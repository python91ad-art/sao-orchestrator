// ============================================================
// AUTONOMOUS BUSINESS MANAGER
// ============================================================
// Continuously monitors deployed businesses and, without human
// intervention, detects failures, recovers/redeploys, enforces
// risk & spending limits, detects failed businesses, and shuts down
// consistently unsuccessful ones. Also recovers stale/abandoned jobs
// so the whole system is self-healing and safe to run long-term.
// ============================================================

import * as db from './db';
import { verifyPublicUrl } from './services/vercel';
import { deployApplication, cleanStaleQueueItems } from './orchestrator';
import { checkQueueHealth } from './auditScheduler';
import { callLLM, MODEL_BUSINESS_PLAN } from './services/llm';
import { broadcastEvent } from './websocket';

// ------------------------------------------------------------
// Configuration (all overridable via environment variables)
// ------------------------------------------------------------
const MONITOR_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.AUTONOMOUS_MONITOR_INTERVAL_MS) || 300_000
);
const REDEPLOY_FAILURE_STREAK = Math.max(
  2,
  Number(process.env.AUTONOMOUS_REDEPLOY_FAILURE_STREAK) || 2
);
const SHUTDOWN_FAILURE_STREAK = Math.max(
  3,
  Number(process.env.AUTONOMOUS_SHUTDOWN_FAILURE_STREAK) || 5
);
const STALE_PROCESSING_MINUTES = Math.max(
  5,
  Number(process.env.AUTONOMOUS_STALE_PROCESSING_MINUTES) || 20
);

// ------------------------------------------------------------
// Runtime state
// ------------------------------------------------------------
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let cycleRunning = false;
let startupRunScheduled = false;

// In-process lock to prevent concurrent deploys of the same business.
const deploying = new Set<string>();

// ------------------------------------------------------------
// Scheduler
// ------------------------------------------------------------
export function scheduleAutonomousManager(): void {
  if (monitorTimer) return;

  console.log(
    `[AutonomousManager] Scheduled every ${Math.round(MONITOR_INTERVAL_MS / 1000)}s.`
  );

  monitorTimer = setInterval(() => {
    runAutonomousCycle().catch((err) =>
      console.error('[AutonomousManager] Cycle failed:', err)
    );
  }, MONITOR_INTERVAL_MS);

  if (!startupRunScheduled) {
    startupRunScheduled = true;
    // Run once shortly after boot so failures are caught immediately.
    setTimeout(() => {
      runAutonomousCycle().catch((err) =>
        console.error('[AutonomousManager] Startup cycle failed:', err)
      );
    }, 15_000);
  }
}

// ------------------------------------------------------------
// Main cycle
// ------------------------------------------------------------
export async function runAutonomousCycle(): Promise<void> {
  if (cycleRunning) {
    console.log('[AutonomousManager] Cycle already running — skipping overlap.');
    return;
  }
  cycleRunning = true;
  const started = Date.now();
  try {
    // 1. Recover abandoned/stale jobs (worker & scheduler self-healing).
    await recoverStaleJobs();

    // 2. Enforce risk limits (auto-pause on high ban risk).
    await enforceRiskLimits();

    // 3. Monitor every active business.
    const deployments = await db.listDeployments();
    const active = deployments.filter((d: any) => d.status === 'active');
    console.log(
      `[AutonomousManager] Monitoring ${active.length} active deployment(s).`
    );

    for (const dep of active) {
      try {
        await monitorDeployment(dep as any);
      } catch (err) {
        console.error(
          `[AutonomousManager] Error monitoring ${(dep as any).id}:`,
          err
        );
      }
    }

    // 4. Queue-health alerting (shared with the 3-day audit).
    await checkQueueHealth().catch((err) =>
      console.error('[AutonomousManager] Queue health check failed:', err)
    );
  } catch (err) {
    console.error('[AutonomousManager] Cycle error:', err);
  } finally {
    cycleRunning = false;
    console.log(
      `[AutonomousManager] Cycle completed in ${Date.now() - started}ms.`
    );
  }
}


// ------------------------------------------------------------
// Stale / abandoned job recovery
// ------------------------------------------------------------
export async function recoverStaleJobs(minutes = STALE_PROCESSING_MINUTES): Promise<void> {
  try {
    const recovered = await db.recoverStaleProcessingQueueItems(minutes);
    if (recovered > 0) {
      console.log(
        `[AutonomousManager] Recovered ${recovered} stale processing job(s).`
      );
    }
    const cleaned = await cleanStaleQueueItems();
    if (cleaned > 0) {
      console.log(`[AutonomousManager] Cleaned ${cleaned} stale pending job(s).`);
    }
  } catch (err) {
    console.error('[AutonomousManager] Stale-job recovery failed:', err);
  }
}

