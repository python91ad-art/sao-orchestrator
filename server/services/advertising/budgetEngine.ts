// ============================================================
// ADVERTISING BUDGET ENGINE (Phase 13)
//
// Pure functions for calculating advertising budget from
// deployment revenue using a configurable percentage.
// ============================================================

/**
 * Advertising revenue-percentage configuration.
 * The percentage is configurable — never hardcoded.
 */
export function getAdvertisingRevenuePercentage(): number {
  const envValue = process.env.ADVERTISING_REVENUE_PERCENTAGE;
  if (!envValue || envValue.trim().length === 0) return 0;
  const percentage = Number(envValue);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return 0;
  return percentage;
}

/**
 * Calculate the advertising budget allocated from deployment revenue.
 * Pure function — no side effects.
 *
 * Formula: advertisingBudget = deploymentRevenue × (percentage / 100)
 *
 * Returns zero if:
 * - Revenue is zero or negative
 * - Percentage is zero or not configured
 */
export function calculateAdvertisingBudget(
  deploymentRevenue: number,
  percentageOverride?: number
): { budget: number; percentageUsed: number; cappedAtRevenue: boolean } {
  const percentage = percentageOverride ?? getAdvertisingRevenuePercentage();

  if (percentage <= 0 || deploymentRevenue <= 0) {
    return { budget: 0, percentageUsed: percentage, cappedAtRevenue: false };
  }

  const rawBudget = deploymentRevenue * (percentage / 100);
  // Budget cannot exceed deployment revenue (spending cap)
  const capped = rawBudget > deploymentRevenue;
  const budget = capped ? deploymentRevenue : rawBudget;

  return {
    budget: Math.round(budget * 100) / 100,
    percentageUsed: percentage,
    cappedAtRevenue: capped,
  };
}

/**
 * Check whether a campaign can spend the given amount.
 */
export function canSpend(
  allocatedBudget: number,
  alreadySpent: number,
  proposedSpend: number
): { allowed: boolean; remaining: number } {
  const remaining = Math.max(0, allocatedBudget - alreadySpent);
  return {
    allowed: proposedSpend <= remaining,
    remaining: Math.round(remaining * 100) / 100,
  };
}

/**
 * Determine whether to use PAID or FREE_ORGANIC based on budget availability.
 */
export function determineCampaignType(budget: number): 'PAID' | 'FREE_ORGANIC' {
  return budget > 0 ? 'PAID' : 'FREE_ORGANIC';
}
