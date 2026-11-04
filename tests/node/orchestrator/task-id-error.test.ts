/**
 * Task-id rejection message (issue #1016).
 *
 * `taskIdError` is the decision the guard makes for every async spawn: reject an id the
 * store does not know, exempt the `-1` read-only sentinel, and stay silent when the id
 * resolves. It had no test while shipping a behaviour change, so it has one now.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { taskIdError } from "../../../extensions/orchestrator/subagent-tool.ts";

const known = (ids: string[]) => (id: string) => ids.includes(id);

describe("taskIdError", () => {
  it("rejects an id the store does not know", () => {
    const message = taskIdError("99997", known(["1", "2"]));
    assert.ok(message?.includes("Task #99997 not found"));
    assert.ok(message?.includes('pass taskId: "-1" for a read-only check'));
  });

  it("accepts an id the store knows", () => {
    assert.equal(taskIdError("2", known(["1", "2"])), null);
  });

  it("exempts the -1 read-only sentinel without consulting the store", () => {
    let consulted = false;
    const lookup = () => {
      consulted = true;
      return false;
    };
    assert.equal(taskIdError("-1", lookup), null);
    assert.equal(consulted, false, "the sentinel must not hit the store");
  });
});
