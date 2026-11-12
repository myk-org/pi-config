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
import {
  buildDrilldownRows,
  buildPeerInfoRow,
  clearItemIdLabelSeen,
  itemIdLabel,
  logDetailOpen,
} from "../../../extensions/coms/coms-drilldown.ts";
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
  // Finding A: these assertions must not be able to read another session's lines. Every case gets
  // its OWN home + session id, so the sink path is exact and a previous run cannot satisfy it.
  let savedHome: string | undefined;
  let savedParent: string | undefined;
  const savedLevels: Record<string, string | undefined> = {};
  let runs = 0;

  const freshSink = (): void => {
    const dir = makeTempDir(`pi-drilldown-log-${runs++}-`);
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    // A nested path (subagent layout) would move the file; these cases want the simple one.
    delete process.env.__PI_PARENT_SESSION_ID;
    for (const key of ENV_KEYS) process.env[key] = "debug";
    setGlobalSessionId(`drilldown-log-${runs}`);
    clearLogLevelCache();
    clearItemIdLabelSeen();
  };

  /** Only this run's exact sink — no tree scan, no fallback. */
  const exactLines = (name: string, event: string): string[] => {
    const logPath = getPiLogPath(name);
    assert.ok(logPath, `${name} log path must resolve`);
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf-8").split("\n").filter((line) => line.includes(event));
  };

  const exactPayloads = (name: string, event: string): any[] => {
    const marker = `${event} `;
    return exactLines(name, event).map((line) => {
      const json = line.slice(line.indexOf(marker) + marker.length);
      return JSON.parse(json.slice(json.indexOf("{")));
    });
  };

  before(() => {
    savedHome = process.env.HOME;
    savedParent = process.env.__PI_PARENT_SESSION_ID;
    for (const key of ENV_KEYS) savedLevels[key] = process.env[key];
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedParent === undefined) delete process.env.__PI_PARENT_SESSION_ID;
    else process.env.__PI_PARENT_SESSION_ID = savedParent;
    process.env.USERPROFILE = savedHome;
    for (const key of ENV_KEYS) {
      if (savedLevels[key] === undefined) delete process.env[key];
      else process.env[key] = savedLevels[key];
    }
    clearLogLevelCache();
    clearItemIdLabelSeen();
  });

  it("starts from an empty sink, so a stale line from another run cannot satisfy it", () => {
    freshSink();
    assert.deepEqual(exactLines("coms-drilldown", "item_id_label"), []);
    assert.deepEqual(exactPayloads("coms-drilldown", "item_id_label"), []);
  });

  it("logs which id a row displayed, and the composite it came from", () => {
    freshSink();
    const rows = buildDrilldownRows({
      ok: true,
      detail: { agents: [], tasks: [{ id: "session:abc", status: "pending", subject: "s", blockedBy: [] }], crons: [] },
      truncated: {},
    });
    const item = rows[0].items[0];
    assert.equal(itemIdLabel(item), "session:abc");
    assert.deepEqual(exactPayloads("coms-drilldown", "item_id_label"), [
      { id: "0:session:abc", label: "session:abc" },
    ]);
  });

  it("logs a no-name row once, with an empty label", () => {
    freshSink();
    const info = buildPeerInfoRow({ name: "w", project: "p", busy: false }).items[0];
    assert.equal(itemIdLabel(info), "");
    assert.equal(itemIdLabel(info), "");
    assert.deepEqual(exactPayloads("coms-drilldown", "item_id_label"), [{ id: "0:peer", label: "" }]);
  });

  it("stays silent for a trivial pair where the label IS the id", () => {
    freshSink();
    assert.equal(itemIdLabel({ id: "abc", displayId: "abc" }), "abc");
    assert.deepEqual(exactLines("coms-drilldown", "item_id_label"), []);
  });

  it("writes one line per mapping, not one per render tick", () => {
    freshSink();
    const item = { id: "0:peer", displayId: "" };
    for (let tick = 0; tick < 5; tick++) {
      const rows = buildDrilldownRows({ ok: false, reason: "timeout" });
      itemIdLabel(rows[0].items[0]);
      itemIdLabel(item);
    }
    // Two distinct mappings, five renders each.
    assert.equal(exactLines("coms-drilldown", "item_id_label").length, 2);
  });

  it("logs a detail-pane construction with its path and pair count, and no peer text", () => {
    freshSink();
    const rows = buildDrilldownRows({
      ok: true,
      detail: { agents: [], tasks: [{ id: "7", status: "pending", subject: "secret subject", blockedBy: [] }], crons: [] },
      truncated: {},
    });
    const item = rows[0].items[0];
    logDetailOpen("direct", item);
    assert.deepEqual(exactPayloads("coms-drilldown", "drilldown_detail_open"), [
      { path: "direct", id: "0:7", pairs: item.detail.length },
    ]);
    for (const line of exactLines("coms-drilldown", "drilldown_detail_open")) {
      assert.equal(line.includes("secret subject"), false, "no peer text in the log");
    }
  });
});
