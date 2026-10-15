import { db } from '../../server/db';
import * as schema from '../../drizzle/schema';
import { policyDefinitions, PolicyCategory } from '../../shared/policyContracts';
import { ADMIN_PERMISSIONS } from '../../shared/permissions';
import { activatePolicy, savePolicyDraft, validatePolicyDraft } from '../../server/services/policyEngine';
import { createEvidence } from '../../server/services/infrastructure';
import { recordGapReview, reviewDiscoveryEvidence } from '../../server/services/discoveryPolicy';
import { decideApproval, requestApproval, validApproval } from '../../server/services/execution';

export async function configureTestPolicies(adminId: string) {
  const admin = { id: adminId, role: 'admin' };
  for (const permission of ADMIN_PERMISSIONS) await db.insert(schema.adminPermissions).values({ userId: adminId, permission }).onDuplicateKeyUpdate({ set: { permission } });
  const values: Record<PolicyCategory, Record<string, unknown>> = {
    discovery: { minimumSources: 2, demandWeight: 1, severityWeight: 1, evidenceWeight: 1, solutionWeight: 1, qualificationThreshold: 10, evidenceMaxAgeDays: 30 },
    specification: {},
    agents: { originalAgentRetries: 2, backupAgentRetries: 1, allowedTools: ['coordinate', 'review_conflict', 'specification', 'compliance', 'build', 'repair', 'qc', 'pricing', 'pricing_review', 'marketing', 'finance', 'deadline_review', 'strategy', 'analytics', 'research', 'lifecycle', 'discuss_conflict', 'architecture'] },
    pricing: { automaticChanges: true, maximumChangePercent: 10, minimumChangeIntervalHours: 1 },
    quality: { repairRetries: 2, maximumLatencyMs: 30000 },
    advertising: { campaignLimit: 100, performanceReviewDays: 7 },
    finance: { currency: 'USD', timezone: 'UTC', weekStartsOn: 1, accountingConvention: 'cash', transactionEligibility: 'verified_received', taxTreatment: 'verified_tax_deduction', rounding: 'half_up' },
    deadlines: { industry: 'home services', complexity: 'normal', initialDays: 30, maximumExtensions: 2, extensionDays: 7, minimumExtensionPrice: 10, maximumExtensionPrice: 50, profitabilityThreshold: 1, profitabilityPeriods: 2, warningDays: 3, customerGrowthThreshold: 1, demandThreshold: 5, sustainabilityThreshold: 5 },
    shutdown: { retentionDays: 365, lossSuspensionThreshold: 1000 },
  };
  for (const category of Object.keys(values) as PolicyCategory[]) {
    const draft = await savePolicyDraft(admin, { category, config: { ...policyDefinitions[category].defaults, ...values[category] }, reason: 'Isolated test fixture; not a production default.' });
    const validation = await validatePolicyDraft(admin, draft.id);
    if (!validation.valid || validation.missing.length) throw new Error(`Incomplete fixture: ${category} ${validation.missing}`);
    await activatePolicy(admin, draft.id);
  }
}
export async function authorizeTestGap(adminId: string, gapId: string) {
  const evidenceIds: string[] = [];
  for (const publisher of ['customers', 'market-research']) {
    const evidence = await createEvidence({ gapId, provider: 'isolated_fixture', sourceUrl: `https://${publisher}.example.test/verified-study/${gapId}`, category: 'customer_demand', summary: 'Controlled test evidence: documented interviews and independently collected demand observations.', reliability: { fixture: true, actualProductionEvidence: false } });
    evidenceIds.push(evidence.id);
    await reviewDiscoveryEvidence({ id: adminId, role: 'admin' }, evidence.id, true, 'Reviewed controlled isolated fixture source.', publisher);
  }
  await recordGapReview({ id: adminId, role: 'admin' }, { gapId, legalState: 'legal', complexity: 'normal', demandScore: 8, severityScore: 8, evidenceScore: 8, solutionScore: 8, evidenceIds, rationale: 'Authorized legal clearance for controlled test opportunity only.', confidence: 'clear', jurisdiction: 'Test jurisdiction', uncertainty: [] });
}
export async function authorizeTestDeployment(ownerId: string, deploymentId: string) {
  if (!await validApproval({ deploymentId, action: 'profit_share', resourceId: deploymentId, authority: 'user', currency: 'USD' })) {
    const agreement = await requestApproval({ id: ownerId, role: 'admin' }, { deploymentId, action: 'profit_share', resourceId: deploymentId, authority: 'user', risk: 'high', expiresAt: new Date(Date.now() + 30 * 86400000), currency: 'USD', scope: { reusable: true, platformPercent: 20, frequency: 'weekly', fixtureOnly: true } });
    await decideApproval({ id: ownerId, role: 'admin' }, agreement, 'approved');
  }
  if (await validApproval({ deploymentId, action: 'external_deployment', resourceId: deploymentId, authority: 'user' })) return;
  const id = await requestApproval({ id: ownerId, role: 'admin' }, { deploymentId, action: 'external_deployment', resourceId: deploymentId, authority: 'user', risk: 'high', expiresAt: new Date(Date.now() + 86400000), scope: { reusable: true, purpose: 'Mock provider deployment only in isolated test environment.' } });
  await decideApproval({ id: ownerId, role: 'admin' }, id, 'approved');
}
