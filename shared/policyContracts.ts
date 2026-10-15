import { z } from 'zod';

const limit = z.number().finite().positive().nullable();
const count = z.number().int().positive().nullable();
export const policySchemas = {
  discovery: z.object({ minimumSources: z.number().int().min(2).nullable(), demandWeight: limit, severityWeight: limit, evidenceWeight: limit, solutionWeight: limit, qualificationThreshold: limit, evidenceMaxAgeDays: limit, complexReasoning: z.enum(['high', 'extended']) }).strict(),
  specification: z.object({ requiredSections: z.array(z.string().min(1)).min(1), allowAutomaticImprovements: z.boolean(), requireArchitectReview: z.literal(true) }).strict(),
  agents: z.object({ originalAgentRetries: count, backupAgentRetries: count, allowedTools: z.array(z.string().min(1)), requireSupervisorForHighRisk: z.literal(true), requireUserForSpending: z.literal(true), requireUserForIrreversible: z.literal(true) }).strict(),
  pricing: z.object({ automaticChanges: z.boolean(), maximumChangePercent: limit, minimumChangeIntervalHours: limit, requireMarketEvidence: z.literal(true), requireSupervisorForHighRisk: z.literal(true) }).strict(),
  quality: z.object({ mandatorySuites: z.array(z.string().min(1)).min(1), repairRetries: count, maximumLatencyMs: limit, requireIndependentQc: z.literal(true), requireArchitectCompliance: z.literal(true) }).strict(),
  advertising: z.object({ organicFirst: z.literal(true), requireUserAuthorization: z.literal(true), requireReinvestmentAuthorization: z.literal(true), campaignLimit: limit, performanceReviewDays: limit }).strict(),
  finance: z.object({ platformPercent: z.literal(20), settlementFrequency: z.literal('weekly'), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), timezone: z.string().min(1).nullable(), weekStartsOn: z.number().int().min(0).max(6).nullable(), accountingConvention: z.enum(['cash', 'accrual']).nullable(), transactionEligibility: z.enum(['verified_received']).nullable(), taxTreatment: z.enum(['verified_tax_deduction']).nullable(), rounding: z.enum(['half_up', 'down']).nullable(), requireUserAuthorization: z.literal(true) }).strict(),
  deadlines: z.object({ industry: z.string().min(1).nullable(), complexity: z.enum(['normal', 'complex', 'very_complex']).nullable(), initialDays: count, maximumExtensions: count, extensionDays: count, minimumExtensionPrice: limit, maximumExtensionPrice: limit, profitabilityThreshold: z.number().finite().nonnegative().nullable(), profitabilityPeriods: count.optional(), warningDays: count.optional(), customerGrowthThreshold: z.number().int().nonnegative().nullable(), demandThreshold: limit, sustainabilityThreshold: limit }).strict(),
  shutdown: z.object({ requireSupervisorForClosure: z.literal(true), requireUserForDeletion: z.literal(true), preserveObligations: z.literal(true), freshBuildOnRestart: z.literal(true), retentionDays: count, lossSuspensionThreshold: limit }).strict(),
} as const;
export type PolicyCategory = keyof typeof policySchemas;
export const policyCategories = Object.keys(policySchemas) as PolicyCategory[];
export const policyDefinitions: Record<PolicyCategory, { name: string; description: string; agents: string[]; workflows: string[]; defaults: Record<string, unknown> }> = {
  discovery: { name: 'Discovery & Qualification', description: 'Independent evidence, legal clearance, ranking and reasoning.', agents: ['market_research', 'ceo_strategy'], workflows: ['discovery', 'qualification', 'business_creation'], defaults: { minimumSources: null, demandWeight: null, severityWeight: null, evidenceWeight: null, solutionWeight: null, qualificationThreshold: null, evidenceMaxAgeDays: null, complexReasoning: 'high' } },
  specification: { name: 'Master Business Specification', description: 'Architect review, shared requirements and recorded conflicts.', agents: ['system_architect', 'supervisor'], workflows: ['specification', 'conflict_resolution', 'build'], defaults: { requiredSections: ['objectives', 'productRequirements', 'technicalRequirements'], allowAutomaticImprovements: false, requireArchitectReview: true } },
  agents: { name: 'Agent Permissions & Coordination', description: 'Least privilege, approvals, dependencies and escalation.', agents: ['supervisor'], workflows: ['task_execution', 'tool_execution'], defaults: { originalAgentRetries: null, backupAgentRetries: null, allowedTools: [], requireSupervisorForHighRisk: true, requireUserForSpending: true, requireUserForIrreversible: true } },
  pricing: { name: 'Business Model & Pricing', description: 'Evidence-backed recommendations and approved adjustments.', agents: ['business_model_pricing', 'marketing', 'finance'], workflows: ['business_model', 'price_change'], defaults: { automaticChanges: false, maximumChangePercent: null, minimumChangeIntervalHours: null, requireMarketEvidence: true, requireSupervisorForHighRisk: true } },
  quality: { name: 'Independent Quality Control', description: 'Independent tests and separate specification compliance.', agents: ['independent_qc', 'system_architect'], workflows: ['release', 'post_deployment'], defaults: { mandatorySuites: ['functional', 'integration', 'security', 'performance'], repairRetries: null, maximumLatencyMs: null, requireIndependentQc: true, requireArchitectCompliance: true } },
  advertising: { name: 'Marketing & Advertising Budgets', description: 'Organic first; paid budgets and reinvestment require consent.', agents: ['marketing', 'advertising', 'finance', 'supervisor'], workflows: ['marketing', 'paid_campaign', 'reinvestment'], defaults: { organicFirst: true, requireUserAuthorization: true, requireReinvestmentAuthorization: true, campaignLimit: null, performanceReviewDays: null } },
  finance: { name: 'Profit Sharing & Weekly Settlement', description: '20% of verified positive net profit after losses and deductions.', agents: ['finance'], workflows: ['profit_calculation', 'settlement'], defaults: { platformPercent: 20, settlementFrequency: 'weekly', currency: null, timezone: null, weekStartsOn: null, accountingConvention: null, transactionEligibility: null, taxTreatment: null, rounding: null, requireUserAuthorization: true } },
  deadlines: { name: 'Deadlines, Success & Extensions', description: 'Configured success criteria and finite paid extensions.', agents: ['finance', 'ceo_strategy', 'analytics', 'supervisor'], workflows: ['deadline', 'success', 'extension'], defaults: { industry: null, complexity: null, initialDays: null, maximumExtensions: null, extensionDays: null, minimumExtensionPrice: null, maximumExtensionPrice: null, profitabilityThreshold: null, profitabilityPeriods: null, warningDays: null, customerGrowthThreshold: null, demandThreshold: null, sustainabilityThreshold: null } },
  shutdown: { name: 'Shutdown, Restart & Learning', description: 'Safe suspension, retained obligations and fresh-build restart.', agents: ['supervisor', 'system_architect', 'operations'], workflows: ['suspension', 'closure', 'restart'], defaults: { requireSupervisorForClosure: true, requireUserForDeletion: true, preserveObligations: true, freshBuildOnRestart: true, retentionDays: null, lossSuspensionThreshold: null } },
};
export function validatePolicy(category: PolicyCategory, config: unknown) {
  const result = policySchemas[category].safeParse(config);
  if (!result.success) return { valid: false, errors: result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`), missing: [] as string[] };
  const missing = Object.keys(policyDefinitions[category].defaults).filter(key => (result.data as Record<string, unknown>)[key] == null);
  const errors: string[] = [];
  const fields = result.data as Record<string, unknown>;
  if (category === 'finance' && fields.accountingConvention === 'accrual') errors.push('accountingConvention: accrual is unsupported by the verified-received cash ledger.');
  if (category === 'quality' && (fields.mandatorySuites as string[]).some(suite => !['functional', 'integration', 'security', 'performance'].includes(suite))) errors.push('mandatorySuites: unsupported runner; only implemented static artifact suites may be activated.');
  if (category === 'finance' && fields.timezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: String(fields.timezone) }); } catch { errors.push('timezone: invalid IANA timezone'); }
  }
  if (category === 'finance' && fields.currency) {
    const currency = String(fields.currency);
    if (!Intl.supportedValuesOf('currency').includes(currency) || new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits !== 2) errors.push('currency: this accounting workflow supports explicitly configured two-decimal ISO currencies only; no implicit currency conversion is permitted');
  }
  if (category === 'deadlines' && typeof fields.minimumExtensionPrice === 'number' && typeof fields.maximumExtensionPrice === 'number' && fields.minimumExtensionPrice > fields.maximumExtensionPrice) errors.push('Extension minimum exceeds maximum.');
  return { valid: errors.length === 0, errors, missing };
}