// ------------------------------------------------------------
// Risk / spending limit enforcement
// ------------------------------------------------------------
export async function enforceRiskLimits(): Promise<void> {
  try {
    const state = await db.getCoreLoopState();
    const autoPause = Boolean((state as any)?.autoPauseOnHighBanRisk ?? true);
    if (!autoPause) return;

    const deployments = await db.listDeployments();
    for (const dep of deployments) {
      if ((dep as any).status !== 'active') continue;
      if ((dep as any).banRisk === 'high') {
        await db.updateDeployment(dep.id, { status: 'paused' });
        console.log(
          `[AutonomousManager] ⚠️ Auto-paused ${dep.id} (high ban risk).`
        );
        broadcastEvent({
          type: 'deployment:provider',
          data: {
            deploymentId: dep.id,
            providerType: 'vercel',
            providerId: '',
            status: 'paused',
            note: 'Auto-paused on high ban risk',
          },
        });
      }
    }
  } catch (err) {
    console.error('[AutonomousManager] Risk-limit enforcement failed:', err);
  }
}

// ------------------------------------------------------------
// Per-business continuous monitoring
// ------------------------------------------------------------
async function monitorDeployment(deployment: any): Promise<void> {
  const provider = await db.getActiveProvider(deployment.id, 'vercel');
  const url = provider?.deploymentUrl || null;

  await db.updateDeployment(deployment.id, { lastCheckedAt: new Date() });

  if (!url) {
    await recordFailure(
      deployment,
      'No active provider / deployment URL found.'
    );
    return;
  }

  const check = await verifyPublicUrl(url);

  if (check.reachable) {
    await db.updateDeployment(deployment.id, {
      consecutiveFailures: 0,
      lastSeenHealthyAt: new Date(),
      health: deployment.health === 'critical' ? 'warning' : deployment.health || 'healthy',
      lastFailureReason: null,
    });
    await db.createHealthCheck({
      deploymentId: deployment.id,
      revenue: String(deployment.revenue ?? '0.00'),
      banRisk: deployment.banRisk || 'low',
      health: 'healthy',
      action: 'Uptime check passed',
      success: true,
    });

    // Autonomous improvement: if the 3-day audit flagged the business as
    // critical (app up, business failing), regenerate + redeploy.
    if (deployment.health === 'critical') {
      await improveDeployment(deployment);
    }
    return;
  }

  await recordFailure(
    deployment,
    `App unreachable (HTTP ${check.status}${check.gated ? ', login-gated' : ''}).`
  );
}

async function recordFailure(deployment: any, reason: string): Promise<void> {
  const consecutive = (Number(deployment.consecutiveFailures) || 0) + 1;
  const total = (Number(deployment.totalFailures) || 0) + 1;

  await db.updateDeployment(deployment.id, {
    consecutiveFailures: consecutive,
    totalFailures: total,
    lastFailureReason: reason,
    health: 'critical',
  });
  await db.createHealthCheck({
    deploymentId: deployment.id,
    revenue: String(deployment.revenue ?? '0.00'),
    banRisk: deployment.banRisk || 'low',
    health: 'critical',
    action: reason,
    success: false,
  });
  broadcastEvent({
    type: 'queue:updated',
    data: { queueItemId: deployment.id, status: 'unreachable' },
  });
  console.log(
    `[AutonomousManager] ❌ ${deployment.id} failure #${consecutive}: ${reason}`
  );

  if (consecutive >= SHUTDOWN_FAILURE_STREAK) {
    await autoStopDeployment(
      deployment,
      `Consistently unsuccessful: ${consecutive} consecutive failures.`
    );
  } else if (consecutive >= REDEPLOY_FAILURE_STREAK) {
    await recoverDeployment(deployment, reason);
  }
}


// ------------------------------------------------------------
// Recovery / redeployment
// ------------------------------------------------------------
async function recoverDeployment(deployment: any, reason: string): Promise<void> {
  if (deploying.has(deployment.id)) {
    console.log(`[AutonomousManager] ${deployment.id} already recovering.`);
    return;
  }
  deploying.add(deployment.id);
  try {
    await db.updateDeployment(deployment.id, {
      recoveryCount: (Number(deployment.recoveryCount) || 0) + 1,
    });
    const result = await deployApplication(deployment.id, {
      reason: `auto-recovery: ${reason}`,
    });
    await db.updateDeployment(deployment.id, {
      consecutiveFailures: 0,
      lastSeenHealthyAt: new Date(),
      health: 'healthy',
      lastFailureReason: null,
    });
    broadcastEvent({
      type: 'deployment:provider',
      data: {
        deploymentId: deployment.id,
        providerType: 'vercel',
        providerId: result.providerId,
        status: 'active',
        deploymentUrl: result.publicUrl,
      },
    });
    console.log(
      `[AutonomousManager] ✅ Recovered ${deployment.id} -> ${result.publicUrl}`
    );
  } catch (err) {
    console.error(
      `[AutonomousManager] Recovery failed for ${deployment.id}:`,
      (err as Error)?.message
    );
    await rollbackToLastGood(deployment, (err as Error)?.message);
  } finally {
    deploying.delete(deployment.id);
  }
}

