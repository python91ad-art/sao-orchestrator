// ============================================================
// ADVERTISING & GROWTH ENGINE
// ============================================================
// Deterministic server-side safety, metrics, approval, allocation,
// experiment, and optimization logic. Paid provider adapters remain
// explicit stubs until real integrations are connected.
// ============================================================

import crypto from 'crypto';
import { and, eq, gte, inArray } from 'drizzle-orm';
import * as database from '../../db';
import * as schema from '../../../drizzle/schema';
import { analyzeProject, ProjectAnalysis } from './projectAnalyzer';
import { AdvertisingStrategy, buildAdvertisingStrategy } from './strategyEngine';
import { getChannelStatus, isLiveAdvertisingEnabled } from './channelAdapter';

export type LedgerType = 'ALLOCATION' | 'RESERVATION' | 'SPEND' | 'RELEASE' | 'ADJUSTMENT';
export type MetricSource = 'PROVIDER' | 'INTERNAL' | 'ESTIMATED';
export type AttributionType = 'DIRECT' | 'ASSISTED' | 'ESTIMATED' | 'UNKNOWN';
export type OptimizationDecision =
  | 'KEEP_RUNNING'
  | 'MONITOR'
  | 'ADJUST'
  | 'PAUSE'
  | 'STOP'
  | 'START_AB_TEST'
  | 'PROMOTE_VARIANT'
  | 'REDUCE_BUDGET'
  | 'INCREASE_BUDGET_WITHIN_LIMITS';

