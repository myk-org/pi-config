import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cronDetailRows,
  cronStateLabel,
  formatCronSchedule,
  formatLastRunLabel,
  formatNextRunLabel,
  resolveNextRunAt,
  toCronStatusTaskView,
} from "../../../extensions/orchestrator/cron-status-format.ts";
import { openCronStatusOverlay } from "../../../extensions/orchestrator/cron-status-ui.ts";

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

describe("cronDetailRows", () => {
  it("adds a Model row when the task pins a model", () => {
    const rows = cronDetailRows(sample({ model: "openrouter/anthropic/claude-opus-5" }));
    assert.deepEqual(rows.filter(([label]) => label === "Model"), [
      ["Model", "openrouter/anthropic/claude-opus-5"],
    ]);
  });

  it("omits the Model row when the task inherits its model", () => {
    assert.equal(
      cronDetailRows(sample()).some(([label]) => label === "Model"),
      false,
    );
  });

  it("always renders the four base rows", () => {
    const rows = cronDetailRows(sample({ intervalMs: 60_000 }), 1_000_000).map(
      ([label]) => label,
    );
    assert.deepEqual(rows, ["Schedule", "Last run", "Next run", "Created"]);
  });
});

describe("cronStateLabel", () => {
  it("marks a paused cron", () => {
    assert.equal(cronStateLabel({ paused: true, leader: true }), "⏸ paused");
  });

  it("leaves the active text alone", () => {
    assert.equal(cronStateLabel({ paused: false }), "active");
    assert.equal(cronStateLabel({}), "active");
  });

  it("names a non-leader replica", () => {
    assert.equal(cronStateLabel({ leader: false }), "waiting for leader");
  });

  it("carries paused through the overlay view", () => {
    const view = (overrides: Record<string, unknown>) =>
      toCronStatusTaskView({ id: 1, description: "x", task: "y", createdAt: 0, ...overrides } as any, { overlayId: "1" });
    assert.equal(view({ paused: true }).paused, true);
    assert.equal(view({}).paused, undefined);
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

/** Only input handling is exercised: `ctx.ui.custom` is mocked so the real OverlayListDashboard
 *  receives the keystroke, which is where `p` lives (#1089). */
function makeCtx() {
  const notifications: Array<{ message: string; level: string }> = [];
  const tui = { terminal: { rows: 20 }, requestRender: () => {} };
  // `close` is the cancel keybinding the dashboard really checks.
  const keybindings = { matches: (data: string, action: string) => action === "tui.select.cancel" && data === "close" };
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      custom: async (factory: any) =>
        new Promise((resolve) => {
          const component = factory(tui, {}, keybindings, resolve);
          component.handleInput("p");
          component.handleInput("close");
        }),
    },
  };
  return { ctx: ctx as any, notifications };
}

const row = (overrides: Record<string, unknown> = {}) =>
  toCronStatusTaskView(
    { id: "1", description: "x", task: "y", createdAt: 0, ...overrides } as any,
    { overlayId: "session:1" },
  );

describe("openCronStatusOverlay pause key (#1089)", () => {
  it("toggles the focused row", async () => {
    const { ctx, notifications } = makeCtx();
    const toggled: string[] = [];
    await openCronStatusOverlay(ctx, {
      listTasks: () => [row(), row({ id: "2" })],
      removeTask: () => true,
      togglePaused: (id) => { toggled.push(id); return { ok: true, paused: true }; },
    });
    assert.deepEqual(toggled, ["session:1"]);
    assert.deepEqual(notifications, []);
  });

  it("warns instead of showing a pause the store never accepted", async () => {
    const { ctx, notifications } = makeCtx();
    await openCronStatusOverlay(ctx, {
      listTasks: () => [row()],
      removeTask: () => true,
      togglePaused: () => ({ ok: false, paused: false }),
    });
    assert.deepEqual(notifications, [{ message: "Could not save the pause state of #session:1.", level: "warning" }]);
  });
});
