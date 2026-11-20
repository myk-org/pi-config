/**
 * Tests for compact pidiff review formatting and shared field hoisting (#1293).
 * Run with: npx tsx --test tests/node/pidiff/review-format.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatReviewMessage } from "../../../extensions/pidiff/pidiff.js";

function extractJsonBlock(msg: string): string {
  const match = msg.match(/```json\n([\s\S]+?)\n```/);
  assert.ok(match, "expected markdown json block");
  return match[1];
}

describe("formatReviewMessage (#1293)", () => {
  it("hoists shared branch and worktreePath once, omits source/type, and emits compact JSON", () => {
    const msg = formatReviewMessage({
      comments: [
        { file: "a.ts", line: 10, side: "new", body: "Fix null check", branch: "feat/x", worktreePath: "/repo/wt" },
        {
          file: "b.ts",
          line: 22,
          side: "old",
          body: "Simplify loop",
          branch: "feat/x",
          worktreePath: "/repo/wt",
          replies: [{ author: "You", body: "Good catch", timestamp: "now" }],
          resolved: true,
        },
      ],
      summary: "Two small cleanups",
    });

    const jsonText = extractJsonBlock(msg);
    assert.equal(jsonText.includes("\n"), false, "JSON payload must be compact (single line)");

    const parsed = JSON.parse(jsonText);
    assert.equal("source" in parsed, false);
    assert.equal("type" in parsed, false);
    assert.equal(parsed.branch, "feat/x");
    assert.equal(parsed.worktreePath, "/repo/wt");
    assert.equal(parsed.summary, "Two small cleanups");
    assert.equal(parsed.comments.length, 2);
    assert.equal("branch" in parsed.comments[0], false);
    assert.equal("worktreePath" in parsed.comments[0], false);
    assert.equal("branch" in parsed.comments[1], false);
    assert.equal("worktreePath" in parsed.comments[1], false);
    assert.equal(parsed.comments[1].resolved, true);
    assert.equal(parsed.comments[1].replies.length, 1);
  });

  it("keeps per-comment branch and worktreePath when comments differ across worktrees", () => {
    const msg = formatReviewMessage({
      comments: [
        { file: "a.ts", line: 1, side: "new", body: "One", branch: "feat/a", worktreePath: "/repo/wt-a" },
        { file: "b.ts", line: 2, side: "new", body: "Two", branch: "feat/b", worktreePath: "/repo/wt-b" },
      ],
    });

    const parsed = JSON.parse(extractJsonBlock(msg));
    assert.equal("branch" in parsed, false);
    assert.equal("worktreePath" in parsed, false);
    assert.equal(parsed.comments[0].branch, "feat/a");
    assert.equal(parsed.comments[0].worktreePath, "/repo/wt-a");
    assert.equal(parsed.comments[1].branch, "feat/b");
    assert.equal(parsed.comments[1].worktreePath, "/repo/wt-b");
  });

  it("hoists branch independently when only branch is uniform and worktreePath varies", () => {
    const msg = formatReviewMessage({
      comments: [
        { file: "a.ts", line: 1, side: "new", body: "One", branch: "main", worktreePath: "/repo/a" },
        { file: "b.ts", line: 2, side: "new", body: "Two", branch: "main" },
      ],
    });

    const parsed = JSON.parse(extractJsonBlock(msg));
    assert.equal(parsed.branch, "main");
    assert.equal("worktreePath" in parsed, false);
    assert.equal("branch" in parsed.comments[0], false);
    assert.equal(parsed.comments[0].worktreePath, "/repo/a");
    assert.equal("worktreePath" in parsed.comments[1], false);
  });
});
