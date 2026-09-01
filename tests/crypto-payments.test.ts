// ============================================================
// Credential-independent crypto payment tests.
//
// These tests exercise the pure, DB-free pieces of the NOWPayments
// integration (config validation, IPN signature verification, status
// mapping, revenue/trigger rules, and secret-safe payload shaping).
//
// They run WITHOUT real NOWPayments credentials and WITHOUT a live
// database. Provider calls and ownership/IDOR checks that require a
// running provider or database are covered by code review and are
// documented in the final report.
// ============================================================

import assert from 'node:assert/strict';
import {
  getNowPaymentsConfig,
  hasNowPaymentsApiKey,
  verifyIpnSignature,
  buildIpnSignatureForTest,
  mapNowPaymentsStatusToSao,
} from '../server/services/nowpayments';
import {
  shouldRecordRevenue,
  shouldTriggerDeployment,
  isTerminalStatus,
  toSafePaymentView,
} from '../server/services/paymentState';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
  }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

console.log('\n=== Crypto payments (credential-independent) tests ===\n');

// A. Missing API key fails clearly.
test('A: missing API key fails clearly', () => {
  withEnv({ NOWPAYMENTS_API_KEY: '', NOWPAYMENTS_IPN_SECRET: 'secret' }, () => {
    assert.throws(
      () => getNowPaymentsConfig(),
      /NOWPayments API credentials are not configured/
    );
  });
});

// B. Missing IPN secret fails clearly.
test('B: missing IPN secret fails clearly', () => {
  withEnv({ NOWPAYMENTS_API_KEY: 'key', NOWPAYMENTS_IPN_SECRET: '' }, () => {
    assert.throws(
      () => getNowPaymentsConfig(),
      /NOWPayments IPN credentials are not configured/
    );
  });
});

test('config: hasNowPaymentsApiKey reflects env presence', () => {
  withEnv({ NOWPAYMENTS_API_KEY: 'some-key' }, () => {
    assert.equal(hasNowPaymentsApiKey(), true);
  });
  withEnv({ NOWPAYMENTS_API_KEY: '' }, () => {
    assert.equal(hasNowPaymentsApiKey(), false);
  });
});

// H. Invalid webhook authentication is rejected.
const SECRET = 'ipn-secret-123';
const BODY = JSON.stringify({
  payment_id: '123',
  payment_status: 'finished',
  price_amount: 10,
  price_currency: 'usd',
  pay_amount: 0.0004,
  pay_currency: 'btc',
});

test('H: valid IPN signature is accepted', () => {
  const sig = buildIpnSignatureForTest(BODY, SECRET);
  assert.equal(verifyIpnSignature(BODY, sig, SECRET), true);
});

test('H: wrong IPN signature is rejected', () => {
  assert.equal(verifyIpnSignature(BODY, 'deadbeef', SECRET), false);
});

test('H: tampered body is rejected', () => {
  const sig = buildIpnSignatureForTest(BODY, SECRET);
  assert.equal(verifyIpnSignature(JSON.stringify({ payment_id: '999' }), sig, SECRET), false);
});

test('H: missing signature is rejected', () => {
  assert.equal(verifyIpnSignature(BODY, '', SECRET), false);
});

test('H: missing secret is rejected', () => {
  const sig = buildIpnSignatureForTest(BODY, SECRET);
  assert.equal(verifyIpnSignature(BODY, sig, ''), false);
});

