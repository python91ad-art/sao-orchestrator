import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';

let databaseProcess: ChildProcess;
let backend: ChildProcess;
let directory: string;
let backendEnv: NodeJS.ProcessEnv;
const baseURL = 'http://127.0.0.1:3101';
test.beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sao-browser-real-'));
  const socketPath = path.join(directory, 'mysql.sock');
  const initialized = spawnSync('mariadb-install-db', [`--datadir=${directory}/data`, '--auth-root-authentication-method=normal', '--skip-test-db'], { encoding: 'utf8' });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  databaseProcess = spawn('mysqld', [`--datadir=${directory}/data`, `--socket=${socketPath}`, `--pid-file=${directory}/pid`, '--skip-networking', '--skip-grant-tables'], { stdio: 'ignore' });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const connection = await mysql.createConnection({ socketPath, user: 'root' }); await connection.query('CREATE DATABASE sao_browser'); await connection.end(); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!ready) throw new Error('Disposable browser database did not start.');
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', DB_HOST: 'localhost', DB_SOCKET: socketPath, DB_NAME: 'sao_browser', DB_USER: 'root', DB_PASSWORD: '', PORT: '3101', JWT_SECRET: 'isolated-browser-secret', RESEND_API_KEY: '', SLACK_BOT_TOKEN: '' };
  backendEnv = env;
  const migrated = spawnSync('node', ['run-migration.js'], { env, encoding: 'utf8' });
  if (migrated.status !== 0) throw new Error(migrated.stdout + migrated.stderr);
  backend = spawn('node', ['--import', 'tsx', 'tests/fixtures/browserBackend.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let diagnostics = '';
    backend.stderr?.on('data', chunk => { diagnostics = `${diagnostics}${String(chunk)}`.slice(-4000); });
    const timeout = setTimeout(() => reject(new Error('Isolated backend startup timed out.')), 20000);
    backend.stdout?.on('data', chunk => { if (String(chunk).includes('ISOLATED_BROWSER_BACKEND_READY')) { clearTimeout(timeout); resolve(); } });
    backend.once('exit', () => { clearTimeout(timeout); reject(new Error(`Isolated backend exited before ready: ${diagnostics}`)); });
  });
});
test.afterAll(async () => {
  for (const child of [backend, databaseProcess]) {
    if (!child || child.exitCode !== null) continue;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
  }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
test('real authenticated policy validation, activation, history and Settings persistence', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto(baseURL);
  await page.getByLabel(/email/i).fill('real-admin@sao.test');
  await page.getByLabel(/password/i).fill('isolated-test-password');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('button', { name: 'Policies', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Policies', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Policies', exact: true })).toBeVisible();
  await page.getByLabel(/^Minimum Sources/).fill('1');
  await page.getByLabel('Reason for change').fill('Invalid controlled fixture');
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /Master Business Specification/ }).click();
  await page.getByLabel('Reason for change').fill('Real browser isolated policy activation');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Validate', exact: true }).first().click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Activate version', exact: true }).first().click();
  await expect(page.getByText(/Active version:/)).not.toContainText('Policy Not Configured');
  const priorVersion = await page.getByText(/Active version:/).textContent();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Restore as new draft', exact: true }).first().click();
  await page.getByRole('button', { name: 'Validate', exact: true }).first().click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Activate version', exact: true }).first().click();
  await expect(page.getByText(/Active version:/)).not.toHaveText(priorVersion || '');
  await page.reload();
  await expect(page.getByText(/Active version:/)).not.toContainText('Policy Not Configured');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'General & System', exact: true }).click();
  await page.getByLabel('system Name', { exact: true }).fill('Isolated SAO');
  await page.getByLabel('timezone', { exact: true }).fill('UTC');
  await page.getByLabel('region', { exact: true }).fill('GB');
  await page.getByRole('button', { name: 'Save general configuration' }).click();
  await expect(page.getByText('Saved, audited and applied.', { exact: true })).toBeVisible();
  await new Promise<void>(resolve => { backend.once('exit', () => resolve()); backend.kill('SIGTERM'); });
  backend = spawn('node', ['--import', 'tsx', 'tests/fixtures/browserBackend.ts', '--resume'], { env: backendEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Isolated backend restart timed out.')), 20000);
    backend.stdout?.on('data', chunk => { if (String(chunk).includes('ISOLATED_BROWSER_BACKEND_READY')) { clearTimeout(timeout); resolve(); } });
    backend.once('exit', () => { clearTimeout(timeout); reject(new Error('Isolated backend restart failed.')); });
  });
  await page.reload();
  await page.getByRole('button', { name: 'General & System', exact: true }).click();
  await expect(page.getByLabel('system Name', { exact: true })).toHaveValue('Isolated SAO');
  await page.getByRole('button', { name: 'Operations', exact: true }).click();
  await page.getByRole('button', { name: 'Maintenance', exact: true }).click();
  await expect(page.getByText(/sao_browser/).first()).toBeVisible();
  await page.getByLabel('Exact database name', { exact: true }).fill('sao_browser');
  await page.getByRole('button', { name: 'Prepare backup and verified reset plan' }).click();
  const confirmation = page.locator('pre').filter({ hasText: /^RESET DISCOVERY sao_browser DELETE 1 ARCHIVE 1 / });
  await expect(confirmation).toBeVisible();
  await page.getByLabel('Exact confirmation', { exact: true }).fill(await confirmation.innerText());
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Execute approved scoped reset' }).click();
  await expect(page.getByText('Reset status: completed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Providers', exact: true }).click();
  await expect(page.getByText('Controlled preservation provider', { exact: true })).toBeVisible();
});

