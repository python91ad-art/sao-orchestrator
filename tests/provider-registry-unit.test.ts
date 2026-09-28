// ============================================================
// PROVIDER REGISTRY — Comprehensive Unit Tests
// Tests real crypto, descriptors, adapter detection, resolution logic,
// and secret protection without requiring an external DB.
// ============================================================

import { encryptCredential, decryptCredential, redactCredential } from '../server/services/credentialCrypto';
import {
  getKnownProviders,
  getProviderDescriptor,
  hasAdapter,
  isSupportedService,
  SERVICE_TYPES,
} from '../server/services/providerRegistry';
import {
  hasProviderCredentials,
  hasProviderCredentialsAsync,
  getModelRegistry,
  PROVIDER_ENV_KEYS,
} from '../server/services/llmModels';
import { getProviders } from '../server/services/llmProviders';
import { getRouterStatus } from '../server/services/llmRouter';
import { hasNowPaymentsApiKey, hasNowPaymentsApiKeyAsync } from '../server/services/nowpayments';

const results: { name: string; pass: boolean; detail?: string }[] = [];

function record(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('\n=== Provider Registry Unit Tests ===\n');

  // --- 1. Credential Encryption & Decryption ---
  console.log('--- 1. Cryptographic Security ---');
  {
    const secret = 'sk-proj-test1234567890abcdefghijklmnopqrstuvwxyz';
    const encrypted = encryptCredential(secret);
    const decrypted = decryptCredential(encrypted);

    record('Encryption produces ciphertext different from plaintext', encrypted !== secret);
    record('Encryption round-trip preserves exact secret', decrypted === secret);
    record('Ciphertext does not contain plaintext secret substring', !encrypted.includes('1234567890'));

    // Different IV per encryption
    const encrypted2 = encryptCredential(secret);
    record('Different encryptions of same secret produce different ciphertexts (random IV)', encrypted !== encrypted2);
    record('Second ciphertext decrypts to same secret', decryptCredential(encrypted2) === secret);
  }

  // --- 2. Redaction / Secret Masking ---
  console.log('\n--- 2. Secret Redaction ---');
  {
    record('Redaction keeps only last 4 chars', redactCredential('sk-1234567890abcdef') === '••••••••••••cdef');
    record('Redaction handles short secrets safely', redactCredential('abc') === '••••');
    record('Redaction handles empty secrets', redactCredential('') === '');
    record('Redaction never exposes start/middle of token', !redactCredential('very_secret_token_1234').includes('very_secret'));
  }

  // --- 3. Supported Service Types & Descriptors ---
  console.log('\n--- 3. Known Providers & Service Types ---');
  {
    const known = getKnownProviders();
    const knownIds = known.map((p) => p.id);

    record('Supports all 5 core service types', SERVICE_TYPES.length === 5);
    record('isSupportedService accepts valid types', isSupportedService('search') && isSupportedService('llm') && isSupportedService('deployment') && isSupportedService('advertising') && isSupportedService('payments'));
    record('isSupportedService rejects unknown types', !isSupportedService('arbitrary_fake_type'));

    record('Contains Tavily adapter', knownIds.includes('tavily') && hasAdapter('tavily'));
    record('Contains Groq adapter', knownIds.includes('groq') && hasAdapter('groq'));
    record('Contains Gemini adapter', knownIds.includes('gemini') && hasAdapter('gemini'));
    record('Contains Cerebras adapter', knownIds.includes('cerebras') && hasAdapter('cerebras'));
    record('Contains OpenRouter adapter', knownIds.includes('openrouter') && hasAdapter('openrouter'));
    record('Contains Vercel adapter', knownIds.includes('vercel') && hasAdapter('vercel'));
    record('Contains NOWPayments adapter', knownIds.includes('nowpayments') && hasAdapter('nowpayments'));

    record('hasAdapter returns false for unknown provider', !hasAdapter('unknown_nonexistent_provider'));
  }

  // --- 4. Provider Descriptors & Test Callbacks ---
  console.log('\n--- 4. Provider Descriptors & Envs ---');
  {
    const tavily = getProviderDescriptor('tavily');
    record('Tavily descriptor configured for search', tavily?.serviceType === 'search' && tavily?.credentialType === 'api_key');

    const groq = getProviderDescriptor('groq');
    record('Groq descriptor configured for llm', groq?.serviceType === 'llm' && groq?.credentialType === 'api_key');

    const vercel = getProviderDescriptor('vercel');
    record('Vercel descriptor configured for deployment', vercel?.serviceType === 'deployment' && vercel?.credentialType === 'token');

    const nowpayments = getProviderDescriptor('nowpayments');
    record('NOWPayments descriptor configured for payments', nowpayments?.serviceType === 'payments' && nowpayments?.credentialType === 'api_key');
  }

  // --- 5. LLM Model Registry & Provider Adapters ---
  console.log('\n--- 5. LLM Router Integration ---');
  {
    const models = getModelRegistry();
    record('Model registry has models configured', models.length >= 4);

    const providers = getProviders();
    const providerIds = providers.map((p) => p.id);
    record('LLM provider adapters instantiated', providerIds.includes('groq') && providerIds.includes('cerebras') && providerIds.includes('gemini') && providerIds.includes('openrouter'));

    const status = getRouterStatus();
    record('Router status reports credentials as SET/MISSING only', status.every((s) => s.credentials === 'SET' || s.credentials === 'MISSING'));
    record('Router status contains no plaintext secrets', !JSON.stringify(status).includes('sk_') && !JSON.stringify(status).includes('gsk_'));
  }

  // --- 6. Async Fallback Resolution Checks ---
  console.log('\n--- 6. Resolution Checks ---');
  {
    const groqHasCreds = typeof hasProviderCredentials('groq') === 'boolean';
    record('hasProviderCredentials returns boolean', groqHasCreds);

    const nowpaymentsHasCreds = typeof hasNowPaymentsApiKey() === 'boolean';
    record('hasNowPaymentsApiKey returns boolean', nowpaymentsHasCreds);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
