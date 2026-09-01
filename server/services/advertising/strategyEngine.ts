// ============================================================
// ADVERTISING STRATEGY ENGINE (Phase 13)
//
// Converts project analysis into a concrete advertising strategy.
// Pure logic — no provider calls.
// ============================================================

import { ProjectAnalysis } from './projectAnalyzer';

export interface AdvertisingStrategy {
  deploymentId: string;
  whatToPromote: string;
  targetAudienceDescription: string;
  valueProposition: string;
  keyMessages: string[];
  recommendedChannels: RecommendedChannel[];
  campaignObjectives: string[];
  contentFormats: string[];
  budgetAllocation: {
    totalAvailable: number;
    recommendedDaily: number;
    isZeroBudget: boolean;
    recommendation: string;
  };
  notes: string;
  createdAt: string;
}

export interface RecommendedChannel {
  channel: string;
  suitability: 'high' | 'medium' | 'low';
  reason: string;
  requiresPayment: boolean;
}

export interface StrategyInput {
  projectAnalysis: ProjectAnalysis;
  advertisingBudget: number;
  percentageUsed: number;
}

/**
 * Build an advertising strategy from project analysis + budget.
 * Pure function — deterministic given the same input.
 */
export function buildAdvertisingStrategy(input: StrategyInput): AdvertisingStrategy {
  const { projectAnalysis, advertisingBudget } = input;

  const isZeroBudget = advertisingBudget <= 0;

  const channels: RecommendedChannel[] = isZeroBudget
    ? [
        { channel: 'organic_social', suitability: 'high', reason: 'Free social media distribution', requiresPayment: false },
        { channel: 'content_marketing', suitability: 'medium', reason: 'Blog posts and articles', requiresPayment: false },
        { channel: 'community_engagement', suitability: 'medium', reason: 'Relevant forums and communities', requiresPayment: false },
      ]
    : [
        { channel: 'google_ads', suitability: 'high', reason: 'Search intent targeting', requiresPayment: true },
        { channel: 'meta_ads', suitability: 'medium', reason: 'Target audience likely on social media', requiresPayment: true },
        { channel: 'tiktok_ads', suitability: 'low', reason: 'Broader reach potential', requiresPayment: true },
        { channel: 'organic_social', suitability: 'medium', reason: 'Complementary organic presence', requiresPayment: false },
      ];

  const keyMessages = generateKeyMessages(projectAnalysis);

  const objectives = isZeroBudget
    ? ['Build organic awareness', 'Drive organic traffic', 'Establish social presence']
    : ['Generate qualified leads', 'Drive conversions', 'Maximize ROAS', 'Build brand awareness'];

  return {
    deploymentId: projectAnalysis.deploymentId,
    whatToPromote: projectAnalysis.description || projectAnalysis.valueProposition,
    targetAudienceDescription:
      projectAnalysis.targetUsers.length > 0
        ? projectAnalysis.targetUsers.join(', ')
        : 'General audience interested in ' + (projectAnalysis.keywords.slice(0, 3).join(', ') || 'this service'),
    valueProposition: projectAnalysis.valueProposition,
    keyMessages,
    recommendedChannels: channels,
    campaignObjectives: objectives,
    contentFormats: ['headline', 'primary_text', 'description', 'cta', 'short_video_script'],
    budgetAllocation: {
      totalAvailable: advertisingBudget,
      recommendedDaily: isZeroBudget ? 0 : Math.max(1, Math.round((advertisingBudget / 30) * 100) / 100),
      isZeroBudget,
      recommendation: isZeroBudget
        ? 'No advertising budget available. Only FREE_ORGANIC channels can be used. Revenue must be generated before paid advertising becomes available.'
        : `$${advertisingBudget.toFixed(2)} total available (${input.percentageUsed}% of deployment revenue). Recommended daily spend: $${(advertisingBudget / 30).toFixed(2)}`,
    },
    notes: buildNotes(projectAnalysis, isZeroBudget),
    createdAt: new Date().toISOString(),
  };
}

function generateKeyMessages(analysis: ProjectAnalysis): string[] {
  const messages: string[] = [];

  if (analysis.valueProposition && analysis.valueProposition !== 'Unknown') {
    messages.push(analysis.valueProposition);
  }

  if (analysis.advertisingAngles.length > 0) {
    messages.push(...analysis.advertisingAngles.slice(0, 3));
  }

  if (analysis.keywords.length > 0 && messages.length === 0) {
    messages.push(`Solutions for ${analysis.keywords.slice(0, 3).join(', ')}`);
  }

  if (messages.length === 0) {
    messages.push('Solve your problem with our solution');
  }

  return messages.slice(0, 5);
}

function buildNotes(analysis: ProjectAnalysis, isZeroBudget: boolean): string {
  const parts: string[] = [];

  if (analysis.completeness === 'insufficient') {
    parts.push('WARNING: Project analysis is incomplete. Strategy may not be optimal.');
  } else if (analysis.completeness === 'partial') {
    parts.push('NOTE: Project analysis is partial. Some strategy elements may be missing.');
  }

  if (isZeroBudget) {
    parts.push('BUDGET: Zero-budget mode — only FREE_ORGANIC channels available.');
  }

  if (analysis.keywords.length === 0) {
    parts.push('No keywords identified — keyword targeting unavailable.');
  }

  return parts.join(' ') || 'Strategy generated from available project data.';
}
