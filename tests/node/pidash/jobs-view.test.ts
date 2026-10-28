/**
 * `/async` and `/cron` layout.
 *
 * The view is pure so the phone-facing shape can be asserted: a long list must
 * not exceed Discord's limit, and Stop buttons only appear when every job has
 * one (a partial row would be a lie about what can be stopped).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatNextRun, jobIdAt, renderJobsView } from "../../../extensions/pidash/discord-jobs-view.ts";

describe("async/cron list rendering", () => {
  it("says so when nothing is running", () => {
    assert.equal(renderJobsView("async", { count: 0, jobs: [] }).content, "No async agents running.");
    assert.equal(renderJobsView("cron", { count: 0, tasks: [] }).content, "No cron jobs scheduled.");
  });

  it("numbers async agents with status and task", () => {
    const view = renderJobsView("async", {
      count: 2,
      jobs: [
        { id: "a1", name: "reviewer", status: "running", task: "review PR 977" },
        { id: "a2", name: "tester", status: "done", task: "run suites" },
      ],
    });
    assert.match(view.content, /\*\*Async agents\*\* \(2\)/);
    assert.match(view.content, /1\. \*\*reviewer\*\* — running\n   review PR 977/);
    assert.deepEqual(view.stoppable, ["a1", "a2"]);
  });

  it("renders cron schedules and next run", () => {
    const view = renderJobsView("cron", {
      count: 1,
      tasks: [{ id: "c1", description: "nightly dream", schedule: "every 24h", nextRun: "in 3h" }],
    });
    assert.match(view.content, /\*\*Cron jobs\*\* \(1\)/);
    assert.match(view.content, /nightly dream/);
    assert.match(view.content, /every 24h/);
    assert.match(view.content, /next in 3h/);
    assert.deepEqual(view.stoppable, ["c1"]);
  });

  it("truncates a long list and drops the buttons", () => {
    const jobs = Array.from({ length: 20 }, (_, i) => ({ id: `j${i}`, name: `agent-${i}`, status: "running", task: "x" }));
    const view = renderJobsView("async", { count: 20, jobs });
    assert.match(view.content, /…and 5 more/);
    assert.ok(view.content.length <= 1900, `content was ${view.content.length} chars`);
    assert.deepEqual(view.stoppable, [], "20 jobs cannot each get a button");
  });

  it("keeps buttons when every job fits", () => {
    const jobs = Array.from({ length: 5 }, (_, i) => ({ id: `j${i}`, name: `agent-${i}`, status: "running" }));
    assert.equal(renderJobsView("async", { count: 5, jobs }).stoppable.length, 5);
  });

  it("survives a snapshot with no count", () => {
    const view = renderJobsView("cron", { tasks: [{ id: "c1", description: "job" }] });
    assert.match(view.content, /\(1\)/, "count falls back to the item list");
  });
});

describe("cron next-run formatting", () => {
  it("renders a millisecond timestamp as a readable UTC time", () => {
    assert.equal(formatNextRun(1_767_000_000_000), "2025-12-29 09:20 UTC");
  });

  it("passes through an already formatted label", () => {
    assert.equal(formatNextRun("every 24h"), "every 24h");
  });

  it("shows nothing for a missing value", () => {
    assert.equal(formatNextRun(undefined), "");
    assert.equal(formatNextRun(null), "");
  });

  it("puts the formatted time in the cron line", () => {
    const view = renderJobsView("cron", {
      count: 1,
      tasks: [{ id: "c1", description: "nightly", schedule: "0 3 * * *", nextRun: 1_767_000_000_000 }],
    });
    assert.match(view.content, /next 2025-12-29 09:20 UTC/);
    assert.doesNotMatch(view.content, /1767000000000/);
  });
});

describe("stop button resolution", () => {
  // The session id contains a colon, so parsing it back out of a customId picked
  // the wrong session; buttons resolve by index instead.
  const stoppable = ["job-a", "job-b"];

  it("returns the job at an index", () => {
    assert.equal(jobIdAt(stoppable, 0), "job-a");
    assert.equal(jobIdAt(stoppable, 1), "job-b");
  });

  it("refuses an out-of-range or malformed index", () => {
    assert.equal(jobIdAt(stoppable, 2), null);
    assert.equal(jobIdAt(stoppable, -1), null);
    assert.equal(jobIdAt(stoppable, 1.5), null);
    assert.equal(jobIdAt(stoppable, Number.NaN), null);
  });
});
