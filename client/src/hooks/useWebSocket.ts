import { useState, useEffect, useRef } from 'react';

export interface WSEvent {
  type: string;
  data: any;
}

export function useWebSocket() {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let stopped = false;

    const connect = () => {
      if (stopped) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;

      try {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          console.log('[WS] Connected');
        };

        ws.onmessage = (event) => {
          try {
            const parsed = JSON.parse(event.data);
            if (parsed.type && parsed.type !== 'pong') {
              setLastEvent({
                type: parsed.type,
                data: parsed.data || parsed,
              });
            }
          } catch {
            // Ignore non-JSON messages.
          }
        };

        ws.onclose = () => {
          setConnected(false);

          if (!stopped) {
            console.log('[WS] Disconnected, reconnecting in 3s...');
            reconnectTimerRef.current = setTimeout(connect, 3000);
          }
        };

        ws.onerror = () => {
          setConnected(false);
        };
      } catch {
        setConnected(false);

        if (!stopped) {
          reconnectTimerRef.current = setTimeout(connect, 3000);
        }
      }
    };

    connect();

    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: 'ping' }));
      }
    }, 30000);

    return () => {
      stopped = true;

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }

      clearInterval(pingInterval);

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  return { connected, lastEvent };
}
