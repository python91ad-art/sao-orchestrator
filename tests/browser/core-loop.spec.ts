import { test, expect } from '@playwright/test';

function report(status = 'idle') {
  return { status, outcome: status === 'ok' ? 'completed_with_zero_results' : status,
    ons: { status: 'insufficient_evidence', signals: 0, errors: [] }, web: { status: 'ok', searches: 10, successes: 10, failures: 0, attempts: [] },
    candidatesBySource: {}, validated: 0, rejected: 0, queued: 0, persisted: 0, lastSuccess: null, lastFailure: null };
}
async function fixture(context: any) {
  let state = { isRunning: false, executing: false, runtimeState: 'stopped', intervalMs: 60000, lastExecutedAt: null, nextExecutionAt: null };
  let discovery = report();
  let emergencyStop = false, revision = 0;
  const calls: Record<string, number> = {};
  let release!: () => void;
  let hold = false, fail = false;
  await context.route('**/api/trpc/**', async (route: any) => {
    const url = new URL(route.request().url());
    const names = url.pathname.split('/api/trpc/')[1].split(',');
    const results = await Promise.all(names.map(async name => {
      calls[name] = (calls[name] || 0) + 1;
      let data: any = [];
      if (name === 'auth.me') data = { id: 'admin', email: 'admin@sao.test', role: 'admin' };
      if (name === 'coreLoop.start') { state = { ...state, isRunning: true, runtimeState: 'running' }; data = { success: true }; }
      if (name === 'coreLoop.stop') { state = { ...state, isRunning: false, runtimeState: state.executing ? 'stopping' : 'stopped' }; data = { success: true, ...state }; }
      if (name === 'coreLoop.runOnce') {
        if (fail) return { error: { message: 'Controlled backend discovery failure', code: -32012, data: { code: 'PRECONDITION_FAILED', httpStatus: 412, path: name } } };
        state = { ...state, executing: true, runtimeState: 'executing' };
        if (hold) await new Promise<void>(resolve => { release = resolve; });
        const stopped = state.runtimeState === 'stopping';
        state = { ...state, executing: false, runtimeState: state.isRunning ? 'running' : 'stopped' };
        discovery = report(stopped ? 'stopped' : 'ok');
        data = { discovery, processed: 0, stopped };
      }
      if (name === 'coreLoop.processNext') data = { processed: 0, outcomes: [], message: 'No eligible queued gaps.' };
      if (name === 'coreLoop.runAudit') data = { success: true };
      if (name === 'coreLoop.status') data = state;
      if (name === 'discovery.pipelineDiagnostic') data = { coreLoop: state, multiSource: discovery, webSearch: { activeProvider: 'tavily', attempts: [], providers: {} } };
      if (name === 'operations.saveSetting') {
        const body = route.request().postDataJSON(); const input = body['0'] || body;
        if (input.key === 'emergencyStop') { emergencyStop = input.value; revision++; state = { ...state, isRunning: false, runtimeState: 'stopped' }; }
        data = { success: true };
      }
      if (name === 'operations.diagnostics') data = { coreLoop: state, workers: { activeWorkers: 0 }, settings: [{ key: 'emergencyStop', value: emergencyStop, revision }] };
      return { result: { data } };
    }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.searchParams.has('batch') ? results : results[0]) });
  });
  return { calls, hold: () => { hold = true; }, fail: () => { fail = true; }, release: () => release() };
}

test('Overview Start, Stop, reload and second session reflect confirmed backend state', async ({ page, context }) => {
  const f = await fixture(context);
  await page.goto('/'); await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause Loop' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'Pause Loop' })).toBeVisible();
  const second = await context.newPage(); await second.goto('/'); await expect(second.getByRole('button', { name: 'Pause Loop' })).toBeVisible();
  await second.getByRole('button', { name: 'Pause Loop' }).click();
  await page.getByRole('button', { name: /Refresh/ }).click();
  await expect(page.getByRole('button', { name: 'Start Loop', exact: true })).toBeVisible();
  expect(f.calls['coreLoop.start']).toBe(1); expect(f.calls['coreLoop.stop']).toBe(1);
});

test('Run Once double clicks dispatch one full cycle, disable conflicting controls, allow Stop and refresh diagnostics', async ({ page, context }) => {
  const f = await fixture(context); f.hold();
  await page.goto('/');
  await page.getByRole('button', { name: 'Run Once Now' }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByText('Executing request…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Process Next Gap' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pause Loop' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause Loop' }).click();
  await expect(page.getByText('Stopping: dispatched work is finishing safely.', { exact: true })).toBeVisible();
  const before = f.calls['discovery.pipelineDiagnostic']; f.release();
  await expect(page.getByText('Cycle stopped; no further work dispatched.', { exact: true })).toBeVisible();
  await expect.poll(() => f.calls['discovery.pipelineDiagnostic']).toBeGreaterThan(before);
  expect(f.calls['coreLoop.runOnce']).toBe(1); expect(f.calls['coreLoop.processNext'] || 0).toBe(0);
});

test('Run Once shows completed zero results and Process Next uses a separate backend action', async ({ page, context }) => {
  const f = await fixture(context); await page.goto('/');
  await page.getByRole('button', { name: 'Run Once Now' }).click();
  await expect(page.getByText('Cycle completed: 0 validated, 0 queued, 0 processed.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Process Next Gap' }).click();
  await expect(page.getByText('No eligible queued gaps.', { exact: true })).toBeVisible();
  expect(f.calls['coreLoop.runOnce']).toBe(1); expect(f.calls['coreLoop.processNext']).toBe(1);
});

test('Runtime failures show the backend error without a success claim', async ({ page, context }) => {
  const f = await fixture(context); f.fail(); await page.goto('/');
  await page.getByRole('button', { name: 'Run Once Now' }).click();
  await expect(page.getByRole('alert')).toContainText('Controlled backend discovery failure');
  await expect(page.getByText(/Cycle completed:/)).toHaveCount(0);
});

test('Settings honors zero capacity and uses the same Start, Stop, discovery and single-gap operations', async ({ page, context }) => {
  const f = await fixture(context); await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Start Loop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start Loop', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Stop Loop', exact: true }).click();
  await page.getByRole('button', { name: 'Run Once Now', exact: true }).click();
  await expect(page.getByText('Cycle completed: 0 validated, 0 queued, 0 processed.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Process Next Gap' }).click();
  await expect(page.getByText('No eligible queued gaps.', { exact: true })).toBeVisible();
  for (const name of ['coreLoop.start', 'coreLoop.stop', 'coreLoop.runOnce', 'coreLoop.processNext']) expect(f.calls[name]).toBe(1);
  await page.getByRole('button', { name: 'Budgets & Financial Controls', exact: true }).click();
  await page.getByLabel('Max Active Deployments', { exact: true }).fill('0');
  await expect(page.getByLabel('Max Active Deployments', { exact: true })).toHaveValue('0');

});

test('Emergency Stop persists the existing policy control and refreshes its confirmed state', async ({ page, context }) => {
  const f = await fixture(context); await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Security & Approvals', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Activate emergency stop', exact: true }).click();
  await expect(page.getByText('Emergency stop: ACTIVE', { exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Security & Approvals', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear emergency stop', exact: true })).toBeVisible();
  expect(f.calls['operations.saveSetting']).toBe(1);
});
