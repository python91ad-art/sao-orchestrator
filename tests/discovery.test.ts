import assert from 'node:assert/strict';
import { WebSearchRouter, normalizeSearchResponse, type SearchProvider } from '../server/services/webSearch';
import { memoryRuntime, acquireDiscoveryLease } from '../server/services/discoveryRuntime';
import { extractQualifiedGaps, validateDiscoveryProposal, type DiscoveryEvidence } from '../server/services/discoveryEvidence';
import { discoverOns, compatibleSignal } from '../server/services/onsDiscovery';
import { OnsAdapter, clearDiscoveryEvidenceCache } from '../server/services/businessData';
import { runDiscoveryCycle, deduplicateCandidates } from '../server/services/discovery';
import { discoveryConfigSchema } from '../server/services/providerRegistry';

const now = Date.now();
const iso = new Date(now).toISOString();
const url = 'https://retail.example.org/research';
const words = { knows: 'UK independent retailers know their inventory', needs: 'UK independent retailers lose orders to stock errors', controlsAccess: 'Retail platforms control access to inventory feeds', underestimatesValue: 'Manual reconciliation costs exceed automation costs' };
const context = Object.values(words).join('. ');
const makeProposal = (id = 'context') => ({ ...words, problem: { evidenceId: id, quote: words.needs }, audience: { evidenceId: id, quote: 'UK independent retailers' }, market: { evidenceId: id, quote: 'UK independent retailers' },
  support: Object.fromEntries(Object.entries(words).map(([field, quote]) => [field, { evidenceId: id, quote }])),
  hypothesis: 'Test inventory reconciliation with retailers; willingness to pay is unknown.', strength: 'moderate', statisticalClaims: [] });
const evidence: DiscoveryEvidence = { id: 'context', provider: 'tavily', url, title: 'Retail operational study', text: context, retrievedAt: iso, publishedAt: iso };
const tavily = { results: [{ url, title: 'Retail study', content: context, published_date: iso }] };
const gemini = { candidates: [{ content: { parts: [{ text: context }] }, groundingMetadata: {
  webSearchQueries: ['retail inventory'], groundingChunks: [{ web: { uri: url, title: 'Retail study' } }],
  groundingSupports: [{ segment: { text: context }, groundingChunkIndices: [0] }], searchEntryPoint: { renderedContent: '<div>Search suggestions</div>' },
} }] };
const groq = { choices: [{ message: { content: 'Ordinary completion is ignored', executed_tools: [{ type: 'browser_search', index: 0, arguments: '{}', browser_results: [{ url, title: 'Retail study', content: context }] }] } }] };
const openrouter = { choices: [{ message: { annotations: [{ type: 'url_citation', url_citation: { url, title: 'Retail study', content: context } }] } }] };
const approved = { enabled: true, model: 'gemini-2.5-flash', billingApproved: true, accountSpendLimitConfirmed: true, maxRequestsPerDay: 20, dailyBudgetUsd: 1, maxRequestCostUsd: 0.05 };
const response = (body: any, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
let passed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) { await run(); passed++; console.log(`PASS ${name}`); }
function router(replies: Partial<Record<SearchProvider, any>>, opts: { mutate?: ReturnType<typeof memoryRuntime>; config?: any; sleep?: (ms: number) => Promise<void>; time?: () => number } = {}) {
  const calls: SearchProvider[] = [];
  const requests: { provider: SearchProvider; init: RequestInit }[] = [];
  const cfg: any = opts.config || {};
  const service = new WebSearchRouter({
    resolve: async p => ({ enabled: cfg[p]?.disabled !== true, key: replies[p] === undefined ? null : 'secret-key', revision: cfg[p]?.revision || '1',
      config: { ...approved, model: p === 'groq' ? 'openai/gpt-oss-20b' : p === 'openrouter' ? 'example/approved-model' : approved.model, ...cfg[p] } }),
    mutate: opts.mutate || memoryRuntime(), now: opts.time || (() => now), sleep: opts.sleep || (async () => {}),
    fetch: (async (input, init) => {
      const str = String(input);
      const provider = str.includes('tavily') ? 'tavily' : str.includes('googleapis') ? 'gemini' : str.includes('groq') ? 'groq' : 'openrouter';
      calls.push(provider); requests.push({ provider, init: init! });
      const reply = replies[provider];
      if (reply instanceof Error) throw reply;
      if (reply instanceof Response) return reply.clone();
      return typeof reply === 'number' ? response({ error: 'secret-key MUST NOT BE EXPOSED' }, reply) : response(reply);
    }) as typeof fetch,
  });
  return { service, calls, requests };
}

