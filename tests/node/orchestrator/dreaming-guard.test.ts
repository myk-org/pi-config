/**
 * Guard for issue #1010: memory maintenance must not delete learned knowledge.
 *
 * A dream is an LLM rewriting topic files from a prompt. Prompt wording drifts, so
 * "never remove pinned/enforced/review-learned entries" cannot be a promise — these
 * helpers restore whatever a dream removed that is not re-derivable history.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isProtectedTopicLine,
  restoreProtectedTopicLines,
  snapshotTopicLines,
} from "../../../extensions/orchestrator/dreaming.js";

const DISTILLED =
  "extensions/orchestrator/enforcement-helpers.ts: Quoted identity values can forge commits";

function makeTopics(lines: string[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dream-guard-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lessons.md"), `# Lessons\n\n${lines.join("\n")}\n`, "utf-8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("isProtectedTopicLine", () => {
  it("protects pinned and enforced entries", () => {
    assert.equal(isProtectedTopicLine("- [preference] Always deploy first *(pinned)*", []), true);
    assert.equal(isProtectedTopicLine("- [lesson] Never merge *(enforced)* {#abc123}", []), true);
  });

  it("protects a lesson distilled from a review", () => {
    assert.equal(isProtectedTopicLine(`- [lesson] ${DISTILLED} {#dc8d8500}`, [DISTILLED]), true);
  });

  it("leaves re-derivable history unprotected", () => {
    assert.equal(
      isProtectedTopicLine("- [done] #924 merged in v4.13.0: coms steer/broadcast", []),
      false,
    );
  });

  it("ignores non-entry lines", () => {
    assert.equal(isProtectedTopicLine("# Lessons", [DISTILLED]), false);
    assert.equal(isProtectedTopicLine("", [DISTILLED]), false);
  });
});

describe("restoreProtectedTopicLines", () => {
  it("restores what a dream removed and keeps its own prunings", () => {
    const pinned = "- [preference] Ask before paying for a model *(pinned)*";
    const distilled = `- [lesson] ${DISTILLED} {#dc8d8500}`;
    const history = "- [done] #936 merged via PR #937 in v4.14.0";
    const { dir, cleanup } = makeTopics([pinned, distilled, history]);
    try {
      const before = snapshotTopicLines(dir);

      // The dream keeps one entry, deletes all three originals, and adds its own.
      writeFileSync(
        join(dir, "lessons.md"),
        `# Lessons\n\n- [lesson] Something new the dream learned\n`,
        "utf-8",
      );

      const restored = restoreProtectedTopicLines(dir, before, [DISTILLED]);
      assert.equal(restored, 2, "pinned + distilled come back, history does not");

      const after = readFileSync(join(dir, "lessons.md"), "utf-8");
      assert.ok(after.includes(pinned), "pinned entry restored");
      assert.ok(after.includes(distilled), "distilled review lesson restored");
      assert.ok(!after.includes(history), "re-derivable history stays pruned");
      assert.ok(after.includes("Something new the dream learned"), "the dream's own entry survives");
    } finally {
      cleanup();
    }
  });

  it("changes nothing when the dream kept every protected line", () => {
    const pinned = "- [preference] Ask before paying for a model *(pinned)*";
    const { dir, cleanup } = makeTopics([pinned]);
    try {
      const before = snapshotTopicLines(dir);
      const original = readFileSync(join(dir, "lessons.md"), "utf-8");
      assert.equal(restoreProtectedTopicLines(dir, before, []), 0);
      assert.equal(readFileSync(join(dir, "lessons.md"), "utf-8"), original);
    } finally {
      cleanup();
    }
  });

  it("does not throw when a topic file is missing", () => {
    const { dir, cleanup } = makeTopics(["- [lesson] keep me *(pinned)*"]);
    try {
      const before = snapshotTopicLines(dir);
      rmSync(join(dir, "lessons.md"));
      assert.equal(restoreProtectedTopicLines(dir, before, []), 0);
    } finally {
      cleanup();
    }
  });
});
