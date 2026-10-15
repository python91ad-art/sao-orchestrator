import * as db from '../db';
import { and, eq } from 'drizzle-orm';
import { operationalEvents } from '../../drizzle/schema';
import { minorUnits } from './profitAccounting';
import {
  getNowPaymentsConfigAsync,
  createNowPaymentsPayment,
  mapNowPaymentsStatusToSao,
  verifyIpnSignature,
  type NowPaymentsPayment,
} from './nowpayments';
import { broadcastEvent } from '../websocket';
import { allocateRevenueForPayment } from './advertising/growthEngine';
import { recordRevenueTransaction } from './infrastructure';

// Re-export the pure, DB-free helpers for callers and tests.
import {
  shouldRecordRevenue,
  shouldTriggerDeployment,
  isTerminalStatus,
  toSafePaymentView,
} from './paymentState';
export {
  shouldRecordRevenue,
  shouldTriggerDeployment,
  isTerminalStatus,
  toSafePaymentView,
};

const PROVIDER_TYPE = 'crypto';

// ============================================================
// Configuration helpers
// ============================================================

function buildWebhookUrl(): string | undefined {
  const explicit = process.env.CRYPTO_WEBHOOK_URL;
  if (explicit) return explicit;
  const base = process.env.FRONTEND_URL || process.env.PUBLIC_URL || process.env.CORS_ORIGIN;
  if (base) return `${base.replace(/\/+$/, '')}/api/crypto/webhook`;
  return undefined;
}

function extractTransactionHash(p: NowPaymentsPayment): string | null {
  const hash = (p as any).payin_hash || p.transaction_id || null;
  return typeof hash === 'string' ? hash : null;
}

function toAmountStr(v: number | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return null;
  return String(v);
}

// ============================================================
// Server-side SAO price (client cannot manipulate)
// ============================================================

export function getSaoPrice(): { amount: string; currency: string } {
  const amountStr = process.env.SAO_PRICE_AMOUNT || '10.00';
  const currency = (process.env.SAO_PRICE_CURRENCY || 'USD').toUpperCase();
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('SAO price configuration is invalid. Set SAO_PRICE_AMOUNT to a positive number.');
  }
  return { amount: amount.toFixed(2), currency };
}
// ============================================================
// Payment creation orchestration
// ============================================================

export async function createCryptoPayment(params: {
  deploymentId: string;
  payCurrency?: string;
}) {
  return createQuotedPayment({ ...params, ...getSaoPrice(), purpose: 'legacy_sao_payment', resourceId: params.deploymentId });
}

export async function createQuotedPayment(params: { deploymentId: string; payCurrency?: string; amount: string; currency: string; purpose: 'legacy_sao_payment' | 'business_sale' | 'extension'; resourceId: string; customerUserId?: string }) {
  const config = await getNowPaymentsConfigAsync();
  const price = { amount: params.amount, currency: params.currency };

  const payment = await db.createPayment({
    deploymentId: params.deploymentId,
    providerType: PROVIDER_TYPE,
    amount: price.amount,
    currency: price.currency,
    providerPaymentId: null,
  });
  const { auditOperation } = await import('./execution');
  await auditOperation('system:payments', 'payment_purpose', payment.id, { purpose: params.purpose, resourceId: params.resourceId, amount: price.amount, currency: price.currency, customerUserId: params.customerUserId }, params.deploymentId);

  try {
    const webhookUrl = buildWebhookUrl();

    const provider = await createNowPaymentsPayment(config, {
      priceAmount: price.amount,
      priceCurrency: price.currency,
      payCurrency: params.payCurrency,
      orderId: payment.id,
      ipnCallbackUrl: webhookUrl,
    });

    const checkoutUrl = provider.payment_id
      ? `https://nowpayments.io/payment/?iid=${encodeURIComponent(provider.payment_id)}`
      : null;

    const updated = await db.updatePayment(payment.id, {
      providerPaymentId: provider.payment_id || null,
      providerStatus: provider.payment_status || 'waiting',
      checkoutUrl,
      cryptoAmount: toAmountStr(provider.pay_amount),
      cryptoCurrency: provider.pay_currency || null,
      cryptoNetwork: provider.network || null,
      paymentAddress: provider.pay_address || null,
      expiresAt: provider.expiration_estimate_date
        ? new Date(provider.expiration_estimate_date)
        : null,
    });

    return toSafePaymentView(updated);
  } catch (err) {
    await db.updatePayment(payment.id, { status: 'failed', providerStatus: 'failed' });
    throw err;
  }
}

