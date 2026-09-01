import crypto from 'crypto';

// ============================================================
// NOWPayments provider adapter (isolated, server-side only).
//
// All credentials are read exclusively from process.env and are
// NEVER exposed to the client, logged, stored in the database, or
// included in WebSocket / tRPC payloads.
//
// When credentials are missing, this module throws a clear,
// server-side configuration error instead of using fake values.
// ============================================================

const DEFAULT_API_URL = 'https://api.nowpayments.io';

export interface NowPaymentsConfig {
  apiKey: string;
  ipnSecret: string;
  apiUrl: string;
}

export interface NowPaymentsCreatePaymentInput {
  priceAmount: string;
  priceCurrency: string;
  payCurrency?: string;
  orderId?: string;
  orderDescription?: string;
  ipnCallbackUrl?: string;
}

export interface NowPaymentsPayment {
  payment_id?: string;
  payment_status?: string;
  pay_address?: string | null;
  price_amount?: number | string | null;
  price_currency?: string | null;
  pay_amount?: number | string | null;
  pay_currency?: string | null;
  network?: string | null;
  purchase_id?: string | null;
  order_id?: string | null;
  order_description?: string | null;
  outcome_amount?: number | string | null;
  outcome_currency?: string | null;
  actually_paid?: number | string | null;
  transaction_id?: string | null;
  payin_hash?: string | null;
  payment_extra_ids?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
  expiration_estimate_date?: string | null;
  amount_received?: number | string | null;
}

/**
 * Read the NOWPayments configuration from environment variables.
 * Throws a clear configuration error when credentials are missing.
 */
export function getNowPaymentsConfig(): NowPaymentsConfig {
  const apiKey = process.env.NOWPAYMENTS_API_KEY || '';
  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET || '';
  const apiUrl = process.env.NOWPAYMENTS_API_URL || DEFAULT_API_URL;

  if (!apiKey) {
    throw new Error('NOWPayments API credentials are not configured. Set NOWPAYMENTS_API_KEY server-side.');
  }
  if (!ipnSecret) {
    throw new Error('NOWPayments IPN credentials are not configured. Set NOWPAYMENTS_IPN_SECRET server-side.');
  }

  return { apiKey, ipnSecret, apiUrl };
}

/** True when the provider has at least an API key configured (for admin status checks). */
export function hasNowPaymentsApiKey(): boolean {
  return Boolean(process.env.NOWPAYMENTS_API_KEY);
}

function nowPaymentsHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Create a payment at NOWPayments.
 * https://api.nowpayments.io/v1/payment
 */
export async function createNowPaymentsPayment(
  config: NowPaymentsConfig,
  input: NowPaymentsCreatePaymentInput
): Promise<NowPaymentsPayment> {
  const body: Record<string, unknown> = {
    price_amount: Number(input.priceAmount),
    price_currency: input.priceCurrency.toLowerCase(),
    order_id: input.orderId,
    order_description: input.orderDescription || 'SAO deployment',
  };

  if (input.payCurrency) {
    body.pay_currency = input.payCurrency.toLowerCase();
  }
  if (input.ipnCallbackUrl) {
    body.ipn_callback_url = input.ipnCallbackUrl;
  }

  const response = await fetch(`${config.apiUrl}/v1/payment`, {
    method: 'POST',
    headers: nowPaymentsHeaders(config.apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`NOWPayments create payment failed (HTTP ${response.status}): ${text}`);
  }

  return (await response.json()) as NowPaymentsPayment;
}

/**
 * Fetch the current payment status from NOWPayments.
 * https://api.nowpayments.io/v1/payment/{payment_id}
 */
export async function getNowPaymentsPaymentStatus(
  config: NowPaymentsConfig,
  paymentId: string
): Promise<NowPaymentsPayment> {
  const response = await fetch(`${config.apiUrl}/v1/payment/${encodeURIComponent(paymentId)}`, {
    method: 'GET',
    headers: nowPaymentsHeaders(config.apiKey),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`NOWPayments status lookup failed (HTTP ${response.status}): ${text}`);
  }

  return (await response.json()) as NowPaymentsPayment;
}

/**
 * Sort an object's top-level keys alphabetically (the documented
 * NOWPayments IPN signing approach). Nested values are left as-is
 * to match the provider's own serialization.
 */
function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = (value as Record<string, unknown>)[key];
    }
    return sorted;
  }
  return value;
}

function computeIpnSignature(rawBody: string, secret: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  }
  const sorted = sortObjectKeys(parsed);
  const json = JSON.stringify(sorted);
  return crypto.createHmac('sha512', secret).update(json).digest('hex');
}

/**
 * Verify the NOWPayments IPN signature header (`x-nowpayments-sig`)
 * using HMAC-SHA512 over the sorted JSON body and the IPN secret.
 * Returns false (never throws) for any mismatch.
 */
export function verifyIpnSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = computeIpnSignature(rawBody, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Build an IPN signature for the given body — exposed only for tests. */
export function buildIpnSignatureForTest(rawBody: string, secret: string): string {
  return computeIpnSignature(rawBody, secret);
}

/**
 * Map a NOWPayments provider status into the controlled SAO status model.
 *
 *   waiting        -> pending      (awaiting payment)
 *   confirming     -> confirming   (payment detected, awaiting confirmations)
 *   confirmed      -> confirmed    (confirmed on-chain, not yet settled)
 *   sending        -> confirmed    (settlement in progress)
 *   partially_paid -> confirming   (underpayment — not yet complete)
 *   finished       -> paid         (terminal success — records revenue)
 *   failed         -> failed
 *   refunded       -> canceled     (funds returned — not a successful payment)
 *   expired        -> expired
 *   unknown/other  -> pending      (do not invent a terminal state)
 */
export function mapNowPaymentsStatusToSao(providerStatus: string | null | undefined): string {
  switch ((providerStatus || '').toLowerCase()) {
    case 'waiting':
      return 'pending';
    case 'confirming':
      return 'confirming';
    case 'confirmed':
      return 'confirmed';
    case 'sending':
      return 'confirmed';
    case 'partially_paid':
      return 'confirming';
    case 'finished':
      return 'paid';
    case 'failed':
      return 'failed';
    case 'refunded':
      return 'canceled';
    case 'expired':
      return 'expired';
    default:
      return 'pending';
  }
}