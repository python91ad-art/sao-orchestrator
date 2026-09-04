import { callLLM, callLLMJson, MODEL_CLASSIFIER, MODEL_BUSINESS_PLAN } from './services/llm';
import * as db from './db';
import { retryWithExponentialBackoff, aiRateLimiter } from './retryEngine';
import { sql } from 'drizzle-orm';
import { queueItems } from '../drizzle/schema';
import { broadcastEvent } from './websocket';
import { detectEcommerceGaps, detectOperationalGaps, DetectedGap, getDiscoveryStatus, getExtractionMetrics } from './services/search';
import crypto from 'crypto';

let loopInterval: NodeJS.Timeout | null = null;
let coreLoopTickRunning = false;

// ==========================================
// WORKER POOL — Concurrent queue processing
// ==========================================
type QueueType = 'synthesis' | 'deployment' | 'audit' | 'maintenance';

interface Worker {
  id: string;
  busy: boolean;
  currentItem: string | null;
}

const workers = new Map<string, Worker>();
let totalProcessedByWorkers = 0;

function spawnWorker(workerId: string): Worker {
  const worker: Worker = { id: workerId, busy: false, currentItem: null };
  workers.set(workerId, worker);
  return worker;
}

function getActiveWorkers(): number {
  return Array.from(workers.values()).filter(w => w.busy).length;
}

async function dispatchToWorker(worker: Worker, queueItem: any, queueType: QueueType): Promise<void> {
  worker.busy = true;
  worker.currentItem = queueItem.id;

  broadcastEvent({
    type: 'worker:status',
    data: { activeWorkers: getActiveWorkers(), totalProcessed: totalProcessedByWorkers }
  });

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  try {
    broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'processing' } });

    // Keep the processing lease alive while this worker is actively processing.
    heartbeatTimer = setInterval(() => {
      db.touchProcessingQueueItem(queueItem.id, worker.id).catch((error) => {
        console.error(
          `[Worker ${worker.id}] Failed to update queue heartbeat for ${queueItem.id}:`,
          error
        );
      });
    }, 5 * 60 * 1000);

    if (queueType === 'synthesis') {
      await processSynthesisQueueItem(queueItem, worker);
    } else if (queueType === 'audit') {
      await processAuditQueueItem(queueItem, worker);
    } else if (queueType === 'deployment') {
      await processDeploymentQueueItem(queueItem, worker);
    } else {
      // maintenance — just mark complete
    }

    totalProcessedByWorkers++;
    broadcastEvent({
      type: 'worker:status',
      data: { activeWorkers: getActiveWorkers(), totalProcessed: totalProcessedByWorkers }
    });
  } catch (error) {
    console.error(`[Worker ${worker.id}] Error processing ${queueType} item:`, error);

    const state = await getStatus();
    const maxAttempts = Math.max(
      1,
      Number((state as any).maxAttempts) || Number(queueItem.maxAttempts) || 3
    );

    const errorMessage =
      error instanceof Error ? error.message : String(error);

    if (queueItem.attempts >= maxAttempts) {
      await db.updateQueueItem(queueItem.id, {
        status: 'failed',
        lastError: errorMessage,
        workerId: null,
        nextRetryAt: null,
      });

      broadcastEvent({
        type: 'queue:updated',
        data: { queueItemId: queueItem.id, status: 'failed' }
      });

      console.error(
        `[Worker ${worker.id}] Queue item ${queueItem.id} permanently failed after ${queueItem.attempts}/${maxAttempts} attempts.`
      );
    } else {
      const backoffMultiplier = Math.max(
        1,
        Number((state as any).backoffMultiplier) || 1.5
      );

      const baseDelayMs = Math.max(
        1000,
        Number((state as any).baseDelayMs) || 5000
      );

      const retryDelayMs = Math.round(
        baseDelayMs *
        Math.pow(backoffMultiplier, Math.max(0, queueItem.attempts - 1))
      );

      const nextRetryAt = new Date(Date.now() + retryDelayMs);

      await db.updateQueueItem(queueItem.id, {
        status: 'pending',
        lastError: errorMessage,
        workerId: null,
        nextRetryAt,
      });

      broadcastEvent({
        type: 'queue:updated',
        data: {
          queueItemId: queueItem.id,
          status: 'pending',
          nextRetryAt: nextRetryAt.toISOString(),
        }
      });

      console.log(
        `[Worker ${worker.id}] Queue item ${queueItem.id} returned to pending for retry (${queueItem.attempts}/${maxAttempts}) in ${retryDelayMs}ms.`
      );
    }
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    worker.busy = false;
    worker.currentItem = null;
  }
}

