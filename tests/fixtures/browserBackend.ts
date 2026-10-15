import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { appRouter } from '../../server/routers';
import { createContext } from '../../server/_core/context';
import { db, mysqlPool, createGap, createDeployment } from '../../server/db';
import * as schema from '../../drizzle/schema';
import { ADMIN_PERMISSIONS } from '../../shared/permissions';
import { serveBuiltFrontend } from '../../server/_core/frontend';

assert.equal(process.env.NODE_ENV, 'test');
assert.ok(process.env.DB_SOCKET?.startsWith('/tmp/'));
async function main() {
  if (!process.argv.includes('--resume')) {
  await db.insert(schema.users).values({ id: 'browser-real-admin', email: 'real-admin@sao.test', passwordHash: await bcrypt.hash('isolated-test-password', 4), role: 'admin' });
  for (const permission of ADMIN_PERMISSIONS) await db.insert(schema.adminPermissions).values({ userId: 'browser-real-admin', permission });
  await db.insert(schema.users).values({ id: 'browser-real-user', email: 'real-user@sao.test', passwordHash: await bcrypt.hash('isolated-test-password', 4), role: 'user' });
  const candidate = await createGap({ knows: 'test research', needs: 'old isolated candidate', controlsAccess: 'test resources', underestimatesValue: 'test demand', source: 'isolated-browser-fixture', dedupHash: 'browser-reset-candidate' });
  const protectedGap = await createGap({ knows: 'existing business', needs: 'protected business', controlsAccess: 'existing assets', underestimatesValue: 'retained value', source: 'isolated-browser-fixture', dedupHash: 'browser-protected-gap' });
  if (!candidate || !protectedGap) throw new Error('Browser discovery fixtures failed.');
  const business = await createDeployment({ gapId: protectedGap.id, userId: 'browser-real-user' });
  await db.insert(schema.operationalEvents).values(Array.from({ length: 51 }, (_, index) => ({ id: `browser-owner-notification-${String(index).padStart(3, '0')}`, deploymentId: business.id, actorId: 'system:isolated-fixture', type: 'user_notification', resourceId: business.id, detailJson: JSON.stringify({ message: `Controlled owner notification ${index + 1}` }) })));
  await db.insert(schema.agents).values({ id: 'browser-agent', role: 'developer', name: 'Controlled browser agent', capabilityJson: '["build"]', toolMetadataJson: '{}' });
  await db.insert(schema.agentSessions).values({ id: 'browser-agent-session', agentId: 'browser-agent', deploymentId: business.id, tokenHash: crypto.createHash('sha256').update('controlled-agent-only-test-token').digest('hex'), toolsJson: '["build"]', expiresAt: new Date(Date.now() + 3600000), createdBy: 'browser-real-admin' });
  await db.insert(schema.integrationCredentials).values({ id: 'browser-protected-provider', service: 'search', name: 'Controlled preservation provider', providerId: 'tavily', encryptedValue: 'isolated-test-not-a-real-secret' });
  }
  const app = express();
  app.use(cookieParser());
  app.use('/api/trpc', createExpressMiddleware({ router: appRouter, createContext }));
  serveBuiltFrontend(app, path.resolve('dist/client'));
  const server = app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ISOLATED_BROWSER_BACKEND_READY'));
  process.on('SIGTERM', () => { server.close(); mysqlPool.end().finally(() => process.exit(0)); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
