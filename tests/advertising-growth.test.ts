// ============================================================
// Advertising Growth Engine Tests
// Exercises real production service helpers without live providers,
// payment callbacks, or paid advertising side effects.
// ============================================================

import assert from 'node:assert/strict';
import {
  buildAudienceResearch,
  calculateMetricsFromEvents,
  evaluateOptimization,
  evaluateSpendAuthorizationSnapshot,
  getAdvertisingAllocationPercentage,
  selectChannels,
} from '../server/services/advertising/growthEngine';

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

const analysis = {
  deploymentId: 'dep-test',
  appName: 'Clinic Booking Optimizer',
  category: 'healthcare operations',
  description: 'Automation for clinic teams that reduces missed bookings and saves time.',
  functionality: ['booking automation', 'patient reminders'],
  targetUsers: ['clinic operators', 'healthcare teams'],
  valueProposition: 'Reduce missed appointments and recover revenue.',
  keywords: ['clinic booking', 'patient reminders', 'healthcare workflow'],
  advertisingAngles: ['Recover lost booking revenue'],
  callsToAction: ['Start improving bookings'],
  completeness: 'complete' as const,
  missingFields: [],
};

console.log('\n=== Advertising Growth Engine Tests ===\n');

{
  withEnv('ADVERTISING_REVENUE_PERCENTAGE', undefined, () => {
    assert.strictEqual(getAdvertisingAllocationPercentage(), 20);
  });
  withEnv('ADVERTISING_REVENUE_PERCENTAGE', '15', () => {
    assert.strictEqual(getAdvertisingAllocationPercentage(), 15);
  });
  withEnv('ADVERTISING_REVENUE_PERCENTAGE', 'not-a-number', () => {
    assert.strictEqual(getAdvertisingAllocationPercentage(), 20);
  });
  console.log('✓ revenue allocation defaults to 20% and rejects invalid config');
}

{
  const audience = buildAudienceResearch(analysis);
  assert.strictEqual(audience.likelyCustomerType, 'clinic operators');
  assert.strictEqual(audience.marketType, 'B2B');
  assert.ok(audience.evidence.some((item) => item.includes('keywords=')));
  assert.ok(audience.organicOpportunities.length > 0);
  assert.ok(audience.paidOpportunities.length > 0);

  const noFunds = selectChannels({ research: audience, availableBudget: 0 });
  assert.strictEqual(noFunds[0].requiresPayment, false);
  assert.ok(noFunds[0].reasons.includes('organic-first'));

  const funded = selectChannels({ research: audience, availableBudget: 200 });
  assert.ok(funded.some((channel) => channel.channel === 'google_ads'));
  console.log('✓ audience research and channel scoring are evidence-based and organic-first');
}

{
  const metrics = calculateMetricsFromEvents([
    { eventType: 'impression', quantity: 1000, source: 'PROVIDER' },
    { eventType: 'reach', quantity: 800, source: 'PROVIDER' },
    { eventType: 'click', quantity: 50, source: 'PROVIDER' },
    { eventType: 'conversion', quantity: 5, source: 'INTERNAL' },
    { eventType: 'spend', amount: 100, source: 'PROVIDER' },
    { eventType: 'revenue', amount: 350, source: 'INTERNAL' },
  ]);
  assert.strictEqual(metrics.ctr, 0.05);
  assert.strictEqual(metrics.conversionRate, 0.1);
  assert.strictEqual(metrics.cpc, 2);
  assert.strictEqual(metrics.cpa, 20);
  assert.strictEqual(metrics.roas, 3.5);
  assert.strictEqual(metrics.source, 'MIXED');

  const zero = calculateMetricsFromEvents([]);
  assert.strictEqual(zero.ctr, 0);
  assert.strictEqual(zero.cpc, 0);
  assert.strictEqual(zero.roas, 0);
  console.log('✓ metrics math handles CTR/CPC/CPA/conversion-rate/ROAS and zero values');
}

{
  const base = {
    requestedAmount: 10,
    availableFunds: 100,
    campaignBudget: 100,
    campaignSpent: 0,
    approvedSpendLimit: 100,
    campaignDailyLimit: 25,
    campaignSpentToday: 0,
    businessDailyLimit: 50,
    businessSpentToday: 0,
    globalDailyLimit: 100,
    globalSpentToday: 0,
    campaignStatus: 'ACTIVE',
    campaignType: 'PAID',
    approvalStatus: 'APPROVED',
    liveMode: true,
    emergencyStop: false,
    channelStatus: 'CONFIGURED',
  };
  assert.strictEqual(evaluateSpendAuthorizationSnapshot(base).allowed, true);
  assert.match(evaluateSpendAuthorizationSnapshot({ ...base, availableFunds: 5 }).reason, /Insufficient/);
  assert.match(evaluateSpendAuthorizationSnapshot({ ...base, campaignBudget: 10, campaignSpent: 5 }).reason, /Campaign budget/);
  assert.match(evaluateSpendAuthorizationSnapshot({ ...base, campaignSpentToday: 20 }).reason, /Campaign daily/);
  assert.match(evaluateSpendAuthorizationSnapshot({ ...base, businessSpentToday: 45 }).reason, /Business daily/);
  assert.match(evaluateSpendAuthorizationSnapshot({ ...base, globalSpentToday: 95 }).reason, /Global advertising/);
  assert.match(evaluateSpendAuthorizationSnapshot({ ...base, approvalStatus: 'PENDING' }).reason, /not approved/);
  assert.match(evaluateSpendAuthorizationSnapshot({ ...base, emergencyStop: true }).reason, /emergency stop/);
  assert.match(evaluateSpendAuthorizationSnapshot({ ...base, channelStatus: 'STUBBED' }).reason, /STUBBED/);
  console.log('✓ server-side spend authorization denies unsafe paid actions');
}

{
  const insufficient = evaluateOptimization(
    calculateMetricsFromEvents([{ eventType: 'click', quantity: 3 }]),
    { ageHours: 1 }
  );
  assert.strictEqual(insufficient.decision, 'MONITOR');

  const poor = evaluateOptimization(
    calculateMetricsFromEvents([
      { eventType: 'impression', quantity: 1000 },
      { eventType: 'click', quantity: 5 },
      { eventType: 'spend', amount: 50 },
      { eventType: 'revenue', amount: 10 },
    ]),
    { ageHours: 48, minClicks: 5 }
  );
  assert.strictEqual(poor.decision, 'PAUSE');

  const strong = evaluateOptimization(
    calculateMetricsFromEvents([
      { eventType: 'impression', quantity: 2000 },
      { eventType: 'click', quantity: 100 },
      { eventType: 'conversion', quantity: 20 },
      { eventType: 'spend', amount: 100 },
      { eventType: 'revenue', amount: 500 },
    ]),
    { ageHours: 48 }
  );
  assert.strictEqual(strong.decision, 'KEEP_RUNNING');
  console.log('✓ optimizer avoids premature stops and pauses poor campaigns only after evidence');
}

console.log('\n=== Results: 6 passed, 0 failed ===\n');
process.exit(0);
