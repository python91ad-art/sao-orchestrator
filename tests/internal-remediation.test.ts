// ============================================================
// Internal remediation regression tests
// Static/pure checks for production-readiness fixes that must not
// depend on live DBs, providers, deployments, payments, or ad spend.
// ============================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const routers = read('server/routers.ts');
const index = read('server/_core/index.ts');
const db = read('server/db.ts');
const orchestrator = read('server/orchestrator.ts');
const revenue = read('server/services/revenue.ts');
const growth = read('server/services/advertising/growthEngine.ts');
const packageJson = JSON.parse(read('package.json'));

function section(source: string, marker: string, nextMarker: string) {
  const start = source.indexOf(marker);
  assert.notStrictEqual(start, -1, `${marker} should exist`);
  const end = source.indexOf(nextMarker, start + marker.length);
  assert.notStrictEqual(end, -1, `${nextMarker} should exist after ${marker}`);
  return source.slice(start, end);
}

console.log('\n=== Internal Remediation Regression Tests ===');

{
  const gapsRouter = section(routers, 'const gapsRouter = router({', '// ==========================================\n// QUEUE ROUTER');
  const queueRouter = section(routers, 'const queueRouter = router({', '// ==========================================\n// DEPLOYMENTS ROUTER');
  const auditRouter = section(routers, 'const auditRouter = router({', '// ==========================================\n// POLICIES ROUTER');

  assert.match(gapsRouter, /list:\s*adminProcedure/);
  assert.match(gapsRouter, /get:\s*adminProcedure/);
  assert.match(gapsRouter, /retry:\s*adminProcedure/);
  assert.match(queueRouter, /list:\s*adminProcedure/);
  assert.match(queueRouter, /stats:\s*adminProcedure/);
  assert.match(auditRouter, /list:\s*adminProcedure/);
  assert.match(auditRouter, /get:\s*adminProcedure/);
  assert.match(auditRouter, /getAuditLogById\(input\)/);
  console.log('✓ Global operational routers are admin-only');
}

{
  assert.match(db, /export async function assertDatabaseReady/);
  assert.match(index, /await withRetry\(\s*\(\) => assertDatabaseReady\(\)/);
  assert.doesNotMatch(db, /DIAGNOSTIC: Test connection at startup[\s\S]*?\(async \(\) =>/);
  console.log('✓ Startup awaits explicit database readiness');
}

{
  assert.match(orchestrator, /runCoreLoopTick\(\)\.catch/);
  assert.match(orchestrator, /Tick already running/);
  assert.match(orchestrator, /Recovering from tick crash/);
  assert.doesNotMatch(orchestrator, /scheduleCoreLoopTick\(state\.intervalMs\);\s*\n}/);
  console.log('✓ Core loop starts with immediate guarded tick and crash recovery');
}

{
  const stripeWebhook = section(index, "app.post('/api/stripe/webhook'", "// ==========================================\n// 1b. CRYPTO");
  assert.match(stripeWebhook, /recognizeExternalPaymentRevenue/);
  assert.doesNotMatch(stripeWebhook, /parseFloat\(deployment\.revenue/);
  assert.doesNotMatch(stripeWebhook, /updateDeployment\(deployment\.id,\s*{\s*revenue/);
  assert.match(revenue, /getOrCreateProviderPayment/);
  assert.match(revenue, /recordPaymentPaid/);
  assert.match(revenue, /allocateRevenueForPayment/);
  assert.match(revenue, /Revenue Recognized/);
  console.log('✓ Stripe revenue uses canonical payment ledger flow');
}

{
  assert.match(growth, /export async function startExperiment/);
  assert.match(growth, /export async function stopExperiment/);
  assert.match(growth, /Two configured variants are required/);
  assert.match(growth, /Insufficient evidence/);
  assert.match(growth, /status: status === 'COMPLETED' \? 'COMPLETED' : experiment\.status === 'ACTIVE' \? 'ACTIVE' : 'INCONCLUSIVE'/);
  assert.match(routers, /startExperiment:\s*adminProcedure/);
  assert.match(routers, /stopExperiment:\s*adminProcedure/);
  assert.match(routers, /listExperiments:\s*protectedProcedure/);
  console.log('✓ A/B experiment lifecycle has start/evaluate/stop controls');
}

{
  assert.equal(typeof packageJson.scripts.test, 'string');
  assert.ok(!packageJson.scripts.test.includes('live-providers.test.ts'));
  assert.ok(!packageJson.scripts.test.includes('autonomous-manager.test.ts'));
  assert.ok(packageJson.scripts.test.includes('internal-remediation.test.ts'));
  console.log('✓ Default test suite excludes live/external integration tests');
}

console.log('\n✅ INTERNAL REMEDIATION REGRESSION TESTS PASSED\n');
