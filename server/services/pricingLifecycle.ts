import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, generateId } from '../db';
import * as schema from '../../drizzle/schema';
import { activePolicy, enforcePolicy, Principal, requirePolicyPermission } from './policyEngine';
import { callLLMJson } from './llm';
import { auditOperation, consumeApproval, runAgent, validApproval } from './execution';
import { minorUnits } from './profitAccounting';
import crypto from 'node:crypto';

const recommendationSchema = z.object({ businessModel: z.string().min(1), amount: z.string().regex(/^\d+\.\d{2}$/), currency: z.string().regex(/^[A-Z]{3}$/), competitorAnalysis: z.string().min(1), willingnessToPay: z.string().min(1), operatingCosts: z.string().min(1), marginAnalysis: z.string().min(1), repeatUsage: z.string().min(1), rationale: z.string().min(1), risk: z.enum(['low', 'high']) });
export function attachGovernedCheckout<T extends { files: { path: string; content: string }[]; entryPoint: string }>(app: T, deploymentId: string): T {
  const configured = process.env.PUBLIC_URL || process.env.FRONTEND_URL;
  if (!configured) return app;
  const origin = new URL(configured);
  if (origin.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && origin.protocol === 'http:')) throw new Error('Governed checkout requires an explicitly configured HTTPS application origin.');
  const url = new URL('/checkout', origin.origin);
  url.searchParams.set('business', deploymentId);
  const link = `<aside id="sao-governed-checkout"><a href="${url.toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">View current approved price and secure checkout</a></aside>`;
  return { ...app, files: app.files.map(file => file.path !== app.entryPoint || file.content.includes('id="sao-governed-checkout"') ? file : { ...file, content: file.content.includes('</body>') ? file.content.replace('</body>', `${link}</body>`) : `${file.content}${link}` }) };
}
export async function currentBusinessPrice(deploymentId: string) {
  return (await db.select().from(schema.priceProposals).where(and(eq(schema.priceProposals.deploymentId, deploymentId), eq(schema.priceProposals.status, 'applied'))).orderBy(desc(schema.priceProposals.appliedAt)).limit(1))[0] || null;
}
export async function enrollFreeCustomer(deploymentId: string, customerUserId: string, quoteId: string) {
  const quote = await currentBusinessPrice(deploymentId);
  if (!quote || quote.id !== quoteId || minorUnits(quote.amount) !== 0n) throw new Error('A current explicitly approved free offer is required.');
  const user = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, customerUserId)).limit(1))[0];
  if (!user) throw new Error('Authenticated customer identity required.');
  const customerId = `customer:${crypto.createHash('sha256').update(`${deploymentId}:${user.id}`).digest('hex')}`;
  const id = `enrollment:${crypto.createHash('sha256').update(`${quoteId}:${user.id}`).digest('hex')}`;
  await db.transaction(async tx => {
    await tx.insert(schema.customers).values({ id: customerId, deploymentId, status: 'active', metadataJson: JSON.stringify({ customerUserId: user.id, source: 'authorized_free_enrollment', obligations: 'preserved_pending_fulfillment' }) }).onDuplicateKeyUpdate({ set: { id: customerId } });
    await tx.insert(schema.salesActivities).values({ id, deploymentId, customerId, activityType: 'free_enrollment', status: 'no_payment_required', attributionJson: JSON.stringify({ priceProposalId: quote.id, agreedAmount: '0.00', currency: quote.currency }) }).onDuplicateKeyUpdate({ set: { id } });
  });
  return { id, deploymentId, amount: '0.00', currency: quote.currency, status: 'no_payment_required', checkoutUrl: null as string | null };
}
export async function recordVerifiedSaleCustomer(paymentId: string) {
  const payment = (await db.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).limit(1))[0];
  const purposeEvent = (await db.select().from(schema.operationalEvents).where(and(eq(schema.operationalEvents.type, 'payment_purpose'), eq(schema.operationalEvents.resourceId, paymentId))).limit(1))[0];
  const purpose = purposeEvent ? JSON.parse(purposeEvent.detailJson) : null;
  if (!payment || payment.status !== 'paid' || purpose?.purpose !== 'business_sale' || !purpose.customerUserId) return;
  const user = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, purpose.customerUserId)).limit(1))[0];
  if (!user) throw new Error('Verified checkout customer identity is unavailable.');
  const customerId = `customer:${crypto.createHash('sha256').update(`${payment.deploymentId}:${user.id}`).digest('hex')}`;
  await db.transaction(async tx => {
    await tx.insert(schema.customers).values({ id: customerId, deploymentId: payment.deploymentId, status: 'active', metadataJson: JSON.stringify({ customerUserId: user.id, source: 'verified_checkout', obligations: 'preserved_pending_fulfillment' }) }).onDuplicateKeyUpdate({ set: { id: customerId } });
    await tx.insert(schema.salesActivities).values({ id: `sale:${payment.id}`, deploymentId: payment.deploymentId, customerId, activityType: 'verified_purchase', status: 'payment_received_obligation_open', attributionJson: JSON.stringify({ paymentId: payment.id, priceProposalId: purpose.resourceId, agreedAmount: payment.amount, currency: payment.currency }) }).onDuplicateKeyUpdate({ set: { id: `sale:${payment.id}` } });
  });
  return customerId;
}
export async function recommendPricing(actor: Principal, deploymentId: string, evidenceIds: string[]) {
  await requirePolicyPermission(actor, 'policies.edit');
  return preparePricingRecommendation(deploymentId, evidenceIds);
}
export async function ensureBusinessModelRecommendation(deploymentId: string) {
  const existing = (await db.select().from(schema.priceProposals).where(eq(schema.priceProposals.deploymentId, deploymentId)).orderBy(desc(schema.priceProposals.createdAt)).limit(1))[0];
  if (existing) return existing;
  const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
  if (!business) throw new Error('Business model workspace is unavailable.');
  const evidence = await db.select({ id: schema.evidenceRecords.id }).from(schema.evidenceRecords).where(and(eq(schema.evidenceRecords.gapId, business.gapId), eq(schema.evidenceRecords.status, 'verified')));
  if (!evidence.length) throw new Error('Verified market evidence is required for initial business-model selection.');
  const id = await preparePricingRecommendation(deploymentId, evidence.map(record => record.id), `initial-business-model:${deploymentId}`);
  return (await db.select().from(schema.priceProposals).where(eq(schema.priceProposals.id, id)).limit(1))[0];
}
async function preparePricingRecommendation(deploymentId: string, evidenceIds: string[], key = `pricing:${generateId()}`) {
  const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
  if (!business) throw new Error('Business not found.');
  const evidence = await db.select().from(schema.evidenceRecords).where(eq(schema.evidenceRecords.gapId, business.gapId));
  const selected = evidence.filter(record => evidenceIds.includes(record.id));
  if (!selected.length || selected.length !== new Set(evidenceIds).size) throw new Error('Business-scoped market evidence is required.');
  const old = await currentBusinessPrice(deploymentId);
  const proposed = await runAgent('business_model_pricing', deploymentId, 'pricing', key, async () => recommendationSchema.parse(await callLLMJson(`Recommend a business model and price based only on this evidence and business plan. Return JSON with businessModel, amount (decimal string), currency (ISO code), competitorAnalysis, willingnessToPay, operatingCosts, marginAnalysis, repeatUsage, rationale, risk (low/high). Uncertainty must be stated.\n${JSON.stringify({ plan: business.businessPlan, evidence: selected.map(record => ({ id: record.id, summary: record.summary, source: record.sourceUrl })), currentPrice: old?.amount })}`, { task: 'JSON_GENERATION' })));
  const reviews = [];
  for (const role of ['marketing', 'finance']) {
    const review = await runAgent(role, deploymentId, 'pricing_review', `pricing-review:${proposed.executionId}:${role}`, async () => {
      const result = await callLLMJson<{ recommendation: string; concerns: string[] }>(`Review this pricing proposal as ${role}. Return recommendation (string) and concerns (array of strings). ${JSON.stringify(proposed.value)}`, { task: 'JSON_GENERATION' });
      return z.object({ recommendation: z.string().min(1), concerns: z.array(z.string()) }).parse(result);
    }, { dependsOnTaskIds: [proposed.taskId] });
    reviews.push({ role, executionId: review.executionId, ...review.value });
  }
  const id = `price:${proposed.executionId}`;
  await db.insert(schema.priceProposals).values({ id, deploymentId, amount: proposed.value.amount, currency: proposed.value.currency, previousId: old?.id || null, risk: proposed.value.risk === 'high' || reviews.some(review => review.concerns.length) || !old ? 'high' : 'low', status: 'proposed', recommendationJson: JSON.stringify({ ...proposed.value, reviews, pricingExecutionId: proposed.executionId }), evidenceIdsJson: JSON.stringify(evidenceIds) }).onDuplicateKeyUpdate({ set: { id } });
  await auditOperation(proposed.agentId, 'pricing_proposed', id, { executionId: proposed.executionId, reviewers: reviews.map(review => review.executionId) }, deploymentId);
  const saved = (await db.select().from(schema.priceProposals).where(eq(schema.priceProposals.id, id)).limit(1))[0];
  const policy = await activePolicy('pricing', deploymentId);
  if (saved.risk === 'low' && policy && JSON.parse(policy.configJson).automaticChanges === true) {
    try { await applyPriceChange(proposed.agentId, id); } catch (error: any) { await auditOperation(proposed.agentId, 'pricing_change_blocked', id, { reason: error.message }, deploymentId); }
  }
  return id;
}
export async function applyPricing(actor: Principal, id: string) {
  await requirePolicyPermission(actor, 'policies.edit');
  return applyPriceChange(actor.id, id);
}
async function applyPriceChange(actorId: string, id: string) {
  const proposal = (await db.select().from(schema.priceProposals).where(eq(schema.priceProposals.id, id)).limit(1))[0];
  if (!proposal || proposal.status !== 'proposed') throw new Error('Unapplied pricing proposal required.');
  const current = await currentBusinessPrice(proposal.deploymentId);
  const policy = await activePolicy('pricing', proposal.deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: pricing.');
  const config = JSON.parse(policy.configJson);
  const finance = await activePolicy('finance', proposal.deploymentId);
  if (!finance || JSON.parse(finance.configJson).currency !== proposal.currency) throw new Error('Pricing must use the explicitly configured accounting currency; implicit conversion is unavailable.');
  const approval = await validApproval({ deploymentId: proposal.deploymentId, action: 'price_change', resourceId: id, authority: 'supervisor' });
  const previous = current ? minorUnits(current.amount) : 0n;
  const changePercent = previous > 0n ? Number((minorUnits(proposal.amount) - previous) * 10000n / previous) / 100 : 0;
  if (current && proposal.currency !== current.currency) throw new Error('Currency conversion and existing commitments require a separately approved product migration.');
  const committedCustomers = await db.select().from(schema.customers).where(eq(schema.customers.deploymentId, proposal.deploymentId));
  const affectedTransactions = await db.select({ id: schema.payments.id }).from(schema.payments).where(eq(schema.payments.deploymentId, proposal.deploymentId));
  await enforcePolicy({ category: 'pricing', action: 'price_change', deploymentId: proposal.deploymentId, actorId, facts: { marketEvidenceId: JSON.parse(proposal.evidenceIdsJson)[0], commitmentsPreserved: true, highRisk: proposal.risk === 'high' || !current || (minorUnits(current.amount) === 0n && minorUnits(proposal.amount) > 0n), changePercent, hoursSinceChange: current?.appliedAt ? (Date.now() - current.appliedAt.getTime()) / 3600000 : config.minimumChangeIntervalHours, supervisorApprovalId: approval?.id, preservedCustomerIds: committedCustomers.map(customer => customer.id), preservedTransactionIds: affectedTransactions.map(payment => payment.id) } });
  if (approval) await consumeApproval(approval.id, `price:${id}`);
  await db.transaction(async tx => {
    await tx.select().from(schema.deployments).where(eq(schema.deployments.id, proposal.deploymentId)).for('update');
    const active = (await tx.select().from(schema.priceProposals).where(and(eq(schema.priceProposals.deploymentId, proposal.deploymentId), eq(schema.priceProposals.status, 'applied'))).limit(1))[0];
    if ((active?.id || null) !== proposal.previousId) throw new Error('Price changed concurrently; create a new proposal.');
    if (active) await tx.update(schema.priceProposals).set({ status: 'superseded' }).where(eq(schema.priceProposals.id, active.id));
    await tx.update(schema.priceProposals).set({ status: 'applied', appliedAt: new Date() }).where(and(eq(schema.priceProposals.id, id), eq(schema.priceProposals.status, 'proposed')));
    await tx.insert(schema.operationalEvents).values({ id: generateId(), actorId, type: 'pricing_applied', resourceId: id, deploymentId: proposal.deploymentId, detailJson: JSON.stringify({ previousId: active?.id, approvalId: approval?.id, policyVersionId: policy.id, appliesTo: 'new_quotes_only' }) });
  });
}
export async function reviewAutomaticPricing(deploymentId: string) {
  const policy = await activePolicy('pricing', deploymentId);
  const config = policy ? JSON.parse(policy.configJson) : null;
  const current = await currentBusinessPrice(deploymentId);
  if (!config?.automaticChanges || !current?.appliedAt || (Date.now() - current.appliedAt.getTime()) / 3600000 < config.minimumChangeIntervalHours) return;
  const pending = (await db.select().from(schema.priceProposals).where(and(eq(schema.priceProposals.deploymentId, deploymentId), eq(schema.priceProposals.status, 'proposed'))).limit(1))[0];
  if (pending) {
    if (pending.risk !== 'low') return;
    const executionId = JSON.parse(pending.recommendationJson).pricingExecutionId;
    const source = executionId ? (await db.select().from(schema.taskExecutions).where(and(eq(schema.taskExecutions.id, executionId), eq(schema.taskExecutions.status, 'completed'))).limit(1))[0] : null;
    if (source) await applyPriceChange(source.agentId, pending.id);
    return;
  }
  const business = (await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).limit(1))[0];
  if (!business) return;
  const evidence = await db.select({ id: schema.evidenceRecords.id }).from(schema.evidenceRecords).where(and(eq(schema.evidenceRecords.gapId, business.gapId), eq(schema.evidenceRecords.status, 'verified'))).limit(50);
  if (evidence.length) await preparePricingRecommendation(deploymentId, evidence.map(record => record.id));
}
export async function rollbackPricing(actor: Principal, id: string) {
  await requirePolicyPermission(actor, 'policies.edit');
  const old = (await db.select().from(schema.priceProposals).where(eq(schema.priceProposals.id, id)).limit(1))[0];
  if (!old || !['applied', 'superseded'].includes(old.status)) throw new Error('Previously applied price required.');
  const current = await currentBusinessPrice(old.deploymentId);
  const proposalId = generateId();
  await db.insert(schema.priceProposals).values({ ...old, id: proposalId, previousId: current?.id || null, status: 'proposed', risk: 'high', appliedAt: null, createdAt: new Date(), recommendationJson: JSON.stringify({ restoredFrom: id, original: JSON.parse(old.recommendationJson), requiresSupervisor: true }) });
  return proposalId;
}
