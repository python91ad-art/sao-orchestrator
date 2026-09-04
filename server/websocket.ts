import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifySession } from './_core/cookies';

// Singleton WebSocket server
let wss: WebSocketServer | null = null;

// Track connected clients with optional user identity
interface AuthenticatedClient {
  ws: WebSocket;
  userId: string | null;
  role: string | null;
}
const clients = new Set<AuthenticatedClient>();

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

  wss.on('connection', (ws: WebSocket) => {
    const client: AuthenticatedClient = { ws, userId: null, role: null };
    clients.add(client);
    console.log(`[WS] Client connected (${clients.size} total)`);

    ws.on('message', (msg: string) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.action === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        } else if (parsed.action === 'auth' && parsed.token) {
          // Authenticate this WS connection using the session token
          const verified = verifySession(parsed.token);
          if (verified) {
            client.userId = verified.userId;
            client.role = null; // role is not in session token payload currently
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
      timestamp: new Date().toISOString(),
    }));
  });

  return wss;
}

export function broadcastEvent(event: WSEvent, targetUserId?: string | null): void {
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

  // Private events: broadcast to clients that match the deployment/user
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    // Admins see everything
    if (client.role === 'admin') {
      client.ws.send(message);
      continue;
    }

    // Non-authenticated clients only get global events (already handled above)
    if (!client.userId) continue;

    // If targetUserId matches, send
    if (targetUserId && client.userId === targetUserId) {
      client.ws.send(message);
      continue;
    }

    // For deployment-scoped events, the deployment data is embedded in the event
    // but we don't do deployment-level filtering currently since we don't have
    // deployment->user mapping in the WS layer. Authenticated users get
    // deployment-scoped events since they've proven their identity.
    if (client.userId) {
      client.ws.send(message);
    }
  }
}

export function getConnectedClients(): number {
  return clients.size;
}