async function processWithWorkerPool(): Promise<number> {
  const state = await getStatus();
  const concurrency = Math.max(
    1,
    Math.min(10, Number((state as any).concurrency) || 1)
  );

  // Create missing workers.
  while (workers.size < concurrency) {
    const workerId = `worker-${workers.size + 1}`;
    spawnWorker(workerId);
  }

  // If concurrency was reduced, only remove IDLE workers.
  // Busy workers are allowed to finish their current jobs.
  if (workers.size > concurrency) {
    const idleWorkers = Array.from(workers.values()).filter(
      worker => !worker.busy
    );

    for (const worker of idleWorkers) {
      if (workers.size <= concurrency) break;
      workers.delete(worker.id);
    }
  }

  const availableWorkers = Array.from(workers.values()).filter(
    worker => !worker.busy
  );

  if (availableWorkers.length === 0) {
    return 0;
  }

  let processed = 0;

  await Promise.all(
    availableWorkers.map(async worker => {
      while (true) {
        const queueItem = await db.claimNextPendingQueueItem(worker.id);

        if (!queueItem) {
          break;
        }

        processed++;

        const queueType =
          (queueItem as any).queueType || 'synthesis';

        await dispatchToWorker(
          worker,
          queueItem,
          queueType as QueueType
        );
      }
    })
  );

  return processed;
}

// ==========================================
// MULTI-QUEUE TYPE HANDLERS
// ==========================================

async function processSynthesisQueueItem(queueItem: any, _worker: Worker): Promise<boolean> {
  const state = await getStatus();
  const maxAttempts = (state as any).maxAttempts || 3;
  const backoffMultiplier = parseFloat((state as any).backoffMultiplier || '1.5');
  const baseDelayMs = (state as any).baseDelayMs || 5000;

  const gap = await db.getGapById(queueItem.gapId);
  if (!gap) {
    await db.updateQueueItem(queueItem.id, {
      status: 'failed',
      lastError: 'Associated gap not found in database.',
      workerId: null,
      nextRetryAt: null,
    });
    return false;
  }

  await db.updateGapStatus(gap.id, 'processing');

  const classification = await retryWithExponentialBackoff(
    () => classifyGap(gap),
    maxAttempts,
    baseDelayMs,
    backoffMultiplier
  );

  await db.createAuditLog({
    gapId: gap.id,
    decision: classification.classification,
    reasoning: classification.reasoning,
    explanation: classification.explanation,
    banRisk: classification.banRisk,
  });

  broadcastEvent({ type: 'audit:completed', data: { deploymentId: '', health: classification.classification } });

  if (classification.classification === 'safe') {
    const plan = await retryWithExponentialBackoff(
      () => generateBusinessPlan(gap),
      maxAttempts,
      baseDelayMs,
      backoffMultiplier
    );

    const limitCheck = await db.canCreateDeployment();
    if (!limitCheck.allowed) {
      await db.updateGapStatus(gap.id, 'gray');
      await db.updateQueueItem(queueItem.id, { status: 'paused', lastError: limitCheck.reason, workerId: null, nextRetryAt: null });
      broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'paused' } });
      return true;
    }

    const adminUserId = await db.getAdminUserId();
    const deployment = await db.createDeployment({
      gapId: gap.id,
      userId: adminUserId,
      businessPlan: plan,
      banRisk: classification.banRisk,
      health: 'healthy',
    });

    broadcastEvent({ type: 'deployment:created', data: { deploymentId: deployment.id, gapId: gap.id } });

    // Enqueue the deployment step so the application is generated,
    // smoke-tested and deployed to Vercel automatically — closing the
    // previously-broken gap between business-plan synthesis and live app.
    await db.enqueueDeploymentQueueItem(gap.id);

    await db.updateGapStatus(gap.id, 'deployed');
    await db.updateQueueItem(queueItem.id, { status: 'completed', workerId: null, nextRetryAt: null });
    broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'completed' } });

    const currentState = await getStatus();
    await db.updateCoreLoopState({
      totalGapsProcessed: currentState.totalGapsProcessed + 1,
      totalDeploymentsCreated: currentState.totalDeploymentsCreated + 1,
    });
  } else if (classification.classification === 'unsafe') {
    await db.updateGapStatus(gap.id, 'unsafe');
    await db.updateQueueItem(queueItem.id, { status: 'failed', lastError: 'Violates safe policy guidelines.', workerId: null, nextRetryAt: null });
    broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'failed' } });
  } else if (classification.classification === 'gray') {
    await db.updateGapStatus(gap.id, 'gray');
    await db.updateQueueItem(queueItem.id, { status: 'paused', lastError: 'Requires manual admin oversight.', workerId: null, nextRetryAt: null });
    broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'paused' } });
  } else {
    await db.updateGapStatus(gap.id, 'false');
    await db.updateQueueItem(queueItem.id, { status: 'failed', lastError: 'Identified as not a real gap opportunity.', workerId: null, nextRetryAt: null });
    broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'failed' } });
  }

  return true;
}