// ============================================================
// IPN / Webhook processing (idempotent, safe)
// ============================================================

export interface IpnResult {
  status: 'invalid_signature' | 'invalid_payload' | 'missing_payment_id' |
          'unknown_payment' | 'currency_mismatch' | 'amount_mismatch' | 'already_paid' |
          'recorded' | 'updated' | 'noop' | 'not_found';
  detail?: string;
}

export async function processNowPaymentsIpn(
  rawBody: string,
  signature: string | undefined
): Promise<IpnResult> {
  // 1. Verify the IPN signature.
  const config = await getNowPaymentsConfigAsync();
  if (!signature || !verifyIpnSignature(rawBody, signature, config.ipnSecret)) {
    return { status: 'invalid_signature' };
  }

  // 2. Parse the payload.
  let payload: NowPaymentsPayment;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 'invalid_payload' };
  }

  const providerPaymentId = payload.payment_id;
  if (!providerPaymentId) {
    return { status: 'missing_payment_id' };
  }

  // 3. Locate the local payment record.
  const payment = await db.getPaymentByProviderPaymentId(PROVIDER_TYPE, providerPaymentId);
  if (!payment) {
    console.warn(
      `[crypto-webhook] Unknown provider payment id (not stored): ${providerPaymentId}`
    );
    return { status: 'unknown_payment' };
  }

  if (payment.status === 'paid' && payload.payment_status === 'refunded') {
    const { recordVerifiedPaymentException } = await import('./financialLifecycle');
    await recordVerifiedPaymentException(payment.id, `refunded:${providerPaymentId}`, { providerStatus: payload.payment_status, invoiceCurrency: payload.price_currency, invoiceAmount: payload.price_amount, actualRefundAmount: 'Requires provider refund/settlement evidence; invoice value is not assumed to be the refund value.' });
    return { status: 'already_paid' };
  }
  // 4. Never regress a paid payment.
  if (payment.status === 'paid') {
    const { ingestVerifiedPayment } = await import('./financialLifecycle');
    await ingestVerifiedPayment(payment.id);
    const { recordVerifiedSaleCustomer } = await import('./pricingLifecycle');
    await recordVerifiedSaleCustomer(payment.id);
    return { status: 'already_paid' };
  }

  // 5. Verify currency consistency where the provider provides it.
  if (payload.price_currency && payment.currency) {
    if (payload.price_currency.toLowerCase() !== payment.currency.toLowerCase()) {
      console.warn(
        `[crypto-webhook] Currency mismatch for payment ${payment.id}: ` +
        `expected ${payment.currency}, got ${payload.price_currency}`
      );
      return { status: 'currency_mismatch' };
    }
  }

  // 6. Map provider status to SAO status.
  const targetStatus = mapNowPaymentsStatusToSao(payload.payment_status);

  // 7. Transition to `paid` — record revenue and trigger deployment once.
  if (targetStatus === 'paid') {
    if (typeof payload.price_currency !== 'string' || payload.price_currency.toUpperCase() !== payment.currency.toUpperCase()) return { status: 'currency_mismatch' };
    const received = String(payload.price_amount ?? '');
    const [whole, fraction = ''] = received.split('.');
    const normalized = /^\d+(\.\d+)?$/.test(received) && !/[1-9]/.test(fraction.slice(2)) ? `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}` : null;
    if (!normalized || minorUnits(normalized) !== minorUnits(payment.amount)) {
      const { auditOperation } = await import('./execution');
      await auditOperation('verified-provider:crypto', 'payment_evidence_rejected', payment.id, { expectedInvoiceAmount: payment.amount, receivedInvoiceAmount: payload.price_amount, reason: 'Signed provider invoice value does not match the server-created payment request.' }, payment.deploymentId);
      return { status: 'amount_mismatch' };
    }
    const result = await db.recordPaymentPaid(payment.id, {
      providerStatus: payload.payment_status,
      transactionHash: extractTransactionHash(payload),
      cryptoAmount: toAmountStr(payload.pay_amount ?? payload.actually_paid),
      cryptoCurrency: payload.pay_currency,
      cryptoNetwork: payload.network,
      paymentAddress: payload.pay_address,
    });

    if ('payment' in result && result.payment?.status === 'paid') {
      const { ingestVerifiedPayment } = await import('./financialLifecycle');
      await ingestVerifiedPayment(result.payment.id);
      const { recordVerifiedSaleCustomer } = await import('./pricingLifecycle');
      await recordVerifiedSaleCustomer(result.payment.id);
    }
    if (result.outcome === 'recorded') {
      const purposeRows = await db.db.select().from(operationalEvents).where(and(eq(operationalEvents.type, 'payment_purpose'), eq(operationalEvents.resourceId, result.payment.id))).limit(1);
      const purpose = purposeRows[0] ? JSON.parse(purposeRows[0].detailJson) : null;
      if (purpose?.purpose === 'extension') {
        const { applyPaidExtension } = await import('./businessLifecycle');
        await recordRevenueTransaction({ deploymentId: result.payment.deploymentId, paymentId: result.payment.id, transactionType: 'extension_receipt', amount: result.payment.amount, currency: result.payment.currency, idempotencyKey: `extension_receipt:${result.payment.id}`, metadata: { offerId: purpose.resourceId } });
        try { await applyPaidExtension(purpose.resourceId); } catch (error: any) {
          const { extensionOffers } = await import('../../drizzle/schema');
          await db.db.update(extensionOffers).set({ status: 'payment_exception' }).where(and(eq(extensionOffers.id, purpose.resourceId), eq(extensionOffers.status, 'accepted')));
          const { auditOperation } = await import('./execution');
          await auditOperation('system:payments', 'settlement_exception', result.payment.id, { offerId: purpose.resourceId, reason: error.message, paymentReceived: true, extensionApplied: false, refundOrFulfillmentReviewRequired: true }, result.payment.deploymentId);
          await auditOperation('system:payments', 'user_notification', result.payment.id, { reason: 'Extension payment was recorded but fulfillment requires review. The extension has not been applied; payment and refund obligations are preserved.', offerId: purpose.resourceId }, result.payment.deploymentId);
        }
        return { status: result.outcome };
      }
      if (purpose?.purpose !== 'legacy_sao_payment') await allocateRevenueForPayment(result.payment, result.deployment);
      if (result.deployment) {
        await recordRevenueTransaction({
          deploymentId: result.deployment.id,
          paymentId: result.payment.id,
          transactionType: purpose?.purpose === 'legacy_sao_payment' ? 'platform_service_receipt' : 'verified_crypto_revenue',
          amount: result.payment.amount,
          currency: result.payment.currency,
          idempotencyKey: `revenue:${result.payment.id}`,
          metadata: {
            providerType: PROVIDER_TYPE,
            providerPaymentId,
            settlementPolicy: 'POLICY_NOT_CONFIGURED',
          },
        });
      }

      broadcastEvent({
        type: 'payment:updated',
        data: { paymentId: payment.id, deploymentId: payment.deploymentId, status: 'paid' },
      });

      if (result.deployment && purpose?.purpose !== 'business_sale') {
        await db.enqueueDeploymentQueueItem(result.deployment.gapId);
        console.log(
          `[crypto-webhook] Enqueued deployment for ${result.deployment.id} ` +
          `(payment ${payment.id})`
        );
      }
    }

    return { status: result.outcome };
  }

  // 8. Non-paid transition (confirming, confirmed, failed, expired, etc.).
  if (payment.status === targetStatus) {
    return { status: 'noop' };
  }

  await db.updatePayment(payment.id, {
    status: targetStatus,
    providerStatus: payload.payment_status || null,
    transactionHash: extractTransactionHash(payload) || undefined,
    cryptoAmount: toAmountStr(payload.pay_amount ?? payload.actually_paid) || undefined,
    cryptoCurrency: payload.pay_currency || undefined,
    cryptoNetwork: payload.network || undefined,
    paymentAddress: payload.pay_address || undefined,
  });

  broadcastEvent({
    type: 'payment:updated',
    data: { paymentId: payment.id, deploymentId: payment.deploymentId, status: targetStatus },
  });

  return { status: 'updated', detail: targetStatus };
}
