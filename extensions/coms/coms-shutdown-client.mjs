/**
 * coms-shutdown-client.mjs — Pure Node ESM client for graceful COMS RPC peer shutdown (#1488).
 *
 * Shared between `scripts/coms-peer-supervisor.mjs` (plain Node ESM) and
 * `extensions/coms/coms-wrapper.ts` (TypeScript) so both use one wire protocol
 * implementation with zero external dependencies.
 */
import * as net from "node:net";

/** Default timeout waiting for a peer to ACK a graceful `shutdown` envelope. */
export const SHUTDOWN_ACK_TIMEOUT_MS = 1_000;

/** Cap reply size so a broken peer cannot exhaust memory. */
export const SHUTDOWN_MAX_REPLY_BYTES = 16 * 1024;

/**
 * Send a graceful `shutdown` envelope to a supervised COMS RPC peer over its socket.
 *
 * Resolves `{ ok: true, busy, alreadyShuttingDown }` when the peer ACKs the shutdown
 * (meaning it is running `cleanShutdown()` and invoking Pi 1.7.0 `ctx.shutdown()`), or
 * `{ ok: false, reason, error? }` when the caller should fall back to external termination.
 */
export function requestPeerShutdown(endpoint, opts = {}) {
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : SHUTDOWN_ACK_TIMEOUT_MS;
  const msgId =
    typeof opts.msgId === "string" && opts.msgId
      ? opts.msgId
      : `shutdown-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const senderSession =
    typeof opts.senderSession === "string" && opts.senderSession ? opts.senderSession : "supervisor";
  const reason = typeof opts.reason === "string" && opts.reason ? opts.reason : "supervisor_stop";

  if (typeof endpoint !== "string" || !endpoint.trim()) {
    return Promise.resolve({ ok: false, reason: "missing-endpoint" });
  }

  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    let socket;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    timer.unref?.();

    try {
      socket = net.createConnection({ path: endpoint });
    } catch (err) {
      finish({ ok: false, reason: "unreachable", error: err?.message ?? String(err) });
      return;
    }

    socket.once("connect", () => {
      const envelope = {
        type: "shutdown",
        msg_id: msgId,
        sender_session: senderSession,
        sender_endpoint: "",
        hops: 0,
        reason,
        timestamp: new Date().toISOString(),
      };
      try {
        socket.write(`${JSON.stringify(envelope)}\n`);
      } catch (err) {
        finish({ ok: false, reason: "write-failed", error: err?.message ?? String(err) });
      }
    });

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      if (Buffer.byteLength(buf, "utf-8") > SHUTDOWN_MAX_REPLY_BYTES) {
        finish({ ok: false, reason: "oversize" });
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let reply;
      try {
        reply = JSON.parse(buf.slice(0, nl));
      } catch {
        finish({ ok: false, reason: "malformed" });
        return;
      }
      if (reply?.type === "ack") {
        finish({
          ok: true,
          busy: reply.busy === true,
          alreadyShuttingDown: reply.already_shutting_down === true,
        });
        return;
      }
      if (reply?.type === "nack") {
        finish({
          ok: false,
          reason: "nack",
          error: typeof reply.error === "string" ? reply.error : "nack",
        });
        return;
      }
      finish({ ok: false, reason: "malformed" });
    });

    socket.once("error", (err) => {
      finish({ ok: false, reason: "unreachable", error: err?.message ?? String(err) });
    });

    socket.once("close", () => {
      finish({ ok: false, reason: "closed" });
    });
  });
}
