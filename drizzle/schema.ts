import { mysqlTable, varchar, text, datetime, mysqlEnum, int, decimal, boolean, json, index } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

export const users = mysqlTable('users', {
  id: varchar('id', { length: 255 }).primaryKey(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: mysqlEnum('role', ['admin', 'user']).default('user').notNull(),
  resetCode: varchar('reset_code', { length: 255 }),
  resetCodeExpiry: datetime('reset_code_expiry'),
  lastSignedIn: datetime('last_signed_in'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const gaps = mysqlTable('gaps', {
  id: varchar('id', { length: 255 }).primaryKey(),
  knows: text('knows').notNull(),
  needs: text('needs').notNull(),
  controlsAccess: text('controls_access').notNull(),
  underestimatesValue: text('underestimates_value').notNull(),
  source: varchar('source', { length: 255 }).notNull(),
  status: mysqlEnum('status', ['pending', 'processing', 'safe', 'unsafe', 'gray', 'false', 'deployed', 'failed']).default('pending').notNull(),
  priority: int('priority').default(5).notNull(),
  dedupHash: varchar('dedup_hash', { length: 255 }).unique().notNull(),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const queueItems = mysqlTable('queue_items', {
  id: varchar('id', { length: 255 }).primaryKey(),
  gapId: varchar('gap_id', { length: 255 }).notNull(),
  status: mysqlEnum('status', ['pending', 'processing', 'paused', 'completed', 'failed']).default('pending').notNull(),
  queueType: mysqlEnum('queue_type', ['synthesis', 'deployment', 'audit', 'maintenance']).default('synthesis').notNull(),
  workerId: varchar('worker_id', { length: 255 }),
  attempts: int('attempts').default(0).notNull(),
  maxAttempts: int('max_attempts').default(3).notNull(),
  lastError: text('last_error'),
  nextRetryAt: datetime('next_retry_at'),
  dedupHash: varchar('dedup_hash', { length: 255 }).notNull(),
  priority: int('priority').default(5).notNull(),
  sortOrder: int('sort_order').default(0).notNull(),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const deployments = mysqlTable('deployments', {
  id: varchar('id', { length: 255 }).primaryKey(),
  gapId: varchar('gap_id', { length: 255 }).notNull(),
  userId: varchar('user_id', { length: 255 }),
  status: mysqlEnum('status', ['active', 'paused', 'stopped']).default('active').notNull(),
  businessPlan: text('business_plan'),
  revenue: decimal('revenue', { precision: 10, scale: 2 }).default('0.00').notNull(),
  costPerDay: decimal('cost_per_day', { precision: 10, scale: 2 }).default('0.00').notNull(),
  banRisk: mysqlEnum('ban_risk', ['low', 'medium', 'high']).default('low').notNull(),
  health: mysqlEnum('health', ['healthy', 'warning', 'critical']).default('healthy').notNull(),
  stripeProductId: varchar('stripe_product_id', { length: 255 }),
  stripePriceId: varchar('stripe_price_id', { length: 255 }),
  // --- Autonomous management runtime state ---
  lastSeenHealthyAt: datetime('last_seen_healthy_at'),
  consecutiveFailures: int('consecutive_failures').default(0).notNull(),
  totalFailures: int('total_failures').default(0).notNull(),
  lastFailureReason: varchar('last_failure_reason', { length: 512 }),
  lastCheckedAt: datetime('last_checked_at'),
  recoveryCount: int('recovery_count').default(0).notNull(),
  autoStoppedAt: datetime('auto_stopped_at'),
  autoStopReason: varchar('auto_stop_reason', { length: 512 }),
  lastGoodFiles: text('last_good_files'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_deployments_user').on(table.userId),
  index('idx_deployments_gap').on(table.gapId),
]);

export const auditLogs = mysqlTable('audit_logs', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }),
  gapId: varchar('gap_id', { length: 255 }),
  decision: varchar('decision', { length: 255 }).notNull(),
  reasoning: text('reasoning').notNull(),
  explanation: text('explanation').notNull(),
  banRisk: mysqlEnum('ban_risk', ['low', 'medium', 'high']).default('low').notNull(),
  businessHealth: mysqlEnum('business_health', ['healthy', 'warning', 'critical']),
  timestamp: datetime('timestamp').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const policies = mysqlTable('policies', {
  id: varchar('id', { length: 255 }).primaryKey(),
  ruleText: text('rule_text').notNull(),
  acknowledgedAt: datetime('acknowledged_at'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const recurringActors = mysqlTable('recurring_actors', {
  id: varchar('id', { length: 255 }).primaryKey(),
  actorHash: varchar('actor_hash', { length: 255 }).unique().notNull(),
  frequency: int('frequency').default(1).notNull(),
  lastSeen: datetime('last_seen').notNull(),
  pattern: text('pattern'),
  anonymizedId: varchar('anonymized_id', { length: 255 }).notNull(),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const deploymentHealthChecks = mysqlTable('deployment_health_checks', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }).notNull(),
  revenue: decimal('revenue', { precision: 10, scale: 2 }).notNull(),
  banRisk: mysqlEnum('ban_risk', ['low', 'medium', 'high']).notNull(),
  health: mysqlEnum('health', ['healthy', 'warning', 'critical']).notNull(),
  action: text('action'),
  success: boolean('success').default(true).notNull(),
  checkedAt: datetime('checked_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const coreLoopState = mysqlTable('core_loop_state', {
  id: varchar('id', { length: 255 }).default('singleton').primaryKey(),
  isRunning: boolean('is_running').default(false).notNull(),
  intervalMs: int('interval_ms').default(10800000).notNull(),
  lastExecutedAt: datetime('last_executed_at'),
  nextExecutionAt: datetime('next_execution_at'),
  totalGapsProcessed: int('total_gaps_processed').default(0).notNull(),
  totalDeploymentsCreated: int('total_deployments_created').default(0).notNull(),
  maxAttempts: int('max_attempts').default(3).notNull(),
  backoffMultiplier: decimal('backoff_multiplier', { precision: 3, scale: 1 }).default('1.5').notNull(),
  baseDelayMs: int('base_delay_ms').default(5000).notNull(),
  queueMaxSize: int('queue_max_size').default(1000).notNull(),
  queueExpirationHours: int('queue_expiration_hours').default(72).notNull(),
  concurrency: int('concurrency').default(1).notNull(),
  maxCostPerDay: decimal('max_cost_per_day', { precision: 10, scale: 2 }).default('50.00').notNull(),
  maxDeployments: int('max_deployments').default(10).notNull(),
  autoPauseOnHighBanRisk: boolean('auto_pause_on_high_ban_risk').default(true).notNull(),
  emailNotifications: boolean('email_notifications').default(true).notNull(),
  slackNotifications: boolean('slack_notifications').default(false).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ==========================================
// Registration Invites (for authorized sign-ups)
// ==========================================
export const registrationInvites = mysqlTable('registration_invites', {
  id: varchar('id', { length: 255 }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  role: mysqlEnum('role', ['admin', 'user']).default('user').notNull(),
  createdBy: varchar('created_by', { length: 255 }).notNull(), // admin user id
  tokenHash: varchar('token_hash', { length: 64 }).unique(),
  expiresAt: datetime('expires_at'),
  usedAt: datetime('used_at'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ==========================================
// Deployment Providers (infrastructure providers, e.g. Vercel)
// ==========================================
export const deploymentProviders = mysqlTable('deployment_providers', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }).notNull(),
  providerType: mysqlEnum('provider_type', ['vercel', 'mollie']).notNull(),
  providerConfig: json('provider_config').notNull(),
  deploymentUrl: varchar('deployment_url', { length: 512 }),
  status: mysqlEnum('status', ['pending', 'active', 'failed', 'superseded']).default('pending').notNull(),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_dp_deployment_provider_status').on(table.deploymentId, table.providerType, table.status),
]);

// ==========================================
// Advertising Campaigns (Phase 13)
// ==========================================
export const adCampaigns = mysqlTable('ad_campaigns', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  channel: varchar('channel', { length: 50 }).notNull(), // provider type: google_ads, meta_ads, tiktok_ads, organic_social, etc.
  status: mysqlEnum('status', [
    'PLANNED', 'DRAFT', 'ANALYSING', 'READY', 'WAITING_FOR_BUDGET',
    'WAITING_FOR_CREDENTIALS', 'READY_TO_PUBLISH', 'ACTIVE',
    'PAUSED', 'COMPLETED', 'FAILED', 'READY_FOR_APPROVAL',
    'APPROVED', 'REJECTED', 'STOPPED'
  ]).default('DRAFT').notNull(),
  campaignType: mysqlEnum('campaign_type', ['PAID', 'FREE_ORGANIC']).default('PAID').notNull(),
  objective: varchar('objective', { length: 255 }),
  targetAudience: text('target_audience'),
  offer: varchar('offer', { length: 512 }),
  callToAction: varchar('call_to_action', { length: 255 }),
  budget: decimal('budget', { precision: 12, scale: 2 }).default('0.00').notNull(),
  dailyLimit: decimal('daily_limit', { precision: 12, scale: 2 }).default('0.00').notNull(),
  approvedSpendLimit: decimal('approved_spend_limit', { precision: 12, scale: 2 }).default('0.00').notNull(),
  spent: decimal('spent', { precision: 12, scale: 2 }).default('0.00').notNull(),
  revenueAttributed: decimal('revenue_attributed', { precision: 12, scale: 2 }).default('0.00'),
  approvalStatus: varchar('approval_status', { length: 32 }).default('NOT_REQUIRED').notNull(),
  optimizationStatus: varchar('optimization_status', { length: 32 }).default('MONITOR').notNull(),
  strategy: text('strategy'), // JSON: the strategy analysis
  providerCampaignId: varchar('provider_campaign_id', { length: 255 }),
  providerStatus: varchar('provider_status', { length: 100 }),
  errorMessage: text('error_message'),
  startedAt: datetime('started_at'),
  endedAt: datetime('ended_at'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_ad_campaigns_deployment').on(table.deploymentId),
  index('idx_ad_campaigns_status').on(table.status),
]);

// ==========================================
// Advertising Creatives (Phase 13)
// ==========================================
export const adCreatives = mysqlTable('ad_creatives', {
  id: varchar('id', { length: 255 }).primaryKey(),
  campaignId: varchar('campaign_id', { length: 255 }).notNull(),
  format: varchar('format', { length: 50 }).notNull(), // headline, primary_text, description, social_post, cta, etc.
  content: text('content').notNull(),
  headline: varchar('headline', { length: 255 }),
  callToAction: varchar('call_to_action', { length: 100 }),
  targetAudience: varchar('target_audience', { length: 512 }),
  variation: int('variation').default(1), // A/B testing variation number
  providerCreativeId: varchar('provider_creative_id', { length: 255 }),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_ad_creatives_campaign').on(table.campaignId),
]);

export const adAudienceResearch = mysqlTable('ad_audience_research', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }).notNull(),
  researchJson: text('research_json').notNull(),
  evidenceJson: text('evidence_json'),
  sourceHash: varchar('source_hash', { length: 64 }).notNull().unique(),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_ad_audience_research_deployment').on(table.deploymentId),
]);

export const adBudgetLedger = mysqlTable('ad_budget_ledger', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }).notNull(),
  campaignId: varchar('campaign_id', { length: 255 }),
  paymentId: varchar('payment_id', { length: 255 }),
  type: varchar('type', { length: 32 }).notNull(),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('POSTED'),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull().unique(),
  metadata: text('metadata'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_ad_budget_ledger_deployment').on(table.deploymentId),
  index('idx_ad_budget_ledger_campaign').on(table.campaignId),
]);

export const adCampaignEvents = mysqlTable('ad_campaign_events', {
  id: varchar('id', { length: 255 }).primaryKey(),
  campaignId: varchar('campaign_id', { length: 255 }).notNull(),
  creativeId: varchar('creative_id', { length: 255 }),
  eventType: varchar('event_type', { length: 32 }).notNull(),
  quantity: int('quantity').default(1).notNull(),
  amount: decimal('amount', { precision: 12, scale: 2 }).default('0.00').notNull(),
  source: varchar('source', { length: 32 }).notNull().default('INTERNAL'),
  attribution: varchar('attribution', { length: 32 }).notNull().default('UNKNOWN'),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull().unique(),
  metadata: text('metadata'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_ad_campaign_events_campaign').on(table.campaignId),
  index('idx_ad_campaign_events_creative').on(table.creativeId),
  index('idx_ad_campaign_events_type').on(table.eventType),
]);

export const adApprovals = mysqlTable('ad_approvals', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }).notNull(),
  campaignId: varchar('campaign_id', { length: 255 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('PENDING'),
  requestedBudget: decimal('requested_budget', { precision: 12, scale: 2 }).notNull(),
  requestedChannel: varchar('requested_channel', { length: 50 }).notNull(),
  strategy: text('strategy'),
  approvedLimit: decimal('approved_limit', { precision: 12, scale: 2 }).default('0.00').notNull(),
  approvedBy: varchar('approved_by', { length: 255 }),
  decisionReason: text('decision_reason'),
  decidedAt: datetime('decided_at'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_ad_approvals_deployment').on(table.deploymentId),
  index('idx_ad_approvals_campaign').on(table.campaignId),
  index('idx_ad_approvals_status').on(table.status),
]);

export const adExperiments = mysqlTable('ad_experiments', {
  id: varchar('id', { length: 255 }).primaryKey(),
  campaignId: varchar('campaign_id', { length: 255 }).notNull(),
  hypothesis: text('hypothesis').notNull(),
  variable: varchar('variable', { length: 64 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('DRAFT'),
  controlCreativeId: varchar('control_creative_id', { length: 255 }),
  variantACreativeId: varchar('variant_a_creative_id', { length: 255 }),
  variantBCreativeId: varchar('variant_b_creative_id', { length: 255 }),
  metricsJson: text('metrics_json'),
  selectedCreativeId: varchar('selected_creative_id', { length: 255 }),
  decisionReason: text('decision_reason'),
  startedAt: datetime('started_at'),
  endedAt: datetime('ended_at'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_ad_experiments_campaign').on(table.campaignId),
  index('idx_ad_experiments_status').on(table.status),
]);

export const adOptimizationDecisions = mysqlTable('ad_optimization_decisions', {
  id: varchar('id', { length: 255 }).primaryKey(),
  campaignId: varchar('campaign_id', { length: 255 }).notNull(),
  decision: varchar('decision', { length: 64 }).notNull(),
  reason: text('reason').notNull(),
  metricsJson: text('metrics_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_ad_optimization_campaign').on(table.campaignId),
  index('idx_ad_optimization_decision').on(table.decision),
]);
export const payments = mysqlTable('payments', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }).notNull(),
  providerType: varchar('provider_type', { length: 50 }).notNull(),
  providerPaymentId: varchar('provider_payment_id', { length: 255 }),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 10 }).notNull().default('EUR'),
  status: mysqlEnum('status', ['pending', 'confirming', 'confirmed', 'paid', 'failed', 'canceled', 'expired', 'authorized', 'unknown']).default('pending').notNull(),
  checkoutUrl: varchar('checkout_url', { length: 1024 }),
  cryptoAmount: decimal('crypto_amount', { precision: 38, scale: 18 }),
  cryptoCurrency: varchar('crypto_currency', { length: 20 }),
  cryptoNetwork: varchar('crypto_network', { length: 50 }),
  paymentAddress: varchar('payment_address', { length: 255 }),
  transactionHash: varchar('transaction_hash', { length: 255 }),
  providerStatus: varchar('provider_status', { length: 50 }),
  paidAt: datetime('paid_at'),
  expiresAt: datetime('expires_at'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_payments_deployment').on(table.deploymentId),
  index('idx_payments_provider_payment').on(table.providerType, table.providerPaymentId),
]);

// ==========================================
// Generic provider / API-key registry
// ==========================================
// One row per registered credential. `service` is the extensible service
// type (search, llm, deployment, advertising, payments, ...). `name` is a
// display name and `providerId` is the canonical provider key used to
// resolve an adapter (or 'custom' when no adapter exists yet).
export const integrationCredentials = mysqlTable('integration_credentials', {
  id: varchar('id', { length: 255 }).primaryKey(),
  service: varchar('service', { length: 128 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  providerId: varchar('provider_id', { length: 128 }).notNull().default('custom'),
  credentialType: varchar('credential_type', { length: 64 }).notNull().default('api_key'),
  encryptedValue: text('encrypted_value').notNull(),
  encryptionVersion: int('encryption_version').default(1).notNull(),
  baseUrl: varchar('base_url', { length: 1024 }),
  config: text('config'),
  enabled: boolean('enabled').default(true).notNull(),
  priority: varchar('priority', { length: 16 }),
  compatibilityStatus: varchar('compatibility_status', { length: 32 }).notNull().default('unknown'),
  connectionStatus: varchar('connection_status', { length: 32 }).notNull().default('untested'),
  lastTestedAt: datetime('last_tested_at'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_integration_credentials_service').on(table.service, table.providerId),
]);

export const credentialAuditLogs = mysqlTable('credential_audit_logs', {
  id: varchar('id', { length: 255 }).primaryKey(),
  userId: varchar('user_id', { length: 255 }),
  service: varchar('service', { length: 64 }).notNull(),
  operation: varchar('operation', { length: 64 }).notNull(),
  success: boolean('success').default(true).notNull(),
  message: varchar('message', { length: 255 }),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});
