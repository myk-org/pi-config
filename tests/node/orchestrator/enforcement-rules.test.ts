/**
 * Tests for enforcement-rules engine (trigger matching + action execution).
 * Run with: npx tsx --test tests/node/orchestrator/enforcement-rules.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  matchBashCommand,
  matchToolCall,
  executeAction,
  type EnforcedEntry,
} from "../../../extensions/orchestrator/enforcement-rules.ts";
import type { ScoredEntry } from "../../../extensions/orchestrator/memory-scoring.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Minimal ScoredEntry stub — only fields required by EnforcedEntry. */
function stubScoredEntry(
  trigger: string,
  action: "block" | "warn" | "run_after" = "warn",
): ScoredEntry {
  return {
    category: "lesson",
    evidence: 1,
    lastSeen: Date.now(),
    firstSeen: Date.now(),
    status: "active",
    trigger: trigger as any,
    action,
  } as ScoredEntry;
}

/** Build an EnforcedEntry with the given trigger/action. */
function makeEntry(
  trigger: string,
  action: "block" | "warn" | "run_after" = "warn",
  opts: { actionCommand?: string; verifier?: string } = {},
): EnforcedEntry {
  return {
    hash: `test-hash-${trigger}`,
    text: `Test rule: ${trigger}`,
    trigger: trigger as any,
    action,
    actionCommand: opts.actionCommand,
    verifier: opts.verifier,
    entry: stubScoredEntry(trigger, action),
  };
}

// ── matchBashCommand — bash_contains ───────────────────────────────────────

describe("matchBashCommand — bash_contains trigger", () => {
  const entry = makeEntry("bash_contains git add .");

  it("matches when command contains the needle", () => {
    const matches = matchBashCommand([entry], "git add . && git commit");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "git add .");
    assert.strictEqual(matches[0].rule, entry);
  });

  it("does not match when needle is absent", () => {
    const matches = matchBashCommand([entry], "git add src/file.py");
    assert.equal(matches.length, 0);
  });
});

// ── matchBashCommand — bash_regex ──────────────────────────────────────────

describe("matchBashCommand — bash_regex trigger", () => {
  const entry = makeEntry("bash_regex git\\s+add\\s+\\.");

  it("matches when regex pattern hits", () => {
    const matches = matchBashCommand([entry], "git  add  .");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "git  add  .");
  });

  it("does not match when regex pattern misses", () => {
    const matches = matchBashCommand([entry], "git add src/");
    assert.equal(matches.length, 0);
  });
});

// ── matchToolCall — tool_name ──────────────────────────────────────────────

describe("matchToolCall — tool_name trigger", () => {
  const entry = makeEntry("tool_name write");

  it("matches when tool name equals expected", () => {
    const matches = matchToolCall([entry], "write", { path: "foo.py" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "write");
  });

  it("does not match a different tool name", () => {
    const matches = matchToolCall([entry], "read", { path: "foo.py" });
    assert.equal(matches.length, 0);
  });
});

// ── matchToolCall — file_modified ──────────────────────────────────────────

describe("matchToolCall — file_modified trigger", () => {
  const entry = makeEntry("file_modified *.py");

  it("matches when written file has matching extension", () => {
    const matches = matchToolCall([entry], "write", { path: "src/main.py" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "src/main.py");
  });

  it("does not match a different file extension", () => {
    const matches = matchToolCall([entry], "write", { path: "src/main.ts" });
    assert.equal(matches.length, 0);
  });
});

// ── matchToolCall — bash trigger via bash tool ─────────────────────────────

describe("matchToolCall — bash trigger via bash tool", () => {
  const entry = makeEntry("bash_contains rm -rf");

  it("matches bash_contains trigger when tool is bash", () => {
    const matches = matchToolCall([entry], "bash", {
      command: "rm -rf /tmp/foo",
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matched, "rm -rf");
  });
});

// ── matchToolCall — no matches ─────────────────────────────────────────────

describe("matchToolCall — no matches returns empty", () => {
  const entries = [
    makeEntry("tool_name write"),
    makeEntry("bash_contains sudo"),
    makeEntry("file_modified *.go"),
  ];

  it("returns empty array when nothing matches", () => {
    const matches = matchToolCall(entries, "read", { path: "src/main.ts" });
    assert.equal(matches.length, 0);
  });
});

// ── executeAction ──────────────────────────────────────────────────────────

describe("executeAction — successful command", () => {
  it("returns success=true and captures output", () => {
    const result = executeAction("echo hello", "/tmp");
    assert.equal(result.success, true);
    assert.ok(result.output.includes("hello"));
  });
});

describe("executeAction — failing command", () => {
  it("returns success=false for a failing command", () => {
    const result = executeAction("false", "/tmp");
    assert.equal(result.success, false);
  });
});
