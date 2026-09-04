// ============================================================
// AUTONOMOUS BUSINESS MANAGER — integration test
// ============================================================
// Exercises the autonomous manager against the REAL database and, for
// the recovery scenario, the REAL Vercel deployment pipeline. Uses
// isolated test deployments that are cleaned up at the end.
// ============================================================
import 'dotenv/config';
import * as db from '../server/db';
import {
  runAutonomousCycle,
  monitorDeploymentById,
  recoverStaleJobs,
  enforceRiskLimits,
} from '../server/autonomousManager';
import { deployApplication } from '../server/orchestrator';
import { verifyPublicUrl } from '../server/services/vercel';
import * as schema from '../drizzle/schema';
import { eq, sql } from 'drizzle-orm';

const results: { name: string; pass: boolean; detail: string }[] = [];
const created = { gaps: [] as string[], deployments: [] as string[], queueItems: [] as string[] };

function record(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function createTestDeployment(overrides: {
  banRisk?: 'low' | 'medium' | 'high';
  health?: 'healthy' | 'warning' | 'critical';
  consecutiveFailures?: number;
  url?: string;
} = {}) {
  const admin = await db.getAdminUserId();
  const dedupHash = 'autonomous-test-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const gap = await db.createGap({
    knows: 'Independent repair technicians who know how to fix niche appliances',
    needs: 'Homeowners who cannot find a local technician for a niche appliance and resort to replacing it',
    controlsAccess: 'Appliance brands that restrict service manuals and parts to authorized dealers',
    underestimatesValue: 'The repair know-how is undervalued because it is fragmented across forums',
    source: 'autonomous-test',
    priority: 5,
    dedupHash,
  });
  created.gaps.push(gap!.id);

  const deployment = await db.createDeployment({
    gapId: gap!.id,
    userId: admin,
    businessPlan: 'Test business plan for autonomous management verification.',
    banRisk: overrides.banRisk || 'low',
    health: overrides.health || 'healthy',
  });
  created.deployments.push(deployment!.id);

  if (overrides.consecutiveFailures) {
    await db.updateDeployment(deployment!.id, {
      consecutiveFailures: overrides.consecutiveFailures,
    });
  }

  const url = overrides.url || 'https://sao-dead-test-does-not-exist.vercel.app';
  const provider = await db.createDeploymentProvider(
    deployment!.id,
    'vercel',
    { vercelProjectId: 'test-' + Date.now(), vercelDeploymentId: 'test' },
    url
  );
  await db.updateProviderStatus(provider!.id, 'active');

  return deployment!;
}

