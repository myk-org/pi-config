/**
 * Forum board planning.
 *
 * The board is a list users scan, so the two failures that matter are invisible
 * in a screenshot: a session getting two posts, and a picker option pointing at
 * a session that is not on the board.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BOARD_SELECT_LIMIT, boardLabel, planBoard } from "../../../extensions/pidash/discord-board.ts";

const sessions = [
  { sessionId: "1:/a", label: "repo-a" },
  { sessionId: "2:/b", label: "repo-b" },
  { sessionId: "3:/c", label: "repo-c" },
];

describe("board planning", () => {
  it("creates a post for every session when none exist", () => {
    const plan = planBoard(sessions, {});
    assert.deepEqual(plan.toCreate.map((s) => s.sessionId), ["1:/a", "2:/b", "3:/c"]);
    assert.equal(plan.total, 3);
    assert.equal(plan.existing, 0);
  });

  it("skips sessions that already have a post", () => {
    const plan = planBoard(sessions, { "2:/b": "thread-b" });
    assert.deepEqual(plan.toCreate.map((s) => s.sessionId), ["1:/a", "3:/c"], "re-running must not duplicate");
    assert.equal(plan.existing, 1);
  });

  it("never creates a post twice for the same session", () => {
    const plan = planBoard([...sessions, { sessionId: "1:/a", label: "repo-a again" }], {});
    assert.equal(plan.total, 3);
    assert.equal(plan.toCreate.length, 3);
  });

  it("offers an option for every session", () => {
    const plan = planBoard(sessions, { "1:/a": "t" });
    assert.deepEqual(plan.options, [
      { label: "repo-a", value: "1:/a" },
      { label: "repo-b", value: "2:/b" },
      { label: "repo-c", value: "3:/c" },
    ]);
  });

  it("caps the picker at Discord's select limit", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ sessionId: `${i}:/r`, label: `repo-${i}` }));
    const plan = planBoard(many, {});
    assert.equal(plan.options.length, BOARD_SELECT_LIMIT);
    assert.equal(plan.total, 40, "the count still reports everything");
    assert.equal(plan.toCreate.length, 40, "posts are created for all of them");
  });

  it("handles an empty board", () => {
    const plan = planBoard([], {});
    assert.deepEqual(plan, { toCreate: [], options: [], total: 0, existing: 0 });
  });

  it("drops sessions without an id", () => {
    const plan = planBoard([{ sessionId: "", label: "ghost" }, ...sessions], {});
    assert.equal(plan.total, 3);
  });
});

describe("board labels", () => {
  it("keeps a short label as-is", () => {
    assert.equal(boardLabel("repo-a"), "repo-a");
  });

  it("truncates a long label", () => {
    const label = boardLabel("x".repeat(200));
    assert.equal(label.length, 90);
    assert.ok(label.endsWith("…"));
  });

  it("falls back for a blank label", () => {
    assert.equal(boardLabel("   "), "session");
  });
});
