/**
 * Type declarations for coms-shutdown-client.mjs.
 */

export declare const SHUTDOWN_ACK_TIMEOUT_MS: number;
export declare const SHUTDOWN_MAX_REPLY_BYTES: number;

export interface RequestPeerShutdownOptions {
  timeoutMs?: number;
  msgId?: string;
  senderSession?: string;
  reason?: string;
}

export type PeerShutdownResult =
  | { ok: true; busy: boolean; alreadyShuttingDown: boolean }
  | {
      ok: false;
      reason: "missing-endpoint" | "timeout" | "unreachable" | "write-failed" | "oversize" | "malformed" | "nack" | "closed";
      error?: string;
    };

export declare function requestPeerShutdown(
  endpoint: string,
  opts?: RequestPeerShutdownOptions,
): Promise<PeerShutdownResult>;
