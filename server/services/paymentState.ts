// ============================================================
// Pure, DB-free payment state helpers.
//
// Kept separate from `crypto.ts` so the business rules can be
// tested without importing the database or provider client.
// ============================================================

/**
 * Revenue must only be recorded when a payment transitions into the
 * `paid` terminal state for the first time.
 */
export function shouldRecordRevenue(prevStatus: string, nextStatus: string): boolean {
  return prevStatus !== 'paid' && nextStatus === 'paid';
}

/**
 * The deployment pipeline must only be triggered once per successful
 * payment, on the first `paid` transition.
 */
export function shouldTriggerDeployment(prevStatus: string, nextStatus: string): boolean {
  return prevStatus !== 'paid' && nextStatus === 'paid';
}

/**
 * Statuses that are terminal and should never regress to a non-terminal
 * state. `paid | failed | expired | canceled` are considered terminal.
 */
export function isTerminalStatus(status: string): boolean {
  return ['paid', 'failed', 'expired', 'canceled'].includes(status);
}

/**
 * Return a safe public view of a payment row. This function
 * intentionally whitelists fields so that no secret/crypto-key
 * field can leak through to the client or WebSocket broadcasts.
 */
export function toSafePaymentView(payment: any) {
  return {
    id: payment.id,
    deploymentId: payment.deploymentId,
    providerType: payment.providerType,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    checkoutUrl: payment.checkoutUrl,
    cryptoAmount: payment.cryptoAmount,
    cryptoCurrency: payment.cryptoCurrency,
    cryptoNetwork: payment.cryptoNetwork,
    paymentAddress: payment.paymentAddress,
    transactionHash: payment.transactionHash,
    providerStatus: payment.providerStatus,
    paidAt: payment.paidAt,
    expiresAt: payment.expiresAt,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}
