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
  console.log('7 isolated discovery DB scenarios passed. No external requests.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await database?.mysqlPool.end();
  if (server && server.exitCode === null) { const stopped = new Promise<void>(r => server!.once('exit', () => r())); server.kill('SIGTERM'); await stopped; }
  fs.rmSync(dir, { recursive: true, force: true });
});