async function main() {
  await test('Tavily normal results retain source, text, date and attribution', async () => {
    const r = router({ tavily, gemini }); const result = await r.service.search('inventory');
    assert.equal(result.provider, 'tavily'); assert.deepEqual(r.calls, ['tavily']);
    const body = JSON.parse(String(r.requests[0].init.body));
    assert.equal(body.search_depth, 'basic'); assert.equal(body.auto_parameters, false); assert.equal(body.include_published_date, true);
    assert.ok(!String(r.requests[0].init.body).includes('secret-key'));
    assert.equal((r.requests[0].init.headers as any).Authorization, 'Bearer secret-key');
    assert.equal(result.results[0].publishedAt, iso); assert.equal(result.results[0].provider, 'tavily');
  });
  await test('Genuine empty Tavily success does not invoke fallback', async () => {
    const r = router({ tavily: { results: [] }, gemini }); assert.equal((await r.service.search('inventory')).status, 'zero_results'); assert.deepEqual(r.calls, ['tavily']);
  });
  await test('HTTP 432 falls back to Gemini and persists a quota circuit across router restarts', async () => {
    const mutate = memoryRuntime(); const r = router({ tavily: 432, gemini }, { mutate });
    assert.equal((await r.service.search('inventory')).provider, 'gemini');
    const next = router({ tavily: 432, gemini }, { mutate });
    const outcome = await next.service.search('new query');
    assert.deepEqual(next.calls, ['gemini']); assert.equal(outcome.attempts[0].status, 'quota_exhausted');
    assert.ok(outcome.attempts[0].retryAt); assert.ok(!JSON.stringify(next.service.getStatus()).includes('secret-key'));
  });
  await test('Gemini failure invokes supported Groq browser search next', async () => {
    const r = router({ tavily: 401, gemini: 403, groq, openrouter });
    const o = await r.service.search('inventory'); assert.equal(o.provider, 'groq'); assert.deepEqual(r.calls, ['tavily', 'gemini', 'groq']); assert.equal(o.results[0].snippet, context);
  });
  await test('Groq failure invokes OpenRouter with attributed extractive results', async () => {
    const r = router({ tavily: 432, gemini: 401, groq: 403, openrouter });
    const o = await r.service.search('inventory'); assert.equal(o.provider, 'openrouter'); assert.deepEqual(r.calls, ['tavily', 'gemini', 'groq', 'openrouter']);
  });
  await test('All web providers unavailable is an explicit failure', async () => {
    const r = router({ tavily: 432, gemini: 401, groq: 403, openrouter: 402 }); const o = await r.service.search('inventory'); assert.equal(o.status, 'unavailable'); assert.equal(o.attempts.length, 4);
  });
  await test('Ungrounded completions and invented citation-only responses are rejected', async () => {
    for (const p of ['gemini', 'groq', 'openrouter'] as const) assert.throws(() => normalizeSearchResponse(p, { choices: [{ message: { content: context } }] }, 5, now));
    const r = router({ tavily: 432, gemini: { candidates: [{ content: { parts: [{ text: context }] } }] }, groq, openrouter });
    assert.equal((await r.service.search('inventory')).provider, 'groq');
  });
  await test('Grounded fallback searches with explicitly empty tool results remain genuine zero results', async () => {
    const emptyGemini = { candidates: [{ groundingMetadata: { webSearchQueries: ['query'], groundingChunks: [], groundingSupports: [] } }] };
    const r = router({ tavily: 432, gemini: emptyGemini, groq });
    assert.equal((await r.service.search('one')).status, 'zero_results'); assert.deepEqual(r.calls, ['tavily', 'gemini']);
    const emptyGroq = { choices: [{ message: { executed_tools: [{ type: 'browser_search', browser_results: [] }] } }] };
    const r2 = router({ tavily: 432, gemini: 401, groq: emptyGroq, openrouter });
    assert.equal((await r2.service.search('one')).status, 'zero_results'); assert.deepEqual(r2.calls, ['tavily', 'gemini', 'groq']);
  });
  await test('Unapproved billing, disabled providers and unsupported models never send requests', async () => {
    const r = router({ tavily: 432, gemini, groq, openrouter }, { config: { gemini: { billingApproved: false }, groq: { model: 'ordinary-llm' }, openrouter: { disabled: true } } });
    const o = await r.service.search('inventory'); assert.deepEqual(r.calls, ['tavily']);
    assert.equal(o.attempts[1].status, 'billing_blocked'); assert.equal(o.attempts[2].status, 'unsupported'); assert.equal(o.attempts[3].status, 'not_configured');
  });
  await test('Increasing Tavily allowance beyond the free reserve requires paid opt-in and budget', async () => {
    const r = router({ tavily }, { config: { tavily: { maxCreditsPerMonth: 2000, billingApproved: false } } });
    const result = await r.service.search('one'); assert.equal(result.attempts[0].status, 'billing_blocked'); assert.equal(r.calls.length, 0);
  });
  await test('Durable spend reservations bound calls including failed requests', async () => {
    const r = router({ tavily: 432, gemini }, { config: { gemini: { dailyBudgetUsd: 0.05 } } });
    assert.equal((await r.service.search('one')).provider, 'gemini'); assert.equal((await r.service.search('two')).status, 'unavailable'); assert.deepEqual(r.calls, ['tavily', 'gemini']);
  });
  await test('Transient errors retry with bounded backoff; auth/quota do not retry', async () => {
    const delays: number[] = [];
    const r = router({ tavily: 503, gemini }, { sleep: async ms => { delays.push(ms); } });
    assert.equal((await r.service.search('one')).provider, 'gemini'); assert.deepEqual(delays, [500]); assert.deepEqual(r.calls, ['tavily', 'tavily', 'gemini']);
  });
  await test('Timeouts are classified and trigger fallback', async () => {
    const error = new Error('timeout'); error.name = 'TimeoutError';
    const r = router({ tavily: error, gemini }); const o = await r.service.search('one'); assert.equal(o.attempts[0].status, 'timeout'); assert.equal(o.provider, 'gemini');
  });
  await test('Identical concurrent searches share a single request', async () => {
    const r = router({ tavily }); await Promise.all([r.service.search('same'), r.service.search('same')]); assert.equal(r.calls.length, 1);
  });
  await test('Quota circuit recovers after its cooldown', async () => {
    let time = now; const r = router({ tavily: 432 }, { time: () => time });
    await r.service.search('one'); await r.service.search('two'); assert.equal(r.calls.length, 1);
    time += 86400001; await r.service.search('three'); assert.equal(r.calls.length, 2);
  });
  await test('Rate-limit Retry-After is respected without repeated HTTP calls', async () => {
    const r = router({ tavily: response({}, 429, { 'Retry-After': '600' }), gemini });
    const original = r.requests;
    const outcome = await r.service.search('one');
    assert.equal(outcome.attempts[0].status, 'rate_limited');
    assert.equal(outcome.attempts[0].retryAt, new Date(now + 600000).toISOString());
    await r.service.search('two');
    assert.equal(original.filter(x => x.provider === 'tavily').length, 1);
  });
  await test('Tavily monthly credit and daily request caps are enforced', async () => {
    const r = router({ tavily }, { config: { tavily: { maxCreditsPerMonth: 1 } } });
    assert.equal((await r.service.search('one')).provider, 'tavily');
    assert.equal((await r.service.search('two')).status, 'unavailable'); assert.equal(r.calls.length, 1);
    const disabled = router({ tavily }, { config: { tavily: { maxRequestsPerDay: 0 } } });
    assert.equal((await disabled.service.search('one')).status, 'unavailable'); assert.equal(disabled.calls.length, 0);
  });
  await test('Fallback wire formats use supported tools with bounded output', async () => {
    const r = router({ tavily: 432, gemini: 401, groq: 403, openrouter }); await r.service.search('one');
    const geminiBody = JSON.parse(String(r.requests.find(x => x.provider === 'gemini')!.init.body));
    assert.deepEqual(geminiBody.tools, [{ google_search: {} }]);
    const groqBody = JSON.parse(String(r.requests.find(x => x.provider === 'groq')!.init.body));
    assert.deepEqual(groqBody.tools, [{ type: 'browser_search' }]); assert.equal(groqBody.tool_choice, 'required'); assert.equal(groqBody.response_format, undefined);
    const orBody = JSON.parse(String(r.requests.find(x => x.provider === 'openrouter')!.init.body));
    assert.equal(orBody.plugins[0].engine, 'exa'); assert.equal(orBody.max_tokens, 2048);
  });
  await test('Configuration rejects credential-like fields and invalid spend limits', () => {
    assert.equal(discoveryConfigSchema.safeParse({ apiKey: 'secret' }).success, false);
    assert.equal(discoveryConfigSchema.safeParse({ maxRequestsPerDay: -1 }).success, false);
    assert.equal(discoveryConfigSchema.safeParse({ dailyBudgetUsd: NaN }).success, false);
  });
  await test('Candidate fields, source references, publication dates and numerical claims are checked', async () => {
    assert.ok(validateDiscoveryProposal(makeProposal(), [evidence], 'tavily_search', now));
    assert.equal(validateDiscoveryProposal({ ...makeProposal(), controlsAccess: 'An invented platform' }, [evidence], 'tavily_search', now), null);
    assert.equal(validateDiscoveryProposal(makeProposal(), [{ ...evidence, publishedAt: undefined }], 'tavily_search', now), null);
    assert.equal(validateDiscoveryProposal(makeProposal(), [{ ...evidence, publishedAt: '2019-01-01' }], 'tavily_search', now), null);
    assert.equal(validateDiscoveryProposal({ ...makeProposal(), statisticalClaims: [{ evidenceId: 'context', value: 999 }] }, [evidence], 'tavily_search', now), null);
    const batch = await extractQualifiedGaps([evidence], 'tavily_search', async () => ({ gaps: [makeProposal(), { ...makeProposal(), needs: 'fabrication' }] }), now);
    assert.equal(batch.gaps.length, 1); assert.equal(batch.rejected, 1);
  });

  const original = global.fetch;
  let mode = 'valid', inferenceCalls = 0;
  const d = new Date(now); const periods = [1, 2].map(i => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  global.fetch = (async input => {
    const u = new URL(String(input));
    if (u.pathname === '/v1/search') return mode === 'api_failure' ? response({}, 401) : response({ items: [] });
    if (u.pathname === '/v1/datasets' && mode === 'malformed') return response({ items: 'invalid' });
    if (u.pathname === '/v1/datasets' && mode === 'api_failure') return response({}, 401);
    if (u.pathname === '/v1/search' && mode === 'api_failure') return response({}, 401);
    if (u.pathname === '/v1/datasets') return response({ items: [{ id: 'retail', title: 'Business inventory costs' }] });
    if (u.pathname === '/v1/datasets/retail') return response({ id: 'retail', state: 'published', title: 'Retail business data', description: context, last_updated: iso, links: { latest_version: { href: 'https://api.beta.ons.gov.uk/v1/datasets/retail/editions/time-series/versions/1' } } });
    if (u.pathname.endsWith('/versions/1')) return response({ dimensions: [{ name: 'time' }, { name: 'geography' }, { name: 'industry' }], release_date: iso });
    if (u.pathname.endsWith('/time/options')) return response({ items: periods.map(label => ({ label, option: label })), total_count: 2 });
    if (u.pathname.endsWith('/geography/options')) return response({ items: [{ option: 'K02000001', label: 'United Kingdom' }] });
    if (u.pathname.endsWith('/industry/options')) return response({ items: [{ option: 'retail', label: 'Retail' }] });
    if (u.pathname.endsWith('/observations')) {
      const time = u.searchParams.get('time')!;
      const value = time === periods[0] ? 120 : 100;
      return response({ unit_of_measure: mode === 'incompatible' && time === periods[0] ? 'percent' : 'GBP',
        dimensions: Object.fromEntries([...u.searchParams.entries()].map(([name, id]) => [name, { option: { id } }])),
        observations: mode === 'metadata' ? [] : [{ observation: mode === 'missing' ? '..' : String(value) }] });
    }
    return response({}, 404);
  }) as typeof fetch;
  const dependencies = () => ({ adapter: new OnsAdapter(), mutate: memoryRuntime(), resolve: async () => ({ enabled: true, key: null, config: {}, revision: '1' }), now: () => now,
    extract: async (e: DiscoveryEvidence[], source: string) => {
      inferenceCalls++;
      const p = makeProposal('retail:context');
      const raw = { ...p, statisticalClaims: e.filter(x => x.observation).map(x => ({ evidenceId: x.id, value: x.observation!.value })) };
      return extractQualifiedGaps(e, source, async () => ({ gaps: [raw] }), now);
    } });
  let onsGap: any;
  try {
    await test('ONS discovery uses compatible numerical observations and preserves full provenance', async () => {
      clearDiscoveryEvidenceCache(); const result = await discoverOns(dependencies());
      assert.equal(result.status, 'ok'); assert.equal(result.signals, 1); assert.equal(result.gaps.length, 1);
      onsGap = result.gaps[0];
      const records = onsGap.evidence.filter((e: DiscoveryEvidence) => e.observation);
      assert.equal(records.length, 2); assert.equal(records[0].observation.datasetId, 'retail'); assert.equal(records[0].observation.unit, 'GBP'); assert.equal(records[0].observation.geography, 'K02000001');
      assert.ok(records[0].url.includes('/observations?')); assert.ok(records[0].retrievedAt);
    });
    await test('Unchanged ONS observations reuse interpretation instead of repeatedly calling inference', async () => {
      clearDiscoveryEvidenceCache(); const deps = dependencies(); const before = inferenceCalls; await discoverOns(deps); await discoverOns(deps); assert.equal(inferenceCalls - before, 1);
    });
    for (const value of ['metadata', 'missing', 'incompatible']) await test(`ONS rejects ${value} statistics without interpretation`, async () => {
      mode = value; clearDiscoveryEvidenceCache(); const before = inferenceCalls; const result = await discoverOns(dependencies());
      assert.equal(result.gaps.length, 0); assert.equal(result.status, 'insufficient_evidence'); assert.equal(inferenceCalls, before);
    });
    for (const value of ['malformed', 'api_failure']) await test(`ONS ${value} fails truthfully without inference`, async () => {
      mode = value; clearDiscoveryEvidenceCache(); const before = inferenceCalls;
      const result = await discoverOns(dependencies()); assert.equal(result.status, 'unavailable'); assert.equal(result.gaps.length, 0); assert.equal(inferenceCalls, before);
    });
    await test('ONS valid statistics remain visible when required LLM interpretation fails', async () => {
      mode = 'valid'; clearDiscoveryEvidenceCache();
      const result = await discoverOns({ ...dependencies(), extract: async () => { throw new Error('Controlled inference unavailable'); } });
      assert.equal(result.signals, 1); assert.equal(result.gaps.length, 0); assert.equal(result.status, 'partial'); assert.ok(result.errors.length);
    });
    await test('Old statistics and incompatible dimensions cannot generate signals', () => {
      const [a, b] = onsGap.evidence.filter((e: DiscoveryEvidence) => e.observation).map((e: DiscoveryEvidence) => e.observation);
      assert.equal(compatibleSignal({ ...a, periodEnd: '2015-01-01' }, b, now), false);
      assert.equal(compatibleSignal(a, { ...b, geography: 'other' }, now), false);
      assert.equal(compatibleSignal(a, { ...b, unit: 'percent' }, now), false);
    });
    await test('ONS cannot turn an unsupported AI numerical claim or macro demand into a gap', () => {
      const raw = { ...onsGap.validation, statisticalClaims: [{ evidenceId: onsGap.evidence[0].id, value: 999999 }] };
      assert.equal(validateDiscoveryProposal(raw, onsGap.evidence, onsGap.source, now), null);
      assert.equal(validateDiscoveryProposal(makeProposal(), [evidence], 'ons_statistics', now), null);
    });
  } finally { global.fetch = original; clearDiscoveryEvidenceCache(); }

  await test('Cross-source exact duplicates combine evidence; different problems stay separate', () => {
    const web = validateDiscoveryProposal(makeProposal(), [evidence], 'tavily_search', now)!;
    const combined = deduplicateCandidates([onsGap, web]); assert.equal(combined.length, 1); assert.ok(combined[0].evidence.some(e => e.provider === 'tavily'));
    assert.equal(deduplicateCandidates([web, { ...web, needs: 'A different problem' }]).length, 2);
  });
  const lease = async () => async () => {};
  const emptyOns = { status: 'unavailable' as const, signals: 0, gaps: [], candidates: 0, rejected: 0, errors: ['offline'] };
  await test('Web failure does not stop ONS discovery or queue submission', async () => {
    let queued = 0;
    const result = await runDiscoveryCycle(async gaps => queued = gaps.length, { acquireLease: lease, ons: async () => ({ ...emptyOns, status: 'ok', gaps: [onsGap], candidates: 1, signals: 1, errors: [] }),
      ecommerce: async m => { m!.failures++; return []; }, operational: async () => { throw new Error('web offline'); }, persist: async () => {} });
    assert.equal(result.status, 'partial'); assert.equal(queued, 1); assert.equal(result.web.status, 'unavailable');
  });
  await test('ONS failure does not stop web discovery; all failed sources report unavailable', async () => {
    const web = validateDiscoveryProposal(makeProposal(), [evidence], 'tavily_search', now)!;
    const deps = { acquireLease: lease, ons: async () => emptyOns, ecommerce: async (m: any) => { m.successes++; m.candidates++; return [web]; }, operational: async () => [], persist: async () => {} };
    assert.equal((await runDiscoveryCycle(async g => g.length, deps)).status, 'partial');
    assert.equal((await runDiscoveryCycle(async g => g.length, { ...deps, ecommerce: async () => { throw new Error('offline'); } })).status, 'unavailable');
  });
  await test('A genuine zero-result cycle persists start and completion separately', async () => {
    const saved: any[] = [];
    const result = await runDiscoveryCycle(async () => 0, { acquireLease: lease,
      ons: async () => ({ ...emptyOns, status: 'insufficient_evidence', errors: [] }), ecommerce: async m => { m!.successes++; return []; }, operational: async () => [], persist: async r => { saved.push(structuredClone(r)); } });
    assert.equal(saved[0].status, 'running'); assert.ok(saved[0].startedAt); assert.equal(result.outcome, 'completed_with_zero_results'); assert.equal(result.status, 'ok'); assert.ok(result.completedAt);
  });
  await test('Stop after sources finish prevents persistence and records stopped outcome', async () => {
    let writes = 0;
    const result = await runDiscoveryCycle(async () => { writes++; return 1; }, { acquireLease: lease,
      ons: async () => ({ ...emptyOns, status: 'ok', gaps: [onsGap], candidates: 1, signals: 1, errors: [] }), ecommerce: async () => [], operational: async () => [], persist: async () => {} }, async () => false);
    assert.equal(result.status, 'stopped'); assert.equal(writes, 0); assert.equal(result.queued, 0);
  });
  await test('A new process cycle reloads durable success/failure history before publishing its start', async () => {
    const previous = { lastSuccess: '2026-01-01T00:00:00.000Z', lastFailure: '2026-01-02T00:00:00.000Z' };
    const saved: any[] = [];
    await runDiscoveryCycle(async () => 0, { acquireLease: lease, load: async () => previous as any,
      ons: async () => ({ ...emptyOns, status: 'ok', errors: [] }), ecommerce: async () => [], operational: async () => [], persist: async r => { saved.push(structuredClone(r)); } }, async () => false);
    assert.equal(saved[0].lastSuccess, previous.lastSuccess); assert.equal(saved[0].lastFailure, previous.lastFailure);
    assert.equal(saved[1].lastSuccess, previous.lastSuccess);
  });
  await test('Queue failure retains partial persistence counts and error diagnostics', async () => {
    const result = await runDiscoveryCycle(async () => { throw Object.assign(new Error('Controlled storage failure'), { queued: 0, persisted: 1 }); }, { acquireLease: lease,
      ons: async () => ({ ...emptyOns, status: 'ok', gaps: [onsGap], candidates: 1, signals: 1, errors: [] }), ecommerce: async m => { m!.successes++; return []; }, operational: async () => [], persist: async () => {} });
    assert.equal(result.status, 'partial'); assert.equal(result.persisted, 1); assert.ok(result.errors!.some(e => e.includes('persistence')));
  });
  await test('Distributed leases prevent simultaneous jobs and safely release', async () => {
    const mutate = memoryRuntime(); const first = await acquireDiscoveryLease(mutate); assert.ok(first); assert.equal(await acquireDiscoveryLease(mutate), null); await first!(); assert.ok(await acquireDiscoveryLease(mutate));
  });
  console.log(`\n${passed} discovery tests passed; all external responses mocked.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