async function cleanup() {
  try {
    for (const id of created.deployments) {
      await db.db.delete(schema.deploymentProviders).where(eq(schema.deploymentProviders.deploymentId, id));
      await db.db.delete(schema.deploymentHealthChecks).where(eq(schema.deploymentHealthChecks.deploymentId, id));
      await db.db.delete(schema.auditLogs).where(eq(schema.auditLogs.deploymentId, id));
      await db.db.delete(schema.deployments).where(eq(schema.deployments.id, id));
    }
    for (const id of created.queueItems) {
      await db.db.delete(schema.queueItems).where(eq(schema.queueItems.id, id));
    }
    for (const id of created.gaps) {
      await db.db.delete(schema.gaps).where(eq(schema.gaps.id, id));
    }
    console.log('🧹 Cleaned up test data.');
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}


async function main() {
  console.log('=== AUTONOMOUS BUSINESS MANAGER TEST ===\n');

  // ---- 1. Spending limit enforcement (maxDeployments) ----
  {
    const state = await db.getCoreLoopState();
    const originalMax = Number((state as any).maxDeployments);
    const activeCount = await db.countDeploymentsByStatus('active');
    await db.updateCoreLoopState({ maxDeployments: Math.max(0, activeCount) });
    const check = await db.canCreateDeployment();
    record('Spending/risk limit (maxDeployments) blocks new deployments', check.allowed === false, check.reason || '');
    await db.updateCoreLoopState({ maxDeployments: originalMax });
  }

  // ---- 2. Ban-risk auto-pause (enforceRiskLimits) ----
  {
    const dep = await createTestDeployment({ banRisk: 'high' });
    await enforceRiskLimits();
    const updated = await db.getDeploymentById(dep.id);
    record('Auto-pause on high ban risk', updated!.status === 'paused');
    await db.updateDeployment(dep.id, { status: 'active', banRisk: 'low' });
  }

  // ---- 3. Failure detection (dead app) ----
  {
    const dep = await createTestDeployment({});
    await monitorDeploymentById(dep.id);
    const updated = await db.getDeploymentById(dep.id);
    const checks = await db.listHealthChecks(dep.id);
    record(
      'Failure detection (dead URL -> critical + failure recorded)',
      (updated!.consecutiveFailures as any) === 1 &&
        updated!.health === 'critical' &&
        checks.length >= 1 &&
        (checks[0] as any).success === false
    );
  }

  // ---- 4. Auto-recovery (redeploy to real Vercel) ----
  let recoveryDeployment: any = null;
  {
    const dep = await createTestDeployment({});
    await monitorDeploymentById(dep.id); // failure #1
    await monitorDeploymentById(dep.id); // failure #2 -> recovery
    const updated = await db.getDeploymentById(dep.id);
    const provider = await db.getActiveProvider(dep.id, 'vercel');
    const reachable = provider?.deploymentUrl
      ? (await verifyPublicUrl(provider.deploymentUrl)).reachable
      : false;
    recoveryDeployment = updated;
    record(
      'Auto-recovery (redeploy restores a reachable app)',
      (updated!.consecutiveFailures as any) === 0 &&
        updated!.health === 'healthy' &&
        Boolean(provider?.deploymentUrl) &&
        reachable,
      provider?.deploymentUrl || 'no-url'
    );
  }


  // ---- 5. Rollback protection (last-good snapshot + restore) ----
  {
    const dep = recoveryDeployment || (await createTestDeployment({}));
    const hasSnapshot = Boolean((dep as any).lastGoodFiles);
    let restoredOk = false;
    if (hasSnapshot) {
      const snapshot = JSON.parse((dep as any).lastGoodFiles);
      if (Array.isArray(snapshot.files) && snapshot.files.length > 0) {
        const result = await deployApplication(dep.id, {
          reason: 'rollback-test',
          files: snapshot.files,
        });
        restoredOk = result.restored === true && Boolean(result.publicUrl);
      }
    }
    record('Rollback protection (last-good snapshot persisted + restorable)', hasSnapshot && restoredOk);
  }

  // ---- 6. Auto-shutdown of consistently-unsuccessful business ----
  {
    const dep = await createTestDeployment({ consecutiveFailures: 4 });
    await monitorDeploymentById(dep.id);
    const updated = await db.getDeploymentById(dep.id);
    const logs = await db.listAuditLogs(10, 0);
    const autoStopLog = logs.find((l: any) => l.decision === 'Auto-Stop');
    record(
      'Failed-business detection + auto-shutdown',
      updated!.status === 'stopped' && Boolean((updated as any).autoStoppedAt) && Boolean(autoStopLog)
    );
  }

  // ---- 7. Worker / stale-job recovery ----
  {
    const dep = await createTestDeployment({});
    const q = await db.createQueueItem({ gapId: dep.gapId, dedupHash: 'stale-' + Date.now() });
    created.queueItems.push(q!.id);
    await db.updateQueueItem(q!.id, { status: 'processing', workerId: 'dead-worker', attempts: 1 });
    await db.db.execute(sql`UPDATE queue_items SET updated_at = NOW() - INTERVAL 60 MINUTE WHERE id = ${q!.id}`);
    await recoverStaleJobs(5);
    const recovered = await db.getQueueItem(q!.id);
    record('Stale/abandoned job recovery', recovered!.status === 'pending');
  }

  // ---- 8. Duplicate-job prevention (idempotent deployment enqueue) ----
  {
    const dep = await createTestDeployment({});
    await db.enqueueDeploymentQueueItem(dep.gapId);
    await db.enqueueDeploymentQueueItem(dep.gapId);
    const items = await db.listQueueItems();
    const count = items.filter(
      (i: any) => i.queueItem.gapId === dep.gapId && i.queueItem.queueType === 'deployment'
    ).length;
    record('Duplicate-job prevention (idempotent enqueue)', count === 1, `found ${count}`);
  }

  // ---- 9. Long-running stability (cycle runs without throwing) ----
  {
    await runAutonomousCycle();
    record('Long-running stability (cycle runs without throwing)', true);
  }

  console.log('\n=== RESULTS ===');
  const passed = results.filter((r) => r.pass).length;
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.name}`);
  }
  console.log(`\n${passed}/${results.length} passed`);

  await cleanup();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  cleanup().finally(() => process.exit(1));
});
