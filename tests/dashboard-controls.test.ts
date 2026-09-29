// ============================================================
// Admin Dashboard control inventory / contract tests
// Static UI-to-tRPC coverage for dashboard controls. This complements
// the isolated service E2E by proving visible controls are wired to
// backend procedures and refresh paths.
// ============================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const pages = {
  Overview: 'client/src/pages/dashboard/Overview.tsx',
  Gaps: 'client/src/pages/dashboard/Gaps.tsx',
  Queue: 'client/src/pages/dashboard/Queue.tsx',
  Deployments: 'client/src/pages/dashboard/Deployments.tsx',
  Advertising: 'client/src/pages/dashboard/Advertising.tsx',
  CryptoPayments: 'client/src/pages/dashboard/CryptoPayments.tsx',
  AuditLog: 'client/src/pages/dashboard/AuditLog.tsx',
  Analytics: 'client/src/pages/dashboard/Analytics.tsx',
  Policies: 'client/src/pages/dashboard/Policies.tsx',
  Providers: 'client/src/pages/dashboard/Providers.tsx',
  Settings: 'client/src/pages/dashboard/Settings.tsx',
  RegistrationAccess: 'client/src/pages/dashboard/RegistrationAccess.tsx',
};

const expectations: Record<string, string[]> = {
  Overview: ['trpc.coreLoop.start.useMutation', 'trpc.coreLoop.stop.useMutation', 'trpc.coreLoop.runOnce.useMutation', 'trpc.coreLoop.runAudit.useMutation', 'handleRefresh'],
  Gaps: ['trpc.gaps.list.useQuery', 'trpc.gaps.create.useMutation', 'trpc.gaps.retry.useMutation', 'setIsAddModalOpen(true)', 'gapsQuery.refetch'],
  Queue: ['trpc.queue.list.useQuery', 'trpc.queue.moveUp.useMutation', 'trpc.queue.moveDown.useMutation', 'trpc.queue.pause.useMutation', 'trpc.queue.resume.useMutation', 'trpc.queue.delete.useMutation', 'trpc.queue.retry.useMutation', 'refreshQueue'],
  Deployments: ['trpc.deployments.pause.useMutation', 'trpc.deployments.resume.useMutation', 'trpc.deployments.stop.useMutation', 'trpc.deployments.audit.useMutation', 'trpc.deployments.stopAll.useMutation', 'trpc.deployments.resumeAll.useMutation', 'deploymentsQuery.refetch'],
  Advertising: ['trpc.advertising.analyze.useMutation', 'trpc.advertising.generateStrategy.useMutation', 'trpc.advertising.generateCreatives.useMutation', 'trpc.advertising.publish.useMutation', 'trpc.advertising.approve.useMutation', 'trpc.advertising.reject.useMutation', 'trpc.advertising.optimize.useMutation', 'trpc.advertising.createExperiment.useMutation', 'trpc.advertising.startExperiment.useMutation', 'trpc.advertising.evaluateExperiment.useMutation', 'trpc.advertising.stopExperiment.useMutation', 'refreshOverview'],
  CryptoPayments: ['trpc.payments.createCryptoPayment.useMutation', 'paymentsQuery.refetch', 'deploymentsQuery'],
  AuditLog: ['trpc.audit.list.useQuery', 'setIsModalOpen(true)', 'auditQuery.refetch'],
  Analytics: ['trpc.analytics.overview.useQuery', 'analyticsQuery.refetch'],
  Policies: ['trpc.policies.create.useMutation', 'trpc.policies.acknowledge.useMutation', 'trpc.policies.delete.useMutation', 'utils.policies.list.invalidate'],
  Providers: ['trpc.providers.create.useMutation', 'trpc.providers.update.useMutation', 'trpc.providers.remove.useMutation', 'trpc.providers.test.useMutation', 'trpc.providers.setPriority.useMutation', 'trpc.providers.setEnabled.useMutation', 'utils.providers.list.invalidate'],
  Settings: ['trpc.coreLoop.resetOperationalData.useMutation', 'handleSave', 'handleReset', 'retryConfig', 'queueLimits', 'setConcurrency'],
  RegistrationAccess: ['trpc.invites.create.useMutation', 'trpc.invites.delete.useMutation', 'utils.invites.list.invalidate', 'handleCopy'],
};

function buttonTags(source: string) {
  return Array.from(source.matchAll(/<button\b[\s\S]*?>/g)).map((m) => m[0]);
}

console.log('\n=== Admin Dashboard Control Inventory Tests ===');

for (const [name, file] of Object.entries(pages)) {
  const source = read(file);
  const buttons = buttonTags(source);
  assert.ok(buttons.length > 0, `${name} should render interactive controls`);
  for (const marker of expectations[name]) {
    assert.ok(source.includes(marker), `${name} missing control/backend marker: ${marker}`);
  }

  for (const tag of buttons) {
    const hasHandler = /onClick=|type="submit"|type='submit'|disabled=/.test(tag);
    assert.ok(hasHandler, `${name} has a button without onClick, submit type, or disabled state: ${tag}`);
  }

  const hasMutation = source.includes('useMutation');
  if (hasMutation) {
    assert.ok(
      /refetch\(|invalidate\(|refreshOverview\(|refreshQueue\(|loadData\(|trpcQuery\(/.test(source),
      `${name} has mutations but no visible refresh/invalidation path`
    );
  }

  console.log(`PASS ${name}: ${buttons.length} button/control tag(s), backend markers verified`);
}

const dashboard = read('client/src/pages/Dashboard.tsx');
for (const pageId of ['overview', 'gaps', 'queue', 'deployments', 'advertising', 'audit-log', 'analytics', 'policies', 'providers', 'settings', 'registration-access']) {
  assert.ok(dashboard.includes(`case '${pageId}'`), `Dashboard route missing ${pageId}`);
}

const layout = read('client/src/components/DashboardLayout.tsx');
for (const pageId of ['overview', 'gaps', 'queue', 'deployments', 'advertising', 'audit-log', 'analytics', 'policies', 'providers', 'settings', 'registration-access']) {
  assert.ok(layout.includes(`id: '${pageId}'`), `Dashboard nav missing ${pageId}`);
}

console.log('\nPASS Dashboard navigation and control inventory verified\n');
