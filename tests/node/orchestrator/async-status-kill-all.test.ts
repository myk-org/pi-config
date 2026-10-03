/**
 * Bulk-kill behaviour of the real killAllJobs.
 *
 * The overlay test swaps the bulk-kill callback for a counter, so it can prove the key
 * dispatches but says nothing about what killAllJobs actually does. These drive the real
 * function so the failure paths — a kill that throws, and a kill that reports signalling
 * errors without throwing — are covered rather than assumed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { killAllJobs } from "../../../extensions/orchestrator/async-status-ui.js";

type Job = { id: string; name: string; status: string };

function job(id: string, status = "running"): Job {
  return { id, name: `agent-${id}`, status };
}

function ctx() {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  };
}

describe("killAllJobs", () => {
  it("attempts later jobs after one throws and reports partial failure", () => {
    const c = ctx();
    const attempted: string[] = [];
    const jobs = [job("a"), job("b"), job("c")];

    killAllJobs(c as any, {
      listJobs: () => jobs as any,
      killJob: (id: string) => {
        attempted.push(id);
        if (id === "b") throw new Error("spawn failure");
        return { killed: [`agent-${id}`], errors: [] };
      },
    } as any);

    assert.deepEqual(attempted, ["a", "b", "c"],
      "a throw on b must not stop c from being attempted");
    assert.equal(c.notifications.length, 1);
    assert.match(c.notifications[0].message, /Killed 2 of 3 async agents — 1 failed/,
      "the notification must describe the partial result");
    assert.equal(c.notifications[0].level, "warning");
  });

  it("counts a reported signalling error as a failure, not a successful kill", () => {
    // Regression: killAsyncAgent swallowed a failed SIGKILL and marked the job failed, so
    // the bulk notification claimed a kill while the worker was still running.
    const c = ctx();
    const jobs = [job("a"), job("b")];

    killAllJobs(c as any, {
      listJobs: () => jobs as any,
      killJob: (id: string) =>
        id === "a"
          ? { killed: [], errors: ["Could not stop agent-a (pid 4242 still running)."] }
          : { killed: ["agent-b"], errors: [] },
    } as any);

    assert.match(c.notifications[0].message, /Killed 1 of 2 async agents — 1 failed/,
      "a non-throwing signalling failure must not be counted as killed");
  });

  it("reports full success when every kill succeeds", () => {
    const c = ctx();
    const jobs = [job("a"), job("b")];

    killAllJobs(c as any, {
      listJobs: () => jobs as any,
      killJob: (id: string) => ({ killed: [`agent-${id}`], errors: [] }),
    } as any);

    assert.equal(c.notifications.length, 1);
    assert.match(c.notifications[0].message, /Killed 2 async agents\./);
    assert.equal(c.notifications[0].level, "info");
  });

  it("only targets active jobs", () => {
    const c = ctx();
    const attempted: string[] = [];
    const jobs = [job("a"), job("b", "failed"), job("c", "completed")];

    killAllJobs(c as any, {
      listJobs: () => jobs as any,
      killJob: (id: string) => {
        attempted.push(id);
        return { killed: [], errors: [] };
      },
    } as any);

    assert.deepEqual(attempted, ["a"], "only running or queued jobs are killed");
    assert.match(c.notifications[0].message, /Killed 1 async agent\./);
  });

  it("tells the user when there is nothing to kill", () => {
    const c = ctx();
    killAllJobs(c as any, {
      listJobs: () => [job("a", "completed")] as any,
      killJob: () => ({ killed: [], errors: [] }),
    } as any);

    assert.match(c.notifications[0].message, /No running async agents to kill\./);
  });
});
