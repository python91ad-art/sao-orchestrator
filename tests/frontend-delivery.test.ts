import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { serveBuiltFrontend } from '../server/_core/frontend';
import { dashboardPage, dashboardPages, requiresAdministrator } from '../client/src/lib/dashboardRoutes';

async function main() {
  for (const page of dashboardPages) {
    assert.equal(dashboardPage({ pathname: `/dashboard/${page}`, search: '' }, 'overview'), page);
    assert.equal(dashboardPage({ pathname: '/', search: `?page=${page}` }, 'overview'), page);
  }
  assert.equal(dashboardPage({ pathname: '/', search: '' }, 'settings'), 'settings');
  assert.equal(dashboardPage({ pathname: '/dashboard/unknown', search: '' }, 'settings'), 'overview');
  assert.equal(requiresAdministrator('registration-access'), true);
  assert.equal(requiresAdministrator('policies'), true);
  assert.equal(requiresAdministrator('operations'), true);
  assert.equal(requiresAdministrator('authorizations'), false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sao-frontend-delivery-'));
  const app = express();
  fs.mkdirSync(path.join(directory, 'assets'));
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Isolated frontend</title>');
  fs.writeFileSync(path.join(directory, 'assets', 'index-hash.js'), 'window.testArtifact = true;');
  fs.writeFileSync(path.join(directory, 'build-info.json'), '{"revision":null}');
  assert.equal(serveBuiltFrontend(app, directory), true);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    for (const route of ['/', '/index.html', '/dashboard/policies', '/dashboard/authorizations', '/checkout?business=isolated', '/build-info.json']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('cache-control'), 'no-store', route);
    }
    const asset = await fetch(`${base}/assets/index-hash.js`);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const missingApi = await fetch(`${base}/api/not-a-route`, { signal: AbortSignal.timeout(2000) });
    assert.equal(missingApi.status, 404);
    assert.equal((await missingApi.text()).includes('Isolated frontend'), false);
    const missingAsset = await fetch(`${base}/assets/missing.js`);
    assert.equal(missingAsset.status, 404);
    console.log('PASS dashboard routes/access classification, fresh HTML/build identity, immutable assets and non-hanging API 404.');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
