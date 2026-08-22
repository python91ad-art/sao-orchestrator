import Groq from 'groq-sdk';
import { getCredential } from './credentials';

/**
 * Default models on Groq (free tier):
 * - llama-3.3-70b-versatile  → business plan generation (high quality)
 * - llama-3.1-8b-instant     → classification & safety checks (fast)
 */
export const MODEL_BUSINESS_PLAN = 'openai/gpt-oss-120b';
export const MODEL_CLASSIFIER = 'openai/gpt-oss-20b';
export const MODEL_GENERIC = 'openai/gpt-oss-20b';

export interface LLMResponse {
  content: string;
  model: string;
}

/**
 * Unified LLM call via Groq (free, fast).
 * Returns the raw text response.
 */
export async function callLLM(
  prompt: string,
  options?: {
    model?: string;
    systemPrompt?: string;
    jsonMode?: boolean;
    maxTokens?: number;
    temperature?: number;
  }
): Promise<string> {
  const apiKey = await getCredential('groq');
  if (!apiKey) {
    throw new Error('Groq API key is not configured.');
  }

  const groq = new Groq({ apiKey });
  const model = options?.model || MODEL_GENERIC;
  const messages: any[] = [];

  if (options?.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  try {
    const completion = await groq.chat.completions.create({
      model,
      messages,
      max_tokens: options?.maxTokens || 4096,
      temperature: options?.temperature ?? 0.7,
      response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Groq returned empty response');
    return content;
  } catch (error) {
    console.error('[Groq LLM] callLLM failed:', error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Call LLM and parse the response as JSON.
 * Falls back to extracting JSON from the text if direct parse fails.
 */
export async function callLLMJson<T = any>(
  prompt: string,
  options?: {
    model?: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }
): Promise<T> {
  const text = await callLLM(prompt, {
    ...options,
    jsonMode: true,
  });

  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON from within markdown code blocks or mixed text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('Failed to parse LLM response as JSON');
  }
}

/**
 * Test Groq connectivity — used by the integrations router.
 */
export async function testGroqConnection(): Promise<{
  success: boolean;
  message: string;
  model?: string;
}> {
  if (!(await getCredential('groq'))) {
    return { success: false, message: 'Groq API key is not configured.' };
  }
  try {
    await callLLM('Reply with "OK"', {
      model: MODEL_CLASSIFIER,
      maxTokens: 100,
      temperature: 0,
    });
    return {
      success: true,
      message: `Groq connection successful. Model ${MODEL_CLASSIFIER} responded.`,
      model: MODEL_CLASSIFIER,
    };
  } catch {
    return { success: false, message: 'Groq authentication or connectivity check failed.' };
  }
}
