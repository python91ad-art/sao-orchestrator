// ============================================================
// LLM ROUTER — centralized model registry (Phase 12)
//
// All model ids / limits / priorities live here so they can be
// changed without touching the rest of the codebase. Every model id
// is overridable via environment variables.
//
// IMPORTANT: model ids and limits for providers other than Groq are
// sensible placeholders and MUST be verified against current provider
// documentation before relying on them in production. Missing
// credentials simply make the corresponding provider unavailable.
// ============================================================

import { Capability, ModelConfig, ProviderId } from './llmTypes';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

function envNum(name: string, fallback: number | undefined): number | undefined {
  const v = process.env[name];
  if (!v || v.trim().length === 0) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

// Provider API-key environment variables (server-side only).
export const PROVIDER_ENV_KEYS: Record<ProviderId, string> = {
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export function hasProviderCredentials(provider: ProviderId): boolean {
  return Boolean(process.env[PROVIDER_ENV_KEYS[provider]]);
}

const HIGH_CAPABILITIES: Capability[] = [
  'BUSINESS_PLAN',
  'APPLICATION_GENERATION',
  'CODE_GENERATION',
  'CODE_REPAIR',
  'JSON_GENERATION',
  'ANALYSIS',
  'PROJECT_ANALYSIS',
  'ADVERTISING_ANALYSIS',
  'ADVERTISING_CREATIVE',
];

const FAST_CAPABILITIES: Capability[] = [
  'CLASSIFICATION',
  'ANALYSIS',
  'JSON_GENERATION',
  'CODE_REPAIR',
  'BUSINESS_PLAN',
  'ADVERTISING_ANALYSIS',
];

/**
 * Build the model registry from environment configuration.
 * Models whose provider has no credentials are kept but marked
 * unavailable at selection time (so they can activate later without
 * a restart once credentials are added).
 */
export function getModelRegistry(): ModelConfig[] {
  return [
    // ---- Groq (existing primary provider) ----
    {
      provider: 'groq',
      model: env('GROQ_MODEL_PRIMARY', 'openai/gpt-oss-120b'),
      capabilities: HIGH_CAPABILITIES,
      priority: 100,
      maxInputTokens: envNum('GROQ_PRIMARY_MAX_INPUT', 131072) ?? 131072,
      maxOutputTokens: envNum('GROQ_PRIMARY_MAX_OUTPUT', 32768) ?? 32768,
      maxTokensPerMinute: envNum('GROQ_TPM_LIMIT', 8000),
      maxRequestsPerMinute: envNum('GROQ_RPM_LIMIT', undefined),
      estimatedCostPer1kTokens: 0.02,
      supportsJsonMode: true,
      enabled: envBool('GROQ_PRIMARY_ENABLED', true),
      envKey: PROVIDER_ENV_KEYS.groq,
    },
    {
      provider: 'groq',
      model: env('GROQ_MODEL_FALLBACK', 'openai/gpt-oss-20b'),
      capabilities: FAST_CAPABILITIES,
      priority: 80,
      maxInputTokens: envNum('GROQ_FALLBACK_MAX_INPUT', 131072) ?? 131072,
      maxOutputTokens: envNum('GROQ_FALLBACK_MAX_OUTPUT', 16384) ?? 16384,
      maxTokensPerMinute: envNum('GROQ_TPM_LIMIT', 8000),
      maxRequestsPerMinute: envNum('GROQ_RPM_LIMIT', undefined),
      estimatedCostPer1kTokens: 0.02,
      supportsJsonMode: true,
      enabled: envBool('GROQ_FALLBACK_ENABLED', true),
      envKey: PROVIDER_ENV_KEYS.groq,
    },

    // ---- Cerebras ----
    {
      provider: 'cerebras',
      model: env('CEREBRAS_MODEL_PRIMARY', 'gpt-oss-120b'),
      capabilities: HIGH_CAPABILITIES,
      priority: 60,
      maxInputTokens: envNum('CEREBRAS_PRIMARY_MAX_INPUT', 131072) ?? 131072,
      maxOutputTokens: envNum('CEREBRAS_PRIMARY_MAX_OUTPUT', 32768) ?? 32768,
      maxTokensPerMinute: envNum('CEREBRAS_TPM_LIMIT', undefined),
      estimatedCostPer1kTokens: 0.1,
      supportsJsonMode: true,
      enabled: envBool('CEREBRAS_PRIMARY_ENABLED', true),
      envKey: PROVIDER_ENV_KEYS.cerebras,
    },
    {
      provider: 'cerebras',
      model: env('CEREBRAS_MODEL_SECONDARY', 'llama-3.1-8b'),
      capabilities: FAST_CAPABILITIES,
      priority: 55,
      maxInputTokens: envNum('CEREBRAS_SECONDARY_MAX_INPUT', 131072) ?? 131072,
      maxOutputTokens: envNum('CEREBRAS_SECONDARY_MAX_OUTPUT', 16384) ?? 16384,
      maxTokensPerMinute: envNum('CEREBRAS_TPM_LIMIT', undefined),
      estimatedCostPer1kTokens: 0.1,
      supportsJsonMode: true,
      enabled: envBool('CEREBRAS_SECONDARY_ENABLED', true),
      envKey: PROVIDER_ENV_KEYS.cerebras,
    },

    // ---- Google Gemini (AI Studio OpenAI-compatible endpoint) ----
    {
      provider: 'gemini',
      model: env('GEMINI_MODEL_PRIMARY', 'gemini-3.1-flash-lite'),
      capabilities: [
        'CLASSIFICATION',
        'ANALYSIS',
        'JSON_GENERATION',
        'CODE_GENERATION',
        'CODE_REPAIR',
        'BUSINESS_PLAN',
        'PROJECT_ANALYSIS',
        'ADVERTISING_ANALYSIS',
      ],
      priority: 40,
      maxInputTokens: envNum('GEMINI_PRIMARY_MAX_INPUT', 1048576) ?? 1048576,
      maxOutputTokens: envNum('GEMINI_PRIMARY_MAX_OUTPUT', 8192) ?? 8192,
      maxTokensPerMinute: envNum('GEMINI_TPM_LIMIT', undefined),
      estimatedCostPer1kTokens: 0.0,
      supportsJsonMode: true,
      enabled: envBool('GEMINI_PRIMARY_ENABLED', true),
      envKey: PROVIDER_ENV_KEYS.gemini,
    },

    // ---- OpenRouter (emergency/final fallback) ----
    {
      provider: 'openrouter',
      model: env('OPENROUTER_MODEL', 'openai/gpt-oss-120b'),
      capabilities: HIGH_CAPABILITIES,
      priority: 20,
      maxInputTokens: envNum('OPENROUTER_MAX_INPUT', 131072) ?? 131072,
      maxOutputTokens: envNum('OPENROUTER_MAX_OUTPUT', 32768) ?? 32768,
      maxTokensPerMinute: envNum('OPENROUTER_TPM_LIMIT', undefined),
      estimatedCostPer1kTokens: 0.5,
      supportsJsonMode: true,
      enabled: envBool('OPENROUTER_ENABLED', true),
      envKey: PROVIDER_ENV_KEYS.openrouter,
    },
  ];
}
