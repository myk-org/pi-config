/**
 * Session-search store and harvest tests (issue #915).
 * Run: npx tsx --test tests/node/orchestrator/session-search.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  indexSessionSummary,
  searchSessions,
  extractSessionSummaries,
} from "../../../extensions/orchestrator/session-search.js";

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
}

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
});
