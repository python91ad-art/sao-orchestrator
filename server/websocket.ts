import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// Singleton WebSocket server
let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

export type WSEvent =
  | { type: 'queue:updated'; data: { queueItemId: string; status: string } }
  | { type: 'gap:created'; data: { gapId: string; knows: string } }
  | { type: 'deployment:created'; data: { deploymentId: string; gapId: string } }
  | { type: 'audit:completed'; data: { deploymentId: string; health: string } }
  | { type: 'coreloop:status'; data: { isRunning: boolean; lastExecutedAt: string | null } }
  | { type: 'worker:status'; data: { activeWorkers: number; totalProcessed: number } };

export function initWebSocketServer(server: HttpServer): WebSocketServer {
  if (wss) return wss;

  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    console.log(`[WS] Client connected (${clients.size} total)`);

    ws.on('message', (msg: string) => {
      try {
        const parsed = JSON.parse(msg.toString());
        // Client can send { action: 'subscribe', channel: 'queue' } etc.
        if (parsed.action === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} total)`);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });

    // Send initial connection confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      timestamp: new Date().toISOString(),
    }));
  });

  return wss;
}

export function broadcastEvent(event: WSEvent): void {
  if (!wss || clients.size === 0) return;
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

export function getConnectedClients(): number {
  return clients.size;
}
