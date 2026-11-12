/**
 * #1084 round 4 — the new peer logging lines must actually fire, and must fire only when there is
 * something to say. A sanitizer that silently stopped stripping would otherwise be invisible.
 *
 * Same capture pattern as the packaging suites (#1079): a temp HOME, the module's level pinned to
 * debug through PI_LOG_*, a cleared level cache (without it these pass alone and fail in the full
 * suite, where an earlier test cached the level), then read the real sink.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import { sanitizePeerText } from "../../../extensions/coms/peer-text.ts";
import { formatPeerTable, type RegistryRow } from "../../../extensions/coms/coms-peers.ts";
import { clearLogLevelCache, getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

const SESSION = "peer-logging-test";
const ENV_KEYS = ["PI_LOG_COMS_PEER_TEXT", "PI_LOG_COMS_PEERS"] as const;

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
