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
 *  receives the keystrokes, which is where `p` lives (#1089). */
function makeCtx(keys: string[] = ["p"]) {
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
          for (const key of keys) component.handleInput(key);
          component.handleInput("close");
        }),
    },
  };
  return { ctx: ctx as any, notifications };
}

/** One view per distinct id: the overlay row id is the scope-qualified key, so a helper that
 *  reused one overlayId would give every row the same id and make multi-select untestable. */
const row = (overrides: Record<string, unknown> = {}) => {
  const id = String(overrides.id ?? "1");
  return toCronStatusTaskView(
    { id, description: "x", task: "y", createdAt: 0, ...overrides } as any,
    { overlayId: `session:${id}` },
  );
};

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

describe("openCronStatusOverlay multi-select (#1087)", () => {
  const three = () => [row(), row({ id: "2" }), row({ id: "3" })];

  it("x removes exactly the selected crons and reports once", async () => {
    // Space #1, j, Space #2, j to #3 (not selected), x, close.
    const { ctx, notifications } = makeCtx([" ", "j", " ", "j", "x"]);
    const removed: string[] = [];
    await openCronStatusOverlay(ctx, {
      listTasks: () => three().filter((r) => !removed.includes(r.id)),
      removeTask: (id) => { removed.push(id); return true; },
      togglePaused: () => ({ ok: true, paused: true }),
    });
    assert.deepEqual(removed, ["session:1", "session:2"], "the focused-but-unselected #3 is untouched");
    assert.deepEqual(notifications, [{ message: "removed 2 crons", level: "info" }]);
  });

  it("names a cron whose removal was rejected", async () => {
    const { ctx, notifications } = makeCtx([" ", "j", " ", "x"]);
    await openCronStatusOverlay(ctx, {
      listTasks: three,
      removeTask: (id) => id !== "session:2",
      togglePaused: () => ({ ok: true, paused: true }),
    });
    assert.deepEqual(notifications, [
      { message: "removed 1 of 2 crons — failed: #session:2", level: "warning" },
    ]);
  });

  it("keeps removing after one removal throws", async () => {
    // A store write-lock timeout on #1 must not abandon #2 the user also selected.
    const { ctx, notifications } = makeCtx([" ", "j", " ", "x"]);
    const removed: string[] = [];
    await openCronStatusOverlay(ctx, {
      listTasks: three,
      removeTask: (id) => {
        if (id === "session:1") throw new Error("store is locked");
        removed.push(id);
        return true;
      },
      togglePaused: () => ({ ok: true, paused: true }),
    });
    assert.deepEqual(removed, ["session:2"], "the throw did not abort the remaining removal");
    assert.deepEqual(notifications, [
      { message: "removed 1 of 2 crons — failed: #session:1", level: "warning" },
    ]);
  });

  it("p on a mixed selection pauses every selected cron", async () => {
    const { ctx, notifications } = makeCtx([" ", "j", " ", "p"]);
    const pressed: string[] = [];
    await openCronStatusOverlay(ctx, {
      listTasks: () => [row(), row({ id: "2", paused: true }), row({ id: "3" })],
      removeTask: () => true,
      togglePaused: (id) => { pressed.push(id); return { ok: true, paused: true }; },
    });
    // #1 was active so the group pauses; #2 is already paused, so it needs no write.
    assert.deepEqual(pressed, ["session:1"]);
    assert.deepEqual(notifications, [{ message: "paused 2 crons", level: "info" }]);
  });

  it("p on an all-paused selection resumes every selected cron", async () => {
    const { ctx, notifications } = makeCtx([" ", "j", " ", "p"]);
    const pressed: string[] = [];
    await openCronStatusOverlay(ctx, {
      listTasks: () => [row({ paused: true }), row({ id: "2", paused: true }), row({ id: "3" })],
      removeTask: () => true,
      togglePaused: (id) => { pressed.push(id); return { ok: true, paused: false }; },
    });
    assert.deepEqual(pressed, ["session:1", "session:2"]);
    assert.deepEqual(notifications, [{ message: "resumed 2 crons", level: "info" }]);
  });

  it("names a cron whose pause write failed, instead of claiming the whole group", async () => {
    const { ctx, notifications } = makeCtx([" ", "j", " ", "p"]);
    await openCronStatusOverlay(ctx, {
      listTasks: () => [row(), row({ id: "2" })],
      removeTask: () => true,
      togglePaused: (id) => ({ ok: id !== "session:1", paused: true }),
    });
    assert.deepEqual(notifications, [
      { message: "paused 1 of 2 crons — failed: #session:1", level: "warning" },
    ]);
  });
});
