import { createLogger } from "../lib/create-logger.ts";
import { useSharedWebSocket } from "../../../../shared/ui/useWebSocket.ts";

const log = createLogger("pidiff-ui");

export function useWebSocket(options?: { testWs?: WebSocket | null; reconnectMs?: number }) {
  return useSharedWebSocket({ url: "/ws/browser", ...options, logger: log });
}
