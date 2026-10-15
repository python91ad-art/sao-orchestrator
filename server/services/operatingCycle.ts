import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import { db } from '../db';
import * as schema from '../../drizzle/schema';
import { activePolicy } from './policyEngine';
import { auditOperation, emergencyStopped, recoverExpiredAssignments } from './execution';
import { processDueAccountingPeriod } from './financialLifecycle';
import { applyPaidExtension, evaluateBusiness, initializeLaunchedDeadline, suspendBusiness } from './businessLifecycle';
import { reviewAutomaticPricing } from './pricingLifecycle';

let running = false;
export async function runOperatingCycle() {
  if (running) return;
  running = true;
  try {
    await recoverExpiredAssignments();
    const expired = await db.select({ id: schema.approvals.id, deploymentId: schema.approvals.deploymentId }).from(schema.approvals).where(and(inArray(schema.approvals.status, ['pending', 'approved']), lt(schema.approvals.expiresAt, new Date())));
    for (const approval of expired) {
      await db.update(schema.approvals).set({ status: 'expired' }).where(and(eq(schema.approvals.id, approval.id), inArray(schema.approvals.status, ['pending', 'approved'])));
      await auditOperation('system:approvals', 'approval_expired', approval.id, {}, approval.deploymentId);
    }
    let cursor = '';
    while (true) {
    const businesses = await db.select().from(schema.deployments).where(gt(schema.deployments.id, cursor)).orderBy(asc(schema.deployments.id)).limit(100);
    if (!businesses.length) break;
    cursor = businesses[businesses.length - 1].id;
    for (const business of businesses) {
      const lifecycle = (await db.select().from(schema.businessLifecycleRecords).where(eq(schema.businessLifecycleRecords.deploymentId, business.id)).limit(1))[0];
      if (lifecycle?.state === 'closed') continue;
      if (await emergencyStopped() || business.banRisk === 'high' || business.health === 'critical') {
        if (lifecycle?.state !== 'suspended') await suspendBusiness('system:risk-monitor', business.id, await emergencyStopped() ? 'System emergency stop.' : 'Serious operational or legal risk requires Supervisor review.');
        continue;
      }
      const offers = await db.select().from(schema.extensionOffers).where(and(eq(schema.extensionOffers.deploymentId, business.id), eq(schema.extensionOffers.status, 'accepted')));
      for (const offer of offers) {
        try { await applyPaidExtension(offer.id); } catch (error: any) { await auditOperation('system:lifecycle', 'extension_pending', offer.id, { reason: error.message }, business.id); }
      }
      for (const operation of [() => initializeLaunchedDeadline(business.id), () => processDueAccountingPeriod(business.id), () => evaluateBusiness(business.id), () => reviewAutomaticPricing(business.id)]) {
        try { await operation(); } catch (error: any) { await auditOperation('system:lifecycle', 'operation_blocked', business.id, { reason: error.message }, business.id); }
      }
      const deadline = await activePolicy('deadlines', business.id);
      const config = deadline ? JSON.parse(deadline.configJson) : null;
      if (lifecycle?.deadlineAt && config?.warningDays && lifecycle.deadlineAt.getTime() > Date.now() && lifecycle.deadlineAt.getTime() - Date.now() <= config.warningDays * 86400000) {
        const existing = await db.select().from(schema.operationalEvents).where(and(eq(schema.operationalEvents.resourceId, lifecycle.id), eq(schema.operationalEvents.type, 'deadline_warning'))).limit(1);
        if (!existing.length) await auditOperation('system:lifecycle', 'deadline_warning', lifecycle.id, { deadlineAt: lifecycle.deadlineAt, delivery: 'in_app', ownerId: business.userId }, business.id);
      }
      const shutdown = await activePolicy('shutdown', business.id);
      if (shutdown) {
        const threshold = JSON.parse(shutdown.configJson).lossSuspensionThreshold;
        const periods = await db.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.deploymentId, business.id));
        const verified = periods.filter(period => period.reconciledAt && period.calculationJson).sort((first, second) => second.endsAt.getTime() - first.endsAt.getTime());
        if (threshold !== null && verified[0] && Number(JSON.parse(verified[0].calculationJson!).closingLoss) >= threshold) await suspendBusiness('system:finance', business.id, 'Verified carried losses exceeded the configured suspension boundary.');
      }
    }
    }
  } finally { running = false; }
}
