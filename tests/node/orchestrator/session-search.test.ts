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

  it("deduplicates identical summaries and caps at 500 entries", () => {
    const cwd = makeCwd();
    try {
      const summary = "Repeated identical summary about caching behavior in the provider layer";
      indexSessionSummary(cwd, "sess-1", summary);
      indexSessionSummary(cwd, "sess-1", summary);
      assert.equal(searchSessions(cwd, "caching", 10).length, 1);

      for (let i = 0; i < 510; i++) {
        indexSessionSummary(cwd, `sess-${i}`, `Unique summary number ${i} about topic alpha`);
      }
      // All entries are searchable but capped
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
      // JSONL store now exists
      assert.ok(fs.existsSync(path.join(dataDir, "session-search.jsonl")));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("extractSessionSummaries (pi session file harvest)", () => {
  it("extracts compaction and branch summaries, skipping short and corrupt lines", () => {
    const dir = makeCwd();
    try {
      const file = path.join(dir, "session.jsonl");
      const lines = [
        JSON.stringify({ type: "message", role: "user", content: "hello" }),
        JSON.stringify({ type: "compaction", summary: "The user worked on the memory system hardening pass and reviewed the conflict gate design in detail.", firstKeptEntryId: "abc" }),
        "{corrupt json line",
        JSON.stringify({ type: "branch_summary", summary: "Explored an alternative approach using vector-only conflict detection before returning to polarity heuristics." }),
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
  it("finds a recent uncompacted/unclosed session via PI_CODING_AGENT_DIR slug resolution", () => {
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

      // No .pi/data/session-search.jsonl exists yet (neither compacted nor shut down)
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

  it("handles abnormally terminated sessions with truncated last lines and missing trailing newlines", () => {
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

  it("uses mtime caching on repeated queries and incremental byte-offset reads on appends", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-cache-");
    try {
      const sid = "active-incremental-01";
      const file = path.join(sessionsDir, `2026-11-21T10-00-00-000Z_${sid}.jsonl`);
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-21T10:00:00.000Z", cwd },
          makeUserMsg("Initial discussion about sqlite WAL checkpoint tuning", "2026-11-21T10:01:00.000Z"),
        ]),
      );

      // 1st query: full scan
      const first = searchSessions(cwd, "sqlite checkpoint", 5, { sessionsDir });
      assert.equal(first.length, 1);
      assert.deepEqual(getSessionScanStats(), { cacheHits: 0, fullScans: 1, incrementalScans: 0 });

      // 2nd query on unchanged file: cache hit (zero re-parse)
      const second = searchSessions(cwd, "sqlite checkpoint", 5, { sessionsDir });
      assert.equal(second.length, 1);
      assert.deepEqual(getSessionScanStats(), { cacheHits: 1, fullScans: 1, incrementalScans: 0 });

      // Append a new user message to the active file: incremental scan only
      fs.appendFileSync(
        file,
        JSON.stringify(
          makeUserMsg("Now debugging prometheus scrape timeout in sidecar", "2026-11-21T10:05:00.000Z"),
        ) + "\n",
      );
      const third = searchSessions(cwd, "prometheus scrape", 5, { sessionsDir });
      assert.equal(third.length, 1);
      assert.equal(third[0]!.sessionId, sid);
      assert.deepEqual(getSessionScanStats(), { cacheHits: 1, fullScans: 1, incrementalScans: 1 });

      // Rewrite/truncate file: falls back to full scan
      fs.writeFileSync(
        file,
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-21T10:00:00.000Z", cwd },
          makeUserMsg("Rewritten content focusing on graphql schema federation", "2026-11-21T10:10:00.000Z"),
        ]),
      );
      const fourth = searchSessions(cwd, "graphql federation", 5, { sessionsDir });
      assert.equal(fourth.length, 1);
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
        "\n" + JSON.stringify(makeUserMsg("Follow-up on bloom filter false positive rate", "2026-11-21T11:02:00.000Z")) + "\n",
      );

      const firstTopic = searchSessions(cwd, "radix trie", 5, { sessionsDir });
      const secondTopic = searchSessions(cwd, "bloom filter", 5, { sessionsDir });
      assert.equal(firstTopic.length, 1);
      assert.equal(secondTopic.length, 1);
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

      // Before compaction: discovered via raw JSONL scan
      const liveHits = searchSessions(cwd, "canary rollout", 5, { sessionsDir });
      assert.equal(liveHits.length, 1);
      assert.equal(liveHits[0]!.sessionId, sid);

      // Compaction/shutdown summary later recorded to store
      const realSummary = "Completed canary rollout metrics implementation and added Prometheus alert rules for latency spikes.";
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
      // Store already has the Day 1 compaction summary (older than Day 2 mtime)
      const dataDir = path.join(cwd, ".pi", "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, "session-search.jsonl"),
        JSON.stringify({
          entries: [{ sessionId: sid, timestamp: "2026-11-20T12:00:05.000Z", summary: compactionSummary }],
        }) + "\n",
      );

      // Day 1 compaction summary is found once (deduplicated)
      const day1 = searchSessions(cwd, "OAuth PKCE", 5, { sessionsDir });
      assert.equal(day1.length, 1);
      assert.equal(day1[0]!.sessionId, sid);

      // Pre-compaction raw message was superseded by compaction boundary
      assert.equal(searchSessions(cwd, "legacy-widget", 5, { sessionsDir }).length, 0);

      // Day 2 uncompacted turn after compaction IS searchable
      const day2 = searchSessions(cwd, "websocket reconnection jitter", 5, { sessionsDir });
      assert.equal(day2.length, 1);
      assert.equal(day2[0]!.sessionId, sid);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it("redacts secrets, filters command/system noise, and skips async subagent sessions", () => {
    const cwd = makeCwd();
    const sessionsDir = makeTempDir("sessions-sanitize-");
    try {
      const fakeOpenAiKey = "sk-proj-" + "x".repeat(30);
      const fakeAuthHeader = "Authorization: Bearer " + "b".repeat(32);
      const fakeUrl = ["https://alice", "supersecretpass@registry.example.com/pkg"].join(":");

      // Direct redactSecrets unit assertions
      const redacted = redactSecrets(`${fakeOpenAiKey} ${fakeAuthHeader} ${fakeUrl} api_key=my_secret_value_12345`);
      assert.ok(!redacted.includes(fakeOpenAiKey));
      assert.ok(!redacted.includes("b".repeat(32)));
      assert.ok(!redacted.includes("supersecretpass"));
      assert.ok(!redacted.includes("my_secret_value_12345"));

      // Main user session containing secrets + noise + real message
      const sid = "clean-session-77";
      fs.writeFileSync(
        path.join(sessionsDir, `2026-11-22T10-00-00-000Z_${sid}.jsonl`),
        makeSessionJsonl([
          { type: "session", version: 3, id: sid, timestamp: "2026-11-22T10:00:00.000Z", cwd },
          makeUserMsg("/compact focus on memory", "2026-11-22T10:01:00.000Z"),
          makeUserMsg("[IMPORTANT: internal system notice about specialtoken]", "2026-11-22T10:02:00.000Z"),
          makeUserMsg("📡 Connected to coms · You are peer-1", "2026-11-22T10:02:30.000Z"),
          makeUserMsg(
            `📡 Peer joined: wt-1 [2026-11-22T10:03:00Z]\nDeploying webhook proxy with ${fakeOpenAiKey} and ${fakeUrl}`,
            "2026-11-22T10:03:00.000Z",
          ),
        ]),
      );

      // Async subagent session that must be skipped
      fs.writeFileSync(
        path.join(sessionsDir, "2026-11-22T10-05-00-000Z_async-code-reviewer-quality-abc123.jsonl"),
        makeSessionJsonl([
          { type: "session", version: 3, id: "async-code-reviewer-quality-abc123", timestamp: "2026-11-22T10:05:00.000Z", cwd },
          makeUserMsg("Reviewing subagent-only-keyword diff in isolation", "2026-11-22T10:05:01.000Z"),
        ]),
      );

      // Slash command & system notice filtered out
      assert.equal(searchSessions(cwd, "compact focus", 5, { sessionsDir }).length, 0);
      assert.equal(searchSessions(cwd, "specialtoken", 5, { sessionsDir }).length, 0);
      // Async subagent session skipped
      assert.equal(searchSessions(cwd, "subagent-only-keyword", 5, { sessionsDir }).length, 0);

      // Real prompt found with secrets stripped
      const hits = searchSessions(cwd, "webhook proxy", 5, { sessionsDir });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.sessionId, sid);
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
  it("registers session_search tool and hooks when PI_SUBAGENT_CHILD is unset", async () => {
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

    let sessionSearchTool: any;
    withSubagentChildEnv(undefined, () => {
      registerSessionSearch(pi);
      sessionSearchTool = tools.get("session_search");
      assert.ok(sessionSearchTool, "session_search tool must be registered in parent orchestrator");
      return undefined;
    });

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

      // Exercise input + session_shutdown fallback with secret redaction
      const startFn = handlers.get("session_start")?.[0];
      const inputFn = handlers.get("input")?.[0];
      const shutdownFn = handlers.get("session_shutdown")?.[0];
      assert.ok(startFn && inputFn && shutdownFn);

      const liveSid = "shutdown-fallback-session";
      const fakeKey = "sk-ant-" + "z".repeat(28);
      startFn({}, { cwd, sessionManager: { getSessionId: () => liveSid, getSessionFile: () => "" } });
      inputFn({ text: `Configuring telemetry exporter with key ${fakeKey}` }, { cwd });
      shutdownFn({}, { cwd });

      const shutdownHits = searchSessions(cwd, "telemetry exporter", 5, { sessionsDir });
      assert.equal(shutdownHits.length, 1);
      assert.equal(shutdownHits[0]!.sessionId, liveSid);
      assert.ok(!shutdownHits[0]!.snippet.includes(fakeKey));
      assert.match(shutdownHits[0]!.snippet, /\[REDACTED\]/);

      // Exercise session_compact (skip willRetry, index real summary)
      const compactFn = handlers.get("session_compact")?.[0];
      assert.ok(compactFn);
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

      compactFn(
        {
          willRetry: false,
          compactionEntry: {
            summary: "Real compaction summary documenting circuit-breaker-backoff strategy across upstream gateways.",
          },
        },
        { cwd },
      );
      const compactHits = searchSessions(cwd, "circuit-breaker-backoff", 5, { sessionsDir });
      assert.equal(compactHits.length, 1);
      assert.equal(compactHits[0]!.sessionId, liveSid);
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(agentDir, { recursive: true, force: true });
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
