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
import { loadEnforcedEntries } from "../../../extensions/orchestrator/enforcement-rules.js";

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-write-"));
}

function seedEntry(
  cwd: string,
  category: string,
  text: string,
  opts: { pinned?: boolean; trigger?: string; action?: string } = {},
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
    ...(opts.trigger ? { trigger: opts.trigger as any } : {}),
    ...(opts.action ? { action: opts.action as any } : {}),
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

  it("refuses an always/never flip — the canonical phrasing (live battery, round 7)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Always use widget-alpha for probe runs");
      const result = await addMemoryEntry(cwd, {
        text: "Never use widget-alpha for probe runs",
        category: "lesson",
      });
      // Without "always" in PERMIT_RE this slipped past the gate into the
      // near-duplicate path, which silently REINFORCED the opposite rule.
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
      assert.match(result.message, /overrideConflicts: true/);
      assert.equal(readAllTopicEntries(cwd).length, 1);
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

describe("conflict gate — \"only\" is not a permission marker (Qodo round 8, PR #916)", () => {
  it("does not reject an unrelated \"only\"-qualified restriction as a conflict", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use git add . — stage files explicitly");
      const result = await addMemoryEntry(cwd, {
        text: "Only stage files after tests pass",
        category: "lesson",
      });
      // Both restrictions coexist; \"only\" is a qualifier, not a permit.
      assert.equal(result.status, "added");
      assert.equal(readAllTopicEntries(cwd).length, 2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("conflict gate — verb-qualified \"use only X\" (Qodo round 9, PR #916)", () => {
  it("refuses 'use only X' against a pinned prohibition of X (embeddings-independent overlap path)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use uv to install dependencies", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Use only uv to install dependencies",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
      assert.equal(readAllTopicEntries(cwd).length, 1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses the flip when the only-permission is stored first", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Use only uv to install dependencies");
      const result = await addMemoryEntry(cwd, {
        text: "Never use uv to install dependencies",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("still does not flag sentence-initial 'only' restrictions (round 8 regression)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use git add . — stage files explicitly");
      const result = await addMemoryEntry(cwd, {
        text: "Only stage files after tests pass",
        category: "lesson",
      });
      assert.equal(result.status, "added");
      assert.equal(readAllTopicEntries(cwd).length, 2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("conflict gate — temporal \"only\" continuations (Qodo round 10, PR #916)", () => {
  it("lets a temporal restriction coexist with a compatible prohibition", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run migrations until tests pass");
      const result = await addMemoryEntry(cwd, {
        text: "Run only after tests pass",
        category: "lesson",
      });
      // Same rule restated — both restrict WHEN, neither permits the action.
      assert.equal(result.status, "added");
      assert.equal(readAllTopicEntries(cwd).length, 2);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("still refuses a genuine 'use only X' against a prohibition (round 9 regression)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use uv to install dependencies", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Use only uv to install dependencies",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("conflict gate — formatted tool names in \"use only X\" (Qodo round 11, PR #916)", () => {
  it("refuses a Markdown code-span tool against a pinned prohibition", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use uv to install dependencies", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Use only `uv` to install dependencies",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses the flip when the formatted only-permission is stored first", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Use only **uv** to install dependencies");
      const result = await addMemoryEntry(cwd, {
        text: "Never use uv to install dependencies",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("conflict gate — clause-scoped polarity, quoted spans, trigger warnings (#936)", () => {
  it("complementary entries: pinned how-to vs scheduling rule are BOTH storable (the #936 incident)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(
        cwd,
        "lesson",
        "Sidecar provider test: POST /sessions then POST /sessions/{id}/prompt with 'say OK' — test vertex-claude, acpx-cursor, gemini",
        { pinned: true },
      );
      const result = await addMemoryEntry(cwd, {
        text: "Live verification of rootcoz features is USER-SCHEDULED — never self-start it; #329 transcripts verify only after pi-config#935 ships",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("complementary entries: enforced scheduling rule stays storable next to a pinned how-to (Qodo c8368767)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(
        cwd,
        "lesson",
        "Sidecar provider test: POST /sessions then POST /sessions/{id}/prompt with 'say OK' — test vertex-claude, acpx-cursor, gemini",
        { pinned: true },
      );
      const result = await addMemoryEntry(cwd, {
        text: "Live verification of rootcoz features is USER-SCHEDULED — never self-start it; #329 transcripts verify only after pi-config#935 ships",
        category: "lesson",
        trigger: "tool_name subagent",
        action: "warn",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("complementary entries: conditional prohibition vs unconditional mandate on the same verb, different objects", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(
        cwd,
        "preference",
        "After /release in pi-config: ALWAYS publish to npm @myk-org/pi-sidecar AND @myk-org/pi-vertex-claude, and to PyPI pi-sidecar-client",
        { pinned: true },
      );
      const result = await addMemoryEntry(cwd, {
        text: "release-publish: verify npm auth (npm whoami) BEFORE publish; on 401 ask user to re-login — never publish with a dead token",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("quoted payloads are not permission markers — 'say OK' in a pinned procedure never clashes", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "pattern", "Health check: reply 'OK' when asked — never reply with prose", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Health check replies are always logged",
        category: "pattern",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("genuine conflict still detected when the polarized clauses share the action", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(
        cwd,
        "preference",
        "After /release in pi-config: ALWAYS publish to npm AND to PyPI pi-sidecar-client",
        { pinned: true },
      );
      const result = await addMemoryEntry(cwd, {
        text: "Releases: never publish to PyPI — the pipeline owns PyPI",
        category: "preference",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("tool_name trigger naming a shell command warns instead of silently never firing", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Live-verify endpoints with curl into the dev container only",
        category: "lesson",
        trigger: "tool_name curl",
        action: "block",
      });
      assert.equal(result.status, "added", `stored with advisory warning: ${result.message}`);
      assert.match(result.message, /tool_name curl"? names a shell command/i);
      assert.match(result.message, /bash_contains/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("tool_name bash with block warns as over-broad", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Bash usage is restricted on this project",
        category: "lesson",
        trigger: "tool_name bash",
        action: "block",
      });
      assert.equal(result.status, "added");
      assert.match(result.message, /EVERY bash call/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("narrow, valid tool_name triggers add without a warning", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Generate images only on explicit request",
        category: "preference",
        trigger: "tool_name generate_image",
        action: "warn",
      });
      assert.equal(result.status, "added");
      assert.doesNotMatch(result.message, /warning:/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("quoted tool names still count as action objects — 'uv' conflicts detected (Qodo 0f0ad673)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use 'uv' to install dependencies", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use 'uv' to install dependencies",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("contractions are not quote delimiters — Don't/don't prohibitions survive (Qodo 67def191)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "Don't run npm; don't run pip", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run npm; always run pip",
        category: "preference",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("restating a compound rule reinforces instead of rejecting (Qodo f464da16)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "Never publish npm packages; always publish PyPI packages", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Never publish npm packages; always publish PyPI packages",
        category: "preference",
      });
      assert.equal(result.status, "reinforced", `restatement must reinforce: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("swapped compound rules still conflict — alignment guard is not a bypass", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "Never publish npm packages; always publish PyPI packages", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Never publish PyPI packages; always publish npm packages",
        category: "preference",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reinforced entries surface the trigger warning too (Qodo 4a6dd686)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Live-verify endpoints into the dev container only");
      const result = await addMemoryEntry(cwd, {
        text: "Live-verify endpoints into the dev container only",
        category: "lesson",
        trigger: "tool_name curl",
        action: "block",
      });
      assert.equal(result.status, "reinforced");
      assert.match(result.message, /names a shell command/i);
      assert.match(result.message, /bash_contains/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("separators inside quoted payloads neither split clauses nor permit (Qodo 652e15cd)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "pattern", "Reply 'ok; sure' to confirm — never reply with prose", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Confirmations are always silent",
        category: "pattern",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("quoted payloads containing contractions are not prohibitions (Qodo 874f0adc)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "pattern", "Execute 'don't use npm' for fixture setup", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use npm for installs",
        category: "pattern",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("tool_name python warns — interpreter commands run inside bash (Qodo 32aba1c4)", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Fixture setup runs python scripts only",
        category: "lesson",
        trigger: "tool_name python",
        action: "warn",
      });
      assert.equal(result.status, "added");
      assert.match(result.message, /names a shell command/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("single-word actions still clash across polarity (Qodo 8f4191ef)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy; keep audit logs", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy; keep audit logs",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("colons do not detach the object from a polarized action (Qodo 0ae964c1)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never publish: npm packages; always publish: PyPI packages", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always publish npm packages",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("broad permissions do not align with narrower ones (Qodo 8ec45667)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never publish PyPI packages; always publish packages", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Never publish PyPI packages; always publish npm packages",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("tool_name bash warns for ANY action, not just block (Qodo b2f6f0e6)", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Run tests inside bash only",
        category: "lesson",
        trigger: "tool_name bash",
        action: "warn",
      });
      assert.equal(result.status, "added");
      assert.match(result.message, /EVERY bash call/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("whitespace-padded tool_name triggers are canonicalized, not dead (Qodo dfbdbf1c)", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Run linters inside bash only",
        category: "lesson",
        trigger: "tool_name  bash ",
        action: "warn",
      });
      assert.equal(result.status, "added");
      // Verify through the enforcement loader — the consumer of the stored
      // trigger — not the score-file internals (Qodo 309f268e).
      const enforced = loadEnforcedEntries(cwd);
      const entry = enforced.find((e) => e.trigger === "tool_name bash");
      assert.ok(entry, "canonical trigger must load for enforcement");
      assert.equal(entry!.action, "warn");
      assert.match(result.message, /EVERY bash call/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("curly-quoted payloads are masked too (Qodo 9c430f3d)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "pattern", "say “OK” to inspect health checks; never emit prose", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Never log health checks",
        category: "pattern",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("curly-quoted contractions inside payloads stay content (Qodo 9c430f3d)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "pattern", "Execute ‘don’t use npm’ for fixture setup", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use npm for installs",
        category: "pattern",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("‘may not’ clauses are prohibitions, so restatements reinforce (Qodo e788f4b2)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "You may not merge PRs without review", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Never merge PRs without review",
        category: "lesson",
      });
      assert.notEqual(result.status, "rejected", `must not be rejected: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("possessives after accented letters do not open quote spans (Qodo ad3da7c8)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Beyoncé's rule: never publish secrets", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always publish secrets",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("quoted examples inside a prohibition are not its action (Qodo c92087ed)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never inspect logs containing 'use npm'", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use npm for installs",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("quoted tool names distinguish restatements from swaps (Qodo 92151894)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use 'uv' to install dependencies; always use 'npm' to install dependencies", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Never use 'npm' to install dependencies; always use 'uv' to install dependencies",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("different deployment targets are complementary (Qodo 6d0214c7)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy production builds", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy staging builds",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("dash parentheticals do not detach the polarity marker (Qodo 9e179121)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "NEVER — under any circumstances — push to main", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always push to main",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("an unclosed quote does not mask the rest of the rule (Qodo c23b9d86)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Wait 'til tests pass; never skip tests", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always skip tests",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("coordinated rules split when the tail leads with a polarity marker (Qodo 1ad018b0)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use npm and always run tests", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Never run tests",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("different quoted tools are complementary (Qodo 4fe7b1c3)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use 'npm' to install dependencies", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use 'uv' to install dependencies",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("two stray apostrophes do not crash the write (Qodo b0c6383f)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Logs 'til 'noon are noisy; never trust them", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always trust them",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("dash-separated instructions stay separate clauses (Qodo 20adf2da)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy staging — document release — always deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("tool_name without an action warns it will never fire (Qodo 792c27a3)", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Bash calls are the only tool allowed here",
        category: "lesson",
        trigger: "tool_name bash",
      });
      assert.equal(result.status, "added");
      assert.match(result.message, /has no action — it will never fire/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("capitalized However still splits clauses (Qodo eb263200)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never push to main. However, you can push to feature branches.", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always push to feature branches",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reworded verbs still match their pinned prohibition (Qodo adbd3504)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never push to main", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Pushing to main is okay",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("quoted examples in a permission are not its action (Qodo 29a4da4e)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy to production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: 'Always document the phrase "deploy to production" in the runbook',
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("object lists stay inside the prohibiting clause (Qodo 438cc007)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never publish npm and PyPI packages and always update docs", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always publish PyPI packages",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("singular with plural objects converge under stemming (Qodo 833b46be)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never delete packages", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always delete package",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("demonstratives stay stop words after stemming (Qodo 72013bb5)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never push these branches", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always push these tags",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("short opposing rules with a single action word still clash (Qodo 2c16ab75)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("clippings of the same target still clash (Qodo d44e182b)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy app to production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy application to production",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("different services are distinct targets, not variants (Qodo 5a346f0f)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use git for local pushes", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use github for local pushes",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("abbreviated examples stay inside the prohibiting clause (Qodo ab8d2a82)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run destructive commands, e.g. rm -rf /", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run rm -rf on stale build dirs",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("leading-condition prohibitions are exceptions, not bans (live battery #936)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(
        cwd,
        "preference",
        "After /release in pi-config: ALWAYS publish to npm @myk-org/pi-sidecar AND @myk-org/pi-vertex-claude, and to PyPI pi-sidecar-client",
        { pinned: true },
      );
      const result = await addMemoryEntry(cwd, {
        text: "When npm whoami fails with E401 during a release, never continue publishing — stop and ask the user to re-login",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("same-condition flips still clash under condition scoping (live battery #936)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When it is Friday, never deploy", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy on Fridays",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a condition-scoped prohibition coexists with an unconditional mandate (live battery #936)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When it is Friday, never deploy", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("prepositional subjects are not conditions (Qodo 4da6e3e5)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Agents on this repo must never push to main", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always push to main",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("'not only ... but also' is an affirmative grant, not a negation (Qodo 4b669927)", async () => {
    const { isGrantText } = await import("../../../extensions/orchestrator/memory-scoring.js");
    assert.equal(
      isGrantText("You may not only merge today, but also approve it"),
      true,
      "correlative 'not only' is affirmative",
    );
    assert.equal(isGrantText("you may not merge without review"), false, "plain negation stays a prohibition");
  });

  it("the retry cap restores, not masks, the trailing text (Qodo bc5a3517)", async () => {
    const { quotedMask } = await import("../../../extensions/orchestrator/memory-write.js");
    const flood = "never deploy production " + "' ".repeat(1100);
    const masked = quotedMask(flood);
    assert.equal(masked.length, flood.length, "same-length mask preserved");
    assert.match(masked, /never deploy production/, "prohibition before the flood stays visible");
    const flood2 = "' ".repeat(1100) + "never deploy production";
    const masked2 = quotedMask(flood2);
    assert.equal(masked2.length, flood2.length, "same-length mask preserved");
    assert.match(masked2, /never deploy production/, "prohibition after the flood stays visible at cap");
  });

  it("action-before-copula permissions are not conditions (live battery #936)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never push to main", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Pushing to main is okay",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("negated 'you may not' phrasing is a prohibition, not a grant (live battery #936)", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "You may not merge PRs without review",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("'you cannot' is a prohibition, not a grant (Qodo 3a4b6c2d)", async () => {
    const { isGrantText } = await import("../../../extensions/orchestrator/memory-scoring.js");
    assert.equal(isGrantText("You cannot push to main"), false);
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "You cannot push to main",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("negated grant forms stay prohibitions (Qodo 3a4b6c2d)", async () => {
    const { isGrantText } = await import("../../../extensions/orchestrator/memory-scoring.js");
    assert.equal(isGrantText("you can't push"), false);
    assert.equal(isGrantText("you may not push"), false);
  });

  it("word-stem collisions are not grants (Qodo 3a4b6c2d)", async () => {
    const { isGrantText } = await import("../../../extensions/orchestrator/memory-scoring.js");
    assert.equal(isGrantText("you mayor of the city decides"), false);
    assert.equal(isGrantText("you candidly admit it"), false);
  });

  it("plain grants are still detected (Qodo 3a4b6c2d)", async () => {
    const { isGrantText } = await import("../../../extensions/orchestrator/memory-scoring.js");
    assert.equal(isGrantText("you can merge this PR"), true);
    assert.equal(isGrantText("you may push now"), true);
  });

  it("stem over-merges do not manufacture conflicts (Qodo 2fb4dd7e)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never store bases", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always store bass",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reworded same-condition permissions still clash (Qodo 6b17d4ae)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When deploying service to production, never use npm", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use npm when deploying to production",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("astral-plane possessives do not open quote spans (Qodo 2fb3b831)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "𝒜's rule: Never deploy prod's artifact", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy prod's artifact",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("unless-led bans reject unconditioned opposites as general rules (Qodo 7c839ae6)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Unless the user says otherwise, never push to main", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always push to main",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("unless-led bans coexist with permissions carrying the escape (Qodo 7c839ae6)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Unless the user says otherwise, never push to main", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "When the user says otherwise, always push to main",
        category: "lesson",
      });
      assert.notEqual(result.status, "rejected", `must not be rejected: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("subordinator-initial idioms are discourse, not conditions (Qodo 7c839ae6)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Once again, never push to main", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always push to main",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reinforcing with an action warns from the merged trigger (Qodo 0c10e5eb)", async () => {
    const cwd = makeCwd();
    try {
      const first = await addMemoryEntry(cwd, {
        text: "bash needs enforcement",
        category: "lesson",
        trigger: "tool_name bash",
      });
      assert.equal(first.status, "added");
      const second = await addMemoryEntry(cwd, {
        text: "bash needs enforcement",
        category: "lesson",
        action: "block",
      });
      assert.match(second.message ?? "", /EVERY bash call/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("decomposed accented possessives do not open quote spans (Qodo 1ec72614)", async () => {
    const cwd = makeCwd();
    try {
      const nfd = "Cafe\u0301's rule: Never deploy production";
      seedEntry(cwd, "lesson", nfd, { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("'only' inside a condition does not cut it short (Qodo d689acbf)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When only the release branch is ready, never deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("multi-letter abbreviation periods do not split clauses (Qodo d6fa46c0)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run rm, mv, etc. on shared hosts", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run rm on shared hosts",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("-ing forms of ll/ss/ff/zz verbs match their base (Qodo 59932c0a)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never install globally", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Installing globally is fine",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a quote after two backslashes is a real delimiter (Qodo 9468b527)", async () => {
    const { quotedMask } = await import("../../../extensions/orchestrator/memory-write.js");
    const even = 'say \\\\"ok; sure\\\\" now';
    const maskedEven = quotedMask(even);
    assert.doesNotMatch(maskedEven, /ok; sure/, "even-backslash quote delimits and masks the payload");
    const odd = 'say \\"ok; sure\\" now';
    const maskedOdd = quotedMask(odd);
    assert.match(maskedOdd, /ok; sure/, "odd-backslash quote stays escaped content");
  });

  it("a blank tool_name trigger is rejected, not stored dead (Qodo ccce07dd)", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "blank tool trigger test",
        category: "lesson",
        trigger: "tool_name   ",
        action: "block",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /names no tool/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("k8s with kubernetes converge after expansion (Qodo 7ed1ea1e)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy to k8s", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy to kubernetes",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("universal qualifiers are not distinct targets (Qodo 02dfd684)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy production builds", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy all builds",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("quoted subordinators do not scope a prohibition (Qodo d87c13dd)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", 'Publish "when battery" logs, never publish packages', { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always publish packages",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("plural clippings match their singular expansion — repos (Qodo 9253c632)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never delete repos", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always delete repo",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("plural clippings match their singular expansion — docs (Qodo 9253c632)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never edit docs", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always edit documentation",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("'no longer' is a withdrawal, not a grant (Qodo 77fc2333)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "You can no longer force-push to main", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always force-push to main",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("curly-apostrophe ’t contraction is a negation (Qodo 375ff320)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "You can’t deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("curly-apostrophe Don’t is a negation (Qodo 375ff320)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Don’t push to main", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always push to main",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("line-wrapped markers keep their action (Qodo 35f32790)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Always publish npm packages", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Never\npublish npm packages",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stranded markers govern what follows (Qodo 7ab4f675)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy PyPI packages", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always check logs; always; deploy PyPI packages",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("multi-word distinct targets coexist (Qodo 46dd1ccb)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy production builds", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy staging environment builds",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("-ss base verbs match their inflected forms (Qodo f6030e64)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never pass tokens", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Passing tokens is fine",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("contrastive conditions are complements, not matches (Qodo 6949694b)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When outage, never deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production outside outage",
        category: "lesson",
      });
      // The pair coexists — the near-duplicate path may also fold it into
      // the existing entry as a reinforcement, which is equally correct.
      assert.notEqual(result.status, "rejected");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a scoped universal qualifier stays a distinct target (Qodo be992ad0)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy all staging builds", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production builds",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("y/i plurals converge with their singular (Qodo f5cdc461)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never delete entries; preserve audit logs", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always delete entry; preserve audit logs",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("short silent-e verbs match their inflected forms (Qodo d14f222c)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use npm", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Using npm is fine",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
      seedEntry(cwd, "lesson", "Never move fast", { pinned: true });
      const second = await addMemoryEntry(cwd, {
        text: "Moving fast is fine",
        category: "lesson",
      });
      assert.equal(second.status, "rejected");
      assert.match(second.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("subordinators are not condition content (Qodo 6566bcde)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "If on main, never force push", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always force push when on main",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("if-in-doubt bans are general bans (Qodo 04532d72)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "If in doubt, never push to main", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always push to main",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a period after a closing quote still splits sentences (Qodo 93525434)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: 'Always deploy "production". Never deploy staging',
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a negated antecedent is condition content, not the marker (Qodo 5c14da70)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When no builds are ready, never deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production",
        category: "lesson",
      });
      assert.notEqual(result.status, "rejected");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("regardless-of wording does not escape a scoped ban (Qodo e4a581cf)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "During an outage, never deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production regardless of outage",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a contrastive marker must govern the shared condition (Qodo ae4d616b)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When outage occurs, never deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production when outage occurs, except staging",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("plurals of -ing nouns match their singular (Qodo 038f14f5)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never commit settings", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always commit setting",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("hyphenated targets tokenize like their spaced forms (Qodo 5ed24d35)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy npm-package; preserve audit logs", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy npm package; preserve audit logs",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("trailing objects of a shared verb are distinct targets (Qodo 45fea51b)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(
        cwd,
        "lesson",
        "When battery is low, never publish npm; when battery is charged, always publish PyPI",
        { pinned: true },
      );
      const result = await addMemoryEntry(cwd, {
        text: "When battery is low, always publish PyPI; when battery is charged, never publish npm",
        category: "lesson",
      });
      assert.notEqual(result.status, "rejected", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a negated coordination keeps its second half (Qodo b9c0d215)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never disable branch protection or permit force pushes", { pinned: true });
      const opposite = await addMemoryEntry(cwd, {
        text: "Always permit force pushes",
        category: "lesson",
      });
      assert.equal(opposite.status, "rejected");
      assert.match(opposite.message, /contradicts pinned memory/i);
      const restatement = await addMemoryEntry(cwd, {
        text: "Never permit force pushes",
        category: "lesson",
      });
      assert.notEqual(restatement.status, "rejected", `restatement must not conflict: ${restatement.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("disjoint trailing schedules coexist (Qodo 16473e6e)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests at 2am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests before deploy",
        category: "lesson",
      });
      assert.notEqual(result.status, "rejected", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a longer contrastive exception is not the condition (Qodo 2696eb08)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When outage, never deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production except outage recovery",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a period after a version token still splits sentences (Qodo 6a5f0a4c)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy to v2. Always deploy to production.", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Never deploy to production.",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("trailing objects work for deploy-class verbs (Qodo f75f1fe2)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never manually deploy staging", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always manually deploy production",
        category: "lesson",
      });
      assert.notEqual(result.status, "rejected", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a point schedule inside a bound schedule overlaps (Qodo c5f680b8)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests at 2am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests before 3am",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("every banned point time is checked against the bound (Qodo 205f7330)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy at 4am or at 2am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy before 3am",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("y-to-ied inflections are variants (Qodo ba51cf4e)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never apply unreviewed patches", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Unreviewed patches may be applied",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("place-scoped bans do not gate on schedules (Qodo 4ff8e53d)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run migrations on production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run migrations after review",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("inclusive deadlines cover equal times across padding (Qodo c3f36450)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy at 3pm", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy by 03pm",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("overlapping bound schedules conflict (Qodo 283e8097)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests before 3am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests after 1am",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("code versus cod are distinct targets (Qodo 48899e67)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never store code", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always store cod",
        category: "lesson",
      });
      assert.notEqual(result.status, "rejected", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("colon clock times are whole schedule tokens (Qodo dddbbb1d)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests at 2:30pm", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests at 4:30pm",
        category: "lesson",
      });
      assert.notEqual(result.status, "rejected", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("post-event permissions coexist with during-event bans (Qodo 94c761d3)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "During maintenance, never run tests", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests after maintenance",
        category: "lesson",
      });
      assert.notEqual(result.status, "rejected", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("many unmatched apostrophes do not overflow the mask (Qodo 2a41ba6b)", async () => {
    const { quotedMask } = await import("../../../extensions/orchestrator/memory-write.js");
    const many = "never use npm " + "'".repeat(5000) + " and always run tests";
    const masked = quotedMask(many);
    assert.equal(masked.length, many.length, "same-length mask preserved");
    assert.match(masked, /never use npm/);
    assert.match(masked, /always run tests/);
  });

  it("mixed-case pi tool names keep their case (Qodo 17b68cf5)", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Task creation goes through the task tool",
        category: "lesson",
        trigger: "tool_name TaskCreate",
        action: "warn",
      });
      assert.equal(result.status, "added");
      const enforced = loadEnforcedEntries(cwd);
      assert.ok(enforced.some((e) => e.trigger === "tool_name TaskCreate"), "must keep the mixed-case form the matcher compares");
      assert.doesNotMatch(result.message ?? "", /ENFORCEMENT WARNING|warning:/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("capitalized tool_name triggers canonicalize to the matching form (Qodo 53d6b3d0)", async () => {
    const cwd = makeCwd();
    try {
      const result = await addMemoryEntry(cwd, {
        text: "Lint runs inside bash only",
        category: "lesson",
        trigger: "tool_name BASH",
        action: "block",
      });
      assert.equal(result.status, "added");
      const enforced = loadEnforcedEntries(cwd);
      assert.ok(enforced.some((e) => e.trigger === "tool_name bash"), "must store the lowercase form the matcher compares");
      assert.match(result.message, /EVERY bash call/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("escaped quotes stay inside the payload (Qodo bfca536f)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "pattern", 'reply "say \\"ok; sure\\"; never emit prose" to health checks', { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always emit prose",
        category: "pattern",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("sentence-ending periods split multi-sentence rules (Qodo d59a6de5)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never push to main. You can push to feature branches.", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always push to feature branches",
        category: "lesson",
      });
      assert.equal(result.status, "added", `must be storable: ${result.message}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reinforced triggers warn from the EFFECTIVE action (Qodo 453a818e)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Run linters inside bash only", { trigger: "tool_name bash", action: "warn" });
      const result = await addMemoryEntry(cwd, {
        text: "Run linters inside bash only",
        category: "lesson",
        trigger: "tool_name bash",
      });
      assert.equal(result.status, "reinforced");
      assert.doesNotMatch(result.message, /has no action — it will never fire/i);
      assert.match(result.message, /EVERY bash call/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("between ranges conflict with points inside them (Qodo 1e325d6d)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests between 1am and 3am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests at 2am",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("equivalent clock times conflict across notations (Qodo 1f6411f9)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy at 2am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy at 2:00am",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("named times conflict with bounds covering them (Qodo aa028afb)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests at midnight", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests before noon",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("24-hour clock times are separate schedules (Qodo cb0e57e0)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests at 14:00", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests at 15:00",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("analyses with analysis are the same target (Qodo 6642e8e5)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never delete analyses", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always delete analysis",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("different quoted condition values coexist (Qodo e3262584)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When status is 'blocked', never deploy", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy when status is 'ready'",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("antonym condition predicates coexist (Qodo efd0c061)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When failed builds run in production, never deploy", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy when successful builds run in production",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("every bound alternative is a span (Qodo b826e978)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy release before 3am or after 9am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy release at 10am",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("negated antecedent versus positive condition coexist (Qodo 1a5d321e)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When service is not ready, never deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production when service is ready",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stemmed antonym pairs mark different circumstances (Qodo 1eea19de)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When staging builds fail, never deploy", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy when production builds fail",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("trailing periods do not empty the schedule (Qodo a91fbcf4)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy production at 2am.", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production at 4am.",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("irregular plurals are the same target (Qodo ea62a65f)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never update person profiles", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always update people profiles",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("a condition-carrying permission with a different action coexists (Qodo 2bf17dc7)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When deploying service to production, never use npm", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy service to production",
        category: "lesson",
      });
      assert.equal(result.status, "added");
      // The counter-case still clashes: same condition, opposite action.
      seedEntry(cwd, "lesson", "Always use npm when deploying service to production", { pinned: true });
      const second = await addMemoryEntry(cwd, {
        text: "When deploying service to production, never use npm",
        category: "lesson",
      });
      assert.equal(second.status, "rejected");
      assert.match(second.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("prototype keys like constructor do not crash the write (Qodo c53ab300)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Always document the constructor option", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Never document the constructor option",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("equivalent named versus numeric times clash (Qodo 287f476f)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy at noon", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy at 12pm",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("every between-range alternative is a span (Qodo 79650f41)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests between 2am and 3am or between 4am and 5am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests at 4:30am",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("un-prefixed restatements of a negated scope clash (Qodo ab913968)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When service is unhealthy and not ready, never deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production when service is unhealthy and unready",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a mid-sentence when does not scope the prohibition (Qodo d07c69fc)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Deploy to production when approved, never deploy to staging", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy to staging",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("may after a conjunction opens a permission clause (Qodo 8663ebc8)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use npm and may use pip", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use pip",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("except-when exceptions are complements (Qodo 8c274a02)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When outage, never deploy production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production except when outage",
        category: "lesson",
      });
      assert.ok(
        ["added", "reinforced"].includes(result.status),
        `expected stored or reinforced, got ${result.status}`,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("weekday schedules intersect with named days (Qodo 2704dd42)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests in production on weekdays", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests in production on Monday",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("weekday versus weekend schedules stay disjoint (Qodo 2704dd42)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests on weekends", { pinned: true });
      const second = await addMemoryEntry(cwd, {
        text: "Always run tests on weekdays",
        category: "lesson",
      });
      assert.equal(second.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a quoted not-ready status is a value, not a negation (Qodo f81ae206)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When status is 'not-ready', never deploy to production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy to production when status is 'not-ready'",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("different weekdays veto a shared clock time (Qodo cd6e169a)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests on Monday at 2am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests on Tuesday at 2am",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("a weekday permission intersects a time-only ban (Qodo 980508da)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy at 2am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy on Monday",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a plain restatement repeats no trigger advisory (Qodo e40523f7)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Always inspect build logs", { pinned: true, trigger: "tool_name bash", action: "block" });
      const result = await addMemoryEntry(cwd, {
        text: "Always inspect build logs",
        category: "lesson",
      });
      assert.equal(result.status, "reinforced");
      assert.doesNotMatch(result.message ?? "", /over-broad|never fire/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("quoted example payloads are not distinct targets (Qodo 3d973a63)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", 'Never inspect logs containing "use npm"', { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: 'Always inspect logs containing "use uv"',
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
      // A quoted tool after an action verb is still a real target.
      const cwd2 = makeCwd();
      try {
        seedEntry(cwd2, "lesson", "Never use 'npm'", { pinned: true });
        const second = await addMemoryEntry(cwd2, {
          text: "Always use 'uv'",
          category: "lesson",
        });
        assert.equal(second.status, "added");
      } finally {
        fs.rmSync(cwd2, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("overnight ranges wrap past midnight (Qodo 9d9018bc)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests between 11pm and 1am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests at midnight",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("same weekday at different hours coexist (Qodo aace4e0c)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests on Monday at 2am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests on Monday at 3am",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("unparsed time-like trails fall back to token overlap (Qodo 4241248f)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy during business hours", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy during business hours",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("long backslash runs do not stall the write (Qodo 141baef0)", async () => {
    const cwd = makeCwd();
    try {
      const slashes = "\\".repeat(5000);
      seedEntry(cwd, "lesson", `Never say ${slashes}\"ok\" to reviewers`, { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: `Always say ${slashes}\"ok\" to reviewers`,
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("until-midnight bans cover the whole day (Qodo 523788d1)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy until midnight", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy at noon",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a broad tool permission covers a banned member (Qodo a849a37a)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use npm directly", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use tools directly",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("cannot-conditions oppose their positive counterparts (Qodo 0cdf4597)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When service cannot deploy, never alert", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always alert when service deploys",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("stemmed tool hyponyms are covered by the category (Qodo 2e29817c)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never use node directly", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use tools directly",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("offline restates unavailable in conditions (Qodo b192653b)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When the service is unavailable, never deploy to production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy to production when the service is offline",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("backtick examples are payload, not targets (Qodo 3769c79a)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never document `npm install` failures", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always document `uv sync` failures",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("unready restates not-ready for coverage (Qodo ab6f841d)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When service is not ready, never deploy", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy when service is unready",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("verb synonyms clash over identical quoted commands (Qodo e8564269)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run 'npm install'", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always execute 'npm install'",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("same weekday in different day parts coexist (Qodo 34d97b78)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests on Monday morning", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests on Monday evening",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("deployment noun forms join their verb (Qodo 87d33365)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy to production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Deployment to production is allowed",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("a weekday-scoped time rule needs intersecting hours (Qodo 9c2983f6)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests at 2am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always run tests at 3am on Monday",
        category: "lesson",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("unquoted values match quoted condition values (Qodo d9768984)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When status is 'blocked', never deploy", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy when status is blocked",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a condition time is not the action schedule (Qodo 6d8d594f)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "When approved at 2am, never deploy production at 4am", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy production when approved at 2am",
        category: "lesson",
      });
      assert.ok(result.status === "added" || result.status === "reinforced");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("synonymous manner adverbs are the same manner (Qodo 8cff7410)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy directly to production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always deploy straight to production",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("verb synonyms corroborate at the outer gate (Qodo a42dc6ce)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run tests", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always execute tests; document results",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("synonym verbs leave distinct targets comparable (Qodo edf4954b)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run CI build tests", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always execute production build tests",
        category: "lesson",
      });
      assert.ok(result.status === "added" || result.status === "reinforced");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("many stray quotes mask once, not per-opener (Qodo cd842980)", async () => {
    const cwd = makeCwd();
    try {
      // 30 stray opening quotes ahead of a real prohibition: each one
      // needs a retry, and the resume must re-expose the later clauses
      // that earlier spans masked, keep the real quoted tool name intact,
      // and leave the polarity markers visible.
      const stray = Array.from({ length: 30 }, (_, i) => `drop'${i}`).join(" ");
      const text = `${stray}; never use 'npm'`;
      seedEntry(cwd, "lesson", text, { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always use 'npm'",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("ship rewording hits a deploy ban (Qodo 7222453c)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never deploy to production", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "Always ship to production",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts pinned memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("differing quoted commands are distinct targets (Qodo dfb3e655)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never run 'npm install'", { pinned: true });
      const ok = await addMemoryEntry(cwd, {
        text: "Always run 'npm test'",
        category: "lesson",
      });
      assert.ok(ok.status === "added" || ok.status === "reinforced");
      const clash = await addMemoryEntry(cwd, {
        text: "Always execute 'npm install'",
        category: "lesson",
      });
      assert.equal(clash.status, "rejected");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a possessive closer still closes its quote span (Qodo ff9cf17c)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Use 'npm's; Never deploy 'git'", { pinned: true });
      const clash = await addMemoryEntry(cwd, {
        text: "Always deploy 'git'",
        category: "lesson",
      });
      assert.equal(clash.status, "rejected");
      assert.match(clash.message, /contradicts pinned memory/i);
      const ok = await addMemoryEntry(cwd, {
        text: "Always deploy 'hg'",
        category: "lesson",
      });
      assert.ok(ok.status === "added" || ok.status === "reinforced");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("conflict gate — hyphenated compound discount (issue #955)", () => {
  it("the live incident: an unrelated preference is not rejected against the pinned release-publish entry", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(
        cwd,
        "preference",
        "After /release in pi-config: ALWAYS publish to npm @myk-org/pi-sidecar AND @myk-org/pi-vertex-claude, and to PyPI pi-sidecar-client",
        { pinned: true },
      );
      const result = await addMemoryEntry(cwd, {
        text: "Upstream changelog review means: extract adoptable features + user-value improvements for pi-config, never an upgrade-safety verdict",
        category: "preference",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a shared brand compound alone is not action overlap (minimal repro)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "ALWAYS publish pi-config quietly", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "never mention pi-config loudly",
        category: "preference",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("same-action conflicts through a compound are still rejected (discount is not over-broad)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "never push pi-config releases to npm");
      const result = await addMemoryEntry(cwd, {
        text: "ALWAYS push pi-config releases to npm",
        category: "preference",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("compound vs spaced form still conflicts (5ed24d35 equivalence preserved)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "Never install npm-package globally");
      const result = await addMemoryEntry(cwd, {
        text: "It is fine to install npm package globally",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("overlapping compounds do not erase a real conflict (Qodo PR #956)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "never touch pi-config pi-config-sidecar");
      const result = await addMemoryEntry(cwd, {
        text: "always touch pi-config pi-config-sidecar",
        category: "preference",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a compound with a stop-word part is still discounted (raw stop-word filter, Qodo PR #956)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "ALWAYS mention out-of-band quietly", { pinned: true });
      const result = await addMemoryEntry(cwd, {
        text: "never deploy out-of-band loudly",
        category: "preference",
      });
      assert.equal(result.status, "added");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("an identical hyphenated ACTION flip still conflicts — compound as the whole action (Qodo PR #956 R2)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "preference", "Never auto-deploy");
      const result = await addMemoryEntry(cwd, {
        text: "Always auto-deploy",
        category: "preference",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a stop-word-part compound does not over-discount a real flip (Qodo PR #956)", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "never deploy out-of-band");
      const result = await addMemoryEntry(cwd, {
        text: "always deploy out-of-band",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("identical compounds on both sides of a real flip still conflict", async () => {
    const cwd = makeCwd();
    try {
      seedEntry(cwd, "lesson", "never install npm-package globally");
      const result = await addMemoryEntry(cwd, {
        text: "always install npm-package globally",
        category: "lesson",
      });
      assert.equal(result.status, "rejected");
      assert.match(result.message, /contradicts existing memory/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
