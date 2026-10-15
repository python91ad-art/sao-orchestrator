import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, generateId } from '../db';
import * as schema from '../../drizzle/schema';
import { activePolicy, enforcePolicy, Principal, requirePolicyPermission } from './policyEngine';
import { callLLMJson } from './llm';
import { AGENT_ROLES, createBusinessSpecification, createBusinessSpecificationVersion, recordSpecificationEvent } from './infrastructure';
import { auditOperation, runAgent } from './execution';
import { gapPolicyAssessment } from './discoveryPolicy';
import { ensureBusinessModelRecommendation } from './pricingLifecycle';

export const acceptanceCheck = z.object({ selector: z.string().min(1).max(1000), operation: z.enum(['visible', 'text', 'click', 'fill', 'attribute']), value: z.string().max(10000).optional(), attribute: z.string().max(200).optional() }).strict();
export const acceptanceManifest = z.array(acceptanceCheck).min(1).max(100);
export async function approvedSpecification(deploymentId: string) {
  const spec = (await db.select().from(schema.businessSpecifications).where(and(eq(schema.businessSpecifications.deploymentId, deploymentId), eq(schema.businessSpecifications.status, 'approved'))).orderBy(desc(schema.businessSpecifications.updatedAt)).limit(1))[0];
  if (!spec?.currentVersionId) return null;
  const version = (await db.select().from(schema.businessSpecificationVersions).where(eq(schema.businessSpecificationVersions.id, spec.currentVersionId)).limit(1))[0];
  if (!version || version.status !== 'approved') return null;
  return { spec, version, sections: JSON.parse(version.sectionsJson) };
}
async function approveVersion(deploymentId: string, specificationId: string, versionId: string, actorId: string) {
  const policy = await activePolicy('specification', deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: specification governance.');
  const config = JSON.parse(policy.configJson);
  await db.transaction(async tx => {
    const spec = (await tx.select().from(schema.businessSpecifications).where(eq(schema.businessSpecifications.id, specificationId)).for('update'))[0];
    const version = (await tx.select().from(schema.businessSpecificationVersions).where(eq(schema.businessSpecificationVersions.id, versionId)).for('update'))[0];
    if (!spec || spec.deploymentId !== deploymentId || !version || version.specificationId !== spec.id || version.status !== 'draft') throw new Error('Invalid specification approval target.');
    const conflicts = await tx.select().from(schema.businessSpecificationEvents).where(and(eq(schema.businessSpecificationEvents.specificationId, spec.id), eq(schema.businessSpecificationEvents.eventType, 'conflict'), inArray(schema.businessSpecificationEvents.status, ['open', 'escalated'])));
    if (conflicts.length) throw new Error('Unresolved specification conflicts require investigation before approval.');
    const sections = JSON.parse(version.sectionsJson);
    for (const field of config.requiredSections) if (!sections[field] || (Array.isArray(sections[field]) && !sections[field].length)) throw new Error(`Required specification section missing: ${field}`);
    acceptanceManifest.parse(sections.acceptanceChecks);
    z.array(z.enum(AGENT_ROLES)).min(1).parse(sections.expertise);
    if (spec.currentVersionId && spec.currentVersionId !== versionId) {
      await tx.update(schema.businessSpecificationVersions).set({ status: 'superseded' }).where(and(eq(schema.businessSpecificationVersions.id, spec.currentVersionId), eq(schema.businessSpecificationVersions.status, 'approved')));
      const tasks = await tx.select().from(schema.agentTasks).where(and(eq(schema.agentTasks.specificationId, spec.id), inArray(schema.agentTasks.state, ['ready', 'pending', 'waiting_for_dependencies', 'running'])));
      for (const task of tasks) await tx.update(schema.agentTasks).set({ state: 'blocked_by_policy', errorMessage: 'Specification updated; task must be reassigned to the approved version.', updatedAt: new Date() }).where(eq(schema.agentTasks.id, task.id));
    }
    await tx.update(schema.businessSpecificationVersions).set({ status: 'approved' }).where(eq(schema.businessSpecificationVersions.id, versionId));
    await tx.update(schema.businessSpecifications).set({ currentVersionId: versionId, status: 'approved', approvalState: 'approved', updatedAt: new Date() }).where(eq(schema.businessSpecifications.id, spec.id));
    await tx.insert(schema.businessSpecificationEvents).values({ id: generateId(), specificationId: spec.id, versionId, eventType: 'architect_approval', status: 'approved', title: 'Architect specification verification', detail: 'Required sections and executable acceptance manifest validated.', createdBy: actorId });
  });
}
export async function ensureApprovedSpecification(deploymentId: string) {
  const approved = await approvedSpecification(deploymentId);
  if (approved) return approved;
  const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
  if (!business) throw new Error('Business not found.');
  const gap = (await db.select().from(schema.gaps).where(eq(schema.gaps.id, business.gapId)).limit(1))[0];
  const assessment = await gapPolicyAssessment(business.gapId);
  const businessModel = await ensureBusinessModelRecommendation(deploymentId);
  const policy = await activePolicy('specification', deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: specification.');
  const required = JSON.parse(policy.configJson).requiredSections;
  const result = await runAgent('system_architect', deploymentId, 'specification', `specification:${deploymentId}`, async identity => {
    const sections = await callLLMJson<Record<string, unknown>>(`Create a Master Business Specification from the business plan and fresh opportunity evidence. Return an object with nonempty sections ${JSON.stringify(required)}, immediateRequirements, futureImprovements, expertise, and acceptanceChecks. acceptanceChecks must contain executable browser assertions with selector, operation (visible/text/click/fill/attribute), optional value and attribute. Assertions must verify this business's functionality rather than only generic HTML. Do not claim tests ran.\nBusiness plan:\n${business.businessPlan}\nPricing/Marketing/Finance recommendation (not an approved customer price): ${businessModel.recommendationJson}\nOpportunity: ${JSON.stringify(gap)}\nEvidence: ${JSON.stringify('evidence' in assessment ? assessment.evidence?.map(record => ({ id: record.id, summary: record.summary, url: record.sourceUrl })) : [])}`, { task: 'JSON_GENERATION', reasoningLevel: assessment.reasoningLevel as any, systemPrompt: 'You are the System Architect. Produce concrete requirements and executable acceptance checks as JSON.' });
    acceptanceManifest.parse(sections.acceptanceChecks);
    const existingDraft = (await db.select().from(schema.businessSpecifications).where(and(eq(schema.businessSpecifications.deploymentId, deploymentId), eq(schema.businessSpecifications.status, 'draft'))).limit(1))[0];
    const draft = existingDraft ? await createBusinessSpecificationVersion({ specificationId: existingDraft.id, sections, changeSummary: 'Architect completed the initial governed requirements.', createdBy: identity.agentId }) : await createBusinessSpecification({ deploymentId, gapId: business.gapId, title: 'Master Business Specification', legacyBusinessPlan: business.businessPlan, sections, createdBy: identity.agentId });
    if (!draft) throw new Error('Specification creation failed.');
    const versionId = existingDraft && draft.versions.length ? draft.versions[0].id : draft.currentVersionId!;
    await approveVersion(deploymentId, draft.id, versionId, identity.agentId);
    return { specificationId: draft.id, versionId };
  });
  const current = await approvedSpecification(deploymentId);
  if (!current || current.version.id !== result.value.versionId) throw new Error('Architect result does not match the approved specification.');
  return current;
}
export async function proposeSpecification(actor: Principal, input: { specificationId: string; sections: Record<string, unknown>; reason: string }) {
  await requirePolicyPermission(actor, 'specifications.manage');
  return createBusinessSpecificationVersion({ specificationId: input.specificationId, sections: input.sections, changeSummary: input.reason, createdBy: actor.id });
}
export async function evaluateFutureImprovements(actor: Principal, specificationId: string) {
  await requirePolicyPermission(actor, 'specifications.manage');
  const spec = (await db.select().from(schema.businessSpecifications).where(eq(schema.businessSpecifications.id, specificationId)).limit(1))[0];
  const approved = spec?.deploymentId ? await approvedSpecification(spec.deploymentId) : null;
  if (!approved || approved.spec.id !== specificationId) throw new Error('An approved business specification is required.');
  const policy = await activePolicy('specification', spec.deploymentId!);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: improvement governance.');
  const result = await runAgent('system_architect', spec.deploymentId!, 'specification', `future-improvements:${approved.version.id}`, async identity => {
    const assessment = z.object({ futureImprovements: z.array(z.string().min(1)).min(1), rationale: z.string().min(1) }).parse(await callLLMJson(`Evaluate useful future improvements, separate from all immediate approved requirements. Return {futureImprovements:string[],rationale:string}. Do not change prices, authorizations, deployment, security controls or existing acceptance requirements. Approved specification: ${JSON.stringify(approved.sections)}`, { task: 'JSON_GENERATION' }));
    const sections = { ...approved.sections, futureImprovements: [...new Set([...(Array.isArray(approved.sections.futureImprovements) ? approved.sections.futureImprovements : []), ...assessment.futureImprovements])] };
    const proposal = await createBusinessSpecificationVersion({ specificationId, sections, changeSummary: assessment.rationale, createdBy: identity.agentId });
    if (!proposal) throw new Error('Improvement proposal could not be persisted.');
    const versionId = proposal.versions[0].id;
    const automatic = JSON.parse(policy.configJson).allowAutomaticImprovements === true;
    if (automatic) await approveVersion(spec.deploymentId!, specificationId, versionId, identity.agentId);
    await recordSpecificationEvent({ specificationId, versionId, eventType: 'improvement_evaluated', status: automatic ? 'approved' : 'proposed', title: 'Architect future improvement assessment', detail: assessment.rationale, metadata: { immediateRequirementsUnchanged: true, policyVersionId: policy.id, automatic }, createdBy: identity.agentId });
    return { versionId, status: automatic ? 'approved' : 'draft', immediateRequirementsUnchanged: true };
  });
  return result.value;
}
export async function reviewSpecificationProposal(actor: Principal, specificationId: string, versionId: string) {
  await requirePolicyPermission(actor, 'specifications.manage');
  const spec = (await db.select().from(schema.businessSpecifications).where(eq(schema.businessSpecifications.id, specificationId)).limit(1))[0];
  if (!spec?.deploymentId) throw new Error('Business specification required.');
  const result = await runAgent('system_architect', spec.deploymentId, 'specification', `review:${versionId}`, async identity => {
    const proposal = (await db.select().from(schema.businessSpecificationVersions).where(and(eq(schema.businessSpecificationVersions.id, versionId), eq(schema.businessSpecificationVersions.specificationId, specificationId))).limit(1))[0];
    if (!proposal || proposal.status !== 'draft') throw new Error('An immutable draft proposal is required for review.');
    const assessment = z.object({ rationale: z.string().min(1), concerns: z.array(z.string()) }).parse(await callLLMJson(`Review proposed specification changes for technical consistency, immediate requirements and future improvements. Return {rationale:string,concerns:string[]}. Do not grant spending authorization or QC approval. Business plan: ${spec.legacyBusinessPlan}. Proposal: ${proposal.sectionsJson}`, { task: 'JSON_GENERATION' }));
    await recordSpecificationEvent({ specificationId, versionId, eventType: 'architect_change_assessment', status: assessment.concerns.length ? 'escalated' : 'verified', title: 'Architect change evaluation', detail: assessment.rationale, metadata: assessment, createdBy: identity.agentId });
    if (assessment.concerns.length) throw new Error('Architect concerns require conflict resolution before adoption.');
    await approveVersion(spec.deploymentId!, specificationId, versionId, identity.agentId);
    return { versionId };
  });
  await auditOperation(actor.id, 'specification_proposal_reviewed', versionId, { executionId: result.executionId }, spec.deploymentId);
  return result.value;
}
export async function investigateSpecificationConflict(actor: Principal, specificationId: string, taskIds: string[], concern: string) {
  await requirePolicyPermission(actor, 'specifications.manage');
  const spec = (await db.select().from(schema.businessSpecifications).where(eq(schema.businessSpecifications.id, specificationId)).limit(1))[0];
  if (!spec?.deploymentId || !taskIds.length || !concern.trim()) throw new Error('Business specification, affected tasks and concern are required.');
  const tasks = await db.select().from(schema.agentTasks).where(and(inArray(schema.agentTasks.id, taskIds), eq(schema.agentTasks.deploymentId, spec.deploymentId)));
  if (new Set(taskIds).size !== tasks.length) throw new Error('Conflict tasks must belong to the same business workspace.');
  const conflictId = await recordSpecificationEvent({ specificationId, versionId: spec.currentVersionId || undefined, eventType: 'conflict', status: 'open', title: 'Cross-agent requirements conflict', detail: concern, metadata: { taskIds, participants: tasks.map(task => task.agentId) }, createdBy: actor.id });
  const participantReviews: { sourceAgentId: string; reviewAgentId: string; executionId: string; taskId: string; role: string; position: string; concerns: string[] }[] = [];
  for (const agentId of [...new Set(tasks.map(task => task.agentId).filter(Boolean))]) {
    const agent = (await db.select().from(schema.agents).where(eq(schema.agents.id, agentId!)).limit(1))[0];
    if (!agent) throw new Error('A conflict participant has no verified registered agent identity.');
    const relevant = tasks.filter(task => task.agentId === agentId);
    const review = await runAgent(agent.role, spec.deploymentId, 'discuss_conflict', `conflict-position:${conflictId}:${agent.id}`, async () => z.object({ position: z.string().min(1), concerns: z.array(z.string()) }).parse(await callLLMJson(`Provide your specialist position in a shared technical investigation as ${agent.role}. Return {position:string,concerns:string[]}. Do not claim approval, change requirements or execute external actions. Concern: ${concern}. Your business-scoped task evidence: ${JSON.stringify(relevant.map(task => ({ id: task.id, input: task.inputJson, output: task.outputJson, error: task.errorMessage })))}`, { task: 'JSON_GENERATION' })));
    participantReviews.push({ sourceAgentId: agent.id, reviewAgentId: review.agentId, executionId: review.executionId, taskId: review.taskId, role: agent.role, position: review.value.position!, concerns: review.value.concerns! });
  }
  const result = await runAgent('system_architect', spec.deploymentId, 'specification', `investigate:${conflictId}`, async () => z.object({ resolution: z.string().min(1), resolved: z.boolean(), requiresRequirementChange: z.boolean() }).parse(await callLLMJson(`Investigate this technical conflict using affected agents' persisted outputs and their fresh joint-investigation positions. Return {resolution:string,resolved:boolean,requiresRequirementChange:boolean}. Do not overwrite requirements, approve QC or authorize spending. Concern: ${concern}. Participant positions: ${JSON.stringify(participantReviews)}. Tasks: ${JSON.stringify(tasks.map(task => ({ id: task.id, agentId: task.agentId, input: task.inputJson, output: task.outputJson, error: task.errorMessage })))}`, { task: 'JSON_GENERATION' })), { dependsOnTaskIds: participantReviews.map(review => review.taskId) });
  const status = result.value.resolved && !result.value.requiresRequirementChange ? 'resolved' : 'escalated';
  await db.update(schema.businessSpecificationEvents).set({ status, metadataJson: JSON.stringify({ taskIds, participantReviews, assessment: result.value, executionId: result.executionId }) }).where(eq(schema.businessSpecificationEvents.id, conflictId));
  await auditOperation(result.agentId, status === 'escalated' ? 'supervisor_escalation' : 'technical_conflict_resolved', conflictId, { specificationId, ...result.value }, spec.deploymentId);
  return { id: conflictId, status, assessment: result.value };
}
export async function resolveSpecificationConflict(actor: Principal, id: string, resolution: string) {
  await requirePolicyPermission(actor, 'approvals.supervisor');
  const conflict = (await db.select().from(schema.businessSpecificationEvents).where(eq(schema.businessSpecificationEvents.id, id)).limit(1))[0];
  if (!conflict || conflict.eventType !== 'conflict' || conflict.status !== 'escalated') throw new Error('An Architect-investigated, escalated conflict is required.');
  await db.update(schema.businessSpecificationEvents).set({ status: 'resolved', metadataJson: JSON.stringify({ resolution, resolvedBy: actor.id, resolvedAt: new Date().toISOString() }) }).where(eq(schema.businessSpecificationEvents.id, id));
  await recordSpecificationEvent({ specificationId: conflict.specificationId, versionId: conflict.versionId, eventType: 'conflict_resolution', status: 'resolved', title: 'Supervisor resolution', detail: resolution, createdBy: actor.id });
}
export async function enforceSpecification(deploymentId: string, versionId: string, actorId: string) {
  const approved = await approvedSpecification(deploymentId);
  const conflicts = approved ? await db.select({ id: schema.businessSpecificationEvents.id }).from(schema.businessSpecificationEvents).where(and(eq(schema.businessSpecificationEvents.specificationId, approved.spec.id), eq(schema.businessSpecificationEvents.eventType, 'conflict'), inArray(schema.businessSpecificationEvents.status, ['open', 'escalated']))) : [];
  const review = approved ? (await db.select().from(schema.businessSpecificationEvents).where(and(eq(schema.businessSpecificationEvents.versionId, approved.version.id), eq(schema.businessSpecificationEvents.eventType, 'architect_approval'))).limit(1))[0] : null;
  return enforcePolicy({ category: 'specification', action: 'build', deploymentId, actorId, facts: { approvedVersionId: approved?.version.id, taskVersionId: versionId, architectReviewId: review?.id, unresolvedConflicts: conflicts.length > 0 } });
}
