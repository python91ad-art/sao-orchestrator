import fs from 'fs';
import assert from 'assert';
import { AGENT_ROLES, POLICY_NOT_CONFIGURED, computeGapDedupHash } from '../server/services/infrastructure';

const read = (path: string) => fs.readFileSync(path, 'utf8');
const schema = read('drizzle/schema.ts');
const runner = read('run-migration.js');
const routers = read('server/routers.ts');
const dashboard = read('client/src/pages/dashboard/Infrastructure.tsx');

let passed = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`✓ ${message}`);
}

console.log('\n=== Lifecycle Infrastructure Tests ===');

const expectedTables = [
  'evidenceRecords',
  'businessSpecifications',
  'businessSpecificationVersions',
  'agents',
  'agentTasks',
  'taskDependencies',
  'buildProjects',
  'buildArtifacts',
  'qcJobs',
  'qcTestRuns',
  'defectReports',
  'leads',
  'customers',
  'salesActivities',
  'revenueAccounts',
  'revenueTransactions',
  'settlementRecords',
  'businessLifecycleRecords',
  'businessLifecycleEvents',
];

for (const table of expectedTables) {
  ok(schema.includes(`export const ${table}`), `${table} exists in Drizzle schema`);
}

for (const sqlTable of [
  'evidence_records',
  'business_specifications',
  'agents',
  'agent_tasks',
  'build_projects',
  'qc_jobs',
  'leads',
  'customers',
  'revenue_transactions',
  'settlement_records',
  'business_lifecycle_records',
]) {
  ok(runner.includes(`CREATE TABLE IF NOT EXISTS ${sqlTable}`), `${sqlTable} exists in startup migration runner`);
}

for (const routerName of ['evidence', 'specifications', 'agents', 'supervisor', 'builder', 'qc', 'sales', 'finance', 'lifecycle', 'infrastructure']) {
  ok(routers.includes(`${routerName}:`), `${routerName} router is mounted`);
}

for (const label of ['Evidence', 'Specs', 'Agents', 'Tasks', 'Builder', 'QC', 'Sales', 'Finance', 'Lifecycle', 'Trace']) {
  ok(dashboard.includes(label), `${label} dashboard tab exists`);
}

ok(AGENT_ROLES.includes('independent_qc'), 'Independent QC agent role is registered');
ok(AGENT_ROLES.includes('supervisor'), 'Supervisor agent role is registered');
ok(POLICY_NOT_CONFIGURED === 'POLICY_NOT_CONFIGURED', 'Policy-not-configured sentinel is explicit');

const a = computeGapDedupHash({
  knows: '  Operators Know ',
  needs: 'Manual Invoices',
  controlsAccess: 'Platform',
  underestimatesValue: 'Fragmented',
  source: 'Tavily',
});
const b = computeGapDedupHash({
  knows: 'operators know',
  needs: 'manual   invoices',
  controlsAccess: 'platform',
  underestimatesValue: 'fragmented',
  source: 'tavily',
});
ok(a === b, 'Gap deduplication is normalized consistently');

console.log(`\n=== Results: ${passed} passed, 0 failed ===`);
