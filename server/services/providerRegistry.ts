// ============================================================
// GENERIC PROVIDER REGISTRY
// ============================================================
// Stores provider credentials (encrypted) and maps them to service
// adapters. `service` is an extensible service type; `providerId` is the
// canonical adapter key. A provider is only "compatible" when SAO has an
// adapter for it — an arbitrary key is never treated as automatically
// usable. Credential precedence is: dashboard credential → env fallback.
// ============================================================

import * as db from '../db';
import { z } from 'zod';
import { integrationCredentials, credentialAuditLogs, providerAssignments } from '../../drizzle/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { encryptCredential, decryptCredential, redactCredential } from './credentialCrypto';

export type ServiceType =
  | 'search'
  | 'llm'
  | 'deployment'
  | 'advertising'
  | 'payments'
  | 'business_data';

export const SERVICE_TYPES: { id: ServiceType; label: string }[] = [
  { id: 'search', label: 'Search / Gap Finder' },
  { id: 'llm', label: 'LLM / AI Models' },
  { id: 'deployment', label: 'Deployment' },
  { id: 'advertising', label: 'Advertising' },
  { id: 'payments', label: 'Payments' },
  { id: 'business_data', label: 'Business Data' },
];

export type ConnectionStatus =
  | 'untested'
  | 'connected'
  | 'auth_failed'
  | 'invalid_key'
  | 'rate_limited'
  | 'timeout'
  | 'unreachable'
  | 'invalid_config'
  | 'unsupported';

export interface ProviderTestOutcome {
  status: ConnectionStatus;
  message: string;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  serviceType: ServiceType;
  credentialType: string;
  envKeys: string[];
  envConfigured: () => boolean;
  credentialRequired?: boolean;
  test: (credential: string, baseUrl?: string, config?: any) => Promise<ProviderTestOutcome>;
}

// ------------------------------------------------------------
// Generic HTTP adapter test helper
// ------------------------------------------------------------
async function httpTest(opts: {
  url: string;
  headers: Record<string, string>;
  method?: string;
  body?: string;
  okStatuses?: number[];
}): Promise<ProviderTestOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(opts.url, {
      method: opts.method || 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
    const ok = opts.okStatuses || [200, 201, 202];
    if (ok.includes(res.status)) {
      return { status: 'connected', message: `Connected (HTTP ${res.status}).` };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'invalid_key', message: `Authentication failed (HTTP ${res.status}).` };
    }
    if (res.status === 429) {
      return { status: 'rate_limited', message: 'Rate limited (HTTP 429).' };
    }
    return { status: 'unreachable', message: `Endpoint unavailable (HTTP ${res.status}).` };
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('abort')) {
      return { status: 'timeout', message: 'Request timed out.' };
    }
    return { status: 'unreachable', message: 'Could not reach provider endpoint.' };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------
