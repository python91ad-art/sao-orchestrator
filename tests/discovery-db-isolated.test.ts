/** Isolated real DB tests. No production connections or paid provider traffic. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { eq, sql } from 'drizzle-orm';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sao-discovery-db-'));
const socket = path.join(dir, 'mysql.sock');
let server: ReturnType<typeof spawn> | undefined;
let database: typeof import('../server/db') | undefined;
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd} failed: ${r.stderr}`);
}
async function main() {
  run('mariadb-install-db', [`--datadir=${dir}/data`, '--auth-root-authentication-method=normal', '--skip-test-db']);
  server = spawn('mysqld', [`--datadir=${dir}/data`, `--socket=${socket}`, `--pid-file=${dir}/pid`, '--skip-networking', '--skip-grant-tables'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = ''; server.stderr?.on('data', x => { logs += String(x); });
  let conn: mysql.Connection | undefined;
  for (let i = 0; i < 60; i++) {
    try { conn = await mysql.createConnection({ socketPath: socket, user: 'root' }); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(conn, `Isolated MySQL failed: ${logs}`);
  await conn.query('CREATE DATABASE sao_discovery'); await conn.end();
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: '', DB_HOST: 'localhost', DB_PORT: '0', DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'sao_discovery', DB_SOCKET: socket });
  run('node', ['run-migration.js']);
  global.fetch = (async () => { throw new Error('External calls prohibited in isolated discovery persistence tests'); }) as typeof fetch;
  database = await import('../server/db');
  const schema = await import('../drizzle/schema');
  const { queueDiscoveryGaps } = await import('../server/services/discoveryQueue');
  const { validateDiscoveryProposal } = await import('../server/services/discoveryEvidence');
  const infra = await import('../server/services/infrastructure');
  const registry = await import('../server/services/providerRegistry');
  const { mutateDiscoveryRuntime } = await import('../server/services/discoveryRuntime');
  const { WebSearchRouter } = await import('../server/services/webSearch');
  const now = new Date().toISOString();
  const observedAt = new Date(Date.now() - 3600000).toISOString();
  const words = { knows: 'UK retailers know their available inventory', needs: 'UK retailers lose orders through reconciliation errors', controlsAccess: 'Retail platforms control access to transaction feeds', underestimatesValue: 'Manual reconciliation costs exceed automation costs' };
  const evidence = [{ id: 'context', provider: 'tavily', url: 'https://fixture.example.org/retail', title: 'Synthetic fixture, not real market evidence', text: Object.values(words).join('. '), retrievedAt: observedAt, publishedAt: now }];
  const ref = (quote: string) => ({ evidenceId: 'context', quote });
  const proposal = { ...words, support: Object.fromEntries(Object.entries(words).map(([key, value]) => [key, ref(value)])), problem: ref(words.needs), audience: ref('UK retailers'), market: ref('UK retailers'), hypothesis: 'Test a reconciliation product; customer demand is unverified.', strength: 'moderate', statisticalClaims: [] };
  const gap = validateDiscoveryProposal(proposal, evidence, 'tavily_search:ecommerce')!;
  assert.ok(gap);
  assert.equal(await queueDiscoveryGaps([gap]), 1);
  const [stored] = await database.db.select().from(schema.gaps);
  const [item] = await database.db.select().from(schema.queueItems);
  const [record] = await infra.listEvidence({ gapId: stored.id });
  assert.equal(item.gapId, stored.id); assert.equal(item.queueType, 'synthesis');
  assert.ok(['pending', 'paused'].includes(item.status));
  assert.equal(record.provider, 'tavily'); assert.equal(record.sourceUrl, evidence[0].url);
  assert.equal(record.retrievedAt.getTime(), Math.floor(Date.parse(observedAt) / 1000) * 1000);
  assert.equal(record.status, 'collected'); assert.equal(JSON.parse(record.metadataJson!).validation.hypothesis, proposal.hypothesis);
  assert.ok((await infra.formatStoredDiscoveryEvidence(stored.id)).includes(proposal.hypothesis));
  console.log('PASS real queue/evidence persistence, retrieval timestamp and downstream provenance');
  const second = { ...gap, source: 'gemini_search:operational', evidence: [{ ...evidence[0], provider: 'gemini', url: 'https://fixture.example.org/second-source' }] };
  assert.equal(await queueDiscoveryGaps([second]), 0);
  assert.equal((await database.db.select().from(schema.gaps)).length, 1);
  assert.equal((await database.db.select().from(schema.queueItems)).length, 1);
  assert.equal((await infra.listEvidence({ gapId: stored.id })).length, 2);
  console.log('PASS duplicate cross-source gap preserves sources without a second queue record');
  await database.db.update(schema.gaps).set({ status: 'deployed' }).where(eq(schema.gaps.id, stored.id));
  assert.equal(await queueDiscoveryGaps([gap]), 0);
  assert.equal((await database.getGapById(stored.id))!.status, 'deployed');
  console.log('PASS historical statuses preserved');
  const legacyWords = { ...words, needs: 'UK retailers have a different legacy problem' };
  const legacy = await database.createGap({ ...legacyWords, source: 'old-provider', dedupHash: infra.computeGapDedupHash({ ...legacyWords, source: 'old-provider' }), status: 'safe' });
  const legacyEvidence = [{ ...evidence[0], text: Object.values(legacyWords).join('. ') }];
  const legacyProposal = { ...proposal, ...legacyWords, problem: ref(legacyWords.needs), support: { ...proposal.support, needs: ref(legacyWords.needs) } };
  const legacyCandidate = validateDiscoveryProposal(legacyProposal, legacyEvidence, 'openrouter_search')!;
  assert.equal(await queueDiscoveryGaps([legacyCandidate]), 0);
  assert.equal((await database.db.select().from(schema.gaps)).length, 2);
  assert.equal((await database.getGapById(legacy!.id))!.status, 'safe');
  console.log('PASS existing source-specific hashes deduplicate without rewriting histories');
  const p = await registry.saveProvider({ providerId: 'gemini', service: 'llm', name: 'Gemini fixture', credential: 'fixture-secret', config: { discovery: { enabled: false } } });
  assert.ok(p); assert.ok(!JSON.stringify(p).includes('fixture-secret'));
  assert.equal((await registry.resolveDiscoveryProvider('gemini')).enabled, false);
  await registry.toggleProviderEnabled(p!.id, false);
  process.env.GEMINI_API_KEY = 'environment-secret';
  assert.equal((await registry.resolveDiscoveryProvider('gemini')).key, null);
  console.log('PASS secure credential resolution and disabled provider blocks environment fallback');
  await Promise.all(Array.from({ length: 12 }, () => mutateDiscoveryRuntime('counter-test', state => { state.count = (state.count || 0) + 1; })));
  assert.equal(await mutateDiscoveryRuntime('counter-test', state => state.count), 12);
  console.log('PASS durable concurrent counters use real row locks');
  let calls = 0;
  const deps = { resolve: async () => ({ enabled: true, key: 'fixture-key', config: {}, revision: '1' }), mutate: mutateDiscoveryRuntime,
    now: Date.now, sleep: async () => {}, fetch: (async () => { calls++; return new Response('{}', { status: 432 }); }) as typeof fetch };
  const r1 = new WebSearchRouter(deps); await r1.search('first');
  const r2 = new WebSearchRouter(deps); await r2.search('second');
  assert.equal(calls, 1);
  console.log('PASS quota circuit survives router recreation through real database');
  const [count] = await database.db.select({ n: sql<number>`COUNT(*)` }).from(schema.queueItems);
  assert.equal(Number(count.n), 1);
  // Real router and worker integration; synthetic evidence and provider boundaries only.
  const { appRouter } = await import('../server/routers');
  const { ADMIN_PERMISSIONS } = await import('../shared/permissions');
  const { setProvidersForTest, resetRouterState } = await import('../server/services/llmRouter');
  const orchestrator = await import('../server/orchestrator');
  const admin = await database.createUser('loop-admin@sao.test', 'test-hash', 'admin');
  const ordinary = await database.createUser('loop-user@sao.test', 'test-hash', 'user');
  for (const permission of ADMIN_PERMISSIONS) await database.db.insert(schema.adminPermissions).values({ userId: admin!.id, permission });
  const caller = appRouter.createCaller({ user: admin, req: {} as any, res: {} as any });
  const userCaller = appRouter.createCaller({ user: ordinary, req: {} as any, res: {} as any });
  const anonymous = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
  for (const control of ['start', 'stop', 'runOnce', 'processNext'] as const) {
    await assert.rejects(userCaller.coreLoop[control](), /admin/);
    await assert.rejects(anonymous.coreLoop[control](), /logged in/);
  }
  console.log('PASS all runtime controls require authenticated administrators and permission checks');
  process.env.GROQ_API_KEY = 'isolated-test-key'; process.env.GROQ_TPM_LIMIT = '999999';
  let inferenceFailed = false;
  await registry.saveProvider({ service: 'search', providerId: 'tavily', name: 'Synthetic search fixture', credential: 'fixture-key', config: { discovery: { enabled: true, maxRequestsPerDay: 200 } } });
  await registry.saveProvider({ service: 'business_data' as any, providerId: 'ons', name: 'ONS isolation disabled', credential: '', config: { discovery: { enabled: false } } });
  // Leave historical test work complete; only the newly discovered candidate should be processed.
  await database.updateQueueItem(item.id, { status: 'completed' });
  const loopWords = { ...words, needs: 'UK retailers lose orders through unreconciled inventory errors' };
  const loopEvidence = { ...evidence[0], text: Object.values(loopWords).join('. ') };
  const webRef = (quote: string) => ({ evidenceId: 'web:0', quote });
  const loopProposal = { ...proposal, ...loopWords, problem: webRef(loopWords.needs), audience: webRef('UK retailers'), market: webRef('UK retailers'), support: Object.fromEntries(Object.entries(loopWords).map(([key, value]) => [key, webRef(value)])) };
  setProvidersForTest([{ id: 'groq', complete: async (_model: string, request: any) => {
    if (inferenceFailed) throw new Error('Controlled worker failure');
    const system = request.messages.find((m: any) => m.role === 'system')?.content || '';
    return { text: JSON.stringify(system.includes('gap classifier') ? { classification: 'gray', banRisk: 'medium', reasoning: 'Synthetic evidence requires review.', explanation: 'Synthetic fixture.' } : { gaps: [loopProposal] }), usage: {} };
  } } as any]);
  let searches = 0;
  let holdSearch: Promise<void> | undefined;
  global.fetch = (async input => {
    if (String(input).includes('api.tavily.com')) {
      searches++; if (holdSearch) await holdSearch;
      return new Response(JSON.stringify({ results: [{ url: loopEvidence.url, title: loopEvidence.title, content: loopEvidence.text, published_date: now }] }));
    }
    // Public ONS context used by classification is mocked and contains no invented opportunity.
    return new Response(JSON.stringify({ items: [] }));
  }) as typeof fetch;
  const cycle = await caller.coreLoop.runOnce();
  assert.equal(cycle.discovery.status, 'partial'); // ONS deliberately disabled, web is independently usable.
  assert.equal(cycle.discovery.queued, 1); assert.equal(cycle.discovery.persisted, 1); assert.equal(cycle.processed, 1);
  assert.equal((await database.getCoreLoopState())!.isRunning, false);
  assert.equal(searches, 10);
  const loopGap = (await database.listGaps()).find(g => g.needs === loopWords.needs)!;
  assert.equal(loopGap.status, 'gray');
  const loopItem = (await database.listQueueItems()).find(x => x.queueItem.gapId === loopGap.id)!.queueItem;
  assert.equal(loopItem.status, 'paused'); assert.equal(loopItem.workerId, null);
  console.log('PASS Run Once → ten web searches → evidence validation → real gap/evidence/queue persistence → worker review without starting scheduler');
  const persistedReport = await caller.discovery.pipelineDiagnostic();
  const restarted = spawnSync('node', ['--import', 'tsx', '-e', `(async()=>{const dm=await import('./server/db.ts');const d=dm.default||dm;const rm=await import('./server/services/discovery.ts');const r=rm.default||rm;console.log('RESTORED_REPORT:'+JSON.stringify(await r.restoreDiscoveryReport()));await d.mysqlPool.end();})().catch(e=>{console.error(e.message);process.exitCode=1;})`], { env: process.env, encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  const restored = JSON.parse(restarted.stdout.match(/RESTORED_REPORT:(.*)/)![1]);
  assert.equal(restored.cycleId, persistedReport.multiSource.cycleId); assert.equal(restored.completedAt, persistedReport.multiSource.completedAt);
  console.log('PASS discovery completion diagnostics survive an actual separate process');
  await database.updateQueueItem(loopItem.id, { status: 'pending', attempts: 0 });
  const searchesBeforeStart = searches;
  await caller.coreLoop.start();
  for (let i = 0; i < 500; i++) {
    const state = await caller.coreLoop.status();
    const job = await database.getQueueItem(loopItem.id);
    if (searches > searchesBeforeStart && !state.executing && job?.status === 'paused' && state.nextExecutionAt && Date.parse(state.nextExecutionAt) > Date.now()) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(searches > searchesBeforeStart); assert.equal((await database.getQueueItem(loopItem.id))!.status, 'paused');
  assert.equal((await caller.coreLoop.status()).isRunning, true);
  assert.ok(Date.parse((await caller.coreLoop.status()).nextExecutionAt!) > Date.now());
  await caller.coreLoop.stop();
  console.log('PASS Start immediately discovers, processes eligible queue work and schedules the next configured cycle');
  await caller.settings.retryConfig({ maxAttempts: 1, backoffMultiplier: 2, baseDelayMs: 1000 });
  await caller.settings.setInterval({ intervalMs: 120000 });
  await caller.settings.setConcurrency({ level: 2 });
  assert.equal((await caller.coreLoop.status()).intervalMs, 120000);
  assert.equal((await caller.settings.getRetryConfig()).maxAttempts, 1);
  assert.equal((await caller.settings.getConcurrency()).concurrency, 2);
  await database.updateQueueItem(loopItem.id, { status: 'pending', attempts: 0 });
  inferenceFailed = true; resetRouterState();
  const one = await caller.coreLoop.processNext();
  assert.equal(one.processed, 1); assert.equal(one.outcomes[0].status, 'failed'); assert.ok(one.outcomes[0].error);
  assert.equal((await caller.coreLoop.processNext()).processed, 0);
  inferenceFailed = false; resetRouterState();
  console.log('PASS Process Next claims exactly one item; configured retry exhaustion and error are recorded and returned');
  let releaseSearch!: () => void;
  holdSearch = new Promise(resolve => { releaseSearch = resolve; });
  const before = searches;
  const activeCycle = caller.coreLoop.runOnce();
  for (let i = 0; i < 200 && searches === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(searches > before);
  assert.equal((await caller.coreLoop.status()).runtimeState, 'executing');
  await assert.rejects(caller.coreLoop.runOnce(), /already executing/);
  await caller.coreLoop.stop();
  assert.equal((await caller.coreLoop.status()).runtimeState, 'stopping');
  releaseSearch(); holdSearch = undefined;
  assert.equal((await activeCycle).discovery.status, 'stopped');
  assert.equal((await caller.coreLoop.status()).runtimeState, 'stopped');
  console.log('PASS actual router concurrent request rejection, Stop during discovery, Stopping state, drained stopped report');
  await Promise.all([caller.coreLoop.start(), caller.coreLoop.start()]);
  await caller.coreLoop.stop(); await caller.coreLoop.stop();
  assert.equal((await caller.coreLoop.status()).isRunning, false);
  const control = await database.getCoreLoopRuntimeState();
  await database.updateQueueItem(loopItem.id, { status: 'pending', attempts: 0 });
  assert.equal(await database.claimNextPendingQueueItem('stale-epoch', { epoch: control.epoch - 1, requireRunning: false }), null);
  const claims = await Promise.all([database.claimNextPendingQueueItem('claim-a'), database.claimNextPendingQueueItem('claim-b')]);
  assert.equal(claims.filter(Boolean).length, 1);
  const owned = claims.find(Boolean)!;
  await assert.rejects(database.withQueueOwnership(owned.id, 'wrong-owner', () => database!.updateQueueItem(owned.id, { status: 'completed' })), /ownership lost/);
  await database.db.execute(sql`UPDATE queue_items SET updated_at=NOW()-INTERVAL 60 MINUTE WHERE id=${owned.id}`);
  await database.recoverStaleProcessingQueueItems(30);
  assert.equal((await database.getQueueItem(owned.id))!.status, 'failed');
  await database.updateQueueItem(owned.id, { status: 'processing', attempts: 0 });
  await database.db.execute(sql`UPDATE queue_items SET updated_at=NOW()-INTERVAL 60 MINUTE WHERE id=${owned.id}`);
  await database.recoverStaleProcessingQueueItems(30);
  assert.equal((await database.getQueueItem(owned.id))!.status, 'pending');
  await database.updateQueueItem(owned.id, { attempts: 0 });
  await database.db.execute(sql`UPDATE queue_items SET updated_at=NOW()-INTERVAL 100 HOUR WHERE id=${owned.id}`);
  assert.equal(await orchestrator.cleanStaleQueueItems(), 1);
  assert.equal((await database.getQueueItem(owned.id))!.status, 'paused');
  assert.equal((await database.getGapById(loopGap.id))!.id, loopGap.id);
  console.log('PASS stale epochs cannot claim; concurrent claims are exclusive; stale owners cannot complete; interrupted jobs recover; expiration preserves records');
  await database.db.insert(schema.operationalSettings).values({ key: 'emergencyStop', valueJson: 'true', updatedBy: admin!.id });
  await assert.rejects(caller.coreLoop.start(), /Emergency stop/); await assert.rejects(caller.coreLoop.runOnce(), /Emergency stop/);
  await database.updateQueueItem(owned.id, { status: 'pending' });
  assert.equal(await database.claimNextPendingQueueItem('emergency-worker'), null);
  console.log('PASS emergency stop blocks Start, Run Once and synthesis claims');
  await database.db.update(schema.operationalSettings).set({ valueJson: 'false' }).where(eq(schema.operationalSettings.key, 'emergencyStop'));
  await caller.settings.saveOperationalLimits({ maxCostPerDay: 50, maxDeployments: 0, autoPauseOnHighBanRisk: true });
  assert.equal((await database.canCreateDeployment()).allowed, false);
  await assert.rejects(database.createDeployment({ gapId: loopGap.id, userId: admin!.id }, true), /Maximum deployments/);
  await caller.settings.saveOperationalLimits({ maxCostPerDay: 50, maxDeployments: 1, autoPauseOnHighBanRisk: true });
  const business = await database.createDeployment({ gapId: loopGap.id, userId: admin!.id }, true);
  assert.equal((await database.createDeployment({ gapId: loopGap.id, userId: admin!.id }, true)).id, business.id);
  await assert.rejects(database.createDeployment({ gapId: stored.id, userId: admin!.id }, true), /Maximum deployments/);
  console.log('PASS zero deployment limit is honored, business admission rechecks capacity under a transaction lock, and retry reuses the existing business');
  await orchestrator.shutdownCoreLoop();
  console.log('16 isolated discovery/runtime DB scenarios passed. All external responses mocked.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await database?.mysqlPool.end();
  if (server && server.exitCode === null) { const stopped = new Promise<void>(r => server!.once('exit', () => r())); server.kill('SIGTERM'); await stopped; }
  fs.rmSync(dir, { recursive: true, force: true });
});
