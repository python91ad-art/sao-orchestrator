/** Isolated real DB tests. No production connections or paid provider traffic. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { eq, sql } from 'drizzle-orm';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sao-assignments-db-'));
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
  await conn.query('CREATE DATABASE sao_assignments'); await conn.end();
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: '', DB_HOST: 'localhost', DB_PORT: '0', DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'sao_assignments', DB_SOCKET: socket });
  run('node', ['run-migration.js']);
  run('node', ['run-migration.js']);
  global.fetch = (async () => { throw new Error('External calls prohibited in isolated discovery persistence tests'); }) as typeof fetch;
  database = await import('../server/db');
  const schema = await import('../drizzle/schema');
  const registry = await import('../server/services/providerRegistry');
  const assignments = await import('../server/services/providerAssignments');
  const { decryptCredential } = await import('../server/services/credentialCrypto');
  const { route, setProvidersForTest, resetRouterState } = await import('../server/services/llmRouter');
  const { WebSearchRouter } = await import('../server/services/webSearch');
  const { mutateDiscoveryRuntime } = await import('../server/services/discoveryRuntime');
  // Remove inherited external provider environment configuration in this disposable process only.
  for (const name of ['GROQ_API_KEY', 'GEMINI_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY', 'TAVILY_API_KEY', 'VERCEL_API_TOKEN', 'NOWPAYMENTS_API_KEY']) delete process.env[name];
  const p = (await registry.saveProvider({ providerId: 'groq', service: 'llm', name: 'Groq fixture', credential: 'synthetic-groq-secret' }))!;
  const [original] = await database.db.select().from(schema.integrationCredentials).where(eq(schema.integrationCredentials.id, p.id));
  await database.db.execute(sql`ALTER TABLE integration_credentials DROP COLUMN assignment_version`);
  run('node', ['run-migration.js']);
  const [migrated] = await database.db.select().from(schema.integrationCredentials).where(eq(schema.integrationCredentials.id, p.id));
  assert.equal(migrated.encryptedValue, original.encryptedValue);
  for (const field of ['name', 'providerId', 'config', 'enabled', 'priority'] as const) assert.equal(migrated[field], original[field]);
  const view = await assignments.assignmentView(p.id);
  assert.deepEqual(view.assignments.map(a => a.section), ['llm']);
  const llm = { ...view.assignments[0], priority: 42, settings: { maxRequestsPerDay: 10 } };
  const search = { section: 'search', operation: 'live_web_search', model: 'openai/gpt-oss-20b', priority: 30, fallbackOrder: 2, enabled: true, settings: {} };
  await assignments.saveAssignments(p.id, [llm, search], 'admin-fixture', view.revision);
  assert.equal((await assignments.assignmentView(p.id)).assignments.length, 2);
  const concurrentView = await assignments.assignmentView(p.id);
  const writers = await Promise.allSettled([assignments.saveAssignments(p.id, [llm, search], 'admin-a', concurrentView.revision), assignments.saveAssignments(p.id, [llm, search], 'admin-b', concurrentView.revision)]);
  assert.equal(writers.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(writers.filter(r => r.status === 'rejected').length, 1);
  const [after] = await database.db.select().from(schema.integrationCredentials).where(eq(schema.integrationCredentials.id, p.id));
  assert.equal(after.encryptedValue, original.encryptedValue);
  assert.equal(decryptCredential(after.encryptedValue), 'synthetic-groq-secret');
  assert.ok(!JSON.stringify(await assignments.assignmentView(p.id)).includes('synthetic-groq-secret'));
  await assert.rejects(assignments.saveAssignments(p.id, [llm], 'admin-fixture', 'legacy'), /another session/);
  await assert.rejects(assignments.saveAssignments(p.id, [llm, llm], 'admin-fixture'), /only one/);
  await assert.rejects(assignments.saveAssignments(p.id, [{ ...search, model: 'ordinary-llm' }], 'admin-fixture'), /not verified/);
  await assert.rejects(assignments.saveAssignments(p.id, [{ ...llm, section: 'invalid' }], 'admin-fixture'));
  console.log('PASS idempotent startup migrations, legacy routes, multi-assignment, optimistic conflict, validation and unchanged encrypted credential bytes');

  const { appRouter } = await import('../server/routers');
  const admin = await database.createUser('assignment-admin@sao.test', 'fixture-hash', 'admin');
  const user = await database.createUser('assignment-user@sao.test', 'fixture-hash', 'user');
  const caller = (u: any) => appRouter.createCaller({ user: u, req: {} as any, res: {} as any });
  await assert.rejects(caller(null).providers.saveAssignments({ connectionId: p.id, assignments: [] }), /logged in/);
  await assert.rejects(caller(user).providers.saveAssignments({ connectionId: p.id, assignments: [] }), /admin/);
  await caller(admin).providers.saveAssignments({ connectionId: p.id, assignments: [llm, search] as any });
  const audit = await database.db.select().from(schema.operationalEvents).where(eq(schema.operationalEvents.type, 'provider_assignments_updated'));
  assert.ok(audit.some(e => e.actorId === admin!.id && JSON.parse(e.detailJson).after[0].priority === 42));
  console.log('PASS actual tRPC authorization and atomic detailed audit with actor, before and after');

  let llmCalls = 0;
  setProvidersForTest([{ id: 'groq', complete: async model => { llmCalls++; const key = await registry.resolveCredential('groq', ['GROQ_API_KEY']); assert.equal(key.value, 'synthetic-groq-secret'); return { text: 'synthetic completion', usage: {}, model }; } }]);
  const request = { task: 'ANALYSIS' as const, prompt: 'synthetic', jsonMode: false, maxTokens: 10, temperature: 0 };
  assert.equal((await route(request)).provider, 'groq');
  let webCalls = 0;
  const web = new WebSearchRouter({ routes: () => assignments.resolveSectionRoutes('search', 'live_web_search'), resolve: registry.resolveDiscoveryProvider, mutate: mutateDiscoveryRuntime, now: Date.now, sleep: async () => {}, fetch: (async () => { webCalls++; return new Response('{}'); }) as typeof fetch });
  assert.equal((await web.search('billing blocked fixture')).attempts[0].status, 'billing_blocked');
  assert.equal(webCalls, 0);
  assert.equal((await registry.getProviderRecord(p.id))!.config, null);
  await assignments.saveAssignments(p.id, [llm], admin!.id);
  assert.equal((await assignments.resolveSectionRoutes('search', 'live_web_search')).length, 0);
  assert.equal((await assignments.resolveSectionRoutes('llm')).length, 1);
  assert.equal((await route(request)).provider, 'groq');
  await assignments.saveAssignments(p.id, [{ ...llm, enabled: false }], admin!.id);
  await assert.rejects(route(request), /exhausted/i);
  await assignments.saveAssignments(p.id, [], admin!.id);
  run('node', ['run-migration.js']);
  assert.equal((await assignments.assignmentView(p.id)).assignments.length, 0);
  await assert.rejects(route(request), /exhausted/i);
  console.log('PASS existing LLM routing, section removal, disabled assignments, durable empty configuration and blocked unauthorized web billing (no fetch)');

  const second = (await registry.saveProvider({ providerId: 'groq', service: 'llm', name: 'Second connection', credential: 'second-synthetic-secret' }))!;
  await assignments.saveAssignments(second.id, [{ ...llm, priority: 1 }], admin!.id);
  await assignments.saveAssignments(p.id, [{ ...llm, priority: 100, settings: { maxRequestsPerDay: 0 } }], admin!.id);
  setProvidersForTest([{ id: 'groq', complete: async model => { const key = await registry.resolveCredential('groq', []); assert.equal(key.value, 'second-synthetic-secret'); return { text: 'second fixture', usage: {}, model }; } }]);
  assert.equal((await route(request)).text, 'second fixture');
  await registry.toggleProviderEnabled(second.id, false);
  process.env.GROQ_API_KEY = 'env-must-not-bypass';
  resetRouterState(); await assert.rejects(route(request), /exhausted/i);
  assert.equal((await assignments.resolveSectionRoutes('llm')).length, 1);
  console.log('PASS request-cap fallback uses exact second connection credential; disabled connection cannot return via environment');

  process.env.GEMINI_API_KEY = 'synthetic-env-secret';
  const env = (await assignments.listConnections()).find(c => c.id === 'env:gemini')!;
  assert.ok(env);
  const envView = await assignments.assignmentView(env.id);
  await assignments.saveAssignments(env.id, envView.assignments, admin!.id, envView.revision);
  const [envRow] = await database.db.select().from(schema.integrationCredentials).where(eq(schema.integrationCredentials.id, env.id));
  assert.equal(decryptCredential(envRow.encryptedValue), '');
  assert.equal(await assignments.routeCredential((await assignments.resolveSectionRoutes('llm')).find(r => r.providerId === 'gemini')!), 'synthetic-env-secret');
  assert.equal((await registry.listProviders()).filter(r => r.id === env.id).length, 1);
  console.log('PASS environment connection becomes assignable without copying credentials or duplicate connection views');
  // Billing is configured explicitly in this test fixture, separately from assignments.
  await registry.updateProvider(p.id, { config: { discovery: { enabled: true, billingApproved: true, accountSpendLimitConfirmed: true, dailyBudgetUsd: 1, maxRequestCostUsd: 0.1, maxRequestsPerDay: 10 } } });
  await assignments.saveAssignments(p.id, [llm, { ...search, priority: 200 }], admin!.id);
  const tavily = (await registry.saveProvider({ providerId: 'tavily', service: 'search', name: 'Search fallback fixture', credential: 'synthetic-search-secret' }))!;
  await assignments.saveAssignments(tavily.id, [{ ...search, model: null, priority: 1 }], admin!.id);
  const webCallsByProvider: string[] = [];
  const ordered = new WebSearchRouter({ routes: () => assignments.resolveSectionRoutes('search', 'live_web_search'), resolve: registry.resolveDiscoveryProvider, mutate: mutateDiscoveryRuntime, now: Date.now, sleep: async () => {}, fetch: (async (input, init) => {
    if (String(input).includes('groq')) { webCallsByProvider.push('groq'); assert.equal(JSON.parse(String(init!.body)).model, 'openai/gpt-oss-20b'); return new Response('{}', { status: 429 }); }
    webCallsByProvider.push('tavily'); return new Response(JSON.stringify({ results: [{ title: 'Synthetic fixture', url: 'https://fixture.example.org/source', content: 'Synthetic source evidence' }] }));
  }) as typeof fetch });
  assert.equal((await ordered.search('first mocked search')).provider, 'tavily');
  assert.deepEqual(webCallsByProvider, ['groq', 'tavily']);
  assert.equal((await ordered.search('second mocked search')).provider, 'tavily');
  assert.deepEqual(webCallsByProvider, ['groq', 'tavily', 'tavily']);
  assert.equal((await assignments.assignmentView(p.id)).health.search.reason, 'rate_limited');
  await assignments.saveAssignments(tavily.id, [], admin!.id);
  assert.equal((await ordered.search('removed fallback')).status, 'unavailable');
  assert.deepEqual(webCallsByProvider, ['groq', 'tavily', 'tavily']);
  assert.equal((await assignments.assignmentView(p.id)).assignments.find(a => a.section === 'llm')!.enabled, true);
  assert.equal((await registry.testProvider(tavily.id)).status, 'untested');
  await assignments.saveAssignments(tavily.id, [{ ...search, model: null, priority: 1 }], admin!.id);
  await registry.updateProvider(tavily.id, { config: { discovery: { maxCreditsPerMonth: 1000, billingApproved: false } } });
  const guardedTest = await registry.testProvider(tavily.id);
  assert.equal(guardedTest.status, 'untested'); assert.match(guardedTest.message, /Paid discovery requires/);
  assert.deepEqual(webCallsByProvider, ['groq', 'tavily', 'tavily']);
  console.log('PASS real search assignment ordering, evidence fallback, circuits, removal and connection tests preserve billing gates');
  const capped = (await registry.saveProvider({ providerId: 'groq', service: 'llm', name: 'Concurrent limit fixture', credential: 'synthetic-cap-key' }))!;
  const cappedAssignment = { ...llm, settings: { maxRequestsPerDay: 3 } };
  await assignments.saveAssignments(capped.id, [cappedAssignment], admin!.id);
  const cappedRoute = (await assignments.resolveSectionRoutes('llm')).find(r => r.connectionId === capped.id)!;
  const reservations = await Promise.all(Array.from({ length: 12 }, () => assignments.reserveAssignment(cappedRoute)));
  assert.equal(reservations.filter(r => r === null).length, 3);
  await assignments.saveAssignments(capped.id, [{ ...cappedAssignment, priority: 123 }], admin!.id);
  assert.equal(await assignments.reserveAssignment((await assignments.resolveSectionRoutes('llm')).find(r => r.connectionId === capped.id)!), 'daily_request_limit');
  console.log('PASS real concurrent reservations enforce shared caps; editing assignments does not reset usage');
  const va = (await registry.saveProvider({ providerId: 'vercel', service: 'deployment', name: 'Deployment primary fixture', credential: 'bad-deploy-key', priority: 'primary' }))!;
  const vb = (await registry.saveProvider({ providerId: 'vercel', service: 'deployment', name: 'Deployment fallback fixture', credential: 'good-deploy-key', priority: 'fallback' }))!;
  const nativeCalls: string[] = [];
  const dispatch = async (key: string) => { nativeCalls.push(key); return new Response('{}', { status: key === 'bad-deploy-key' ? 401 : 200 }); };
  assert.equal((await assignments.executeFunctionRequest('vercel', 'deployment', dispatch)).status, 200);
  assert.deepEqual(nativeCalls, ['bad-deploy-key', 'good-deploy-key']);
  await assignments.executeFunctionRequest('vercel', 'deployment', dispatch);
  assert.deepEqual(nativeCalls, ['bad-deploy-key', 'good-deploy-key', 'good-deploy-key']);
  assert.equal((await assignments.assignmentView(va.id)).health.deployment.reason, 'auth_failure');
  assert.equal((await assignments.assignmentView(vb.id)).health.deployment.status, 'healthy');
  await assignments.saveAssignments(vb.id, [], admin!.id);
  await assert.rejects(assignments.executeFunctionRequest('vercel', 'deployment', dispatch), /No eligible deployment/);
  const payment = (await registry.saveProvider({ providerId: 'nowpayments', service: 'payments', name: 'Payment fixture', credential: 'synthetic-payment-secret' }))!;
  const { createNowPaymentsPayment } = await import('../server/services/nowpayments');
  global.fetch = (async (_input, init) => { assert.equal(new Headers(init!.headers).get('x-api-key'), 'synthetic-payment-secret'); return new Response('synthetic-payment-secret', { status: 500 }); }) as typeof fetch;
  await assert.rejects(createNowPaymentsPayment({ apiKey: 'unused-stale-key', ipnSecret: 'fixture', apiUrl: 'https://fixture.example.org' }, { priceAmount: '1', priceCurrency: 'gbp', orderId: 'test-only' }), e => !String(e).includes('synthetic-payment-secret') && /HTTP 500/.test(String(e)));
  assert.equal((await assignments.assignmentView(payment.id)).health.payments.reason, 'http_500');
  console.log('PASS native function routing, explicit-rejection fallback, durable auth circuit, per-assignment health and safe provider errors');
  assert.ok(llmCalls >= 2); setProvidersForTest(null);
  console.log('All assignment integration scenarios passed on disposable MariaDB; external calls prohibited.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await database?.mysqlPool.end();
  if (server && server.exitCode === null) { const stopped = new Promise<void>(r => server!.once('exit', () => r())); server.kill('SIGTERM'); await stopped; }
  fs.rmSync(dir, { recursive: true, force: true });
});