// Status mapping.
test('status mapping: finished -> paid', () => {
  assert.equal(mapNowPaymentsStatusToSao('finished'), 'paid');
});
test('status mapping: waiting -> pending', () => {
  assert.equal(mapNowPaymentsStatusToSao('waiting'), 'pending');
});
test('status mapping: confirming -> confirming', () => {
  assert.equal(mapNowPaymentsStatusToSao('confirming'), 'confirming');
});
test('status mapping: confirmed -> confirmed', () => {
  assert.equal(mapNowPaymentsStatusToSao('confirmed'), 'confirmed');
});
test('status mapping: sending -> confirmed', () => {
  assert.equal(mapNowPaymentsStatusToSao('sending'), 'confirmed');
});
test('status mapping: partially_paid -> confirming', () => {
  assert.equal(mapNowPaymentsStatusToSao('partially_paid'), 'confirming');
});
test('status mapping: failed -> failed', () => {
  assert.equal(mapNowPaymentsStatusToSao('failed'), 'failed');
});
test('status mapping: refunded -> canceled', () => {
  assert.equal(mapNowPaymentsStatusToSao('refunded'), 'canceled');
});
test('status mapping: expired -> expired', () => {
  assert.equal(mapNowPaymentsStatusToSao('expired'), 'expired');
});
test('status mapping: unknown -> pending (no invented terminal state)', () => {
  assert.equal(mapNowPaymentsStatusToSao('mystery'), 'pending');
});

// Revenue accounting idempotency.
test('I: paid -> paid does NOT record revenue', () => {
  assert.equal(shouldRecordRevenue('paid', 'paid'), false);
});
test('I: already-paid webhook does not record revenue again', () => {
  assert.equal(shouldRecordRevenue('paid', 'paid'), false);
});
test('J: repeated paid webhook does not record revenue again', () => {
  assert.equal(shouldRecordRevenue('paid', 'paid'), false);
});
test('revenue: pending -> paid records revenue once', () => {
  assert.equal(shouldRecordRevenue('pending', 'paid'), true);
});
test('revenue: confirming -> paid records revenue once', () => {
  assert.equal(shouldRecordRevenue('confirming', 'paid'), true);
});
test('revenue: confirming -> confirming does not record revenue', () => {
  assert.equal(shouldRecordRevenue('confirming', 'confirming'), false);
});

// Deployment trigger rules.
test('K: failed payment does not trigger deployment', () => {
  assert.equal(shouldTriggerDeployment('pending', 'failed'), false);
});
test('L: expired payment does not trigger deployment', () => {
  assert.equal(shouldTriggerDeployment('pending', 'expired'), false);
});
test('trigger: pending -> paid triggers deployment once', () => {
  assert.equal(shouldTriggerDeployment('pending', 'paid'), true);
});
test('trigger: paid -> paid does not trigger deployment again', () => {
  assert.equal(shouldTriggerDeployment('paid', 'paid'), false);
});

// Terminal statuses.
test('isTerminalStatus: paid/failed/expired/canceled are terminal', () => {
  for (const s of ['paid', 'failed', 'expired', 'canceled']) {
    assert.equal(isTerminalStatus(s), true, s);
  }
  for (const s of ['pending', 'confirming', 'confirmed']) {
    assert.equal(isTerminalStatus(s), false, s);
  }
});

// O. No secret appears in API responses.
test('O: safe payment view excludes secret-like fields', () => {
  const view = toSafePaymentView({
    id: 'p1',
    deploymentId: 'd1',
    providerType: 'crypto',
    amount: '10.00',
    currency: 'USD',
    status: 'pending',
    checkoutUrl: null,
    cryptoAmount: null,
    cryptoCurrency: null,
    cryptoNetwork: null,
    paymentAddress: null,
    transactionHash: null,
    providerStatus: 'waiting',
    paidAt: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    apiKey: 'SECRET-API-KEY',
    ipnSecret: 'SECRET-IPN-SECRET',
    nowpayments_api_key: 'leak',
  });

  assert.equal('apiKey' in view, false);
  assert.equal('ipnSecret' in view, false);
  assert.equal('nowpayments_api_key' in view, false);
  assert.equal(JSON.stringify(view).includes('SECRET-API-KEY'), false);
  assert.equal(JSON.stringify(view).includes('SECRET-IPN-SECRET'), false);
});

// P. No secret appears in configuration error messages.
test('P: configuration error does not leak the secret value', () => {
  withEnv({ NOWPAYMENTS_API_KEY: 'super-secret-key', NOWPAYMENTS_IPN_SECRET: '' }, () => {
    try {
      getNowPaymentsConfig();
      assert.fail('expected error');
    } catch (err: any) {
      assert.equal(err.message.includes('super-secret-key'), false);
    }
  });
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
}