test('non-admin and verified agent mutations are denied by the real backend', async ({ request }) => {
  const login = await request.post(`${baseURL}/api/trpc/auth.login`, { data: { email: 'real-user@sao.test', password: 'isolated-test-password' } });
  expect(login.ok()).toBeTruthy();
  const denied = await request.post(`${baseURL}/api/trpc/policies.saveDraft`, { data: { category: 'specification', config: {}, reason: 'Unauthorized' } });
  expect(denied.status()).toBe(403);
  const agentDenied = await request.post(`${baseURL}/api/trpc/policies.saveDraft`, { headers: { 'x-sao-agent-token': 'controlled-agent-only-test-token' }, data: { category: 'specification', config: {}, reason: 'Agent cannot edit policy' } });
  expect([401, 403]).toContain(agentDenied.status());
  const read = await request.get(`${baseURL}/api/trpc/operations.applicableAgentPolicies`, { headers: { 'x-sao-agent-token': 'controlled-agent-only-test-token' } });
  expect(read.ok()).toBeTruthy();
});

test('owner history pagination uses the real authenticated business workspace', async ({ page }) => {
  await page.goto(baseURL);
  await page.getByLabel(/email/i).fill('real-user@sao.test');
  await page.getByLabel(/password/i).fill('isolated-test-password');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.getByRole('button', { name: 'My Authorizations', exact: true }).click();
  await page.getByRole('combobox').selectOption({ index: 1 });
  const pagination = page.getByRole('navigation', { name: 'Authorization history pages' });
  await expect(pagination.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  await expect(pagination.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Business notification', exact: true })).toHaveCount(50);
  await pagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(pagination).toContainText('History page 2');
  await expect(page.getByRole('heading', { name: 'Business notification', exact: true })).toHaveCount(1);
  await expect(pagination.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await pagination.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Business notification', exact: true })).toHaveCount(50);
});

test('direct dashboard links, browser history, checkout and account-switch restrictions', async ({ page }) => {
  await page.goto(`${baseURL}/dashboard/operations`);
  await page.getByLabel(/email/i).fill('real-admin@sao.test');
  await page.getByLabel(/password/i).fill('isolated-test-password');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('heading', { name: 'Business Operations', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Infrastructure', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/dashboard/infrastructure`);
  await expect(page.getByRole('heading', { name: 'Lifecycle Infrastructure', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Business Operations', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings Control Center', exact: true })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Policies', exact: true }).click();
  await page.getByRole('button', { name: 'Open dedicated Policies workspace', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/dashboard/policies`);
  await expect(page.getByRole('heading', { name: 'Policies', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Operations', exact: true }).click();
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click();
  await page.getByLabel(/email/i).fill('real-user@sao.test');
  await page.getByLabel(/password/i).fill('isolated-test-password');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page.getByRole('button', { name: 'Operations', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Policies', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Registration Access', exact: true })).toHaveCount(0);
  for (const name of ['Gaps', 'Queue', 'Deployments', 'Audit Log', 'Settings']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveText('Administrator access required.');
  await page.goto(`${baseURL}/dashboard/authorizations`);
  await expect(page.getByRole('heading', { name: 'My Business Authorizations', exact: true })).toBeVisible();
  await page.goto(`${baseURL}/dashboard/registration-access`);
  await expect(page.getByRole('alert')).toHaveText('Administrator access required.');
  await page.goto(`${baseURL}/checkout?business=isolated-no-price`);
  await expect(page.getByRole('heading', { name: 'Business Checkout', exact: true })).toBeVisible();
  await expect(page.getByText('No approved public price is currently available.')).toBeVisible();
});

test('implemented dashboard read APIs and compiled asset identity resolve through the real backend', async ({ request }) => {
  const login = await request.post(`${baseURL}/api/trpc/auth.login`, { data: { email: 'real-admin@sao.test', password: 'isolated-test-password' } });
  expect(login.ok()).toBeTruthy();
  const queries: Record<string, unknown> = {
    'operations.preferences': undefined,
    'operations.workspace': {},
    'operations.diagnostics': undefined,
    'operations.ownedBusinesses': undefined,
    'policies.overview': undefined,
    'policies.history': { category: 'specification' },
    'infrastructure.overview': undefined,
    'infrastructure.businessTrace': {},
    'specifications.list': {},
    'agents.list': undefined,
    'qc.list': {},
    'builder.list': {},
    'finance.transactions': {},
    'finance.settlements': {},
    'lifecycle.list': {},
  };
  for (const [procedure, input] of Object.entries(queries)) {
    const response = await request.get(`${baseURL}/api/trpc/${procedure}`, { params: input === undefined ? undefined : { input: JSON.stringify(input) } });
    expect(response.status(), procedure).toBe(200);
    expect((await response.json()).error, procedure).toBeUndefined();
  }
  const response = await request.get(`${baseURL}/build-info.json`);
  expect(response.headers()['cache-control']).toBe('no-store');
  const manifest = await response.json();
  expect(manifest.assets.length).toBeGreaterThan(0);
  for (const asset of manifest.assets) {
    const result = await request.get(`${baseURL}/${asset.file}`);
    expect(result.ok()).toBeTruthy();
    expect(createHash('sha256').update(await result.body()).digest('hex')).toBe(asset.sha256);
  }
  expect((await request.get(`${baseURL}/api/not-a-real-route`)).status()).toBe(404);
});

test('real opportunity pagination, source-backed search and safe status filters', async ({ page, request }) => {
  test.setTimeout(60000);
  await request.post(`${baseURL}/api/trpc/auth.login`, { data: { email: 'real-admin@sao.test', password: 'isolated-test-password' } });
  for (let index = 0; index < 52; index++) {
    const result = await request.post(`${baseURL}/api/trpc/gaps.create`, { data: { knows: `UI proof ${String(index).padStart(2, '0')}`, needs: 'Controlled pagination verification', controlsAccess: `isolated ${index}`, underestimatesValue: 'Controlled demand fixture, not verified', source: 'isolated-ui-test' } });
    expect(result.ok()).toBeTruthy();
  }
  await page.goto(`${baseURL}/dashboard/gaps`);
  await page.getByLabel(/email/i).fill('real-admin@sao.test');
  await page.getByLabel(/password/i).fill('isolated-test-password');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  const pagination = page.getByRole('navigation', { name: 'Opportunity pages' });
  await page.getByRole('searchbox', { name: 'Search gaps' }).fill('UI proof');
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await expect(pagination).toContainText('Page 1');
  await pagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(pagination).toContainText('Page 2');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search gaps' }).fill('UI proof 51');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('UI proof 51');
  await page.getByRole('combobox', { name: 'Gap status' }).selectOption('safe');
  await expect(page.getByText('No opportunities match this page or filter.')).toBeVisible();
  const injected = await request.get(`${baseURL}/api/trpc/gaps.list`, { params: { input: JSON.stringify({ limit: 50, skip: 0, search: "' OR 1=1 --" }) } });
  expect((await injected.json()).result.data).toEqual([]);
});

test('command navigation, mobile focus, reduced motion and all workspace visual captures', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(baseURL);
  await page.getByLabel(/email/i).fill('real-admin@sao.test');
  await page.getByLabel(/password/i).fill('isolated-test-password');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.locator('.command-sidebar')).toHaveCSS('width', '80px');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await page.keyboard.press('Control+k');
  const command = page.getByRole('dialog', { name: 'Find workspace' });
  await command.getByRole('textbox', { name: 'Search navigation' }).fill('Policies');
  await command.getByRole('button', { name: 'Policies', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/dashboard/policies`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const navigation = page.getByRole('dialog', { name: 'Main navigation' });
  await expect(navigation.getByRole('button', { name: 'Close navigation', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const captureDirectory = path.resolve('.sao-backups/design-qa');
  fs.mkdirSync(captureDirectory, { recursive: true, mode: 0o700 });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 960 });
    for (const route of ['overview', 'authorizations', 'operations', 'gaps', 'queue', 'deployments', 'advertising', 'audit-log', 'analytics', 'policies', 'providers', 'infrastructure', 'settings', 'registration-access']) {
      await page.goto(`${baseURL}/dashboard/${route}`);
      await expect(page.locator('.workspace-page')).toBeVisible();
      await expect(page.locator('.spinner')).toHaveCount(0);
      await expect(page.locator('.loading-state')).toHaveCount(0);
      await expect(page.locator('.workspace-page')).toHaveCSS('animation-name', 'none');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} at ${width}px`).toBeTruthy();
      await page.screenshot({ path: path.join(captureDirectory, `${route}-${width}.png`) });
    }
  }
  await page.goto(`${baseURL}/dashboard/gaps`);
  await page.getByRole('button', { name: 'Add Asymmetric Gap' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Asymmetric Gap' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /Who has this knowledge/ })).toBeVisible();
  await page.screenshot({ path: path.join(captureDirectory, 'candidate-dialog-390.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add Asymmetric Gap' })).toBeFocused();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(`${baseURL}/checkout?business=isolated-no-price`);
    await expect(page.getByRole('heading', { name: 'Business Checkout', exact: true })).toBeVisible();
    await expect(page.getByText('No approved public price is currently available.')).toBeVisible();
    await page.screenshot({ path: path.join(captureDirectory, `checkout-${width}.png`) });
  }
  await page.context().clearCookies();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(baseURL);
    await expect(page.getByRole('heading', { name: 'Sign in to SAO' })).toBeVisible();
    await page.screenshot({ path: path.join(captureDirectory, `login-${width}.png`) });
    await page.goto(`${baseURL}/register`);
    await expect(page.getByRole('heading', { name: 'Join SAO' })).toBeVisible();
    await page.screenshot({ path: path.join(captureDirectory, `registration-${width}.png`) });
  }
});

test('queue failures are visible and duplicate actions are prevented', async ({ page, request }) => {
  await request.post(`${baseURL}/api/trpc/auth.login`, { data: { email: 'real-admin@sao.test', password: 'isolated-test-password' } });
  const created = await request.post(`${baseURL}/api/trpc/gaps.create`, { data: { knows: 'Controlled queue denial candidate', needs: 'Verify error feedback', controlsAccess: 'isolated tools', underestimatesValue: 'unverified fixture', source: 'isolated-queue-error-test' } });
  expect(created.ok()).toBeTruthy();
  await page.goto(`${baseURL}/dashboard/queue`);
  await page.getByLabel(/email/i).fill('real-admin@sao.test');
  await page.getByLabel(/password/i).fill('isolated-test-password');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  let calls = 0;
  await page.route('**/api/trpc/queue.pause*', async route => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 400));
    const error = { error: { message: 'Controlled queue failure', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'queue.pause' } } };
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify(route.request().url().includes('batch=1') ? [error] : error) });
  });
  const pause = page.getByTitle('Pause Processing').first();
  await pause.click();
  await expect(pause).toBeDisabled();
  await pause.evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.getByRole('alert')).toContainText('Controlled queue failure');
  expect(calls).toBe(1);
});

test('manual evidence form validates and persists actual operator input without verification claims', async ({ page }) => {
  await page.goto(`${baseURL}/dashboard/infrastructure`);
  await page.getByLabel(/email/i).fill('real-admin@sao.test');
  await page.getByLabel(/password/i).fill('isolated-test-password');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.getByRole('button', { name: 'Record Evidence', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Record evidence', exact: true });
  await dialog.getByRole('textbox', { name: 'Evidence title' }).fill('Controlled UI evidence');
  await dialog.getByRole('textbox', { name: 'Source URL' }).fill('not-a-url');
  await dialog.getByRole('textbox', { name: 'Evidence findings' }).fill('Controlled isolated findings; not verified demand or legality.');
  await dialog.getByRole('button', { name: 'Save source evidence' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Source URL' }).fill('https://example.test/controlled-evidence');
  await dialog.getByRole('button', { name: 'Save source evidence' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Controlled UI evidence', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Controlled UI evidence', { exact: true })).toBeVisible();
});
