import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifySession, COOKIE_NAME } from './_core/cookies';
import * as db from './db';

// Singleton WebSocket server
let wss: WebSocketServer | null = null;

// Track connected clients with optional user identity
interface AuthenticatedClient {
  ws: WebSocket;
  userId: string | null;
  role: string | null;
}
const clients = new Set<AuthenticatedClient>();

function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const name = parts[0]?.trim();
    if (!name) return;
    const value = parts.slice(1).join('=').trim();
    try {
      list[name] = decodeURIComponent(value);
    } catch {
      list[name] = value;
    }
  });
  return list;
}

function hydrateClientRole(client: AuthenticatedClient, userId: string): void {
  void db.getUserById(userId)
    .then((user) => {
      if (user) {
        client.role = user.role;
      }
    })
    .catch(() => {
      // Authentication remains valid without role hydration; the client simply
      // will not receive admin-only broadcasts until a later connection.
    });
}

// Events that are safe for broadcast to all connected clients
const GLOBAL_EVENT_TYPES = new Set([
  'queue:updated',
  'gap:created',
  'audit:completed',
  'coreloop:status',
  'worker:status',
]);

export type WSEvent =
  | { type: 'queue:updated'; data: { queueItemId: string; status: string; nextRetryAt?: string | null } }
  | { type: 'gap:created'; data: { gapId: string; knows: string } }
  | { type: 'deployment:created'; data: { deploymentId: string; gapId: string } }
  | { type: 'audit:completed'; data: { deploymentId: string; health: string } }
  | {
      type: 'coreloop:status';
      data: {
        isRunning: boolean;
        lastExecutedAt: string | null;
        nextExecutionAt: string | null;
      };
    }
  | { type: 'worker:status'; data: { activeWorkers: number; totalProcessed: number } }
  | {
      type: 'deployment:provider';
      data: {
        deploymentId: string;
        providerType: string;
        providerId: string;
        status: string;
        note?: string;
        deploymentUrl?: string;
      };
    }
  | { type: 'application:generation_started'; data: { deploymentId: string; gapId: string } }
  | { type: 'application:generation_completed'; data: { deploymentId: string; fileCount: number } }
  | {
      type: 'payment:updated';
      data: { paymentId: string; deploymentId: string; status: string };
    };

export function initWebSocketServer(server: HttpServer): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const client: AuthenticatedClient = { ws, userId: null, role: null };
    clients.add(client);

    // Attempt authentication from handshake cookie (secure HttpOnly cookie session)
    try {
      const cookies = parseCookies(req.headers?.cookie);
      const sessionCookie = cookies[COOKIE_NAME];
      if (sessionCookie) {
        const verified = verifySession(sessionCookie);
        if (verified?.userId) {
          client.userId = verified.userId;
          hydrateClientRole(client, verified.userId);
        }
      }
    } catch {
      // Non-blocking handshake authentication failure
    }

    console.log(`[WS] Client connected (${clients.size} total, authenticated: ${!!client.userId})`);

    ws.on('message', async (msg: string) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.action === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        } else if (parsed.action === 'auth' && parsed.token) {
          // Authenticate this WS connection using the session token
          const verified = verifySession(parsed.token);
          if (verified?.userId) {
            client.userId = verified.userId;
            hydrateClientRole(client, verified.userId);
            ws.send(JSON.stringify({
              type: 'authenticated',
              userId: verified.userId,
              role: client.role,
              timestamp: new Date().toISOString(),
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'auth_error',
              message: 'Invalid session token',
            }));
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      console.log(`[WS] Client disconnected (${clients.size} total)`);
    });

    ws.on('error', () => {
      clients.delete(client);
    });

    // Send initial connection confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      authenticated: !!client.userId,
      timestamp: new Date().toISOString(),
    }));
  });

  return wss;
}

export function broadcastEvent(event: WSEvent, targetUserId?: string | null): void {
  void deliverEvent(event, targetUserId);
}

function getDeploymentIdFromEvent(event: WSEvent): string | null {
  const data = (event as any).data;
  return typeof data?.deploymentId === 'string' ? data.deploymentId : null;
}

async function resolveEventOwner(event: WSEvent, targetUserId?: string | null): Promise<string | null> {
  if (targetUserId) return targetUserId;

  const deploymentId = getDeploymentIdFromEvent(event);
  if (!deploymentId) return null;

  const deployment = await db.getDeploymentById(deploymentId).catch(() => null);
  return deployment?.userId || null;
}

async function deliverEvent(event: WSEvent, targetUserId?: string | null): Promise<void> {
  if (!wss || clients.size === 0) return;
  const message = JSON.stringify(event);

  // Global events broadcast to all
  if (GLOBAL_EVENT_TYPES.has(event.type)) {
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
    return;
  }

  // Private events: broadcast only to admins or the owning user. Ownership is
  // resolved from the deployment id embedded in deployment/payment events.
  const ownerUserId = await resolveEventOwner(event, targetUserId);
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    // Admins see everything
    if (client.role === 'admin') {
      client.ws.send(message);
      continue;
    }

    // Non-authenticated clients only get global events (already handled above)
    if (!client.userId) continue;

    if (ownerUserId && client.userId === ownerUserId) {
      client.ws.send(message);
    }
  }
}

export function getConnectedClients(): number {
  return clients.size;
}