async function processAuditQueueItem(queueItem: any, _worker: Worker): Promise<boolean> {
  const deployment = await db.getDeploymentByGapId(queueItem.gapId);
  if (!deployment) {
    await db.updateQueueItem(queueItem.id, { status: 'failed', lastError: 'Deployment not found for audit.', workerId: null, nextRetryAt: null });
    return false;
  }

  const { auditDeployment } = await import('./auditScheduler');
  await auditDeployment(deployment.id);
  await db.updateQueueItem(queueItem.id, { status: 'completed', workerId: null, nextRetryAt: null });
  broadcastEvent({ type: 'audit:completed', data: { deploymentId: deployment.id, health: 'checked' } });
  return true;
}

// ============================================================
// APPLICATION DEPLOYMENT CORE
// Reused by the queue worker AND by the autonomous manager
// (recovery, improvement and rollback). Commits a new app to
// production only AFTER it is verified READY and publicly reachable,
// preserving the previous provider on any failure (rollback protection).
// ============================================================
export async function deployApplication(
  deploymentId: string,
  opts: { reason?: string; files?: { path: string; content: string }[] } = {}
): Promise<{ publicUrl: string; providerId: string; restored: boolean }> {
  const deployment = await db.getDeploymentById(deploymentId);
  if (!deployment) {
    throw new Error(`Deployment ${deploymentId} not found.`);
  }

  const gap = await db.getGapById(deployment.gapId);
  if (!gap) {
    throw new Error(`Gap ${deployment.gapId} not found for deployment ${deploymentId}.`);
  }

  const { generateApplication, smokeTestApplication } = await import('./services/applicationGenerator');
  const {
    createVercelProject,
    deployToVercel,
    makeVercelProjectName,
    mapFrameworkForVercel,
    resolveVercelPublicUrl,
    waitForVercelDeploymentReady,
  } = await import('./services/vercel');

  const restored = Boolean(opts.files && opts.files.length > 0);

  let app: {
    files: { path: string; content: string }[];
    entryPoint: string;
    framework: 'static' | 'react' | 'other';
  };

  if (restored) {
    // Rollback path — redeploy the last-known-good files verbatim.
    app = {
      files: opts.files!,
      entryPoint: opts.files![0]?.path || 'index.html',
      framework: 'static',
    };
    console.log(`[Deployment] Restoring ${opts.files!.length} last-known-good files for ${deploymentId}.`);
  } else {
    broadcastEvent({ type: 'application:generation_started', data: { deploymentId, gapId: gap.id } });

    const genResult = await retryWithExponentialBackoff(
      () => generateApplication({
        gapId: gap.id,
        deploymentId,
        knows: gap.knows,
        needs: gap.needs,
        controlsAccess: gap.controlsAccess,
        underestimatesValue: gap.underestimatesValue,
        businessPlan: deployment.businessPlan || '',
      }),
      2,
      3000
    );

    if (!genResult.success || !genResult.application) {
      throw new Error(genResult.error || 'Application generation produced no output.');
    }
    app = genResult.application;
    broadcastEvent({ type: 'application:generation_completed', data: { deploymentId, fileCount: app.files.length } });
    console.log(`[Deployment] Generated ${app.files.length} files for deployment ${deploymentId}.`);
  }

  // ---- Smoke test the application before deploying ----
  const smokeResult = smokeTestApplication(app as any);
  console.log(
    `[Deployment] Smoke test for ${deploymentId}: ${smokeResult.passed ? 'PASSED' : 'FAILED'} ` +
    `(${smokeResult.stats.totalFiles} files, ${smokeResult.stats.totalChars} chars, ` +
    `${smokeResult.errors.length} errors, ${smokeResult.warnings.length} warnings)`
  );
  if (!smokeResult.passed) {
    throw new Error(`Application smoke test failed: ${smokeResult.errors.join('; ')}`);
  }
  if (smokeResult.warnings.length > 0) {
    console.warn(`[Deployment] ⚠️ Smoke test warnings for ${deploymentId}: ${smokeResult.warnings.join('; ')}`);
  }

  // ---- Create/reuse Vercel project ----
  const projectName = makeVercelProjectName(deploymentId);
  const { projectId } = await retryWithExponentialBackoff(
    () => createVercelProject({ name: projectName, framework: mapFrameworkForVercel(app.framework) ?? undefined }),
    3,
    2000
  );

  // ---- Deploy to Vercel ----
  const vercelFiles = app.files.map((f) => ({ file: f.path, data: f.content }));
  const deployResult = await retryWithExponentialBackoff(
    () => deployToVercel({ projectId, files: vercelFiles, name: `deploy-${Date.now()}`, target: 'production' }),
    3,
    3000
  );

  // ---- Wait for READY ----
  const readyState = await waitForVercelDeploymentReady(deployResult.deploymentId, 180_000, 3_000);
  if (!readyState.ready) {
    throw new Error(`Vercel deployment ${deployResult.deploymentId} did not become READY (state: ${readyState.state}).`);
  }

  // ---- Resolve + verify the publicly reachable URL ----
  const publicUrl = await resolveVercelPublicUrl(readyState.alias || [], readyState.url);
  if (!publicUrl) {
    throw new Error(`No publicly reachable URL found for deployment ${deploymentId}.`);
  }
  console.log(`[Deployment] ✅ Public URL verified for ${deploymentId}: ${publicUrl}`);

  // ---- Commit: supersede prior provider, activate the new one ----
  // Only reached after the new app is verified live, so a failed update
  // leaves the previous provider untouched (rollback protection).
  await db.supersedeActiveProviders(deploymentId, 'vercel');
  const provider = await db.createDeploymentProvider(
    deploymentId,
    'vercel',
    { vercelProjectId: projectId, vercelDeploymentId: deployResult.deploymentId, framework: app.framework },
    publicUrl
  );
  await db.updateProviderStatus(provider.id, 'active');

  // Persist a last-known-good snapshot for future rollback/restore.
  if (!restored) {
    await db.updateDeployment(deploymentId, {
      lastGoodFiles: JSON.stringify({ files: app.files, entryPoint: app.entryPoint, framework: app.framework }),
    });
  }

  console.log(
    `[Deployment] ${restored ? 'Restored' : 'Deployed'} ${deploymentId} to ${publicUrl} ` +
    `(provider ${provider.id})${opts.reason ? ` [${opts.reason}]` : ''}.`
  );

  return { publicUrl, providerId: provider.id, restored };
}


