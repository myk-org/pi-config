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

  it("refuses a permission flip against a non-pinned entry and points at memory_edit", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests with bare python — always use uv run");
      const result = await addMemoryEntry(cwd, {
        text: "It is fine to run tests with bare python",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
      assert.match(result.message, /memory_edit/);
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

  it("validates category and action", async () => {
    const cwd = makeCwd();
    try {
      const badCategory = await addMemoryEntry(cwd, { text: "x", category: "bogus" });
      assert.equal(badCategory.status, "rejected");
      assert.match(badCategory.message, /Invalid category/);

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
  it("removes expired session-scoped entries from topics and scores", () => {
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

  it("isGrantText detects common grant phrasings", () => {
    assert.ok(isGrantText("You may push directly for this release"));
    assert.ok(isGrantText("Go ahead and skip the lint step"));
    assert.ok(!isGrantText("Always run lint before committing"));
  });
});
