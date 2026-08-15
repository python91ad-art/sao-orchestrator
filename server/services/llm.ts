import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'gsk_dummy' });

/**
 * Default models on Groq (free tier):
 * - llama-3.3-70b-versatile  → business plan generation (high quality)
 * - llama-3.1-8b-instant     → classification & safety checks (fast)
 */
export const MODEL_BUSINESS_PLAN = 'llama-3.3-70b-versatile';
export const MODEL_CLASSIFIER = 'llama-3.1-8b-instant';
export const MODEL_GENERIC = 'llama-3.3-70b-versatile';

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
    console.error('[Groq LLM] callLLM failed:', error);
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
  if (!process.env.GROQ_API_KEY) {
    return { success: false, message: 'GROQ_API_KEY is not configured' };
  }
  try {
    const response = await callLLM('Reply with "OK"', {
      model: MODEL_CLASSIFIER,
      maxTokens: 10,
    });
    return {
      success: true,
      message: `Groq connected — model ${MODEL_CLASSIFIER} responded`,
      model: MODEL_CLASSIFIER,
    };
  } catch (error: any) {
    return { success: false, message: error.message || 'Groq connection failed' };
  }
}