async function processDeploymentQueueItem(queueItem: any, _worker: Worker): Promise<boolean> {
  const gap = await db.getGapById(queueItem.gapId);
  if (!gap) {
    await db.updateQueueItem(queueItem.id, { status: 'failed', lastError: 'Gap not found.', workerId: null, nextRetryAt: null });
    return false;
  }

  const existingDeployment = await db.getDeploymentByGapId(queueItem.gapId);
  if (!existingDeployment) {
    await db.updateQueueItem(queueItem.id, { status: 'failed', lastError: 'No SAO deployment record found — synthesis must run first.', workerId: null, nextRetryAt: null });
    return false;
  }

  // Check for existing active Vercel provider with a real deployment URL
  const existingProvider = await db.getActiveProvider(existingDeployment.id, 'vercel');
  if (existingProvider && existingProvider.deploymentUrl) {
    console.log(`[Deployment] SAO deployment ${existingDeployment.id} already live at ${existingProvider.deploymentUrl}.`);
    await db.updateQueueItem(queueItem.id, { status: 'completed', workerId: null, nextRetryAt: null });
    broadcastEvent({
      type: 'deployment:provider',
      data: { deploymentId: existingDeployment.id, providerType: 'vercel', providerId: existingProvider.id, status: 'active' },
    });
    return true;
  }

  // ============================================================
  // Full pipeline: generate application → deploy to Vercel
  // ============================================================
  const result = await deployApplication(existingDeployment.id, { reason: 'scheduled-deployment' });

  await db.updateQueueItem(queueItem.id, { status: 'completed', workerId: null, nextRetryAt: null });

  broadcastEvent({
    type: 'deployment:provider',
    data: {
      deploymentId: existingDeployment.id,
      providerType: 'vercel',
      providerId: result.providerId,
      status: 'active',
      deploymentUrl: result.publicUrl,
    },
  });

  const currentState = await getStatus();
  await db.updateCoreLoopState({ totalDeploymentsCreated: currentState.totalDeploymentsCreated + 1 });

  return true;
}

// ==========================================
// CORE STATE
// ==========================================
export async function getStatus() {
  let state = await db.getCoreLoopState();
  if (!state) {
    state = await db.initCoreLoopState();
  }
  return state;
}

/**
 * Enhanced status including discovery health and extraction metrics.
 * Safe for dashboard display — never exposes credentials.
 */
export async function getEnhancedStatus() {
  const state = await getStatus();
  const discoveryStatus = getDiscoveryStatus();
  const extractionMetrics = getExtractionMetrics();
  return {
    ...state,
    discovery: {
      tavilyConfigured: discoveryStatus.tavilyConfigured,
      lastSearchStatus: discoveryStatus.lastSearchStatus,
      lastSearchStatusTime: discoveryStatus.lastSearchStatusTime,
    },
    extraction: {
      totalAttempts: extractionMetrics.totalAttempts,
      llmSuccesses: extractionMetrics.llmSuccesses,
      llmNoValidGaps: extractionMetrics.llmNoValidGaps,
      llmSchemaFailures: extractionMetrics.llmSchemaFailures,
      totalGapsExtracted: extractionMetrics.totalGapsExtracted,
      failures: extractionMetrics.failures,
      lastFailureReason: extractionMetrics.lastFailureReason,
      lastFailureTime: extractionMetrics.lastFailureTime ? new Date(extractionMetrics.lastFailureTime).toISOString() : null,
      lastSuccessTime: extractionMetrics.lastSuccessTime ? new Date(extractionMetrics.lastSuccessTime).toISOString() : null,
    },
  };
}

