import { mysqlTable, varchar, longtext, datetime, int, decimal, boolean, index } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

const identifier = (name: string) => varchar(name, { length: 255 });
const timestamp = (name: string) => datetime(name).notNull().default(sql`CURRENT_TIMESTAMP`);
export const approvals = mysqlTable('action_approvals', {
  id: identifier('id').primaryKey(), deploymentId: identifier('deployment_id').notNull(),
  action: varchar('action', { length: 128 }).notNull(), resourceId: identifier('resource_id').notNull(),
  authority: varchar('authority', { length: 32 }).notNull(), requestedBy: identifier('requested_by').notNull(),
  risk: varchar('risk', { length: 32 }).notNull(), amount: decimal('amount', { precision: 18, scale: 2 }), currency: varchar('currency', { length: 3 }),
  scopeJson: longtext('scope_json').notNull(), status: varchar('status', { length: 32 }).notNull().default('pending'),
  expiresAt: datetime('expires_at').notNull(), decidedBy: identifier('decided_by'), decidedAt: datetime('decided_at'),
  revokedAt: datetime('revoked_at'), executionRef: identifier('execution_ref'), createdAt: timestamp('created_at'),
}, table => [index('approval_scope').on(table.deploymentId, table.action, table.status)]);
export const agentSessions = mysqlTable('agent_sessions', {
  id: identifier('id').primaryKey(), agentId: identifier('agent_id').notNull(), deploymentId: identifier('deployment_id').notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(), toolsJson: longtext('tools_json').notNull(),
  expiresAt: datetime('expires_at').notNull(), revokedAt: datetime('revoked_at'), createdBy: identifier('created_by').notNull(), createdAt: timestamp('created_at'),
});
export const taskExecutions = mysqlTable('task_executions', {
  id: identifier('id').primaryKey(), taskId: identifier('task_id').notNull(), agentId: identifier('agent_id').notNull(),
  deploymentId: identifier('deployment_id').notNull(), specificationVersionId: identifier('specification_version_id'),
  tool: varchar('tool', { length: 128 }).notNull(), status: varchar('status', { length: 32 }).notNull(),
  attempt: int('attempt').notNull(), outputJson: longtext('output_json'), errorMessage: longtext('error_message'),
  startedAt: timestamp('started_at'), finishedAt: datetime('finished_at'),
}, table => [index('execution_task').on(table.taskId, table.startedAt)]);
export const releaseAuthorizations = mysqlTable('release_authorizations', {
  id: identifier('id').primaryKey(), deploymentId: identifier('deployment_id').notNull(), artifactId: identifier('artifact_id').notNull(),
  artifactHash: varchar('artifact_hash', { length: 64 }).notNull(), specificationVersionId: identifier('specification_version_id').notNull(),
  qcJobId: identifier('qc_job_id').notNull(), builderAgentId: identifier('builder_agent_id').notNull(), qcAgentId: identifier('qc_agent_id').notNull(),
  architectExecutionId: identifier('architect_execution_id').notNull(), policyEvaluationId: identifier('policy_evaluation_id'),
  status: varchar('status', { length: 32 }).notNull(), evidenceJson: longtext('evidence_json').notNull(), createdAt: timestamp('created_at'),
}, table => [index('release_business').on(table.deploymentId, table.createdAt)]);
export const accountingItems = mysqlTable('accounting_items', {
  id: identifier('id').primaryKey(), deploymentId: identifier('deployment_id').notNull(),
  economicKey: identifier('economic_key').notNull().unique(), paymentId: identifier('payment_id'),
  kind: varchar('kind', { length: 32 }).notNull(), amount: decimal('amount', { precision: 18, scale: 2 }).notNull(), currency: varchar('currency', { length: 3 }).notNull(),
  occurredAt: datetime('occurred_at').notNull(), verifiedBy: identifier('verified_by'), verifiedAt: datetime('verified_at'),
  disputed: boolean('disputed').notNull().default(false), periodId: identifier('period_id'), evidenceJson: longtext('evidence_json').notNull(), createdAt: timestamp('created_at'),
}, table => [index('accounting_business_period').on(table.deploymentId, table.occurredAt)]);
export const accountingPeriods = mysqlTable('accounting_periods', {
  id: identifier('id').primaryKey(), deploymentId: identifier('deployment_id').notNull(),
  periodKey: identifier('period_key').notNull().unique(), startsAt: datetime('starts_at').notNull(), endsAt: datetime('ends_at').notNull(),
  policyVersionId: identifier('policy_version_id').notNull(), authorizationId: identifier('authorization_id'), previousPeriodId: identifier('previous_period_id'),
  status: varchar('status', { length: 32 }).notNull(), calculationJson: longtext('calculation_json'),
  reconciledBy: identifier('reconciled_by'), reconciledAt: datetime('reconciled_at'), settlementId: identifier('settlement_id'), createdAt: timestamp('created_at'),
}, table => [index('period_business').on(table.deploymentId, table.endsAt)]);
export const priceProposals = mysqlTable('price_proposals', {
  id: identifier('id').primaryKey(), deploymentId: identifier('deployment_id').notNull(),
  amount: decimal('amount', { precision: 18, scale: 2 }).notNull(), currency: varchar('currency', { length: 3 }).notNull(),
  previousId: identifier('previous_id'), status: varchar('status', { length: 32 }).notNull(),
  risk: varchar('risk', { length: 32 }).notNull(), recommendationJson: longtext('recommendation_json').notNull(),
  evidenceIdsJson: longtext('evidence_ids_json').notNull(), appliedAt: datetime('applied_at'), createdAt: timestamp('created_at'),
}, table => [index('pricing_business').on(table.deploymentId, table.createdAt)]);
export const extensionOffers = mysqlTable('extension_offers', {
  id: identifier('id').primaryKey(), lifecycleId: identifier('lifecycle_id').notNull(), deploymentId: identifier('deployment_id').notNull(),
  price: decimal('price', { precision: 18, scale: 2 }).notNull(), currency: varchar('currency', { length: 3 }).notNull(),
  durationDays: int('duration_days').notNull(), status: varchar('status', { length: 32 }).notNull(), assessmentJson: longtext('assessment_json').notNull(),
  expiresAt: datetime('expires_at').notNull(), acceptedBy: identifier('accepted_by'), paymentId: identifier('payment_id'), createdAt: timestamp('created_at'),
}, table => [index('extension_business').on(table.deploymentId, table.status)]);
export const operationalSettings = mysqlTable('operational_settings', {
  key: varchar('setting_key', { length: 128 }).primaryKey(), valueJson: longtext('value_json').notNull(),
  revision: int('revision').notNull().default(1), updatedBy: identifier('updated_by').notNull(), updatedAt: timestamp('updated_at'),
});
export const operationalEvents = mysqlTable('operational_events', {
  id: identifier('id').primaryKey(), deploymentId: identifier('deployment_id'), actorId: identifier('actor_id').notNull(),
  type: varchar('event_type', { length: 128 }).notNull(), resourceId: identifier('resource_id'), detailJson: longtext('detail_json').notNull(), createdAt: timestamp('created_at'),
}, table => [index('operation_history').on(table.deploymentId, table.createdAt)]);
export const discoveryArchives = mysqlTable('discovery_archives', {
  gapId: identifier('gap_id').primaryKey(), resetId: identifier('reset_id').notNull(), reason: longtext('reason').notNull(), createdAt: timestamp('created_at'),
});
