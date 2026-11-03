/**
 * Guard for issue #1010: memory maintenance must not delete learned knowledge.
 *
 * A dream is an LLM rewriting topic files from a prompt, so "never remove
 * pinned/enforced/review-learned entries" cannot be a promise — these helpers restore
 * whatever a dream removed that is not re-derivable history, then keep the file inside
 * its per-topic cap and never resurrect an entry the user removed themselves.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isProtectedTopicLine,
  restoreProtectedTopicLines,
  snapshotTopicLines,
  topicLineCanonical,
} from "../../../extensions/orchestrator/dreaming.js";

const DISTILLED =
  "extensions/orchestrator/enforcement-helpers.ts: Quoted identity values can forge commits";
const PINNED = "- [preference] Ask before paying for a model *(pinned)*";
const DISTILLED_LINE = `- [lesson] ${DISTILLED} {#dc8d8500}`;
const HISTORY = "- [done] #936 merged via PR #937 in v4.14.0";

function topics(lines: string[], name = "lessons"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dream-guard-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `# Lessons\n\n${lines.join("\n")}\n`, "utf-8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function read(dir: string, name = "lessons"): string {
  return readFileSync(join(dir, `${name}.md`), "utf-8");
}

describe("isProtectedTopicLine", () => {
  it("protects pinned entries", () => {
    assert.equal(isProtectedTopicLine(PINNED, []), true);
  });

  it("protects enforced entries", () => {
    assert.equal(isProtectedTopicLine("- [lesson] Never merge *(enforced)* {#abc123}", []), true);
  });

  it("protects a lesson distilled from a review", () => {
    assert.equal(isProtectedTopicLine(DISTILLED_LINE, [DISTILLED]), true);
  });

  it("leaves re-derivable history unprotected", () => {
    assert.equal(isProtectedTopicLine(HISTORY, []), false);
  });

  it("ignores non-entry lines", () => {
    assert.equal(isProtectedTopicLine("# Lessons", [DISTILLED]), false);
  });
});

describe("topicLineCanonical", () => {
  it("drops markers, hash, and keeps the category", () => {
    assert.equal(topicLineCanonical(DISTILLED_LINE), `- [lesson] ${DISTILLED}`);
    assert.equal(topicLineCanonical(PINNED), "- [preference] Ask before paying for a model");
  });
});

describe("restoreProtectedTopicLines", () => {
  it("restores a pinned entry the dream removed", () => {
    const { dir, cleanup } = topics([PINNED, HISTORY]);
    try {
      const before = snapshotTopicLines(dir);
      writeFileSync(join(dir, "lessons.md"), `# Lessons\n\n${HISTORY}\n`, "utf-8");
      const report = restoreProtectedTopicLines(dir, before, []);
      assert.equal(report.restored, 1);
      assert.ok(read(dir).includes(PINNED));
    } finally {
      cleanup();
    }
  });

  it("restores a distilled review lesson the dream removed", () => {
    const { dir, cleanup } = topics([DISTILLED_LINE]);
    try {
      const before = snapshotTopicLines(dir);
      writeFileSync(join(dir, "lessons.md"), "# Lessons\n", "utf-8");
      const report = restoreProtectedTopicLines(dir, before, [DISTILLED]);
      assert.equal(report.restored, 1);
      assert.ok(read(dir).includes(DISTILLED_LINE));
    } finally {
      cleanup();
    }
  });

  it("does not resurrect re-derivable history", () => {
    const { dir, cleanup } = topics([PINNED, HISTORY]);
    try {
      const before = snapshotTopicLines(dir);
      writeFileSync(join(dir, "lessons.md"), `# Lessons\n\n${PINNED}\n`, "utf-8");
      restoreProtectedTopicLines(dir, before, []);
      assert.ok(!read(dir).includes(HISTORY));
    } finally {
      cleanup();
    }
  });

  it("keeps the entry the dream added", () => {
    const { dir, cleanup } = topics([PINNED]);
    try {
      const before = snapshotTopicLines(dir);
      writeFileSync(
        join(dir, "lessons.md"),
        `# Lessons\n\n${PINNED}\n- [lesson] Something new the dream learned\n`,
        "utf-8",
      );
      restoreProtectedTopicLines(dir, before, []);
      assert.ok(read(dir).includes("Something new the dream learned"));
    } finally {
      cleanup();
    }
  });

  it("recreates a topic the dream deleted outright", () => {
    const { dir, cleanup } = topics([PINNED, DISTILLED_LINE]);
    try {
      const before = snapshotTopicLines(dir);
      rmSync(join(dir, "lessons.md"));
      const report = restoreProtectedTopicLines(dir, before, [DISTILLED]);
      assert.equal(report.restored, 2, "a deleted topic is rebuilt from its protected entries");
      assert.equal(report.failed, 0);
      assert.ok(read(dir).includes(PINNED));
      assert.ok(read(dir).includes(DISTILLED_LINE));
    } finally {
      cleanup();
    }
  });

  it("does not restore an entry the user removed while the dream ran", () => {
    const { dir, cleanup } = topics([PINNED, DISTILLED_LINE]);
    try {
      const before = snapshotTopicLines(dir);
      writeFileSync(join(dir, "lessons.md"), `# Lessons\n\n${PINNED}\n`, "utf-8");
      // The memory system no longer tracks the distilled line → the user removed it.
      const report = restoreProtectedTopicLines(dir, before, [DISTILLED], () => false);
      assert.equal(report.restored, 0);
      assert.ok(!read(dir).includes(DISTILLED_LINE));
    } finally {
      cleanup();
    }
  });

  it("keeps completions inside its 6000-char cap by dropping unprotected additions", () => {
    const filler = `- [lesson] ${"x".repeat(120)}`;
    const { dir, cleanup } = topics([PINNED], "completions");
    try {
      const before = snapshotTopicLines(dir);
      const dreamAdded = Array.from({ length: 60 }, (_, i) => `- [done] dream entry ${i} ${"y".repeat(100)}`);
      writeFileSync(join(dir, "completions.md"), `# Completions\n\n${filler}\n${dreamAdded.join("\n")}\n`, "utf-8");

      const report = restoreProtectedTopicLines(dir, before, []);
      const after = read(dir, "completions");
      assert.ok(after.includes(PINNED), "the protected entry is restored");
      assert.ok(after.length <= 6000, `kept inside the cap, got ${after.length}`);
      assert.ok(report.droppedForCap > 0, "unprotected additions were dropped to fit");
    } finally {
      cleanup();
    }
  });

  it("reports a failed restore instead of swallowing it", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return; // root ignores the write permission this case relies on
    }
    const { dir, cleanup } = topics([PINNED]);
    try {
      const before = snapshotTopicLines(dir);
      writeFileSync(join(dir, "lessons.md"), "# Lessons\n", "utf-8");
      chmodSync(join(dir, "lessons.md"), 0o444);
      const report = restoreProtectedTopicLines(dir, before, []);
      assert.equal(report.failed, 1, "the caller must be able to log a failed restore");
      assert.equal(report.restored, 0);
    } finally {
      chmodSync(join(dir, "lessons.md"), 0o644);
      cleanup();
    }
  });

  it("changes nothing when the dream kept every protected line", () => {
    const { dir, cleanup } = topics([PINNED]);
    try {
      const before = snapshotTopicLines(dir);
      const original = read(dir);
      const report = restoreProtectedTopicLines(dir, before, []);
      assert.deepEqual(report, { restored: 0, failed: 0, droppedForCap: 0 });
      assert.equal(read(dir), original);
    } finally {
      cleanup();
    }
  });

});