// Known providers + adapters
// ------------------------------------------------------------
const KNOWN_PROVIDERS: ProviderDescriptor[] = [
  {
    id: 'tavily',
    name: 'Tavily',
    serviceType: 'search',
    credentialType: 'api_key',
    envKeys: ['TAVILY_API_KEY'],
    envConfigured: () => Boolean(process.env.TAVILY_API_KEY),
    test: (key) =>
      httpTest({
        url: 'https://api.tavily.com/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query: 'ping', max_results: 1 }),
      }),
  },
  {
    id: 'groq',
    name: 'Groq',
    serviceType: 'llm',
    credentialType: 'api_key',
    envKeys: ['GROQ_API_KEY'],
    envConfigured: () => Boolean(process.env.GROQ_API_KEY),
    test: (key) =>
      httpTest({
        url: 'https://api.groq.com/openai/v1/models',
        headers: { Authorization: `Bearer ${key}` },
      }),
  },
  {
    id: 'gemini',
    name: 'Gemini',
    serviceType: 'llm',
    credentialType: 'api_key',
    envKeys: ['GEMINI_API_KEY'],
    envConfigured: () => Boolean(process.env.GEMINI_API_KEY),
    test: (key) =>
      httpTest({
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
        headers: { Authorization: `Bearer ${key}` },
      }),
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    serviceType: 'llm',
    credentialType: 'api_key',
    envKeys: ['CEREBRAS_API_KEY'],
    envConfigured: () => Boolean(process.env.CEREBRAS_API_KEY),
    test: (key) =>
      httpTest({
        url: 'https://api.cerebras.ai/v1/models',
        headers: { Authorization: `Bearer ${key}` },
      }),
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    serviceType: 'llm',
    credentialType: 'api_key',
    envKeys: ['OPENROUTER_API_KEY'],
    envConfigured: () => Boolean(process.env.OPENROUTER_API_KEY),
    test: (key) =>
      httpTest({
        url: 'https://openrouter.ai/api/v1/models',
        headers: { Authorization: `Bearer ${key}` },
      }),
  },
  {
    id: 'vercel',
    name: 'Vercel',
    serviceType: 'deployment',
    credentialType: 'token',
    envKeys: ['VERCEL_API_TOKEN'],
    envConfigured: () => Boolean(process.env.VERCEL_API_TOKEN),
    test: (key) =>
      httpTest({
        url: 'https://api.vercel.com/v2/user',
        headers: { Authorization: `Bearer ${key}` },
      }),
  },
  {
    id: 'nowpayments',
    name: 'NOWPayments',
    serviceType: 'payments',
    credentialType: 'api_key',
    envKeys: ['NOWPAYMENTS_API_KEY'],
    envConfigured: () => Boolean(process.env.NOWPAYMENTS_API_KEY),
    test: (key) =>
      httpTest({
        url: 'https://api.nowpayments.io/v1/status',
        headers: { 'x-api-key': key },
      }),
  },
  {
    id: 'ons',
    name: 'Office for National Statistics',
    serviceType: 'business_data',
    credentialType: 'none',
    envKeys: [],
    credentialRequired: false,
    envConfigured: () => true,
    test: () =>
      httpTest({
        url: 'https://api.beta.ons.gov.uk/v1/datasets?limit=1',
        headers: { Accept: 'application/json' },
      }),
  },
];

export function getKnownProviders(): ProviderDescriptor[] {
  return KNOWN_PROVIDERS;
}

export function getProviderDescriptor(providerId: string): ProviderDescriptor | undefined {
  return KNOWN_PROVIDERS.find((p) => p.id === providerId);
}

export function hasAdapter(providerId: string): boolean {
  return Boolean(getProviderDescriptor(providerId));
}

export function isSupportedService(service: string): boolean {
  return SERVICE_TYPES.some((s) => s.id === service);
}


// ------------------------------------------------------------
// Safe (secret-free) view of a stored credential
// ------------------------------------------------------------
export interface ProviderRecord {
  id: string;
  service: ServiceType;
  name: string;
  providerId: string;
  credentialType: string;
  hasCredential: boolean;
  maskedCredential: string | null;
  baseUrl: string | null;
  config: any;
  enabled: boolean;
  priority: 'primary' | 'fallback' | null;
  compatibilityStatus: 'compatible' | 'adapter_required' | 'unknown';
  connectionStatus: ConnectionStatus;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  envFallback: boolean;
}

function safeParseConfig(config: string | null | undefined): any {
  if (!config) return null;
  try {
    return JSON.parse(config);
  } catch {
    return null;
  }
}

