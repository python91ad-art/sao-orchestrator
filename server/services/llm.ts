// ============================================================
// LLM FACADE (Phase 12)
//
// Public interface preserved for backward compatibility:
//   callLLM(prompt, options?)   -> string
//   callLLMJson<T>(prompt, o?)  -> T
//
// Internally, all calls are routed through the provider-agnostic LLM
// router. Callers do not need to know which provider/model handled
// the request.
// ============================================================

import { Capability, LLMRouterExhaustedError, ProviderId } from './llmTypes';
import { route, getRouterStatus, resetProvider, resetRouterState, estimateTokens } from './llmRouter';

// Re-export for callers/tests.
export { LLMRouterExhaustedError, estimateTokens };
export { getRouterStatus, resetProvider, resetRouterState };

export interface LLMResponse {
  content: string;
  model: string;
}

// Capability markers. These replaced raw Groq model ids so the router
// can map a logical request type to the best available model.
export const MODEL_BUSINESS_PLAN = 'BUSINESS_PLAN';
export const MODEL_CLASSIFIER = 'CLASSIFICATION';
export const MODEL_GENERIC = 'ANALYSIS';

export interface LLMCallOptions {
  model?: string;
  systemPrompt?: string;
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Explicit capability. Overrides any inferred capability from `model`. */
  task?: Capability;
}

function resolveTask(options?: LLMCallOptions): Capability {
  if (options?.task) return options.task;
  if (options?.model === MODEL_BUSINESS_PLAN) return 'BUSINESS_PLAN';
  if (options?.model === MODEL_CLASSIFIER) return 'CLASSIFICATION';
  if (options?.model === MODEL_GENERIC) {
    return options?.jsonMode ? 'JSON_GENERATION' : 'ANALYSIS';
  }
  return options?.jsonMode ? 'JSON_GENERATION' : 'ANALYSIS';
}

/**
 * Unified LLM call. Returns the raw text response.
 */
export async function callLLM(prompt: string, options?: LLMCallOptions): Promise<string> {
  const result = await route({
    task: resolveTask(options),
    prompt,
    systemPrompt: options?.systemPrompt,
    jsonMode: options?.jsonMode || false,
    maxTokens: options?.maxTokens || 4096,
    temperature: options?.temperature ?? 0.7,
  });
  return result.text;
}

/**
 * Call LLM and parse the response as JSON. Retries once with another
 * compatible model when a provider returns malformed JSON.
 */
export async function callLLMJson<T = any>(prompt: string, options?: LLMCallOptions): Promise<T> {
  return (await callLLMJsonWithMeta<T>(prompt, options)).data;
}

/**
 * Like callLLMJson but also returns which provider/model produced the
 * response (for observability, e.g. application generation reporting).
 */
export async function callLLMJsonWithMeta<T = any>(
  prompt: string,
  options?: LLMCallOptions
): Promise<{ data: T; model: string; provider: ProviderId }> {
  const task = resolveTask({ ...options, jsonMode: true });
  const excludeModels: string[] = [];
  const maxAttempts = 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await route({
      task,
      prompt,
      systemPrompt: options?.systemPrompt,
      jsonMode: true,
      maxTokens: options?.maxTokens || 4096,
      temperature: options?.temperature ?? 0.3,
      excludeModels,
    });

    try {
      return { data: JSON.parse(result.text) as T, model: result.model, provider: result.provider };
    } catch {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return {
            data: JSON.parse(jsonMatch[0]) as T,
            model: result.model,
            provider: result.provider,
          };
        } catch {
          /* fall through to retry with another model */
        }
      }
      console.warn(
        `[LLM] Model ${result.provider}/${result.model} returned malformed JSON — retrying with another model.`
      );
      excludeModels.push(result.model);
    }
  }

  throw new Error('Failed to parse LLM response as JSON');
}

/**
 * Test connectivity through the router (Groq-first). Kept for the
 * existing integrations router.
 */
export async function testGroqConnection(): Promise<{
  success: boolean;
  message: string;
  model?: string;
}> {
  if (!process.env.GROQ_API_KEY) {
    return { success: false, message: 'GROQ_API_KEY is not configured' };
  }
  try {
    const result = await route({
      task: 'CLASSIFICATION',
      prompt: 'Reply with "OK"',
      jsonMode: false,
      maxTokens: 100,
      temperature: 0,
    });
    return {
      success: true,
      message: `LLM connected — model ${result.model} responded`,
      model: result.model,
    };
  } catch (error: any) {
    return { success: false, message: error.message || 'LLM connection failed' };
  }
}

/**
 * Report the full LLM router health for admin visibility. Never
 * includes API keys — only SET/MISSING per provider.
 */
export function testLLMRouter(): {
  success: boolean;
  message: string;
  providers: ReturnType<typeof getRouterStatus>;
} {
  const status = getRouterStatus();
  const configured = status.filter((s) => s.credentials === 'SET').length;
  return {
    success: configured > 0,
    message:
      configured > 0
        ? `${configured} provider(s) configured; see per-provider status.`
        : 'No LLM providers configured (all API keys missing).',
    providers: status,
  };
}

