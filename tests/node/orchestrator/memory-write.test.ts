/**
 * Unified memory write path tests (issue #915).
 * Run: npx tsx --test tests/node/orchestrator/memory-write.test.ts
 *
 * Covers: grant-phrase guardrail, contradiction gate (pinned and non-pinned),
 * scope metadata + expiry pruning, dedup reinforcement, and the preference
 * extractor's question/grant filters.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addMemoryEntry, pruneExpiredEntries } from "../../../extensions/orchestrator/memory-write.js";
import {
  entryHash,
  loadScores,
  saveScores,
  extractPreferences,
  isGrantText,
  isEntryActiveForSession,
  type ScoredEntry,
} from "../../../extensions/orchestrator/memory-scoring.js";
import { readAllTopicEntries } from "../../../extensions/orchestrator/memory-tree.js";

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-write-"));
}

function seedEntry(
  cwd: string,
  category: string,
  text: string,
  opts: { pinned?: boolean } = {},
): void {
  const topicFile: Record<string, string> = {
    preference: "preferences.md",
    lesson: "lessons.md",
    pattern: "patterns.md",
    decision: "decisions.md",
    done: "completions.md",
    mistake: "mistakes.md",
  };
  const topicsDir = path.join(cwd, ".pi", "memory", "topics");
  fs.mkdirSync(topicsDir, { recursive: true });
  const file = path.join(topicsDir, topicFile[category]!);
  const pin = opts.pinned ? " *(pinned)*" : "";
  fs.appendFileSync(file, `- [${category}] ${text}${pin}\n`);

  const hash = entryHash(`- [${category}] ${text}`);
  const entry: ScoredEntry = {
    class: category as any,
    score: opts.pinned ? 9999 : 1,
    evidenceCount: 1,
    cue: "explicit",
    firstSeen: new Date().toISOString(),
    lastReinforced: new Date().toISOString(),
    userState: opts.pinned ? "pinned" : "auto",
    lifecycle: "active",
  };
  const scores = loadScores(cwd);
  scores.entries[hash] = entry;
  saveScores(cwd, scores);
}

describe("addMemoryEntry — grant-phrase guardrail", () => {
  it("rejects one-off permission grant phrasing", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "You can merge this PR",
        category: "preference",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /one-off permission grant/i);
      // Nothing was written
      assert.equal(readAllTopicEntries(cwd).length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("allows grant-like text when explicitly session-scoped", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "For this task, temporary note with you can phrasing",
        category: "lesson",
        scope: "session",
      });
      assert.equal(result.status, "added");
      const scores = loadScores(cwd);
      const hash = entryHash(`- [lesson] For this task, temporary note with you can phrasing`);
      assert.ok(scores.entries[hash], "score entry created");
      assert.equal(scores.entries[hash]!.scope, "session");
      assert.ok(scores.entries[hash]!.expiresAt, "session scope gets expiry safety net");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("addMemoryEntry — contradiction gate", () => {
  it("refuses a permission flip against a pinned entry (the #915 incident)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "NEVER merge code PRs — user merges those", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Agent can merge code PRs",
        category: "preference",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
      assert.match(result.message, /NEVER merge code PRs/);
      // The pinned entry was not reinforced or modified
      assert.equal(readAllTopicEntries(cwd).length, 1);
      const scores = loadScores(cwd);
      const pinnedHash = entryHash("- [preference] NEVER merge code PRs — user merges those");
      assert.equal(scores.entries[pinnedHash]!.evidenceCount, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not clash a neutral entry with a mixed-polarity candidate (issue #915 live FP)", async () => {
    const cwd = makeCwd();
    try {
      // Pinned candidate mixes negation AND permission in its own text;
      // a topic-adjacent but neutral new entry must NOT be rejected.
      seedEntry(cwd, "preference", "Enforce via code, not rules — code can't be ignored, rules can", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Test entry for override flow verification — deploy via ad-hoc cp commands",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a permission flip against a non-pinned entry, offering the override path", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests with bare python — always use uv run");
      const result = await addMemoryEntry(cwd, {
        text: "It is fine to run tests with bare python",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
      assert.match(result.message, /overrideConflicts: true/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("supersedes the old entry when the user confirms via overrideConflicts", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests with bare python — always use uv run");
      const result = await addMemoryEntry(cwd, {
        text: "It is fine to run tests with bare python",
        category: "lesson",
        overrideConflicts: true,
      });
      assert.equal(result.status, "added");
      // Old entry gone, new entry present with supersession provenance
      const remaining = readAllTopicEntries(cwd).map((e) => e.text);
      assert.deepEqual(remaining, ["It is fine to run tests with bare python"]);
      const scores = loadScores(cwd);
      const newHash = entryHash("- [lesson] It is fine to run tests with bare python");
      assert.match(scores.entries[newHash]!.derivedFrom!, /supersedes/);
      assert.ok(!scores.entries[entryHash("- [lesson] Never run tests with bare python — always use uv run")]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("never supersedes a pinned entry, even with overrideConflicts", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "NEVER merge code PRs — user merges those", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Agent can merge code PRs",
        category: "preference",
        overrideConflicts: true,
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
      assert.equal(readAllTopicEntries(cwd).length, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not flag non-permission overlaps as conflicts", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never merge feature PRs — the user merges those");
      // Shares topic words but no permission flip — different rule entirely
      const result = await addMemoryEntry(cwd, {
        text: "After merging, switch back to main and pull",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("addMemoryEntry — dedup", () => {
  it("reinforces an exact duplicate instead of adding", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "Always show file paths in responses");
      const result = await addMemoryEntry(cwd, {
        text: "Always show file paths in responses",
        category: "preference",
      });
      assert.equal(result.status, "reinforced");
      // Exact matches may be caught by either the vector near-duplicate path
      // (similarity 1.000) or the exact-match path — both reinforce.
      assert.match(result.message, /reinforced instead/);
      const scores = loadScores(cwd);
      const hash = entryHash("- [preference] Always show file paths in responses");
      assert.equal(scores.entries[hash]!.evidenceCount, 2);
      assert.equal(readAllTopicEntries(cwd).length, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an invalid category", async () => {
    const cwd = makeCwd();
    try {
      const badCategory = await addMemoryEntry(cwd, { text: "x", category: "bogus" });
      assert.equal(badCategory.status, "rejected");
      assert.match(badCategory.message, /Invalid category/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a run_after action without a command", async () => {
    const cwd = makeCwd();
    try {
      const badAction = await addMemoryEntry(cwd, {
        text: "Run checks",
        category: "lesson",
        action: "run_after ",
      });
      assert.equal(badAction.status, "rejected");
      assert.equal(
        badAction.message,
        "Invalid action \"run_after \". run_after requires a command (e.g., 'run_after npm test')",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("pruneExpiredEntries", () => {
  it("prunes expired session-scoped entries from topics with their scores", () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Durable project lesson");
      seedEntry(cwd, "lesson", "Temporary session note", {});
      // Make the second entry session-scoped and expired
      const scores = loadScores(cwd);
      const tempHash = entryHash("- [lesson] Temporary session note");
      scores.entries[tempHash]!.scope = "session";
      scores.entries[tempHash]!.expiresAt = new Date(Date.now() - 1000).toISOString();
      saveScores(cwd, scores);

      const pruned = pruneExpiredEntries(cwd);
      assert.equal(pruned, 1);
      const remaining = readAllTopicEntries(cwd).map((e) => e.text);
      assert.deepEqual(remaining, ["Durable project lesson"]);
      const after = loadScores(cwd);
      assert.ok(after.entries[entryHash("- [lesson] Durable project lesson")]);
      assert.ok(!after.entries[tempHash]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("extractPreferences filters (issue #915)", () => {
  it("excludes questions", () => {
    const out = extractPreferences("Do I always need to run the full test suite before committing?");
    assert.equal(out.length, 0);
  });

  it("excludes one-off grants", () => {
    const out = extractPreferences("You can merge this PR since all checks passed");
    assert.equal(out.length, 0);
  });

  it("keeps genuine statements", () => {
    const out = extractPreferences("I prefer uv run for all Python commands");
    assert.equal(out.length, 1);
    assert.match(out[0]!, /I prefer uv run/);
  });

  it("keeps imperatives starting with a question verb (Qodo #21 PR #916)", () => {
    // "Do not use pip" was dropped by the old leading-verb question heuristic
    const out = extractPreferences("Do not use pip for installing dependencies, always use uv run");
    assert.equal(out.length, 1);
    assert.match(out[0]!, /Do not use pip/);
  });

  it("excludes questions that end without a question mark too", () => {
    const out = extractPreferences("Could you check whether the tests pass");
    assert.equal(out.length, 0);
  });

  it("isGrantText detects common grant phrasings", () => {
    assert.ok(isGrantText("You may push directly for this release"));
    assert.ok(isGrantText("Go ahead and skip the lint step"));
    assert.ok(!isGrantText("Always run lint before committing"));
  });
});

describe("addMemoryEntry — Qodo PR #916 hardening", () => {
  it("rejects marker-shaped text (id suffix) that would break hash binding", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Deploy via .dev scripts only {#deadbeef12345678}",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /markers/i);
      assert.equal(readAllTopicEntries(cwd).length, 0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects marker-shaped text containing *(pinned)*", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Deploy via .dev scripts only *(pinned)*",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /markers/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("cites the pinned entry when pinned entries conflict alongside non-pinned ones", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "NEVER merge code PRs — user merges those", { pinned: true });
      seedEntry(cwd, "lesson", "Never let the agent merge code PRs");
      const result = await addMemoryEntry(cwd, {
        text: "Agent can merge code PRs",
        category: "preference",
        overrideConflicts: true,
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
      // Pinned entry untouched either way
      const texts = readAllTopicEntries(cwd).map((e) => e.text);
      assert.ok(texts.includes("NEVER merge code PRs — user merges those"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("supersedes ALL conflicting entries on override, not only the best match", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests with bare python — always use uv run");
      seedEntry(cwd, "lesson", "Never allow bare python for running tests");
      const result = await addMemoryEntry(cwd, {
        text: "It is fine to run tests with bare python",
        category: "lesson",
        overrideConflicts: true,
      });
      assert.equal(result.status, "added");
      const remaining = readAllTopicEntries(cwd).map((e) => e.text);
      assert.deepEqual(remaining, ["It is fine to run tests with bare python"]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("gives task-scoped entries the same TTL safety net as session scope", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Workaround note kept until the refactor lands",
        category: "lesson",
        scope: "task",
      });
      assert.equal(result.status, "added");
      const scores = loadScores(cwd);
      const hash = entryHash("- [lesson] Workaround note kept until the refactor lands");
      assert.equal(scores.entries[hash]!.scope, "task");
      assert.ok(scores.entries[hash]!.expiresAt, "task-scoped entry must carry expiresAt");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("clears session scope + TTL when the entry is restated as durable", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Session note about flaky test ordering",
        category: "lesson",
        scope: "session",
        sourceSession: "sess-a",
      });
      assert.equal(result.status, "added");
      const hash = entryHash("- [lesson] Session note about flaky test ordering");
      assert.ok(loadScores(cwd).entries[hash]!.expiresAt);

      // Restate the SAME text without a scope — dedup reinforces and the
      // scope must be reconciled to durable (no scope, no TTL)
      const reinforced = await addMemoryEntry(cwd, {
        text: "Session note about flaky test ordering",
        category: "lesson",
      });
      assert.equal(reinforced.status, "reinforced");
      const entry = loadScores(cwd).entries[hash]!;
      assert.ok(!entry.scope, "scope must be cleared on durable restatement");
      assert.ok(!entry.expiresAt, "TTL must be cleared on durable restatement");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("isEntryActiveForSession — session/expiry eligibility (Qodo PR #916)", () => {
  it("excludes expired entries regardless of scope", () => {
    assert.equal(isEntryActiveForSession({ expiresAt: new Date(Date.now() - 1000).toISOString() } as any), false);
    assert.equal(isEntryActiveForSession({ expiresAt: new Date(Date.now() + 60000).toISOString() } as any), true);
  });

  it("session-scoped entries are active only in their own session", () => {
    const entry = { scope: "session", sourceSession: "sess-a" } as any;
    assert.equal(isEntryActiveForSession(entry, "sess-a"), true);
    assert.equal(isEntryActiveForSession(entry, "sess-b"), false);
    // Unknown current session → fail closed (transient by design)
    assert.equal(isEntryActiveForSession(entry, undefined), false);
  });

  it("durable entries without a score record stay visible", () => {
    assert.equal(isEntryActiveForSession(undefined, "sess-a"), true);
    assert.equal(isEntryActiveForSession({ scope: "project" } as any, "sess-a"), true);
  });
});

describe("sourceSessions — multi-session session-scoped entries (Qodo round 3, PR #916)", () => {
  it("keeps the entry active in the original session when another session restates it", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Session note about flaky test ordering",
        category: "lesson",
        scope: "session",
        sourceSession: "sess-a",
      });
      assert.equal(result.status, "added");
      const hash = entryHash("- [lesson] Session note about flaky test ordering");

      // Session B restates the same rule
      const restated = await addMemoryEntry(cwd, {
        text: "Session note about flaky test ordering",
        category: "lesson",
        scope: "session",
        sourceSession: "sess-b",
      });
      assert.equal(restated.status, "reinforced");

      const entry = loadScores(cwd).entries[hash]!;
      assert.equal(entry.sourceSession, "sess-a", "primary sourceSession must not be overwritten");
      assert.deepEqual(entry.sourceSessions, ["sess-a", "sess-b"], "restating session must be added");

      // Eligible in BOTH sessions
      assert.equal(isEntryActiveForSession(entry, "sess-a"), true);
      assert.equal(isEntryActiveForSession(entry, "sess-b"), true);
      assert.equal(isEntryActiveForSession(entry, "sess-c"), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