function toSafeView(row: any): ProviderRecord {
  const descriptor = getProviderDescriptor(row.providerId);
  let hasCredential = false;
  let maskedCredential: string | null = null;
  if (row.encryptedValue) {
    try {
      const plain = decryptCredential(row.encryptedValue);
      hasCredential = plain.length > 0;
      maskedCredential = redactCredential(plain);
    } catch {
      hasCredential = false;
      maskedCredential = null;
    }
  }
  const compatibilityStatus: ProviderRecord['compatibilityStatus'] = descriptor
    ? 'compatible'
    : row.providerId === 'custom'
      ? 'adapter_required'
      : 'unknown';

  return {
    id: row.id,
    service: row.service,
    name: row.name,
    providerId: row.providerId,
    credentialType: row.credentialType,
    hasCredential,
    maskedCredential,
    baseUrl: row.baseUrl || null,
    config: safeParseConfig(row.config),
    enabled: Boolean(row.enabled),
    priority: row.priority || null,
    compatibilityStatus,
    connectionStatus: row.connectionStatus || 'untested',
    lastTestedAt: row.lastTestedAt ? new Date(row.lastTestedAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : '',
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : '',
    envFallback: descriptor ? descriptor.envConfigured() : false,
  };
}

// ------------------------------------------------------------
// Registry CRUD
// ------------------------------------------------------------
export async function listProviders(service?: ServiceType) {
  const rows = await db.db
    .select()
    .from(integrationCredentials)
    .where(service ? eq(integrationCredentials.service, service) : undefined)
    .orderBy(desc(integrationCredentials.createdAt));
  const { listConnections } = await import('./providerAssignments');
  const virtual = (await listConnections()).filter(r => !rows.some(existing => existing.id === r.id) && r.id.startsWith('env:') && (!service || r.service === service));
  return [...rows, ...virtual].map(toSafeView);
}

export async function getProviderRecord(id: string) {
  const rows = await db.db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, id))
    .limit(1);
  return rows[0] ? toSafeView(rows[0]) : null;
}

export interface SaveCredentialInput {
  service: ServiceType;
  name: string;
  providerId?: string;
  credentialType?: string;
  credential?: string;
  baseUrl?: string;
  config?: any;
  priority?: 'primary' | 'fallback' | null;
}

export const discoveryConfigSchema = z.object({
  enabled: z.boolean().optional(), model: z.string().max(150).regex(/^[a-zA-Z0-9/._:-]*$/).optional(),
  billingApproved: z.boolean().optional(), accountSpendLimitConfirmed: z.boolean().optional(),
  maxRequestsPerDay: z.number().int().min(0).max(500).optional(),
  maxCreditsPerMonth: z.number().int().min(0).max(100000).optional(),
  dailyBudgetUsd: z.number().finite().min(0).max(1000).optional(),
  maxRequestCostUsd: z.number().finite().min(0).max(100).optional(),
  maxAgeDays: z.number().int().min(1).max(550).optional(),
}).strict();
function validateDiscoveryConfig(config: any) {
  if (config?.discovery !== undefined) discoveryConfigSchema.parse(config.discovery);
}

export async function saveProvider(input: SaveCredentialInput) {
  validateDiscoveryConfig(input.config);
  if (!isSupportedService(input.service)) {
    throw new Error(`Unsupported service type: ${input.service}`);
  }
  const providerId = input.providerId || 'custom';
  const descriptor = getProviderDescriptor(providerId);
  const compatibilityStatus = descriptor ? 'compatible' : 'adapter_required';

  const id = db.generateId();
  await db.db.insert(integrationCredentials).values({
    id,
    service: input.service,
    name: input.name || descriptor?.name || 'Custom Provider',
    providerId,
    credentialType: input.credentialType || descriptor?.credentialType || 'api_key',
    encryptedValue: encryptCredential(input.credential || ''),
    encryptionVersion: 1,
    baseUrl: input.baseUrl || null,
    config: input.config ? JSON.stringify(input.config) : null,
    enabled: true,
    priority: input.priority || null,
    compatibilityStatus,
    connectionStatus: 'untested',
    lastTestedAt: null,
  });
  await auditCredential(input.service, 'create', true);
  return getProviderRecord(id);
}


