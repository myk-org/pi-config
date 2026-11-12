import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideCronArm } from "../../../extensions/orchestrator/cron.ts";

describe("decideCronArm", () => {
  it("skips a paused task, whatever its scope or leadership", () => {
    assert.equal(decideCronArm({ paused: true, scope: "session", leader: true }), "skip");
    assert.equal(decideCronArm({ paused: true, scope: "project", leader: true }), "skip");
    assert.equal(decideCronArm({ paused: true, scope: "project" }), "skip");
  });

  it("arms an active task and still skips a non-leader durable one", () => {
    assert.equal(decideCronArm({ scope: "session", leader: true }), "arm");
    assert.equal(decideCronArm({ scope: "project", leader: true }), "arm");
    assert.equal(decideCronArm({ scope: "project", leader: false }), "skip");
  });
});