// ==========================================
// QUEUE MAINTENANCE — Clean stale items
// ==========================================
export async function cleanStaleQueueItems(): Promise<number> {
  try {
    const state = await getStatus();
    const expirationHours = (state as any).queueExpirationHours || 72;
    const cutoff = new Date(Date.now() - expirationHours * 60 * 60 * 1000);
    
    const staleItems = await db.db.select()
      .from(queueItems)
      .where(sql`${queueItems.status} = 'pending' AND ${queueItems.updatedAt} < ${cutoff}`);
    
    if (staleItems.length > 0) {
      await db.db.delete(queueItems)
        .where(sql`${queueItems.status} = 'pending' AND ${queueItems.updatedAt} < ${cutoff}`);
      console.log(`[Queue Maintenance] Cleaned ${staleItems.length} stale queue items (expired after ${expirationHours}h).`);
    }
    
    return staleItems.length;
  } catch (error) {
    console.error('[Queue Maintenance] Error cleaning stale items:', error);
    return 0;
  }
}

// ==========================================
// QUEUE ALERTS — Slack notification when queue too large
// ==========================================
export async function checkQueueAlerts(): Promise<void> {
  try {
    const state = await getStatus();
    const maxSize = (state as any).queueMaxSize || 1000;
    const stats = await db.getQueueStats();
    
    if (stats.pending > maxSize) {
      console.warn(`[Queue Alert] Pending items (${stats.pending}) exceed max size (${maxSize}). Sending Slack alert.`);
      await sendSlackAlert(`SAO Queue Alert: ${stats.pending} pending items exceed configured max of ${maxSize}. Consider increasing processing capacity or clearing old items.`);
    }
  } catch (error) {
    console.error('[Queue Alert] Error checking queue alerts:', error);
  }
}

async function sendSlackAlert(message: string): Promise<void> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackChannel = process.env.SLACK_CHANNEL || '#alerts';
  
  if (!slackToken) return;
  
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: slackChannel, text: message }),
    });
  } catch (error) {
    console.error('[Slack Alert] Failed to send:', error);
  }
}

