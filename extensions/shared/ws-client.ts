/**
 * Shared WebSocket client helpers — heartbeat, keepalive, and reconnect
 * infrastructure used by both pidash and pidiff extensions.
 */

export interface WsHeartbeatOptions {
  /** The WebSocket client instance */
  ws: any;
  /** Interval in ms (default 30000) */
  intervalMs?: number;
  /** Called when connection is detected dead (no pong) */
  onDead: () => void;
  /** Logger function */
  log: (msg: string) => void;
}

/**
 * Set up ping/pong keepalive + dead connection detection on a WebSocket client.
 * Returns a cleanup function that clears the heartbeat interval.
 */
export function setupHeartbeat(opts: WsHeartbeatOptions): () => void {
  const { ws, intervalMs = 30000, onDead, log } = opts;

  // Respond to server pings
  ws.on("ping", () => { try { ws.pong(); } catch {} });

  // Detect dead connections via client-initiated pings
  let pongReceived = true;
  ws.on("pong", () => { pongReceived = true; });

  const heartbeat = setInterval(() => {
    if (ws.readyState !== 1) { // Not OPEN
      clearInterval(heartbeat);
      return;
    }
    if (!pongReceived) {
      log("heartbeat: no pong received — connection dead, forcing reconnect");
      clearInterval(heartbeat);
      try { ws.terminate(); } catch {}
      onDead();
      return;
    }
    pongReceived = false;
    try { ws.ping(); } catch {};
  }, intervalMs);
  if ((heartbeat as any).unref) (heartbeat as any).unref();

  return () => clearInterval(heartbeat);
}

export interface ReconnectPollerOptions {
  /** Returns true if currently connected */
  isConnected: () => boolean;
  /** Returns true if currently connecting */
  isConnecting: () => boolean;
  /** Returns true if shutting down */
  isShuttingDown: () => boolean;
  /** The connect function to call */
  connect: () => void;
  /** Interval in ms (default 15000) */
  intervalMs?: number;
}

/**
 * Set up a periodic reconnect poller. Returns a cleanup function.
 */
export function setupReconnectPoller(opts: ReconnectPollerOptions): () => void {
  const { isConnected, isConnecting, isShuttingDown, connect, intervalMs = 15000 } = opts;
  const poller = setInterval(() => {
    if (!isConnected() && !isConnecting() && !isShuttingDown()) connect();
  }, intervalMs);
  if (poller.unref) poller.unref();
  return () => clearInterval(poller);
}
