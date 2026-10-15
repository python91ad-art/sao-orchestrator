import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';

async function worker() {
  const { db, mysqlPool } = await import('../server/db');
  const schema = await import('../drizzle/schema');
  const engine = await import('../server/services/policyEngine');
  const { policyDefinitions } = await import('../shared/policyContracts');
  const { eq } = await import('drizzle-orm');
  try {
    await db.insert(schema.users).values({ id: 'policy-admin', email: 'policy-admin@sao.test', passwordHash: 'fixture', role: 'admin' });
    const admin = { id: 'policy-admin', role: 'admin' };
    await assert.rejects(engine.policyOverview(admin), /Explicit/);
    const { ADMIN_PERMISSIONS } = await import('../shared/permissions');
    for (const permission of ADMIN_PERMISSIONS) await db.insert(schema.adminPermissions).values({ userId: admin.id, permission });
    const permissionPreview = spawnSync('node', ['--import', 'tsx', 'scripts/grant-policy-permissions.ts', admin.id], { env: process.env, encoding: 'utf8' });
    assert.equal(permissionPreview.status, 0);
    const previewResult = JSON.parse(permissionPreview.stdout.split('\n').find(line => line.startsWith('{"mode"'))!);
    assert.equal(previewResult.mode, 'read_only_preview');
    assert.equal(previewResult.existingPermissions.length, ADMIN_PERMISSIONS.length);
    assert.equal(previewResult.permissions.length, 0);
    const ambiguous = spawnSync('node', ['--import', 'tsx', 'scripts/grant-policy-permissions.ts', admin.id, '--confirm', 'first', '--confirm', 'second'], { env: process.env, encoding: 'utf8' });
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /ambiguous requests are rejected/);
    assert.equal((await db.select().from(schema.operationalEvents).where(eq(schema.operationalEvents.type, 'administrator_permissions_granted'))).length, 0);
    assert.equal((await engine.policyOverview(admin)).length, 9);
    const legacyDatabase = await import('../server/db');
    const legacyGap = await legacyDatabase.createGap({ knows: 'legacy fixture', needs: 'legacy fixture', controlsAccess: 'legacy fixture', underestimatesValue: 'legacy fixture', source: 'isolated-test', dedupHash: 'unassigned-legacy-business' });
    const legacyBusiness = await legacyDatabase.createDeployment({ gapId: legacyGap!.id, userId: admin.id });
    const incomplete = await engine.savePolicyDraft(admin, { category: 'discovery', config: policyDefinitions.discovery.defaults, reason: 'Incomplete fixture' });
    assert.ok((await engine.validatePolicyDraft(admin, incomplete.id)).missing.length);
    await assert.rejects(engine.activatePolicy(admin, incomplete.id));
    const config = { ...policyDefinitions.agents.defaults, originalAgentRetries: 2, backupAgentRetries: 1, allowedTools: ['test'] };
    const draft = await engine.savePolicyDraft(admin, { category: 'agents', config, reason: 'Activate fixture' });
    assert.equal((await engine.validatePolicyDraft(admin, draft.id)).missing.length, 0);
    await engine.activatePolicy(admin, draft.id);
    assert.equal((await engine.activePolicy('agents'))?.id, draft.id);
    assert.equal(await engine.activePolicy('agents', legacyBusiness.id), null, 'Activating a global head must not silently assign a legacy business or alter its arrangements.');
    const database = await import('../server/db');
    const gap = await database.createGap({ knows: 'fixture', needs: 'fixture', controlsAccess: 'fixture', underestimatesValue: 'fixture', source: 'isolated-test', dedupHash: 'policy-snapshot-fixture' });
    const business = await database.createDeployment({ gapId: gap!.id, userId: admin.id });
    assert.equal((await engine.activePolicy('agents', business!.id))?.id, draft.id);
    const result = await engine.evaluatePolicy({ category: 'agents', action: 'tool_execution', actorId: 'fixture:agent', facts: { verifiedIdentity: true, workspaceMatch: true, tool: 'test', roleAllowsTool: true } });
    assert.equal(result.decision, 'ALLOW');
    assert.equal(result.versionId, draft.id);
    const evaluations = await engine.policyActivity(admin, 'agents');
    assert.equal(evaluations[0].versionId, draft.id);
    const restored = await engine.savePolicyDraft(admin, { category: 'agents', config: {}, restoreId: draft.id, reason: 'Restore fixture' });
    assert.notEqual(restored.id, draft.id);
    await engine.validatePolicyDraft(admin, restored.id);
    await engine.activatePolicy(admin, restored.id);
    assert.equal((await engine.activePolicy('agents', business!.id))?.id, draft.id);
    assert.equal((await db.select().from(schema.policyVersions).where(eq(schema.policyVersions.id, draft.id)))[0].status, 'superseded');
    assert.equal((await engine.policyHistory(admin, 'agents')).length, 2);
    await assert.rejects(engine.savePolicyDraft({ id: 'agent', role: 'agent' }, { category: 'agents', config, reason: 'Denied' }));
    await assert.rejects(engine.savePolicyDraft({ id: 'user', role: 'user' }, { category: 'agents', config, reason: 'Denied' }));
    const { appRouter } = await import('../server/routers');
    const userCaller = appRouter.createCaller({ user: { id: 'user', role: 'user' } as any, req: {} as any, res: {} as any });
    await assert.rejects(userCaller.policies.saveDraft({ category: 'agents', config, reason: 'Denied over API' }));
    const adminCaller = appRouter.createCaller({ user: { ...admin } as any, req: {} as any, res: {} as any });
    assert.equal((await adminCaller.policies.overview()).length, 9);
    await assert.rejects(adminCaller.coreLoop.resetOperationalData(), /Full operational reset is unavailable/);
    const preview = await adminCaller.policies.discoveryResetPreview();
    assert.equal(preview.status, 'PREVIEW_ONLY');
    const { assertOperationalWorkflows } = await import('./fixtures/operationalAssertions');
    await assertOperationalWorkflows(admin.id);
    const financeVersion = await engine.activePolicy('finance');
    assert.ok(financeVersion);
    await assert.rejects(engine.assignBusinessPolicy(admin, legacyBusiness.id, 'finance', financeVersion.id, 'Unconsented legacy financial assignment'), /owner authorization/);
    const execution = await import('../server/services/execution');
    const consent = await execution.requestApproval(admin, { deploymentId: legacyBusiness.id, action: 'policy_assignment', resourceId: financeVersion.id, authority: 'user', risk: 'high', expiresAt: new Date(Date.now() + 3600000), scope: { category: 'finance', versionId: financeVersion.id } });
    await execution.decideApproval(admin, consent, 'approved');
    await engine.assignBusinessPolicy(admin, legacyBusiness.id, 'finance', financeVersion.id, 'Authenticated owner approved this exact legacy policy assignment');
    assert.equal((await engine.activePolicy('finance', legacyBusiness.id))?.id, financeVersion.id);
    assert.equal(await execution.validApproval({ deploymentId: legacyBusiness.id, action: 'profit_share', resourceId: legacyBusiness.id, authority: 'user' }), null);
    console.log('PASS isolated MySQL migration, explicit permissions, nine categories, drafts, validation, activation, rollback, evaluation audit, API authorization and reset safety');
  } finally { await mysqlPool.end(); }
}
async function main() {
  if (process.argv.includes('--worker')) return worker();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sao-policy-db-'));
  const socketPath = path.join(directory, 'mysql.sock');
  const install = spawnSync('mariadb-install-db', [`--datadir=${directory}/data`, '--auth-root-authentication-method=normal', '--skip-test-db'], { encoding: 'utf8' });
  if (install.status !== 0) throw new Error(install.stderr);
  const server = spawn('mysqld', [`--datadir=${directory}/data`, `--socket=${socketPath}`, `--pid-file=${directory}/pid`, '--skip-networking', '--skip-grant-tables'], { stdio: 'ignore' });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { const connection = await mysql.createConnection({ socketPath, user: 'root' }); await connection.query('CREATE DATABASE sao_policy_test'); await connection.end(); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw new Error('Isolated MariaDB failed to start.');
    const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', DB_SOCKET: socketPath, DB_HOST: 'localhost', DB_USER: 'root', DB_PASSWORD: '', DB_NAME: 'sao_policy_test' };
    const migration = spawnSync('node', ['run-migration.js'], { env, encoding: 'utf8' });
    if (migration.status !== 0) throw new Error(migration.stdout + migration.stderr);
    const repeated = spawnSync('node', ['run-migration.js'], { env, encoding: 'utf8' });
    if (repeated.status !== 0) throw new Error(`Migration reapplication failed: ${repeated.stdout}${repeated.stderr}`);
    const result = spawnSync('node', ['--import', 'tsx', 'tests/policy-db-isolated.test.ts', '--worker'], { env, stdio: 'inherit' });
    assert.equal(result.status, 0);
  } finally {
    await new Promise<void>(resolve => { if (server.exitCode !== null) return resolve(); server.once('exit', () => resolve()); server.kill('SIGTERM'); });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