// ==========================================
// AI CLASSIFICATION PIPELINE (Groq LLM)
// ==========================================
async function classifyGap(gap: {
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
  source: string;
}): Promise<{
  classification: 'safe' | 'unsafe' | 'gray' | 'false';
  reasoning: string;
  banRisk: 'low' | 'medium' | 'high';
  explanation: string;
}> {
  const hasToken = await aiRateLimiter.waitForTokens(1, 5000);
  if (!hasToken) {
    console.warn('[Rate Limiter] AI rate limit reached, waiting...');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const systemPrompt = `You are a gap classifier for the Situational Arbitrage Orchestrator. 
Classify this market gap as: SAFE (legal, low ban risk, clear opportunity), UNSAFE (illegal, toxic, or clear policy violation), GRAY (unclear, needs human review), or FALSE (not a real gap or invalid).
You must respond with raw, valid JSON only, using this exact schema:
{
  "classification": "safe" | "unsafe" | "gray" | "false",
  "reasoning": "Detailed logic behind classification",
  "banRisk": "low" | "medium" | "high",
  "explanation": "Human readable explanation"
}`;

  const userPrompt = `Gap details:
Knows: ${gap.knows}
Needs: ${gap.needs}
Controls Access: ${gap.controlsAccess}
Underestimates Value: ${gap.underestimatesValue}
Source: ${gap.source}`;

  const result = await callLLMJson(userPrompt, {
    model: MODEL_CLASSIFIER,
    systemPrompt,
    maxTokens: 1000,
    temperature: 0.3,
  });

  return {
    classification: result.classification || 'gray',
    reasoning: result.reasoning || 'No reasoning provided',
    banRisk: result.banRisk || 'medium',
    explanation: result.explanation || 'No explanation provided',
  };
}

// ==========================================
// BUSINESS PLAN GENERATION (Groq LLM)
// ==========================================
async function generateBusinessPlan(gap: {
  knows: string;
  needs: string;
  controlsAccess: string;
  underestimatesValue: string;
}): Promise<string> {
  const hasToken = await aiRateLimiter.waitForTokens(1, 5000);
  if (!hasToken) {
    console.warn('[Rate Limiter] AI rate limit reached for business plan generation, waiting...');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const prompt = `Formulate a complete micro-startup execution business plan for this situational arbitrage gap.
Gap Details:
Knows (who has the knowledge): ${gap.knows}
Needs (what demands are unfulfilled): ${gap.needs}
Controls Access (gatekeepers): ${gap.controlsAccess}
Underestimates Value (price mismatch/inefficiency): ${gap.underestimatesValue}

Provide a comprehensive blueprint covering:
1. Operational Strategy (How to bridge the gap)
2. Monetization & Pricing structure
3. Mitigation of Ban/Interference risks
4. Initial setup checklist`;

  const plan = await callLLM(prompt, {
    model: MODEL_BUSINESS_PLAN,
    systemPrompt: 'You are an elite entrepreneurial strategist specializing in situational arbitrage.',
    maxTokens: 4096,
    temperature: 0.8,
  });

  return plan || 'Business plan generation returned empty content.';
}

// ==========================================
// PROCESS ONE GAP (backwards-compatible single-item processing)
// ==========================================
export async function processOneGap(): Promise<boolean> {
  await cleanStaleQueueItems();
  await checkQueueAlerts();

  const state = await getStatus();
  const maxAttempts = (state as any).maxAttempts || 3;
  const backoffMultiplier = parseFloat((state as any).backoffMultiplier || '1.5');
  const baseDelayMs = (state as any).baseDelayMs || 5000;

  const queueItem = await db.claimNextPendingQueueItem(`worker-${process.pid}`);
  if (!queueItem) {
    console.log('No pending gaps in queue.');
    return false;
  }

  broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'processing' } });

  const gap = await db.getGapById(queueItem.gapId);
  if (!gap) {
    await db.updateQueueItem(queueItem.id, {
      status: 'failed',
      lastError: 'Associated gap not found in database.',
      nextRetryAt: null,
    });
    return false;
  }

  await db.updateGapStatus(gap.id, 'processing');

  try {
    const classification = await retryWithExponentialBackoff(
      () => classifyGap(gap),
      maxAttempts,
      baseDelayMs,
      backoffMultiplier
    );

    await db.createAuditLog({
      gapId: gap.id,
      decision: classification.classification,
      reasoning: classification.reasoning,
      explanation: classification.explanation,
      banRisk: classification.banRisk,
    });

    if (classification.classification === 'safe') {
      const limitCheck = await db.canCreateDeployment();
      if (!limitCheck.allowed) {
        await db.updateGapStatus(gap.id, 'gray');
        await db.updateQueueItem(queueItem.id, { status: 'paused', lastError: limitCheck.reason, nextRetryAt: null });
        broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'paused' } });
        return true;
      }

      const adminUserId = await db.getAdminUserId();
      const plan = await retryWithExponentialBackoff(
        () => generateBusinessPlan(gap),
        maxAttempts,
        baseDelayMs,
        backoffMultiplier
      );

      await db.createDeployment({
        gapId: gap.id,
        userId: adminUserId,
        businessPlan: plan,
        banRisk: classification.banRisk,
        health: 'healthy',
      });

      // Fetch the deployment to get its ID for the broadcast
      const deployment = await db.getDeploymentByGapId(gap.id);

      // Enqueue the deployment step so the app is generated, tested and
      // deployed automatically (same fix as the worker-pool path).
      await db.enqueueDeploymentQueueItem(gap.id);

      await db.updateGapStatus(gap.id, 'deployed');
      await db.updateQueueItem(queueItem.id, { status: 'completed', nextRetryAt: null });

      broadcastEvent({ type: 'deployment:created', data: { deploymentId: deployment?.id || gap.id, gapId: gap.id } });
      broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'completed' } });

      const currentState = await getStatus();
      await db.updateCoreLoopState({
        totalDeploymentsCreated: currentState.totalDeploymentsCreated + 1,
      });

    } else if (classification.classification === 'unsafe') {
      await db.updateGapStatus(gap.id, 'unsafe');
      await db.updateQueueItem(queueItem.id, { status: 'failed', lastError: 'Violates safe policy guidelines.', nextRetryAt: null });
      broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'failed' } });
    } else if (classification.classification === 'gray') {
      await db.updateGapStatus(gap.id, 'gray');
      await db.updateQueueItem(queueItem.id, { status: 'paused', lastError: 'Requires manual admin oversight.', nextRetryAt: null });
      broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'paused' } });
    } else {
      await db.updateGapStatus(gap.id, 'false');
      await db.updateQueueItem(queueItem.id, { status: 'failed', lastError: 'Identified as not a real gap opportunity.', nextRetryAt: null });
      broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'failed' } });
    }

    const currentState = await getStatus();
    await db.updateCoreLoopState({
      totalGapsProcessed: currentState.totalGapsProcessed + 1,
    });

    return true;
  } catch (error) {
    console.error('[Orchestrator] Error processing gap:', error);
    const state = await getStatus();
    const maxAttempts = (state as any).maxAttempts || 3;

    if (queueItem.attempts >= maxAttempts) {
      await db.updateQueueItem(queueItem.id, {
        status: 'failed',
        lastError: error instanceof Error ? error.message : String(error),
        nextRetryAt: null,
      });
      broadcastEvent({ type: 'queue:updated', data: { queueItemId: queueItem.id, status: 'failed' } });
    } else {
      const backoffMultiplier = Math.max(
        1,
        Number((state as any).backoffMultiplier) || 1.5
      );

      const baseDelayMs = Math.max(
        1000,
        Number((state as any).baseDelayMs) || 5000
      );

      const retryDelayMs = Math.round(
        baseDelayMs *
        Math.pow(backoffMultiplier, Math.max(0, queueItem.attempts - 1))
      );

      const nextRetryAt = new Date(Date.now() + retryDelayMs);

      await db.updateQueueItem(queueItem.id, {
        status: 'pending',
        nextRetryAt,
      });

      broadcastEvent({
        type: 'queue:updated',
        data: {
          queueItemId: queueItem.id,
          status: 'pending',
          nextRetryAt: nextRetryAt.toISOString(),
        }
      });
    }

    return false;
  }
}

