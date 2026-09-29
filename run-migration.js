#!/usr/bin/env node

require('dotenv').config();

const mysql = require('mysql2/promise');

function buildDbUrlFromEnv() {
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '3306';
  const user = process.env.DB_USER || 'root';
  const pass = process.env.DB_PASSWORD || '';
  const name = process.env.DB_NAME || 'sao';
  return `mysql://${user}:${encodeURIComponent(pass)}@${host}:${port}/${name}`;
}

const DATABASE_URL = process.env.DATABASE_URL || buildDbUrlFromEnv();

const SQL = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id varchar(255) NOT NULL,
  deployment_id varchar(255),
  gap_id varchar(255),
  decision varchar(255) NOT NULL,
  reasoning text NOT NULL,
  explanation text NOT NULL,
  ban_risk enum('low','medium','high') NOT NULL DEFAULT 'low',
  business_health enum('healthy','warning','critical'),
  timestamp datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT audit_logs_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS core_loop_state (
  id varchar(255) NOT NULL DEFAULT 'singleton',
  is_running boolean NOT NULL DEFAULT false,
  interval_ms int NOT NULL DEFAULT 10800000,
  last_executed_at datetime,
  next_execution_at datetime,
  total_gaps_processed int NOT NULL DEFAULT 0,
  total_deployments_created int NOT NULL DEFAULT 0,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT core_loop_state_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS deployment_health_checks (
  id varchar(255) NOT NULL,
  deployment_id varchar(255) NOT NULL,
  revenue decimal(10,2) NOT NULL,
  ban_risk enum('low','medium','high') NOT NULL DEFAULT 'low',
  health enum('healthy','warning','critical') NOT NULL DEFAULT 'healthy',
  action text,
  success boolean NOT NULL DEFAULT true,
  checked_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT deployment_health_checks_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS deployments (
  id varchar(255) NOT NULL,
  gap_id varchar(255) NOT NULL,
  user_id varchar(255),
  status enum('active','paused','stopped') NOT NULL DEFAULT 'active',
  business_plan text,
  revenue decimal(10,2) NOT NULL DEFAULT '0.00',
  cost_per_day decimal(10,2) NOT NULL DEFAULT '0.00',
  ban_risk enum('low','medium','high') NOT NULL DEFAULT 'low',
  health enum('healthy','warning','critical') NOT NULL DEFAULT 'healthy',
  stripe_product_id varchar(255),
  stripe_price_id varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT deployments_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS gaps (
  id varchar(255) NOT NULL,
  knows text NOT NULL,
  needs text NOT NULL,
  controls_access text NOT NULL,
  underestimates_value text NOT NULL,
  source varchar(255) NOT NULL,
  status enum('pending','processing','safe','unsafe','gray','false','deployed','failed') NOT NULL DEFAULT 'pending',
  priority int NOT NULL DEFAULT 5,
  dedup_hash varchar(255) NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT gaps_id PRIMARY KEY(id),
  CONSTRAINT gaps_dedup_hash_unique UNIQUE(dedup_hash)
);

CREATE TABLE IF NOT EXISTS policies (
  id varchar(255) NOT NULL,
  rule_text text NOT NULL,
  acknowledged_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT policies_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS queue_items (
  id varchar(255) NOT NULL,
  gap_id varchar(255) NOT NULL,
  status enum('pending','processing','paused','completed','failed') NOT NULL DEFAULT 'pending',
  queue_type enum('synthesis','deployment','audit','maintenance') NOT NULL DEFAULT 'synthesis',
  worker_id varchar(255),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  last_error text,
  dedup_hash varchar(255) NOT NULL,
  priority int NOT NULL DEFAULT 5,
  sort_order int NOT NULL DEFAULT 0,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT queue_items_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS recurring_actors (
  id varchar(255) NOT NULL,
  actor_hash varchar(255) NOT NULL,
  frequency int NOT NULL DEFAULT 1,
  last_seen datetime NOT NULL,
  pattern text,
  anonymized_id varchar(255) NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT recurring_actors_id PRIMARY KEY(id),
  CONSTRAINT recurring_actors_actor_hash_unique UNIQUE(actor_hash)
);

CREATE TABLE IF NOT EXISTS users (
  id varchar(255) NOT NULL,
  email varchar(255) NOT NULL,
  password_hash varchar(255) NOT NULL,
  role enum('admin','user') NOT NULL DEFAULT 'user',
  reset_code varchar(255),
  reset_code_expiry datetime,
  last_signed_in datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT users_id PRIMARY KEY(id),
  CONSTRAINT users_email_unique UNIQUE(email)
);

CREATE TABLE IF NOT EXISTS registration_invites (
  id varchar(255) NOT NULL,
  email varchar(255) NOT NULL,
  role enum('admin','user') NOT NULL DEFAULT 'user',
  created_by varchar(255) NOT NULL,
  token_hash varchar(64) NULL,
  expires_at datetime,
  used_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT registration_invites_id PRIMARY KEY(id),
  CONSTRAINT registration_invites_token_hash_unique UNIQUE(token_hash)
);

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id varchar(255) NOT NULL,
  deployment_id varchar(255) NOT NULL,
  name varchar(255) NOT NULL,
  channel varchar(50) NOT NULL,
  status enum('PLANNED','DRAFT','ANALYSING','READY','WAITING_FOR_BUDGET','WAITING_FOR_CREDENTIALS','READY_TO_PUBLISH','ACTIVE','PAUSED','COMPLETED','FAILED','READY_FOR_APPROVAL','APPROVED','REJECTED','STOPPED') NOT NULL DEFAULT 'DRAFT',
  campaign_type enum('PAID','FREE_ORGANIC') NOT NULL DEFAULT 'PAID',
  objective varchar(255),
  target_audience text,
  offer varchar(512),
  call_to_action varchar(255),
  budget decimal(12,2) NOT NULL DEFAULT '0.00',
  daily_limit decimal(12,2) NOT NULL DEFAULT '0.00',
  approved_spend_limit decimal(12,2) NOT NULL DEFAULT '0.00',
  spent decimal(12,2) NOT NULL DEFAULT '0.00',
  revenue_attributed decimal(12,2) DEFAULT '0.00',
  approval_status varchar(32) NOT NULL DEFAULT 'NOT_REQUIRED',
  optimization_status varchar(32) NOT NULL DEFAULT 'MONITOR',
  strategy text,
  provider_campaign_id varchar(255),
  provider_status varchar(100),
  error_message text,
  started_at datetime,
  ended_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ad_campaigns_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS ad_creatives (
  id varchar(255) NOT NULL,
  campaign_id varchar(255) NOT NULL,
  format varchar(50) NOT NULL,
  content text NOT NULL,
  headline varchar(255),
  call_to_action varchar(100),
  target_audience varchar(512),
  variation int DEFAULT 1,
  provider_creative_id varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ad_creatives_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS ad_audience_research (
  id varchar(255) NOT NULL,
  deployment_id varchar(255) NOT NULL,
  research_json text NOT NULL,
  evidence_json text,
  source_hash varchar(64) NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ad_audience_research_id PRIMARY KEY(id),
  CONSTRAINT ad_audience_research_source_hash_unique UNIQUE(source_hash)
);

CREATE TABLE IF NOT EXISTS ad_budget_ledger (
  id varchar(255) NOT NULL,
  deployment_id varchar(255) NOT NULL,
  campaign_id varchar(255),
  payment_id varchar(255),
  type varchar(32) NOT NULL,
  amount decimal(12,2) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'POSTED',
  idempotency_key varchar(255) NOT NULL,
  metadata text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ad_budget_ledger_id PRIMARY KEY(id),
  CONSTRAINT ad_budget_ledger_idempotency_key_unique UNIQUE(idempotency_key)
);

CREATE TABLE IF NOT EXISTS ad_campaign_events (
  id varchar(255) NOT NULL,
  campaign_id varchar(255) NOT NULL,
  creative_id varchar(255),
  event_type varchar(32) NOT NULL,
  quantity int NOT NULL DEFAULT 1,
  amount decimal(12,2) NOT NULL DEFAULT '0.00',
  source varchar(32) NOT NULL DEFAULT 'INTERNAL',
  attribution varchar(32) NOT NULL DEFAULT 'UNKNOWN',
  idempotency_key varchar(255) NOT NULL,
  metadata text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ad_campaign_events_id PRIMARY KEY(id),
  CONSTRAINT ad_campaign_events_idempotency_key_unique UNIQUE(idempotency_key)
);

CREATE TABLE IF NOT EXISTS ad_approvals (
  id varchar(255) NOT NULL,
  deployment_id varchar(255) NOT NULL,
  campaign_id varchar(255) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'PENDING',
  requested_budget decimal(12,2) NOT NULL,
  requested_channel varchar(50) NOT NULL,
  strategy text,
  approved_limit decimal(12,2) NOT NULL DEFAULT '0.00',
  approved_by varchar(255),
  decision_reason text,
  decided_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ad_approvals_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS ad_experiments (
  id varchar(255) NOT NULL,
  campaign_id varchar(255) NOT NULL,
  hypothesis text NOT NULL,
  variable varchar(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'DRAFT',
  control_creative_id varchar(255),
  variant_a_creative_id varchar(255),
  variant_b_creative_id varchar(255),
  metrics_json text,
  selected_creative_id varchar(255),
  decision_reason text,
  started_at datetime,
  ended_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ad_experiments_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS ad_optimization_decisions (
  id varchar(255) NOT NULL,
  campaign_id varchar(255) NOT NULL,
  decision varchar(64) NOT NULL,
  reason text NOT NULL,
  metrics_json text,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ad_optimization_decisions_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS deployment_providers (
  id varchar(255) NOT NULL,
  deployment_id varchar(255) NOT NULL,
  provider_type enum('vercel','mollie') NOT NULL,
  provider_config json NOT NULL,
  deployment_url varchar(512),
  status enum('pending','active','failed','superseded') NOT NULL DEFAULT 'pending',
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT deployment_providers_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id varchar(255) NOT NULL,
  deployment_id varchar(255) NOT NULL,
  provider_type varchar(50) NOT NULL,
  provider_payment_id varchar(255),
  amount decimal(10,2) NOT NULL,
  currency varchar(10) NOT NULL DEFAULT 'EUR',
  status enum('pending','confirming','confirmed','paid','failed','canceled','expired','authorized','unknown') NOT NULL DEFAULT 'pending',
  checkout_url varchar(1024),
  crypto_amount decimal(38,18),
  crypto_currency varchar(20),
  crypto_network varchar(50),
  payment_address varchar(255),
  transaction_hash varchar(255),
  provider_status varchar(50),
  paid_at datetime,
  expires_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payments_id PRIMARY KEY(id)
);

INSERT INTO core_loop_state (id, is_running, interval_ms, total_gaps_processed, total_deployments_created)
VALUES ('singleton', false, 10800000, 0, 0)
ON DUPLICATE KEY UPDATE id = id;

CREATE TABLE IF NOT EXISTS integration_credentials (
  id varchar(255) NOT NULL,
  service varchar(128) NOT NULL,
  name varchar(255) NOT NULL DEFAULT 'Legacy Integration',
  provider_id varchar(128) NOT NULL DEFAULT 'custom',
  credential_type varchar(64) NOT NULL DEFAULT 'api_key',
  encrypted_value text NOT NULL,
  encryption_version int NOT NULL DEFAULT 1,
  base_url varchar(1024),
  config text,
  enabled boolean NOT NULL DEFAULT true,
  priority varchar(16),
  compatibility_status varchar(32) NOT NULL DEFAULT 'unknown',
  connection_status varchar(32) NOT NULL DEFAULT 'untested',
  last_tested_at datetime,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT integration_credentials_id PRIMARY KEY(id)
);

CREATE TABLE IF NOT EXISTS credential_audit_logs (
  id varchar(255) NOT NULL,
  user_id varchar(255),
  service varchar(64) NOT NULL,
  operation varchar(64) NOT NULL,
  success boolean NOT NULL DEFAULT true,
  message varchar(255),
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT credential_audit_logs_id PRIMARY KEY(id)
);
`;

// Columns to add individually (MySQL doesn't support ADD COLUMN IF NOT EXISTS)
const ALTER_COLUMNS = [
  { table: 'core_loop_state', column: 'max_attempts', definition: 'INT NOT NULL DEFAULT 3' },
  { table: 'core_loop_state', column: 'backoff_multiplier', definition: 'DECIMAL(3,1) NOT NULL DEFAULT 1.5' },
  { table: 'core_loop_state', column: 'base_delay_ms', definition: 'INT NOT NULL DEFAULT 5000' },
  { table: 'core_loop_state', column: 'queue_max_size', definition: 'INT NOT NULL DEFAULT 1000' },
  { table: 'core_loop_state', column: 'queue_expiration_hours', definition: 'INT NOT NULL DEFAULT 72' },
  { table: 'core_loop_state', column: 'concurrency', definition: 'INT NOT NULL DEFAULT 1' },
  { table: 'core_loop_state', column: 'max_cost_per_day', definition: 'DECIMAL(10,2) NOT NULL DEFAULT 50.00' },
  { table: 'core_loop_state', column: 'max_deployments', definition: 'INT NOT NULL DEFAULT 10' },
  { table: 'core_loop_state', column: 'auto_pause_on_high_ban_risk', definition: 'BOOLEAN NOT NULL DEFAULT true' },
  { table: 'core_loop_state', column: 'email_notifications', definition: 'BOOLEAN NOT NULL DEFAULT true' },
  { table: 'core_loop_state', column: 'slack_notifications', definition: 'BOOLEAN NOT NULL DEFAULT false' },
  { table: 'queue_items', column: 'queue_type', definition: "enum('synthesis','deployment','audit','maintenance') NOT NULL DEFAULT 'synthesis'" },
  { table: 'queue_items', column: 'worker_id', definition: 'varchar(255)' },
  { table: 'queue_items', column: 'next_retry_at', definition: 'datetime' },
  { table: 'deployments', column: 'user_id', definition: 'varchar(255)' },
  // Crypto payments (Phase 11 — NOWPayments). Additive only.
  { table: 'payments', column: 'crypto_amount', definition: 'decimal(38,18)' },
  { table: 'payments', column: 'crypto_currency', definition: 'varchar(20)' },
  { table: 'payments', column: 'crypto_network', definition: 'varchar(50)' },
  { table: 'payments', column: 'payment_address', definition: 'varchar(255)' },
  { table: 'payments', column: 'transaction_hash', definition: 'varchar(255)' },
  { table: 'payments', column: 'provider_status', definition: 'varchar(50)' },
  { table: 'payments', column: 'expires_at', definition: 'datetime' },
  // Autonomous business-management runtime columns on deployments.
  { table: 'deployments', column: 'last_seen_healthy_at', definition: 'datetime NULL' },
  { table: 'deployments', column: 'consecutive_failures', definition: 'INT NOT NULL DEFAULT 0' },
  { table: 'deployments', column: 'total_failures', definition: 'INT NOT NULL DEFAULT 0' },
  { table: 'deployments', column: 'last_failure_reason', definition: 'varchar(512) NULL' },
  { table: 'deployments', column: 'last_checked_at', definition: 'datetime NULL' },
  { table: 'deployments', column: 'recovery_count', definition: 'INT NOT NULL DEFAULT 0' },
  { table: 'deployments', column: 'auto_stopped_at', definition: 'datetime NULL' },
  { table: 'deployments', column: 'auto_stop_reason', definition: 'varchar(512) NULL' },
  { table: 'deployments', column: 'last_good_files', definition: 'text NULL' },
  { table: 'registration_invites', column: 'token_hash', definition: 'varchar(64) NULL' },
  { table: 'ad_campaigns', column: 'objective', definition: 'varchar(255) NULL' },
  { table: 'ad_campaigns', column: 'target_audience', definition: 'text NULL' },
  { table: 'ad_campaigns', column: 'offer', definition: 'varchar(512) NULL' },
  { table: 'ad_campaigns', column: 'call_to_action', definition: 'varchar(255) NULL' },
  { table: 'ad_campaigns', column: 'daily_limit', definition: "decimal(12,2) NOT NULL DEFAULT '0.00'" },
  { table: 'ad_campaigns', column: 'approved_spend_limit', definition: "decimal(12,2) NOT NULL DEFAULT '0.00'" },
  { table: 'ad_campaigns', column: 'approval_status', definition: "varchar(32) NOT NULL DEFAULT 'NOT_REQUIRED'" },
  { table: 'ad_campaigns', column: 'optimization_status', definition: "varchar(32) NOT NULL DEFAULT 'MONITOR'" },
  // Generic provider registry columns on integration_credentials.
  { table: 'integration_credentials', column: 'provider_id', definition: "varchar(128) NOT NULL DEFAULT 'custom'" },
  { table: 'integration_credentials', column: 'priority', definition: 'varchar(16) NULL' },
  { table: 'integration_credentials', column: 'compatibility_status', definition: "varchar(32) NOT NULL DEFAULT 'unknown'" },
  { table: 'integration_credentials', column: 'connection_status', definition: "varchar(32) NOT NULL DEFAULT 'untested'" },
  { table: 'integration_credentials', column: 'last_tested_at', definition: 'datetime NULL' },
];

// Columns whose definition must be modified in place (MySQL MODIFY).
// Re-applying the same definition is idempotent and non-destructive.
const ALTER_MODIFY_COLUMNS = [
  { table: 'payments', column: 'status', definition: "enum('pending','confirming','confirmed','paid','failed','canceled','expired','authorized','unknown') NOT NULL DEFAULT 'pending'" },
  { table: 'payments', column: 'provider_payment_id', definition: 'varchar(255) NULL' },
  { table: 'ad_campaigns', column: 'status', definition: "enum('PLANNED','DRAFT','ANALYSING','READY','WAITING_FOR_BUDGET','WAITING_FOR_CREDENTIALS','READY_TO_PUBLISH','ACTIVE','PAUSED','COMPLETED','FAILED','READY_FOR_APPROVAL','APPROVED','REJECTED','STOPPED') NOT NULL DEFAULT 'DRAFT'" },
];

async function main() {
  function getDbConfig() {
    const databaseUrl = process.env.DATABASE_URL;

    if (databaseUrl) {
      const parsed = new URL(databaseUrl);

      return {
        host: parsed.hostname,
        port: parseInt(parsed.port || '3306', 10),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: decodeURIComponent(parsed.pathname.replace(/^\/+/, '')),
        ssl: {
          rejectUnauthorized: false,
        },
        connectTimeout: 20000,
      };
    }

  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    socketPath: process.env.DB_SOCKET || undefined,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sao',
    ssl: process.env.DB_SOCKET ? undefined : {
      rejectUnauthorized: false,
    },
    connectTimeout: 20000,
  };
}

  const connectionOptions = getDbConfig();

  console.log('Connecting to MySQL database...');
  console.log({
    host: connectionOptions.host,
    port: connectionOptions.port,
    socketPath: connectionOptions.socketPath,
    user: connectionOptions.user,
    database: connectionOptions.database,
    tlsEnabled: !!connectionOptions.ssl,
  });

  const conn = await mysql.createConnection(connectionOptions);
  console.log('Connected! Running migration...\n');

  // Run CREATE TABLE statements
  const statements = SQL.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    try {
      await conn.execute(stmt);
      const tableName = stmt.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)/i);
      const insertMatch = stmt.match(/INSERT INTO\s+(\w+)/i);
      if (tableName) {
        console.log('✅ Table ready:', tableName[1]);
      } else if (insertMatch) {
        console.log('✅ Seed data:', insertMatch[1]);
      } else {
        console.log('✅ Statement executed');
      }
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' || err.code === 'ER_TABLE_EXISTS_ERROR') {
        console.log('⏭️  Already exists, skipping');
      } else {
        console.error('❌ Error:', err.message);
        throw err;
      }
    }
  }

  // Add missing columns one by one (MySQL-compatible — no IF NOT EXISTS)
  console.log('\n=== Checking columns ===');
  for (const { table, column, definition } of ALTER_COLUMNS) {
    try {
      // Check if column already exists
      const [rows] = await conn.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
      );

      if (rows.length > 0) {
        console.log(`⏭️  ${table}.${column} already exists`);
      } else {
        await conn.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`✅ Added column: ${table}.${column}`);
      }
    } catch (err) {
      console.error(`❌ Failed to add ${table}.${column}:`, err.message);
      throw err;
    }
  }

  // Modify column definitions in place (idempotent re-application).
  console.log('\n=== Modifying column definitions ===');
  for (const { table, column, definition } of ALTER_MODIFY_COLUMNS) {
    try {
      await conn.execute(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
      console.log(`✅ Modified column: ${table}.${column}`);
    } catch (err) {
      console.error(`❌ Failed to modify ${table}.${column}:`, err.message);
      throw err;
    }
  }

  // Verify all tables
  const [tables] = await conn.execute('SHOW TABLES');
  console.log('\n=== All tables in database ===');
  tables.forEach(t => console.log('  -', Object.values(t)[0]));

  // Ensure required indexes exist (idempotent).
  const INDEXES = [
    { name: 'idx_deployments_user', sql: 'CREATE INDEX idx_deployments_user ON deployments(user_id)' },
    { name: 'idx_deployments_gap', sql: 'CREATE INDEX idx_deployments_gap ON deployments(gap_id)' },
    { name: 'idx_dp_deployment_provider_status', sql: 'CREATE INDEX idx_dp_deployment_provider_status ON deployment_providers(deployment_id, provider_type, status)' },
    { name: 'idx_payments_deployment', sql: 'CREATE INDEX idx_payments_deployment ON payments(deployment_id)' },
    { name: 'idx_payments_provider_payment', sql: 'CREATE INDEX idx_payments_provider_payment ON payments(provider_type, provider_payment_id)' },
    { name: 'idx_registration_invites_token_hash', sql: 'CREATE UNIQUE INDEX idx_registration_invites_token_hash ON registration_invites(token_hash)' },
    { name: 'idx_integration_credentials_service', sql: 'CREATE INDEX idx_integration_credentials_service ON integration_credentials(service, provider_id)' },
    { name: 'idx_ad_campaigns_deployment', sql: 'CREATE INDEX idx_ad_campaigns_deployment ON ad_campaigns(deployment_id)' },
    { name: 'idx_ad_campaigns_status', sql: 'CREATE INDEX idx_ad_campaigns_status ON ad_campaigns(status)' },
    { name: 'idx_ad_creatives_campaign', sql: 'CREATE INDEX idx_ad_creatives_campaign ON ad_creatives(campaign_id)' },
    { name: 'idx_ad_audience_research_deployment', sql: 'CREATE INDEX idx_ad_audience_research_deployment ON ad_audience_research(deployment_id)' },
    { name: 'idx_ad_budget_ledger_deployment', sql: 'CREATE INDEX idx_ad_budget_ledger_deployment ON ad_budget_ledger(deployment_id)' },
    { name: 'idx_ad_budget_ledger_campaign', sql: 'CREATE INDEX idx_ad_budget_ledger_campaign ON ad_budget_ledger(campaign_id)' },
    { name: 'idx_ad_campaign_events_campaign', sql: 'CREATE INDEX idx_ad_campaign_events_campaign ON ad_campaign_events(campaign_id)' },
    { name: 'idx_ad_campaign_events_creative', sql: 'CREATE INDEX idx_ad_campaign_events_creative ON ad_campaign_events(creative_id)' },
    { name: 'idx_ad_campaign_events_type', sql: 'CREATE INDEX idx_ad_campaign_events_type ON ad_campaign_events(event_type)' },
    { name: 'idx_ad_approvals_deployment', sql: 'CREATE INDEX idx_ad_approvals_deployment ON ad_approvals(deployment_id)' },
    { name: 'idx_ad_approvals_campaign', sql: 'CREATE INDEX idx_ad_approvals_campaign ON ad_approvals(campaign_id)' },
    { name: 'idx_ad_approvals_status', sql: 'CREATE INDEX idx_ad_approvals_status ON ad_approvals(status)' },
    { name: 'idx_ad_experiments_campaign', sql: 'CREATE INDEX idx_ad_experiments_campaign ON ad_experiments(campaign_id)' },
    { name: 'idx_ad_experiments_status', sql: 'CREATE INDEX idx_ad_experiments_status ON ad_experiments(status)' },
    { name: 'idx_ad_optimization_campaign', sql: 'CREATE INDEX idx_ad_optimization_campaign ON ad_optimization_decisions(campaign_id)' },
    { name: 'idx_ad_optimization_decision', sql: 'CREATE INDEX idx_ad_optimization_decision ON ad_optimization_decisions(decision)' },
  ];
  for (const idx of INDEXES) {
    try {
      await conn.execute(idx.sql);
      console.log(`✅ Added index: ${idx.name}`);
    } catch (err) {
      if (err.code === 'ER_DUP_KEYNAME') {
        console.log(`⏭️  ${idx.name} index already exists`);
      } else {
        console.error(`❌ Failed to add ${idx.name} index:`, err.message);
        throw err;
      }
    }
  }

  // Backfill ownership for legacy deployments (assign to first admin)
  try {
    const [result] = await conn.execute(
      `UPDATE deployments SET user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1) WHERE user_id IS NULL`
    );
    if (result.affectedRows > 0) {
      console.log(`✅ Assigned admin ownership to ${result.affectedRows} legacy deployment(s).`);
    } else {
      console.log('⏭️  No unowned deployments to backfill.');
    }
  } catch (err) {
    console.error('❌ Failed to backfill deployment ownership:', err.message);
    throw err;
  }

  // Verify queue_items has the new columns
  console.log('\n=== queue_items columns ===');
  const [cols] = await conn.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'queue_items' ORDER BY ORDINAL_POSITION`
  );
  cols.forEach(c => console.log(`  - ${c.COLUMN_NAME} (${c.COLUMN_TYPE})`));

  await conn.end();
  console.log('\n✅ Migration complete!');
}

main().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
