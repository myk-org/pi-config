/**
 * #1084 round 4 — the new peer logging lines must actually fire, and must fire only when there is
 * something to say. A sanitizer that silently stopped stripping would otherwise be invisible.
 *
 * Same capture pattern as the packaging suites (#1079): a temp HOME, the module's level pinned to
 * debug through PI_LOG_*, a cleared level cache (without it these pass alone and fail in the full
 * suite, where an earlier test cached the level), then read the real sink.
 */
import assert from "node:assert/strict";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { sanitizePeerText } from "../../../extensions/coms/peer-text.ts";
import { buildDrilldownRows, itemIdLabel, logDetailOpen, buildPeerInfoRow } from "../../../extensions/coms/coms-drilldown.ts";
import { formatPeerTable, type RegistryRow } from "../../../extensions/coms/coms-peers.ts";
import { clearLogLevelCache, getPiLogPath, getPiLogsDir, setGlobalSessionId } from "../../../extensions/shared/file-logger.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

const SESSION = "peer-logging-test";
const ENV_KEYS = ["PI_LOG_COMS_PEER_TEXT", "PI_LOG_COMS_PEERS", "PI_LOG_COMS_DRILLDOWN"] as const;

const row = (over: Partial<RegistryRow> = {}): RegistryRow => ({
  project: "proj-a", name: "peer1", pid: 100, cwd: "/w", purpose: "p", endpoint: "/sock",
  busy: false, queueDepth: null, contextUsedPct: null, startedAt: null, heartbeatAt: null, ...over,
});

/** The sink for one logger, or "" before anything has been written. */
const logBody = (name: string): string => {
  const logPath = getPiLogPath(name);
  assert.ok(logPath, `${name} log path must resolve while a session id is set`);
  return existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
};

/** Find an event anywhere in the log tree, reading only each file's tail. The sink nests per
 *  session, rotates on size, and this process shares ~/.pi/logs with a live session, so a single
 *  hard-coded path is brittle — and full reads of other sessions' rotated logs are enormous. */
const TAIL_BYTES = 256 * 1024;
const linesIn = (name: string, event: string): string[] => {
  const exact = getPiLogPath(name);
  const names = [join(getPiLogsDir(), name)];
  const found: string[] = [];
  const scan = (full: string): void => {
    const size = statSync(full).size;
    const startAt = Math.max(0, size - TAIL_BYTES);
    const length = size - startAt;
    if (length === 0) return;
    const buffer = Buffer.alloc(length);
    const fd = openSync(full, "r");
    try {
      readSync(fd, buffer, 0, length, startAt);
    } finally {
      closeSync(fd);
    }
    for (const line of buffer.toString("utf-8").split("\n")) {
      if (line.includes(event)) found.push(line);
    }
  };
  if (exact && existsSync(exact)) scan(exact);
  for (const nameDir of names) {
    if (!existsSync(nameDir)) continue;
    for (const entry of readdirSync(nameDir, { recursive: true, withFileTypes: true }) as any[]) {
      if (typeof entry.isFile !== "function" || !entry.isFile()) continue;
      if (!entry.name.endsWith(".log")) continue;
      const full = join(entry.parentPath ?? entry.path, entry.name);
      if (full === exact) continue; // already read
      scan(full);
    }
  }
  assert.ok(found.length > 0, `${event} must be written to a sink under ${join(getPiLogsDir(), name)}`);
  return found;
};

const lineFor = (name: string, event: string): string => {
  const line = logBody(name).split("\n").find((candidate) => candidate.includes(event));
  assert.ok(line, `${event} must be written to the ${name} log`);
  return line;
};