// ==========================================
// CORE LOOP — Start / Stop
// ==========================================
// ==========================================
// AUTO-DISCOVERY — Search-based gap detection
// Replaces WooCommerce/Odoo adapters. Uses Google Search + Groq LLM.
// ==========================================
async function queueGaps(gaps: DetectedGap[]): Promise<number> {
  console.log(`[Auto-Discovery] 📥 queueGaps called with ${gaps.length} candidate gaps`);
  let queued = 0;
  let skippedDuplicate = 0;
  let failedInsert = 0;
  
  for (const g of gaps) {
    const concatenated = [g.knows, g.needs, g.controlsAccess, g.underestimatesValue, g.source]
      .map((part) => String(part || '').toLowerCase().replace(/\s+/g, ' ').trim())
      .join('|');
    const dedupHash = crypto.createHash('sha256').update(concatenated).digest('hex');

    // Deduplicate — skip if gap already exists
    try {
      const existing = await db.getGapByHash(dedupHash);
      if (existing) {
        skippedDuplicate++;
        continue;
      }

      const gap = await db.createGap({
        knows: g.knows,
        needs: g.needs,
        controlsAccess: g.controlsAccess,
        underestimatesValue: g.underestimatesValue,
        source: g.source || 'tavily_search',
        priority: g.priority || 5,
        dedupHash,
        status: 'pending',
      });

      if (gap) {
        await db.createQueueItem({
          gapId: gap.id,
          dedupHash,
          priority: g.priority || 5,
          sortOrder: 0,
        });
        queued++;
      } else {
        failedInsert++;
      }
    } catch (error: any) {
      console.error(`[Auto-Discovery] ❌ Failed to insert gap: ${error?.message || error}`);
      failedInsert++;
    }
  }
  
  console.log(`[Auto-Discovery] 📊 queueGaps result: ${queued} inserted, ${skippedDuplicate} duplicates skipped, ${failedInsert} failed`);
  return queued;
}

async function runCoreLoopTick(): Promise<void> {
  if (coreLoopTickRunning) {
    console.warn('[Core Loop] Tick already running — skipping overlapping tick.');
    return;
  }

  coreLoopTickRunning = true;

  try {
    const tickStart = Date.now();
    console.log('[Core Loop] 🚀 Tick started — Auto-discovering gaps + processing queue...');
    
    const currentState = await getStatus();
    console.log(`[Core Loop] Current state: isRunning=${currentState.isRunning}, intervalMs=${currentState.intervalMs}, concurrency=${(currentState as any).concurrency || 1}`);

    // Auto-discover new gaps via Tavily Search + LLM
    console.log('[Core Loop] 📡 Starting gap discovery phase...');
    try {
      const [ecommerceGaps, operationalGaps] = await Promise.all([
        detectEcommerceGaps(),
        detectOperationalGaps(),
      ]);

      const allGaps = [...ecommerceGaps, ...operationalGaps];
      console.log(`[Core Loop] 🔬 Discovery complete: ${ecommerceGaps.length} e-commerce + ${operationalGaps.length} operational = ${allGaps.length} total candidate gaps`);

      if (allGaps.length > 0) {
        const queued = await queueGaps(allGaps);
        console.log(`[Core Loop] 📦 Queued ${queued} new gaps into database`);
      } else {
        console.log('[Core Loop] ⚠️ No gaps discovered in this tick');
      }
    } catch (error) {
      console.error('[Core Loop] ❌ Auto-discovery failed:', error);
    }

    console.log('[Core Loop] 🔧 Starting queue processing phase...');
    await processWithWorkerPool();

    const endState = await getStatus();

    if (!endState.isRunning) {
      console.log('[Core Loop] 🛑 Core loop was stopped during tick — not rescheduling.');
      return;
    }

    const now = new Date();
    const nextExecutionAt = new Date(
      now.getTime() + endState.intervalMs
    );

    await db.updateCoreLoopState({
      lastExecutedAt: now,
      nextExecutionAt,
    });

    const tickDuration = Date.now() - tickStart;
    console.log(`[Core Loop] ✅ Tick completed in ${tickDuration}ms. Next tick at ${nextExecutionAt.toISOString()}`);

    broadcastEvent({
      type: 'coreloop:status',
      data: {
        isRunning: true,
        lastExecutedAt: now.toISOString(),
        nextExecutionAt: nextExecutionAt.toISOString(),
      }
    });

    scheduleCoreLoopTick(endState.intervalMs);
  } finally {
    coreLoopTickRunning = false;
  }
}

