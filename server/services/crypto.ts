import * as db from '../db';
import {
  getNowPaymentsConfig,
  createNowPaymentsPayment,
  mapNowPaymentsStatusToSao,
  verifyIpnSignature,
  type NowPaymentsPayment,
} from './nowpayments';
import { broadcastEvent } from '../websocket';

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
  const config = getNowPaymentsConfig();
  const price = getSaoPrice();

  const payment = await db.createPayment({
    deploymentId: params.deploymentId,
    providerType: PROVIDER_TYPE,
    amount: price.amount,
    currency: price.currency,
    providerPaymentId: null,
  });

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
          'unknown_payment' | 'currency_mismatch' | 'already_paid' |
          'recorded' | 'updated' | 'noop' | 'not_found';
  detail?: string;
}

export async function processNowPaymentsIpn(
  rawBody: string,
  signature: string | undefined
): Promise<IpnResult> {
  // 1. Verify the IPN signature.
  const config = getNowPaymentsConfig();
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

  // 4. Never regress a paid payment.
  if (payment.status === 'paid') {
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
    const result = await db.recordPaymentPaid(payment.id, {
      providerStatus: payload.payment_status,
      transactionHash: extractTransactionHash(payload),
      cryptoAmount: toAmountStr(payload.pay_amount ?? payload.actually_paid),
      cryptoCurrency: payload.pay_currency,
      cryptoNetwork: payload.network,
      paymentAddress: payload.pay_address,
    });

    if (result.outcome === 'recorded') {
      broadcastEvent({
        type: 'payment:updated',
        data: { paymentId: payment.id, deploymentId: payment.deploymentId, status: 'paid' },
      });

      if (result.deployment) {
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