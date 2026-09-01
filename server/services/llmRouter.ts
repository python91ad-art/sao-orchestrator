// ============================================================
// LLM ROUTER — selection / quota / cooldown / rotation (Phase 12)
//
// In-memory runtime state only (no database changes). Local usage is
// a routing ESTIMATE — provider responses remain authoritative when
// they return rate-limit information.
// ============================================================

import {
  Capability,
  ErrorCategory,
  LLMRouterExhaustedError,
  LLMRouteResult,
  LLMProviderError,
  ModelConfig,
  ProviderId,
  AttemptedProvider,
} from './llmTypes';
import { getModelRegistry, hasProviderCredentials } from './llmModels';
import {
  classifyError,
  getProviders,
  LLMProvider,
  ProviderRequest,
} from './llmProviders';

type HealthState = 'AVAILABLE' | 'DEGRADED' | 'COOLDOWN' | 'DISABLED';

interface ModelHealth {
  state: HealthState;
  cooldownUntil: number;
  consecutiveFailures: number;
  consecutiveRateLimits: number;
  lastUsedAt: number;
  lastErrorCategory?: ErrorCategory;
}

interface UsageRecord {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const healthMap = new Map<string, ModelHealth>();
const usageMap = new Map<string, UsageRecord[]>();

const RATE_LIMIT_MULTIPLIER = 3;
const RATE_LIMIT_MAX_MS = 300_000;
const DEGRADED_COOLDOWN_MS = 10_000;
const USAGE_WINDOW_MS = 60_000;
const MAX_USAGE_RECORDS = 200;

// Test injection: allows routing tests to substitute mock adapters.
let providersOverride: LLMProvider[] | null = null;
export function setProvidersForTest(providers: LLMProvider[] | null) {
  providersOverride = providers;
}

function getAvailableProviders(): LLMProvider[] {
  return providersOverride ?? getProviders();
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || v.trim().length === 0) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function rateLimitBaseMs(): number {
  return envInt('LLM_COOLDOWN_BASE_MS', 30_000);
}

function modelKey(mc: { provider: string; model: string }): string {
  return `${mc.provider}:${mc.model}`;
}

function getHealth(mc: { provider: string; model: string }): ModelHealth {
  const key = modelKey(mc);
  let h = healthMap.get(key);
  if (!h) {
    h = {
      state: 'AVAILABLE',
      cooldownUntil: 0,
      consecutiveFailures: 0,
      consecutiveRateLimits: 0,
      lastUsedAt: 0,
    };
    healthMap.set(key, h);
  }
  return h;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function recordUsage(mc: ModelConfig, inputTokens: number, outputTokens: number) {
  const key = modelKey(mc);
  let records = usageMap.get(key);
  if (!records) {
    records = [];
    usageMap.set(key, records);
  }
  const now = Date.now();
  records.push({ timestamp: now, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
  // Prune old records outside the window and cap list length.
  usageMap.set(key, records.filter((r) => now - r.timestamp < USAGE_WINDOW_MS).slice(-MAX_USAGE_RECORDS));
}

function sumTokensInWindow(mc: ModelConfig): number {
  const records = usageMap.get(modelKey(mc)) || [];
  const now = Date.now();
  return records
    .filter((r) => now - r.timestamp < USAGE_WINDOW_MS)
    .reduce((sum, r) => sum + r.totalTokens, 0);
}

function countRequestsInWindow(mc: ModelConfig): number {
  const records = usageMap.get(modelKey(mc)) || [];
  const now = Date.now();
  return records.filter((r) => now - r.timestamp < USAGE_WINDOW_MS).length;
}

function logLine(fields: Record<string, unknown>) {
  const parts = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[LLM Router] ${parts}`);
}

function disableProvider(provider: ProviderId) {
  for (const mc of getModelRegistry()) {
    if (mc.provider === provider) {
      const h = getHealth(mc);
      h.state = 'DISABLED';
      h.cooldownUntil = Number.POSITIVE_INFINITY;
    }
  }
}

function handleFailure(mc: ModelConfig, error: LLMProviderError) {
  const h = getHealth(mc);
  h.lastUsedAt = Date.now();
  h.lastErrorCategory = error.category;

  switch (error.category) {
    case 'auth':
      h.state = 'DISABLED';
      disableProvider(mc.provider);
      break;
    case 'invalid_model':
      h.state = 'DISABLED';
      h.cooldownUntil = Number.POSITIVE_INFINITY;
      break;
    case 'rate_limit':
      h.consecutiveFailures++;
      h.consecutiveRateLimits++;
      const base = error.retryAfterMs || rateLimitBaseMs();
      const multiplier = Math.pow(RATE_LIMIT_MULTIPLIER, h.consecutiveRateLimits - 1);
      h.cooldownUntil = Date.now() + Math.min(base * multiplier, RATE_LIMIT_MAX_MS);
      h.state = 'COOLDOWN';
      break;
    case 'server_error':
    case 'timeout':
    case 'network':
      h.consecutiveFailures++;
      h.cooldownUntil = Date.now() + DEGRADED_COOLDOWN_MS;
      h.state = 'DEGRADED';
      break;
    default:
      h.consecutiveFailures++;
      break;
  }
}

function restoreOnSuccess(mc: ModelConfig) {
  const h = getHealth(mc);
  h.state = 'AVAILABLE';
  h.cooldownUntil = 0;
  h.consecutiveFailures = 0;
  h.consecutiveRateLimits = 0;
  h.lastUsedAt = Date.now();
  h.lastErrorCategory = undefined;
}

export interface RouterRequest {
  task: Capability;
  prompt: string;
  systemPrompt?: string;
  jsonMode: boolean;
  maxTokens: number;
  temperature: number;
  excludeModels?: string[];
}

function selectCandidates(
  req: RouterRequest,
  providers: Map<ProviderId, LLMProvider>
): ModelConfig[] {
  const now = Date.now();

  return getModelRegistry()
    .filter((mc) => {
      if (!mc.enabled) return false;
      if (!hasProviderCredentials(mc.provider)) return false;
      if (!providers.has(mc.provider)) return false;
      if (!mc.capabilities.includes(req.task)) return false;
      if (req.jsonMode && !mc.supportsJsonMode) return false;
      if (req.excludeModels?.includes(mc.model)) return false;

      const h = getHealth(mc);
      if (h.state === 'DISABLED') return false;
      if ((h.state === 'COOLDOWN' || h.state === 'DEGRADED') && h.cooldownUntil > now) {
        return false;
      }

      // Capacity / quota awareness (local routing estimate).
      if (req.maxTokens > mc.maxOutputTokens) return false;
      const estInput = estimateTokens(req.prompt) + estimateTokens(req.systemPrompt || '');
      if (estInput + req.maxTokens > mc.maxInputTokens) return false;
      if (mc.maxTokensPerMinute && req.maxTokens > mc.maxTokensPerMinute) return false;

      if (mc.maxTokensPerMinute) {
        const used = sumTokensInWindow(mc);
        if (used + estInput + req.maxTokens > mc.maxTokensPerMinute) return false;
      }
      if (mc.maxRequestsPerMinute && countRequestsInWindow(mc) >= mc.maxRequestsPerMinute) {
        return false;
      }

      return true;
    })
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.maxOutputTokens !== a.maxOutputTokens) {
        return b.maxOutputTokens - a.maxOutputTokens;
      }
      const aLast = getHealth(a).lastUsedAt || 0;
      const bLast = getHealth(b).lastUsedAt || 0;
      return aLast - bLast;
    });
}

/**
 * Route a single logical LLM request across compatible providers/models
 * with rotation, cooldown, and a bounded attempt budget. Throws
 * LLMRouterExhaustedError when everything is exhausted.
 */
export async function route(req: RouterRequest): Promise<LLMRouteResult> {
  const providers = new Map(getAvailableProviders().map((p) => [p.id, p]));
  const candidates = selectCandidates(req, providers);

  if (candidates.length === 0) {
    logLine({ task: req.task, result: 'no_candidates', action: 'exhausted' });
    throw new LLMRouterExhaustedError(req.task, []);
  }

  const maxAttempts = Math.max(
    1,
    Math.min(envInt('MAX_PROVIDER_ATTEMPTS', candidates.length), candidates.length)
  );

  const attempted: AttemptedProvider[] = [];
  const messages: ProviderRequest['messages'] = [];
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
  messages.push({ role: 'user', content: req.prompt });

  for (let i = 0; i < maxAttempts; i++) {
    const mc = candidates[i];
    const provider = providers.get(mc.provider)!;

    try {
      const completion = await provider.complete(mc.model, {
        messages,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        jsonMode: req.jsonMode,
      });

      recordUsage(mc, completion.usage.inputTokens ?? estimateTokens(req.prompt), completion.usage.outputTokens ?? req.maxTokens);
      restoreOnSuccess(mc);
      logLine({
        task: req.task,
        provider: mc.provider,
        model: mc.model,
        result: 'success',
        action: 'complete',
      });

      return {
        text: completion.text,
        model: mc.model,
        provider: mc.provider,
        usage: completion.usage,
        attemptCount: i + 1,
      };
    } catch (error) {
      const classified =
        error instanceof LLMProviderError ? error : classifyError(mc.provider, mc.model, error);

      attempted.push({ provider: mc.provider, model: mc.model, category: classified.category });
      handleFailure(mc, classified);

      logLine({
        task: req.task,
        provider: mc.provider,
        model: mc.model,
        result: classified.category,
        action: classified.category === 'rate_limit' ? 'rotate' : 'skip',
      });

      // Do not blindly rotate on request-level or policy failures.
      if (classified.category === 'invalid_request' || classified.category === 'content_policy') {
        throw classified;
      }
    }
  }

  throw new LLMRouterExhaustedError(req.task, attempted);
}

/**
 * Runtime status for admin visibility. Reports only SET/MISSING for
 * credentials — never the key values.
 */
export function getRouterStatus() {
  return getModelRegistry().map((mc) => {
    const h = getHealth(mc);
    return {
      provider: mc.provider,
      model: mc.model,
      credentials: hasProviderCredentials(mc.provider) ? ('SET' as const) : ('MISSING' as const),
      state: h.state,
      cooldownUntil: h.cooldownUntil && Number.isFinite(h.cooldownUntil) ? h.cooldownUntil : null,
      consecutiveFailures: h.consecutiveFailures,
      lastErrorCategory: h.lastErrorCategory ?? null,
    };
  });
}

/** Reset all runtime health state (useful for tests / admin recovery). */
export function resetRouterState() {
  healthMap.clear();
  usageMap.clear();
}

/** Reset a single provider back to AVAILABLE (admin recovery). */
export function resetProvider(provider: ProviderId) {
  for (const mc of getModelRegistry()) {
    if (mc.provider === provider) {
      const h = getHealth(mc);
      h.state = 'AVAILABLE';
      h.cooldownUntil = 0;
      h.consecutiveFailures = 0;
      h.consecutiveRateLimits = 0;
      h.lastErrorCategory = undefined;
    }
  }
}
