import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCronSchedule,
  formatLastRunLabel,
  formatNextRunLabel,
  resolveNextRunAt,
  toCronStatusTaskView,
} from "../../../extensions/orchestrator/cron-status-format.ts";

function sample(overrides: Record<string, unknown> = {}) {
  return toCronStatusTaskView(
    {
      id: 1,
      description: "x",
      task: "y",
      createdAt: 0,
      ...overrides,
    } as any,
    { overlayId: "1", isLocal: true },
  );
}

describe("formatCronSchedule", () => {
  it("formats interval", () => {
    assert.equal(formatCronSchedule(sample({ intervalMs: 30000 })), "every 30s");
  });

  it("formats daily time", () => {
    assert.equal(
      formatCronSchedule(sample({ atHour: 9, atMinute: 5 })),
      "daily at 09:05",
    );
  });
});

describe("resolveNextRunAt / labels", () => {
  it("uses nextRun when set", () => {
    const now = 1_000_000;
    const task = sample({ nextRun: now + 45_000 });
    assert.equal(resolveNextRunAt(task, now), now + 45_000);
    assert.equal(formatNextRunLabel(task, now), "in 45s");
  });

  it("derives interval next from lastRun", () => {
    const now = 1_000_000;
    const lastRun = now - 10_000;
    assert.equal(
      resolveNextRunAt(sample({ intervalMs: 60_000, lastRun }), now),
      lastRun + 60_000,
    );
  });

  it("formats never for missing lastRun", () => {
    assert.equal(formatLastRunLabel(sample()), "never");
  });
});

describe("toCronStatusTaskView", () => {
  it("builds unique overlay id for list-all", () => {
    const v = toCronStatusTaskView(
      {
        id: 3,
        description: "d",
        task: "t",
        createdAt: 1,
      },
      {
        overlayId: "cron-1-abc.json:3",
        sessionLabel: "PID 1",
        isLocal: false,
        cronFile: "/tmp/cron-1-abc.json",
      },
    );
    assert.equal(v.id, "cron-1-abc.json:3");
    assert.equal(v.taskId, "cron-1-abc.json:3");
    assert.equal(v.isLocal, false);
  });
});
