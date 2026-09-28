// ============================================================
// WEBSOCKET AUTHENTICATION — Unit & Security Tests
// Tests handshake cookie parsing, session verification, client state,
// and private vs global event filtering.
// ============================================================

import { signSession, verifySession, COOKIE_NAME } from '../server/_core/cookies';
import { broadcastEvent, initWebSocketServer, WSEvent } from '../server/websocket';
import { createServer } from 'http';
import WebSocket from 'ws';

const results: { name: string; pass: boolean; detail?: string }[] = [];

function record(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('\n=== WebSocket Authentication Tests ===\n');

  // --- 1. Session Sign & Verify Core ---
  console.log('--- 1. Session Signing & Cookie Verification ---');
  {
    const userId = 'user_test_123456';
    const cookieVal = signSession(userId);
    const verified = verifySession(cookieVal);

    record('Valid signed session cookie verifies correctly', verified?.userId === userId);

    // Tampered cookie
    const tampered = cookieVal.slice(0, -4) + 'abcd';
    record('Tampered session cookie is rejected', verifySession(tampered) === null);

    // Malformed cookie
    record('Malformed string rejected', verifySession('not-a-valid-session') === null);
    record('Empty cookie string rejected', verifySession('') === null);
  }

  // --- 2. WebSocket Handshake & Auth Lifecycle ---
  console.log('\n--- 2. WebSocket Server Connection & Auth ---');
  {
    const server = createServer();
    const wss = initWebSocketServer(server);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const port = (server.address() as any).port;
    const testUserId = 'user_ws_auth_test';
    const authCookie = signSession(testUserId);

    // Client 1: Unauthenticated connection
    const clientUnauth = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const clientUnauthEvents: any[] = [];
    clientUnauth.on('message', (data) => {
      try {
        clientUnauthEvents.push(JSON.parse(data.toString()));
      } catch {}
    });

    await new Promise<void>((resolve) => clientUnauth.on('open', () => resolve()));

    // Client 2: Authenticated connection via cookie header
    const clientAuth = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        cookie: `${COOKIE_NAME}=${authCookie}`,
      },
    });
    const clientAuthEvents: any[] = [];
    clientAuth.on('message', (data) => {
      try {
        clientAuthEvents.push(JSON.parse(data.toString()));
      } catch {}
    });

    await new Promise<void>((resolve) => clientAuth.on('open', () => resolve()));

    // Wait a brief moment for connection events
    await new Promise((resolve) => setTimeout(resolve, 100));

    record(
      'Unauthenticated client receives connected event with authenticated: false',
      clientUnauthEvents.some((e) => e.type === 'connected' && e.authenticated === false)
    );

    record(
      'Authenticated client receives connected event with authenticated: true',
      clientAuthEvents.some((e) => e.type === 'connected' && e.authenticated === true)
    );

    // --- 3. Event Broadcasting Filtering ---
    console.log('\n--- 3. Event Filtering (Global vs Private) ---');

    // Broadcast a global event: both unauthenticated and authenticated clients should receive it
    const globalEvent: WSEvent = {
      type: 'queue:updated',
      data: { queueItemId: 'queue_1', status: 'completed' },
    };
    broadcastEvent(globalEvent);

    // Broadcast a private event scoped to testUserId
    const privateEvent: WSEvent = {
      type: 'payment:updated',
      data: { paymentId: 'pay_1', deploymentId: 'dep_1', status: 'paid' },
    };
    broadcastEvent(privateEvent, testUserId);

    // Broadcast a private event scoped to another user
    const otherUserPrivateEvent: WSEvent = {
      type: 'deployment:created',
      data: { deploymentId: 'dep_other', gapId: 'gap_other' },
    };
    broadcastEvent(otherUserPrivateEvent, 'different_user_id');

    await new Promise((resolve) => setTimeout(resolve, 200));

    record(
      'Global event delivered to unauthenticated client',
      clientUnauthEvents.some((e) => e.type === 'queue:updated')
    );

    record(
      'Global event delivered to authenticated client',
      clientAuthEvents.some((e) => e.type === 'queue:updated')
    );

    record(
      'Private event delivered to matching authenticated client',
      clientAuthEvents.some((e) => e.type === 'payment:updated')
    );

    record(
      'Private event NOT delivered to unauthenticated client',
      !clientUnauthEvents.some((e) => e.type === 'payment:updated')
    );

    // --- 4. Explicit Auth Action Message ---
    console.log('\n--- 4. Explicit Auth Action Message ---');
    const explicitToken = signSession('user_explicit_auth');
    clientUnauth.send(JSON.stringify({ action: 'auth', token: explicitToken }));

    await new Promise((resolve) => setTimeout(resolve, 150));

    record(
      'Explicit auth message upgrades connection and confirms with authenticated type',
      clientUnauthEvents.some((e) => e.type === 'authenticated' && e.userId === 'user_explicit_auth')
    );

    // Cleanup
    clientUnauth.close();
    clientAuth.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
