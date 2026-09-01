// ============================================================
// LLM ROUTER — shared types (Phase 12)
//
// Provider-agnostic definitions used by the model registry,
// provider adapters, and the router. Contains no secrets.
// ============================================================

export type ProviderId = 'groq' | 'cerebras' | 'gemini' | 'openrouter';

export type Capability =
  | 'BUSINESS_PLAN'
  | 'APPLICATION_GENERATION'
  | 'CODE_GENERATION'
  | 'CODE_REPAIR'
  | 'CLASSIFICATION'
  | 'JSON_GENERATION'
  | 'ANALYSIS'
  | 'PROJECT_ANALYSIS'
  | 'ADVERTISING_ANALYSIS'
  | 'ADVERTISING_CREATIVE';

export const ALL_CAPABILITIES: Capability[] = [
  'BUSINESS_PLAN',
  'APPLICATION_GENERATION',
  'CODE_GENERATION',
  'CODE_REPAIR',
  'CLASSIFICATION',
  'JSON_GENERATION',
  'ANALYSIS',
  'PROJECT_ANALYSIS',
  'ADVERTISING_ANALYSIS',
  'ADVERTISING_CREATIVE',
];

export type ErrorCategory =
  | 'rate_limit'
  | 'auth'
  | 'invalid_request'
  | 'invalid_model'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'content_policy'
  | 'unknown';

export interface ModelConfig {
  provider: ProviderId;
  /** Provider-specific model id. Configurable via env for easy swaps. */
  model: string;
  capabilities: Capability[];
  /** Higher value = preferred. Ties are broken by last-used time. */
  priority: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Known throughput limit (tokens/min). Optional — routing estimate only. */
  maxTokensPerMinute?: number;
  /** Known request rate limit (requests/min). Optional. */
  maxRequestsPerMinute?: number;
  /** Approximate cost per 1K tokens (USD). Informational only. */
  estimatedCostPer1kTokens?: number;
  supportsJsonMode: boolean;
  enabled: boolean;
  /** Env var that holds the provider API key. */
  envKey: string;
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LLMRouteResult {
  text: string;
  model: string;
  provider: ProviderId;
  usage: LLMUsage;
  attemptCount: number;
}

/** A failure record used for safe diagnostics when all providers fail. */
export interface AttemptedProvider {
  provider: string;
  model: string;
  category: ErrorCategory;
}

/**
 * Typed error carrying a machine-readable category so the router can
 * decide whether to rotate, retry, cooldown, or disable.
 */
export class LLMProviderError extends Error {
  category: ErrorCategory;
  status?: number;
  retryAfterMs?: number;
  provider: ProviderId;
  model: string;

  constructor(params: {
    category: ErrorCategory;
    message: string;
    provider: ProviderId;
    model: string;
    status?: number;
    retryAfterMs?: number;
  }) {
    super(params.message);
    this.name = 'LLMProviderError';
    this.category = params.category;
    this.status = params.status;
    this.retryAfterMs = params.retryAfterMs;
    this.provider = params.provider;
    this.model = params.model;
  }
}

/**
 * Thrown when every compatible provider/model has been attempted and
 * none succeeded. Message contains only safe diagnostics (never keys).
 */
export class LLMRouterExhaustedError extends Error {
  code = 'LLM_ALL_PROVIDERS_EXHAUSTED';
  task: string;
  providersAttempted: AttemptedProvider[];

  constructor(task: string, providersAttempted: AttemptedProvider[]) {
    const summary = providersAttempted
      .map((p) => `${p.provider}/${p.model} (${p.category})`)
      .join(', ');
    super(
      `[LLM_ALL_PROVIDERS_EXHAUSTED] task=${task} — no compatible provider/model succeeded. ` +
      `Attempted: ${summary || 'none'}. ` +
      `Recommendation: wait for provider cooldowns to expire or add/verify credentials.`
    );
    this.name = 'LLMRouterExhaustedError';
    this.task = task;
    this.providersAttempted = providersAttempted;
  }
}
