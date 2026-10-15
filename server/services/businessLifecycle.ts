import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, generateId, createDeployment, enqueueDeploymentQueueItem } from '../db';
import * as schema from '../../drizzle/schema';
import { activePolicy, enforcePolicy, Principal, requirePolicyPermission } from './policyEngine';
import { createLifecycleRecord, recordLifecycleEvent } from './infrastructure';
import { auditOperation, consumeApproval, emergencyStopped, requestApproval, requireBusinessOwner, runAgent, validApproval } from './execution';
import { callLLM, callLLMJson } from './llm';
import { minorUnits } from './profitAccounting';
import { createQuotedPayment } from './crypto';
import { evaluateGapPromotion } from './discoveryPolicy';
import { ensureApprovedSpecification } from './specificationGovernance';

async function lifecycle(deploymentId: string) {
  let record = (await db.select().from(schema.businessLifecycleRecords).where(eq(schema.businessLifecycleRecords.deploymentId, deploymentId)).orderBy(desc(schema.businessLifecycleRecords.createdAt)).limit(1))[0];
  if (!record) { await createLifecycleRecord({ deploymentId, state: 'monitoring' }); record = (await db.select().from(schema.businessLifecycleRecords).where(eq(schema.businessLifecycleRecords.deploymentId, deploymentId)).limit(1))[0]; }
  return record;
}
export async function setDeadline(actor: Principal, deploymentId: string) {
  await requirePolicyPermission(actor, 'lifecycle.manage');
  return persistConfiguredDeadline(actor.id, deploymentId);
}
export async function initializeLaunchedDeadline(deploymentId: string) {
  const record = await lifecycle(deploymentId);
  if (record.deadlineAt || record.state !== 'monitoring') return;
  const release = (await db.select({ id: schema.releaseAuthorizations.id }).from(schema.releaseAuthorizations).where(and(eq(schema.releaseAuthorizations.deploymentId, deploymentId), eq(schema.releaseAuthorizations.status, 'deployed'))).limit(1))[0];
  if (!release) return;
  return persistConfiguredDeadline('system:activation', deploymentId);
}
export async function reviewActivationDeadline(deploymentId: string) {
  return persistConfiguredDeadline('system:activation', deploymentId, false);
}
async function persistConfiguredDeadline(actorId: string, deploymentId: string, persist = true) {
  const policy = await activePolicy('deadlines', deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: deadlines.');
  const config = JSON.parse(policy.configJson);
  if (!Number.isInteger(config.initialDays) || !config.industry || !config.complexity) throw new Error('Configured industry, complexity and deadline required.');
  const record = await lifecycle(deploymentId);
  if (record.deadlineAt) { if (!persist) return { deadlineAt: record.deadlineAt }; throw new Error('Existing deadlines require a governed extension; they cannot be reset.'); }
  if (record.state !== 'monitoring') throw new Error('Only a monitoring business can receive an initial deadline.');
  const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
  if (!business) throw new Error('Deadline business workspace is unavailable.');
  const reviews = [];
  for (const role of ['finance', 'ceo_strategy']) {
    const review = await runAgent(role, deploymentId, 'deadline_review', `deadline:${record.id}:${policy.id}:${role}`, async () => {
      const assessment = await callLLMJson(`Assess this administrator-configured business deadline: ${JSON.stringify({ industry: config.industry, complexity: config.complexity, days: config.initialDays, businessPlan: business.businessPlan, costPerDay: business.costPerDay })}. Return {rationale:string, concerns:string[]}. Distinguish cost estimates from verified accounts. Do not invent a deadline or approve spending.`, { task: 'JSON_GENERATION' });
      return z.object({ rationale: z.string().min(1), concerns: z.array(z.string()) }).parse(assessment);
    });
    reviews.push({ role, executionId: review.executionId, ...review.value });
  }
  const reviewResourceId = `${record.id}:${policy.id}`;
  const needsSupervisor = reviews.some(review => review.concerns.length);
  const approval = needsSupervisor ? await validApproval({ deploymentId, action: 'deadline', resourceId: reviewResourceId, authority: 'supervisor' }) : null;
  await enforcePolicy({ category: 'deadlines', action: 'set_deadline', versionId: policy.id, deploymentId, actorId, facts: { financeExecutionId: reviews[0].executionId, strategyExecutionId: reviews[1].executionId, assessmentAccepted: !needsSupervisor || Boolean(approval), needsSupervisor, supervisorApprovalId: approval?.id, reviewResourceId, days: config.initialDays, industry: config.industry, complexity: config.complexity } });
  if (!persist) return { deadlineAt: null, reviewedDays: config.initialDays, policyVersionId: policy.id };
  const deadlineAt = new Date(Date.now() + config.initialDays * 86400000);
  const updated = await db.update(schema.businessLifecycleRecords).set({ deadlineAt, deadlinePolicyStatus: 'configured', updatedAt: new Date() }).where(and(eq(schema.businessLifecycleRecords.id, record.id), eq(schema.businessLifecycleRecords.state, 'monitoring'), isNull(schema.businessLifecycleRecords.deadlineAt)));
  if (!(updated[0] as any).affectedRows) throw new Error('Deadline or lifecycle changed during assessment. Existing persisted deadlines were preserved.');
  await recordLifecycleEvent({ lifecycleId: record.id, eventType: 'deadline_set', detail: `Deadline ${deadlineAt.toISOString()}`, metadata: { policyVersionId: policy.id, reviews, actorId } });
  return { deadlineAt };
}
export async function evaluateBusiness(deploymentId: string) {
  const record = await lifecycle(deploymentId);
  if (record.state === 'closed') return { state: 'closed', record };
  const policy = await activePolicy('deadlines', deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: success evaluation.');
  const config = JSON.parse(policy.configJson);
  const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
  const periods = await db.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.deploymentId, deploymentId)).orderBy(desc(schema.accountingPeriods.endsAt)).limit(config.profitabilityPeriods || 1);
  const customers = await db.select().from(schema.customers).where(and(eq(schema.customers.deploymentId, deploymentId), eq(schema.customers.status, 'active')));
  const reviews = business ? await db.select().from(schema.gapPolicyReviews).where(eq(schema.gapPolicyReviews.gapId, business.gapId)).orderBy(desc(schema.gapPolicyReviews.createdAt)).limit(1) : [];
  const metrics = { reconciledPeriods: periods.filter(period => period.reconciledAt && period.status !== 'disputed').map(period => JSON.parse(period.calculationJson!)), customerCount: customers.length, demand: reviews[0] ? Number(reviews[0].demandScore) : null };
  const evaluations = [];
  for (const role of ['finance', 'ceo_strategy', 'analytics']) {
    const evaluation = await runAgent(role, deploymentId, 'deadline_review', `success:${record.id}:${periods[0]?.id || 'none'}:${customers.length}:${new Date().toISOString().slice(0, 10)}`, async () => {
      const analysis = await callLLMJson(`Assess business sustainability and recovery using only these verified metrics. Return {sustainabilityScore:number,recoveryPotential:boolean,rationale:string,uncertainties:string[]}. ${JSON.stringify(metrics)}`, { task: 'JSON_GENERATION' });
      return z.object({ sustainabilityScore: z.number().finite(), recoveryPotential: z.boolean(), rationale: z.string().min(1), uncertainties: z.array(z.string()) }).parse(analysis);
    });
    evaluations.push({ role, executionId: evaluation.executionId, ...evaluation.value });
  }
  const growth = customers.filter(customer => periods[0] && customer.createdAt >= periods[0].startsAt).length;
  if (!Number.isInteger(config.profitabilityPeriods) || config.profitabilityPeriods < 1) throw new Error('POLICY_NOT_CONFIGURED: consistent profitability period count.');
  const success = periods.length >= config.profitabilityPeriods && periods.every(period => period.reconciledAt && period.status !== 'disputed') && metrics.reconciledPeriods.length >= config.profitabilityPeriods && metrics.reconciledPeriods.every(period => Number(period.netProfit) > 0 && Number(period.netProfit) >= config.profitabilityThreshold) && growth >= config.customerGrowthThreshold && metrics.demand !== null && metrics.demand >= config.demandThreshold && evaluations.every(evaluation => evaluation.sustainabilityScore >= config.sustainabilityThreshold && evaluation.uncertainties.length === 0);
  await recordLifecycleEvent({ lifecycleId: record.id, eventType: 'success_evaluated', status: success ? 'successful' : 'monitoring', detail: success ? 'Configured success requirements met.' : 'Success requirements not met or evidence incomplete.', metadata: { metrics, growth, evaluations, policyVersionId: policy.id } });
  if (success && record.state !== 'suspended') await db.update(schema.businessLifecycleRecords).set({ state: 'successful', updatedAt: new Date() }).where(eq(schema.businessLifecycleRecords.id, record.id));
  else if (!success && !['suspended', 'successful'].includes(record.state) && record.deadlineAt && record.deadlineAt.getTime() <= Date.now()) await suspendBusiness('system:lifecycle', deploymentId, 'Deadline expired without verified success or an applied extension.');
  return { success, metrics, evaluations, record };
}
export async function offerExtension(actor: Principal, deploymentId: string, price: string, currency: string, expiresAt: Date) {
  await requirePolicyPermission(actor, 'lifecycle.manage');
  const policy = await activePolicy('deadlines', deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: extension.');
  const config = JSON.parse(policy.configJson);
  const record = await lifecycle(deploymentId);
  const old = await db.select().from(schema.extensionOffers).where(eq(schema.extensionOffers.deploymentId, deploymentId));
  if (record.state === 'closed' || old.filter(offer => ['applied', 'accepted'].includes(offer.status)).length >= config.maximumExtensions || !Number.isInteger(config.maximumExtensions)) throw new Error('Maximum extension count reached or not configured.');
  if (minorUnits(price) < minorUnits(Number(config.minimumExtensionPrice).toFixed(2)) || minorUnits(price) > minorUnits(Number(config.maximumExtensionPrice).toFixed(2)) || expiresAt.getTime() <= Date.now()) throw new Error('Offer outside configured price or expiry boundaries.');
  const assessment = await evaluateBusiness(deploymentId);
  if (assessment.success || !assessment.evaluations?.every(review => review.recoveryPotential && !review.uncertainties.length)) throw new Error('Extension lacks justified recovery evidence.');
  const id = generateId();
  await db.insert(schema.extensionOffers).values({ id, deploymentId, lifecycleId: record.id, price, currency, durationDays: config.extensionDays, expiresAt, status: 'offered', assessmentJson: JSON.stringify({ ...assessment, policyVersionId: policy.id }) });
  await auditOperation(actor.id, 'extension_offered', id, { price, currency, expiresAt, durationDays: config.extensionDays }, deploymentId);
  return id;
}
export async function purchaseExtension(actor: Principal, id: string, payCurrency?: string) {
  const offer = (await db.select().from(schema.extensionOffers).where(eq(schema.extensionOffers.id, id)).limit(1))[0];
  if (!offer || offer.status !== 'offered' || offer.expiresAt.getTime() <= Date.now()) throw new Error('Valid open extension offer required.');
  await requireBusinessOwner(actor, offer.deploymentId);
  const approval = await validApproval({ deploymentId: offer.deploymentId, action: 'extension', resourceId: id, authority: 'supervisor' });
  if (!approval) throw new Error('Supervisor approval is required for the recovery assessment.');
  const payment = await createQuotedPayment({ deploymentId: offer.deploymentId, amount: offer.price, currency: offer.currency, purpose: 'extension', resourceId: id, payCurrency });
  await db.update(schema.extensionOffers).set({ status: 'accepted', acceptedBy: actor.id, paymentId: payment.id }).where(and(eq(schema.extensionOffers.id, id), eq(schema.extensionOffers.status, 'offered')));
  await auditOperation(actor.id, 'extension_accepted', id, { paymentId: payment.id }, offer.deploymentId);
  return payment;
}
export async function applyPaidExtension(id: string) {
  return db.transaction(async tx => {
    const offer = (await tx.select().from(schema.extensionOffers).where(eq(schema.extensionOffers.id, id)).for('update'))[0];
    if (!offer) throw new Error('Extension offer not found.');
    if (offer.status === 'applied') return offer;
    if (offer.status !== 'accepted' || !offer.paymentId || !offer.acceptedBy || offer.expiresAt.getTime() <= Date.now()) throw new Error('Accepted and unexpired paid offer required.');
    const payment = (await tx.select().from(schema.payments).where(eq(schema.payments.id, offer.paymentId)).for('update'))[0];
    if (payment?.status !== 'paid' || payment.deploymentId !== offer.deploymentId || payment.amount !== offer.price || payment.currency.toUpperCase() !== offer.currency) throw new Error('Matching canonical verified extension payment required.');
    const purpose = (await tx.select().from(schema.operationalEvents).where(and(eq(schema.operationalEvents.resourceId, payment.id), eq(schema.operationalEvents.type, 'payment_purpose'))).limit(1))[0];
    if (!purpose || JSON.parse(purpose.detailJson).purpose !== 'extension' || JSON.parse(purpose.detailJson).resourceId !== offer.id) throw new Error('Payment must be bound to this exact extension offer.');
    const record = (await tx.select().from(schema.businessLifecycleRecords).where(eq(schema.businessLifecycleRecords.id, offer.lifecycleId)).for('update'))[0];
    const extensions = await tx.select().from(schema.extensionOffers).where(and(eq(schema.extensionOffers.deploymentId, offer.deploymentId), eq(schema.extensionOffers.status, 'applied')));
    const originalPolicyId = JSON.parse(offer.assessmentJson).policyVersionId;
    const policy = originalPolicyId ? (await tx.select().from(schema.policyVersions).where(and(eq(schema.policyVersions.id, originalPolicyId), eq(schema.policyVersions.category, 'deadlines'))).limit(1))[0] : null;
    const approval = await validApproval({ deploymentId: offer.deploymentId, action: 'extension', resourceId: id, authority: 'supervisor' });
    await enforcePolicy({ category: 'deadlines', action: 'extension', versionId: policy?.id, deploymentId: offer.deploymentId, actorId: offer.acceptedBy, facts: { recoveryAssessmentId: offer.id, supervisorApprovalId: approval?.id, extensionsUsed: extensions.length, price: Number(offer.price), userAcceptanceId: offer.acceptedBy, verifiedPaymentId: payment.id } });
    if (!policy || record.state === 'closed') throw new Error('Closed businesses cannot be extended.');
    const deadlineAt = new Date(Math.max(record.deadlineAt?.getTime() || 0, Date.now()) + offer.durationDays * 86400000);
    const suspension = (await tx.select().from(schema.businessLifecycleEvents).where(and(eq(schema.businessLifecycleEvents.lifecycleId, record.id), eq(schema.businessLifecycleEvents.eventType, 'suspended'))).orderBy(desc(schema.businessLifecycleEvents.createdAt)).limit(1))[0];
    const deadlineSuspension = record.state === 'suspended' && suspension?.detail === 'Deadline expired without verified success or an applied extension.' && !await emergencyStopped();
    const business = (await tx.select().from(schema.deployments).where(eq(schema.deployments.id, offer.deploymentId)).for('update'))[0];
    const canResume = deadlineSuspension && business.banRisk !== 'high' && business.health !== 'critical';
    await tx.update(schema.businessLifecycleRecords).set({ deadlineAt, state: record.state === 'suspended' && !canResume ? 'suspended' : 'monitoring', updatedAt: new Date() }).where(eq(schema.businessLifecycleRecords.id, record.id));
    if (canResume) {
      const provider = (await tx.select({ id: schema.deploymentProviders.id }).from(schema.deploymentProviders).where(and(eq(schema.deploymentProviders.deploymentId, business.id), eq(schema.deploymentProviders.status, 'active'))).limit(1))[0];
      await tx.update(schema.deployments).set({ status: provider ? 'active' : 'paused', updatedAt: new Date() }).where(eq(schema.deployments.id, business.id));
    }
    await tx.update(schema.extensionOffers).set({ status: 'applied' }).where(eq(schema.extensionOffers.id, id));
    await tx.insert(schema.businessLifecycleEvents).values({ id: generateId(), lifecycleId: record.id, eventType: 'extension_applied', status: 'applied', detail: `Paid extension applied until ${deadlineAt.toISOString()}`, metadataJson: JSON.stringify({ offerId: id, paymentId: payment.id, policyVersionId: policy.id }) });
    return { ...offer, deadlineAt };
  });
}
export async function suspendBusiness(actorId: string, deploymentId: string, reason: string) {
  await enforcePolicy({ category: 'shutdown', action: 'suspend', deploymentId, actorId, facts: { reason } });
  const record = await lifecycle(deploymentId);
  if (record.state === 'closed') return;
  await db.transaction(async tx => {
    await tx.update(schema.deployments).set({ status: 'paused', updatedAt: new Date() }).where(eq(schema.deployments.id, deploymentId));
    await tx.update(schema.businessLifecycleRecords).set({ state: 'suspended', updatedAt: new Date() }).where(eq(schema.businessLifecycleRecords.id, record.id));
    await tx.update(schema.agentTasks).set({ state: 'cancelled', errorMessage: `Business safely suspended: ${reason}`, updatedAt: new Date() }).where(and(eq(schema.agentTasks.deploymentId, deploymentId), inArray(schema.agentTasks.state, ['pending', 'ready', 'waiting_for_dependencies', 'running', 'blocked_by_policy'])));
    const business = (await tx.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
    await tx.update(schema.queueItems).set({ status: 'paused', workerId: null, nextRetryAt: null, lastError: reason, updatedAt: new Date() }).where(and(eq(schema.queueItems.gapId, business.gapId), inArray(schema.queueItems.status, ['pending', 'processing'])));
    await tx.update(schema.adCampaigns).set({ status: 'PAUSED', updatedAt: new Date() }).where(and(eq(schema.adCampaigns.deploymentId, deploymentId), inArray(schema.adCampaigns.status, ['ACTIVE', 'APPROVED', 'READY_TO_PUBLISH'])));
    await tx.insert(schema.businessLifecycleEvents).values({ id: generateId(), lifecycleId: record.id, eventType: 'suspended', status: 'suspended', detail: reason, metadataJson: JSON.stringify({ actorId, resourcesRetained: true }) });
    await tx.insert(schema.operationalEvents).values({ id: generateId(), actorId, deploymentId, type: 'user_notification', resourceId: record.id, detailJson: JSON.stringify({ reason, businessUserId: business.userId, delivery: 'in_app', permanentClosure: false }) });
  });
}
export async function resumeSuspendedBusiness(actor: Principal, deploymentId: string, reason: string) {
  await requirePolicyPermission(actor, 'approvals.supervisor');
  if (!reason.trim() || await emergencyStopped()) throw new Error('Supervisor rationale and an inactive emergency stop are required.');
  const record = await lifecycle(deploymentId);
  if (record.state !== 'suspended') throw new Error('Only a suspended business can use governed resumption; closed businesses require a fresh build.');
  if (record.deadlineAt && record.deadlineAt.getTime() <= Date.now()) throw new Error('Expired deadlines require an accepted paid extension or verified success.');
  const { gapPolicyAssessment } = await import('./discoveryPolicy');
  const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
  const assessment = await gapPolicyAssessment(business.gapId);
  if (assessment.legalState !== 'legal' || !assessment.legalReviewId || (business.banRisk === 'high' && assessment.review!.createdAt <= record.updatedAt)) throw new Error('Verified legal clearance after any serious legal-risk suspension is required.');
  const provider = (await db.select().from(schema.deploymentProviders).where(and(eq(schema.deploymentProviders.deploymentId, deploymentId), eq(schema.deploymentProviders.status, 'active'))).limit(1))[0];
  const releases = await db.select().from(schema.releaseAuthorizations).where(and(eq(schema.releaseAuthorizations.deploymentId, deploymentId), eq(schema.releaseAuthorizations.status, 'deployed')));
  const config = provider?.providerConfig ? typeof provider.providerConfig === 'string' ? JSON.parse(provider.providerConfig) : provider.providerConfig : null;
  const release = releases.find(release => JSON.parse(release.evidenceJson).externalDeploymentId === config?.vercelDeploymentId);
  if (!provider?.deploymentUrl || !release) throw new Error('The current provider artifact needs persisted independent pre/post QC evidence before resumption.');
  const financePolicy = await activePolicy('finance', deploymentId);
  const currency = financePolicy ? JSON.parse(financePolicy.configJson).currency : null;
  if (!currency || !await validApproval({ deploymentId, action: 'profit_share', resourceId: deploymentId, authority: 'user', currency })) throw new Error('Current owner profit-share authorization is required before resumption.');
  const shutdown = await activePolicy('shutdown', deploymentId);
  if (!shutdown) throw new Error('POLICY_NOT_CONFIGURED: shutdown recovery.');
  const threshold = JSON.parse(shutdown.configJson).lossSuspensionThreshold;
  const periods = await db.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.deploymentId, deploymentId)).orderBy(desc(schema.accountingPeriods.endsAt)).limit(1);
  if (periods[0]?.status === 'disputed' || (threshold !== null && periods[0]?.calculationJson && Number(JSON.parse(periods[0].calculationJson).closingLoss) >= threshold)) throw new Error('Financial suspension remains unresolved.');
  const { verifyPublicUrl } = await import('./vercel');
  const health = await verifyPublicUrl(provider.deploymentUrl);
  if (!health.reachable || health.gated) throw new Error('Current public provider health could not be verified.');
  const supervisorDecisionId = await auditOperation(actor.id, 'supervisor_resumption_approved', record.id, { reason, releaseId: release.id, legalReviewId: assessment.legalReviewId, providerHealth: health, application: 'immediate_verified_resumption_only' }, deploymentId);
  await enforcePolicy({ category: 'shutdown', action: 'resume', deploymentId, actorId: actor.id, facts: { supervisorDecisionId, legalReviewId: assessment.legalReviewId, qcReleaseId: release.id, providerVerified: true, obligationsPreserved: true } });
  await db.transaction(async tx => {
    const current = (await tx.select().from(schema.businessLifecycleRecords).where(eq(schema.businessLifecycleRecords.id, record.id)).for('update'))[0];
    if (current.state !== 'suspended' || current.updatedAt.getTime() !== record.updatedAt.getTime()) throw new Error('Suspension changed during review. Re-evaluate current risks.');
    await tx.update(schema.businessLifecycleRecords).set({ state: 'monitoring', updatedAt: new Date() }).where(eq(schema.businessLifecycleRecords.id, record.id));
    await tx.update(schema.deployments).set({ status: 'active', health: 'healthy', banRisk: 'low', updatedAt: new Date() }).where(eq(schema.deployments.id, deploymentId));
    await tx.insert(schema.businessLifecycleEvents).values({ id: generateId(), lifecycleId: record.id, eventType: 'supervisor_resumption', status: 'monitoring', detail: reason, metadataJson: JSON.stringify({ supervisorId: actor.id, releaseId: release.id, legalReviewId: assessment.legalReviewId, providerHealth: health, campaignsRemainPaused: true }) });
  });
  await auditOperation(actor.id, 'business_resumed', record.id, { reason, releaseId: release.id, automaticSpending: false }, deploymentId);
}
export async function closeBusiness(actor: Principal, deploymentId: string, reason: string, approvalExpiresAt?: Date) {
  await requirePolicyPermission(actor, 'lifecycle.manage');
  const record = await lifecycle(deploymentId);
  if (record.state !== 'suspended') throw new Error('Business must be safely suspended before closure.');
  const review = await runAgent('operations', deploymentId, 'lifecycle', `closure-assessment:${record.id}:${record.updatedAt.toISOString()}`, async () => {
    const customers = await db.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.deploymentId, deploymentId), eq(schema.customers.status, 'active')));
    const settlements = await db.select({ id: schema.settlementRecords.id, status: schema.settlementRecords.status, amount: schema.settlementRecords.amount }).from(schema.settlementRecords).where(eq(schema.settlementRecords.deploymentId, deploymentId));
    return { reason, customers, settlements, obligationsResolved: !customers.length && settlements.every(settlement => minorUnits(settlement.amount) === 0n || ['paid', 'reconciled', 'cancelled', 'superseded_by_correction'].includes(settlement.status)) };
  });
  const requests = await db.select().from(schema.approvals).where(and(eq(schema.approvals.deploymentId, deploymentId), eq(schema.approvals.action, 'closure'), eq(schema.approvals.resourceId, record.id)));
  for (const authority of ['supervisor', 'user'] as const) {
    if (approvalExpiresAt && !requests.some(request => request.authority === authority && ['pending', 'approved'].includes(request.status) && request.expiresAt.getTime() > Date.now())) {
      await requestApproval(actor, { deploymentId, action: 'closure', resourceId: record.id, authority, risk: 'high', expiresAt: approvalExpiresAt, scope: { irreversibleDeletion: false, recordsRetained: true, operationsExecutionId: review.executionId, reason } });
    }
  }
  const supervisor = await validApproval({ deploymentId, action: 'closure', resourceId: record.id, authority: 'supervisor' });
  const owner = await validApproval({ deploymentId, action: 'closure', resourceId: record.id, authority: 'user' });
  const customers = await db.select().from(schema.customers).where(and(eq(schema.customers.deploymentId, deploymentId), eq(schema.customers.status, 'active')));
  const unsettled = await db.select().from(schema.settlementRecords).where(eq(schema.settlementRecords.deploymentId, deploymentId));
  const pendingExtensions = await db.select({ id: schema.extensionOffers.id }).from(schema.extensionOffers).where(and(eq(schema.extensionOffers.deploymentId, deploymentId), inArray(schema.extensionOffers.status, ['accepted', 'payment_exception'])));
  const accountingExceptions = await db.select({ id: schema.accountingItems.id }).from(schema.accountingItems).where(and(eq(schema.accountingItems.deploymentId, deploymentId), or(eq(schema.accountingItems.disputed, true), isNull(schema.accountingItems.verifiedAt)))).limit(1);
  const obligationsResolved = customers.length === 0 && pendingExtensions.length === 0 && accountingExceptions.length === 0 && unsettled.every(settlement => minorUnits(settlement.amount) === 0n || ['paid', 'reconciled', 'cancelled', 'superseded_by_correction'].includes(settlement.status));
  const events = await db.select().from(schema.businessLifecycleEvents).where(eq(schema.businessLifecycleEvents.lifecycleId, record.id)).orderBy(desc(schema.businessLifecycleEvents.createdAt), desc(schema.businessLifecycleEvents.id)).limit(100);
  const eventCount = (await db.select({ count: sql<number>`COUNT(*)` }).from(schema.businessLifecycleEvents).where(eq(schema.businessLifecycleEvents.lifecycleId, record.id)))[0].count;
  const report = { reason, businessId: deploymentId, outcomes: events, totalOutcomeEvents: Number(eventCount), history: 'Latest 100 events shown; the complete immutable history remains available through paginated lifecycle activity.', retainedObligations: { customers: customers.map(customer => customer.id), settlements: unsettled.map(settlement => ({ id: settlement.id, status: settlement.status })), unresolvedExtensionOffers: pendingExtensions.map(offer => offer.id), unresolvedAccounting: accountingExceptions.map(item => item.id) }, generatedAt: new Date().toISOString() };
  const notification = (await db.select().from(schema.operationalEvents).where(and(eq(schema.operationalEvents.deploymentId, deploymentId), eq(schema.operationalEvents.type, 'user_notification'))).limit(1))[0];
  await enforcePolicy({ category: 'shutdown', action: 'closure', deploymentId, actorId: actor.id, facts: { supervisorApprovalId: supervisor?.id, userAuthorizationId: owner?.id, notificationId: notification?.id, obligationsResolved, finalReportId: record.id } });
  if (owner) await consumeApproval(owner.id, `closure:${record.id}`);
  await db.transaction(async tx => {
    await tx.update(schema.businessLifecycleRecords).set({ state: 'closed', finalReportJson: JSON.stringify(report), updatedAt: new Date() }).where(eq(schema.businessLifecycleRecords.id, record.id));
    await tx.update(schema.deployments).set({ status: 'stopped', updatedAt: new Date() }).where(eq(schema.deployments.id, deploymentId));
    await tx.insert(schema.businessLifecycleEvents).values({ id: generateId(), lifecycleId: record.id, eventType: 'closed', status: 'closed', detail: reason, metadataJson: JSON.stringify({ supervisorApprovalId: supervisor?.id, ownerAuthorizationId: owner?.id, recordsRetained: true }) });
    await tx.insert(schema.operationalEvents).values({ id: generateId(), actorId: actor.id, deploymentId, type: 'closure_report_completed', resourceId: record.id, detailJson: JSON.stringify({ reason, finalReportId: record.id, historicalRecordsPreserved: true }) });
  });
  try { await analyzeClosedBusiness(actor, deploymentId); } catch (error: any) { await auditOperation(actor.id, 'learning_analysis_pending', record.id, { reason: error.message, closureCompleted: true }, deploymentId); }
}
export async function analyzeClosedBusiness(actor: Principal, deploymentId: string) {
  await requirePolicyPermission(actor, 'lifecycle.manage');
  const record = await lifecycle(deploymentId);
  if (record.state !== 'closed' || !record.finalReportJson) throw new Error('A retained final closure report is required for outcome analysis.');
  const requestId = generateId();
  const report = JSON.parse(record.finalReportJson);
  const context = { reason: report.reason, totalOutcomeEvents: report.totalOutcomeEvents, outcomes: (report.outcomes || []).map((event: any) => ({ reference: event.id, type: event.eventType, status: event.status, detailExcerpt: String(event.detail || '').slice(0, 2000) })), limitations: ['Historical report excerpts are not fresh market evidence or authorization. Full source history is retained for review.'] };
  const analyses = [];
  for (const [role, tool] of [['finance', 'finance'], ['ceo_strategy', 'strategy'], ['analytics', 'analytics']]) {
    const result = await runAgent(role, deploymentId, tool, `closure-learning:${record.id}:${requestId}:${role}`, async () => z.object({ lessons: z.array(z.string().min(1)).min(1), recommendations: z.array(z.string()), limitations: z.array(z.string()) }).parse(await callLLMJson(`Analyze closed business outcomes as ${role}. Return {lessons:string[],recommendations:string[],limitations:string[]}. Derive generalizable lessons from the retained report only. Do not expose customer identities or credentials, invent fresh market evidence, grant approvals or claim the old business can resume. Report excerpts: ${JSON.stringify(context)}`, { task: 'JSON_GENERATION' })));
    analyses.push({ role, executionId: result.executionId, agentId: result.agentId, ...result.value });
  }
  await auditOperation(actor.id, 'lessons_learned', record.id, { analyses, historicalOnly: true, currentDiscoveryEvidence: false, finalReportId: record.id }, deploymentId);
  return { analyses, historicalOnly: true };
}
export async function restartBusiness(actor: Principal, deploymentId: string, freshGapId: string) {
  await requirePolicyPermission(actor, 'lifecycle.manage');
  const record = await lifecycle(deploymentId);
  const old = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
  const gap = (await db.select().from(schema.gaps).where(eq(schema.gaps.id, freshGapId)).limit(1))[0];
  if (record.state !== 'closed' || !gap || !old || old.gapId === freshGapId || gap.createdAt <= record.updatedAt) throw new Error('Restart requires a newly discovered, freshly validated opportunity after closure.');
  const promotion = await evaluateGapPromotion(freshGapId);
  if (promotion.decision !== 'ALLOW') throw new Error(`${promotion.decision}: ${promotion.reason}`);
  const review = (await db.select().from(schema.gapPolicyReviews).where(eq(schema.gapPolicyReviews.gapId, freshGapId)).orderBy(desc(schema.gapPolicyReviews.createdAt)).limit(1))[0];
  await enforcePolicy({ category: 'shutdown', action: 'restart', deploymentId, gapId: freshGapId, actorId: actor.id, facts: { oldBusinessClosed: record.state === 'closed', freshGapId, freshLegalReviewId: review?.id, discoveredAfterClosure: gap.createdAt > record.updatedAt, freshBuildRequired: true } });
  const business = await createDeployment({ gapId: freshGapId, userId: old.userId || undefined, businessPlan: `Fresh opportunity: ${gap.needs}` });
  const strategy = await runAgent('ceo_strategy', business.id, 'strategy', `restart-plan:${business.id}`, async () => callLLM(`Create a fresh business plan from this newly cleared opportunity. Historical outcomes are lessons only, not current market evidence. Opportunity: ${JSON.stringify(gap)}. Previous report: ${record.finalReportJson || 'No prior report'}`, { task: 'BUSINESS_PLAN' }));
  await db.update(schema.deployments).set({ businessPlan: strategy.value, updatedAt: new Date() }).where(eq(schema.deployments.id, business.id));
  await ensureApprovedSpecification(business.id);
  await createLifecycleRecord({ deploymentId: business.id, gapId: freshGapId, state: 'monitoring' });
  await enqueueDeploymentQueueItem(freshGapId);
  await auditOperation(actor.id, 'fresh_build_restart', business.id, { previousBusinessId: deploymentId, freshGapId, freshSpecificationRequired: true }, business.id);
  return business;
}
