import { mysqlTable, varchar, text, datetime, mysqlEnum, int, decimal, boolean, uniqueIndex } from 'drizzle-orm/mysql-core';
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
  status: mysqlEnum('status', ['active', 'paused', 'stopped']).default('active').notNull(),
  businessPlan: text('business_plan'),
  revenue: decimal('revenue', { precision: 10, scale: 2 }).default('0.00').notNull(),
  costPerDay: decimal('cost_per_day', { precision: 10, scale: 2 }).default('0.00').notNull(),
  banRisk: mysqlEnum('ban_risk', ['low', 'medium', 'high']).default('low').notNull(),
  health: mysqlEnum('health', ['healthy', 'warning', 'critical']).default('healthy').notNull(),
  stripeProductId: varchar('stripe_product_id', { length: 255 }),
  stripePriceId: varchar('stripe_price_id', { length: 255 }),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

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

export const integrationCredentials = mysqlTable('integration_credentials', {
  id: varchar('id', { length: 255 }).primaryKey(),
  service: varchar('service', { length: 64 }).notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  encryptionVersion: int('encryption_version').default(1).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: datetime('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => ({
  serviceUnique: uniqueIndex('integration_credentials_service_unique').on(table.service),
}));

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
// Registration Invites (for authorized sign-ups)
// ==========================================
export const registrationInvites = mysqlTable('registration_invites', {
  id: varchar('id', { length: 255 }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  role: mysqlEnum('role', ['admin', 'user']).default('user').notNull(),
  createdBy: varchar('created_by', { length: 255 }).notNull(), // admin user id
  expiresAt: datetime('expires_at'),
  usedAt: datetime('used_at'),
  createdAt: datetime('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});
