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
  await page.getByRole('button', { name: 'Policies', exact: true }).last().click();
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
