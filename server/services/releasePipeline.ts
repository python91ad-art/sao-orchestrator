import crypto from 'node:crypto';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { firefox } from '@playwright/test';
import { db, generateId } from '../db';
import * as schema from '../../drizzle/schema';
import { GeneratedApplication, smokeTestApplication, validateGeneratedApplication } from './applicationGenerator';
import { activePolicy, enforcePolicy, PolicyEnforcementError, Principal, requirePolicyPermission } from './policyEngine';
import { auditOperation, emergencyStopped, runAgent, validApproval } from './execution';
import { acceptanceManifest, approvedSpecification, enforceSpecification, ensureApprovedSpecification } from './specificationGovernance';
import { addBuildArtifact, createBuildProject, createDefectReport, createQcJob, listBuildProjects, recordQcTestRun } from './infrastructure';
import { generateApplication } from './applicationGenerator';
import type { VercelDeployResult } from './vercel';
import { validatePolicy } from '../../shared/policyContracts';
import { gapPolicyAssessment } from './discoveryPolicy';

export function artifactHash(app: Pick<GeneratedApplication, 'files' | 'entryPoint'>) {
  return crypto.createHash('sha256').update(JSON.stringify({ entryPoint: app.entryPoint, files: [...app.files].sort((first, second) => first.path.localeCompare(second.path)) })).digest('hex');
}
export function qcBrowserEnvironment(environment: Record<string, string | undefined> = process.env) {
  return Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ', 'FONTCONFIG_PATH', 'XDG_CACHE_HOME'].filter(key => environment[key] !== undefined).map(key => [key, environment[key]!])) as Record<string, string>;
}
export async function reconcileExternalRelease(actor: Principal, releaseId: string, externalDeploymentId: string) {
  await requirePolicyPermission(actor, 'approvals.supervisor');
  const release = (await db.select().from(schema.releaseAuthorizations).where(eq(schema.releaseAuthorizations.id, releaseId)).limit(1))[0];
  if (!release || !['deploying', 'deployment_unknown'].includes(release.status)) throw new Error('Only an uncertain publication can be reconciled.');
  const { getVercelDeployment, readPublicDeploymentFiles } = await import('./vercel');
  const remote = await getVercelDeployment(externalDeploymentId);
  const evidence = JSON.parse(release.evidenceJson);
  if (!remote || remote.name !== `release-${release.id}` || !evidence.publicationProjectId || remote.projectId !== evidence.publicationProjectId || (remote.readyState || remote.state) !== 'READY') throw new Error('Provider did not verify this exact business release, project and READY deployment. No publication was retried.');
  const artifact = (await db.select().from(schema.buildArtifacts).where(eq(schema.buildArtifacts.id, release.artifactId)).limit(1))[0];
  const app = artifact?.metadataJson ? JSON.parse(artifact.metadataJson).app as GeneratedApplication : null;
  if (!app) throw new Error('Original independently verified artifact is unavailable.');
  const url = `https://${remote.url.replace(/^https:\/\//, '')}`;
  const files = await readPublicDeploymentFiles(url, app.files.map(file => file.path), externalDeploymentId);
  if (artifactHash({ ...app, files }) !== release.artifactHash) throw new Error('Provider artifact does not match the authorized release.');
  await db.update(schema.releaseAuthorizations).set({ status: 'deployment_submitted', evidenceJson: JSON.stringify({ ...evidence, reconciledBy: actor.id, submittedDeployment: { projectId: remote.projectId, deploymentId: externalDeploymentId, deploymentUrl: url, readyState: 'READY' } }) }).where(and(eq(schema.releaseAuthorizations.id, releaseId), inArray(schema.releaseAuthorizations.status, ['deploying', 'deployment_unknown'])));
  await auditOperation(actor.id, 'external_release_reconciled', releaseId, { externalDeploymentId, verifiedArtifactHash: release.artifactHash }, release.deploymentId);
  return { status: 'deployment_submitted', nextAction: 'Resume the existing deployment workflow; independent post-deployment QC still applies.' };
}
export async function testArtifact(app: GeneratedApplication, checks: unknown) {
  if (app.framework !== 'static') throw new Error('Unsupported artifact framework: no sandboxed backend or compiled framework runner is available.');
  const manifest = acceptanceManifest.parse(checks);
  const validation = validateGeneratedApplication(app);
  const smoke = smokeTestApplication(app);
  const errors: string[] = [];
  const externalRequests: string[] = [];
  const server = http.createServer((request, response) => {
    let requestedPath: string;
    try { requestedPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname).replace(/^\//, '') || app.entryPoint; } catch { response.writeHead(400).end(); return; }
    const file = app.files.find(candidate => candidate.path === requestedPath);
    if (!file) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', requestedPath.endsWith('.js') ? 'application/javascript' : requestedPath.endsWith('.css') ? 'text/css' : 'text/html');
    response.setHeader('Content-Security-Policy', "connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'");
    response.end(file.content);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser: Awaited<ReturnType<typeof firefox.launch>> | undefined;
  let latencyMs = 0;
  try {
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await firefox.launch({ headless: true, env: qcBrowserEnvironment(), firefoxUserPrefs: { 'media.peerconnection.enabled': false, 'network.prefetch-next': false, 'network.dns.disablePrefetch': true, 'network.http.speculative-parallel-limit': 0 } });
    const browserContext = await browser.newContext({ serviceWorkers: 'block' });
    await browserContext.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { externalRequests.push(new URL(route.request().url()).origin); return route.abort(); }
      return route.continue();
    });
    const page = await browserContext.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} loading artifact asset.`); });
    const started = performance.now();
    await page.goto(`${origin}/${app.entryPoint}`, { waitUntil: 'load', timeout: 30000 });
    latencyMs = performance.now() - started;
    for (const check of manifest) {
      const locator = page.locator(check.selector);
      try {
        if (check.operation === 'click') await locator.click({ timeout: 5000 });
        else if (check.operation === 'fill') await locator.fill(check.value || '', { timeout: 5000 });
        else if (check.operation === 'visible' && !await locator.isVisible()) errors.push(`Required element not visible: ${check.selector}`);
        else if (check.operation === 'text' && !(await locator.textContent({ timeout: 5000 }))?.includes(check.value || '')) errors.push(`Required text not found: ${check.selector}`);
        else if (check.operation === 'attribute' && await locator.getAttribute(check.attribute || '', { timeout: 5000 }) !== check.value) errors.push(`Required attribute mismatch: ${check.selector}`);
      } catch (error: any) { errors.push(`Acceptance check ${check.selector}: ${error.message.slice(0, 500)}`); }
    }
    await browserContext.close();
  } finally {
    if (browser) await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return { artifactHash: artifactHash(app), latencyMs, validation, smoke, errors, externalRequests, suites: { functional: errors.length ? 'failed' : 'passed', integration: smoke.passed && errors.length === 0 ? 'passed' : 'failed', security: validation.valid && externalRequests.length === 0 ? 'passed' : 'failed', performance: Number.isFinite(latencyMs) && latencyMs > 0 ? 'passed' : 'failed' } };
}
export async function authorizeRelease(deploymentId: string, app: GeneratedApplication, builderAgentId: string) {
  if (app.framework !== 'static') throw new PolicyEnforcementError('DENY', 'Unsupported artifact framework; cached releases cannot substitute for a missing sandboxed runner.');
  const spec = await ensureApprovedSpecification(deploymentId);
  await enforceSpecification(deploymentId, spec.version.id, builderAgentId);
  const policy = await activePolicy('quality', deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: quality.');
  const config = JSON.parse(policy.configJson);
  if (!config.mandatorySuites.every((suite: string) => ['functional', 'integration', 'security', 'performance'].includes(suite))) throw new Error('Configured QC suite is not supported by the static artifact runner.');
  let build = (await listBuildProjects({ deploymentId, limit: 1 }))[0];
  if (!build) {
    const id = await createBuildProject({ deploymentId, specificationId: spec.spec.id, projectType: 'static' });
    build = (await listBuildProjects({ deploymentId, limit: 1 }))[0];
    if (!id || !build) throw new Error('Build project creation failed.');
  }
  const hash = artifactHash(app);
  const prior = (await db.select().from(schema.releaseAuthorizations).where(and(eq(schema.releaseAuthorizations.deploymentId, deploymentId), eq(schema.releaseAuthorizations.artifactHash, hash), eq(schema.releaseAuthorizations.specificationVersionId, spec.version.id))).orderBy(desc(schema.releaseAuthorizations.createdAt)).limit(1))[0];
  if (prior && ['deploying', 'deployment_unknown'].includes(prior.status)) throw new PolicyEnforcementError('DENY', 'A prior publication has an uncertain provider outcome. Reconcile its external state before retrying; duplicate deployment was prevented.');
  if (prior && ['eligible', 'deployment_submitted'].includes(prior.status)) {
    const evidence = JSON.parse(prior.evidenceJson);
    return { id: prior.id, artifactId: prior.artifactId, hash, submittedDeployment: prior.status === 'deployment_submitted' ? evidence.submittedDeployment as VercelDeployResult : undefined };
  }
  const existing = (await db.select().from(schema.buildArtifacts).where(and(eq(schema.buildArtifacts.buildProjectId, build.id), eq(schema.buildArtifacts.contentHash, hash))).limit(1))[0];
  const artifactId = existing?.id || await addBuildArtifact({ buildProjectId: build.id, artifactType: 'static_application', name: `Artifact ${hash}`, metadata: { app, builderAgentId, specificationVersionId: spec.version.id } });
  await db.update(schema.buildArtifacts).set({ contentHash: hash }).where(eq(schema.buildArtifacts.id, artifactId));
  const qc = await runAgent('independent_qc', deploymentId, 'qc', `qc:${hash}:${spec.version.id}`, async identity => {
    if (identity.agentId === builderAgentId) throw new Error('Builder cannot independently QC its own artifact.');
    const jobId = await createQcJob({ buildProjectId: build.id, artifactId, assignedAgentId: identity.agentId });
    const result = await testArtifact(app, spec.sections.acceptanceChecks);
    if (result.latencyMs > config.maximumLatencyMs) result.suites.performance = 'failed';
    for (const [suite, status] of Object.entries(result.suites)) await recordQcTestRun({ qcJobId: jobId, suiteName: suite, testName: `artifact:${hash}`, status, evidence: { artifactId, agentId: identity.agentId, ...result } });
    const passed = config.mandatorySuites.every((suite: string) => (result.suites as Record<string, string>)[suite] === 'passed');
    await db.update(schema.qcJobs).set({ status: passed ? 'passed' : 'failed', releaseDecision: passed ? 'eligible_for_architect_review' : 'denied', updatedAt: new Date() }).where(eq(schema.qcJobs.id, jobId));
    if (!passed) {
      await createDefectReport({ qcJobId: jobId, buildProjectId: build.id, severity: 'release_blocking', title: 'Independent QC failed', detail: JSON.stringify(result) });
      await auditOperation(identity.agentId, 'repair_required', artifactId, { qcJobId: jobId, failures: result }, deploymentId);
      throw new Error(`Independent QC failed: ${JSON.stringify(result.suites)}`);
    }
    return { ...result, qcJobId: jobId };
  }, { specificationId: spec.spec.id, specificationVersionId: spec.version.id });
  const architect = await runAgent('system_architect', deploymentId, 'compliance', `compliance:${hash}:${spec.version.id}`, async () => {
    const verified = await testArtifact(app, spec.sections.acceptanceChecks);
    if (verified.errors.length || !verified.smoke.passed) throw new Error('Artifact does not meet the approved executable specification.');
    return { specificationVersionId: spec.version.id, artifactHash: hash, checks: spec.sections.acceptanceChecks, verified: true };
  }, { specificationId: spec.spec.id, specificationVersionId: spec.version.id, dependsOnTaskIds: [qc.taskId] });
  const decision = await enforcePolicy({ category: 'quality', action: 'release', deploymentId, actorId: qc.agentId, facts: { artifactId, builderAgentId, qcAgentId: qc.agentId, architectComplianceId: architect.executionId, suites: qc.value.suites, latencyMs: qc.value.latencyMs, artifactHash: hash } });
  const id = generateId();
  await db.insert(schema.releaseAuthorizations).values({ id, deploymentId, artifactId, artifactHash: hash, specificationVersionId: spec.version.id, qcJobId: qc.value.qcJobId, builderAgentId, qcAgentId: qc.agentId, architectExecutionId: architect.executionId, policyEvaluationId: decision.evaluationId, status: 'eligible', evidenceJson: JSON.stringify({ policyVersionId: decision.versionId, qcExecutionId: qc.executionId, architectExecutionId: architect.executionId }) });
  return { id, artifactId, hash, submittedDeployment: undefined as VercelDeployResult | undefined };
}
export async function verifyReleaseForDeployment(deploymentId: string, releaseId: string, app: GeneratedApplication) {
  if (await emergencyStopped()) throw new Error('Emergency stop is active.');
  const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
  const lifecycle = (await db.select().from(schema.businessLifecycleRecords).where(eq(schema.businessLifecycleRecords.deploymentId, deploymentId)).limit(1))[0];
  if (!business || business.status !== 'active' || ['suspended', 'closed'].includes(lifecycle?.state || '')) throw new PolicyEnforcementError('DENY', 'Suspended or closed businesses cannot publish; verified Supervisor resumption or a fresh build is required.');
  const legality = await gapPolicyAssessment(business.gapId);
  if (legality.legalState !== 'legal' || !legality.legalReviewId) throw new PolicyEnforcementError('REQUIRES_LEGAL_REVIEW', 'Current verified legal clearance is required at deployment execution; historical consent cannot override a new legal restriction.');
  const release = (await db.select().from(schema.releaseAuthorizations).where(and(eq(schema.releaseAuthorizations.id, releaseId), eq(schema.releaseAuthorizations.deploymentId, deploymentId))).limit(1))[0];
  const spec = await approvedSpecification(deploymentId);
  if (!release || release.status !== 'eligible' || release.artifactHash !== artifactHash(app) || release.specificationVersionId !== spec?.version.id) throw new Error('Release is missing, altered, stale or ineligible.');
  await enforceSpecification(deploymentId, release.specificationVersionId, release.builderAgentId);
  const permission = await validApproval({ deploymentId, action: 'external_deployment', resourceId: deploymentId, authority: 'user' });
  if (!permission) throw new PolicyEnforcementError('REQUIRES_USER_AUTHORIZATION', 'External deployment permission is required.');
  const financePolicy = await activePolicy('finance', deploymentId);
  const financeConfig = financePolicy ? JSON.parse(financePolicy.configJson) : null;
  if (!financeConfig || !validatePolicy('finance', financeConfig).valid || validatePolicy('finance', financeConfig).missing.length) throw new PolicyEnforcementError('POLICY_NOT_CONFIGURED', 'Business activation requires explicit financial accounting configuration and a recorded profit-sharing agreement.');
  const profitAgreement = await validApproval({ deploymentId, action: 'profit_share', resourceId: deploymentId, authority: 'user', currency: financeConfig.currency });
  if (!profitAgreement || JSON.parse(profitAgreement.scopeJson).platformPercent !== 20 || JSON.parse(profitAgreement.scopeJson).frequency !== 'weekly') throw new PolicyEnforcementError('REQUIRES_USER_AUTHORIZATION', 'The business owner must authorize weekly 20% of verified positive net profit before activation.');
  const deadlinePolicy = await activePolicy('deadlines', deploymentId);
  const deadlineConfig = deadlinePolicy ? JSON.parse(deadlinePolicy.configJson) : null;
  if (!deadlineConfig || !validatePolicy('deadlines', deadlineConfig).valid || validatePolicy('deadlines', deadlineConfig).missing.length) throw new PolicyEnforcementError('POLICY_NOT_CONFIGURED', 'New activation requires explicitly configured deadline and success criteria.');
  const { reviewActivationDeadline } = await import('./businessLifecycle');
  await reviewActivationDeadline(deploymentId);
  const supervisor = await runAgent('supervisor', deploymentId, 'coordinate', `release-review:${release.id}`, async () => {
    const job = (await db.select().from(schema.qcJobs).where(eq(schema.qcJobs.id, release.qcJobId)).limit(1))[0];
    const execution = (await db.select().from(schema.taskExecutions).where(eq(schema.taskExecutions.id, release.architectExecutionId)).limit(1))[0];
    if (job?.status !== 'passed' || execution?.status !== 'completed' || release.qcAgentId === release.builderAgentId) throw new Error('Supervisor release review rejected missing or conflicting verification.');
    return { releaseId: release.id, permissionId: permission.id, decision: 'approved' };
  });
  const approvalId = `release-supervisor:${release.id}`;
  await db.insert(schema.approvals).values({ id: approvalId, deploymentId, action: 'release', resourceId: release.id, authority: 'supervisor', requestedBy: release.builderAgentId, risk: 'high', scopeJson: JSON.stringify({ artifactHash: release.artifactHash, specificationVersionId: release.specificationVersionId, supervisorExecutionId: supervisor.executionId }), expiresAt: permission.expiresAt, status: 'approved', decidedBy: supervisor.agentId, decidedAt: new Date() }).onDuplicateKeyUpdate({ set: { id: approvalId } });
  await auditOperation(supervisor.agentId, 'deployment_authorized', release.id, { supervisorExecutionId: supervisor.executionId, supervisorApprovalId: approvalId, userAuthorizationId: permission.id, profitShareAuthorizationId: profitAgreement.id }, deploymentId);
  return release;
}
export async function authorizeReleaseWithRepair(deploymentId: string, initialApp: GeneratedApplication, initialBuilderId: string) {
  const policy = await activePolicy('quality', deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: quality.');
  const retries = JSON.parse(policy.configJson).repairRetries;
  if (!Number.isInteger(retries) || retries < 1) throw new Error('POLICY_NOT_CONFIGURED: QC repair limit.');
  let app = initialApp;
  let builderAgentId = initialBuilderId;
  for (let repair = 0; repair <= retries; repair++) {
    try { return { release: await authorizeRelease(deploymentId, app, builderAgentId), app, builderAgentId }; }
    catch (error: any) {
      if (!error.message.includes('Independent QC failed') || repair >= retries) throw error;
      const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
      const gap = business ? (await db.select().from(schema.gaps).where(eq(schema.gaps.id, business.gapId)).limit(1))[0] : null;
      const spec = await approvedSpecification(deploymentId);
      if (!business || !gap || !spec) throw new Error('Repair workspace or approved specification is unavailable.');
      const repaired = await runAgent('developer', deploymentId, 'repair', `repair:${artifactHash(app)}:${repair}`, async () => {
        const result = await generateApplication({ deploymentId, gapId: gap.id, knows: gap.knows, needs: gap.needs, controlsAccess: gap.controlsAccess, underestimatesValue: gap.underestimatesValue, businessPlan: `${business.businessPlan}\nApproved specification: ${JSON.stringify(spec.sections)}\nIndependent QC failure: ${error.message}\nRepair the identified defects and preserve approved requirements.` });
        if (!result.success || !result.application) throw new Error(result.error || 'Repair generation failed.');
        return result.application;
      }, { specificationId: spec.spec.id, specificationVersionId: spec.version.id });
      await auditOperation(repaired.agentId, 'repair_completed', repaired.taskId, { executionId: repaired.executionId, previousArtifactHash: artifactHash(app), newArtifactHash: artifactHash(repaired.value) }, deploymentId);
      app = repaired.value;
      builderAgentId = repaired.agentId;
    }
  }
  throw new Error('QC repair limit reached.');
}
export async function recordPostDeployment(deploymentId: string, releaseId: string, reachable: boolean, url: string, app?: GeneratedApplication, externalDeploymentId?: string) {
  const release = (await db.select().from(schema.releaseAuthorizations).where(eq(schema.releaseAuthorizations.id, releaseId)).limit(1))[0];
  if (!release || release.deploymentId !== deploymentId) throw new Error('Release does not belong to business.');
  try {
  if (reachable && (!app || !externalDeploymentId)) throw new Error('Actual deployed artifact retrieval is required for post-deployment QC.');
  if (reachable && app && externalDeploymentId) {
    const spec = await approvedSpecification(deploymentId);
    if (!spec || spec.version.id !== release.specificationVersionId) throw new Error('Post-deployment specification changed.');
    const { readPublicDeploymentFiles } = await import('./vercel');
    const files = await readPublicDeploymentFiles(url, app.files.map(file => file.path), externalDeploymentId);
    const deployed = { ...app, files };
    if (artifactHash(deployed) !== release.artifactHash) {
      await db.update(schema.releaseAuthorizations).set({ status: 'post_deployment_failed' }).where(eq(schema.releaseAuthorizations.id, releaseId));
      throw new Error('Deployed artifact differs from the independently approved artifact.');
    }
    const result = await runAgent('independent_qc', deploymentId, 'qc', `post-deployment:${release.id}`, async identity => {
      const verified = await testArtifact(deployed, spec.sections.acceptanceChecks);
      const policy = await activePolicy('quality', deploymentId);
      const config = policy ? JSON.parse(policy.configJson) : null;
      if (!config || verified.latencyMs > config.maximumLatencyMs) verified.suites.performance = 'failed';
      for (const [suite, status] of Object.entries(verified.suites)) await recordQcTestRun({ qcJobId: release.qcJobId, suiteName: `post_deployment_${suite}`, testName: externalDeploymentId, status, evidence: { url, agentId: identity.agentId, actualArtifactHash: artifactHash(deployed), ...verified } });
      if (!config?.mandatorySuites.every((suite: string) => (verified.suites as Record<string, string>)[suite] === 'passed')) throw new Error('Mandatory post-deployment QC failed.');
      return { artifactHash: artifactHash(deployed), verifiedSuites: verified.suites };
    }, { specificationId: spec.spec.id, specificationVersionId: spec.version.id });
    await auditOperation(result.agentId, 'post_deployment_verified', releaseId, { executionId: result.executionId, externalDeploymentId, artifactHash: release.artifactHash }, deploymentId);
  }
  await db.update(schema.releaseAuthorizations).set({ status: reachable ? 'deployed' : 'post_deployment_failed' }).where(eq(schema.releaseAuthorizations.id, releaseId));
  await recordQcTestRun({ qcJobId: release.qcJobId, suiteName: 'post_deployment', testName: 'provider_public_reachability', status: reachable ? 'passed' : 'failed', evidence: { url, artifactHash: release.artifactHash, verification: 'deployment_provider_readiness_and_public_reachability' } });
  } catch (error: any) {
    await db.update(schema.releaseAuthorizations).set({ status: 'post_deployment_failed' }).where(eq(schema.releaseAuthorizations.id, releaseId));
    await auditOperation('system:release', 'repair_required', release.artifactId, { releaseId, externalDeploymentId, reason: error.message, previousProductionProviderRetained: true }, deploymentId);
    throw error;
  }
}
