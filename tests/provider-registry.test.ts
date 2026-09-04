// ============================================================
// PROVIDER REGISTRY — integration test (real DB)
// ============================================================
import 'dotenv/config';
import { encryptCredential, decryptCredential, redactCredential } from '../server/services/credentialCrypto';
import * as registry from '../server/services/providerRegistry';

const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('=== PROVIDER REGISTRY TEST ===\n');

  // 1. Encryption roundtrip
  {
    const secret = 'sk-live-abcdef123456';
    const enc = encryptCredential(secret);
    record('Encryption roundtrip', decryptCredential(enc) === secret);
    record('Redaction hides secret', redactCredential(secret) === '••••••••••••3456' && !redactCredential(secret).includes('abcdef'));
  }

  // 2. Save + list (secret never returned in plaintext)
  let savedId: string | null = null;
  {
    const saved = await registry.saveProvider({
      service: 'search',
      name: 'Test Tavily',
      providerId: 'tavily',
      credential: 'tvly-test-key-1234',
      priority: 'primary',
    });
    savedId = saved!.id;
    const list = await registry.listProviders('search');
    const mine = list.find((p) => p.id === savedId);
    record(
      'Save + list (encrypted at rest, masked on read)',
      Boolean(mine) && mine!.hasCredential === true && mine!.maskedCredential === '••••••••••••1234' && !JSON.stringify(mine).includes('tvly-test-key'),
      mine?.maskedCredential || ''
    );
  }

  // 3. Compatibility detection (unknown provider -> adapter_required)
  {
    const custom = await registry.saveProvider({ service: 'search', name: 'Custom X', providerId: 'custom', credential: 'abc123' });
    const rec = await registry.getProviderRecord(custom!.id);
    record('Custom provider flagged adapter_required', rec?.compatibilityStatus === 'adapter_required');
    await registry.deleteProvider(custom!.id);
  }

  // 4. Test (invalid key -> invalid_key) using a fake key
  {
    const bad = await registry.saveProvider({ service: 'llm', name: 'Bad Groq', providerId: 'groq', credential: 'gsk_invalid' });
    const outcome = await registry.testProvider(bad!.id);
    record(
      'Test returns real failure (no false success)',
      outcome.status !== 'connected',
      outcome.status
    );
    const after = await registry.getProviderRecord(bad!.id);
    record('Test persisted connection status', after?.connectionStatus === outcome.status);
    await registry.deleteProvider(bad!.id);
  }

  // 5. Test (valid key -> connected) using real env key
  {
    const realKey = process.env.TAVILY_API_KEY;
    if (realKey) {
      const good = await registry.saveProvider({ service: 'search', name: 'Real Tavily', providerId: 'tavily', credential: realKey });
      const outcome = await registry.testProvider(good!.id);
      record('Test returns connected for valid key', outcome.status === 'connected', outcome.status);
      await registry.deleteProvider(good!.id);
    } else {
      record('Test connected (skipped — no TAVILY_API_KEY)', true, 'skipped');
    }
  }

  // 6. resolveCredential precedence (dashboard -> env)
  {
    const saved = await registry.saveProvider({ service: 'search', name: 'Precedence', providerId: 'tavily', credential: 'dashboard-secret' });
    const resolved = await registry.resolveCredential('tavily', ['TAVILY_API_KEY']);
    record(
      'Credential precedence: dashboard over env',
      resolved.source === 'dashboard' && resolved.value === 'dashboard-secret'
    );
    await registry.deleteProvider(saved!.id);
  }

  // cleanup any remaining tavily credentials, then verify env fallback.
  if (savedId) await registry.deleteProvider(savedId);
  {
    const list = await registry.listProviders('search');
    for (const p of list) {
      if (p.providerId === 'tavily') await registry.deleteProvider(p.id);
    }
    const fallback = await registry.resolveCredential('tavily', ['TAVILY_API_KEY']);
    record(
      'Credential precedence: env fallback after delete',
      fallback.source === 'env' && fallback.value === (process.env.TAVILY_API_KEY || null)
    );
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
