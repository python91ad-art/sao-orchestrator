// ============================================================
// MIGRATION INTEGRITY TESTS
// Static checks for schema / SQL migration / startup-runner parity.
// Does not connect to or mutate a database.
// ============================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const schema = read('drizzle/schema.ts');
const runner = read('run-migration.js');
const inviteMigration = read('drizzle/migrations/0010_registration_invite_token.sql');
const advertisingMigration = read('drizzle/migrations/0008_advertising.sql');
const providerMigration = read('drizzle/migrations/0011_provider_registry.sql');
const advertisingGrowthMigration = read('drizzle/migrations/0012_advertising_growth_engine.sql');
const journal = read('drizzle/migrations/meta/_journal.json');

function assertContains(haystack: string, needle: string, label: string) {
  assert.ok(haystack.includes(needle), `${label} missing "${needle}"`);
}

async function main() {
  console.log('\n=== Migration Integrity Tests ===\n');

  assertContains(schema, "mysqlTable('registration_invites'", 'schema');
  assertContains(schema, "tokenHash: varchar('token_hash'", 'schema');
  assertContains(runner, 'CREATE TABLE IF NOT EXISTS registration_invites', 'startup runner');
  assertContains(runner, 'token_hash varchar(64) NULL', 'startup runner');
  assertContains(inviteMigration, 'ADD COLUMN token_hash varchar(64) NULL', '0010 invite migration');
  assertContains(inviteMigration, 'CREATE UNIQUE INDEX idx_registration_invites_token_hash', '0010 invite migration');
  console.log('✓ registration_invites.token_hash exists in schema, append migration, and startup runner');

  for (const table of ['ad_campaigns', 'ad_creatives']) {
    assertContains(schema, `mysqlTable('${table}'`, 'schema');
    assertContains(runner, `CREATE TABLE IF NOT EXISTS ${table}`, 'startup runner');
    assertContains(advertisingMigration, `CREATE TABLE IF NOT EXISTS ${table}`, '0008 advertising migration');
  }
  for (const indexName of ['idx_ad_campaigns_deployment', 'idx_ad_campaigns_status', 'idx_ad_creatives_campaign']) {
    assertContains(schema, indexName, 'schema');
    assertContains(runner, indexName, 'startup runner');
    assertContains(advertisingMigration, indexName, '0008 advertising migration');
  }
  console.log('✓ advertising tables and indexes exist in schema, append migration, and startup runner');

  for (const table of [
    'ad_audience_research',
    'ad_budget_ledger',
    'ad_campaign_events',
    'ad_approvals',
    'ad_experiments',
    'ad_optimization_decisions',
  ]) {
    assertContains(schema, `mysqlTable('${table}'`, 'schema');
    assertContains(runner, `CREATE TABLE IF NOT EXISTS ${table}`, 'startup runner');
    assertContains(advertisingGrowthMigration, `CREATE TABLE IF NOT EXISTS ${table}`, '0012 advertising growth migration');
  }
  for (const column of [
    "dailyLimit: decimal('daily_limit'",
    "approvedSpendLimit: decimal('approved_spend_limit'",
    "approvalStatus: varchar('approval_status'",
    "optimizationStatus: varchar('optimization_status'",
  ]) {
    assertContains(schema, column, 'schema');
  }
  assertContains(runner, "table: 'ad_campaigns', column: 'daily_limit'", 'startup runner');
  assertContains(runner, 'ALTER TABLE ${table} ADD COLUMN ${column}', 'startup runner');
  assertContains(runner, "table: 'ad_campaigns', column: 'status'", 'startup runner');
  assertContains(runner, 'ALTER TABLE ${table} MODIFY COLUMN ${column}', 'startup runner');
  assertContains(advertisingGrowthMigration, 'ALTER TABLE ad_campaigns ADD COLUMN daily_limit', '0012 advertising growth migration');
  assertContains(journal, '0012_advertising_growth_engine', 'drizzle journal');
  console.log('✓ advertising growth ledger, events, approvals, experiments, optimization tables are migration-covered');

  for (const table of ['integration_credentials', 'credential_audit_logs']) {
    assertContains(schema, `mysqlTable('${table}'`, 'schema');
    assertContains(runner, `CREATE TABLE IF NOT EXISTS ${table}`, 'startup runner');
    assertContains(providerMigration, `CREATE TABLE IF NOT EXISTS ${table}`, '0011 provider registry migration');
  }
  assertContains(journal, '0010_registration_invite_token', 'drizzle journal');
  assertContains(journal, '0011_provider_registry', 'drizzle journal');
  console.log('✓ provider registry tables exist and new migrations are journaled');

  console.log('\n=== Results: 4 passed, 0 failed ===\n');
}

main().catch((error) => {
  console.error('Migration integrity test failed:', error);
  process.exit(1);
});