export async function updateProvider(
  id: string,
  input: { credential?: string; baseUrl?: string; config?: any; name?: string; enabled?: boolean; priority?: 'primary' | 'fallback' | null }
) {
  validateDiscoveryConfig(input.config);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.credential !== undefined) {
    set.encryptedValue = encryptCredential(input.credential);
    set.connectionStatus = 'untested';
    set.lastTestedAt = null;
  }
  if (input.baseUrl !== undefined) set.baseUrl = input.baseUrl;
  if (input.config !== undefined) set.config = JSON.stringify(input.config);
  if (input.name !== undefined) set.name = input.name;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.priority !== undefined) set.priority = input.priority;

  await db.db.update(integrationCredentials).set(set).where(eq(integrationCredentials.id, id));
  if (input.credential !== undefined) {
    const { recoverAssignmentAuthentication } = await import('./providerAssignments');
    await recoverAssignmentAuthentication(id);
    const row = await getProviderRecord(id);
    if (row && ['groq', 'gemini', 'cerebras', 'openrouter'].includes(row.providerId)) {
      const { resetProvider } = await import('./llmRouter');
      resetProvider(row.providerId as import('./llmTypes').ProviderId);
    }
  }
  return getProviderRecord(id);
}

export async function deleteProvider(id: string) {
  const existing = await getProviderRecord(id);
  await db.db.transaction(async tx => {
    await tx.select().from(integrationCredentials).where(eq(integrationCredentials.id, id)).for('update');
    await tx.delete(providerAssignments).where(eq(providerAssignments.connectionId, id));
    await tx.delete(integrationCredentials).where(eq(integrationCredentials.id, id));
  });
  if (existing) await auditCredential(existing.service, 'delete', true);
  return { success: true };
}

export async function setProviderPriority(id: string, priority: 'primary' | 'fallback' | null) {
  return updateProvider(id, { priority });
}

export async function toggleProviderEnabled(id: string, enabled: boolean) {
  return updateProvider(id, { enabled });
}

export async function testProvider(id: string): Promise<ProviderTestOutcome> {
  const rows = await db.db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { status: 'invalid_config', message: 'Provider not found.' };
  }

  const descriptor = getProviderDescriptor(row.providerId);
  if (!descriptor) {
    await setConnectionStatus(id, 'unsupported', 'No adapter available for this provider.');
    return { status: 'unsupported', message: 'No adapter available — an adapter is required.' };
  }

  let credential: string;
  try {
    credential = decryptCredential(row.encryptedValue);
  } catch {
    await setConnectionStatus(id, 'invalid_config', 'Stored credential could not be decrypted.');
    return { status: 'invalid_config', message: 'Stored credential could not be decrypted.' };
  }

  if (!credential) for (const name of descriptor.envKeys) {
    if (process.env[name]?.trim()) { credential = process.env[name]!; break; }
  }
  if (!credential && descriptor.credentialRequired !== false) {
    await setConnectionStatus(id, 'invalid_config', 'No credential value stored.');
    return { status: 'invalid_config', message: 'No credential value stored.' };
  }

  let result: ProviderTestOutcome;
  if (row.providerId === 'tavily') {
    // Tavily's existing test endpoint is itself a search: use the same caps and billing gates.
    const { resolveSectionRoutes } = await import('./providerAssignments');
    const { mutateDiscoveryRuntime } = await import('./discoveryRuntime');
    const { WebSearchRouter } = await import('./webSearch');
    const routes = (await resolveSectionRoutes('search', 'live_web_search')).filter(route => route.connectionId === id);
    if (!routes.length) return { status: 'untested', message: 'Connection test requires an enabled compatible Search assignment; no search was dispatched.' };
    const tester = new WebSearchRouter({ resolve: resolveDiscoveryProvider, mutate: mutateDiscoveryRuntime, fetch: (...args: Parameters<typeof fetch>) => fetch(...args), now: Date.now,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), routes: async () => routes });
    const outcome = await tester.search('SAO provider connection check', { maxResults: 1 });
    const status = outcome.attempts[0]?.status;
    result = { status: status === 'results' || status === 'zero_results' ? 'connected' : status === 'auth_failure' ? 'invalid_key' : status === 'quota_exhausted' || status === 'rate_limited' ? 'rate_limited' : status === 'billing_blocked' || status === 'not_configured' ? 'untested' : 'unreachable',
      message: status === 'results' || status === 'zero_results' ? 'Connected through the guarded search adapter.' : outcome.attempts[0]?.reason || 'No eligible search assignment; test was not dispatched.' };
  } else result = await descriptor.test(credential, row.baseUrl || undefined, safeParseConfig(row.config));
  await setConnectionStatus(id, result.status, result.message);
  await auditCredential(row.service, 'test', result.status === 'connected');
  return result;
}

