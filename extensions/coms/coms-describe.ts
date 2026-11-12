/**
 * `coms_describe` — the drilldown data, requested from the peer over its own socket (#1083).
 *
 * The requester asks; the peer answers from its own memory. There is no fallback: no reply means
 * `unknown`, never a filesystem scan of another process's tasks/crons (§#1072, #1080 — two
 * components disagreeing about another process's state).
 *
 * The reply is untrusted peer input, so every entry is shape-checked before it can reach a
 * renderer: an invalid element is dropped (and logged), never passed through. The buffer and each
 * section are capped, so a hostile or broken peer cannot exhaust this process's memory.
 *
 * Only `node:net`: this module never reads or stats a file.
 */
import * as net from "node:net";
import { createLogger } from "../shared/logger.js";
import type {
  DescribeAgent,
  DescribeCron,
  DescribeFailure,
  DescribeTask,
  PeerWorkloadDetail,
} from "./coms-workload.js";

const log = createLogger("coms-workload");

export const DESCRIBE_TIMEOUT_MS = 2_000;
/** A reply line larger than this is not a workload report — refuse it rather than grow the buffer. */
export const DESCRIBE_MAX_REPLY_BYTES = 1024 * 1024;
/** Per-section cap: a peer cannot flood the detail pane with thousands of rows. */
export const DESCRIBE_MAX_ENTRIES = 50;

export interface DescribeReply {
  type: "describe_reply";
  msg_id: string;
  detail: PeerWorkloadDetail | null;
}

/** An answered peer (`ok`) versus one that never answered usefully (`reason`). */
export type DescribeResult =
  | { ok: true; detail: PeerWorkloadDetail }
  | { ok: false; reason: DescribeFailure };

/** Ask one peer for its active workload. */
export function requestDescribe(
  endpoint: string,
  opts: { timeoutMs?: number; msgId?: string } = {},
): Promise<DescribeResult> {
  const timeoutMs = opts.timeoutMs ?? DESCRIBE_TIMEOUT_MS;
  const msgId = opts.msgId ?? `describe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!endpoint) {
    log.debug("describe_unknown", { peer: "", reason: "no-sources" });
    return Promise.resolve({ ok: false, reason: "no-sources" });
  }
  log.debug("describe_request", { peer: endpoint, timeoutMs });
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: endpoint });
    let settled = false;
    let buf = "";
    const finish = (result: DescribeResult, reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      if (result.ok) {
        log.debug("describe_finished", { peer: endpoint, reason, agents: result.detail.agents.length, tasks: result.detail.tasks.length, crons: result.detail.crons.length });
      } else {
        log.debug("describe_unknown", { peer: endpoint, reason: result.reason });
      }
      resolve(result);
    };
    const invalid = (section: string, field: string, reason: DescribeFailure): void => {
      log.debug("describe_reply_invalid", { section, field });
      finish({ ok: false, reason }, "invalid");
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }, "timeout"), timeoutMs);
    socket.once("connect", () => {
      const request = { type: "describe", msg_id: msgId, sender_session: "", sender_endpoint: "", hops: 0, timestamp: new Date().toISOString() };
      try { socket.write(JSON.stringify(request) + "\n"); } catch { finish({ ok: false, reason: "malformed" }, "write_failed"); }
    });
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      if (Buffer.byteLength(buf, "utf-8") > DESCRIBE_MAX_REPLY_BYTES) {
        invalid("reply", "size", "oversize");
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let reply: any;
      try {
        reply = JSON.parse(buf.slice(0, nl));
      } catch {
        invalid("reply", "json", "malformed");
        return;
      }
      if (reply?.type !== "describe_reply") {
        invalid("reply", "type", "malformed");
        return;
      }
      if (reply.detail === null) {
        // The peer answered, and said it cannot report — not the same as silence.
        finish({ ok: false, reason: "no-sources" }, "no_sources");
        return;
      }
      const { detail, malformed } = validateDetail(reply.detail);
      if (malformed) {
        finish({ ok: false, reason: "malformed" }, "malformed_sections");
        return;
      }
      finish({ ok: true, detail }, "ok");
    });
    socket.once("error", (err: Error) => finish({ ok: false, reason: "malformed" }, `error:${err.message}`));
  });
}

/**
 * Shape-check an untrusted payload: malformed entries are dropped, and a section that arrived
 * non-empty but yielded no valid entry marks the whole reply malformed (the caller renders
 * `unknown`, so missing rows are never mistaken for an idle peer).
 */
export function validateDetail(raw: any): { detail: PeerWorkloadDetail; malformed: boolean } {
  const agents = readSection<DescribeAgent>("agents", raw?.agents, (entry) =>
    hasStrings(entry, ["id", "state", "elapsed"])
      ? {
          id: entry.id,
          name: typeof entry.name === "string" ? entry.name : "",
          state: entry.state,
          elapsed: entry.elapsed,
          purpose: typeof entry.purpose === "string" ? entry.purpose : "",
        }
      : null,
  );
  const tasks = readSection<DescribeTask>("tasks", raw?.tasks, (entry) =>
    hasStrings(entry, ["id", "status", "subject"])
      ? {
          id: entry.id,
          status: entry.status,
          subject: entry.subject,
          blockedBy: Array.isArray(entry.blockedBy) ? entry.blockedBy.filter((id: unknown) => typeof id === "string") : [],
        }
      : null,
  );
  const crons = readSection<DescribeCron>("crons", raw?.crons, (entry) =>
    hasStrings(entry, ["id", "schedule", "next", "description"])
      ? { id: entry.id, schedule: entry.schedule, next: entry.next, description: entry.description }
      : null,
  );
  // A section of the wrong type, or one that arrived non-empty but yielded no usable entry,
  // makes the reply untrustworthy — the caller renders `unknown` rather than a partial guess.
  const malformed = [agents, tasks, crons].some(
    (section) => section.invalidType || (section.received > 0 && section.items.length === 0),
  );
  return { detail: { agents: agents.items, tasks: tasks.items, crons: crons.items }, malformed };
}

function readSection<T>(
  section: string,
  value: unknown,
  pick: (entry: any) => T | null,
): { items: T[]; received: number; invalidType: boolean } {
  if (value === undefined) return { items: [], received: 0, invalidType: false };
  if (!Array.isArray(value)) {
    log.debug("describe_reply_invalid", { section, field: "type" });
    return { items: [], received: 0, invalidType: true };
  }
  const items: T[] = [];
  for (const entry of value.slice(0, DESCRIBE_MAX_ENTRIES)) {
    const item = entry && typeof entry === "object" ? pick(entry) : null;
    if (item) items.push(item);
    else log.debug("describe_entry_invalid", { section, field: "entry" });
  }
  if (value.length > DESCRIBE_MAX_ENTRIES) {
    log.debug("describe_entries_truncated", { section, kept: items.length, received: value.length });
  }
  return { items, received: Math.min(value.length, DESCRIBE_MAX_ENTRIES), invalidType: false };
}

function hasStrings(entry: any, fields: readonly string[]): boolean {
  return fields.every((field) => typeof entry[field] === "string");
}
