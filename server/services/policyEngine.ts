import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db, generateId } from '../db';
import * as schema from '../../drizzle/schema';
import { PolicyCategory, policyCategories, policyDefinitions, validatePolicy } from '../../shared/policyContracts';

export type Decision = 'ALLOW' | 'DENY' | 'REQUIRES_SUPERVISOR_APPROVAL' | 'REQUIRES_USER_AUTHORIZATION' | 'REQUIRES_LEGAL_REVIEW' | 'POLICY_NOT_CONFIGURED' | 'INSUFFICIENT_EVIDENCE';
export type Principal = { id: string; role: string };
export class PolicyEnforcementError extends Error {
  constructor(public decision: Decision, reason: string) { super(`${decision}: ${reason}`); this.name = 'PolicyEnforcementError'; }
}
export async function requirePolicyPermission(actor: Principal, permission = 'policies.edit') {
  if (!actor || actor.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: 'Administrator permission required.' });
  const user = (await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, actor.id)).limit(1))[0];
  if (user?.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: 'Verified administrator identity required.' });
  const permissions = await db.select().from(schema.adminPermissions).where(and(eq(schema.adminPermissions.userId, actor.id), eq(schema.adminPermissions.permission, permission))).limit(1);
  if (!permissions.length) throw new TRPCError({ code: 'FORBIDDEN', message: `Explicit ${permission} permission required.` });
}
export async function activePolicy(category: PolicyCategory, deploymentId?: string) {
  if (deploymentId) {
    const assignment = (await db.select().from(schema.policyAssignments).where(and(eq(schema.policyAssignments.deploymentId, deploymentId), eq(schema.policyAssignments.category, category))).limit(1))[0];
    if (assignment) {
      const pinned = (await db.select().from(schema.policyVersions).where(eq(schema.policyVersions.id, assignment.versionId)).limit(1))[0];
      return pinned?.status === 'disabled' ? null : pinned;
    }
    return null;
  }
  const head = (await db.select().from(schema.policyHeads).where(eq(schema.policyHeads.category, category)).limit(1))[0];
  if (!head?.activeVersionId) return null;
  const version = (await db.select().from(schema.policyVersions).where(eq(schema.policyVersions.id, head.activeVersionId)).limit(1))[0];
  return version?.status === 'disabled' ? null : version;
}
export async function policyOverview(actor: Principal) {
  await requirePolicyPermission(actor, 'policies.view');
  return Promise.all(policyCategories.map(async category => {
    const active = await activePolicy(category);
    const config = { ...policyDefinitions[category].defaults, ...(active ? JSON.parse(active.configJson) : {}) };
    return { category, ...policyDefinitions[category], active, config, validation: validatePolicy(category, config), status: active ? 'active' : 'POLICY_NOT_CONFIGURED' };
  }));
}
export async function policyHistory(actor: Principal, category: PolicyCategory, offset = 0) {
  await requirePolicyPermission(actor, 'policies.history');
  const versions = await db.select().from(schema.policyVersions).where(eq(schema.policyVersions.category, category)).orderBy(desc(schema.policyVersions.createdAt), desc(schema.policyVersions.id)).limit(50).offset(offset);
  return versions.map(version => ({ ...version, configHash: crypto.createHash('sha256').update(version.configJson).digest('hex') }));
}
export async function savePolicyDraft(actor: Principal, input: { category: PolicyCategory; config: unknown; reason: string; restoreId?: string }) {
  await requirePolicyPermission(actor, input.restoreId ? 'policies.restore' : 'policies.edit');
  let config = input.config;
  if (input.restoreId) {
    const old = (await db.select().from(schema.policyVersions).where(eq(schema.policyVersions.id, input.restoreId)).limit(1))[0];
    if (!old || old.category !== input.category) throw new Error('Historical version does not match category.');
    config = JSON.parse(old.configJson);
  }
  const validation = validatePolicy(input.category, config);
  if (!validation.valid) throw new TRPCError({ code: 'BAD_REQUEST', message: validation.errors.join('\n') });
  const id = generateId();
  const active = await activePolicy(input.category);
  await db.insert(schema.policyVersions).values({ id, category: input.category, configJson: JSON.stringify(config), status: 'draft', previousId: active?.id ?? null, actorId: actor.id, reason: input.reason });
  return { id, validation };
}
export async function policyImpact(actor: Principal, category: PolicyCategory, offset = 0, limit = 50) {
  await requirePolicyPermission(actor, 'policies.impact');
  const [businesses, assignments, queue] = await Promise.all([
    db.select({ id: schema.deployments.id, status: schema.deployments.status }).from(schema.deployments).orderBy(schema.deployments.id).limit(limit).offset(offset),
    db.select().from(schema.policyAssignments).where(eq(schema.policyAssignments.category, category)).orderBy(schema.policyAssignments.deploymentId).limit(limit).offset(offset),
    db.select({ id: schema.queueItems.id, type: schema.queueItems.queueType }).from(schema.queueItems).where(eq(schema.queueItems.status, 'pending')).orderBy(schema.queueItems.id).limit(limit).offset(offset),
  ]);
  const [tasks, approvals, counts] = await Promise.all([
    db.select().from(schema.agentTasks).orderBy(schema.agentTasks.id).limit(limit).offset(offset),
    db.select({ id: schema.approvals.id, deploymentId: schema.approvals.deploymentId, action: schema.approvals.action, resourceId: schema.approvals.resourceId, status: schema.approvals.status, authority: schema.approvals.authority, amount: schema.approvals.amount, currency: schema.approvals.currency, expiresAt: schema.approvals.expiresAt, scopeJson: schema.approvals.scopeJson }).from(schema.approvals).orderBy(schema.approvals.id).limit(limit).offset(offset),
    db.execute(sql`SELECT (SELECT COUNT(*) FROM deployments) AS businesses, (SELECT COUNT(*) FROM policy_assignments WHERE category=${category}) AS assignments, (SELECT COUNT(*) FROM queue_items WHERE status='pending') AS queue, (SELECT COUNT(*) FROM agent_tasks) AS tasks, (SELECT COUNT(*) FROM action_approvals) AS approvals`),
  ]);
  const filter = category === 'agents' ? undefined : or(inArray(schema.agents.role, policyDefinitions[category].agents), sql`EXISTS(SELECT 1 FROM policy_evaluations e WHERE e.actor_id=${schema.agents.id} AND e.category=${category})`);
  const agentInstances = await db.select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, availability: schema.agents.availability, implementationStatus: schema.agents.implementationStatus }).from(schema.agents).where(filter).orderBy(schema.agents.id).limit(limit).offset(offset);
  const agentCount = (await db.select({ count: sql<number>`COUNT(*)` }).from(schema.agents).where(filter))[0].count;
  return { ...policyDefinitions[category], agentInstances, businesses, assignments, queue, tasks, approvals, counts: { ...(counts[0] as any)[0], agents: Number(agentCount) }, application: 'Complete conservative impact population, including protected/pinned work. Global activation applies only to unassigned work. Business snapshots and existing user agreements remain unchanged. Explicit reassignment requires separate review.', financialImplications: ['finance', 'advertising', 'pricing', 'deadlines'].includes(category), limit, offset };
}
export async function validatePolicyDraft(actor: Principal, id: string) {
  await requirePolicyPermission(actor, 'policies.validate');
  return db.transaction(async tx => {
    const version = (await tx.select().from(schema.policyVersions).where(eq(schema.policyVersions.id, id)).for('update'))[0];
    if (!version || !['draft', 'invalid', 'validated'].includes(version.status)) throw new Error('Only drafts can be validated.');
    const validation = validatePolicy(version.category as PolicyCategory, JSON.parse(version.configJson));
    await tx.update(schema.policyVersions).set({ status: validation.valid && !validation.missing.length ? 'validated' : 'invalid', validationJson: JSON.stringify(validation), updatedAt: new Date() }).where(eq(schema.policyVersions.id, id));
    return validation;
  });
}
export async function activatePolicy(actor: Principal, id: string) {
  await requirePolicyPermission(actor, 'policies.activate');
  const version = (await db.select().from(schema.policyVersions).where(eq(schema.policyVersions.id, id)).limit(1))[0];
  if (!version) throw new Error('Version not found.');
  const impact = await policyImpact(actor, version.category as PolicyCategory);
  return db.transaction(async tx => {
    await tx.insert(schema.policyHeads).values({ category: version.category }).onDuplicateKeyUpdate({ set: { category: version.category } });
    const head = (await tx.select().from(schema.policyHeads).where(eq(schema.policyHeads.category, version.category)).for('update'))[0];
    const draft = (await tx.select().from(schema.policyVersions).where(eq(schema.policyVersions.id, id)).for('update'))[0];
    const validation = validatePolicy(version.category as PolicyCategory, JSON.parse(draft.configJson));
    if (draft.status !== 'validated' || !validation.valid || validation.missing.length) throw new Error('A complete validated draft is required.');
    if (head.activeVersionId !== draft.previousId) throw new Error('Active version changed. Create and validate a new draft.');
    if (head.activeVersionId) {
      const businesses = await tx.select({ id: schema.deployments.id }).from(schema.deployments);
      for (const business of businesses) {
        await tx.insert(schema.policyAssignments).values({ deploymentId: business.id, category: version.category, versionId: head.activeVersionId }).onDuplicateKeyUpdate({ set: { deploymentId: business.id } });
      }
      await tx.update(schema.policyVersions).set({ status: 'superseded', updatedAt: new Date() }).where(eq(schema.policyVersions.id, head.activeVersionId));
    }
    await tx.update(schema.policyVersions).set({ status: 'active', impactJson: JSON.stringify({ ...impact, activatedBy: actor.id, activatedAt: new Date().toISOString() }), updatedAt: new Date() }).where(eq(schema.policyVersions.id, id));
    await tx.update(schema.policyHeads).set({ activeVersionId: id, updatedAt: new Date() }).where(eq(schema.policyHeads.category, version.category));
    return { id, impact };
  });
}
export function decidePolicy(category: PolicyCategory, config: Record<string, any> | null, action: string, facts: Record<string, any>): { decision: Decision; reason: string } {
  const result = (decision: Decision, reason: string) => ({ decision, reason });
  if (action === 'suspend' && category === 'shutdown') return result('ALLOW', 'Safety suspension preserves records and obligations.');
  if (!config) return result('POLICY_NOT_CONFIGURED', `No applicable ${category} policy is active.`);
  const validation = validatePolicy(category, config);
  if (!validation.valid || validation.missing.length) return result('POLICY_NOT_CONFIGURED', `Invalid or incomplete policy: ${[...validation.errors, ...validation.missing].join(', ')}`);
  if (facts.emergencyStop) return result('DENY', 'Emergency stop is active.');
  if (category === 'discovery' && action === 'business_creation') {
    if (facts.legalState === 'illegal') return result('DENY', 'Opportunity is classified illegal.');
    if (facts.legalState !== 'legal' || !facts.legalReviewId) return result('REQUIRES_LEGAL_REVIEW', 'Recorded legal clearance is required.');
    if (!Array.isArray(facts.independentSources) || new Set(facts.independentSources).size < config.minimumSources) return result('INSUFFICIENT_EVIDENCE', 'Independent source requirement is not met.');
    if (!Number.isFinite(facts.score) || facts.score < config.qualificationThreshold) return result('DENY', 'Configured qualification threshold is not met.');
    return result('ALLOW', 'Legal clearance, evidence and qualification verified.');
  }
  if (category === 'specification' && action === 'build') {
    if (!facts.approvedVersionId || !facts.architectReviewId || facts.unresolvedConflicts) return result('INSUFFICIENT_EVIDENCE', 'Approved specification, Architect review and conflict resolution required.');
    if (facts.taskVersionId !== facts.approvedVersionId) return result('DENY', 'Task uses an outdated specification.');
    return result('ALLOW', 'Task follows the approved specification version.');
  }
  if (category === 'agents' && action === 'tool_execution') {
    if (!facts.verifiedIdentity || !facts.workspaceMatch || !config.allowedTools.includes(facts.tool) || !facts.roleAllowsTool) return result('DENY', 'Agent identity, workspace or tool permission denied.');
    if ((facts.spending || facts.irreversible) && !facts.userAuthorizationId) return result('REQUIRES_USER_AUTHORIZATION', 'Recorded user authorization is required.');
    if (facts.highRisk && !facts.supervisorApprovalId) return result('REQUIRES_SUPERVISOR_APPROVAL', 'Supervisor approval is required.');
    return result('ALLOW', 'Scoped permissions and required approvals verified.');
  }
  if (category === 'quality' && action === 'release') {
    if (!facts.artifactId || !facts.qcAgentId || facts.qcAgentId === facts.builderAgentId || !facts.builderAgentId || !facts.architectComplianceId) return result('INSUFFICIENT_EVIDENCE', 'Independent artifact-linked QC and Architect compliance required.');
    if (!config.mandatorySuites.every((suite: string) => facts.suites?.[suite] === 'passed')) return result('DENY', 'Mandatory QC suite failed or is missing.');
    if (!Number.isFinite(facts.latencyMs) || facts.latencyMs > config.maximumLatencyMs) return result('DENY', 'Performance acceptance requirement is not met.');
    return result('ALLOW', 'Independent mandatory QC and compliance passed.');
  }
  if (category === 'pricing' && action === 'price_change') {
    if (!facts.marketEvidenceId || !facts.commitmentsPreserved) return result('INSUFFICIENT_EVIDENCE', 'Market evidence and customer commitment checks required.');
    if (!Number.isFinite(facts.changePercent)) return result('INSUFFICIENT_EVIDENCE', 'A finite price change amount is required.');
    if ((facts.highRisk || !config.automaticChanges || Math.abs(facts.changePercent) > config.maximumChangePercent) && !facts.supervisorApprovalId) return result('REQUIRES_SUPERVISOR_APPROVAL', 'Price change requires recorded Supervisor review.');
    if (!Number.isFinite(facts.hoursSinceChange) || facts.hoursSinceChange < config.minimumChangeIntervalHours) return result('DENY', 'Price change frequency limit applies.');
    return result('ALLOW', 'Routine pricing change is within configured limits.');
  }
  if (category === 'advertising' && action === 'paid_campaign') {
    if (!facts.userAuthorizationId) return result('REQUIRES_USER_AUTHORIZATION', 'Paid spend requires recorded user consent.');
    if (!facts.providerOperational) return result('DENY', 'Paid provider execution is unavailable.');
    if (!Number.isFinite(facts.amount) || facts.amount <= 0 || facts.amount > config.campaignLimit || facts.amount > facts.remainingAuthorized) return result('DENY', 'Campaign exceeds policy or authorization limits.');
    return result('ALLOW', 'Campaign is within verified user authorization.');
  }
  if (category === 'finance' && action === 'settlement') {
    if (!facts.userAuthorizationId) return result('REQUIRES_USER_AUTHORIZATION', 'Profit-sharing authorization is required.');
    if (facts.disputed || facts.unverifiedExpenses || !facts.reconciled) return result('DENY', 'Settlement paused pending accounting verification.');
    return result('DENY', 'External payout execution is unavailable. Verified calculation does not imply payment.');
  }
  if (category === 'finance' && action === 'profit_calculation') {
    if (!facts.feesReviewed) return result('INSUFFICIENT_EVIDENCE', 'Processing fees must be verified; missing fee evidence is not assumed to mean zero.');
    if (!facts.userAuthorizationId) return result('REQUIRES_USER_AUTHORIZATION', 'Recorded weekly net-profit authorization required.');
    if (!facts.accountingVerified || !facts.taxReviewed || facts.currency !== config.currency) return result('INSUFFICIENT_EVIDENCE', 'Verified accounting, explicit tax treatment and matching currency required.');
    return result('ALLOW', 'Verified accounting calculation is within the recorded agreement; this does not authorize an external payout.');
  }
  if (category === 'deadlines' && action === 'extension') {
    if (!facts.recoveryAssessmentId || !facts.supervisorApprovalId) return result('REQUIRES_SUPERVISOR_APPROVAL', 'Recovery assessment and Supervisor review required.');
    if (!Number.isInteger(facts.extensionsUsed) || facts.extensionsUsed >= config.maximumExtensions || !Number.isFinite(facts.price) || facts.price < config.minimumExtensionPrice || facts.price > config.maximumExtensionPrice) return result('DENY', 'Extension limit or price boundary exceeded.');
    if (!facts.userAcceptanceId || !facts.verifiedPaymentId) return result('REQUIRES_USER_AUTHORIZATION', 'User acceptance and verified extension payment required.');
    return result('ALLOW', 'Finite extension offer accepted and payment verified.');
  }
  if (category === 'deadlines' && action === 'set_deadline') {
    if (facts.needsSupervisor && !facts.supervisorApprovalId) return result('REQUIRES_SUPERVISOR_APPROVAL', `Finance/Strategy concerns require a recorded deadline decision. Approval resource: ${facts.reviewResourceId}`);
    if (!facts.financeExecutionId || !facts.strategyExecutionId || !facts.assessmentAccepted) return result('INSUFFICIENT_EVIDENCE', 'Finance and Strategy must assess the configured industry/complexity deadline.');
    if (facts.days !== config.initialDays || facts.industry !== config.industry || facts.complexity !== config.complexity) return result('DENY', 'Deadline proposal does not match configured business boundaries.');
    return result('ALLOW', 'Configured deadline independently assessed and persisted; extension requirements remain separate.');
  }
  if (category === 'shutdown' && action === 'restart') {
    if (!facts.oldBusinessClosed || !facts.freshGapId || !facts.freshLegalReviewId || !facts.discoveredAfterClosure || !facts.freshBuildRequired) return result('INSUFFICIENT_EVIDENCE', 'Closed business restart requires new viability evidence, legal clearance and a fresh specification/build.');
    return result('ALLOW', 'Fresh-business build may proceed without resuming or deleting the closed business.');
  }
  if (category === 'shutdown' && action === 'resume') {
    if (!facts.supervisorDecisionId || !facts.legalReviewId || !facts.qcReleaseId || !facts.providerVerified || !facts.obligationsPreserved) return result('INSUFFICIENT_EVIDENCE', 'Supervisor review, legal clearance, independent artifact QC and actual provider recovery are required.');
    return result('ALLOW', 'Verified safe resumption preserves customer/financial obligations and does not authorize new spending.');
  }
  if (category === 'shutdown' && action === 'closure') {
    if (!facts.supervisorApprovalId) return result('REQUIRES_SUPERVISOR_APPROVAL', 'Supervisor closure decision required.');
    if (!facts.userAuthorizationId) return result('REQUIRES_USER_AUTHORIZATION', 'User consent required for irreversible closure.');
    if (!facts.notificationId || !facts.obligationsResolved || !facts.finalReportId) return result('DENY', 'Notification, final report and obligation preservation required.');
    return result('ALLOW', 'Closure prerequisites verified; resource deletion remains separately authorized.');
  }
  return result('DENY', `No verified execution handler for ${category}/${action}.`);
}
export async function evaluatePolicy(input: { category: PolicyCategory; action: string; gapId?: string; deploymentId?: string; actorId: string; facts?: Record<string, unknown>; versionId?: string }) {
  const selected = input.versionId ? (await db.select().from(schema.policyVersions).where(and(eq(schema.policyVersions.id, input.versionId), eq(schema.policyVersions.category, input.category))).limit(1))[0] : await activePolicy(input.category, input.deploymentId);
  const version = selected && ['active', 'superseded'].includes(selected.status) ? selected : null;
  const decision = decidePolicy(input.category, version ? JSON.parse(version.configJson) : null, input.action, input.facts || {});
  const evaluationId = generateId();
  await db.insert(schema.policyEvaluations).values({ id: evaluationId, category: input.category, versionId: version?.id ?? null, action: input.action, gapId: input.gapId ?? null, deploymentId: input.deploymentId ?? null, actorId: input.actorId, ...decision, evidenceJson: JSON.stringify(input.facts || {}) });
  return { ...decision, versionId: version?.id ?? null, evaluationId };
}
export async function enforcePolicy(input: Parameters<typeof evaluatePolicy>[0]) {
  const decision = await evaluatePolicy(input);
  if (decision.decision !== 'ALLOW') throw new PolicyEnforcementError(decision.decision, decision.reason);
  return decision;
}
export async function policyActivity(actor: Principal, category: PolicyCategory, offset = 0) {
  await requirePolicyPermission(actor, 'policies.history');
  return db.select().from(schema.policyEvaluations).where(eq(schema.policyEvaluations.category, category)).orderBy(desc(schema.policyEvaluations.createdAt)).limit(50).offset(offset);
}
export async function editPolicyDraft(actor: Principal, input: { id: string; config: unknown; reason: string; expectedHash: string }) {
  await requirePolicyPermission(actor, 'policies.edit');
  return db.transaction(async tx => {
    const draft = (await tx.select().from(schema.policyVersions).where(eq(schema.policyVersions.id, input.id)).for('update'))[0];
    if (!draft || !['draft', 'invalid', 'validated'].includes(draft.status)) throw new Error('Historical and active versions are immutable.');
    if (crypto.createHash('sha256').update(draft.configJson).digest('hex') !== input.expectedHash) throw new Error('Draft changed concurrently. Reload before editing.');
    const validation = validatePolicy(draft.category as PolicyCategory, input.config);
    if (!validation.valid) throw new Error(validation.errors.join(', '));
    await tx.insert(schema.operationalEvents).values({ id: generateId(), actorId: actor.id, type: 'policy_draft_edited', resourceId: draft.id, detailJson: JSON.stringify({ previousConfig: JSON.parse(draft.configJson), newConfig: input.config, reason: input.reason }) });
    await tx.update(schema.policyVersions).set({ configJson: JSON.stringify(input.config), reason: input.reason, validationJson: null, status: 'draft', updatedAt: new Date() }).where(eq(schema.policyVersions.id, draft.id));
    return { id: draft.id, validation };
  });
}
export async function disableOptionalPolicy(actor: Principal, category: PolicyCategory, reason: string) {
  await requirePolicyPermission(actor, 'policies.activate');
  if (category !== 'pricing') throw new Error('Mandatory policy categories cannot be disabled. Leave dependent operations blocked while configuring them.');
  await db.transaction(async tx => {
    const head = (await tx.select().from(schema.policyHeads).where(eq(schema.policyHeads.category, category)).for('update'))[0];
    if (!head?.activeVersionId) throw new Error('No active optional policy.');
    await tx.update(schema.policyVersions).set({ status: 'disabled', updatedAt: new Date() }).where(eq(schema.policyVersions.id, head.activeVersionId));
    await tx.update(schema.policyHeads).set({ activeVersionId: null, updatedAt: new Date() }).where(eq(schema.policyHeads.category, category));
    await tx.insert(schema.operationalEvents).values({ id: generateId(), actorId: actor.id, type: 'policy_disabled', resourceId: head.activeVersionId, detailJson: JSON.stringify({ reason, category, effect: 'Pricing changes denied until reconfigured.' }) });
  });
}
export async function assignBusinessPolicy(actor: Principal, deploymentId: string, category: PolicyCategory, versionId: string, reason: string) {
  await requirePolicyPermission(actor, 'policies.assign');
  const version = (await db.select().from(schema.policyVersions).where(eq(schema.policyVersions.id, versionId)).limit(1))[0];
  if (!version || version.category !== category || !['active', 'superseded'].includes(version.status)) throw new Error('A verified eligible policy version is required.');
  if (['finance', 'advertising', 'pricing', 'deadlines'].includes(category)) {
    const { validApproval } = await import('./execution');
    if (!await validApproval({ deploymentId, action: 'policy_assignment', resourceId: versionId, authority: 'user' })) throw new Error('Existing financial arrangements require explicit owner authorization for reassignment.');
  }
  await db.transaction(async tx => {
    const old = (await tx.select().from(schema.policyAssignments).where(and(eq(schema.policyAssignments.deploymentId, deploymentId), eq(schema.policyAssignments.category, category))).for('update'))[0];
    await tx.insert(schema.policyAssignments).values({ deploymentId, category, versionId }).onDuplicateKeyUpdate({ set: { versionId } });
    await tx.insert(schema.operationalEvents).values({ id: generateId(), actorId: actor.id, deploymentId, type: 'business_policy_assigned', resourceId: versionId, detailJson: JSON.stringify({ category, previousVersionId: old?.versionId, reason }) });
  });
}