async function setConnectionStatus(id: string, status: ConnectionStatus, _message: string) {
  await db.db
    .update(integrationCredentials)
    .set({ connectionStatus: status, lastTestedAt: new Date(), updatedAt: new Date() })
    .where(eq(integrationCredentials.id, id));
}

async function auditCredential(service: string, operation: string, success: boolean, message?: string) {
  try {
    await db.db.insert(credentialAuditLogs).values({
      id: db.generateId(),
      userId: null,
      service,
      operation,
      success,
      message: message || null,
    });
  } catch (err) {
    console.error('[ProviderRegistry] Failed to write credential audit log:', err);
  }
}

// ------------------------------------------------------------
// Runtime credential resolution (dashboard → env precedence)
// ------------------------------------------------------------
export interface ResolvedCredential {
  source: 'dashboard' | 'env' | null;
  value: string | null;
}

/**
 * Resolve the effective credential for a provider id.
 * Precedence: enabled dashboard credential → environment variable.
 */
export async function resolveCredential(
  providerId: string,
  envKeys: string[]
): Promise<ResolvedCredential> {
  const { currentAssignmentCredential } = await import('./providerAssignments');
  const scoped = currentAssignmentCredential(providerId);
  if (scoped) return scoped;
  const all = await db.db.select().from(integrationCredentials).where(eq(integrationCredentials.providerId, providerId));
  if (all.length && !all.some(row => row.enabled)) return { source: null, value: null };
  const rows = await db.db
    .select()
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.providerId, providerId),
        eq(integrationCredentials.enabled, true)
      )
    )
    .orderBy(
      sql`case ${integrationCredentials.priority} when 'primary' then 0 when 'fallback' then 1 else 2 end`,
      desc(integrationCredentials.updatedAt),
      desc(integrationCredentials.createdAt),
      desc(integrationCredentials.id)
    )
    .limit(1);

  if (rows[0]) {
    try {
      const value = decryptCredential(rows[0].encryptedValue);
      if (value) return { source: 'dashboard', value };
    } catch {
      /* fall through to env */
    }
  }

  for (const key of envKeys) {
    const v = process.env[key];
    if (v && v.trim().length > 0) return { source: 'env', value: v };
  }
  return { source: null, value: null };
}

/** Discovery settings are independent of inference routing. A disabled record blocks env fallback. */
export async function resolveDiscoveryProvider(providerId: string): Promise<{
  enabled: boolean; key: string | null; config: any; revision: string; route?: import('./providerAssignments').AssignmentRoute;
}> {
  const { resolveSectionRoutes, discoveryRouteConfig } = await import('./providerAssignments');
  const routes = await resolveSectionRoutes('search', providerId === 'ons' ? 'statistical_data' : 'live_web_search');
  const route = routes.find(r => r.providerId === providerId);
  return route ? { ...await discoveryRouteConfig(route), route } : { enabled: false, key: null, config: {}, revision: 'unassigned' };
}
