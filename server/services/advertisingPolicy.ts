import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import * as schema from '../../drizzle/schema';
import { activePolicy, Principal, requirePolicyPermission } from './policyEngine';
import { auditOperation, requestApproval, runAgent } from './execution';
import { getCampaignMetrics } from './advertising/growthEngine';
import { minorUnits } from './profitAccounting';
import { callLLMJson } from './llm';

export async function proposeCampaignBudget(actor: Principal, input: { campaignId: string; amount: string; currency: string; expiresAt: Date; reinvestment: boolean }) {
  await requirePolicyPermission(actor, 'policies.edit');
  const campaign = (await db.select().from(schema.adCampaigns).where(eq(schema.adCampaigns.id, input.campaignId)).limit(1))[0];
  if (!campaign) throw new Error('Campaign not found.');
  const policy = await activePolicy('advertising', campaign.deploymentId);
  if (!policy) throw new Error('POLICY_NOT_CONFIGURED: advertising.');
  const config = JSON.parse(policy.configJson);
  const organic = await db.select().from(schema.adCampaigns).where(and(eq(schema.adCampaigns.deploymentId, campaign.deploymentId), eq(schema.adCampaigns.campaignType, 'FREE_ORGANIC'))).limit(1);
  if (!organic.length) throw new Error('Organic marketing preparation must come first.');
  const period = (await db.select().from(schema.accountingPeriods).where(eq(schema.accountingPeriods.deploymentId, campaign.deploymentId)).orderBy(desc(schema.accountingPeriods.endsAt)).limit(1))[0];
  if (!period?.reconciledAt || !period.calculationJson) throw new Error('Verified reconciled affordability evidence is required.');
  const calculation = JSON.parse(period.calculationJson);
  if (minorUnits(input.amount) <= 0n || minorUnits(input.amount) > minorUnits(calculation.businessPortion) || Number(input.amount) > config.campaignLimit) throw new Error('Proposed budget exceeds verified affordability or configured campaign limits.');
  const financePolicy = await activePolicy('finance', campaign.deploymentId);
  if (!financePolicy || JSON.parse(financePolicy.configJson).currency !== input.currency) throw new Error('Explicit matching financial currency required.');
  const metrics = await getCampaignMetrics(campaign.id);
  if (input.reinvestment && (metrics.source !== 'PROVIDER' || metrics.spend <= 0 || metrics.attributedRevenue <= metrics.spend)) throw new Error('Reinvestment requires demonstrated provider-verified positive advertising performance; generated or estimated metrics do not qualify.');
  const marketing = await runAgent('marketing', campaign.deploymentId, 'marketing', `budget:${campaign.id}:${input.amount}:${period.id}`, async () => z.object({ rationale: z.string().min(1), targetChannels: z.array(z.string()).min(1), limitations: z.array(z.string()) }).parse(await callLLMJson(`Recommend customer channels and justify this bounded proposed advertising budget. Return {rationale:string,targetChannels:string[],limitations:string[]}. No authorization or publication has occurred. ${JSON.stringify({ campaign: campaign.name, objective: campaign.objective, amount: input.amount, currency: input.currency, metrics })}`, { task: 'JSON_GENERATION' })));
  const finance = await runAgent('finance', campaign.deploymentId, 'finance', `budget-finance:${marketing.executionId}`, async () => ({ periodId: period.id, approvedForOwnerConsideration: minorUnits(input.amount) <= minorUnits(calculation.businessPortion), businessPortion: calculation.businessPortion, campaignLimit: config.campaignLimit, currency: input.currency }), { dependsOnTaskIds: [marketing.taskId] });
  const approvalId = await requestApproval(actor, { deploymentId: campaign.deploymentId, action: input.reinvestment ? 'reinvestment' : 'paid_campaign', resourceId: campaign.id, authority: 'user', risk: 'high', amount: input.amount, currency: input.currency, expiresAt: input.expiresAt, scope: { reusable: true, marketingExecutionId: marketing.executionId, financeExecutionId: finance.executionId, accountingPeriodId: period.id, reinvestment: input.reinvestment } });
  await auditOperation(finance.agentId, 'campaign_budget_proposed', approvalId, { campaignId: campaign.id, marketingExecutionId: marketing.executionId, financeExecutionId: finance.executionId, providerExecution: 'unavailable_until_supported_adapter' }, campaign.deploymentId);
  return { approvalId, marketing: marketing.value, finance: finance.value, executionStatus: 'pending_owner_authorization_and_supported_provider' };
}