export interface AudienceResearch {
  likelyCustomerType: string;
  customerProblem: string;
  buyerIntent: 'low' | 'medium' | 'high' | 'unknown';
  industries: string[];
  communities: string[];
  acquisitionChannels: string[];
  searchBehavior: string[];
  geographicRelevance: string;
  marketType: 'B2B' | 'B2C' | 'B2B2C' | 'unknown';
  expectedConversionIntent: 'low' | 'medium' | 'high' | 'unknown';
  organicOpportunities: string[];
  paidOpportunities: string[];
  evidence: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface CampaignMetrics {
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  spend: number;
  attributedRevenue: number;
  ctr: number;
  conversionRate: number;
  cpc: number;
  cpa: number;
  roas: number;
  source: MetricSource | 'MIXED';
}

export interface Balance {
  allocated: number;
  reserved: number;
  spent: number;
  available: number;
}

export interface SpendCheckInput {
  deploymentId: string;
  campaignId: string;
  requestedAmount: number;
}

export interface SpendCheckResult {
  allowed: boolean;
  reason: string;
  balance?: Balance;
}

export interface SpendAuthorizationSnapshot {
  requestedAmount: number;
  availableFunds: number;
  campaignBudget: number;
  campaignSpent: number;
  approvedSpendLimit: number;
  campaignDailyLimit: number;
  campaignSpentToday: number;
  businessDailyLimit: number;
  businessSpentToday: number;
  globalDailyLimit: number;
  globalSpentToday: number;
  campaignStatus: string;
  campaignType: string;
  approvalStatus: string;
  liveMode: boolean;
  emergencyStop: boolean;
  channelStatus: string;
}

const growthCooldowns = new Map<string, number>();

export function getAdvertisingAllocationPercentage(): number {
  const raw = process.env.ADVERTISING_REVENUE_PERCENTAGE;
  if (raw === undefined || raw.trim() === '') return 20;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 20;
}

function money(value: unknown): number {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function safeDiv(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isDuplicateKeyError(err: any): boolean {
  return err?.code === 'ER_DUP_ENTRY' || err?.cause?.code === 'ER_DUP_ENTRY';
}

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function calculateMetricsFromEvents(events: Array<{
  eventType: string;
  quantity?: number | null;
  amount?: string | number | null;
  source?: string | null;
}>): CampaignMetrics {
  let impressions = 0;
  let reach = 0;
  let clicks = 0;
  let conversions = 0;
  let spend = 0;
  let attributedRevenue = 0;
  const sources = new Set<string>();

  for (const event of events) {
    const q = Number(event.quantity || 1);
    const amount = money(event.amount);
    if (event.source) sources.add(event.source);
    switch (event.eventType) {
      case 'impression':
        impressions += q;
        break;
      case 'reach':
        reach += q;
        break;
      case 'click':
        clicks += q;
        break;
      case 'conversion':
        conversions += q;
        break;
      case 'spend':
        spend += amount;
        break;
      case 'revenue':
        attributedRevenue += amount;
        break;
    }
  }

  return {
    impressions,
    reach,
    clicks,
    conversions,
    spend,
    attributedRevenue,
    ctr: safeDiv(clicks, impressions),
    conversionRate: safeDiv(conversions, clicks),
    cpc: safeDiv(spend, clicks),
    cpa: safeDiv(spend, conversions),
    roas: safeDiv(attributedRevenue, spend),
    source: sources.size === 1 ? (Array.from(sources)[0] as MetricSource) : sources.size > 1 ? 'MIXED' : 'INTERNAL',
  };
}

export function evaluateSpendAuthorizationSnapshot(input: SpendAuthorizationSnapshot): SpendCheckResult {
  if (!Number.isFinite(input.requestedAmount) || input.requestedAmount <= 0) {
    return { allowed: false, reason: 'Requested spend must be positive.' };
  }
  if (input.emergencyStop) {
    return { allowed: false, reason: 'Advertising emergency stop is active.' };
  }
  if (input.campaignType !== 'PAID') {
    return { allowed: false, reason: 'Spend authorization only applies to paid campaigns.' };
  }
  if (!input.liveMode) {
    return { allowed: false, reason: 'Paid advertising live mode is disabled.' };
  }
  if (!['ACTIVE', 'APPROVED', 'READY_TO_PUBLISH'].includes(input.campaignStatus)) {
    return { allowed: false, reason: `Campaign status ${input.campaignStatus} is not spendable.` };
  }
  if (input.approvalStatus !== 'APPROVED') {
    return { allowed: false, reason: 'Campaign is not approved for paid spend.' };
  }
  if (input.channelStatus !== 'CONFIGURED' && input.channelStatus !== 'READY') {
    return { allowed: false, reason: `Channel is ${input.channelStatus}.` };
  }
  if (input.availableFunds < input.requestedAmount) {
    return { allowed: false, reason: 'Insufficient available advertising funds.' };
  }
  if (input.campaignBudget - input.campaignSpent < input.requestedAmount) {
    return { allowed: false, reason: 'Campaign budget would be exceeded.' };
  }
  if (input.approvedSpendLimit - input.campaignSpent < input.requestedAmount) {
    return { allowed: false, reason: 'Approved spending limit would be exceeded.' };
  }
  if (input.campaignDailyLimit > 0 && input.campaignSpentToday + input.requestedAmount > input.campaignDailyLimit) {
    return { allowed: false, reason: 'Campaign daily limit would be exceeded.' };
  }
  if (input.businessDailyLimit > 0 && input.businessSpentToday + input.requestedAmount > input.businessDailyLimit) {
    return { allowed: false, reason: 'Business daily advertising limit would be exceeded.' };
  }
  if (input.globalDailyLimit > 0 && input.globalSpentToday + input.requestedAmount > input.globalDailyLimit) {
    return { allowed: false, reason: 'Global advertising daily limit would be exceeded.' };
  }
  return { allowed: true, reason: 'Authorized.' };
}

export function buildAudienceResearch(analysis: ProjectAnalysis): AudienceResearch {
  const text = [
    analysis.category,
    analysis.description,
    analysis.valueProposition,
    analysis.targetUsers.join(' '),
    analysis.keywords.join(' '),
  ].join(' ').toLowerCase();

  const isB2B = /\b(business|team|company|workflow|enterprise|operator|professional|agency|clinic|firm)\b/.test(text);
  const isB2C = /\b(consumer|student|parent|home|personal|individual|hobby|fitness|creator)\b/.test(text);
  const buyerIntent = /\b(urgent|compliance|cost|revenue|lead|invoice|booking|automation|save time)\b/.test(text) ? 'high' : analysis.completeness === 'complete' ? 'medium' : 'unknown';

  const communities = analysis.keywords.slice(0, 5).map((k) => `${k} communities`);
  const searchBehavior = analysis.keywords.slice(0, 5).map((k) => `${k} solution`);

  return {
    likelyCustomerType: analysis.targetUsers[0] || (isB2B ? 'business operator' : 'general user'),
    customerProblem: analysis.description || analysis.valueProposition || 'Problem not fully known',
    buyerIntent,
    industries: analysis.category && analysis.category !== 'unknown' ? [analysis.category] : [],
    communities,
    acquisitionChannels: buyerIntent === 'high'
      ? ['seo_content', 'google_ads', 'direct_outreach', 'relevant_communities']
      : ['organic_social', 'content_marketing', 'community_engagement'],
    searchBehavior,
    geographicRelevance: /\b(local|city|nearby|region|country|geo)\b/.test(text) ? 'Potentially local/geographic' : 'No geographic signal found',
    marketType: isB2B && isB2C ? 'B2B2C' : isB2B ? 'B2B' : isB2C ? 'B2C' : 'unknown',
    expectedConversionIntent: buyerIntent,
    organicOpportunities: ['seo_content', 'community_engagement', 'content_marketing'],
    paidOpportunities: buyerIntent === 'high' ? ['google_ads', 'meta_ads'] : ['retargeting_later'],
    evidence: [
      `completeness=${analysis.completeness}`,
      analysis.targetUsers.length ? `targetUsers=${analysis.targetUsers.join(', ')}` : 'targetUsers missing',
      analysis.keywords.length ? `keywords=${analysis.keywords.join(', ')}` : 'keywords missing',
    ],
    confidence: analysis.completeness === 'complete' ? 'high' : analysis.completeness === 'partial' ? 'medium' : 'low',
  };
}

export async function storeAudienceResearch(deploymentId: string, research: AudienceResearch) {
  const sourceHash = hash(`${deploymentId}:${JSON.stringify(research)}`);
  const existing = await database.db.select().from(schema.adAudienceResearch)
    .where(eq(schema.adAudienceResearch.sourceHash, sourceHash)).limit(1);
  if (existing[0]) return existing[0];
  const id = database.generateId();
  await database.db.insert(schema.adAudienceResearch).values({
    id,
    deploymentId,
    researchJson: JSON.stringify(research),
    evidenceJson: JSON.stringify(research.evidence || []),
    sourceHash,
  });
  return (await database.db.select().from(schema.adAudienceResearch).where(eq(schema.adAudienceResearch.id, id)).limit(1))[0];
}

export function selectChannels(input: {
  research: AudienceResearch;
  strategy?: AdvertisingStrategy;
  availableBudget: number;
  historical?: CampaignMetrics | null;
}) {
  const candidates = [
    { channel: 'seo_content', requiresPayment: false },
    { channel: 'community_engagement', requiresPayment: false },
    { channel: 'organic_social', requiresPayment: false },
    { channel: 'content_marketing', requiresPayment: false },
    { channel: 'direct_outreach', requiresPayment: false },
    { channel: 'google_ads', requiresPayment: true },
    { channel: 'meta_ads', requiresPayment: true },
  ];

  return candidates
    .map((candidate) => {
      let score = candidate.requiresPayment ? 30 : 60;
      const reasons: string[] = [];
      if (input.research.acquisitionChannels.includes(candidate.channel)) {
        score += 25;
        reasons.push('audience signal');
      }
      if (!candidate.requiresPayment) {
        score += 15;
        reasons.push('organic-first');
      }
      if (candidate.channel === 'google_ads' && input.research.buyerIntent === 'high') {
        score += 20;
        reasons.push('high search intent');
      }
      if (candidate.requiresPayment && input.availableBudget <= 0) {
        score -= 50;
        reasons.push('no available ad funds');
      }
      if (input.historical && input.historical.roas > 1.5 && candidate.requiresPayment) {
        score += 10;
        reasons.push('historical ROAS positive');
      }
      return { ...candidate, score, reasons };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

export async function getAdvertisingBalance(deploymentId: string): Promise<Balance> {
  const rows = await database.db.select().from(schema.adBudgetLedger)
    .where(eq(schema.adBudgetLedger.deploymentId, deploymentId));

  let allocated = 0;
  let reserved = 0;
  let spent = 0;
  for (const row of rows) {
    const amount = money(row.amount);
    if (row.type === 'ALLOCATION') allocated += amount;
    if (row.type === 'RESERVATION' && row.status === 'RESERVED') reserved += amount;
    if (row.type === 'SPEND') spent += amount;
    if (row.type === 'ADJUSTMENT') allocated += amount;
  }
  const available = Math.max(0, Math.round((allocated - reserved - spent) * 100) / 100);
  return { allocated, reserved, spent, available };
}

export async function allocateRevenueForPayment(payment: any, deployment: any) {
  if (!payment || payment.status !== 'paid' || !deployment) return null;
  const percentage = getAdvertisingAllocationPercentage();
  const gross = money(payment.amount);
  const amount = Math.round(gross * (percentage / 100) * 100) / 100;
  if (amount <= 0) return null;
  const idempotencyKey = `ad-allocation:payment:${payment.id}`;

  try {
    const id = database.generateId();
    await database.db.insert(schema.adBudgetLedger).values({
      id,
      deploymentId: deployment.id,
      paymentId: payment.id,
      type: 'ALLOCATION',
      amount: amount.toFixed(2),
      status: 'POSTED',
      idempotencyKey,
      metadata: JSON.stringify({ gross, percentage }),
    });
    await database.createAuditLog({
      deploymentId: deployment.id,
      gapId: deployment.gapId,
      decision: 'Advertising Allocation',
      reasoning: `${percentage}% of realized payment revenue allocated to advertising.`,
      explanation: `Payment ${payment.id} allocated $${amount.toFixed(2)} from $${gross.toFixed(2)} realized revenue.`,
      banRisk: deployment.banRisk || 'low',
      businessHealth: deployment.health || 'healthy',
    });
  } catch (err: any) {
    if (!isDuplicateKeyError(err)) throw err;
  }
  return getAdvertisingBalance(deployment.id);
}

async function sumCampaignSpendToday(campaignId: string): Promise<number> {
  const rows = await database.db.select({ amount: schema.adCampaignEvents.amount })
    .from(schema.adCampaignEvents)
    .where(and(
      eq(schema.adCampaignEvents.campaignId, campaignId),
      eq(schema.adCampaignEvents.eventType, 'spend'),
      gte(schema.adCampaignEvents.createdAt, todayStart())
    ));
  return rows.reduce((sum, row) => sum + money(row.amount), 0);
}

async function sumBusinessSpendToday(deploymentId: string): Promise<number> {
  const campaigns = await database.listCampaignsForDeployment(deploymentId);
  const ids = campaigns.map((c: any) => c.id);
  if (ids.length === 0) return 0;
  const rows = await database.db.select({ amount: schema.adCampaignEvents.amount })
    .from(schema.adCampaignEvents)
    .where(and(
      inArray(schema.adCampaignEvents.campaignId, ids),
      eq(schema.adCampaignEvents.eventType, 'spend'),
      gte(schema.adCampaignEvents.createdAt, todayStart())
    ));
  return rows.reduce((sum, row) => sum + money(row.amount), 0);
}

export async function hasApprovedPaidCampaign(deploymentId: string): Promise<boolean> {
  const rows = await database.db.select().from(schema.adApprovals)
    .where(and(eq(schema.adApprovals.deploymentId, deploymentId), eq(schema.adApprovals.status, 'APPROVED')))
    .limit(1);
  return Boolean(rows[0]);
}

export async function canSpend(input: SpendCheckInput): Promise<SpendCheckResult> {
  if (!Number.isFinite(input.requestedAmount) || input.requestedAmount <= 0) {
    return { allowed: false, reason: 'Requested spend must be positive.' };
  }
  if (process.env.ADVERTISING_EMERGENCY_STOP === 'true') {
    return { allowed: false, reason: 'Advertising emergency stop is active.' };
  }
  const campaign = await database.getAdCampaignById(input.campaignId);
  if (!campaign || campaign.deploymentId !== input.deploymentId) {
    return { allowed: false, reason: 'Campaign not found for deployment.' };
  }
  if (campaign.campaignType !== 'PAID') {
    return { allowed: false, reason: 'Spend authorization only applies to paid campaigns.' };
  }
  if (!isLiveAdvertisingEnabled()) {
    return { allowed: false, reason: 'Paid advertising live mode is disabled.' };
  }
  if (!['ACTIVE', 'APPROVED', 'READY_TO_PUBLISH'].includes(campaign.status)) {
    return { allowed: false, reason: `Campaign status ${campaign.status} is not spendable.` };
  }
  if (campaign.approvalStatus !== 'APPROVED') {
    return { allowed: false, reason: 'Campaign is not approved for paid spend.' };
  }
  const channelStatus = getChannelStatus(campaign.channel as any);

  const balance = await getAdvertisingBalance(input.deploymentId);
  const campaignSpentToday = await sumCampaignSpendToday(campaign.id);
  const businessDailyLimit = Number(process.env.ADVERTISING_BUSINESS_DAILY_LIMIT || 0);
  const businessSpentToday = await sumBusinessSpendToday(input.deploymentId);
  const globalDailyLimit = Number(process.env.ADVERTISING_GLOBAL_DAILY_LIMIT || 0);
  let globalSpentToday = 0;
  if (globalDailyLimit > 0) {
    const rows = await database.db.select({ amount: schema.adCampaignEvents.amount })
      .from(schema.adCampaignEvents)
      .where(and(eq(schema.adCampaignEvents.eventType, 'spend'), gte(schema.adCampaignEvents.createdAt, todayStart())));
    globalSpentToday = rows.reduce((sum, row) => sum + money(row.amount), 0);
  }
  const result = evaluateSpendAuthorizationSnapshot({
    requestedAmount: input.requestedAmount,
    availableFunds: balance.available,
    campaignBudget: money(campaign.budget),
    campaignSpent: money(campaign.spent),
    approvedSpendLimit: money(campaign.approvedSpendLimit),
    campaignDailyLimit: money(campaign.dailyLimit),
    campaignSpentToday,
    businessDailyLimit,
    businessSpentToday,
    globalDailyLimit,
    globalSpentToday,
    campaignStatus: campaign.status,
    campaignType: campaign.campaignType,
    approvalStatus: campaign.approvalStatus,
    liveMode: isLiveAdvertisingEnabled(),
    emergencyStop: process.env.ADVERTISING_EMERGENCY_STOP === 'true',
    channelStatus,
  });
  return { ...result, balance };
}

export async function reserveSpend(input: SpendCheckInput & { idempotencyKey: string }) {
  const lockName = `ad-spend:${input.deploymentId}`;
  const connection = await database.mysqlPool.getConnection();
  try {
    const [lockRows] = await connection.query('SELECT GET_LOCK(?, 5) AS locked', [lockName]) as any;
    if (Number(lockRows?.[0]?.locked) !== 1) {
      await auditAdAction(input.deploymentId, input.campaignId, 'Advertising Authorization Denied', 'Could not acquire advertising spend lock.');
      return { success: false, reason: 'Could not acquire advertising spend lock.' };
    }
    const allowed = await canSpend(input);
    if (!allowed.allowed) {
      await auditAdAction(input.deploymentId, input.campaignId, 'Advertising Authorization Denied', allowed.reason);
      return { success: false, reason: allowed.reason, balance: allowed.balance };
    }
    const id = database.generateId();
    await database.db.insert(schema.adBudgetLedger).values({
      id,
      deploymentId: input.deploymentId,
      campaignId: input.campaignId,
      type: 'RESERVATION',
      amount: input.requestedAmount.toFixed(2),
      status: 'RESERVED',
      idempotencyKey: input.idempotencyKey,
    });
  } catch (err: any) {
    if (!isDuplicateKeyError(err)) throw err;
  } finally {
    try {
      await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } finally {
      connection.release();
    }
  }
  return { success: true, balance: await getAdvertisingBalance(input.deploymentId) };
}

export async function confirmReservedSpend(input: {
  deploymentId: string;
  campaignId: string;
  reservationKey: string;
  spendKey: string;
  amount: number;
}) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { success: false, reason: 'Confirmed spend must be positive.' };
  }
  const reservation = await database.db.select().from(schema.adBudgetLedger)
    .where(eq(schema.adBudgetLedger.idempotencyKey, input.reservationKey)).limit(1);
  if (!reservation[0] || reservation[0].status !== 'RESERVED') {
    return { success: false, reason: 'Reservation not found or already settled.' };
  }
  try {
    const id = database.generateId();
    await database.db.insert(schema.adBudgetLedger).values({
      id,
      deploymentId: input.deploymentId,
      campaignId: input.campaignId,
      type: 'SPEND',
      amount: input.amount.toFixed(2),
      status: 'POSTED',
      idempotencyKey: input.spendKey,
      metadata: JSON.stringify({ reservationKey: input.reservationKey }),
    });
    await database.db.update(schema.adBudgetLedger)
      .set({ status: 'SPENT' })
      .where(eq(schema.adBudgetLedger.idempotencyKey, input.reservationKey));
  } catch (err: any) {
    if (!isDuplicateKeyError(err)) throw err;
  }
  await recordCampaignEvent({
    campaignId: input.campaignId,
    eventType: 'spend',
    amount: input.amount,
    source: 'PROVIDER',
    attribution: 'UNKNOWN',
    idempotencyKey: `${input.spendKey}:event`,
  });
  return { success: true, balance: await getAdvertisingBalance(input.deploymentId) };
}

export async function releaseReservedSpend(input: {
  deploymentId: string;
  campaignId: string;
  reservationKey: string;
  releaseKey: string;
  reason: string;
}) {
  const reservation = await database.db.select().from(schema.adBudgetLedger)
    .where(eq(schema.adBudgetLedger.idempotencyKey, input.reservationKey)).limit(1);
  if (!reservation[0] || reservation[0].status !== 'RESERVED') {
    return { success: false, reason: 'Reservation not found or already settled.' };
  }
  const amount = money(reservation[0].amount);
  try {
    const id = database.generateId();
    await database.db.insert(schema.adBudgetLedger).values({
      id,
      deploymentId: input.deploymentId,
      campaignId: input.campaignId,
      type: 'RELEASE',
      amount: amount.toFixed(2),
      status: 'POSTED',
      idempotencyKey: input.releaseKey,
      metadata: JSON.stringify({ reservationKey: input.reservationKey, reason: input.reason }),
    });
    await database.db.update(schema.adBudgetLedger)
      .set({ status: 'RELEASED' })
      .where(eq(schema.adBudgetLedger.idempotencyKey, input.reservationKey));
  } catch (err: any) {
    if (!isDuplicateKeyError(err)) throw err;
  }
  await auditAdAction(input.deploymentId, input.campaignId, 'Budget Released', input.reason);
  return { success: true, balance: await getAdvertisingBalance(input.deploymentId) };
}

export async function recordCampaignEvent(input: {
  campaignId: string;
  creativeId?: string | null;
  eventType: 'impression' | 'reach' | 'click' | 'conversion' | 'spend' | 'revenue';
  quantity?: number;
  amount?: number;
  source?: MetricSource;
  attribution?: AttributionType;
  idempotencyKey: string;
  metadata?: any;
}) {
  const id = database.generateId();
  let inserted = false;
  try {
    await database.db.insert(schema.adCampaignEvents).values({
      id,
      campaignId: input.campaignId,
      creativeId: input.creativeId || null,
      eventType: input.eventType,
      quantity: input.quantity || 1,
      amount: (input.amount || 0).toFixed(2),
      source: input.source || 'INTERNAL',
      attribution: input.attribution || 'UNKNOWN',
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    });
    inserted = true;
  } catch (err: any) {
    if (!isDuplicateKeyError(err)) throw err;
  }
  if (inserted && input.eventType === 'spend') {
    const campaign = await database.getAdCampaignById(input.campaignId);
    if (campaign) {
      await database.updateAdCampaign(input.campaignId, {
        spent: (money(campaign.spent) + money(input.amount)).toFixed(2),
      } as any);
    }
  }
  if (inserted && input.eventType === 'revenue') {
    const campaign = await database.getAdCampaignById(input.campaignId);
    if (campaign) {
      await database.updateAdCampaign(input.campaignId, {
        revenueAttributed: (money(campaign.revenueAttributed) + money(input.amount)).toFixed(2),
      } as any);
    }
  }
  return getCampaignMetrics(input.campaignId);
}

export async function getCampaignMetrics(campaignId: string): Promise<CampaignMetrics> {
  const events = await database.db.select().from(schema.adCampaignEvents)
    .where(eq(schema.adCampaignEvents.campaignId, campaignId));
  return calculateMetricsFromEvents(events);
}

export async function approveCampaign(campaignId: string, adminUserId: string, approvedLimit: number, reason = 'Approved by admin') {
  const campaign = await database.getAdCampaignById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  const id = database.generateId();
  await database.db.insert(schema.adApprovals).values({
    id,
    deploymentId: campaign.deploymentId,
    campaignId,
    status: 'APPROVED',
    requestedBudget: String(campaign.budget),
    requestedChannel: campaign.channel,
    strategy: campaign.strategy || null,
    approvedLimit: approvedLimit.toFixed(2),
    approvedBy: adminUserId,
    decisionReason: reason,
    decidedAt: new Date(),
  });
  await database.updateAdCampaign(campaignId, {
    approvalStatus: 'APPROVED',
    approvedSpendLimit: approvedLimit.toFixed(2),
    status: 'APPROVED',
  } as any);
  await auditAdAction(campaign.deploymentId, campaignId, 'Campaign Approved', reason);
}

export async function rejectCampaign(campaignId: string, adminUserId: string, reason = 'Rejected by admin') {
  const campaign = await database.getAdCampaignById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  const id = database.generateId();
  await database.db.insert(schema.adApprovals).values({
    id,
    deploymentId: campaign.deploymentId,
    campaignId,
    status: 'REJECTED',
    requestedBudget: String(campaign.budget),
    requestedChannel: campaign.channel,
    strategy: campaign.strategy || null,
    approvedLimit: '0.00',
    approvedBy: adminUserId,
    decisionReason: reason,
    decidedAt: new Date(),
  });
  await database.updateAdCampaign(campaignId, { approvalStatus: 'REJECTED', status: 'REJECTED' } as any);
  await auditAdAction(campaign.deploymentId, campaignId, 'Campaign Rejected', reason);
}

export function evaluateOptimization(metrics: CampaignMetrics, opts: {
  ageHours: number;
  minRuntimeHours?: number;
  minImpressions?: number;
  minClicks?: number;
  minSpend?: number;
  minCtr?: number;
  minRoas?: number;
  maxCpa?: number;
}): { decision: OptimizationDecision; reason: string } {
  const cfg = {
    minRuntimeHours: opts.minRuntimeHours ?? 24,
    minImpressions: opts.minImpressions ?? 500,
    minClicks: opts.minClicks ?? 25,
    minSpend: opts.minSpend ?? 10,
    minCtr: opts.minCtr ?? 0.005,
    minRoas: opts.minRoas ?? 1,
    maxCpa: opts.maxCpa ?? 25,
  };
  if (opts.ageHours < cfg.minRuntimeHours || metrics.impressions < cfg.minImpressions || metrics.clicks < cfg.minClicks || metrics.spend < cfg.minSpend) {
    return { decision: 'MONITOR', reason: 'Insufficient sample size or runtime.' };
  }
  if (metrics.ctr < cfg.minCtr || (metrics.conversions > 0 && metrics.cpa > cfg.maxCpa) || (metrics.spend > 0 && metrics.roas < cfg.minRoas)) {
    return { decision: 'PAUSE', reason: 'Performance below configured thresholds.' };
  }
  if (metrics.roas >= cfg.minRoas * 2 && metrics.conversionRate > 0) {
    return { decision: 'KEEP_RUNNING', reason: 'Performance is above target.' };
  }
  return { decision: 'ADJUST', reason: 'Sample is sufficient but performance can be improved.' };
}

export async function optimizeCampaign(campaignId: string) {
  const campaign = await database.getAdCampaignById(campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  const metrics = await getCampaignMetrics(campaignId);
  const started = campaign.startedAt ? new Date(campaign.startedAt).getTime() : new Date(campaign.createdAt).getTime();
  const ageHours = Math.max(0, (Date.now() - started) / 36e5);
  const result = evaluateOptimization(metrics, { ageHours });
  const id = database.generateId();
  await database.db.insert(schema.adOptimizationDecisions).values({
    id,
    campaignId,
    decision: result.decision,
    reason: result.reason,
    metricsJson: JSON.stringify(metrics),
  });
  if (result.decision === 'PAUSE') {
    await database.updateAdCampaign(campaignId, { status: 'PAUSED', optimizationStatus: 'WARNING' } as any);
  } else {
    await database.updateAdCampaign(campaignId, { optimizationStatus: result.decision } as any);
  }
  await auditAdAction(campaign.deploymentId, campaignId, `Optimization: ${result.decision}`, result.reason);
  return { ...result, metrics };
}

export async function createExperiment(input: {
  campaignId: string;
  hypothesis: string;
  variable: string;
  controlCreativeId?: string | null;
  variantACreativeId?: string | null;
  variantBCreativeId?: string | null;
}) {
  const id = database.generateId();
  await database.db.insert(schema.adExperiments).values({
    id,
    campaignId: input.campaignId,
    hypothesis: input.hypothesis,
    variable: input.variable,
    controlCreativeId: input.controlCreativeId || null,
    variantACreativeId: input.variantACreativeId || null,
    variantBCreativeId: input.variantBCreativeId || null,
    status: 'DRAFT',
  });
  const campaign = await database.getAdCampaignById(input.campaignId);
  if (campaign) await auditAdAction(campaign.deploymentId, input.campaignId, 'Experiment Created', input.hypothesis);
  return id;
}

export async function startExperiment(experimentId: string) {
  const experiment = await database.getAdExperimentById(experimentId);
  if (!experiment) throw new Error('Experiment not found.');

  const creativeIds = [
    experiment.variantACreativeId,
    experiment.variantBCreativeId,
  ].filter(Boolean);

  if (creativeIds.length < 2) {
    throw new Error('Two configured variants are required before starting an experiment.');
  }

  if (['COMPLETED', 'STOPPED'].includes(experiment.status)) {
    throw new Error(`Experiment is terminal (${experiment.status}).`);
  }

  await database.updateAdExperiment(experimentId, {
    status: 'ACTIVE',
    startedAt: experiment.startedAt || new Date(),
    decisionReason: null,
  } as any);

  const campaign = await database.getAdCampaignById(experiment.campaignId);
  if (campaign) {
    await auditAdAction(campaign.deploymentId, experiment.campaignId, 'Experiment Started', experiment.hypothesis);
  }

  return database.getAdExperimentById(experimentId);
}

export async function stopExperiment(experimentId: string, reason = 'Stopped by admin') {
  const experiment = await database.getAdExperimentById(experimentId);
  if (!experiment) throw new Error('Experiment not found.');

  await database.updateAdExperiment(experimentId, {
    status: 'STOPPED',
    decisionReason: reason,
    endedAt: new Date(),
  } as any);

  const campaign = await database.getAdCampaignById(experiment.campaignId);
  if (campaign) {
    await auditAdAction(campaign.deploymentId, experiment.campaignId, 'Experiment Stopped', reason);
  }

  return database.getAdExperimentById(experimentId);
}

export async function evaluateExperiment(experimentId: string, minClicks = 50) {
  const rows = await database.db.select().from(schema.adExperiments)
    .where(eq(schema.adExperiments.id, experimentId)).limit(1);
  const experiment = rows[0];
  if (!experiment) throw new Error('Experiment not found.');
  if (['COMPLETED', 'STOPPED'].includes(experiment.status)) {
    return {
      status: experiment.status,
      selectedCreativeId: experiment.selectedCreativeId,
      reason: experiment.decisionReason || 'Experiment is terminal.',
      metrics: experiment.metricsJson ? JSON.parse(experiment.metricsJson) : {},
    };
  }
  const creativeIds = [experiment.variantACreativeId, experiment.variantBCreativeId].filter(Boolean) as string[];
  if (creativeIds.length < 2) {
    return { status: 'INCONCLUSIVE', reason: 'Two variants are required.' };
  }
  const events = await database.db.select().from(schema.adCampaignEvents)
    .where(and(eq(schema.adCampaignEvents.campaignId, experiment.campaignId), inArray(schema.adCampaignEvents.creativeId, creativeIds)));
  const byCreative = new Map<string, CampaignMetrics>();
  for (const id of creativeIds) {
    byCreative.set(id, calculateMetricsFromEvents(events.filter((e) => e.creativeId === id)));
  }
  const [a, b] = creativeIds.map((id) => byCreative.get(id)!);
  let status = 'INCONCLUSIVE';
  let selected: string | null = null;
  let reason = 'Insufficient evidence.';
  if (a.clicks >= minClicks && b.clicks >= minClicks) {
    if (a.conversionRate > b.conversionRate * 1.1) {
      status = 'COMPLETED'; selected = creativeIds[0]; reason = 'Variant A conversion rate is materially higher.';
    } else if (b.conversionRate > a.conversionRate * 1.1) {
      status = 'COMPLETED'; selected = creativeIds[1]; reason = 'Variant B conversion rate is materially higher.';
    } else {
      reason = 'Sample size is sufficient but no variant is materially better.';
    }
  }
  await database.db.update(schema.adExperiments).set({
    status: status === 'COMPLETED' ? 'COMPLETED' : experiment.status === 'ACTIVE' ? 'ACTIVE' : 'INCONCLUSIVE',
    selectedCreativeId: selected,
    decisionReason: reason,
    metricsJson: JSON.stringify(Object.fromEntries(byCreative)),
    endedAt: status === 'COMPLETED' ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(schema.adExperiments.id, experimentId));
  const persistedStatus = status === 'COMPLETED' ? 'COMPLETED' : experiment.status === 'ACTIVE' ? 'ACTIVE' : 'INCONCLUSIVE';
  if (persistedStatus === 'COMPLETED') {
    const campaign = await database.getAdCampaignById(experiment.campaignId);
    if (campaign) {
      await auditAdAction(campaign.deploymentId, experiment.campaignId, 'Experiment Completed', reason);
    }
  }
  return { status: persistedStatus, selectedCreativeId: selected, reason, metrics: Object.fromEntries(byCreative) };
}

export async function auditAdAction(deploymentId: string, campaignId: string | null, decision: string, reason: string) {
  const deployment = await database.getDeploymentById(deploymentId);
  await database.createAuditLog({
    deploymentId,
    gapId: deployment?.gapId,
    decision,
    reasoning: reason,
    explanation: campaignId ? `Advertising campaign ${campaignId}: ${reason}` : reason,
    banRisk: deployment?.banRisk || 'low',
    businessHealth: deployment?.health || 'healthy',
  });
}

export async function runAdvertisingLifecycleForDeployment(deployment: any): Promise<{
  preparedCampaign?: string;
  optimizedCampaigns: number;
  skipped?: string;
}> {
  if (!deployment?.id) return { optimizedCampaigns: 0, skipped: 'Deployment missing.' };
  if (process.env.ADVERTISING_AUTONOMOUS_ENABLED === 'false') {
    return { optimizedCampaigns: 0, skipped: 'Autonomous advertising disabled.' };
  }
  const cooldownMs = Math.max(60_000, Number(process.env.ADVERTISING_GROWTH_COOLDOWN_MS) || 21_600_000);
  const lastRun = growthCooldowns.get(deployment.id) || 0;
  if (Date.now() - lastRun < cooldownMs) {
    return { optimizedCampaigns: 0, skipped: 'Cooldown active.' };
  }
  growthCooldowns.set(deployment.id, Date.now());

  const campaigns = await database.listCampaignsForDeployment(deployment.id);
  let preparedCampaign: string | undefined;

  if (campaigns.length === 0) {
    const gap = await database.getGapById(deployment.gapId);
    const analysis = await analyzeProject({
      deploymentId: deployment.id,
      knows: gap?.knows || '',
      needs: gap?.needs || '',
      controlsAccess: gap?.controlsAccess || '',
      underestimatesValue: gap?.underestimatesValue || '',
      businessPlan: deployment.businessPlan || '',
    });
    const audience = buildAudienceResearch(analysis);
    await storeAudienceResearch(deployment.id, audience);
    const balance = await getAdvertisingBalance(deployment.id);
    const strategy = buildAdvertisingStrategy({
      projectAnalysis: analysis,
      advertisingBudget: balance.available,
      percentageUsed: getAdvertisingAllocationPercentage(),
    });
    const rankedChannels = selectChannels({ research: audience, strategy, availableBudget: balance.available });
    const organic = rankedChannels.find((c) => !c.requiresPayment) || { channel: 'organic_social' };
    const campaign = await database.createAdCampaign({
      deploymentId: deployment.id,
      name: `${analysis.appName.slice(0, 50)} - ${organic.channel}`,
      channel: organic.channel,
      campaignType: 'FREE_ORGANIC',
      status: 'PLANNED',
      objective: strategy.campaignObjectives[0],
      targetAudience: strategy.targetAudienceDescription,
      offer: strategy.valueProposition,
      callToAction: analysis.callsToAction[0] || 'Learn More',
      budget: '0.00',
      dailyLimit: '0.00',
      approvalStatus: 'NOT_REQUIRED',
      approvedSpendLimit: '0.00',
      strategy: JSON.stringify({ ...strategy, audience, rankedChannels, autonomous: true }),
    });
    preparedCampaign = campaign?.id;
    await auditAdAction(deployment.id, campaign?.id || null, 'Autonomous Organic Campaign Prepared', 'Prepared organic-first acquisition campaign without external publishing.');
  }

  let optimizedCampaigns = 0;
  const currentCampaigns = campaigns.length ? campaigns : await database.listCampaignsForDeployment(deployment.id);
  for (const campaign of currentCampaigns) {
    if (campaign.status === 'ACTIVE') {
      try {
        await optimizeCampaign(campaign.id);
        optimizedCampaigns += 1;
      } catch (err) {
        await auditAdAction(deployment.id, campaign.id, 'Optimization Failed', (err as Error)?.message || 'Unknown optimization failure');
      }
    }
  }

  return { preparedCampaign, optimizedCampaigns };
}
