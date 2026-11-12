/**
 * `coms_describe` — the drilldown data, requested from the peer over its own socket (#1083).
 *
 * The requester asks; the peer answers from its own memory. There is no fallback: no reply means
 * `unknown`, never a filesystem scan of another process's tasks/crons (§#1072, #1080 — two
 * components disagreeing about another process's state).
 *
 * Only `node:net`: this module never reads or stats a file.
 */
import * as net from "node:net";
import { createLogger } from "../shared/logger.js";
import type { PeerWorkloadDetail } from "./coms-workload.js";

const log = createLogger("coms-describe");

export const DESCRIBE_TIMEOUT_MS = 2_000;

export interface DescribeReply {
  type: "describe_reply";
  msg_id: string;
  detail: PeerWorkloadDetail | null;
}

/** Ask one peer for its active workload. Resolves null when it does not answer in time. */
export function requestDescribe(
  endpoint: string,
  opts: { timeoutMs?: number; msgId?: string } = {},
): Promise<PeerWorkloadDetail | null> {
  const timeoutMs = opts.timeoutMs ?? DESCRIBE_TIMEOUT_MS;
  const msgId = opts.msgId ?? `describe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!endpoint) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: endpoint });
    let settled = false;
    let buf = "";
    const finish = (detail: PeerWorkloadDetail | null, reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      log.debug("describe_finished", { endpoint, reason, answered: detail !== null });
      resolve(detail);
    };
    const timer = setTimeout(() => finish(null, "timeout"), timeoutMs);
    socket.once("connect", () => {
      const request = { type: "describe", msg_id: msgId, sender_session: "", sender_endpoint: "", hops: 0, timestamp: new Date().toISOString() };
      try { socket.write(JSON.stringify(request) + "\n"); } catch { finish(null, "write_failed"); }
    });
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        if (reply?.type !== "describe_reply") return finish(null, "unexpected_reply");
        finish(isWorkloadDetail(reply.detail) ? reply.detail : null, reply.detail ? "ok" : "no_detail");
      } catch {
        finish(null, "malformed_reply");
      }
    });
    socket.once("error", (err: Error) => finish(null, `error:${err.message}`));
  });
}

/** Shape check on the untrusted reply: a malformed payload reads as `unknown`, not as zeros. */
function isWorkloadDetail(value: any): value is PeerWorkloadDetail {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray(value.agents) &&
    Array.isArray(value.tasks) &&
    Array.isArray(value.crons)
  );
}
