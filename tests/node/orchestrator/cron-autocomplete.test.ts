import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterCronTasksByScope,
  formatCronScheduleInput,
  nextCronScopeFilter,
  parseCronScheduleInput,
  type CronStatusTaskView,
} from "../../../extensions/orchestrator/cron-status-format.js";

describe("parseCronScheduleInput (#1392)", () => {
  it("parses interval units", () => {
    assert.deepEqual(parseCronScheduleInput("30s"), { ok: true, schedule: { interval_seconds: 30 } });
    assert.deepEqual(parseCronScheduleInput("5m"), { ok: true, schedule: { interval_seconds: 300 } });
    assert.deepEqual(parseCronScheduleInput("2h"), { ok: true, schedule: { interval_seconds: 7200 } });
    assert.deepEqual(parseCronScheduleInput("1h30m"), { ok: true, schedule: { interval_seconds: 5400 } });
    assert.deepEqual(parseCronScheduleInput("every 15m"), { ok: true, schedule: { interval_seconds: 900 } });
    assert.deepEqual(parseCronScheduleInput("45"), { ok: true, schedule: { interval_seconds: 45 } });
  });

  it("parses daily HH:MM schedules", () => {
    assert.deepEqual(parseCronScheduleInput("09:30"), { ok: true, schedule: { at_hour: 9, at_minute: 30 } });
    assert.deepEqual(parseCronScheduleInput("at 23:59"), { ok: true, schedule: { at_hour: 23, at_minute: 59 } });
    assert.deepEqual(parseCronScheduleInput("daily at 00:00"), { ok: true, schedule: { at_hour: 0, at_minute: 0 } });
  });

  it("rejects intervals below 10 seconds", () => {
    assert.equal(parseCronScheduleInput("5s").ok, false);
    assert.equal(parseCronScheduleInput("9").ok, false);
  });

  it("rejects out-of-range times and invalid text", () => {
    assert.equal(parseCronScheduleInput("24:00").ok, false);
    assert.equal(parseCronScheduleInput("12:60").ok, false);
    assert.equal(parseCronScheduleInput("soon").ok, false);
    assert.equal(parseCronScheduleInput("").ok, false);
  });
});

describe("formatCronScheduleInput (#1392)", () => {
  it("formats interval tasks into editable shorthand", () => {
    assert.equal(formatCronScheduleInput({ intervalMs: 30_000 }), "30s");
    assert.equal(formatCronScheduleInput({ intervalMs: 300_000 }), "5m");
    assert.equal(formatCronScheduleInput({ intervalMs: 5_400_000 }), "1h30m");
  });

  it("formats daily tasks as HH:MM", () => {
    assert.equal(formatCronScheduleInput({ atHour: 9, atMinute: 5 }), "09:05");
  });
});

describe("cron scope filter cycle (#1392)", () => {
  it("cycles all -> session -> persist -> all", () => {
    assert.equal(nextCronScopeFilter("all"), "session");
    assert.equal(nextCronScopeFilter("session"), "persist");
    assert.equal(nextCronScopeFilter("persist"), "all");
  });

  it("filters views by scope", () => {
    const base = { description: "d", task: "t", createdAt: 1, intervalMs: 60_000 };
    const rows: CronStatusTaskView[] = [
      { ...base, id: "session:1", taskId: "session:1", isLocal: true },
      { ...base, id: "persist:2", taskId: "persist:2", isLocal: false },
    ];
    assert.deepEqual(filterCronTasksByScope(rows, "all").map((r) => r.id), ["session:1", "persist:2"]);
    assert.deepEqual(filterCronTasksByScope(rows, "session").map((r) => r.id), ["session:1"]);
    assert.deepEqual(filterCronTasksByScope(rows, "persist").map((r) => r.id), ["persist:2"]);
  });
});
