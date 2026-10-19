import { AsyncLocalStorage } from 'node:async_hooks';
import { eq } from 'drizzle-orm';
import { db, generateId } from '../db';
import { integrationCredentials, providerAssignments, credentialAuditLogs, operationalEvents } from '../../drizzle/schema';
import { assignmentListSchema, type Assignment, type ProviderSection } from '../../shared/providerAssignments';
import { getKnownProviders, getProviderDescriptor } from './providerRegistry';
import { decryptCredential, encryptCredential } from './credentialCrypto';
import { getModelRegistry } from './llmModels';
import { mutateDiscoveryRuntime, type MutateRuntime } from './discoveryRuntime';

export { assignmentListSchema } from '../../shared/providerAssignments';
export interface Offering { section: ProviderSection; operation: Assignment['operation']; models: string[]; capabilities: string[]; defaultModel: string | null }
// Explicit adapter contracts. These are not inferred from a provider's name or credential.
// Sources and runtime evidence checks are documented in docs/provider-assignments.md.
export function getOfferings(providerId: string): Offering[] {
  const models = getModelRegistry().filter(m => m.provider === providerId && m.enabled);
  const out: Offering[] = models.length ? [{ section: 'llm', operation: 'inference', models: models.map(m => m.model), capabilities: ['llm_inference', ...new Set(models.flatMap(m => m.capabilities))], defaultModel: null }] : [];
  const searchModels: Record<string, string[]> = {
    tavily: [], groq: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'openai/gpt-oss-safeguard-20b'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.8-flash'],
    openrouter: models.map(m => m.model),
  };
  if (providerId in searchModels) out.push({ section: 'search', operation: 'live_web_search', models: searchModels[providerId], capabilities: ['live_web_search', 'source_evidence'], defaultModel: searchModels[providerId][0] || null });
  if (providerId === 'ons') for (const section of ['search', 'business_data'] as const) out.push({ section, operation: 'statistical_data', models: [], capabilities: ['statistical_data'], defaultModel: null });
  if (providerId === 'vercel') out.push({ section: 'deployment', operation: 'deploy', models: [], capabilities: ['deployment'], defaultModel: null });
  if (providerId === 'nowpayments') out.push({ section: 'payments', operation: 'payment', models: [], capabilities: ['payment'], defaultModel: null });
  return out;
}
export function validateAssignments(providerId: string, raw: unknown): Assignment[] {
  const assignments = assignmentListSchema.parse(raw);
  for (const a of assignments) {
    const offering = getOfferings(providerId).find(o => o.section === a.section && o.operation === a.operation);
    if (!offering) throw new Error(`Missing capability for ${a.section}: adapter ${providerId} does not support ${a.operation}.`);
    const pluginModel = providerId === 'openrouter' && a.operation === 'live_web_search' && /^[a-z0-9_-]+\/[a-z0-9._:-]+$/i.test(a.model || '');
    if (a.model && !offering.models.includes(a.model) && !pluginModel) throw new Error(`Model ${a.model} is not verified for ${a.operation}; choose a supported model.`);
    if (!a.model && a.operation === 'live_web_search' && offering.models.length) a.model = offering.defaultModel;
    if (a.operation !== 'inference' && a.settings.maxTokensPerDay !== undefined) throw new Error('Token limits are supported only by inference assignments.');
    if (a.operation !== 'live_web_search' && a.settings.retries !== undefined) throw new Error('Retry configuration is supported only by live web search.');
    if (!['live_web_search', 'inference'].includes(a.operation) && Object.keys(a.settings).length) throw new Error('Advanced request limits are supported by search and inference assignments only.');
  }
  return assignments;
}
function parse(value: string | null | undefined) { try { return JSON.parse(value || '{}'); } catch { return {}; } }
export function legacyAssignments(row: { providerId: string; service: string; priority?: string | null; config?: string | null }): Assignment[] {
  const cfg = parse(row.config)?.discovery || {};
  const offerings = getOfferings(row.providerId);
  const nativeSection = getProviderDescriptor(row.providerId)?.serviceType;
  const assignments = offerings.filter(o => o.section === nativeSection || (o.section === 'search' && (row.providerId === 'ons' || cfg.enabled === true)));
  return assignments.map(o => ({ section: o.section, operation: o.operation, enabled: o.section === 'search' ? row.providerId === 'tavily' || row.providerId === 'ons' ? cfg.enabled !== false : cfg.enabled === true : true,
    priority: o.section === 'search' ? ({ tavily: 400, gemini: 300, groq: 200, openrouter: 100 }[row.providerId] ?? 100) : o.section === 'llm' ? ({ groq: 100, cerebras: 60, gemini: 40, openrouter: 20 }[row.providerId] ?? 100) : row.priority === 'primary' ? 200 : row.priority === 'fallback' ? 0 : 100,
    fallbackOrder: row.priority === 'primary' ? 0 : row.priority === 'fallback' ? 1 : 2, model: o.section === 'search' && o.models.length ? cfg.model || o.defaultModel : null, settings: {} }));
}
type Connection = typeof integrationCredentials.$inferSelect;
export interface AssignmentRoute { connectionId: string; providerId: string; assignment: Assignment; config: any; revision: string; connectionStatus: string }
const context = new AsyncLocalStorage<{ route: AssignmentRoute; key: string | null }>();
export function currentAssignmentCredential(providerId: string) {
  const ctx = context.getStore(); return ctx?.route.providerId === providerId ? { source: 'dashboard' as const, value: ctx.key } : undefined;
}
export function currentAssignmentSettings() { return context.getStore()?.route.assignment.settings || {}; }
function environmentConnection(providerId: string): Connection {
  const d = getProviderDescriptor(providerId)!;
  return { id: `env:${providerId}`, service: d.serviceType, name: d.name, providerId, credentialType: d.credentialType, encryptedValue: '', encryptionVersion: 1, assignmentVersion: 0, baseUrl: null, config: null, enabled: true, priority: null, compatibilityStatus: 'compatible', connectionStatus: 'untested', lastTestedAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
}
export async function listConnections(): Promise<Connection[]> {
  const rows = await db.select().from(integrationCredentials);
  for (const d of getKnownProviders()) if (d.envConfigured() && !rows.some(r => r.providerId === d.id)) rows.push(environmentConnection(d.id));
  return rows;
}
async function readAssignments(row: Connection): Promise<Assignment[]> {
  if (!row.assignmentVersion) return legacyAssignments(row);
  const rows = await db.select().from(providerAssignments).where(eq(providerAssignments.connectionId, row.id));
  return rows.map(a => ({ section: a.section as ProviderSection, enabled: a.enabled, priority: a.priority, fallbackOrder: a.fallbackOrder, operation: a.operation as Assignment['operation'], model: a.model, settings: parse(a.settingsJson) }));
}
export async function assignmentView(connectionId: string) {
  const row = (await listConnections()).find(r => r.id === connectionId);
  if (!row) throw new Error('Provider connection not found.');
  const assignments = await readAssignments(row);
  const health = await mutateDiscoveryRuntime(`assignments:${row.id}`, s => s.health || {});
  const offerings = getOfferings(row.providerId);
  const configuredSearchModel = parse(row.config)?.discovery?.model;
  if (row.providerId === 'openrouter' && /^[a-z0-9_-]+\/[a-z0-9._:-]+$/i.test(configuredSearchModel || '')) {
    const search = offerings.find(o => o.operation === 'live_web_search');
    if (search && !search.models.includes(configuredSearchModel)) search.models.push(configuredSearchModel);
  }
  return { connectionId, name: row.name, providerId: row.providerId, enabled: row.enabled, connectionStatus: row.connectionStatus,
    offerings, assignments, health,
    billingApproved: parse(row.config)?.discovery?.billingApproved === true,
    revision: row.assignmentVersion ? `${row.assignmentVersion}:${row.updatedAt.toISOString()}` : 'legacy' };
}
/** Atomic replace with a connection lock and optimistic revision; deleting all assignments is durable. */
export async function saveAssignments(connectionId: string, raw: unknown, actorId: string, revision?: string) {
  const connection = (await listConnections()).find(r => r.id === connectionId);
  if (!connection) throw new Error('Provider connection not found.');
  const assignments = validateAssignments(connection.providerId, raw);
  await db.transaction(async tx => {
    if (connectionId.startsWith('env:')) {
      // Reference environment credentials without copying them into the database.
      await tx.insert(integrationCredentials).values({ ...connection, encryptedValue: encryptCredential(''), assignmentVersion: 0, createdAt: new Date(), updatedAt: new Date() }).onDuplicateKeyUpdate({ set: { id: connectionId } });
    }
    const [row] = await tx.select().from(integrationCredentials).where(eq(integrationCredentials.id, connectionId)).for('update');
    if (!row) throw new Error('Provider connection no longer exists.');
    const actualRevision = row.assignmentVersion ? `${row.assignmentVersion}:${row.updatedAt.toISOString()}` : 'legacy';
    if (revision !== undefined && revision !== actualRevision) throw new Error('Assignments changed in another session. Reopen Manage Assignments and try again.');
    const before = row.assignmentVersion ? await tx.select().from(providerAssignments).where(eq(providerAssignments.connectionId, connectionId)) : legacyAssignments(row);
    await tx.delete(providerAssignments).where(eq(providerAssignments.connectionId, connectionId));
    for (const a of assignments) await tx.insert(providerAssignments).values({ connectionId, section: a.section, enabled: a.enabled, priority: a.priority, fallbackOrder: a.fallbackOrder, operation: a.operation, model: a.model || null, settingsJson: JSON.stringify(a.settings) });
    await tx.update(integrationCredentials).set({ assignmentVersion: row.assignmentVersion + 1, updatedAt: new Date() }).where(eq(integrationCredentials.id, connectionId));
    await tx.insert(operationalEvents).values({ id: generateId(), actorId, type: 'provider_assignments_updated', resourceId: connectionId, detailJson: JSON.stringify({ before, after: assignments }) });
    await tx.insert(credentialAuditLogs).values({ id: generateId(), userId: actorId, service: 'provider_assignments', operation: 'replace_assignments', success: true, message: JSON.stringify({ connectionId, sections: assignments.map(a => a.section) }).slice(0, 255) });
  });
  return assignmentView(connectionId);
}
export function orderRoutes(routes: AssignmentRoute[]) {
  return routes.sort((a, b) => b.assignment.priority - a.assignment.priority || a.assignment.fallbackOrder - b.assignment.fallbackOrder || a.connectionId.localeCompare(b.connectionId));
}
export async function resolveSectionRoutes(section: ProviderSection, operation?: Assignment['operation']): Promise<AssignmentRoute[]> {
  const routes: AssignmentRoute[] = [];
  for (const row of await listConnections()) {
    if (!row.enabled || ['invalid_key', 'auth_failed', 'invalid_config', 'unsupported'].includes(row.connectionStatus)) continue;
    for (const a of await readAssignments(row)) {
      if (a.section !== section || !a.enabled || (operation && a.operation !== operation)) continue;
      try { validateAssignments(row.providerId, [a]); } catch { continue; }
      routes.push({ connectionId: row.id, providerId: row.providerId, assignment: a, config: parse(row.config), revision: `${row.id}:${row.updatedAt.getTime()}`, connectionStatus: row.connectionStatus });
    }
  }
  return orderRoutes(routes);
}
export async function routeCredential(route: AssignmentRoute): Promise<string | null> {
  const [row] = await db.select().from(integrationCredentials).where(eq(integrationCredentials.id, route.connectionId));
  if (row && !row.enabled) return null;
  if (row?.encryptedValue) {
    try { const key = decryptCredential(row.encryptedValue); if (key) return key; } catch { return null; }
  }
  const d = getProviderDescriptor(route.providerId);
  for (const name of d?.envKeys || []) if (process.env[name]?.trim()) return process.env[name]!;
  return d?.credentialRequired === false ? '' : null;
}
export async function withAssignment<T>(route: AssignmentRoute, fn: () => Promise<T>): Promise<T> {
  const key = await routeCredential(route);
  if (key === null) throw new Error('Assignment credential unavailable.');
  return context.run({ route, key }, fn);
}
/** Reservations are durable, atomic, and not refunded on failure. Edits never reset usage. */
export async function reserveAssignment(route: AssignmentRoute, cost = 0, tokens = 0, mutate: MutateRuntime = mutateDiscoveryRuntime, now = Date.now()): Promise<string | null> {
  return mutate(`assignment:${route.connectionId}:${route.assignment.section}`, s => {
    const day = new Date(now).toISOString().slice(0, 10), minute = Math.floor(now / 60000);
    if (s.day !== day) Object.assign(s, { day, requests: 0, usd: 0, tokens: 0 });
    if (s.minute !== minute) Object.assign(s, { minute, minuteRequests: 0 });
    if (s.openUntil > now) return `circuit_open:${s.reason || 'unavailable'}`;
    const caps = route.assignment.settings;
    if (caps.maxRequestsPerDay !== undefined && s.requests >= caps.maxRequestsPerDay) return 'daily_request_limit';
    if (caps.maxRequestsPerMinute !== undefined && s.minuteRequests >= caps.maxRequestsPerMinute) return 'minute_request_limit';
    if (caps.maxTokensPerDay !== undefined && s.tokens + tokens > caps.maxTokensPerDay) return 'daily_token_limit';
    if (caps.maxRequestCostUsd !== undefined && cost > caps.maxRequestCostUsd) return 'request_spending_limit';
    if (caps.dailyBudgetUsd !== undefined && s.usd + cost > caps.dailyBudgetUsd + 1e-9) return 'daily_spending_limit';
    s.requests++; s.minuteRequests++; s.usd += cost; s.tokens += tokens;
    return null;
  });
}
export async function recordAssignmentOutcome(route: AssignmentRoute, reason?: string, mutate: MutateRuntime = mutateDiscoveryRuntime) {
  const at = new Date().toISOString();
  await mutate(`assignments:${route.connectionId}`, s => { s.health ||= {}; const previous = s.health[route.assignment.section] || {}; s.health[route.assignment.section] = { ...previous, status: reason ? 'unavailable' : 'healthy', ...(reason ? { lastFailure: at, reason } : { lastSuccess: at, reason: null }) }; });
  await mutate(`assignment:${route.connectionId}:${route.assignment.section}`, s => { s.reason = reason || null; s.openUntil = reason && !['unknown', 'invalid_request', 'content_policy'].includes(reason) ? Date.now() + (/auth|quota|invalid_model/.test(reason) ? 3600000 : 60000) : 0; });
}
/** Single-adapter functions retain their existing business authorization gates. */
export async function resolveFunctionCredential(providerId: string, section: ProviderSection): Promise<string | null> {
  for (const route of (await resolveSectionRoutes(section)).filter(r => r.providerId === providerId)) {
    const key = await routeCredential(route);
    if (key !== null) return key;
  }
  return null;
}

/** Assignment budgets can tighten connection authorization, never enlarge it. */
export async function discoveryRouteConfig(route: AssignmentRoute) {
  const base = route.config.discovery || {};
  const config = { ...base, enabled: route.assignment.enabled, model: route.assignment.model || base.model };
  for (const name of ['maxRequestsPerDay', 'dailyBudgetUsd'] as const) {
    const cap = route.assignment.settings[name];
    if (cap !== undefined) config[name] = Math.min(base[name] ?? (name === 'maxRequestsPerDay' ? 50 : 0), cap);
  }
  config.timeoutMs = route.assignment.settings.timeoutMs;
  config.retries = route.assignment.settings.retries;
  return { enabled: route.assignment.enabled, key: await routeCredential(route), config, revision: route.revision };
}

/** Existing adapters keep their business gates. Retry only explicit rejection, never an ambiguous write failure. */
export async function executeFunctionRequest(providerId: string, section: ProviderSection, dispatch: (key: string) => Promise<Response>): Promise<Response> {
  let rejected: Response | undefined;
  for (const route of (await resolveSectionRoutes(section)).filter(r => r.providerId === providerId)) {
    const key = await routeCredential(route);
    if (key === null || await reserveAssignment(route)) continue;
    try {
      const response = await dispatch(key);
      const reason = response.ok ? undefined : response.status === 401 || response.status === 403 ? 'auth_failure' : response.status === 429 ? 'rate_limited' : `http_${response.status}`;
      await recordAssignmentOutcome(route, reason);
      if ([401, 403, 429].includes(response.status)) { rejected = response; continue; }
      return response;
    } catch {
      await recordAssignmentOutcome(route, 'network_error');
      throw new Error(`${section} provider request failed; check assignment health before retrying.`);
    }
  }
  if (rejected) return rejected;
  throw new Error(`No eligible ${section} assignment with an available credential for ${providerId}.`);
}

/** A verified/new credential can recover authentication failures; counters and quota circuits stay intact. */
export async function recoverAssignmentAuthentication(connectionId: string) {
  for (const section of ['llm', 'search', 'deployment', 'payments', 'business_data'] as const) {
    await mutateDiscoveryRuntime(`assignment:${connectionId}:${section}`, s => {
      if (s.reason === 'auth' || s.reason === 'auth_failure') { s.openUntil = 0; s.reason = null; }
    });
  }
}
