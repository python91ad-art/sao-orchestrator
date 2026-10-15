import * as db from '../db';
import { allocateRevenueForPayment } from './advertising/growthEngine';
import { recordRevenueTransaction } from './infrastructure';

export type RevenueRecognitionResult =
  | { outcome: 'deployment_not_found' }
  | { outcome: 'already_paid'; payment: any }
  | { outcome: 'recorded'; payment: any; deployment: any };

export async function recognizeExternalPaymentRevenue(input: {
  providerType: string;
  providerPaymentId: string;
  deploymentId: string;
  amount: number;
  currency: string;
  providerStatus?: string | null;
}): Promise<RevenueRecognitionResult> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Payment amount must be positive.');
  }

  const deployment = await db.getDeploymentById(input.deploymentId);
  if (!deployment) {
    return { outcome: 'deployment_not_found' };
  }

  const { payment } = await db.getOrCreateProviderPayment({
    deploymentId: deployment.id,
    providerType: input.providerType,
    providerPaymentId: input.providerPaymentId,
    amount: input.amount.toFixed(2),
    currency: input.currency.toUpperCase(),
    providerStatus: input.providerStatus || null,
  });

  const paid = await db.recordPaymentPaid(payment.id, {
    providerStatus: input.providerStatus || null,
  });

  if (paid.outcome === 'already_paid') {
    const { ingestVerifiedPayment } = await import('./financialLifecycle');
    await ingestVerifiedPayment(paid.payment.id);
    return { outcome: 'already_paid', payment: paid.payment };
  }

  if (paid.outcome !== 'recorded') {
    throw new Error('Payment disappeared during revenue recognition.');
  }

  await allocateRevenueForPayment(paid.payment, paid.deployment);
  await recordRevenueTransaction({
    deploymentId: paid.deployment.id,
    paymentId: paid.payment.id,
    transactionType: 'verified_payment_revenue',
    amount: paid.payment.amount,
    currency: paid.payment.currency,
    idempotencyKey: `revenue:${paid.payment.id}`,
    metadata: {
      providerType: input.providerType,
      providerPaymentId: input.providerPaymentId,
      settlementPolicy: 'POLICY_NOT_CONFIGURED',
    },
  });
  await db.createAuditLog({
    deploymentId: paid.deployment.id,
    gapId: paid.deployment.gapId,
    decision: 'Revenue Recognized',
    reasoning: `Canonical ${input.providerType} payment ${input.providerPaymentId} recorded in payment ledger.`,
    explanation: `${input.currency.toUpperCase()} ${input.amount.toFixed(2)} recognized for deployment ${paid.deployment.id}.`,
    banRisk: paid.deployment.banRisk || 'low',
    businessHealth: paid.deployment.health || 'healthy',
  });

  return {
    outcome: 'recorded',
    payment: paid.payment,
    deployment: paid.deployment,
  };
}
