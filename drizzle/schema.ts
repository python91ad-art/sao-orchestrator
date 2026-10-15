import { mysqlTable, varchar, text, longtext, datetime, mysqlEnum, int, decimal, boolean, json, index, primaryKey, AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';
export * from './operations';

export const policyVersions = mysqlTable('policy_versions', {
  id: varchar('id', { length: 255 }).primaryKey(),
  category: varchar('category', { length: 64 }).notNull(),
  configJson: longtext('config_json').notNull(),
  status: varchar('status', { length: 32 }).notNull().default('draft'),
  previousId: varchar('previous_id', { length: 255 }).references((): AnyMySqlColumn => policyVersions.id),
  actorId: varchar('actor_id', { length: 255 }).notNull(),
  reason: text('reason').notNull(),
  validationJson: longtext('validation_json'),
  impactJson: longtext('impact_json'),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [index('policy_category_created').on(table.category, table.createdAt)]);
export const policyHeads = mysqlTable('policy_heads', {
  category: varchar('category', { length: 64 }).primaryKey(),
  activeVersionId: varchar('active_version_id', { length: 255 }).references(() => policyVersions.id),
  updatedAt: datetime('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});
export const policyAssignments = mysqlTable('policy_assignments', {
  deploymentId: varchar('deployment_id', { length: 255 }).notNull().references(() => deployments.id),
  category: varchar('category', { length: 64 }).notNull(),
  versionId: varchar('version_id', { length: 255 }).notNull().references(() => policyVersions.id),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [primaryKey({ columns: [table.deploymentId, table.category] })]);
export const policyEvaluations = mysqlTable('policy_evaluations', {
  id: varchar('id', { length: 255 }).primaryKey(),
  category: varchar('category', { length: 64 }).notNull(),
  versionId: varchar('version_id', { length: 255 }).references(() => policyVersions.id),
  action: varchar('action', { length: 128 }).notNull(),
  deploymentId: varchar('deployment_id', { length: 255 }),
  gapId: varchar('gap_id', { length: 255 }),
  decision: varchar('decision', { length: 64 }).notNull(),
  reason: text('reason').notNull(),
  evidenceJson: longtext('evidence_json').notNull(),
  actorId: varchar('actor_id', { length: 255 }).notNull(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [index('policy_activity').on(table.category, table.createdAt), index('policy_business').on(table.deploymentId)]);
export const adminPermissions = mysqlTable('admin_permissions', {
  userId: varchar('user_id', { length: 255 }).notNull().references(() => users.id),
  permission: varchar('permission', { length: 64 }).notNull(),
}, table => [primaryKey({ columns: [table.userId, table.permission] })]);
export const discoveryResetReports = mysqlTable('discovery_reset_reports', {
  id: varchar('id', { length: 255 }).primaryKey(),
  actorId: varchar('actor_id', { length: 255 }).notNull(),
  reportJson: longtext('report_json').notNull(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});
export const gapPolicyReviews = mysqlTable('gap_policy_reviews', {
  id: varchar('id', { length: 255 }).primaryKey(),
  gapId: varchar('gap_id', { length: 255 }).notNull().references(() => gaps.id),
  legalState: varchar('legal_state', { length: 32 }).notNull(),
  complexity: varchar('complexity', { length: 32 }).notNull(),
  demandScore: decimal('demand_score', { precision: 12, scale: 4 }).notNull(),
  severityScore: decimal('severity_score', { precision: 12, scale: 4 }).notNull(),
  evidenceScore: decimal('evidence_score', { precision: 12, scale: 4 }).notNull(),
  solutionScore: decimal('solution_score', { precision: 12, scale: 4 }).notNull(),
  evidenceIdsJson: longtext('evidence_ids_json').notNull(),
  rationale: text('rationale').notNull(),
  actorId: varchar('actor_id', { length: 255 }).notNull(),
  createdAt: datetime('created_at', { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, table => [index('gap_review').on(table.gapId, table.createdAt)]);

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

// ==========================================
// Lifecycle infrastructure foundation
// ==========================================
// These tables are intentionally policy-neutral. They persist durable state,
// traceability and audit records without authorizing spend, deployment,
// outreach, settlement, shutdown or other high-impact business decisions.

export const evidenceRecords = mysqlTable('evidence_records', {
  id: varchar('id', { length: 255 }).primaryKey(),
  gapId: varchar('gap_id', { length: 255 }),
  deploymentId: varchar('deployment_id', { length: 255 }),
  businessSpecId: varchar('business_spec_id', { length: 255 }),
  provider: varchar('provider', { length: 128 }).notNull(),
  sourceUrl: varchar('source_url', { length: 2048 }),
  category: varchar('category', { length: 128 }).notNull().default('market_context'),
  title: varchar('title', { length: 512 }),
  summary: text('summary').notNull(),
  content: text('content'),
  retrievedAt: datetime('retrieved_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  publishedAt: datetime('published_at'),
  geography: varchar('geography', { length: 255 }),
  reportingPeriod: varchar('reporting_period', { length: 255 }),
  metadataJson: text('metadata_json'),
  reliabilityJson: text('reliability_json'),
  caveatsJson: text('caveats_json'),
  status: varchar('status', { length: 64 }).notNull().default('collected'),
  version: int('version').default(1).notNull(),
  dedupHash: varchar('dedup_hash', { length: 64 }).notNull().unique(),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_evidence_gap').on(table.gapId),
  index('idx_evidence_deployment').on(table.deploymentId),
  index('idx_evidence_provider').on(table.provider),
  index('idx_evidence_status').on(table.status),
]);

export const evidenceEvents = mysqlTable('evidence_events', {
  id: varchar('id', { length: 255 }).primaryKey(),
  evidenceId: varchar('evidence_id', { length: 255 }),
  gapId: varchar('gap_id', { length: 255 }),
  provider: varchar('provider', { length: 128 }).notNull(),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  message: text('message').notNull(),
  metadataJson: text('metadata_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_evidence_events_evidence').on(table.evidenceId),
  index('idx_evidence_events_gap').on(table.gapId),
]);

export const businessSpecifications = mysqlTable('business_specifications', {
  id: varchar('id', { length: 255 }).primaryKey(),
  gapId: varchar('gap_id', { length: 255 }),
  deploymentId: varchar('deployment_id', { length: 255 }),
  currentVersionId: varchar('current_version_id', { length: 255 }),
  status: varchar('status', { length: 64 }).notNull().default('draft'),
  approvalState: varchar('approval_state', { length: 64 }).notNull().default('POLICY_NOT_CONFIGURED'),
  title: varchar('title', { length: 255 }).notNull(),
  legacyBusinessPlan: text('legacy_business_plan'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_specs_gap').on(table.gapId),
  index('idx_specs_deployment').on(table.deploymentId),
  index('idx_specs_status').on(table.status),
]);

export const businessSpecificationVersions = mysqlTable('business_specification_versions', {
  id: varchar('id', { length: 255 }).primaryKey(),
  specificationId: varchar('specification_id', { length: 255 }).notNull(),
  versionNumber: int('version_number').notNull(),
  status: varchar('status', { length: 64 }).notNull().default('draft'),
  sectionsJson: longtext('sections_json').notNull(),
  changeSummary: text('change_summary'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_spec_versions_spec').on(table.specificationId),
]);

export const businessSpecificationEvents = mysqlTable('business_specification_events', {
  id: varchar('id', { length: 255 }).primaryKey(),
  specificationId: varchar('specification_id', { length: 255 }).notNull(),
  versionId: varchar('version_id', { length: 255 }),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  status: varchar('status', { length: 64 }).notNull().default('open'),
  title: varchar('title', { length: 255 }).notNull(),
  detail: text('detail').notNull(),
  metadataJson: text('metadata_json'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_spec_events_spec').on(table.specificationId),
  index('idx_spec_events_type').on(table.eventType),
  index('idx_spec_events_status').on(table.status),
]);

export const agents = mysqlTable('agents', {
  id: varchar('id', { length: 255 }).primaryKey(),
  role: varchar('role', { length: 128 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  capabilityJson: text('capability_json').notNull(),
  toolMetadataJson: text('tool_metadata_json'),
  availability: varchar('availability', { length: 64 }).notNull().default('registered'),
  implementationStatus: varchar('implementation_status', { length: 64 }).notNull().default('registered'),
  healthStatus: varchar('health_status', { length: 64 }).notNull().default('unknown'),
  version: varchar('version', { length: 64 }).notNull().default('1'),
  isBackup: boolean('is_backup').default(false).notNull(),
  backupForAgentId: varchar('backup_for_agent_id', { length: 255 }),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_agents_role').on(table.role),
  index('idx_agents_availability').on(table.availability),
]);

export const agentTasks = mysqlTable('agent_tasks', {
  id: varchar('id', { length: 255 }).primaryKey(),
  parentTaskId: varchar('parent_task_id', { length: 255 }),
  agentId: varchar('agent_id', { length: 255 }),
  gapId: varchar('gap_id', { length: 255 }),
  deploymentId: varchar('deployment_id', { length: 255 }),
  specificationId: varchar('specification_id', { length: 255 }),
  buildProjectId: varchar('build_project_id', { length: 255 }),
  taskType: varchar('task_type', { length: 128 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  state: varchar('state', { length: 64 }).notNull().default('pending'),
  inputJson: longtext('input_json'),
  outputJson: longtext('output_json'),
  errorMessage: text('error_message'),
  retryCount: int('retry_count').default(0).notNull(),
  policyStatus: varchar('policy_status', { length: 64 }).notNull().default('POLICY_NOT_CONFIGURED'),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull().unique(),
  recoveryCheckpointJson: longtext('recovery_checkpoint_json'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_agent_tasks_agent').on(table.agentId),
  index('idx_agent_tasks_state').on(table.state),
  index('idx_agent_tasks_gap').on(table.gapId),
  index('idx_agent_tasks_deployment').on(table.deploymentId),
]);

export const taskDependencies = mysqlTable('task_dependencies', {
  id: varchar('id', { length: 255 }).primaryKey(),
  taskId: varchar('task_id', { length: 255 }).notNull(),
  dependsOnTaskId: varchar('depends_on_task_id', { length: 255 }).notNull(),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_task_dependencies_task').on(table.taskId),
  index('idx_task_dependencies_depends').on(table.dependsOnTaskId),
]);

export const agentEvents = mysqlTable('agent_events', {
  id: varchar('id', { length: 255 }).primaryKey(),
  agentId: varchar('agent_id', { length: 255 }),
  taskId: varchar('task_id', { length: 255 }),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  message: text('message').notNull(),
  metadataJson: text('metadata_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_agent_events_agent').on(table.agentId),
  index('idx_agent_events_task').on(table.taskId),
]);

export const buildProjects = mysqlTable('build_projects', {
  id: varchar('id', { length: 255 }).primaryKey(),
  gapId: varchar('gap_id', { length: 255 }),
  deploymentId: varchar('deployment_id', { length: 255 }),
  specificationId: varchar('specification_id', { length: 255 }),
  projectType: varchar('project_type', { length: 64 }).notNull().default('software'),
  status: varchar('status', { length: 64 }).notNull().default('draft'),
  architectureJson: text('architecture_json'),
  frontendWorkspaceJson: text('frontend_workspace_json'),
  backendWorkspaceJson: text('backend_workspace_json'),
  databaseRequirementsJson: text('database_requirements_json'),
  integrationRequirementsJson: text('integration_requirements_json'),
  environmentConfigJson: text('environment_config_json'),
  policyStatus: varchar('policy_status', { length: 64 }).notNull().default('POLICY_NOT_CONFIGURED'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_build_projects_gap').on(table.gapId),
  index('idx_build_projects_deployment').on(table.deploymentId),
  index('idx_build_projects_spec').on(table.specificationId),
  index('idx_build_projects_status').on(table.status),
]);

export const buildArtifacts = mysqlTable('build_artifacts', {
  id: varchar('id', { length: 255 }).primaryKey(),
  buildProjectId: varchar('build_project_id', { length: 255 }).notNull(),
  artifactType: varchar('artifact_type', { length: 64 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  uri: varchar('uri', { length: 2048 }),
  version: varchar('version', { length: 64 }).notNull().default('1'),
  contentHash: varchar('content_hash', { length: 128 }),
  metadataJson: longtext('metadata_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_build_artifacts_project').on(table.buildProjectId),
]);

export const buildLogs = mysqlTable('build_logs', {
  id: varchar('id', { length: 255 }).primaryKey(),
  buildProjectId: varchar('build_project_id', { length: 255 }).notNull(),
  level: varchar('level', { length: 32 }).notNull().default('info'),
  message: text('message').notNull(),
  metadataJson: text('metadata_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_build_logs_project').on(table.buildProjectId),
]);

export const qcJobs = mysqlTable('qc_jobs', {
  id: varchar('id', { length: 255 }).primaryKey(),
  buildProjectId: varchar('build_project_id', { length: 255 }),
  artifactId: varchar('artifact_id', { length: 255 }),
  assignedAgentId: varchar('assigned_agent_id', { length: 255 }),
  status: varchar('status', { length: 64 }).notNull().default('pending'),
  releaseDecision: varchar('release_decision', { length: 64 }).notNull().default('POLICY_NOT_CONFIGURED'),
  summary: text('summary'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_qc_jobs_project').on(table.buildProjectId),
  index('idx_qc_jobs_status').on(table.status),
]);

export const qcTestRuns = mysqlTable('qc_test_runs', {
  id: varchar('id', { length: 255 }).primaryKey(),
  qcJobId: varchar('qc_job_id', { length: 255 }).notNull(),
  suiteName: varchar('suite_name', { length: 255 }).notNull(),
  testName: varchar('test_name', { length: 255 }).notNull(),
  status: varchar('status', { length: 64 }).notNull(),
  evidenceJson: text('evidence_json'),
  output: text('output'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_qc_test_runs_job').on(table.qcJobId),
  index('idx_qc_test_runs_status').on(table.status),
]);

export const defectReports = mysqlTable('defect_reports', {
  id: varchar('id', { length: 255 }).primaryKey(),
  qcJobId: varchar('qc_job_id', { length: 255 }),
  buildProjectId: varchar('build_project_id', { length: 255 }),
  repairTaskId: varchar('repair_task_id', { length: 255 }),
  severity: varchar('severity', { length: 64 }).notNull().default('medium'),
  status: varchar('status', { length: 64 }).notNull().default('open'),
  title: varchar('title', { length: 255 }).notNull(),
  detail: text('detail').notNull(),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_defects_qc').on(table.qcJobId),
  index('idx_defects_project').on(table.buildProjectId),
  index('idx_defects_status').on(table.status),
]);

export const leads = mysqlTable('leads', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }),
  source: varchar('source', { length: 128 }).notNull(),
  name: varchar('name', { length: 255 }),
  company: varchar('company', { length: 255 }),
  emailHash: varchar('email_hash', { length: 64 }),
  status: varchar('status', { length: 64 }).notNull().default('new'),
  metadataJson: text('metadata_json'),
  dedupHash: varchar('dedup_hash', { length: 64 }).notNull().unique(),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_leads_deployment').on(table.deploymentId),
  index('idx_leads_status').on(table.status),
]);

export const customers = mysqlTable('customers', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }),
  leadId: varchar('lead_id', { length: 255 }),
  name: varchar('name', { length: 255 }),
  company: varchar('company', { length: 255 }),
  emailHash: varchar('email_hash', { length: 64 }),
  status: varchar('status', { length: 64 }).notNull().default('active'),
  metadataJson: text('metadata_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_customers_deployment').on(table.deploymentId),
  index('idx_customers_lead').on(table.leadId),
]);

export const salesActivities = mysqlTable('sales_activities', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }),
  leadId: varchar('lead_id', { length: 255 }),
  customerId: varchar('customer_id', { length: 255 }),
  activityType: varchar('activity_type', { length: 64 }).notNull(),
  status: varchar('status', { length: 64 }).notNull().default('recorded'),
  notes: text('notes'),
  attributionJson: text('attribution_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_sales_activities_deployment').on(table.deploymentId),
  index('idx_sales_activities_lead').on(table.leadId),
  index('idx_sales_activities_customer').on(table.customerId),
]);

export const revenueAccounts = mysqlTable('revenue_accounts', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }),
  accountType: varchar('account_type', { length: 64 }).notNull(),
  currency: varchar('currency', { length: 10 }).notNull().default('USD'),
  status: varchar('status', { length: 64 }).notNull().default('open'),
  policyStatus: varchar('policy_status', { length: 64 }).notNull().default('POLICY_NOT_CONFIGURED'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_revenue_accounts_deployment').on(table.deploymentId),
  index('idx_revenue_accounts_type').on(table.accountType),
]);

export const revenueTransactions = mysqlTable('revenue_transactions', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }),
  paymentId: varchar('payment_id', { length: 255 }),
  customerId: varchar('customer_id', { length: 255 }),
  accountId: varchar('account_id', { length: 255 }),
  transactionType: varchar('transaction_type', { length: 64 }).notNull(),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 10 }).notNull().default('USD'),
  status: varchar('status', { length: 64 }).notNull().default('recorded'),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull().unique(),
  metadataJson: text('metadata_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_revenue_transactions_deployment').on(table.deploymentId),
  index('idx_revenue_transactions_payment').on(table.paymentId),
  index('idx_revenue_transactions_customer').on(table.customerId),
]);

export const settlementRecords = mysqlTable('settlement_records', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }),
  revenueTransactionId: varchar('revenue_transaction_id', { length: 255 }),
  settlementType: varchar('settlement_type', { length: 64 }).notNull(),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull().default('0.00'),
  currency: varchar('currency', { length: 10 }).notNull().default('USD'),
  status: varchar('status', { length: 64 }).notNull().default('POLICY_NOT_CONFIGURED'),
  policyStatus: varchar('policy_status', { length: 64 }).notNull().default('POLICY_NOT_CONFIGURED'),
  metadataJson: text('metadata_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_settlements_deployment').on(table.deploymentId),
  index('idx_settlements_status').on(table.status),
]);

export const businessLifecycleRecords = mysqlTable('business_lifecycle_records', {
  id: varchar('id', { length: 255 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 255 }),
  gapId: varchar('gap_id', { length: 255 }),
  state: varchar('state', { length: 64 }).notNull().default('monitoring'),
  deadlineAt: datetime('deadline_at'),
  deadlinePolicyStatus: varchar('deadline_policy_status', { length: 64 }).notNull().default('POLICY_NOT_CONFIGURED'),
  extensionPolicyStatus: varchar('extension_policy_status', { length: 64 }).notNull().default('POLICY_NOT_CONFIGURED'),
  shutdownPolicyStatus: varchar('shutdown_policy_status', { length: 64 }).notNull().default('POLICY_NOT_CONFIGURED'),
  finalReportJson: longtext('final_report_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_lifecycle_deployment').on(table.deploymentId),
  index('idx_lifecycle_gap').on(table.gapId),
  index('idx_lifecycle_state').on(table.state),
]);

export const businessLifecycleEvents = mysqlTable('business_lifecycle_events', {
  id: varchar('id', { length: 255 }).primaryKey(),
  lifecycleId: varchar('lifecycle_id', { length: 255 }).notNull(),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  status: varchar('status', { length: 64 }).notNull().default('recorded'),
  detail: text('detail').notNull(),
  metadataJson: text('metadata_json'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index('idx_lifecycle_events_lifecycle').on(table.lifecycleId),
  index('idx_lifecycle_events_type').on(table.eventType),
]);