describe("peer logging", () => {
  const saved: { home?: string; userprofile?: string; levels: Record<string, string | undefined> } = {
    levels: {},
  };
  let tmpHome: string;

  before(() => {
    saved.home = process.env.HOME;
    saved.userprofile = process.env.USERPROFILE;
    for (const key of ENV_KEYS) saved.levels[key] = process.env[key];

    tmpHome = makeTempDir("pi-peer-logging-");
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.PI_LOG_COMS_PEER_TEXT = "debug";
    process.env.PI_LOG_COMS_PEERS = "debug";
    process.env.PI_LOG_COMS_DRILLDOWN = "debug";
    setGlobalSessionId(SESSION);
    // The level is cached for 30s per logger name — without this the debug gate stays at `info`
    // whenever another suite resolved it first.
    clearLogLevelCache();
  });

  after(() => {
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.userprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.userprofile;
    for (const key of ENV_KEYS) {
      if (saved.levels[key] === undefined) delete process.env[key];
      else process.env[key] = saved.levels[key];
    }
    clearLogLevelCache();
  });

  it("logs that peer text was sanitized, with lengths only", () => {
    const raw = "\x1b[2Jpwned";
    assert.equal(sanitizePeerText(raw, 120), "pwned");
    const line = lineFor("coms-peer-text", "peer_text_sanitized");
    const payload = JSON.parse(line.slice(line.indexOf("peer_text_sanitized") + "peer_text_sanitized ".length));
    assert.deepEqual(payload, { before: raw.length, after: 5 });
  });

  it("never writes the peer's text into the log", () => {
    const line = lineFor("coms-peer-text", "peer_text_sanitized");
    assert.equal(line.includes("pwned"), false, "the content must not be logged, only its length");
  });

  it("stays quiet when the input was already clean", () => {
    const beforeLines = logBody("coms-peer-text");
    assert.equal(sanitizePeerText("Wire the heartbeat", 120), "Wire the heartbeat");
    assert.equal(logBody("coms-peer-text"), beforeLines, "no line per clean field");
  });

  it("logs the peer table row count and the unknown count", () => {
    const rows = [row({ name: "alpha", workload: { agents: 1, tasks: 0, crons: 0 } }), row({ name: "beta", workload: null })];
    formatPeerTable(rows);
    const line = lineFor("coms-peers", "peer_table_rendered");
    const payload = JSON.parse(line.slice(line.indexOf("peer_table_rendered") + "peer_table_rendered ".length));
    assert.deepEqual(payload, { rows: 2, unknown: 1 });
  });

  it("never writes the peer names into the log", () => {
    const line = lineFor("coms-peers", "peer_table_rendered");
    assert.equal(line.includes("alpha"), false);
    assert.equal(line.includes("beta"), false);
  });
});

describe("drilldown logging (#1084 round 5)", () => {
  // The peer-logging suite above restores HOME/env in its after(), so a sibling suite starts with
  // debug gated off. Set the level for THIS suite instead of relying on the other one's hooks.
  before(() => {
    for (const key of ENV_KEYS) process.env[key] = "debug";
    setGlobalSessionId(SESSION);
    clearLogLevelCache();
  });
  after(() => clearLogLevelCache());

  const payloadsOf = (name: string, event: string): any[] => {
    const marker = `${event} `;
    const payloads: any[] = [];
    for (const line of linesIn(name, event)) {
      // Some lines mention an event name without carrying its payload; only parse JSON ones.
      const json = line.slice(line.indexOf(marker) + marker.length);
      const start = json.indexOf("{");
      if (start < 0) continue;
      try {
        payloads.push(JSON.parse(json.slice(start)));
      } catch {
        continue;
      }
    }
    assert.ok(payloads.length > 0, `${event} payload must be logged`);
    return payloads;
  };
  /** One event fires for several rows in a suite, so a case names the payload it means. */
  const payloadWhere = (name: string, event: string, match: (payload: any) => boolean): any => {
    const hit = payloadsOf(name, event).find(match);
    assert.ok(hit, `${event} with the expected payload must be logged`);
    return hit;
  };

  it("logs which id a row displayed, and the composite it came from", () => {
    const rows = buildDrilldownRows({
      ok: true,
      detail: { agents: [], tasks: [{ id: "session:abc", status: "pending", subject: "s", blockedBy: [] }], crons: [] },
      truncated: {},
    });
    const item = rows[0].items[0];
    assert.equal(itemIdLabel(item), "session:abc");
    assert.deepEqual(payloadWhere("coms-drilldown", "item_id_label", (p) => p.id === "0:session:abc"), {
      id: "0:session:abc",
      label: "session:abc",
    });
  });

  it("logs no label for a row that names nothing", () => {
    const info = buildPeerInfoRow({ name: "w", project: "p", busy: false }).items[0];
    assert.equal(itemIdLabel(info), "");
    assert.deepEqual(payloadWhere("coms-drilldown", "item_id_label", (p) => p.id === "0:peer"), { id: "0:peer", label: "" });
  });

  it("logs a detail-pane construction with its path and pair count, and no peer text", () => {
    const rows = buildDrilldownRows({
      ok: true,
      detail: { agents: [], tasks: [{ id: "7", status: "pending", subject: "secret subject", blockedBy: [] }], crons: [] },
      truncated: {},
    });
    const item = rows[0].items[0];
    logDetailOpen("direct", item);
    assert.deepEqual(payloadWhere("coms-drilldown", "drilldown_detail_open", (p) => p.id === "0:7"), {
      path: "direct",
      id: "0:7",
      pairs: item.detail.length,
    });
    for (const line of linesIn("coms-drilldown", "drilldown_detail_open")) {
      assert.equal(line.includes("secret subject"), false, "no peer text in the log");
    }
  });
});
