/** One completion-relative timer. Controls serialize, but never wait for a long running job.
 * Stop invalidates the epoch; dispatched sources/workers drain without dispatching successors.
 * A durable renewable lease serializes full cycles and manual queue work across replicas.
 */
export interface LoopState { isRunning: boolean; intervalMs: number; epoch: number; nextExecutionAt?: Date | null }
export interface CycleContext { outcomes?: { queueItemId: string; status: string; error?: string }[]; epoch: number; manual: boolean; allowed: () => Promise<boolean> }
export interface SchedulerDeps {
  read: () => Promise<LoopState>;
  control: (running: boolean) => Promise<LoopState>;
  update: (patch: { intervalMs?: number; lastExecutedAt?: Date; nextExecutionAt?: Date | null }, epoch?: number) => Promise<void>;
  emergency: () => Promise<boolean>;
  lease: (state: LoopState) => Promise<(() => Promise<void>) | null>;
  cycle: (context: CycleContext) => Promise<unknown>;
  one: (context: CycleContext) => Promise<unknown>;
  notify: () => void;
  error: (error: unknown) => void;
  now?: () => number;
  timer?: typeof setTimeout;
  clear?: typeof clearTimeout;
}
export class CoreLoopScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<any> | null = null;
  private controls: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closing = false;
  private now: () => number;
  constructor(private deps: SchedulerDeps) { this.now = deps.now || Date.now; }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.controls.then(fn);
    this.controls = result.catch(() => {});
    return result;
  }
  private cancelTimer() {
    this.generation++;
    if (this.timer) (this.deps.clear || clearTimeout)(this.timer);
    this.timer = null;
  }
  private async arm(delay: number, state: LoopState) {
    if (this.closing || !state.isRunning) return;
    this.cancelTimer();
    const generation = this.generation;
    await this.deps.update({ nextExecutionAt: new Date(this.now() + delay) }, state.epoch);
    if (generation !== this.generation || this.closing) return;
    this.timer = (this.deps.timer || setTimeout)(() => {
      this.timer = null;
      if (generation !== this.generation || this.closing) return;
      void this.execute(false, false, state.epoch).catch(this.deps.error);
    }, delay);
    this.timer.unref?.();
  }
  start() { return this.serial(async () => {
    if (this.closing) throw new Error('Service is shutting down.');
    if (await this.deps.emergency()) throw new Error('Emergency stop is active. Clear it before restarting automation.');
    const state = await this.deps.control(true);
    if (!this.timer && !this.active) await this.arm(0, state);
    this.deps.notify();
  }); }
  stop() {
    // Synchronous invalidation also covers a callback already waiting on DB I/O.
    this.cancelTimer();
    return this.serial(async () => {
      this.cancelTimer();
      await this.deps.control(false);
      this.deps.notify();
    });
  }
  interval(intervalMs: number) { return this.serial(async () => {
    if (!Number.isInteger(intervalMs) || intervalMs < 60000 || intervalMs > 86400000) throw new Error('Interval must be 60000–86400000 milliseconds.');
    await this.deps.update({ intervalMs });
    const state = await this.deps.read();
    if (!this.active && state.isRunning) await this.arm(intervalMs, state);
    this.deps.notify();
  }); }
  runOnce(one = false) {
    if (this.active) return Promise.reject(new Error('A Core Loop operation is already executing.'));
    return this.execute(true, one);
  }
  private execute(manual: boolean, one: boolean, expectedEpoch?: number): Promise<any> {
    if (this.active) return manual ? Promise.reject(new Error('A Core Loop operation is already executing.')) : this.active;
    const generation = this.generation;
    let operationEpoch: number | undefined;
    const operation = (async () => {
      await this.controls;
      const state = await this.deps.read();
      if (this.closing || generation !== this.generation || (!manual && (!state.isRunning || state.epoch !== expectedEpoch))) return { stopped: true };
      if (await this.deps.emergency()) throw new Error('Emergency stop is active.');
      operationEpoch = state.epoch;
      const release = await this.deps.lease(state);
      if (!release) {
        if (manual) throw new Error('A Core Loop operation is already executing in another session.');
        return { busy: true };
      }
      this.cancelTimer();
      const epoch = state.epoch;
      const allowed = async () => {
        const current = await this.deps.read();
        return ((release as any).valid?.() ?? true) && !this.closing && current.epoch === epoch && (manual || current.isRunning) && !await this.deps.emergency();
      };
      try {
        await this.deps.update({ nextExecutionAt: null }, epoch);
        if (!await allowed()) return { stopped: true };
        this.deps.notify();
        const result = await (one ? this.deps.one : this.deps.cycle)({ epoch, manual, allowed });
        await this.deps.update({ lastExecutedAt: new Date(this.now()) });
        return result;
      } finally { await release(); }
    })();
    this.active = operation.finally(async () => {
      this.active = null;
      try {
        const current = await this.deps.read();
        // A fresh epoch from Stop → Start waits until the old job has drained.
        if (current.isRunning && !this.closing) await this.arm(operationEpoch !== undefined && operationEpoch !== current.epoch ? 0 : current.intervalMs, current);
      } catch (error) {
        this.deps.error(error);
        // A transient DB outage must not permanently kill the scheduler.
        if (!this.closing) this.retryRecovery();
      }
      this.deps.notify();
    });
    return this.active;
  }
  private retryRecovery() {
    this.cancelTimer();
    const generation = this.generation;
    this.timer = (this.deps.timer || setTimeout)(() => {
      this.timer = null;
      if (generation !== this.generation || this.closing) return;
      void this.recover().catch(error => {
        this.deps.error(error);
        if (generation === this.generation && !this.closing) this.retryRecovery();
      });
    }, 60000);
    this.timer.unref?.();
  }
  recover() { return this.serial(async () => {
    const state = await this.deps.read();
    if (state.isRunning && !this.active && !this.timer && !this.closing && !await this.deps.emergency()) {
      await this.arm(Math.max(0, (state.nextExecutionAt?.getTime() || this.now()) - this.now()), state);
    }
  }); }
  /** Process exit preserves the user's persisted running preference. */
  shutdown() { this.closing = true; this.cancelTimer(); return this.active || Promise.resolve(); }
}
