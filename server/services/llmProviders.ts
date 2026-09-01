// ============================================================
// LLM ROUTER — provider adapters (Phase 12)
//
// Each provider is isolated behind a common interface so the rest of
// the application never sees provider-specific details. API keys are
// read from process.env at call time and NEVER logged or returned.
// ============================================================

import Groq from 'groq-sdk';
import {
  ErrorCategory,
  LLMProviderError,
  LLMUsage,
  ProviderId,
} from './llmTypes';

const DEFAULT_TIMEOUT_MS = 60_000;

export interface ProviderMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ProviderRequest {
  messages: ProviderMessage[];
  maxTokens: number;
  temperature: number;
  jsonMode: boolean;
}

export interface ProviderCompletion {
  text: string;
  usage: LLMUsage;
  model: string;
}

export interface LLMProvider {
  id: ProviderId;
  complete(model: string, req: ProviderRequest): Promise<ProviderCompletion>;
}

function redactMessage(message: string): string {
  const clean = String(message || '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 200);
}

function parseRetryAfter(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n * 1000;
    const d = Date.parse(value);
    if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  }
  return undefined;
}

function getRetryAfterHeader(headers: unknown): unknown {
  if (!headers) return undefined;
  if (typeof (headers as any).get === 'function') {
    return (headers as any).get('retry-after');
  }
  const h = headers as Record<string, unknown>;
  return h['retry-after'] ?? h['Retry-After'];
}

/**
 * Classify an arbitrary provider error into a routing category.
 * Category determines rotation/retry/cooldown behaviour.
 */
export function classifyError(
  provider: ProviderId,
  model: string,
  error: unknown
): LLMProviderError {
  const e = error as any;
  const rawMsg = e?.message || e?.error?.message || String(error || 'unknown error');
  const status = e?.status ?? e?.statusCode ?? e?.response?.status ?? e?.error?.status;
  const retryAfterMs = parseRetryAfter(
    getRetryAfterHeader(e?.headers ?? e?.response?.headers) ?? e?.retryAfterMs
  );

  const msg = String(rawMsg);

  let category: ErrorCategory = 'unknown';

  if (status === 429 || /rate.?limit|too many requests|quota|tokens per minute|requests per minute|tpm|rpm/i.test(msg)) {
    category = 'rate_limit';
  } else if (status === 401 || status === 403 || /unauthorized|forbidden|invalid api key|authentication|not authenticated/i.test(msg)) {
    category = 'auth';
  } else if (status === 404 || /model.*(not found|does not exist|unavailable)|invalid model/i.test(msg)) {
    category = 'invalid_model';
  } else if (status === 400 || status === 422) {
    if (/content|policy|safety|inappropriate|refus/i.test(msg)) category = 'content_policy';
    else category = 'invalid_request';
  } else if (status && status >= 500) {
    category = 'server_error';
  } else if (/timed? ?out|abort|ETIMEDOUT/i.test(msg)) {
    category = 'timeout';
  } else if (/network|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|socket|getaddrinfo/i.test(msg)) {
    category = 'network';
  }

  return new LLMProviderError({
    category,
    message: redactMessage(rawMsg),
    provider,
    model,
    status: status ? Number(status) : undefined,
    retryAfterMs,
  });
}

function parseUsage(usage: any): LLMUsage {
  if (!usage) return {};
  return {
    inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
  };
}

// ------------------------------------------------------------
// Groq adapter (existing primary provider — uses groq-sdk)
// ------------------------------------------------------------
class GroqProvider implements LLMProvider {
  readonly id: ProviderId = 'groq';

  async complete(model: string, req: ProviderRequest): Promise<ProviderCompletion> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new LLMProviderError({
        category: 'auth',
        message: 'GROQ_API_KEY is not configured',
        provider: this.id,
        model,
      });
    }

    const client = new Groq({ apiKey, timeout: DEFAULT_TIMEOUT_MS });
    const completion = await client.chat.completions.create({
      model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      response_format: req.jsonMode ? { type: 'json_object' as any } : undefined,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
      throw new LLMProviderError({
        category: 'unknown',
        message: 'Groq returned empty response',
        provider: this.id,
        model,
      });
    }

    return { text: content, model, usage: parseUsage(completion.usage) };
  }
}

// ------------------------------------------------------------
// OpenAI-compatible HTTP adapter base (Cerebras, Gemini, OpenRouter)
// ------------------------------------------------------------
interface CompatConfig {
  id: ProviderId;
  envKey: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
}

class OpenAICompatProvider implements LLMProvider {
  readonly id: ProviderId;
  private cfg: CompatConfig;

  constructor(cfg: CompatConfig) {
    this.id = cfg.id;
    this.cfg = cfg;
  }

  async complete(model: string, req: ProviderRequest): Promise<ProviderCompletion> {
    const apiKey = process.env[this.cfg.envKey];
    if (!apiKey) {
      throw new LLMProviderError({
        category: 'auth',
        message: `${this.cfg.envKey} is not configured`,
        provider: this.id,
        model,
      });
    }

    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    };
    if (req.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(this.cfg.extraHeaders || {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const category = classifyError(this.id, model, {
        message: text,
        status: response.status,
        headers: response.headers,
      }).category;
      throw new LLMProviderError({
        category,
        message: redactMessage(text),
        provider: this.id,
        model,
        status: response.status,
        retryAfterMs: parseRetryAfter(getRetryAfterHeader(response.headers)),
      });
    }

    const data: any = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new LLMProviderError({
        category: 'unknown',
        message: `${this.id} returned empty response`,
        provider: this.id,
        model,
      });
    }

    return { text: content, model, usage: parseUsage(data?.usage) };
  }
}

function envUrl(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim().replace(/\/+$/, '') : fallback;
}

export function getProviders(): LLMProvider[] {
  return [
    new GroqProvider(),
    new OpenAICompatProvider({
      id: 'cerebras',
      envKey: 'CEREBRAS_API_KEY',
      baseUrl: envUrl('CEREBRAS_API_URL', 'https://api.cerebras.ai/v1'),
    }),
    new OpenAICompatProvider({
      id: 'gemini',
      envKey: 'GEMINI_API_KEY',
      baseUrl: envUrl(
        'GEMINI_API_URL',
        'https://generativelanguage.googleapis.com/v1beta/openai'
      ),
    }),
    new OpenAICompatProvider({
      id: 'openrouter',
      envKey: 'OPENROUTER_API_KEY',
      baseUrl: envUrl('OPENROUTER_API_URL', 'https://openrouter.ai/api/v1'),
      extraHeaders: {
        'HTTP-Referer': 'https://sao.local',
        'X-Title': 'SAO Orchestrator',
      },
    }),
  ];
}
