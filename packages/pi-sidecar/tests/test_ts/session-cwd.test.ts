/**
 * Sidecar session-cwd ALS (#768).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWithSessionCwd, SESSION_CWD_ALS_ID } from "../../src/session-cwd.js";
import {
  getSessionCwd,
  SESSION_CWD_ALS_ID as EXT_ALS_ID,
} from "../../../../extensions/shared/session-cwd.js";

describe("sidecar session cwd (#768)", () => {
  it("runWithSessionCwd returns the callback result", () => {
    assert.equal(runWithSessionCwd("/tmp/job-sidecar", () => 42), 42);
  });

  it("keeps cwd bound across an awaited tick", async () => {
    const seen = await runWithSessionCwd("/tmp/job-sidecar", async () => {
      await Promise.resolve();
      return getSessionCwd();
    });
    assert.equal(seen, "/tmp/job-sidecar");
  });

  it("shares ALS with extensions/shared/session-cwd.ts", () => {
    assert.equal(SESSION_CWD_ALS_ID, EXT_ALS_ID);
    const seen = runWithSessionCwd("/tmp/sidecar-job", () => getSessionCwd());
    assert.equal(seen, "/tmp/sidecar-job");
  });
});
