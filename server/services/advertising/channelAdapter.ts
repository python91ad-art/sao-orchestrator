// ============================================================
// ADVERTISING CHANNEL ADAPTER (Phase 13)
//
// Provider/channel abstraction layer. Each channel adapter exposes
// capabilities and status. No real credentials required now.
//
// All adapters return explicit status indicating whether they
// are configured and ready.
// ============================================================

export type ChannelId = 'google_ads' | 'meta_ads' | 'tiktok_ads' | 'organic_social' | 'content_marketing' | 'community_engagement';

export type ChannelStatus = 'NOT_CONFIGURED' | 'CONFIGURED' | 'READY' | 'ERROR' | 'RATE_LIMITED';

export interface ChannelCapabilities {
  canCreateCampaign: boolean;
  canPublishCreatives: boolean;
  canRetrieveMetrics: boolean;
  canPauseResume: boolean;
  requiresPayment: boolean;
  supportedContentFormats: string[];
}

export interface ChannelInfo {
  id: ChannelId;
  name: string;
  status: ChannelStatus;
  capabilities: ChannelCapabilities;
  missingCredentials: string[];
}

export interface CampaignCreateParams {
  name: string;
  deploymentId: string;
  budget: number;
  channel: ChannelId;
}

export interface CampaignPublishResult {
  success: boolean;
  providerCampaignId?: string;
  providerStatus?: string;
  error?: string;
  notConfigured: boolean;
}

// Credential env vars per channel (server-side only)
const CHANNEL_CREDENTIALS: Record<ChannelId, string[]> = {
  google_ads: ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN'],
  meta_ads: ['META_ADS_ACCESS_TOKEN', 'META_ADS_ACCOUNT_ID'],
  tiktok_ads: ['TIKTOK_ADS_ACCESS_TOKEN', 'TIKTOK_ADS_ADVERTISER_ID'],
  organic_social: [], // Free — no credentials
  content_marketing: [], // Free — no credentials
  community_engagement: [], // Free — no credentials
};

/**
 * Check which credentials are configured for a channel.
 * Returns the list of MISSING credential keys.
 */
export function getMissingCredentials(channel: ChannelId): string[] {
  const required = CHANNEL_CREDENTIALS[channel] || [];
  return required.filter((key) => !process.env[key]);
}

/**
 * Get the readiness status of a channel.
 */
export function getChannelStatus(channel: ChannelId): ChannelStatus {
  const missing = getMissingCredentials(channel);
  const required = CHANNEL_CREDENTIALS[channel] || [];

  if (required.length === 0) return 'READY'; // Free channels always ready
  if (missing.length === required.length) return 'NOT_CONFIGURED';
  if (missing.length > 0) return 'NOT_CONFIGURED'; // Partial config = not configured
  return 'CONFIGURED'; // All credentials present
}

/**
 * Get channel capabilities based on provider type.
 */
export function getChannelCapabilities(channel: ChannelId): ChannelCapabilities {
  const status = getChannelStatus(channel);
  const isConfigured = status === 'CONFIGURED' || status === 'READY';
  const requiresPayment = !['organic_social', 'content_marketing', 'community_engagement'].includes(channel);

  return {
    canCreateCampaign: isConfigured,
    canPublishCreatives: isConfigured,
    canRetrieveMetrics: isConfigured && requiresPayment,
    canPauseResume: isConfigured && requiresPayment,
    requiresPayment,
    supportedContentFormats: ['headline', 'primary_text', 'description', 'cta'],
  };
}

/**
 * Get full channel info suitable for safe dashboard display.
 */
export function getChannelInfo(channel: ChannelId): ChannelInfo {
  return {
    id: channel,
    name: channel.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    status: getChannelStatus(channel),
    capabilities: getChannelCapabilities(channel),
    missingCredentials: getMissingCredentials(channel),
  };
}

/**
 * List all available channels with status. Never exposes credential values.
 */
export function listChannels(): ChannelInfo[] {
  const allChannels: ChannelId[] = [
    'google_ads', 'meta_ads', 'tiktok_ads',
    'organic_social', 'content_marketing', 'community_engagement',
  ];
  return allChannels.map(getChannelInfo);
}

/**
 * Attempt to publish a campaign. ALWAYS returns NOT_CONFIGURED for paid
 * channels without credentials. For organic channels, returns READY.
 */
export async function publishCampaign(params: CampaignCreateParams): Promise<CampaignPublishResult> {
  const status = getChannelStatus(params.channel);

  if (status === 'NOT_CONFIGURED') {
    return {
      success: false,
      notConfigured: true,
      error: `Channel "${params.channel}" is NOT_CONFIGURED. Required credentials: ${getMissingCredentials(params.channel).join(', ') || 'none'}`,
    };
  }

  // For free channels, return success immediately (content is published through
  // manual or scheduled distribution — no API call needed)
  if (['organic_social', 'content_marketing', 'community_engagement'].includes(params.channel)) {
    return {
      success: true,
      providerCampaignId: `organic-${Date.now()}`,
      providerStatus: 'active',
      notConfigured: false,
    };
  }

  // Paid channels with credentials: the actual API call would happen here.
  // Currently no real API calls are made — this is architectural preparation.
  return {
    success: false,
    notConfigured: true,
    error: `Channel "${params.channel}" has credentials but live publishing is not yet active. Set ADVERTISING_LIVE_MODE=true to enable.`,
  };
}

/**
 * Check if live advertising mode is enabled (requires explicit opt-in).
 */
export function isLiveAdvertisingEnabled(): boolean {
  return process.env.ADVERTISING_LIVE_MODE === 'true';
}