function scheduleCoreLoopTick(intervalMs: number): void {
  if (loopInterval) {
    clearTimeout(loopInterval);
    loopInterval = null;
  }

  loopInterval = setTimeout(() => {
    runCoreLoopTick().catch(async (error) => {
      console.error('[Core Loop] Tick failed:', error);
      // If the tick crashed before rescheduling itself, recover by scheduling
      // the next tick. This prevents the loop from dying silently.
      try {
        const state = await getStatus();
        if (state.isRunning) {
          console.log('[Core Loop] Recovering from tick crash — rescheduling next tick.');
          scheduleCoreLoopTick(state.intervalMs);
        }
      } catch (stateErr) {
        console.error('[Core Loop] Could not recover loop state after crash:', stateErr);
      }
    });
  }, intervalMs);
}

export async function startCoreLoop() {
  const state = await getStatus();
  const wasPersistedRunning = Boolean(state.isRunning);

  const recovered = await db.recoverStaleProcessingQueueItems(30);

  if (recovered > 0) {
    console.log(
      `[Core Loop] Recovered ${recovered} stale processing queue item(s) before starting.`
    );
  }

  if (loopInterval) {
    clearTimeout(loopInterval);
    loopInterval = null;
  }

  const now = new Date();
  const nextExecutionAt = new Date(now.getTime() + state.intervalMs);

  if (wasPersistedRunning) {
    console.log(
      '[Core Loop] Persisted running state detected after process restart. Resuming Core Loop.'
    );
  }

  await db.updateCoreLoopState({
    isRunning: true,
    nextExecutionAt,
  });

  broadcastEvent({
    type: 'coreloop:status',
    data: {
      isRunning: true,
      lastExecutedAt: state.lastExecutedAt
        ? new Date(state.lastExecutedAt).toISOString()
        : null,
      nextExecutionAt: nextExecutionAt.toISOString(),
    }
  });

  console.log(`Starting SAO Core Loop. Interval: ${state.intervalMs}ms, Concurrency: ${state.concurrency || 1}`);

  scheduleCoreLoopTick(state.intervalMs);
}

export async function updateCoreLoopInterval(intervalMs: number): Promise<void> {
  await db.updateCoreLoopState({ intervalMs });

  const state = await getStatus();

  if (!state.isRunning) {
    return;
  }

  const now = new Date();
  const nextExecutionAt = new Date(now.getTime() + intervalMs);

  await db.updateCoreLoopState({
    nextExecutionAt,
  });

  scheduleCoreLoopTick(intervalMs);

  broadcastEvent({
    type: 'coreloop:status',
    data: {
      isRunning: true,
      lastExecutedAt: state.lastExecutedAt
        ? new Date(state.lastExecutedAt).toISOString()
        : null,
      nextExecutionAt: nextExecutionAt.toISOString(),
    }
  });

  console.log(`[Core Loop] Interval updated to ${intervalMs}ms and timer rescheduled.`);
}

export async function stopCoreLoop(): Promise<void> {
  if (loopInterval) {
    clearTimeout(loopInterval);
    loopInterval = null;
  }

  const state = await getStatus();

  await db.updateCoreLoopState({
    isRunning: false,
    nextExecutionAt: null,
  });

  broadcastEvent({
    type: 'coreloop:status',
    data: {
      isRunning: false,
      lastExecutedAt: state.lastExecutedAt
        ? new Date(state.lastExecutedAt).toISOString()
        : null,
      nextExecutionAt: null,
    }
  });

  console.log('SAO Core Loop stopped.');
}

// ==========================================
// CONCURRENCY CONTROL
// ==========================================
export async function setConcurrency(level: number): Promise<void> {
  const clamped = Math.max(1, Math.min(10, level));
  await db.updateCoreLoopState({ concurrency: clamped });
  console.log(`[Worker Pool] Concurrency set to ${clamped}`);
}

export function getWorkerStatus() {
  return {
    totalWorkers: workers.size,
    activeWorkers: getActiveWorkers(),
    totalProcessed: totalProcessedByWorkers,
    workers: Array.from(workers.values()).map(w => ({
      id: w.id,
      busy: w.busy,
      currentItem: w.currentItem,
    })),
  };
}
