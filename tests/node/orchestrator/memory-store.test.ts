/**
 * Deep memory-store interface tests (issue #1354).
 *
 * Local-substitutable tests against isolated temp memory directories verifying:
 * - memory_edit guard enforcement (marker-shape, grant, task-scope, contradiction, duplicate, cap)
 * - topic-file cache invalidation on edit, enforcement marking, and dream restore
 * - score/id/provenance/tombstone consistency across store mutations
 * - rebuildMemoryStore expiry pruning, score rebuild, and stale embedding pruning
 * - architectural boundary: zero direct topic writeFileSync or cache choreography outside memory-store.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addMemoryEntry,
  applyEnforcementPromotions,
  applyEntryProvenance,
  editMemoryEntry,
  markEntryEnforced,
  rebuildMemoryStore,
  removeMemoryEntry,
  removalsSince,
  restoreProtectedTopicLines,
  snapshotTopicLines,
} from "../../../extensions/orchestrator/memory-store.js";
import {
  entryHash,
  loadScores,
  saveScores,
} from "../../../extensions/orchestrator/memory-scoring.js";
import {
  ALL_TOPIC_NAMES,
  CATEGORY_TO_TOPIC,
  readAllTopicEntries,
  topicCharCap,
} from "../../../extensions/orchestrator/memory-tree.js";
import { registerMemoryTools } from "../../../extensions/orchestrator/memory-tools.js";
import { findSynchronousContradictions } from "../../../extensions/orchestrator/memory-contradiction.js";
import {
  getProjectStateDbPath,
  openStateDb,
} from "../../../extensions/orchestrator/state-db.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const REPO_ROOT = join(import.meta.dirname, "../../..");

function embeddingKey(text: string, category: string): string {
  return createHash("sha256").update(`[${category}] ${text}`).digest("hex").slice(0, 16);
}

function seedEmbeddingsFile(cwd: string, entries: Record<string, number[]>): void {
  const memDir = join(cwd, ".pi", "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, "embeddings.jsonl"),
    JSON.stringify({
      model: "Xenova/bge-small-en-v1.5",
      dim: 384,
      pooling: "mean",
      entries,
    }) + "\n",
    "utf-8",
  );
}

function readEmbeddingKeys(cwd: string): string[] {
  const db = openStateDb(getProjectStateDbPath(cwd));
  const rows = db
    .prepare("SELECT entry_key FROM embeddings ORDER BY entry_key")
    .all() as Array<{ entry_key: string }>;
  return rows.map((r) => r.entry_key);
}

describe("memory-store: editMemoryEntry guard enforcement", () => {
  it("rejects reserved topic-line markers in newText", async () => {
    const cwd = makeTempDir("mem-store-marker-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Always run pytest via uv run" });

      for (const bad of [
        "Always run pytest via uv run *(pinned)*",
        "Always run pytest via uv run *(enforced)*",
        "Always run pytest via uv run {#deadbeef}",
      ]) {
        const res = await editMemoryEntry(cwd, {
          category: "lesson",
          text: "Always run pytest via uv run",
          newText: bad,
        });
        assert.equal(res.status, "rejected", `expected rejection for ${bad}`);
        assert.match(res.message, /reserved for storage/i);
      }
      assert.deepEqual(
        readAllTopicEntries(cwd).map((e) => e.text),
        ["Always run pytest via uv run"],
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects one-off grant phrases on non-session edits", async () => {
    const cwd = makeTempDir("mem-store-grant-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Wait for CI before merging PRs" });
      const res = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Wait for CI before merging PRs",
        newText: "You can merge this PR right now",
      });
      assert.equal(res.status, "rejected");
      assert.match(res.message, /one-off permission grant/i);
      assert.equal(readAllTopicEntries(cwd)[0]?.text, "Wait for CI before merging PRs");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("allows grant phrasing when editing an already session-scoped entry", async () => {
    const cwd = makeTempDir("mem-store-session-grant-");
    try {
      await addMemoryEntry(cwd, {
        category: "lesson",
        text: "You can merge this PR",
        scope: "session",
        sourceSession: "sess-1",
      });
      const res = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "You can merge this PR",
        newText: "Go ahead and merge this PR once checks pass",
      });
      assert.equal(res.status, "updated");
      assert.equal(readAllTopicEntries(cwd)[0]?.text, "Go ahead and merge this PR once checks pass");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects task-scoped instructions on non-session edits", async () => {
    const cwd = makeTempDir("mem-store-task-scope-");
    try {
      await addMemoryEntry(cwd, { category: "preference", text: "Always format reports as markdown" });
      const res = await editMemoryEntry(cwd, {
        category: "preference",
        text: "Always format reports as markdown",
        newText: "When done, I want an html report",
      });
      assert.equal(res.status, "rejected");
      assert.match(res.message, /task-scoped instruction/i);
      assert.equal(readAllTopicEntries(cwd)[0]?.text, "Always format reports as markdown");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects edits that contradict another pinned memory", async () => {
    const cwd = makeTempDir("mem-store-conflict-pinned-");
    try {
      await addMemoryEntry(cwd, {
        category: "preference",
        text: "Never force push to main",
        pinned: true,
      });
      await addMemoryEntry(cwd, {
        category: "lesson",
        text: "Run typecheck before pushing commits",
      });

      const res = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Run typecheck before pushing commits",
        newText: "Always force push to main",
      });
      assert.equal(res.status, "rejected");
      assert.match(res.message, /contradicts pinned memory/i);
      assert.ok(readAllTopicEntries(cwd).some((e) => e.text === "Run typecheck before pushing commits"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects edits that contradict another non-pinned memory", async () => {
    const cwd = makeTempDir("mem-store-conflict-regular-");
    try {
      await addMemoryEntry(cwd, {
        category: "lesson",
        text: "Never use git add . in this repo",
        trigger: "bash_contains git add .",
        action: "block",
      });
      await addMemoryEntry(cwd, {
        category: "lesson",
        text: "Stage explicit file paths when committing",
      });

      const res = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Stage explicit file paths when committing",
        newText: "Always use git add . in this repo",
      });
      assert.equal(res.status, "rejected");
      assert.match(res.message, /contradicts existing memory/i);
      assert.match(res.message, /code-enforced/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("allows editing an entry to reverse its own polarity when no other entry contradicts it", async () => {
    const cwd = makeTempDir("mem-store-self-flip-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Never deploy on Fridays" });
      const res = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Never deploy on Fridays",
        newText: "Always deploy on Fridays",
      });
      assert.equal(res.status, "updated");
      assert.deepEqual(
        readAllTopicEntries(cwd).map((e) => e.text),
        ["Always deploy on Fridays"],
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects editing an entry into an existing duplicate in the same topic", async () => {
    const cwd = makeTempDir("mem-store-edit-dup-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Run tox before pushing" });
      await addMemoryEntry(cwd, { category: "lesson", text: "Keep commits atomic" });
      const res = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Keep commits atomic",
        newText: "Run tox before pushing",
      });
      assert.equal(res.status, "rejected");
      assert.match(res.message, /already exists/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects edits that exceed the topic char cap", async () => {
    const cwd = makeTempDir("mem-store-edit-cap-");
    try {
      await addMemoryEntry(cwd, { category: "done", text: "Measured baseline startup latency" });
      const res = await editMemoryEntry(cwd, {
        category: "done",
        text: "Measured baseline startup latency",
        newText: "x".repeat(topicCharCap("completions") + 50),
      });
      assert.equal(res.status, "rejected");
      assert.match(res.message, /exceed topic size limit/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects blank or multiline newText values", async () => {
    const cwd = makeTempDir("mem-store-edit-empty-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Keep changes scoped" });
      const blank = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Keep changes scoped",
        newText: "   ",
      });
      assert.equal(blank.status, "rejected");
      const multi = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Keep changes scoped",
        newText: "Line one\nLine two",
      });
      assert.equal(multi.status, "rejected");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects editing an unpinned project preference to unmarked text", async () => {
    const cwd = makeTempDir("mem-store-edit-durability-");
    try {
      await addMemoryEntry(cwd, { category: "preference", text: "Always use uv for Python" });
      const res = await editMemoryEntry(cwd, {
        category: "preference",
        text: "Always use uv for Python",
        newText: "use pip for this",
      });
      assert.equal(res.status, "rejected");
      assert.match(res.message, /durability marker/i);
      assert.equal(readAllTopicEntries(cwd)[0]?.text, "Always use uv for Python");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("allows editing a pinned preference to unmarked text", async () => {
    const cwd = makeTempDir("mem-store-edit-pinned-pref-");
    try {
      await addMemoryEntry(cwd, {
        category: "preference",
        text: "Always use uv for Python",
        pinned: true,
      });
      const res = await editMemoryEntry(cwd, {
        category: "preference",
        text: "Always use uv for Python",
        newText: "use uv for Python scripts",
      });
      assert.equal(res.status, "updated");
      assert.equal(readAllTopicEntries(cwd)[0]?.text, "use uv for Python scripts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects editing an unpinned duplicate when a pinned duplicate contradicts the new text", async () => {
    const cwd = makeTempDir("mem-store-edit-pinned-dup-");
    try {
      const topicsDir = join(cwd, ".pi", "memory", "topics");
      mkdirSync(topicsDir, { recursive: true });
      writeFileSync(
        join(topicsDir, "lessons.md"),
        [
          "# Lessons",
          "",
          "- [lesson] Never force push to main",
          "- [lesson] Never force push to main *(pinned)*",
          "",
        ].join("\n"),
        "utf-8",
      );

      const res = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Never force push to main",
        newText: "Always force push to main",
      });
      assert.equal(res.status, "rejected");
      assert.match(res.message, /contradicts pinned memory/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("memory-store: editMemoryEntry persistence invariants", () => {
  it("re-reads the topic file after async checks so concurrent writes are preserved", async () => {
    const cwd = makeTempDir("mem-store-edit-concurrent-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Target rule to update" });
      const topicPath = join(cwd, ".pi", "memory", "topics", "lessons.md");

      // Start edit (runs synchronously up to its first await, then yields)
      const editPromise = editMemoryEntry(cwd, {
        category: "lesson",
        text: "Target rule to update",
        newText: "Updated target rule",
      });

      // Simulate a concurrent write landing during the await window that shifts line indices
      const current = readFileSync(topicPath, "utf-8");
      const lines = current.split("\n");
      lines.splice(1, 0, "- [lesson] Concurrent entry inserted before target");
      writeFileSync(topicPath, lines.join("\n"), "utf-8");

      const res = await editPromise;
      assert.equal(res.status, "updated");

      const entries = readAllTopicEntries(cwd).map((e) => e.text);
      assert.ok(
        entries.includes("Concurrent entry inserted before target"),
        "concurrent write must not be clobbered",
      );
      assert.ok(entries.includes("Updated target rule"), "target line must be updated at its shifted index");
      assert.ok(!entries.includes("Target rule to update"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an edit when a conflicting pinned rule is added concurrently during awaits", async () => {
    const cwd = makeTempDir("mem-store-edit-concurrent-pinned-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Run typecheck before pushing commits" });
      const topicsDir = join(cwd, ".pi", "memory", "topics");

      // Start edit (yields at embedMissing / findContradictionWithVector)
      const editPromise = editMemoryEntry(cwd, {
        category: "lesson",
        text: "Run typecheck before pushing commits",
        newText: "Always force push to main",
      });

      // Simulate a concurrent write landing a conflicting pinned preference during the await
      writeFileSync(
        join(topicsDir, "preferences.md"),
        "# Preferences\n\n- [preference] Never force push to main *(pinned)*\n",
        "utf-8",
      );

      const res = await editPromise;
      assert.equal(res.status, "rejected");
      assert.match(res.message, /contradicts pinned memory/i);
      assert.ok(
        readAllTopicEntries(cwd).some(
          (e) => e.category === "lesson" && e.text === "Run typecheck before pushing commits",
        ),
        "original entry must remain untouched after concurrent conflict rejection",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an edit when an unembedded one-word-overlap pinned rule lands concurrently", async () => {
    const cwd = makeTempDir("mem-store-edit-short-pinned-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Document release steps clearly" });
      const topicsDir = join(cwd, ".pi", "memory", "topics");

      const editPromise = editMemoryEntry(cwd, {
        category: "lesson",
        text: "Document release steps clearly",
        newText: "Always deploy to production",
      });

      // Concurrent short pinned rule written without an embedding yet (shares only "deploy")
      writeFileSync(
        join(topicsDir, "preferences.md"),
        "# Preferences\n\n- [preference] Never deploy *(pinned)*\n",
        "utf-8",
      );

      const res = await editPromise;
      assert.equal(res.status, "rejected");
      assert.match(res.message, /contradicts pinned memory/i);
      assert.ok(
        readAllTopicEntries(cwd).some(
          (e) => e.category === "lesson" && e.text === "Document release steps clearly",
        ),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("findSynchronousContradictions detects unembedded short-rule conflicts without vector search", () => {
    const cwd = makeTempDir("mem-store-sync-short-");
    try {
      const conflicts = findSynchronousContradictions(
        cwd,
        "Always deploy to production",
        "lesson",
        [{ category: "preference", text: "Never deploy", pinned: true }],
      );
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0]?.text, "Never deploy");
      assert.equal(conflicts[0]?.pinned, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("preserves topic markers, stable id, and invalidates topic read cache", async () => {
    const cwd = makeTempDir("mem-store-edit-cache-");
    try {
      await addMemoryEntry(cwd, {
        category: "lesson",
        text: "Never run bare pip install",
        pinned: true,
        trigger: "bash_contains pip install",
        action: "block",
      });
      const beforeEntries = readAllTopicEntries(cwd);
      const originalId = beforeEntries[0]!.id;
      assert.ok(originalId, "expected stable id on enforced entry");

      const res = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Never run bare pip install",
        newText: "Never run bare pip install in this repo",
      });
      assert.equal(res.status, "updated");

      const afterEntries = readAllTopicEntries(cwd);
      assert.equal(afterEntries.length, 1);
      assert.equal(afterEntries[0]!.text, "Never run bare pip install in this repo");
      assert.equal(afterEntries[0]!.pinned, true);
      assert.equal(afterEntries[0]!.id, originalId);

      const topicContent = readFileSync(join(cwd, ".pi", "memory", "topics", "lessons.md"), "utf-8");
      assert.match(topicContent, /\*\(pinned\)\* \*\(enforced\)\* \{#[0-9a-f]+\}/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("transfers score history, enforcement fields, and provenance to the new hash", async () => {
    const cwd = makeTempDir("mem-store-edit-score-");
    try {
      await addMemoryEntry(cwd, {
        category: "lesson",
        text: "Never run bare pip install",
        trigger: "bash_contains pip install",
        action: "block",
      });
      const originalId = readAllTopicEntries(cwd)[0]!.id;

      const res = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Never run bare pip install",
        newText: "Never run bare pip install in this repo",
        sourceSession: "sess-edit",
        derivedFrom: "manual-refinement",
        informs: ["python"],
      });
      assert.equal(res.status, "updated");

      const scores = loadScores(cwd);
      assert.equal(scores.entries[entryHash("- [lesson] Never run bare pip install")], undefined);
      const moved = scores.entries[entryHash("- [lesson] Never run bare pip install in this repo")];
      assert.ok(moved);
      assert.equal(moved!.id, originalId);
      assert.equal(moved!.trigger, "bash_contains pip install");
      assert.equal(moved!.action, "block");
      assert.equal(moved!.sourceSession, "sess-edit");
      assert.equal(moved!.derivedFrom, "manual-refinement");
      assert.deepEqual(moved!.informs, ["python"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("removes the superseded embedding key on text update", async () => {
    const cwd = makeTempDir("mem-store-edit-emb-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Use uv run for pytest" });
      const oldKey = embeddingKey("Use uv run for pytest", "lesson");
      seedEmbeddingsFile(cwd, { [oldKey]: [0.1, 0.2, 0.3] });

      const res = await editMemoryEntry(cwd, {
        category: "lesson",
        text: "Use uv run for pytest",
        newText: "Use uv run --group tests pytest",
      });
      assert.equal(res.status, "updated");
      assert.ok(!readEmbeddingKeys(cwd).includes(oldKey));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("memory-store: memory_edit tool routes through store guards", () => {
  const originalChild = process.env.PI_SUBAGENT_CHILD;
  before(() => delete process.env.PI_SUBAGENT_CHILD);
  after(() => {
    if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = originalChild;
  });

  it("blocks grant-phrase edit through the registered memory_edit tool", async () => {
    const cwd = makeTempDir("mem-store-tool-edit-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Check git status before committing" });
      const registered = new Map<string, any>();
      registerMemoryTools({ registerTool: (t: any) => registered.set(t.name, t) } as any);

      const res = await registered.get("memory_edit").execute(
        "call-1",
        {
          op: "update",
          category: "lesson",
          text: "Check git status before committing",
          newText: "You can merge this PR without checks",
        },
        undefined,
        undefined,
        { cwd },
      );
      assert.match(res.content[0].text, /one-off permission grant/i);
      assert.equal(readAllTopicEntries(cwd)[0]?.text, "Check git status before committing");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("memory-store: enforcement promotions", () => {
  it("applyEnforcementPromotions attaches enforcement fields once per entry", async () => {
    const cwd = makeTempDir("mem-store-promo-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Never use `git add .`" });
      assert.equal(readAllTopicEntries(cwd).length, 1);

      const first = applyEnforcementPromotions(cwd, [
        {
          category: "lesson",
          text: "Never use `git add .`",
          trigger: "bash_contains git add .",
          action: "block",
        },
      ]);
      assert.equal(first.length, 1);

      const second = applyEnforcementPromotions(cwd, [
        {
          category: "lesson",
          text: "Never use `git add .`",
          trigger: "bash_contains git add .",
          action: "block",
        },
      ]);
      assert.equal(second.length, 0);

      const scored = loadScores(cwd).entries[entryHash("- [lesson] Never use `git add .`")];
      assert.equal(scored?.trigger, "bash_contains git add .");
      assert.equal(scored?.action, "block");
      const topicText = readFileSync(join(cwd, ".pi", "memory", "topics", "lessons.md"), "utf-8");
      assert.match(topicText, /\*\(enforced\)\*/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("markEntryEnforced is idempotent for present entries and false for absent ones", async () => {
    const cwd = makeTempDir("mem-store-mark-enf-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Never use `npm publish`" });
      assert.equal(markEntryEnforced(cwd, "lesson", "Never use `npm publish`"), true);
      assert.equal(markEntryEnforced(cwd, "lesson", "Never use `npm publish`"), true);
      assert.equal(markEntryEnforced(cwd, "lesson", "Nonexistent"), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("memory-store: provenance, restore, removal, rebuild", () => {
  it("applyEntryProvenance merges metadata onto existing scores", async () => {
    const cwd = makeTempDir("mem-store-prov-");
    try {
      await addMemoryEntry(cwd, { category: "pattern", text: "Use createLogger in extensions" });
      const count = applyEntryProvenance(cwd, [
        {
          category: "pattern",
          text: "Use createLogger in extensions",
          sourceSession: "sess-99",
          derivedFrom: "dream",
          informs: ["logging"],
        },
        {
          category: "pattern",
          text: "Does not exist",
          sourceSession: "sess-99",
        },
      ]);
      assert.equal(count, 1);
      const entry = loadScores(cwd).entries[entryHash("- [pattern] Use createLogger in extensions")];
      assert.equal(entry?.sourceSession, "sess-99");
      assert.equal(entry?.derivedFrom, "dream");
      assert.deepEqual(entry?.informs, ["logging"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("restoreProtectedTopicLines invalidates the topic cache after restoring", async () => {
    const cwd = makeTempDir("mem-store-restore-");
    try {
      await addMemoryEntry(cwd, {
        category: "preference",
        text: "Always stage explicit paths",
        pinned: true,
      });
      const topicsDir = join(cwd, ".pi", "memory", "topics");
      const before = snapshotTopicLines(topicsDir);
      assert.ok(before["preferences.md"]);
      assert.deepEqual([...ALL_TOPIC_NAMES].sort(), Object.values(CATEGORY_TO_TOPIC).sort());

      writeFileSync(join(topicsDir, "preferences.md"), "# Preferences\n", "utf-8");
      assert.equal(readAllTopicEntries(cwd).length, 0);

      const report = restoreProtectedTopicLines(topicsDir, before, [], () => false);
      assert.equal(report.restored, 1);
      assert.deepEqual(
        readAllTopicEntries(cwd).map((e) => e.text),
        ["Always stage explicit paths"],
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("removeMemoryEntry clears topic, score, embedding, honoring tombstone flag", async () => {
    const cwd = makeTempDir("mem-store-remove-");
    try {
      await addMemoryEntry(cwd, { category: "lesson", text: "Entry with tombstone" });
      await addMemoryEntry(cwd, { category: "lesson", text: "Entry without tombstone" });
      seedEmbeddingsFile(cwd, {
        [embeddingKey("Entry with tombstone", "lesson")]: [1, 0],
        [embeddingKey("Entry without tombstone", "lesson")]: [0, 1],
      });

      const started = Date.now() - 1000;
      const r1 = removeMemoryEntry(cwd, "lesson", "Entry with tombstone", { recordTombstone: true });
      const r2 = removeMemoryEntry(cwd, "lesson", "Entry without tombstone", { recordTombstone: false });
      assert.equal(r1.status, "removed");
      assert.equal(r2.status, "removed");

      assert.equal(readAllTopicEntries(cwd).length, 0);
      assert.equal(Object.keys(loadScores(cwd).entries).length, 0);
      assert.equal(readEmbeddingKeys(cwd).length, 0);

      const tombstones = removalsSince(cwd, started);
      assert.ok(tombstones.has(entryHash("- [lesson] Entry with tombstone")));
      assert.ok(!tombstones.has(entryHash("- [lesson] Entry without tombstone")));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rebuildMemoryStore prunes expired entries, rebuilds scores, prunes stale embeddings", async () => {
    const cwd = makeTempDir("mem-store-rebuild-");
    try {
      await addMemoryEntry(cwd, {
        category: "lesson",
        text: "Temporary session note",
        scope: "session",
        sourceSession: "s1",
      });
      await addMemoryEntry(cwd, { category: "lesson", text: "Durable project lesson" });

      const scores = loadScores(cwd);
      const expiredHash = entryHash("- [lesson] Temporary session note");
      scores.entries[expiredHash]!.expiresAt = new Date(Date.now() - 60_000).toISOString();
      saveScores(cwd, scores);

      const durableKey = embeddingKey("Durable project lesson", "lesson");
      const staleKey = embeddingKey("Stale orphaned entry", "lesson");
      seedEmbeddingsFile(cwd, {
        [durableKey]: [1, 0],
        [staleKey]: [0, 1],
      });

      rebuildMemoryStore(cwd);

      assert.deepEqual(
        readAllTopicEntries(cwd).map((e) => e.text),
        ["Durable project lesson"],
      );
      const rebuiltScores = loadScores(cwd);
      assert.equal(rebuiltScores.entries[expiredHash], undefined);
      assert.ok(rebuiltScores.entries[entryHash("- [lesson] Durable project lesson")]);

      assert.deepEqual(readEmbeddingKeys(cwd), [durableKey]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("memory-store: architectural boundary invariants (#1354)", () => {
  it("forbids direct writeFileSync in topic consumer modules", () => {
    const consumers = [
      "extensions/orchestrator/memory-tools.ts",
      "extensions/orchestrator/memory-promotion.ts",
      "extensions/orchestrator/dreaming.ts",
      "extensions/orchestrator/situation-report.ts",
    ];
    for (const rel of consumers) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf-8");
      assert.doesNotMatch(src, /\bwriteFileSync\b/, `${rel} must not call writeFileSync directly`);
    }
  });

  it("forbids direct invalidateTopicFileCache calls outside memory-store.ts", () => {
    const consumers = [
      "extensions/orchestrator/memory-tools.ts",
      "extensions/orchestrator/memory-promotion.ts",
      "extensions/orchestrator/dreaming.ts",
      "extensions/orchestrator/situation-report.ts",
    ];
    for (const rel of consumers) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf-8");
      assert.doesNotMatch(
        src,
        /\binvalidateTopicFileCache\b/,
        `${rel} must not call invalidateTopicFileCache directly`,
      );
    }
  });

  it("removes duplicated topic list and canonicalization helpers from dreaming.ts", () => {
    const src = readFileSync(join(REPO_ROOT, "extensions/orchestrator/dreaming.ts"), "utf-8");
    assert.doesNotMatch(src, /\bMEMORY_TOPIC_FILES\b/);
    assert.doesNotMatch(src, /\btopicLineCanonical\b/);
    assert.doesNotMatch(src, /\btopicLineText\b/);
  });

  it("keeps memory-tree.ts strictly read-only", () => {
    const src = readFileSync(join(REPO_ROOT, "extensions/orchestrator/memory-tree.ts"), "utf-8");
    assert.doesNotMatch(src, /\bwriteFileSync\b/);
    assert.doesNotMatch(src, /\bappendFileSync\b/);
  });
});