// ------------------------------------------------------------
// Rollback protection — restore the last-known-good app
// ------------------------------------------------------------
async function rollbackToLastGood(
  deployment: any,
  reason: string
): Promise<void> {
  try {
    if (!deployment.lastGoodFiles) {
      console.warn(
        `[AutonomousManager] No last-good snapshot for ${deployment.id}; cannot roll back.`
      );
      return;
    }
    const snapshot = JSON.parse(deployment.lastGoodFiles);
    const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
    if (files.length === 0) return;

    const result = await deployApplication(deployment.id, {
      reason: `rollback: ${reason}`,
      files,
    });
    await db.updateDeployment(deployment.id, {
      consecutiveFailures: 0,
      lastSeenHealthyAt: new Date(),
      health: 'healthy',
      lastFailureReason: null,
    });
    console.log(
      `[AutonomousManager] ↩️ Rolled back ${deployment.id} to last-good app at ${result.publicUrl}`
    );
  } catch (err) {
    console.error(
      `[AutonomousManager] Rollback failed for ${deployment.id}:`,
      (err as Error)?.message
    );
  }
}

// ------------------------------------------------------------
// Autonomous improvement (business/app update)
// ------------------------------------------------------------
async function improveDeployment(deployment: any): Promise<void> {
  if (deploying.has(deployment.id)) return;
  deploying.add(deployment.id);
  try {
    console.log(
      `[AutonomousManager] 🧠 Improving business ${deployment.id} (critical audit).`
    );
    try {
      const prompt = `Formulate an optimized pivot for this startup to restore viability.
Current plan: ${deployment.businessPlan}
Focus on concrete operational changes that improve margins and reduce risk.`;
      const updatedPlan = await callLLM(prompt, {
        model: MODEL_BUSINESS_PLAN,
        systemPrompt:
          'You are an elite entrepreneurial strategist specializing in situational arbitrage.',
        maxTokens: 4096,
        temperature: 0.7,
      });
      if (updatedPlan) {
        await db.updateDeployment(deployment.id, { businessPlan: updatedPlan });
      }
    } catch (err) {
      console.error(
        `[AutonomousManager] Plan pivot failed for ${deployment.id} (continuing with existing plan):`,
        (err as Error)?.message
      );
    }

    const result = await deployApplication(deployment.id, {
      reason: 'autonomous-improvement',
    });
    await db.updateDeployment(deployment.id, {
      health: 'warning',
      lastSeenHealthyAt: new Date(),
      consecutiveFailures: 0,
    });
    console.log(
      `[AutonomousManager] ✅ Improved ${deployment.id} -> ${result.publicUrl}`
    );
  } catch (err) {
    console.error(
      `[AutonomousManager] Improvement failed for ${deployment.id}:`,
      (err as Error)?.message
    );
  } finally {
    deploying.delete(deployment.id);
  }
}

// ------------------------------------------------------------
// Failed-business detection → automatic shutdown
// ------------------------------------------------------------
async function autoStopDeployment(
  deployment: any,
  reason: string
): Promise<void> {
  await db.updateDeployment(deployment.id, {
    status: 'stopped',
    autoStoppedAt: new Date(),
    autoStopReason: reason,
    health: 'critical',
  });

  const provider = await db.getActiveProvider(deployment.id, 'vercel');
  if (provider) {
    await db.updateProviderStatus(provider.id, 'failed');
  }

  await db.createAuditLog({
    deploymentId: deployment.id,
    gapId: deployment.gapId,
    decision: 'Auto-Stop',
    reasoning: reason,
    explanation: `Automatically stopped after ${deployment.consecutiveFailures} consecutive failures.`,
    banRisk: deployment.banRisk || 'low',
    businessHealth: 'critical',
  });

  broadcastEvent({
    type: 'deployment:provider',
    data: {
      deploymentId: deployment.id,
      providerType: 'vercel',
      providerId: provider?.id || '',
      status: 'stopped',
      note: reason,
    },
  });

  console.log(
    `[AutonomousManager] 🛑 Auto-stopped deployment ${deployment.id}: ${reason}`
  );
}


// ------------------------------------------------------------
// Targeted manual check (admin / tests)
// ------------------------------------------------------------
export async function monitorDeploymentById(deploymentId: string): Promise<void> {
  const deployment = await db.getDeploymentById(deploymentId);
  if (!deployment) {
    throw new Error(`Deployment ${deploymentId} not found.`);
  }
  await monitorDeployment(deployment as any);
}
