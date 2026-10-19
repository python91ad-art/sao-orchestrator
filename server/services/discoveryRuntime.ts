/** Durable counters/circuits share the existing settings store, isolated from policy settings. */
export type RuntimeState = Record<string, any>;
export type MutateRuntime = <T>(key: string, fn: (state: RuntimeState) => T) => Promise<T>;
export const mutateDiscoveryRuntime: MutateRuntime = async (key, fn) => {
  const { db } = await import('../db');
  const { operationalSettings } = await import('../../drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const settingKey = `discovery:${key}`;
  return db.transaction(async tx => {
    await tx.insert(operationalSettings).values({ key: settingKey, valueJson: '{}', updatedBy: 'system:discovery' })
      .onDuplicateKeyUpdate({ set: { key: settingKey } });
    const [row] = await tx.select().from(operationalSettings).where(eq(operationalSettings.key, settingKey)).for('update');
    const state = JSON.parse(row.valueJson);
    const result = fn(state);
    await tx.update(operationalSettings).set({ valueJson: JSON.stringify(state), updatedAt: new Date() }).where(eq(operationalSettings.key, settingKey));
    return result;
  });
};

export function memoryRuntime(): MutateRuntime {
  const states = new Map<string, RuntimeState>();
  return async (key, fn) => {
    const state = states.get(key) || {};
    states.set(key, state);
    return fn(state);
  };
}

/** Crash-safe cross-process lease; tokens prevent an expired worker releasing a newer lease. */
export async function acquireDiscoveryLease(mutate: MutateRuntime = mutateDiscoveryRuntime, key = 'cycle-lease', metadata: Record<string, unknown> = {}): Promise<(() => Promise<void>) | null> {
  const token = (await import('node:crypto')).randomUUID();
  const acquired = await mutate(key, state => {
    if (state.expires > Date.now()) return false;
    Object.assign(state, metadata);
    state.token = token; state.expires = Date.now() + 30 * 60000;
    return true;
  });
  if (!acquired) return null;
  let lost = false;
  const heartbeat = setInterval(() => {
    void mutate(key, state => { if (state.token === token) state.expires = Date.now() + 30 * 60000; else lost = true; }).catch(() => { lost = true; });
  }, 60000);
  heartbeat.unref();
  const release = async () => { clearInterval(heartbeat); await mutate(key, state => { if (state.token === token) state.expires = 0; }); };
  return Object.assign(release, { valid: () => !lost });
}
