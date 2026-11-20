import { createLogger } from "../lib/create-logger.ts";
import { useSharedWebSocket } from "../../../../shared/ui/useWebSocket.ts";

const log = createLogger("pidash-ui");

export function useWebSocket(url: string, options?: { testWs?: WebSocket | null; reconnectMs?: number }) {
  return useSharedWebSocket({ url, ...options, logger: log });
}
