import fs from 'node:fs/promises';
import { configurationReadiness } from '../shared/policyReadiness';

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Supply a review-only production policy plan JSON file. This script performs no database access or activation.');
  const plan = JSON.parse(await fs.readFile(file, 'utf8'));
  const readiness = configurationReadiness(plan.proposedConfigurations || {});
  const configured = readiness.every(policy => policy.state === 'CONFIGURED');
  console.log(JSON.stringify({ status: configured ? 'READY_FOR_ADMIN_REVIEW' : 'BLOCKED_MISSING_OR_INVALID_CONFIGURATION', target: plan.target, authorization: 'This file is not administrator activation or owner consent', policies: readiness }, null, 2));
  if (!configured) process.exitCode = 3;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
