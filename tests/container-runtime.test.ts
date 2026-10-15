import assert from 'node:assert/strict';
import fs from 'node:fs';
import { firefox } from '@playwright/test';
import { spawnSync } from 'node:child_process';

async function main() {
  assert.ok(fs.existsSync('/.dockerenv'), 'Run this verification only inside the local verification container.');
  assert.notEqual(process.getuid?.(), 0, 'Production browser verification must run as the non-root application user.');
  assert.equal(process.env.NODE_ENV, 'production', 'The production image must not silently use development authentication defaults.');
  const missingSecret = spawnSync(process.execPath, ['--import', 'tsx', 'server/_core/index.ts'], { env: { ...process.env, JWT_SECRET: '' }, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(missingSecret.status, 0);
  assert.match(missingSecret.stderr, /JWT_SECRET is required in production/);
  for (const path of ['/app/.env', '/app/.aws', '/app/.codex', '/app/.agents', '/app/.sao-backups']) assert.equal(fs.existsSync(path), false, `Private build-context exclusion: ${path}`);
  assert.equal(process.env.DATABASE_URL, undefined, 'This smoke test must not receive production database credentials.');
  for (const name of ['vite', 'vitest', 'typescript']) assert.equal(fs.existsSync(`/app/node_modules/${name}`), false, 'Build/test-only tooling must not remain in the production dependency graph.');
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>Container QC</title><button onclick="document.body.dataset.verified=\'true\'">Verify runtime</button>');
    await page.getByRole('button', { name: 'Verify runtime', exact: true }).click();
    assert.equal(await page.locator('body').getAttribute('data-verified'), 'true');
    assert.ok(fs.existsSync('/app/dist/client/index.html'), 'The production client must have been built.');
    const { testArtifact } = await import('../server/services/releasePipeline');
    const verified = await testArtifact({ description: 'Controlled container artifact', framework: 'static', entryPoint: 'index.html', files: [{ path: 'index.html', content: '<!doctype html><title>Artifact QC</title><button id="verify" onclick="document.body.dataset.verified=\'true\'">Verify artifact</button>' }] }, [{ selector: '#verify', operation: 'click' }, { selector: 'body', operation: 'attribute', attribute: 'data-verified', value: 'true' }]);
    assert.equal(verified.suites.functional, 'passed');
    assert.equal(verified.suites.security, 'passed');
    assert.equal(verified.errors.length, 0);
    assert.equal(verified.externalRequests.length, 0);
    console.log('PASS non-root production image, private context exclusions, compiled client and genuine Firefox functional execution; no application startup, provider access or database connection.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
