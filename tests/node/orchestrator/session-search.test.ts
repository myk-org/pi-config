/**
 * Session-search store, harvest, and recent-session scan tests (issues #915, #1342).
 * Run: npx tsx --test tests/node/orchestrator/session-search.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  indexSessionSummary,
  searchSessions,
  extractSessionSummaries,
  registerSessionSearch,
  getProjectSessionsDir,
  redactSecrets,
  clearSessionScanCache,
  getSessionScanStats,
} from "../../../extensions/orchestrator/session-search.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

function makeCwd(): string {
  return makeTempDir("session-search-");
}

function makeSessionJsonl(lines: unknown[], trailingNewline = true): string {
  const joined = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  return trailingNewline ? joined + "\n" : joined;
}

function makeUserMsg(text: string, timestamp: string, asBlocks = true): Record<string, unknown> {
  return {
    type: "message",
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp,
    message: {
      role: "user",
      content: asBlocks ? [{ type: "text", text }] : text,
    },
  };
}

function registerHandlers(): {
  tools: Map<string, any>;
  handlers: Map<string, Array<(...args: any[]) => any>>;
} {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, fn: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
  } as any;

  withSubagentChildEnv(undefined, () => {
    registerSessionSearch(pi);
    assert.ok(tools.get("session_search"), "session_search tool must be registered in parent orchestrator");
    return undefined;
  });

  return { tools, handlers };
}

beforeEach(() => {
  clearSessionScanCache();
});

describe("session-search JSONL store", () => {
  it("indexes and searches summaries", () => {
    const cwd = makeCwd();
    try {
      indexSessionSummary(cwd, "sess-1", "We discussed the deployment pipeline and rollout strategy for the sidecar");
      indexSessionSummary(cwd, "sess-2", "Unrelated talk about documentation formatting");

      const results = searchSessions(cwd, "deployment pipeline", 5);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.sessionId, "sess-1");
      assert.match(results[0]!.snippet, /deployment/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("deduplicates identical summaries for the same session", () => {
    const cwd = makeCwd();
    try {
      const summary = "Repeated identical summary about caching behavior in the provider layer";
      indexSessionSummary(cwd, "sess-1", summary);
      indexSessionSummary(cwd, "sess-1", summary);
      assert.equal(searchSessions(cwd, "caching", 10).length, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("caps persisted entries at 500", () => {
    const cwd = makeCwd();
    try {
      for (let i = 0; i < 510; i++) {
        indexSessionSummary(cwd, `sess-${i}`, `Unique summary number ${i} about topic alpha`);
      }
      assert.ok(searchSessions(cwd, "topic alpha", 600).length <= 500);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("migrates a legacy JSON store on first access", () => {
    const cwd = makeCwd();
    try {
      const dataDir = path.join(cwd, ".pi", "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, "session-search.json"),
        JSON.stringify({
          entries: [
            { sessionId: "legacy-1", timestamp: "2026-01-01T00:00:00Z", summary: "Legacy summary about migration testing" },
          ],
        }),
      );

      const results = searchSessions(cwd, "migration testing", 5);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.sessionId, "legacy-1");
      assert.ok(fs.existsSync(path.join(dataDir, "session-search.jsonl")));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("extractSessionSummaries (pi session file harvest)", () => {
  it("extracts compaction and branch summaries while skipping short or corrupt lines", () => {
    const dir = makeCwd();
    try {
      const file = path.join(dir, "session.jsonl");
      const lines = [
        JSON.stringify({ type: "message", role: "user", content: "hello" }),
        JSON.stringify({
          type: "compaction",
          summary: "The user worked on the memory system hardening pass and reviewed the conflict gate design in detail.",
          firstKeptEntryId: "abc",
        }),
        "{corrupt json line",
        JSON.stringify({
          type: "branch_summary",
          summary: "Explored an alternative approach using vector-only conflict detection before returning to polarity heuristics.",
        }),
        JSON.stringify({ type: "compaction", summary: "too short" }),
      ];
      fs.writeFileSync(file, lines.join("\n"));

      const summaries = extractSessionSummaries(file);
      assert.equal(summaries.length, 2);
      assert.match(summaries[0]!, /memory system hardening/);
      assert.match(summaries[1]!, /vector-only conflict detection/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty for a missing file", () => {
    assert.deepEqual(extractSessionSummaries("/nonexistent/session.jsonl"), []);
  });

  it("redacts secrets in extracted compaction summaries", () => {
    const dir = makeCwd();
    try {
      const file = path.join(dir, "session.jsonl");
      const fakeGhToken = "ghp_" + "A".repeat(36);
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          {
            type: "compaction",
            summary: `Reviewed authentication flow using token ${fakeGhToken} and verified retry backoff behavior.`,
          },
        ]),
      );

      const summaries = extractSessionSummaries(file);
      assert.equal(summaries.length, 1);
      assert.ok(!summaries[0]!.includes(fakeGhToken));
      assert.match(summaries[0]!, /\[REDACTED\]/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recent uncompacted session JSONL scanning (issue #1342)", () => {
  it("finds an uncompacted session via PI_CODING_AGENT_DIR slug resolution", () => {
    const cwd = makeCwd();
    const agentDir = makeTempDir("pi-agent-dir-");
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const sessionsDir = getProjectSessionsDir(cwd);
      fs.mkdirSync(sessionsDir, { recursive: true });
      const sid = "01a1f85b-15aa-75b6-b55d-597af88bc941";
      const file = path.join(sessionsDir, `2026-11-20T09-48-01-322Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-20T09:48:01.322Z", cwd },
          { type: "session_info", name: "PR 1334 floorplan comparison", timestamp: "2026-11-20T09:49:00.000Z" },
          makeUserMsg("tell me if floorplan is useful compared to trail for PR #1334 retrospective", "2026-11-20T09:50:00.000Z"),
        ]),
      );

      assert.equal(fs.existsSync(path.join(cwd, ".pi", "data", "session-search.jsonl")), false);

      const results = searchSessions(cwd, "floorplan retrospective", 5);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.sessionId, sid);
      assert.equal(results[0]!.score, 1);
      assert.match(results[0]!.snippet, /floorplan/i);
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("skips a truncated trailing JSON line in an abnormally terminated session", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-crash-");
    try {
      const sid = "crashed-session-1234";
      const file = path.join(sessionsDir, `2026-11-20T12-00-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl(
          [
            { type: "session", version: 3, id: sid, timestamp: "2026-11-20T12:00:00.000Z", cwd },
            makeUserMsg("Investigating kubernetes pod eviction loop on staging cluster", "2026-11-20T12:01:00.000Z", false),
            '{"type":"message","message":{"role":"user","content":"truncated mid-write',
          ],
          false,
        ),
      );

      const results = searchSessions(cwd, "kubernetes eviction", 5, { sessionsDir });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.sessionId, sid);
      assert.match(results[0]!.snippet, /eviction/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("parses a valid final line without a trailing newline", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-no-nl-");
    try {
      const sid = "no-trailing-newline-sid";
      const file = path.join(sessionsDir, `2026-11-20T12-10-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl(
          [
            { type: "session", version: 3, id: sid, timestamp: "2026-11-20T12:10:00.000Z", cwd },
            makeUserMsg("Checking ringbuffer saturation metric in telemetry daemon", "2026-11-20T12:11:00.000Z"),
          ],
          false,
        ),
      );

      const results = searchSessions(cwd, "ringbuffer saturation", 5, { sessionsDir });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.sessionId, sid);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("reuses the mtime cache on repeated queries of an unchanged session file", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-cache-hit-");
    try {
      const sid = "active-cache-hit-01";
      const file = path.join(sessionsDir, `2026-11-21T10-00-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-21T10:00:00.000Z", cwd },
          makeUserMsg("Initial discussion about sqlite WAL checkpoint tuning", "2026-11-21T10:01:00.000Z"),
        ]),
      );

      assert.equal(searchSessions(cwd, "sqlite checkpoint", 5, { sessionsDir }).length, 1);
      assert.deepEqual(getSessionScanStats(), { cacheHits: 0, fullScans: 1, incrementalScans: 0 });

      assert.equal(searchSessions(cwd, "sqlite checkpoint", 5, { sessionsDir }).length, 1);
      assert.deepEqual(getSessionScanStats(), { cacheHits: 1, fullScans: 1, incrementalScans: 0 });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("performs an incremental byte-offset scan when new lines are appended", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-inc-append-");
    try {
      const sid = "active-incremental-02";
      const file = path.join(sessionsDir, `2026-11-21T10-00-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-21T10:00:00.000Z", cwd },
          makeUserMsg("Initial discussion about sqlite WAL checkpoint tuning", "2026-11-21T10:01:00.000Z"),
        ]),
      );

      searchSessions(cwd, "sqlite checkpoint", 5, { sessionsDir });
      fs.appendFileSync(
        file,
        JSON.stringify(
          makeUserMsg("Now debugging prometheus scrape timeout in sidecar", "2026-11-21T10:05:00.000Z"),
        ) + "\n",
      );

      const results = searchSessions(cwd, "prometheus scrape", 5, { sessionsDir });
      assert.equal(results.length, 1);
      assert.equal(results[0]!.sessionId, sid);
      assert.deepEqual(getSessionScanStats(), { cacheHits: 0, fullScans: 1, incrementalScans: 1 });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("falls back to a full scan when a session file is truncated or rewritten shorter", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-rewrite-");
    try {
      const sid = "active-rewrite-03";
      const file = path.join(sessionsDir, `2026-11-21T10-00-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-21T10:00:00.000Z", cwd },
          makeUserMsg("Original prometheus scrape timeout investigation notes", "2026-11-21T10:01:00.000Z"),
          makeUserMsg("Extra detail line that makes the original file longer", "2026-11-21T10:02:00.000Z"),
        ]),
      );

      searchSessions(cwd, "prometheus scrape", 5, { sessionsDir });
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-21T10:00:00.000Z", cwd },
          makeUserMsg("Rewritten graphql schema federation", "2026-11-21T10:10:00.000Z"),
        ]),
      );

      const results = searchSessions(cwd, "graphql federation", 5, { sessionsDir });
      assert.equal(results.length, 1);
      assert.equal(getSessionScanStats().fullScans, 2);
      assert.equal(searchSessions(cwd, "prometheus scrape", 5, { sessionsDir }).length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("handles incremental append after a non-newline-terminated line without duplicating it", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-pending-nl-");
    try {
      const sid = "pending-nl-session";
      const file = path.join(sessionsDir, `2026-11-21T11-00-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl(
          [
            { type: "session", version: 3, id: sid, timestamp: "2026-11-21T11:00:00.000Z", cwd },
            makeUserMsg("Investigating radix trie lookup latency", "2026-11-21T11:01:00.000Z"),
          ],
          false,
        ),
      );

      assert.equal(searchSessions(cwd, "radix trie", 5, { sessionsDir }).length, 1);

      fs.appendFileSync(
        file,
        "\n" +
          JSON.stringify(
            makeUserMsg("Follow-up on bloom filter false positive rate", "2026-11-21T11:02:00.000Z"),
          ) +
          "\n",
      );

      assert.equal(searchSessions(cwd, "radix trie", 5, { sessionsDir }).length, 1);
      assert.equal(searchSessions(cwd, "bloom filter", 5, { sessionsDir }).length, 1);
      assert.equal(getSessionScanStats().incrementalScans, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("supersedes uncompacted raw messages when a real summary is indexed for the same session", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-dedup-");
    try {
      const sid = "sess-supersede-1";
      const file = path.join(sessionsDir, `2026-11-21T08-00-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-21T08:00:00.000Z", cwd },
          makeUserMsg("Working on canary rollout metrics and alert thresholds", "2026-11-21T08:01:00.000Z"),
        ]),
      );

      assert.equal(searchSessions(cwd, "canary rollout", 5, { sessionsDir }).length, 1);

      const realSummary =
        "Completed canary rollout metrics implementation and added Prometheus alert rules for latency spikes.";
      indexSessionSummary(cwd, sid, realSummary);

      const postHits = searchSessions(cwd, "canary rollout", 5, { sessionsDir });
      assert.equal(postHits.length, 1);
      assert.equal(postHits[0]!.sessionId, sid);
      assert.match(postHits[0]!.snippet, /Prometheus alert rules/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("keeps post-compaction turns searchable while deduplicating compaction summaries per session", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-post-compact-");
    try {
      const sid = "multi-day-session-42";
      const file = path.join(sessionsDir, `2026-11-20T09-00-00-000Z_${sid}.jsonl`);
      const compactionSummary =
        "Day 1 work completed the OAuth PKCE token refresh overhaul and added regression tests for clock skew.";
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-20T09:00:00.000Z", cwd },
          makeUserMsg("Early pre-compaction brainstorm about obsolete legacy-widget", "2026-11-20T09:05:00.000Z"),
          { type: "compaction", summary: compactionSummary, timestamp: "2026-11-20T12:00:00.000Z" },
          makeUserMsg("Day 2 task: benchmark websocket reconnection jitter in pidiff", "2026-11-21T14:00:00.000Z"),
        ]),
      );
      const dataDir = path.join(cwd, ".pi", "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, "session-search.jsonl"),
        JSON.stringify({
          entries: [{ sessionId: sid, timestamp: "2026-11-20T12:00:05.000Z", summary: compactionSummary }],
        }) + "\n",
      );

      assert.equal(searchSessions(cwd, "OAuth PKCE", 5, { sessionsDir }).length, 1);
      assert.equal(searchSessions(cwd, "legacy-widget", 5, { sessionsDir }).length, 0);

      const day2 = searchSessions(cwd, "websocket reconnection jitter", 5, { sessionsDir });
      assert.equal(day2.length, 1);
      assert.equal(day2[0]!.sessionId, sid);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("excludes the requested sessionId when excludeSessionId is passed", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-exclude-");
    try {
      const activeSid = "active-current-session";
      const otherSid = "older-past-session";
      fs.writeFileSync(
        path.join(sessionsDir, `2026-11-22T12-00-00-000Z_${activeSid}.jsonl`),
        makeSessionJsonl([
          { type: "session", version: 3, id: activeSid, timestamp: "2026-11-22T12:00:00.000Z", cwd },
          makeUserMsg("Debugging shared-recall-topic in current active chat", "2026-11-22T12:01:00.000Z"),
        ]),
      );
      fs.writeFileSync(
        path.join(sessionsDir, `2026-11-21T12-00-00-000Z_${otherSid}.jsonl`),
        makeSessionJsonl([
          { type: "session", version: 3, id: otherSid, timestamp: "2026-11-21T12:00:00.000Z", cwd },
          makeUserMsg("Earlier notes on shared-recall-topic from yesterday", "2026-11-21T12:01:00.000Z"),
        ]),
      );

      const hits = searchSessions(cwd, "shared-recall-topic", 5, {
        sessionsDir,
        excludeSessionId: activeSid,
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.sessionId, otherSid);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("scans older unindexed sessions even when more than 20 newer sessions are already in the store", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-priority-");
    try {
      const oldUnindexedSid = "older-crashed-session-00";
      const oldFile = path.join(sessionsDir, `2026-11-01T08-00-00-000Z_${oldUnindexedSid}.jsonl`);
      fs.writeFileSync(
        oldFile,
        makeSessionJsonl([
          { type: "session", version: 3, id: oldUnindexedSid, timestamp: "2026-11-01T08:00:00.000Z", cwd },
          makeUserMsg("Unclosed historical investigation into shard-rebalance-deadlock", "2026-11-01T08:05:00.000Z"),
        ]),
      );
      const oldTime = new Date("2026-11-01T08:05:00.000Z");
      fs.utimesSync(oldFile, oldTime, oldTime);

      // Create 25 newer sessions that are already cleanly indexed in the persisted store
      for (let i = 1; i <= 25; i++) {
        const sid = `newer-closed-${String(i).padStart(2, "0")}`;
        const ts = `2026-11-20T10:${String(i).padStart(2, "0")}:00.000Z`;
        const file = path.join(sessionsDir, `2026-11-20T10-${String(i).padStart(2, "0")}-00-000Z_${sid}.jsonl`);
        fs.writeFileSync(
          file,
          makeSessionJsonl([
            { type: "session", version: 3, id: sid, timestamp: ts, cwd },
            makeUserMsg(`Routine maintenance work number ${i} on build scripts`, ts),
          ]),
        );
        indexSessionSummary(cwd, sid, `Routine maintenance work number ${i} on build scripts completed.`);
      }

      const hits = searchSessions(cwd, "shard-rebalance-deadlock", 5, { sessionsDir });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.sessionId, oldUnindexedSid);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("surfaces unindexed branch summaries in canonical files when store has a newer entry", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-branch-summary-");
    try {
      const sid = "branch-unindexed-88";
      const file = path.join(sessionsDir, `2026-11-20T09-00-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-20T09:00:00.000Z", cwd },
          {
            type: "branch_summary",
            summary:
              "Explored zero-copy mmap ring buffer architecture for streaming session search indexes before reverting.",
            timestamp: "2026-11-20T10:00:00.000Z",
          },
        ]),
      );

      indexSessionSummary(
        cwd,
        sid,
        "Earlier compaction summary covering parser refactor and lexical scoring adjustments across modules.",
      );

      const branchHits = searchSessions(cwd, "mmap ring buffer", 5, { sessionsDir });
      assert.equal(branchHits.length, 1);
      assert.equal(branchHits[0]!.sessionId, sid);

      const storeHits = searchSessions(cwd, "parser refactor", 5, { sessionsDir });
      assert.equal(storeHits.length, 1);
      assert.equal(storeHits[0]!.sessionId, sid);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("probes the header and scans the tail window on files larger than 4MB", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-oversized-tail-");
    try {
      const sid = "oversized-header-probe-90";
      const file = path.join(sessionsDir, "non-canonical-large.jsonl");
      const header = JSON.stringify({
        type: "session",
        version: 3,
        id: sid,
        timestamp: "2026-11-22T07:00:00.000Z",
        cwd,
      });
      const earlyMsg = JSON.stringify(
        makeUserMsg("Ancient pre-window-dropped-keyword topic from start of file", "2026-11-22T07:01:00.000Z"),
      );
      const fillerChunk = JSON.stringify({
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text: "z".repeat(128 * 1024) }] },
      });
      // > 4MB of filler rows so st.size exceeds MAX_SCAN_BYTES
      const filler = Array.from({ length: 34 }, () => fillerChunk).join("\n");
      const tailMsg = JSON.stringify(
        makeUserMsg("Recent tail-window-discovered-keyword benchmark results", "2026-11-22T07:30:00.000Z"),
      );
      fs.writeFileSync(file, `${header}\n${earlyMsg}\n${filler}\n${tailMsg}\n`);

      const tailHits = searchSessions(cwd, "tail-window-discovered-keyword", 5, { sessionsDir });
      assert.equal(tailHits.length, 1);
      assert.equal(tailHits[0]!.sessionId, sid);
      assert.equal(searchSessions(cwd, "pre-window-dropped-keyword", 5, { sessionsDir }).length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("recovers cleanly after an oversized single-line tail slice with no newline", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-oversized-nonl-");
    try {
      const sid = "oversized-tail-91";
      const file = path.join(sessionsDir, `2026-11-22T08-00-00-000Z_${sid}.jsonl`);
      const header = JSON.stringify({
        type: "session",
        version: 3,
        id: sid,
        timestamp: "2026-11-22T08:00:00.000Z",
        cwd,
      });
      const hugeLine = JSON.stringify({
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024 + 2048) }] },
      });
      fs.writeFileSync(file, `${header}\n${hugeLine}`);

      assert.equal(searchSessions(cwd, "oversized-tail-recovery", 5, { sessionsDir }).length, 0);

      fs.appendFileSync(
        file,
        "\n" +
          JSON.stringify(
            makeUserMsg("Resolving oversized-tail-recovery edge case after huge tool output", "2026-11-22T08:05:00.000Z"),
          ) +
          "\n",
      );

      const hits = searchSessions(cwd, "oversized-tail-recovery", 5, { sessionsDir });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.sessionId, sid);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("supersedes raw messages despite filesystem mtime clock skew when entries lack timestamps", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-mtime-skew-");
    try {
      const sid = "mtime-skew-session-5";
      const file = path.join(sessionsDir, `2026-11-22T09-00-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, cwd },
          { type: "message", message: { role: "user", content: "Initial raw-only-skew-keyword brainstorming note" } },
        ]),
      );
      const ahead = new Date(Date.now() + 200);
      fs.utimesSync(file, ahead, ahead);

      indexSessionSummary(
        cwd,
        sid,
        "Authoritative compaction summary replacing raw brainstorming after clock-skew-superseded check.",
      );

      assert.equal(searchSessions(cwd, "raw-only-skew-keyword", 5, { sessionsDir }).length, 0);
      const hits = searchSessions(cwd, "clock-skew-superseded", 5, { sessionsDir });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.sessionId, sid);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

describe("session-search sanitization and subagent filtering", () => {
  it("redacts prefixed env keys, API tokens, auth headers, and URL credentials in redactSecrets", () => {
    const fakeOpenAiKey = "sk-proj-" + "x".repeat(30);
    const fakeAuthHeader = "Authorization: Bearer " + "b".repeat(32);
    const fakeUrl = ["https://alice", "supersecretpass@registry.example.com/pkg"].join(":");
    const envVal = "val_" + "q".repeat(16);
    const ghVal = "tok_" + "w".repeat(16);
    const jsonVal = "jsn_" + "r".repeat(16);
    const sample = [
      fakeOpenAiKey,
      fakeAuthHeader,
      fakeUrl,
      `api_key=bare_${"m".repeat(14)}`,
      `OPENAI_API_KEY=${envVal}`,
      `GITHUB_TOKEN=${ghVal}`,
      JSON.stringify({ OPENAI_API_KEY: jsonVal }),
    ].join(" ");

    const redacted = redactSecrets(sample);
    assert.ok(!redacted.includes(fakeOpenAiKey));
    assert.ok(!redacted.includes("b".repeat(32)));
    assert.ok(!redacted.includes("supersecretpass"));
    assert.ok(!redacted.includes("m".repeat(14)));
    assert.ok(!redacted.includes(envVal));
    assert.ok(!redacted.includes(ghVal));
    assert.ok(!redacted.includes(jsonVal));
  });

  it("filters slash commands and harness banners while preserving prompts after peer-joined prefixes", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-noise-");
    try {
      const sid = "noise-filter-session";
      fs.writeFileSync(
        path.join(sessionsDir, `2026-11-22T10-00-00-000Z_${sid}.jsonl`),
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-22T10:00:00.000Z", cwd },
          makeUserMsg("/compact focus on memory", "2026-11-22T10:01:00.000Z"),
          makeUserMsg("[IMPORTANT: internal system notice about specialtoken]", "2026-11-22T10:02:00.000Z"),
          makeUserMsg("📡 Connected to coms · You are peer-1", "2026-11-22T10:02:30.000Z"),
          makeUserMsg(
            "📡 Peer joined: wt-1 [2026-11-22T10:03:00Z]\nDeploying webhook proxy with circuit breakers",
            "2026-11-22T10:03:00.000Z",
          ),
        ]),
      );

      assert.equal(searchSessions(cwd, "compact focus", 5, { sessionsDir }).length, 0);
      assert.equal(searchSessions(cwd, "specialtoken", 5, { sessionsDir }).length, 0);
      assert.equal(searchSessions(cwd, "Connected to coms", 5, { sessionsDir }).length, 0);

      const hits = searchSessions(cwd, "webhook proxy", 5, { sessionsDir });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.sessionId, sid);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("skips async subagent session files", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-subagent-");
    try {
      fs.writeFileSync(
        path.join(sessionsDir, "2026-11-22T10-05-00-000Z_async-code-reviewer-quality-abc123.jsonl"),
        makeSessionJsonl([
          {
            type: "session",
            version: 3,
            id: "async-code-reviewer-quality-abc123",
            timestamp: "2026-11-22T10:05:00.000Z",
            cwd,
          },
          makeUserMsg("Reviewing subagent-only-keyword diff in isolation", "2026-11-22T10:05:01.000Z"),
        ]),
      );

      assert.equal(searchSessions(cwd, "subagent-only-keyword", 5, { sessionsDir }).length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("redacts secrets in snippets returned from scanned session files", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-redact-snippet-");
    try {
      const sid = "clean-session-77";
      const fakeOpenAiKey = "sk-proj-" + "x".repeat(30);
      const fakeUrl = ["https://alice", "supersecretpass@registry.example.com/pkg"].join(":");
      const liveEnvVal = "live_" + "v".repeat(16);
      fs.writeFileSync(
        path.join(sessionsDir, `2026-11-22T10-00-00-000Z_${sid}.jsonl`),
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-22T10:00:00.000Z", cwd },
          makeUserMsg(
            `Deploying webhook proxy with OPENAI_API_KEY=${liveEnvVal} ${fakeOpenAiKey} ${fakeUrl}`,
            "2026-11-22T10:03:00.000Z",
          ),
        ]),
      );

      const hits = searchSessions(cwd, "webhook proxy", 5, { sessionsDir });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.sessionId, sid);
      assert.ok(!hits[0]!.snippet.includes(liveEnvVal));
      assert.ok(!hits[0]!.snippet.includes(fakeOpenAiKey));
      assert.ok(!hits[0]!.snippet.includes("supersecretpass"));
      assert.match(hits[0]!.snippet, /\[REDACTED\]/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

describe("registerSessionSearch PI_SUBAGENT_CHILD and lifecycle hooks", () => {
  it("registers session_search to search recent uncompacted sessions when PI_SUBAGENT_CHILD is unset", async () => {
    const { tools } = registerHandlers();
    const sessionSearchTool = tools.get("session_search");

    const cwd = makeCwd();
    const agentDir = makeTempDir("pi-agent-tool-");
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const sessionsDir = getProjectSessionsDir(cwd);
      fs.mkdirSync(sessionsDir, { recursive: true });
      const sid = "tool-exec-session-99";
      fs.writeFileSync(
        path.join(sessionsDir, `2026-11-22T15-00-00-000Z_${sid}.jsonl`),
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-22T15:00:00.000Z", cwd },
          makeUserMsg("Investigating vector embedding cache invalidation on reload", "2026-11-22T15:01:00.000Z"),
        ]),
      );

      const res = await sessionSearchTool.execute(
        "call-1",
        { query: "embedding cache invalidation", limit: 5 },
        undefined,
        undefined,
        { cwd },
      );
      assert.match(res.content[0].text, /Found 1 past session\(s\)/);
      assert.match(res.content[0].text, /tool-exe/);
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("redacts secrets in session_shutdown fallback entries", () => {
    const { handlers } = registerHandlers();
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-shutdown-redact-");
    try {
      const startFn = handlers.get("session_start")?.[0];
      const inputFn = handlers.get("input")?.[0];
      const shutdownFn = handlers.get("session_shutdown")?.[0];
      assert.ok(startFn && inputFn && shutdownFn);

      const liveSid = "shutdown-fallback-session";
      const fakeKey = "sk-ant-" + "z".repeat(28);
      startFn({}, { cwd, sessionManager: { getSessionId: () => liveSid, getSessionFile: () => "" } });
      inputFn({ text: `Configuring telemetry exporter with key ${fakeKey}` }, { cwd });
      shutdownFn({}, { cwd });

      const hits = searchSessions(cwd, "telemetry exporter", 5, { sessionsDir });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.sessionId, liveSid);
      assert.ok(!hits[0]!.snippet.includes(fakeKey));
      assert.match(hits[0]!.snippet, /\[REDACTED\]/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("skips willRetry compactions during session_compact", () => {
    const { handlers } = registerHandlers();
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-compact-retry-");
    try {
      const startFn = handlers.get("session_start")?.[0];
      const compactFn = handlers.get("session_compact")?.[0];
      assert.ok(startFn && compactFn);

      startFn({}, { cwd, sessionManager: { getSessionId: () => "retry-sid", getSessionFile: () => "" } });
      compactFn(
        {
          willRetry: true,
          compactionEntry: {
            summary: "Aborted overflow retry summary mentioning skipped-retry-marker that must not be indexed.",
          },
        },
        { cwd },
      );

      assert.equal(searchSessions(cwd, "skipped-retry-marker", 5, { sessionsDir }).length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("clears buffered sessionMessages on non-willRetry session_compact before shutdown fallback", () => {
    const { handlers } = registerHandlers();
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-compact-clear-");
    try {
      const startFn = handlers.get("session_start")?.[0];
      const inputFn = handlers.get("input")?.[0];
      const compactFn = handlers.get("session_compact")?.[0];
      const shutdownFn = handlers.get("session_shutdown")?.[0];
      assert.ok(startFn && inputFn && compactFn && shutdownFn);

      const sid = "compact-clears-buffer-sid";
      startFn({}, { cwd, sessionManager: { getSessionId: () => sid, getSessionFile: () => "" } });
      inputFn({ text: "Pre-compaction stale-prompt-marker message before compaction" }, { cwd });
      compactFn(
        {
          willRetry: false,
          compactionEntry: {
            summary: "Authoritative compaction summary capturing compacted-summary-marker outcome cleanly.",
          },
        },
        { cwd },
      );
      shutdownFn({}, { cwd });

      assert.equal(searchSessions(cwd, "compacted-summary-marker", 5, { sessionsDir }).length, 1);
      assert.equal(searchSessions(cwd, "stale-prompt-marker", 5, { sessionsDir }).length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("persists post-compaction sessionMessages during session_shutdown when file has summaries", () => {
    const { handlers } = registerHandlers();
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-post-compact-shutdown-");
    try {
      const sid = "post-compact-shutdown-sid";
      const file = path.join(sessionsDir, `2026-11-22T16-00-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-22T16:00:00.000Z", cwd },
          {
            type: "compaction",
            summary: "Earlier compaction summary documenting grpc-keepalive-tuning across load balancers.",
            timestamp: "2026-11-22T16:10:00.000Z",
          },
        ]),
      );

      const startFn = handlers.get("session_start")?.[0];
      const inputFn = handlers.get("input")?.[0];
      const compactFn = handlers.get("session_compact")?.[0];
      const shutdownFn = handlers.get("session_shutdown")?.[0];
      assert.ok(startFn && inputFn && compactFn && shutdownFn);

      startFn({}, { cwd, sessionManager: { getSessionId: () => sid, getSessionFile: () => file } });
      inputFn({ text: "Pre-compaction message that compaction replaces" }, { cwd });
      compactFn(
        {
          willRetry: false,
          compactionEntry: {
            summary: "Earlier compaction summary documenting grpc-keepalive-tuning across load balancers.",
          },
        },
        { cwd },
      );
      inputFn({ text: "Post-compaction turn about shutdown-surviving-tail-topic" }, { cwd });
      shutdownFn({}, { cwd });

      // Verify post-compaction turn was persisted to the store even without scanning sessionsDir
      const emptyDir = makeTempDir("sessions-empty-");
      try {
        assert.equal(searchSessions(cwd, "grpc-keepalive-tuning", 5, { sessionsDir: emptyDir }).length, 1);
        assert.equal(searchSessions(cwd, "shutdown-surviving-tail-topic", 5, { sessionsDir: emptyDir }).length, 1);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("skips registration when PI_SUBAGENT_CHILD=1", () => {
    const tools = new Map<string, any>();
    const events: string[] = [];
    const pi = {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      on: (event: string) => events.push(event),
    } as any;

    withSubagentChildEnv("1", () => {
      registerSessionSearch(pi);
      assert.equal(tools.has("session_search"), false);
      assert.equal(events.length, 0);
      return undefined;
    });
  });
});
