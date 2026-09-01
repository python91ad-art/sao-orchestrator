// Live provider connectivity tests — validates credentials + model availability.
// Only prints SET/MISSING status, never actual key values.
import 'dotenv/config';

const TIMEOUT = 15000;

async function testProvider(name: string, envKey: string, baseUrl: string, models: string[]): Promise<void> {
  const key = process.env[envKey];
  console.log(`\n=== ${name.toUpperCase()} ===`);
  console.log(`Key: ${key ? 'SET' : 'MISSING'}`);
  console.log(`URL: ${baseUrl}`);
  
  if (!key) { console.log('Result: SKIPPED (no credentials)\n'); return; }
  
  for (const model of models) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), TIMEOUT);
      
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with just the word OK' }], max_tokens: 10 }),
        signal: controller.signal,
      });
      clearTimeout(t);
      
      const body = await resp.text();
      if (resp.ok) {
        const data = JSON.parse(body);
        const content = data?.choices?.[0]?.message?.content || '(empty)';
        console.log(`Model ${model}: OK (${resp.status}) — "${content.trim()}"`);
      } else if (resp.status === 429) {
        console.log(`Model ${model}: RATE_LIMITED (429)`);
      } else if (resp.status === 401 || resp.status === 403) {
        console.log(`Model ${model}: AUTH_ERROR (${resp.status})`);
      } else if (resp.status === 404) {
        console.log(`Model ${model}: NOT_FOUND (404)`);
      } else {
        const snippet = body.slice(0, 200);
        console.log(`Model ${model}: ERROR (${resp.status}) — ${snippet}`);
      }
    } catch (e: any) {
      if (e.name === 'AbortError') console.log(`Model ${model}: TIMEOUT`);
      else console.log(`Model ${model}: FETCH_ERROR — ${e.message?.slice(0, 150)}`);
    }
  }
}

async function main() {
  console.log('=== LIVE AI PROVIDER CONNECTIVITY TESTS ===');
  console.log('Testing authentication + model availability.');
  console.log('No actual keys are printed below.\n');
  
  await testProvider('Groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1', ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  await testProvider('Cerebras', 'CEREBRAS_API_KEY', 'https://api.cerebras.ai/v1', ['llama-3.3-70b']);
  await testProvider('Gemini', 'GEMINI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/openai', ['gemini-2.0-flash']);
  await testProvider('OpenRouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1', ['openai/gpt-oss-120b']);
  
  console.log('\n=== LIVE TESTS COMPLETE ===');
}

main().catch(e => { console.error('Test failed:', e.message); process.exit(1); });
