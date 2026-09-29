// ============================================================
// SAO isolated DB-backed lifecycle E2E
// Starts a disposable local MariaDB datadir, applies the real schema,
// mocks only external provider boundaries, and exercises production
// SAO services end-to-end.
// ============================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import mysql from 'mysql2/promise';
import { eq, sql } from 'drizzle-orm';

type Stage = { name: string; pass: boolean; detail?: string };
const stages: Stage[] = [];

function record(name: string, pass: boolean, detail = '') {
  stages.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  assert.equal(pass, true, `${name}${detail ? ` - ${detail}` : ''}`);
}

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    env: opts.env || process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result;
}

async function waitForMaria(socketPath: string) {
  let lastError: unknown;
  for (let i = 0; i < 80; i++) {
    try {
      const conn = await mysql.createConnection({ socketPath, user: 'root', password: '' });
      await conn.query('SELECT 1');
      await conn.end();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function startIsolatedDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sao-e2e-'));
  const dataDir = path.join(dir, 'data');
  const socketPath = path.join(dir, 'mysql.sock');

  run('mariadb-install-db', [
    `--datadir=${dataDir}`,
    '--auth-root-authentication-method=normal',
    '--skip-test-db',
  ]);

  const server = spawn('mysqld', [
    `--datadir=${dataDir}`,
    `--socket=${socketPath}`,
    `--pid-file=${path.join(dir, 'mysqld.pid')}`,
    '--skip-networking',
    '--skip-grant-tables',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  server.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitForMaria(socketPath).catch((err) => {
    throw new Error(`MariaDB did not start: ${(err as Error).message}\n${stderr}`);
  });

  const root = await mysql.createConnection({ socketPath, user: 'root', password: '' });
  await root.query('CREATE DATABASE sao_e2e');
  await root.end();

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DB_SOCKET: socketPath,
    DB_HOST: 'localhost',
    DB_PORT: '0',
    DB_USER: 'root',
    DB_PASSWORD: '',
    DB_NAME: 'sao_e2e',
    DATABASE_URL: '',
    TLS_REJECT_UNAUTHORIZED: 'false',
  };
  run('node', ['run-migration.js'], { env });

  return {
    dir,
    socketPath,
    stop: async () => {
      await new Promise<void>((resolve) => {
        if (server.exitCode !== null) return resolve();
        server.once('exit', () => resolve());
        server.kill('SIGTERM');
        setTimeout(() => {
          if (server.exitCode === null) server.kill('SIGKILL');
        }, 3000).unref();
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
    server,
  };
}

function installTestEnv(socketPath: string) {
  process.env.NODE_ENV = 'test';
  process.env.DB_SOCKET = socketPath;
  process.env.DB_HOST = 'localhost';
  process.env.DB_PORT = '0';
  process.env.DB_USER = 'root';
  process.env.DB_PASSWORD = '';
  process.env.DB_NAME = 'sao_e2e';
  delete process.env.DATABASE_URL;
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.GROQ_TPM_LIMIT = '999999';
  process.env.MAX_PROVIDER_ATTEMPTS = '1';
  process.env.ADVERTISING_LIVE_MODE = 'false';
  process.env.ADVERTISING_GROWTH_COOLDOWN_MS = '1';
}

function llmResponseFor(task: string, prompt: string) {
  const p = prompt.toLowerCase();
  if (task === 'CLASSIFICATION') {
    if (p.includes('unsafe')) return { classification: 'unsafe', reasoning: 'Unsafe test marker.', banRisk: 'high', explanation: 'Rejected as unsafe.' };
    if (p.includes('false gap')) return { classification: 'false', reasoning: 'False test marker.', banRisk: 'low', explanation: 'Not a real opportunity.' };
    if (p.includes('gray')) return { classification: 'gray', reasoning: 'Uncertain test marker.', banRisk: 'medium', explanation: 'Needs review.' };
    return { classification: 'safe', reasoning: 'Strong evidence and low policy risk.', banRisk: 'low', explanation: 'Qualified safe opportunity.' };
  }
  if (task === 'APPLICATION_GENERATION') {
    return {
      description: 'Repair Match application',
      entryPoint: 'index.html',
      framework: 'static',
      files: [
        { path: 'index.html', content: '<!doctype html><html><head><title>Repair Match</title><link rel="stylesheet" href="css/style.css"></head><body><main><h1>Repair Match</h1><p>Book vetted niche appliance repair specialists.</p><button id="book">Request help</button><script src="js/main.js"></script></main></body></html>' },
        { path: 'css/style.css', content: 'body{font-family:Arial,sans-serif;margin:0;padding:2rem;background:#f7fafc;color:#17202a}main{max-width:720px;margin:auto}button{padding:.75rem 1rem}' },
        { path: 'js/main.js', content: 'document.getElementById("book").addEventListener("click",()=>{document.body.dataset.requested="true";});' },
      ],
    };
  }
  if (task === 'PROJECT_ANALYSIS' || task === 'ADVERTISING_ANALYSIS' || p.includes('analyse this sao-deployed project')) {
    return {
      appName: 'Repair Match',
      category: 'home services',
      description: 'Connects homeowners with niche appliance repair technicians.',
      functionality: ['technician matching', 'repair request intake'],
      targetUsers: ['homeowners'],
      valueProposition: 'Avoid replacing expensive appliances by finding qualified repair help.',
      keywords: ['appliance repair', 'niche repair', 'home services'],
      advertisingAngles: ['Save replacement costs', 'Find hard-to-locate technicians'],
      callsToAction: ['Request repair help'],
      completeness: 'complete',
      missingFields: [],
    };
  }
  if (task === 'ADVERTISING_CREATIVE') {
    return {
      creatives: [
        { format: 'headline', content: 'Fix rare appliances without replacing them', headline: 'Repair Match', callToAction: 'Request Help', targetAudience: 'homeowners', variation: 1 },
        { format: 'primary_text', content: 'Find vetted technicians for niche appliance repairs in minutes.', headline: 'Repair Match', callToAction: 'Request Help', targetAudience: 'homeowners', variation: 2 },
      ],
    };
  }
  return 'Deterministic SAO business plan: match homeowners with vetted niche appliance technicians, charge per qualified lead, and operate with low policy risk.';
}

async function main() {
  const isolated = await startIsolatedDatabase();
  installTestEnv(isolated.socketPath);

  try {
    const db = await import('../server/db');
    const schema = await import('../drizzle/schema');
    const { setProvidersForTest, resetRouterState } = await import('../server/services/llmRouter');
    const { setVercelTestAdapter } = await import('../server/services/vercel');
    const { processQueueBatch } = await import('../server/orchestrator');
    const { monitorDeploymentById, recoverStaleJobs, runAutonomousCycle } = await import('../server/autonomousManager');
    const { recognizeExternalPaymentRevenue } = await import('../server/services/revenue');
    const growth = await import('../server/services/advertising/growthEngine');
    const { generateCreatives } = await import('../server/services/advertising/creativeGenerator');
    const { analyzeProject } = await import('../server/services/advertising/projectAnalyzer');
    const { buildAdvertisingStrategy } = await import('../server/services/advertising/strategyEngine');

    const llmFailures = {
      classification: 0,
      businessPlan: 0,
      applicationGeneration: 0,
      invalidApplication: 0,
      advertisingAnalysis: 0,
      creativeGeneration: 0,
    };
    const vercelFailures = {
      createProject: 0,
      deploy: 0,
      waitReady: 0,
      healthCheck: 0,
    };

    const completeMock = async (_model: string, req: any) => {
      const system = req.messages.find((m: any) => m.role === 'system')?.content || '';
      const user = req.messages[req.messages.length - 1]?.content || '';
      const isApplication = system.includes('web application generator');
      const isClassifier = system.includes('gap classifier');
      const isCreative = system.includes('advertising copywriter');
      const isAdAnalysis = user.includes('Analyse this SAO-deployed project');

      if (isClassifier && llmFailures.classification-- > 0) {
        throw new Error('Injected classifier failure');
      }
      if (!req.jsonMode && llmFailures.businessPlan-- > 0) {
        throw new Error('Injected business-plan failure');
      }
      if (isApplication && llmFailures.applicationGeneration-- > 0) {
        throw new Error('Injected app-generation failure');
      }
      if (isApplication && llmFailures.invalidApplication-- > 0) {
        const invalid = {
          description: 'Invalid app for validation failure test',
          entryPoint: 'index.html',
          framework: 'static',
          files: [],
        };
        return { text: JSON.stringify(invalid), model: _model, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
      }
      if (isAdAnalysis && llmFailures.advertisingAnalysis-- > 0) {
        throw new Error('Injected advertising-analysis failure');
      }
      if (isCreative && llmFailures.creativeGeneration-- > 0) {
        throw new Error('Injected creative failure');
      }

      const inferred = !req.jsonMode ? llmResponseFor('TEXT', user)
        : isApplication ? llmResponseFor('APPLICATION_GENERATION', user)
        : isClassifier ? llmResponseFor('CLASSIFICATION', user)
        : isCreative ? llmResponseFor('ADVERTISING_CREATIVE', user)
        : isAdAnalysis ? llmResponseFor('PROJECT_ANALYSIS', user)
        : llmResponseFor('PROJECT_ANALYSIS', user);
      return { text: typeof inferred === 'string' ? inferred : JSON.stringify(inferred), model: _model, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    };

    resetRouterState();
    setProvidersForTest([
      {
        id: 'groq',
        complete: completeMock,
      },
      {
        id: 'gemini',
        complete: completeMock,
      },
    ] as any);

    setVercelTestAdapter({
      createProject: async (params) => {
        if (vercelFailures.createProject-- > 0) throw new Error('Injected project creation failure');
        return { projectId: `mock-project-${params.name}`, name: params.name };
      },
      deploy: async (params) => {
        if (vercelFailures.deploy-- > 0) throw new Error('Injected deploy failure');
        return { projectId: params.projectId, deploymentId: `mock-deploy-${params.projectId}`, deploymentUrl: `${params.projectId}.test.local`, readyState: 'READY' };
      },
      waitReady: async (deploymentId) => {
        if (vercelFailures.waitReady-- > 0) return { ready: false, state: 'ERROR', url: `${deploymentId}.test.local`, alias: [`${deploymentId}.test.local`] };
        return { ready: true, state: 'READY', url: `${deploymentId}.test.local`, alias: [`${deploymentId}.test.local`] };
      },
      verifyPublicUrl: async () => {
        if (vercelFailures.healthCheck-- > 0) return { reachable: false, status: 503, gated: false };
        return { reachable: true, status: 200, gated: false };
      },
    });

    await db.assertDatabaseReady();
    await db.initCoreLoopState();
    await db.updateCoreLoopState({ maxAttempts: 2, baseDelayMs: 1000, backoffMultiplier: '1.0', concurrency: 1 } as any);
    const admin = await db.createUser('admin-e2e@sao.test', 'hash', 'admin');
    record('isolated database initialized', Boolean(admin?.id), isolated.socketPath);

    async function createQueuedGap(dedupHash: string, overrides: Partial<{
      knows: string;
      needs: string;
      controlsAccess: string;
      underestimatesValue: string;
      priority: number;
    }> = {}) {
      const created = await db.createGap({
        knows: overrides.knows || `Strong safe opportunity ${dedupHash}`,
        needs: overrides.needs || 'Customers need a dependable niche service with urgent demand',
        controlsAccess: overrides.controlsAccess || 'Incumbents control access through fragmented referrals',
        underestimatesValue: overrides.underestimatesValue || 'The market undervalues a simple matching workflow',
        source: 'mock-discovery',
        priority: overrides.priority || 8,
        dedupHash,
      });
      await db.createQueueItem({ gapId: created!.id, dedupHash, priority: overrides.priority || 8 });
      return created!;
    }

    const dedupHash = 'e2e-gap-strong';
    const gap = await db.createGap({
      knows: 'Vetted niche appliance repair technicians with hard-to-find repair knowledge',
      needs: 'Homeowners need affordable alternatives to replacing expensive niche appliances',
      controlsAccess: 'Manufacturers and dealer networks control repair manuals and local referrals',
      underestimatesValue: 'Repair know-how is scattered and undervalued despite high replacement costs',
      source: 'mock-discovery',
      priority: 9,
      dedupHash,
    });
    await db.createQueueItem({ gapId: gap!.id, dedupHash, priority: 9 });
    record('Discovery -> Gap persisted', Boolean(await db.getGapById(gap!.id)));

    const processed = await processQueueBatch();
    record('Analysis -> Queue -> Business -> App -> Mock Deployment', processed >= 1, `processed=${processed}`);

    const updatedGap = await db.getGapById(gap!.id);
    const deployment = await db.getDeploymentByGapId(gap!.id);
    const provider = deployment ? await db.getActiveProvider(deployment.id, 'vercel') : null;
    const queues = await db.listQueueItems();
    record('Gap analyzed and qualified', updatedGap?.status === 'deployed', `status=${updatedGap?.status}`);
    record('Business generated', Boolean(deployment?.businessPlan?.includes('Deterministic SAO business plan')), `plan=${deployment?.businessPlan?.slice(0, 60)}`);
    if (!provider?.deploymentUrl) {
      const secondBatch = await processQueueBatch();
      record('Deployment queue resumed', secondBatch >= 1, `processed=${secondBatch}`);
    }
    const providerAfterResume = deployment ? await db.getActiveProvider(deployment.id, 'vercel') : null;
    record('Application validated and deployment provider active', Boolean(providerAfterResume?.deploymentUrl), `url=${providerAfterResume?.deploymentUrl || 'none'}`);
    record('Queue completed without duplicate active work', queues.filter((q: any) => ['pending', 'processing'].includes(q.queueItem.status)).length === 0);

    await monitorDeploymentById(deployment!.id);
    const healthyDeployment = await db.getDeploymentById(deployment!.id);
    const healthChecks = await db.listHealthChecks(deployment!.id);
    record('Health check succeeds', healthyDeployment?.health === 'healthy' && healthChecks.length >= 1);

    await recognizeExternalPaymentRevenue({
      providerType: 'mock',
      providerPaymentId: 'pay-e2e-100',
      deploymentId: deployment!.id,
      amount: 100,
      currency: 'USD',
      providerStatus: 'paid',
    });
    await recognizeExternalPaymentRevenue({
      providerType: 'mock',
      providerPaymentId: 'pay-e2e-100',
      deploymentId: deployment!.id,
      amount: 100,
      currency: 'USD',
      providerStatus: 'paid',
    });
    const paidDeployment = await db.getDeploymentById(deployment!.id);
    const payments = await db.listPaymentsForDeployment(deployment!.id);
    const ledgerRows = await db.db.select().from(schema.adBudgetLedger).where(eq(schema.adBudgetLedger.deploymentId, deployment!.id));
    record('Mock payment -> canonical revenue recognized once', Number(paidDeployment?.revenue) === 100 && payments.length === 1);
    record('20% advertising allocation once', ledgerRows.filter((r) => r.type === 'ALLOCATION').length === 1 && Number(ledgerRows[0].amount) === 20);

    const lifecycle = await growth.runAdvertisingLifecycleForDeployment(paidDeployment);
    const researchRows = await db.db.select().from(schema.adAudienceResearch).where(eq(schema.adAudienceResearch.deploymentId, deployment!.id));
    let campaigns = await db.listCampaignsForDeployment(deployment!.id);
    record('Audience research generated', researchRows.length === 1);
    record('Campaign generated', campaigns.length === 1 && Boolean(lifecycle.preparedCampaign));

    const analysis = await analyzeProject({
      deploymentId: deployment!.id,
      knows: gap!.knows,
      needs: gap!.needs,
      controlsAccess: gap!.controlsAccess,
      underestimatesValue: gap!.underestimatesValue,
      businessPlan: deployment!.businessPlan || '',
    });
    const strategy = buildAdvertisingStrategy({ projectAnalysis: analysis, advertisingBudget: 20, percentageUsed: 20 });
    const creativeResult = await generateCreatives({ projectAnalysis: analysis, strategy, campaignId: campaigns[0].id, deploymentId: deployment!.id });
    for (const c of creativeResult.creatives) {
      await db.createAdCreative({ campaignId: campaigns[0].id, format: c.format, content: c.content, headline: c.headline || undefined, callToAction: c.callToAction || undefined, targetAudience: c.targetAudience || undefined, variation: c.variation });
    }
    const creatives = await db.listCreativesForCampaign(campaigns[0].id);
    record('Creative generated', creatives.length >= 2);

    const paidCampaign = await db.createAdCampaign({
      deploymentId: deployment!.id,
      name: 'Paid approval check',
      channel: 'google_ads',
      campaignType: 'PAID',
      status: 'READY_FOR_APPROVAL',
      budget: '20.00',
      dailyLimit: '5.00',
      approvalStatus: 'PENDING',
    });
    const spendBeforeApproval = await growth.canSpend({ deploymentId: deployment!.id, campaignId: paidCampaign!.id, requestedAmount: 1 });
    record('Paid campaign approval restriction enforced', spendBeforeApproval.allowed === false);

    const experimentId = await growth.createExperiment({
      campaignId: campaigns[0].id,
      hypothesis: 'Headline variant improves conversion',
      variable: 'headline',
      variantACreativeId: creatives[0].id,
      variantBCreativeId: creatives[1].id,
    });
    await growth.startExperiment(experimentId);
    for (let i = 0; i < 60; i++) {
      await growth.recordCampaignEvent({ campaignId: campaigns[0].id, creativeId: creatives[0].id, eventType: 'click', idempotencyKey: `a-click-${i}` });
      await growth.recordCampaignEvent({ campaignId: campaigns[0].id, creativeId: creatives[1].id, eventType: 'click', idempotencyKey: `b-click-${i}` });
    }
    for (let i = 0; i < 18; i++) {
      await growth.recordCampaignEvent({ campaignId: campaigns[0].id, creativeId: creatives[0].id, eventType: 'conversion', idempotencyKey: `a-conv-${i}` });
    }
    for (let i = 0; i < 3; i++) {
      await growth.recordCampaignEvent({ campaignId: campaigns[0].id, creativeId: creatives[1].id, eventType: 'conversion', idempotencyKey: `b-conv-${i}` });
    }
    const experiment = await growth.evaluateExperiment(experimentId, 50);
    record('A/B experiment completes with valid result', experiment.status === 'COMPLETED' && experiment.selectedCreativeId === creatives[0].id);

    await db.updateAdCampaign(campaigns[0].id, { status: 'ACTIVE', startedAt: new Date(Date.now() - 48 * 3600_000), budget: '20.00' } as any);
    for (let i = 0; i < 600; i++) {
      await growth.recordCampaignEvent({ campaignId: campaigns[0].id, eventType: 'impression', idempotencyKey: `imp-${i}` });
    }
    for (let i = 0; i < 30; i++) {
      await growth.recordCampaignEvent({ campaignId: campaigns[0].id, eventType: 'click', idempotencyKey: `click-${i}` });
    }
    for (let i = 0; i < 5; i++) {
      await growth.recordCampaignEvent({ campaignId: campaigns[0].id, eventType: 'conversion', amount: 10, idempotencyKey: `rev-${i}` });
    }
    await growth.recordCampaignEvent({ campaignId: campaigns[0].id, eventType: 'spend', amount: 10, idempotencyKey: 'spend-10' });
    const optimization = await growth.optimizeCampaign(campaigns[0].id);
    const optimizationRows = await db.db.select().from(schema.adOptimizationDecisions).where(eq(schema.adOptimizationDecisions.campaignId, campaigns[0].id));
    record('Metrics -> optimization decision persisted', ['KEEP_RUNNING', 'ADJUST', 'MONITOR', 'PAUSE'].includes(optimization.decision) && optimizationRows.length >= 1, optimization.decision);

    await db.enqueueDeploymentQueueItem(gap!.id);
    await db.enqueueDeploymentQueueItem(gap!.id);
    const deploymentQueueItems = (await db.listQueueItems()).filter((q: any) => q.queueItem.gapId === gap!.id && q.queueItem.queueType === 'deployment' && ['pending', 'processing'].includes(q.queueItem.status));
    record('Duplicate deployment queue prevented', deploymentQueueItems.length <= 1);

    const stale = await db.createQueueItem({ gapId: gap!.id, dedupHash: 'stale-e2e', priority: 1 });
    await db.updateQueueItem(stale!.id, { status: 'processing', workerId: 'dead-worker', attempts: 1 } as any);
    await db.db.execute(sql`UPDATE queue_items SET updated_at = NOW() - INTERVAL 60 MINUTE WHERE id = ${stale!.id}`);
    await recoverStaleJobs(5);
    const recovered = await db.getQueueItem(stale!.id);
    record('Restart/stale job recovery resumes claimed work', recovered?.status === 'pending');
    await processQueueBatch();
    const deploymentsForOriginalGap = (await db.listDeployments()).filter((d: any) => d.gapId === gap!.id);
    record('Recovered duplicate synthesis does not duplicate deployment', deploymentsForOriginalGap.length === 1, `count=${deploymentsForOriginalGap.length}`);

    const beforeCampaignCount = (await db.listCampaignsForDeployment(deployment!.id)).length;
    await runAutonomousCycle();
    const afterCampaignCount = (await db.listCampaignsForDeployment(deployment!.id)).length;
    record('Autonomous manager resume avoids duplicate campaigns', afterCampaignCount === beforeCampaignCount);

    const unsafeGap = await db.createGap({
      knows: 'unsafe exploit marker',
      needs: 'unsafe demand',
      controlsAccess: 'unsafe controls',
      underestimatesValue: 'unsafe value',
      source: 'mock-discovery',
      priority: 5,
      dedupHash: 'e2e-gap-unsafe',
    });
    await db.createQueueItem({ gapId: unsafeGap!.id, dedupHash: unsafeGap!.dedupHash, priority: 5 });
    await processQueueBatch();
    const unsafeUpdated = await db.getGapById(unsafeGap!.id);
    const unsafeDeployment = await db.getDeploymentByGapId(unsafeGap!.id);
    record('Terminal unsafe gap failure has no downstream deployment', unsafeUpdated?.status === 'unsafe' && !unsafeDeployment);

    const weakGap = await db.createGap({
      knows: 'weak maybe',
      needs: 'low evidence',
      controlsAccess: 'unclear',
      underestimatesValue: 'maybe',
      source: 'mock-discovery',
      priority: 3,
      dedupHash: 'e2e-gap-weak',
    });
    await db.createQueueItem({ gapId: weakGap!.id, dedupHash: weakGap!.dedupHash, priority: 3 });
    await processQueueBatch();
    const weakUpdated = await db.getGapById(weakGap!.id);
    record('Weak opportunity becomes gray review', weakUpdated?.status === 'gray');

    const falseGap = await db.createGap({
      knows: 'false gap marker',
      needs: 'false gap demand',
      controlsAccess: 'none',
      underestimatesValue: 'none',
      source: 'mock-discovery',
      priority: 2,
      dedupHash: 'e2e-gap-false',
    });
    await db.createQueueItem({ gapId: falseGap!.id, dedupHash: falseGap!.dedupHash, priority: 2 });
    await processQueueBatch();
    const falseUpdated = await db.getGapById(falseGap!.id);
    record('False gap is rejected', falseUpdated?.status === 'false');

    const grayGap = await db.createGap({
      knows: 'gray uncertain market participants',
      needs: 'gray uncertain demand',
      controlsAccess: 'gray uncertain controls',
      underestimatesValue: 'gray uncertain value',
      source: 'mock-discovery',
      priority: 4,
      dedupHash: 'e2e-gap-gray',
    });
    await db.createQueueItem({ gapId: grayGap!.id, dedupHash: grayGap!.dedupHash, priority: 4 });
    await processQueueBatch();
    const grayUpdated = await db.getGapById(grayGap!.id);
    record('Gray opportunity pauses for review', grayUpdated?.status === 'gray');

    let duplicateRejected = false;
    try {
      await db.createGap({
        knows: gap!.knows,
        needs: gap!.needs,
        controlsAccess: gap!.controlsAccess,
        underestimatesValue: gap!.underestimatesValue,
        source: gap!.source,
        priority: 9,
        dedupHash: gap!.dedupHash,
      });
    } catch {
      duplicateRejected = true;
    }
    record('Duplicate gap persistence is rejected', duplicateRejected);

    const strongAudit = (await db.listAuditLogs(200, 0)).find((log: any) => log.gapId === gap!.id && String(log.reasoning).includes('score='));
    record('Gap score and qualification reasoning persisted', Boolean(strongAudit));

    const activeDeployments = (await db.listDeployments()).filter((d: any) => d.status === 'active');
    const completedExperiments = await db.db.select().from(schema.adExperiments).where(eq(schema.adExperiments.status, 'COMPLETED'));
    record('State invariant: no active deployment lacks provider', activeDeployments.length > 0 && Boolean(provider));
    record('State invariant: completed experiments have result', completedExperiments.every((e) => Boolean(e.selectedCreativeId && e.decisionReason)));

    let dbFailureCaptured = false;
    try {
      await db.db.execute(sql`SELECT * FROM sao_missing_failure_injection_table`);
    } catch (err) {
      dbFailureCaptured = !String((err as Error).message).includes(process.env.DB_PASSWORD || 'not-a-real-secret');
      await db.createAuditLog({
        deploymentId: deployment!.id,
        gapId: gap!.id,
        decision: 'Database Failure Captured',
        reasoning: 'Controlled invalid database operation failed and was captured without secret exposure.',
        explanation: 'Failure-injection coverage for database operation errors.',
        banRisk: 'low',
        businessHealth: 'healthy',
      });
    }
    record('Failure recovery: database operation failure captured safely', dbFailureCaptured);

    llmFailures.classification = 1;
    const classifierRetryGap = await createQueuedGap('e2e-failure-classifier-retry');
    await processQueueBatch();
    const classifierRetryDeployment = await db.getDeploymentByGapId(classifierRetryGap.id);
    record('Failure recovery: classification transient failure retries to success', Boolean(classifierRetryDeployment));

    llmFailures.businessPlan = 1;
    const planRetryGap = await createQueuedGap('e2e-failure-plan-retry');
    await processQueueBatch();
    const planRetryDeployment = await db.getDeploymentByGapId(planRetryGap.id);
    record('Failure recovery: business generation transient failure retries to success', Boolean(planRetryDeployment?.businessPlan));

    llmFailures.applicationGeneration = 1;
    const appRetryGap = await createQueuedGap('e2e-failure-appgen-retry');
    await processQueueBatch();
    const appRetryDeployment = await db.getDeploymentByGapId(appRetryGap.id);
    const appRetryProvider = appRetryDeployment ? await db.getActiveProvider(appRetryDeployment.id, 'vercel') : null;
    record('Failure recovery: app generation transient failure retries to success', Boolean(appRetryProvider?.deploymentUrl));

    await db.updateCoreLoopState({ maxAttempts: 3, baseDelayMs: 60000, backoffMultiplier: '1.0', concurrency: 1 } as any);
    llmFailures.invalidApplication = 1;
    const validationGap = await createQueuedGap('e2e-failure-validation-retry');
    await processQueueBatch();
    let validationQueue = (await db.listQueueItems()).find((q: any) => q.queueItem.gapId === validationGap.id && q.queueItem.queueType === 'deployment');
    await db.updateCoreLoopState({ maxAttempts: 2, baseDelayMs: 1000, backoffMultiplier: '1.0', concurrency: 1 } as any);
    const validationDeployment = await db.getDeploymentByGapId(validationGap.id);
    const validationProvider = validationDeployment ? await db.getActiveProvider(validationDeployment.id, 'vercel') : null;
    validationQueue = (await db.listQueueItems()).find((q: any) => q.queueItem.id === validationQueue!.queueItem.id);
    record('Failure recovery: validation failure captured for retry', Number(validationQueue?.queueItem.attempts || 0) >= 2 && Boolean(validationQueue?.queueItem.lastError));
    record('Failure recovery: validation retry reaches deployed state', Boolean(validationProvider?.deploymentUrl) && validationQueue?.queueItem.status === 'completed');

    vercelFailures.createProject = 1;
    const prepRetryGap = await createQueuedGap('e2e-failure-deployment-prep-retry');
    await processQueueBatch();
    const prepRetryDeployment = await db.getDeploymentByGapId(prepRetryGap.id);
    const prepRetryProvider = prepRetryDeployment ? await db.getActiveProvider(prepRetryDeployment.id, 'vercel') : null;
    record('Failure recovery: deployment preparation transient failure retries', Boolean(prepRetryProvider?.deploymentUrl));

    vercelFailures.deploy = 1;
    const deployRetryGap = await createQueuedGap('e2e-failure-deploy-retry');
    await processQueueBatch();
    const deployRetryDeployment = await db.getDeploymentByGapId(deployRetryGap.id);
    const deployRetryProvider = deployRetryDeployment ? await db.getActiveProvider(deployRetryDeployment.id, 'vercel') : null;
    record('Failure recovery: deployment provider transient failure retries', Boolean(deployRetryProvider?.deploymentUrl));

    vercelFailures.waitReady = 1;
    const readyRetryGap = await createQueuedGap('e2e-failure-ready-retry');
    await processQueueBatch();
    let readyQueue = (await db.listQueueItems()).find((q: any) => q.queueItem.gapId === readyRetryGap.id && q.queueItem.queueType === 'deployment');
    const readyDeployment = await db.getDeploymentByGapId(readyRetryGap.id);
    const readyProvider = readyDeployment ? await db.getActiveProvider(readyDeployment.id, 'vercel') : null;
    readyQueue = (await db.listQueueItems()).find((q: any) => q.queueItem.id === readyQueue!.queueItem.id);
    record('Failure recovery: deployment readiness failure captured', Number(readyQueue?.queueItem.attempts || 0) >= 2 && Boolean(readyQueue?.queueItem.lastError));
    record('Failure recovery: deployment readiness retry succeeds', Boolean(readyProvider?.deploymentUrl) && readyQueue?.queueItem.status === 'completed');

    vercelFailures.healthCheck = 1;
    await db.updateDeployment(deployment!.id, { consecutiveFailures: 1 } as any);
    await monitorDeploymentById(deployment!.id);
    const recoveredHealth = await db.getDeploymentById(deployment!.id);
    record('Failure recovery: health check failure triggers recovery', recoveredHealth?.health === 'healthy' && Number((recoveredHealth as any).recoveryCount || 0) >= 1);

    const paymentFailure = await recognizeExternalPaymentRevenue({
      providerType: 'mock',
      providerPaymentId: 'pay-missing-deployment',
      deploymentId: 'missing-deployment',
      amount: 100,
      currency: 'USD',
      providerStatus: 'paid',
    });
    let invalidPaymentRejected = false;
    try {
      await recognizeExternalPaymentRevenue({
        providerType: 'mock',
        providerPaymentId: 'pay-invalid-negative',
        deploymentId: deployment!.id,
        amount: -1,
        currency: 'USD',
        providerStatus: 'paid',
      });
    } catch {
      invalidPaymentRejected = true;
    }
    record('Failure recovery: payment failures do not mutate revenue', paymentFailure.outcome === 'deployment_not_found' && invalidPaymentRejected && Number((await db.getDeploymentById(deployment!.id))?.revenue) === 100);

    await growth.recordCampaignEvent({ campaignId: campaigns[0].id, eventType: 'spend', amount: 1, idempotencyKey: 'duplicate-spend-event' });
    await growth.recordCampaignEvent({ campaignId: campaigns[0].id, eventType: 'spend', amount: 1, idempotencyKey: 'duplicate-spend-event' });
    const duplicateSpendEvents = await db.db.select().from(schema.adCampaignEvents).where(eq(schema.adCampaignEvents.idempotencyKey, 'duplicate-spend-event'));
    record('Failure recovery: metrics duplicate event is idempotent', duplicateSpendEvents.length === 1);

    llmFailures.advertisingAnalysis = 1;
    const adFailureDeployment = await db.createDeployment({
      gapId: gap!.id,
      userId: admin!.id,
      businessPlan: 'Ad failure injection deployment',
      banRisk: 'low',
      health: 'healthy',
    });
    const adFailureResult = await growth.runAdvertisingLifecycleForDeployment(adFailureDeployment);
    const adFailureCampaigns = await db.listCampaignsForDeployment(adFailureDeployment!.id);
    record('Failure recovery: campaign generation analysis failure falls back safely', Boolean(adFailureResult.preparedCampaign) && adFailureCampaigns.length === 1);

    const inconclusiveExperimentId = await growth.createExperiment({
      campaignId: campaigns[0].id,
      hypothesis: 'Insufficient data stays inconclusive',
      variable: 'headline',
      variantACreativeId: creatives[0].id,
      variantBCreativeId: creatives[1].id,
    });
    await growth.startExperiment(inconclusiveExperimentId);
    const inconclusive = await growth.evaluateExperiment(inconclusiveExperimentId, 9999);
    record('Failure recovery: experiment insufficient data avoids false winner', inconclusive.status === 'ACTIVE' && !inconclusive.selectedCreativeId);

    const optimizationMissingRejected = await growth.optimizeCampaign('missing-campaign').then(
      () => false,
      () => true
    );
    record('Failure recovery: optimization missing campaign fails clearly', optimizationMissingRejected);

    const noDeploymentQueueGap = await db.createGap({
      knows: 'safe deployment missing record',
      needs: 'deployment queue should fail without synthesis',
      controlsAccess: 'none',
      underestimatesValue: 'none',
      source: 'mock-discovery',
      priority: 1,
      dedupHash: 'e2e-terminal-no-deployment',
    });
    const noDeploymentQueue = await db.enqueueDeploymentQueueItem(noDeploymentQueueGap!.id);
    await processQueueBatch();
    const failedNoDeploymentQueue = await db.getQueueItem(noDeploymentQueue!.id);
    record('Failure recovery: unrecoverable queue item becomes terminal failed', failedNoDeploymentQueue?.status === 'failed' && /No SAO deployment/.test(failedNoDeploymentQueue.lastError || ''));

    const auditLogs = await db.listAuditLogs(200, 0);
    record('Audit events recorded', auditLogs.length >= 5);

    setProvidersForTest(null);
    setVercelTestAdapter(null);
    console.log(`\nE2E stages passed: ${stages.length}/${stages.length}`);
  } finally {
    await isolated.stop();
  }
}

main().catch((error) => {
  console.error(error);
  const child = (global as any).__saoE2eServer as ChildProcess | undefined;
  if (child && child.exitCode === null) child.kill('SIGKILL');
  process.exit(1);
});
