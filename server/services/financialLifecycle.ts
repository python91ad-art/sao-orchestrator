import crypto from 'node:crypto';
import { and, asc, desc, eq, gte, lt, lte, isNull, sql } from 'drizzle-orm';
import { db, generateId } from '../db';
import * as schema from '../../drizzle/schema';
import { activePolicy, enforcePolicy, Principal, requirePolicyPermission } from './policyEngine';
import { calculateVerifiedProfit, minorUnits } from './profitAccounting';
import { auditOperation, runAgent, validApproval } from './execution';
import { validatePolicy } from '../../shared/policyContracts';

async function markLateAccounting(deploymentId: string, occurredAt: Date, itemId: string) {
  const periods = await db.select().from(schema.accountingPeriods).where(and(eq(schema.accountingPeriods.deploymentId, deploymentId), gte(schema.accountingPeriods.endsAt, occurredAt))).orderBy(asc(schema.accountingPeriods.startsAt));
  const first = periods.findIndex(period => period.startsAt <= occurredAt && occurredAt < period.endsAt);
  if (first < 0) return;
  for (const period of periods.slice(first)) {
    await db.update(schema.accountingPeriods).set({ status: 'disputed' }).where(eq(schema.accountingPeriods.id, period.id));
    if (period.settlementId) await db.update(schema.settlementRecords).set({ status: 'disputed' }).where(and(eq(schema.settlementRecords.id, period.settlementId), eq(schema.settlementRecords.status, 'transfer_unavailable')));
    await auditOperation('system:accounting', 'settlement_exception', period.id, { reason: 'Late accounting evidence requires reviewed correction of this period and downstream losses.', itemId }, deploymentId);
  }
}
export async function ingestVerifiedPayment(paymentId: string) {
  const payment = (await db.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).limit(1))[0];
  if (!payment || payment.status !== 'paid' || !payment.deploymentId) throw new Error('Canonical verified paid payment required.');
  const purpose = (await db.select().from(schema.operationalEvents).where(and(eq(schema.operationalEvents.type, 'payment_purpose'), eq(schema.operationalEvents.resourceId, paymentId))).limit(1))[0];
  if (purpose && ['extension', 'legacy_sao_payment'].includes(JSON.parse(purpose.detailJson).purpose)) return null;
  const economicKey = crypto.createHash('sha256').update(`payment:${payment.id}:revenue`).digest('hex');
  const id = generateId();
  const conversionRequired = payment.providerType === 'crypto';
  await db.insert(schema.accountingItems).values({ id, deploymentId: payment.deploymentId, paymentId: payment.id, economicKey, kind: 'revenue', amount: payment.amount, currency: payment.currency.toUpperCase(), occurredAt: payment.paidAt || payment.updatedAt || payment.createdAt, verifiedBy: conversionRequired ? null : `payment:${payment.providerType}`, verifiedAt: conversionRequired ? null : new Date(), evidenceJson: JSON.stringify({ paymentId: payment.id, providerReference: payment.providerPaymentId, currencyReconciliationRequired: conversionRequired, verification: conversionRequired ? 'Crypto receipt is paid; invoice fiat denomination is not verified fiat cash settlement. Explicit conversion/settlement evidence is required.' : 'Canonical paid provider receipt.' }) }).onDuplicateKeyUpdate({ set: { economicKey } });
  const item = (await db.select().from(schema.accountingItems).where(eq(schema.accountingItems.economicKey, economicKey)).limit(1))[0];
  if (item.id === id) await markLateAccounting(item.deploymentId, item.occurredAt, item.id);
  return item;
}
export async function recordAccountingItem(actor: Principal, input: { deploymentId: string; kind: 'expense' | 'refund' | 'fee' | 'tax'; amount: string; currency: string; occurredAt: Date; sourceProvider: string; sourceReference: string; paymentId?: string; evidence: Record<string, unknown> }) {
  await requirePolicyPermission(actor, 'finance.manage');
  if (minorUnits(input.amount) < 0n || !Object.keys(input.evidence).length) throw new Error('Nonnegative amount and source evidence required.');
  if (input.paymentId) {
    const payment = (await db.select().from(schema.payments).where(eq(schema.payments.id, input.paymentId)).limit(1))[0];
    if (!payment || payment.deploymentId !== input.deploymentId || payment.currency.toUpperCase() !== input.currency) throw new Error('Payment source belongs to a different workspace or currency.');
  }
  const economicKey = crypto.createHash('sha256').update(JSON.stringify([input.deploymentId, input.sourceProvider.toLowerCase().trim(), input.sourceReference.trim()])).digest('hex');
  const id = generateId();
  await db.transaction(async tx => {
    const business = (await tx.select({ id: schema.deployments.id }).from(schema.deployments).where(eq(schema.deployments.id, input.deploymentId)).for('update'))[0];
    if (!business) throw new Error('Accounting business does not exist.');
    const prior = await tx.select({ id: schema.accountingItems.id }).from(schema.accountingItems).where(and(eq(schema.accountingItems.deploymentId, input.deploymentId), sql`LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${schema.accountingItems.evidenceJson},'$.sourceProvider'))))=${input.sourceProvider.toLowerCase().trim()}`, sql`TRIM(JSON_UNQUOTE(JSON_EXTRACT(${schema.accountingItems.evidenceJson},'$.sourceReference')))=${input.sourceReference.trim()}`)).limit(1);
    if (prior.length) throw new Error('Economic source event already recorded; changing its accounting category cannot duplicate a deduction.');
    await tx.insert(schema.accountingItems).values({ id, deploymentId: input.deploymentId, economicKey, paymentId: input.paymentId || null, kind: input.kind, amount: input.amount, currency: input.currency, occurredAt: input.occurredAt, evidenceJson: JSON.stringify({ ...input.evidence, sourceProvider: input.sourceProvider, sourceReference: input.sourceReference }) });
  });
  await markLateAccounting(input.deploymentId, input.occurredAt, id);
  await auditOperation(actor.id, 'accounting_item_recorded', id, { economicKey, kind: input.kind }, input.deploymentId);
  return id;
}
export async function verifyAccountingItem(actor: Principal, id: string, disputed: boolean) {
  await requirePolicyPermission(actor, 'finance.manage');
  await db.transaction(async tx => {
    const item = (await tx.select().from(schema.accountingItems).where(eq(schema.accountingItems.id, id)).for('update'))[0];
    if (!item) throw new Error('Accounting item not found.');
    if (!disputed && JSON.parse(item.evidenceJson).currencyReconciliationRequired) throw new Error('Crypto-to-accounting-currency verification is unavailable without explicit conversion rules and supported settlement evidence. A payment receipt cannot be relabeled as verified fiat cash.');
    if (item.periodId) throw new Error('Accounted history is immutable. Record a source-linked correction in a new open period.');
    await tx.update(schema.accountingItems).set({ disputed, verifiedBy: actor.id, verifiedAt: new Date() }).where(eq(schema.accountingItems.id, id));
    await tx.insert(schema.operationalEvents).values({ id: generateId(), actorId: actor.id, type: disputed ? 'accounting_disputed' : 'accounting_verified', resourceId: id, deploymentId: item.deploymentId, detailJson: JSON.stringify({ previousVerifier: item.verifiedBy }) });
  });
}
export async function recordVerifiedPaymentException(paymentId: string, providerEventId: string, evidence: Record<string, unknown>) {
  const payment = (await db.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).limit(1))[0];
  if (!payment?.deploymentId) throw new Error('Canonical payment must exist before its provider exception can be recorded.');
  const id = `provider-exception:${crypto.createHash('sha256').update(`${payment.providerType}:${providerEventId}`).digest('hex')}`;
  const prior = (await db.select({ id: schema.operationalEvents.id }).from(schema.operationalEvents).where(eq(schema.operationalEvents.id, id)).limit(1))[0];
  if (prior) return;
  const items = await db.select().from(schema.accountingItems).where(eq(schema.accountingItems.paymentId, paymentId));
  for (const item of items) {
    await db.update(schema.accountingItems).set({ disputed: true }).where(eq(schema.accountingItems.id, item.id));
    await markLateAccounting(item.deploymentId, item.occurredAt, item.id);
  }
  await db.insert(schema.operationalEvents).values({ id, actorId: `verified-provider:${payment.providerType}`, deploymentId: payment.deploymentId, resourceId: payment.id, type: 'verified_payment_exception', detailJson: JSON.stringify({ providerEventId, evidence, originalPaidReceiptPreserved: true, affectedItems: items.map(item => item.id), resolution: 'Record verified source-linked refund/adjustment and reconcile affected periods; no refund or payout was executed.' }) }).onDuplicateKeyUpdate({ set: { id } });
  await auditOperation(`verified-provider:${payment.providerType}`, 'settlement_exception', id, { paymentId, providerEventId, evidence, reconciliationRequired: true }, payment.deploymentId);
}
export async function resolvePaymentException(actor: Principal, input: { paymentId: string; refundItemId?: string; providerResolutionEventId?: string; evidence: string }) {
  await requirePolicyPermission(actor, 'finance.manage');
  if (!input.evidence.trim()) throw new Error('Independent reconciliation evidence is required.');
  const payment = (await db.select().from(schema.payments).where(eq(schema.payments.id, input.paymentId)).limit(1))[0];
  if (!payment) throw new Error('Canonical payment not found.');
  const refund = input.refundItemId ? (await db.select().from(schema.accountingItems).where(eq(schema.accountingItems.id, input.refundItemId)).limit(1))[0] : null;
  const provider = input.providerResolutionEventId ? (await db.select().from(schema.operationalEvents).where(and(eq(schema.operationalEvents.id, input.providerResolutionEventId), eq(schema.operationalEvents.type, 'verified_payment_exception'), eq(schema.operationalEvents.resourceId, payment.id))).limit(1))[0] : null;
  const resolution = provider ? JSON.parse(provider.detailJson).evidence : null;
  const refunded = refund?.kind === 'refund' && refund.paymentId === payment.id && refund.currency === payment.currency.toUpperCase() && refund.verifiedAt && refund.verifiedBy && !refund.disputed;
  const providerResolved = resolution?.type === 'charge.dispute.closed' && ['won', 'warning_closed'].includes(resolution.status);
  if (!refunded && !providerResolved) throw new Error('A verified payment-linked refund deduction or signed provider resolution is required. Caller assertions cannot clear the exception.');
  await db.transaction(async tx => {
    const items = await tx.select().from(schema.accountingItems).where(and(eq(schema.accountingItems.paymentId, payment.id), eq(schema.accountingItems.kind, 'revenue'))).for('update');
    for (const item of items) await tx.update(schema.accountingItems).set({ disputed: false }).where(eq(schema.accountingItems.id, item.id));
    await tx.insert(schema.operationalEvents).values({ id: generateId(), actorId: actor.id, deploymentId: payment.deploymentId, type: 'payment_exception_reconciled', resourceId: payment.id, detailJson: JSON.stringify({ ...input, originalAmountsUnchanged: true, originalCurrencyVerificationUnchanged: true, affectedPeriodsRequireAuditedCorrection: items.map(item => item.periodId).filter(Boolean) }) });
  });
}
function localParts(date: Date, timezone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}
function localMidnight(year: number, month: number, day: number, timezone: string) {
  const expected = Date.UTC(year, month - 1, day);
  let result = expected;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = localParts(new Date(result), timezone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const correction = expected - represented;
    if (correction === 0) return new Date(result);
    result += correction;
  }
  throw new Error('Weekly timezone boundary is ambiguous or unsupported; accounting review required.');
}
export function previousWeeklyPeriod(now: Date, timezone: string, weekStartsOn: number) {
  const local = localParts(now, timezone);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekStartsOn + 7) % 7));
  const endsAt = localMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timezone);
  date.setUTCDate(date.getUTCDate() - 7);
  return { startsAt: localMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timezone), endsAt };
}
export async function setOpeningBalance(actor: Principal, deploymentId: string, loss: string, startsAt: Date, currency: string) {
  await requirePolicyPermission(actor, 'finance.manage');
  if (minorUnits(loss) < 0n) throw new Error('Opening loss must be nonnegative.');
  const existing = await db.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.deploymentId, deploymentId)).limit(1);
  if (existing.length) throw new Error('Opening balance is immutable after periods exist.');
  const key = `openingLoss:${deploymentId}`;
  await db.insert(schema.operationalSettings).values({ key, valueJson: JSON.stringify({ loss, startsAt: startsAt.toISOString(), currency }), updatedBy: actor.id }).onDuplicateKeyUpdate({ set: { valueJson: JSON.stringify({ loss, startsAt: startsAt.toISOString(), currency }), updatedBy: actor.id, updatedAt: new Date() } });
  await auditOperation(actor.id, 'opening_balance_verified', deploymentId, { loss, startsAt, currency }, deploymentId);
}
export async function calculateWeeklyPeriod(deploymentId: string, now = new Date()) {
  const policy = await activePolicy('finance', deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: finance.');
  const config = JSON.parse(policy.configJson);
  const validation = validatePolicy('finance', config);
  if (!validation.valid || validation.missing.length) throw new Error(`POLICY_NOT_CONFIGURED: ${validation.missing.join(', ')}`);
  if (config.accountingConvention !== 'cash') throw new Error('Accrual accounting requires verified receivables and recognition records; this payment-ledger workflow supports explicitly configured cash accounting only.');
  const boundary = previousWeeklyPeriod(now, config.timezone, config.weekStartsOn);
  const receipts = await db.select({ id: schema.payments.id }).from(schema.payments).where(and(eq(schema.payments.deploymentId, deploymentId), eq(schema.payments.status, 'paid'), gte(schema.payments.paidAt, boundary.startsAt), lt(schema.payments.paidAt, boundary.endsAt)));
  for (const receipt of receipts) await ingestVerifiedPayment(receipt.id);
  const authorization = await validApproval({ deploymentId, action: 'profit_share', resourceId: deploymentId, authority: 'user', currency: config.currency });
  if (!authorization || authorization.currency !== config.currency || JSON.parse(authorization.scopeJson).platformPercent !== 20 || JSON.parse(authorization.scopeJson).frequency !== 'weekly') throw new Error('REQUIRES_USER_AUTHORIZATION: weekly 20% positive net-profit agreement in the configured currency.');
  const opening = (await db.select().from(schema.operationalSettings).where(eq(schema.operationalSettings.key, `openingLoss:${deploymentId}`)).limit(1))[0];
  if (!opening) throw new Error('Verified opening accounting date and loss balance required.');
  const initial = JSON.parse(opening.valueJson);
  if (initial.currency !== config.currency || new Date(initial.startsAt) > boundary.startsAt) throw new Error('Accounting opening date/currency does not cover this period.');
  const periodKey = `${deploymentId}:${boundary.startsAt.toISOString()}:${boundary.endsAt.toISOString()}`;
  const existing = (await db.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.periodKey, periodKey)).limit(1))[0];
  if (existing) return existing;
  return db.transaction(async tx => {
    await tx.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId)).for('update');
    const duplicate = (await tx.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.periodKey, periodKey)).limit(1))[0];
    if (duplicate) return duplicate;
    const previous = (await tx.select().from(schema.accountingPeriods).where(and(eq(schema.accountingPeriods.deploymentId, deploymentId), lte(schema.accountingPeriods.endsAt, boundary.startsAt))).orderBy(desc(schema.accountingPeriods.endsAt)).limit(1))[0];
    if (previous && (previous.status === 'disputed' || previous.endsAt.getTime() !== boundary.startsAt.getTime() || !previous.reconciledAt || !previous.calculationJson)) throw new Error('Previous periods must be consecutive, undisputed and reconciled before carrying losses forward.');
    if (!previous && new Date(initial.startsAt).getTime() !== boundary.startsAt.getTime()) throw new Error('Earlier accounting periods must be completed before this week.');
    const items = await tx.select().from(schema.accountingItems).where(and(eq(schema.accountingItems.deploymentId, deploymentId), gte(schema.accountingItems.occurredAt, boundary.startsAt), lt(schema.accountingItems.occurredAt, boundary.endsAt))).for('update');
    if (items.some(item => item.periodId)) throw new Error('Accounting item already included in a period.');
    await enforcePolicy({ category: 'finance', action: 'profit_calculation', versionId: policy.id, deploymentId, actorId: 'system:finance', facts: { userAuthorizationId: authorization.id, currency: config.currency, accountingVerified: items.every(item => item.verifiedAt && item.verifiedBy && !item.disputed), taxReviewed: items.some(item => item.kind === 'tax' && item.verifiedAt && !item.disputed), feesReviewed: !items.some(item => item.kind === 'revenue') || items.some(item => item.kind === 'fee' && item.verifiedAt && !item.disputed), evidenceIds: items.map(item => item.id), periodKey } });
    const calculation = calculateVerifiedProfit({ entries: items.map(item => ({ id: item.economicKey, kind: item.kind as any, amount: item.amount, currency: item.currency, verified: Boolean(item.verifiedAt && item.verifiedBy), disputed: item.disputed })), currency: config.currency, openingLoss: previous ? JSON.parse(previous.calculationJson!).closingLoss : initial.loss, rounding: config.rounding });
    const id = generateId();
    await tx.insert(schema.accountingPeriods).values({ id, deploymentId, periodKey, ...boundary, policyVersionId: policy.id, authorizationId: authorization.id, previousPeriodId: previous?.id || null, status: 'calculated', calculationJson: JSON.stringify({ ...calculation, accountingConvention: config.accountingConvention, taxTreatment: config.taxTreatment, itemIds: items.map(item => item.id) }) });
    for (const item of items) await tx.update(schema.accountingItems).set({ periodId: id }).where(and(eq(schema.accountingItems.id, item.id), isNull(schema.accountingItems.periodId)));
    await tx.insert(schema.operationalEvents).values({ id: generateId(), actorId: 'system:finance', type: 'weekly_profit_calculated', deploymentId, resourceId: id, detailJson: JSON.stringify({ policyVersionId: policy.id, authorizationId: authorization.id, ...calculation }) });
    return (await tx.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.id, id)))[0];
  });
}
export async function reconcilePeriod(actor: Principal, id: string, evidence: string) {
  await requirePolicyPermission(actor, 'finance.manage');
  return reconcileVerifiedPeriod(actor.id, id, evidence);
}
async function reconcileVerifiedPeriod(actorId: string, id: string, evidence: string) {
  if (!evidence.trim()) throw new Error('Reconciliation evidence required.');
  const period = (await db.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.id, id)).limit(1))[0];
  if (!period || !period.calculationJson) throw new Error('Calculated accounting period required.');
  if (period.status === 'disputed') throw new Error('Disputed periods require an audited correction before reconciliation.');
  const agreement = await validApproval({ deploymentId: period.deploymentId, action: 'profit_share', resourceId: period.deploymentId, authority: 'user', id: period.authorizationId || undefined });
  if (!agreement) throw new Error('Agreement is expired or revoked.');
  const calculationHash = crypto.createHash('sha256').update(period.calculationJson).digest('hex');
  const finance = await runAgent('finance', period.deploymentId, 'finance', `reconcile:${id}:${calculationHash}`, async () => {
    const items = await db.select().from(schema.accountingItems).where(eq(schema.accountingItems.periodId, id));
    if (items.some(item => item.disputed || !item.verifiedAt)) throw new Error('Disputed or unverified accounting items.');
    return { evidence, itemIds: items.map(item => item.id), calculation: JSON.parse(period.calculationJson!) };
  });
  await db.transaction(async tx => {
    const current = (await tx.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.id, id)).for('update'))[0];
    if (current.status === 'disputed' || current.calculationJson !== period.calculationJson) throw new Error('Accounting changed during Finance review. Review and reconcile again.');
    if (current.settlementId) return;
    const settlementId = generateId();
    const calculation = JSON.parse(current.calculationJson!);
    await tx.insert(schema.settlementRecords).values({ id: settlementId, deploymentId: current.deploymentId, settlementType: 'weekly_net_profit', amount: calculation.platformPortion, currency: agreement.currency || JSON.parse((await activePolicy('finance', current.deploymentId))!.configJson).currency, status: 'transfer_unavailable', policyStatus: 'eligible', metadataJson: JSON.stringify({ periodId: id, authorizationId: agreement.id, financeExecutionId: finance.executionId, calculation, reconciliationEvidence: evidence }) });
    await tx.update(schema.accountingPeriods).set({ status: 'transfer_unavailable', reconciledBy: finance.agentId, reconciledAt: new Date(), settlementId }).where(eq(schema.accountingPeriods.id, id));
  });
  await auditOperation(actorId, 'period_reconciled', id, { financeExecutionId: finance.executionId, payout: 'unavailable', evidence }, period.deploymentId);
}
export async function processDueAccountingPeriod(deploymentId: string, now = new Date()) {
  const policy = await activePolicy('finance', deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: weekly finance.');
  const config = JSON.parse(policy.configJson);
  const validation = validatePolicy('finance', config);
  if (!validation.valid || validation.missing.length) throw new Error('POLICY_NOT_CONFIGURED: weekly accounting boundaries.');
  const opening = (await db.select().from(schema.operationalSettings).where(eq(schema.operationalSettings.key, `openingLoss:${deploymentId}`)).limit(1))[0];
  if (!opening) throw new Error('Verified opening balance is required for scheduled accounting.');
  const last = (await db.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.deploymentId, deploymentId)).orderBy(desc(schema.accountingPeriods.endsAt)).limit(1))[0];
  if (last?.status === 'disputed') throw new Error('Disputed accounting pauses weekly verification and loss carryforward.');
  if (last && !last.reconciledAt) { await reconcileVerifiedPeriod('system:finance', last.id, 'Scheduled Finance verification of recorded, independently verified payment, deduction and tax evidence.'); return last; }
  const start = last?.endsAt || new Date(JSON.parse(opening.valueJson).startsAt);
  const due = previousWeeklyPeriod(new Date(start.getTime() + 8 * 86400000), config.timezone, config.weekStartsOn);
  if (due.startsAt.getTime() !== start.getTime()) throw new Error('Opening balance or prior period must align with configured weekly boundaries.');
  if (due.endsAt > previousWeeklyPeriod(now, config.timezone, config.weekStartsOn).endsAt) return { state: 'not_due' };
  const period = await calculateWeeklyPeriod(deploymentId, new Date(due.endsAt.getTime() + 3600000));
  await reconcileVerifiedPeriod('system:finance', period.id, 'Scheduled Finance verification of recorded, independently verified payment, deduction and tax evidence.');
  return period;
}
export async function previewAccountingCorrection(actor: Principal, id: string) {
  await requirePolicyPermission(actor, 'finance.manage');
  const original = (await db.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.id, id)).limit(1))[0];
  if (!original) throw new Error('Accounting period not found.');
  const periods = await db.select().from(schema.accountingPeriods).where(and(eq(schema.accountingPeriods.deploymentId, original.deploymentId), gte(schema.accountingPeriods.startsAt, original.startsAt))).orderBy(asc(schema.accountingPeriods.startsAt));
  return { deploymentId: original.deploymentId, periodIds: periods.map(period => period.id), periods: periods.map(period => ({ id: period.id, status: period.status, startsAt: period.startsAt, endsAt: period.endsAt, settlementId: period.settlementId, calculation: period.calculationJson ? JSON.parse(period.calculationJson) : null })) };
}
export async function correctAccountingPeriods(actor: Principal, id: string, expectedPeriodIds: string[], reason: string) {
  await requirePolicyPermission(actor, 'finance.manage');
  if (!reason.trim()) throw new Error('Correction reason and source review required.');
  const preview = await previewAccountingCorrection(actor, id);
  if (JSON.stringify(preview.periodIds) !== JSON.stringify(expectedPeriodIds)) throw new Error('Affected periods changed. Review a new correction preview.');
  return db.transaction(async tx => {
    await tx.select().from(schema.deployments).where(eq(schema.deployments.id, preview.deploymentId)).for('update');
    const periods = await tx.select().from(schema.accountingPeriods).where(and(eq(schema.accountingPeriods.deploymentId, preview.deploymentId), gte(schema.accountingPeriods.startsAt, preview.periods[0].startsAt))).orderBy(asc(schema.accountingPeriods.startsAt)).for('update');
    if (JSON.stringify(periods.map(period => period.id)) !== JSON.stringify(expectedPeriodIds)) throw new Error('Accounting period chain changed concurrently.');
    let openingLoss: string | null = null;
    for (const period of periods) {
      if (period.settlementId) {
        const settlement = (await tx.select().from(schema.settlementRecords).where(eq(schema.settlementRecords.id, period.settlementId)).for('update'))[0];
        if (settlement && ['paid', 'processing', 'reconciled'].includes(settlement.status)) throw new Error('Executed or in-flight transfers require separate authorized reconciliation; automatic historical correction is unavailable.');
      }
      const policy = (await tx.select().from(schema.policyVersions).where(eq(schema.policyVersions.id, period.policyVersionId)).limit(1))[0];
      if (!policy || !period.calculationJson) throw new Error('Original immutable accounting policy and calculation required.');
      const config = JSON.parse(policy.configJson);
      const approval = await validApproval({ deploymentId: period.deploymentId, action: 'profit_share', resourceId: period.deploymentId, authority: 'user', id: period.authorizationId || undefined, currency: config.currency });
      if (!approval) throw new Error('Original profit-share authorization is expired or revoked; specific renewed consent is required.');
      const original = JSON.parse(period.calculationJson);
      const items = await tx.select().from(schema.accountingItems).where(and(eq(schema.accountingItems.deploymentId, period.deploymentId), gte(schema.accountingItems.occurredAt, period.startsAt), lt(schema.accountingItems.occurredAt, period.endsAt))).for('update');
      if (!items.some(item => item.kind === 'tax' && item.verifiedAt && !item.disputed)) throw new Error('Verified tax treatment is required for every affected period.');
      if (items.some(item => item.kind === 'revenue') && !items.some(item => item.kind === 'fee' && item.verifiedAt && !item.disputed)) throw new Error('Verified processing fees, including a documented zero-fee assessment when applicable, are required.');
      const calculation = calculateVerifiedProfit({ entries: items.map(item => ({ id: item.economicKey, kind: item.kind as any, amount: item.amount, currency: item.currency, verified: Boolean(item.verifiedBy && item.verifiedAt), disputed: item.disputed })), currency: config.currency, openingLoss: openingLoss ?? original.openingLoss, rounding: config.rounding });
      const correctionId = generateId();
      const revised = { ...calculation, itemIds: items.map(item => item.id), accountingConvention: config.accountingConvention, taxTreatment: config.taxTreatment, correctionHistory: [...(original.correctionHistory || []), { correctionId, reason, previousCalculation: { ...original, correctionHistory: undefined }, previousSettlementId: period.settlementId, correctedBy: actor.id, correctedAt: new Date().toISOString() }] };
      await tx.insert(schema.operationalEvents).values({ id: correctionId, actorId: actor.id, deploymentId: period.deploymentId, type: 'accounting_period_corrected', resourceId: period.id, detailJson: JSON.stringify({ reason, previousCalculation: original, revisedCalculation: calculation, authorizationId: approval.id }) });
      if (period.settlementId) await tx.update(schema.settlementRecords).set({ status: 'superseded_by_correction' }).where(eq(schema.settlementRecords.id, period.settlementId));
      await tx.update(schema.accountingPeriods).set({ status: 'calculated', calculationJson: JSON.stringify(revised), reconciledBy: null, reconciledAt: null, settlementId: null }).where(eq(schema.accountingPeriods.id, period.id));
      for (const item of items) await tx.update(schema.accountingItems).set({ periodId: period.id }).where(eq(schema.accountingItems.id, item.id));
      openingLoss = calculation.closingLoss;
    }
    return { correctedPeriodIds: periods.map(period => period.id), externalTransfers: 0 };
  });
}
