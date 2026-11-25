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
import { killAllJobs, openAsyncStatusOverlay, type AsyncStatusJobView, type AsyncStatusUiDeps } from "../../../extensions/orchestrator/async-status-ui.js";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fakeCommandCtx, fakeCustom, type FakeCustomFactory } from "../helpers/fake-extension-ctx.js";

type Job = AsyncStatusJobView;

function job(id: string, status = "running"): Job {
  return { id, agent: `agent-${id}`, name: `agent-${id}`, task: `task ${id}`, status, workerDir: `/tmp/${id}`, startedAt: 0 };
}

const deps = (jobs: Job[], killJob: AsyncStatusUiDeps["killJob"]): AsyncStatusUiDeps =>
  ({ listJobs: () => jobs, killJob, formatDuration: (ms: number) => `${ms}ms` });

/** A ctx that records `ui.notify`; typed by the real context so the calls are checked. */
function ctx() {
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  return {
    notifications,
    ctx: fakeCommandCtx({ notify: (message: string, level?: "info" | "warning" | "error") => { notifications.push({ message, level }); } }),
  };
}

describe("selection kill (x on Space-picked rows)", () => {
  /** The real overlay with a mocked `ctx.ui.custom`, so `x` reaches the real onXSelected. */
  function ui(opens: string[] | string[][]) {
    const scripts = Array.isArray(opens[0])
      ? (opens as string[][])
      : [[...(opens as string[]), "close"]];
    const notifications: Array<{ message: string; level: string | undefined }> = [];
    const lastFrames: string[] = [];
    let opened = 0;
    const custom = (<T,>(factory: FakeCustomFactory<T>) => {
      const idx = opened++;
      const keys = scripts[idx] ?? ["close"];
      return fakeCustom(factory, keys, {
        onOpen: (comp) => { lastFrames[idx] = (comp.render?.(100) ?? []).join("\n"); },
        onKey: (_k, _d, comp) => { lastFrames[idx] = (comp.render?.(100) ?? []).join("\n"); },
      });
    }) satisfies ExtensionUIContext["custom"];
    return {
      notifications,
      lastFrames,
      ctx: fakeCommandCtx({
        notify: (message: string, level?: "info" | "warning" | "error") => notifications.push({ message, level }),
        custom,
      }),
    };
  }

  it("kills every selected job and reports the count once", async () => {
    const h = ui([" ", "j", " ", "x"]);
    const killed: string[] = [];
    await openAsyncStatusOverlay(h.ctx, deps([job("a"), job("b"), job("c")], (id) => {
      killed.push(id);
      return { killed: [`agent-${id}`], errors: [] };
    }));
    assert.deepEqual(killed, ["a", "b"]);
    assert.deepEqual(h.notifications, [{ message: "killed 2 async agents", level: "info" }]);
  });

  it("names a job whose selection kill failed instead of reporting a clean sweep", async () => {
    const h = ui([" ", "j", " ", "x"]);
    await openAsyncStatusOverlay(h.ctx, deps([job("a"), job("b")], (id) =>
      id === "b"
        ? { killed: [], errors: ["Could not stop agent-b (pid 1 still running)."] }
        : { killed: [`agent-${id}`], errors: [] },
    ));
    assert.deepEqual(h.notifications, [
      {
        message: "killed 1 of 2 async agents — failed: b: Could not stop agent-b (pid 1 still running).",
        level: "warning",
      },
    ]);
  });

  it("shows an inline notice when x is pressed on a selection of only finished jobs (#1391)", async () => {
    const h = ui([" ", "j", " ", "x"]);
    let killCalls = 0;
    await openAsyncStatusOverlay(
      h.ctx,
      deps([job("a", "complete"), job("b", "failed")], () => {
        killCalls++;
        return { killed: [], errors: [] };
      }),
    );
    assert.equal(killCalls, 0);
    assert.deepEqual(h.notifications, [{ message: "No active jobs in selection.", level: "info" }]);
    assert.match(h.lastFrames[0], /ℹ No active jobs in selection\./);
  });

  it("preserves multi-selection across Enter -> detail -> Esc (#1391)", async () => {
    const h = ui([
      [" ", "j", " ", "\r"],
      ["\x1b"],
      ["x", "close"],
    ]);
    const killed: string[] = [];
    await openAsyncStatusOverlay(h.ctx, deps([job("a"), job("b")], (id) => {
      killed.push(id);
      return { killed: [`agent-${id}`], errors: [] };
    }));
    assert.deepEqual(killed, ["a", "b"]);
  });
});

describe("killAllJobs", () => {
  it("attempts later jobs after one throws and reports partial failure", () => {
    const { ctx: c, notifications } = ctx();
    const attempted: string[] = [];
    const jobs = [job("a"), job("b"), job("c")];

    killAllJobs(c, deps(jobs, (id: string) => {
      attempted.push(id);
      if (id === "b") throw new Error("spawn failure");
      return { killed: [`agent-${id}`], errors: [] };
    }));

    assert.deepEqual(attempted, ["a", "b", "c"],
      "a throw on b must not stop c from being attempted");
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /Killed 2 of 3 async agents — 1 failed/,
      "the notification must describe the partial result");
    assert.equal(notifications[0].level, "warning");
  });

  it("counts a reported signalling error as a failure, not a successful kill", () => {
    // Regression: killAsyncAgent swallowed a failed SIGKILL and marked the job failed, so
    // the bulk notification claimed a kill while the worker was still running.
    const { ctx: c, notifications } = ctx();
    const jobs = [job("a"), job("b")];

    killAllJobs(c, deps(jobs, (id: string) =>
      id === "a"
        ? { killed: [], errors: ["Could not stop agent-a (pid 4242 still running)."] }
        : { killed: ["agent-b"], errors: [] },
    ));

    assert.match(notifications[0].message, /Killed 1 of 2 async agents — 1 failed/,
      "a non-throwing signalling failure must not be counted as killed");
  });

  it("reports full success when every kill succeeds", () => {
    const { ctx: c, notifications } = ctx();
    const jobs = [job("a"), job("b")];

    killAllJobs(c, deps(jobs, (id: string) => ({ killed: [`agent-${id}`], errors: [] })));

    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /Killed 2 async agents\./);
    assert.equal(notifications[0].level, "info");
  });

  it("only targets active jobs", () => {
    const { ctx: c, notifications } = ctx();
    const attempted: string[] = [];
    const jobs = [job("a"), job("b", "failed"), job("c", "completed")];

    killAllJobs(c, deps(jobs, (id: string) => {
      attempted.push(id);
      return { killed: [], errors: [] };
    }));

    assert.deepEqual(attempted, ["a"], "only running or queued jobs are killed");
    assert.match(notifications[0].message, /Killed 1 async agent\./);
  });

  it("tells the user when there is nothing to kill", () => {
    const { ctx: c, notifications } = ctx();
    killAllJobs(c, deps([job("a", "completed")], () => ({ killed: [], errors: [] })));

    assert.match(notifications[0].message, /No running async agents to kill\./);
  });
});
