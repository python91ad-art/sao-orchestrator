import assert from 'node:assert/strict';
import { policyCategories, policyDefinitions, validatePolicy } from '../shared/policyContracts';
import { decidePolicy, requirePolicyPermission } from '../server/services/policyEngine';
import { calculateVerifiedProfit, minorUnits } from '../server/services/profitAccounting';
import { mysqlPool } from '../server/db';

async function main() {
  assert.equal(policyCategories.length, 9);
  for (const category of policyCategories) {
    assert.equal(validatePolicy(category, policyDefinitions[category].defaults).valid, true);
    assert.equal(decidePolicy(category, null, 'high_impact_action', {}).decision, 'POLICY_NOT_CONFIGURED');
  }
  await assert.rejects(requirePolicyPermission({ id: 'agent', role: 'agent' }));
  await assert.rejects(requirePolicyPermission({ id: 'user', role: 'user' }));
  assert.equal(validatePolicy('finance', { ...policyDefinitions.finance.defaults, platformPercent: 21 }).valid, false);
  assert.equal(validatePolicy('agents', { ...policyDefinitions.agents.defaults, requireUserForSpending: false }).valid, false);
  assert.equal(validatePolicy('finance', { ...policyDefinitions.finance.defaults, timezone: 'Invalid/Zone' }).valid, false);
  assert.equal(validatePolicy('finance', { ...policyDefinitions.finance.defaults, accountingConvention: 'accrual' }).valid, false);
  assert.equal(validatePolicy('quality', { ...policyDefinitions.quality.defaults, mandatorySuites: ['unavailable_backend_runner'] }).valid, false);
  const { configurationReadiness } = await import('../shared/policyReadiness');
  assert.equal(configurationReadiness({}).length, 9);
  assert.ok(configurationReadiness({}).every(policy => policy.state === 'POLICY_NOT_CONFIGURED'));
  assert.ok(configurationReadiness({}).find(policy => policy.category === 'finance')?.fields.find(field => field.name === 'platformPercent')?.mandatorySafeguard);
  const discovery = { ...policyDefinitions.discovery.defaults, minimumSources: 2, demandWeight: 1, severityWeight: 1, evidenceWeight: 1, solutionWeight: 1, qualificationThreshold: 5, evidenceMaxAgeDays: 7 };
  assert.equal(decidePolicy('discovery', discovery, 'business_creation', { legalState: 'illegal' }).decision, 'DENY');
  assert.equal(decidePolicy('discovery', discovery, 'business_creation', { legalState: 'pending' }).decision, 'REQUIRES_LEGAL_REVIEW');
  assert.equal(decidePolicy('discovery', discovery, 'business_creation', { legalState: 'legal', legalReviewId: 'review', independentSources: ['same', 'same'], score: 9 }).decision, 'INSUFFICIENT_EVIDENCE');
  assert.equal(decidePolicy('discovery', discovery, 'business_creation', { legalState: 'legal', legalReviewId: 'review', independentSources: ['a', 'b'], score: 9 }).decision, 'ALLOW');
  const quality = { ...policyDefinitions.quality.defaults, repairRetries: 2, maximumLatencyMs: 500 };
  assert.equal(decidePolicy('quality', quality, 'release', { artifactId: 'artifact', qcAgentId: 'developer', builderAgentId: 'developer', architectComplianceId: 'review' }).decision, 'INSUFFICIENT_EVIDENCE');
  assert.equal(decidePolicy('quality', quality, 'release', { artifactId: 'artifact', qcAgentId: 'qc', builderAgentId: 'developer', architectComplianceId: 'review', suites: { functional: 'failed' } }).decision, 'DENY');
  const agents = { ...policyDefinitions.agents.defaults, originalAgentRetries: 2, backupAgentRetries: 1, allowedTools: ['test'] };
  const agentFacts = { verifiedIdentity: true, workspaceMatch: true, tool: 'test', roleAllowsTool: true };
  assert.equal(decidePolicy('agents', agents, 'tool_execution', { ...agentFacts, spending: true }).decision, 'REQUIRES_USER_AUTHORIZATION');
  assert.equal(decidePolicy('agents', agents, 'tool_execution', { ...agentFacts, highRisk: true }).decision, 'REQUIRES_SUPERVISOR_APPROVAL');
  assert.equal(decidePolicy('agents', agents, 'tool_execution', { ...agentFacts, workspaceMatch: false }).decision, 'DENY');
  assert.equal(decidePolicy('agents', agents, 'tool_execution', agentFacts).decision, 'ALLOW');
  assert.equal(decidePolicy('shutdown', null, 'suspend', {}).decision, 'ALLOW');
  const shutdown = { ...policyDefinitions.shutdown.defaults, retentionDays: 90, lossSuspensionThreshold: 100 };
  assert.equal(decidePolicy('shutdown', shutdown, 'closure', { supervisorApprovalId: 'approval' }).decision, 'REQUIRES_USER_AUTHORIZATION');
  const entries = [
    { id: 'revenue', kind: 'revenue' as const, amount: '100.00', currency: 'GBP', verified: true, disputed: false },
    ...(['expense', 'refund', 'fee', 'tax'] as const).map(kind => ({ id: kind, kind, amount: '10.00', currency: 'GBP', verified: true, disputed: false })),
  ];
  const profit = calculateVerifiedProfit({ entries, currency: 'GBP', openingLoss: '10.00', rounding: 'half_up' });
  assert.equal(profit.netProfit, '60.00');
  assert.equal(profit.eligibleProfit, '50.00');
  assert.equal(profit.platformPortion, '10.00');
  assert.equal(profit.businessPortion, '40.00');
  assert.equal(profit.payoutStatus, 'UNAVAILABLE');
  assert.equal(calculateVerifiedProfit({ entries, currency: 'GBP', openingLoss: '60.00', rounding: 'down' }).platformPortion, '0.00');
  assert.equal(calculateVerifiedProfit({ entries, currency: 'GBP', openingLoss: '80.00', rounding: 'down' }).closingLoss, '20.00');
  assert.throws(() => calculateVerifiedProfit({ entries: [...entries, entries[0]], currency: 'GBP', openingLoss: '0.00', rounding: 'down' }));
  assert.throws(() => calculateVerifiedProfit({ entries: [{ ...entries[0], disputed: true }], currency: 'GBP', openingLoss: '0.00', rounding: 'down' }));
  assert.throws(() => calculateVerifiedProfit({ entries, currency: 'USD', openingLoss: '0.00', rounding: 'down' }));
  assert.throws(() => minorUnits('1.234'));
  console.log('PASS nine policy contracts, deterministic gates, authorization denial and decimal-safe accounting fixtures');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => mysqlPool.end());
