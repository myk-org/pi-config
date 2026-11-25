import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cronDetailRows,
  cronStateLabel,
  formatCronSchedule,
  formatCronStatusSlot,
  formatLastRunLabel,
  formatNextRunLabel,
  resolveNextRunAt,
  toCronStatusTaskView,
} from "../../../extensions/orchestrator/cron-status-format.ts";
import { openCronStatusOverlay } from "../../../extensions/orchestrator/cron-status-ui.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fakeCommandCtx, fakeCustom, type FakeCustomFactory } from "../helpers/fake-extension-ctx.js";

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

describe("formatCronStatusSlot", () => {
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

  it("formats zero crons with muted styling", () => {
    assert.equal(formatCronStatusSlot([], theme), "<muted>⏰ 0 crons</muted>");
  });

  it("formats active crons with muted styling", () => {
    assert.equal(formatCronStatusSlot([{}], theme), "<muted>⏰ 1 cron</muted>");
    assert.equal(formatCronStatusSlot([{}, { paused: false }], theme), "<muted>⏰ 2 crons</muted>");
  });

  it("formats paused crons with warning styling", () => {
    assert.equal(formatCronStatusSlot([{ paused: true }], theme), "<warning>⏸ 1 cron</warning>");
    assert.equal(formatCronStatusSlot([{ paused: true }, { paused: true }], theme), "<warning>⏸ 2 crons</warning>");
  });

  it("formats mixed crons with warning styling on the paused count", () => {
    assert.equal(
      formatCronStatusSlot([{}, { paused: true }, { paused: true }], theme),
      "<muted>⏰ 1 · </muted><warning>⏸ 2</warning>",
    );
  });

  it("returns plain uncolored text when theme is omitted", () => {
    assert.equal(formatCronStatusSlot([]), "⏰ 0 crons");
    assert.equal(formatCronStatusSlot([{}]), "⏰ 1 cron");
    assert.equal(formatCronStatusSlot([{}, {}]), "⏰ 2 crons");
    assert.equal(formatCronStatusSlot([{ paused: true }]), "⏸ 1 cron");
    assert.equal(formatCronStatusSlot([{ paused: true }, { paused: true }]), "⏸ 2 crons");
    assert.equal(formatCronStatusSlot([{}, { paused: true }]), "⏰ 1 · ⏸ 1");
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
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  // `close` is fed last so a test that presses a key the overlay ignores still closes.
  const custom = (<T,>(factory: FakeCustomFactory<T>) => fakeCustom(factory, [...keys, "close"])) satisfies ExtensionUIContext["custom"];
  const ctx = fakeCommandCtx({
    notify: (message: string, level?: "info" | "warning" | "error") => notifications.push({ message, level }),
    custom,
  });
  return { ctx, notifications };
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

  it("renders sessionLabel on rows that define one (#1270)", async () => {
    const tasks = [
      { ...row({ id: "1", description: "with session" }), sessionLabel: "this session" },
      row({ id: "2", description: "without session" }),
    ];
    let rendered = "";
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        custom: async (factory: any) => {
          const fakeTui = { terminal: { rows: 24 }, requestRender: () => {} };
          const fakeTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
          const comp = factory(fakeTui, fakeTheme, {}, () => {});
          try {
            rendered = comp.render(120).join("\n");
          } finally {
            comp.dispose?.();
          }
          return undefined;
        },
      },
    } as any;

    await openCronStatusOverlay(ctx, {
      listTasks: () => tasks,
      removeTask: () => true,
      togglePaused: () => ({ ok: true, paused: true }),
    });

    const lines = rendered.split("\n");
    const withLine = lines.find((l) => l.includes("with session")) ?? "";
    const withoutLine = lines.find((l) => l.includes("without session")) ?? "";
    assert.match(withLine, /this session/);
    assert.doesNotMatch(withoutLine, /this session/);
  });

  it("does not scale listTasks() calls linearly with row count when rendering (#1270)", async () => {
    const measureCalls = async (count: number) => {
      let calls = 0;
      const tasks = Array.from({ length: count }, (_, idx) => ({
        ...row({ id: String(idx + 1), description: `task ${idx + 1}` }),
        sessionLabel: "this session",
      }));
      const ctx = {
        hasUI: true,
        ui: {
          notify: () => {},
          custom: async (factory: any) => {
            const fakeTui = { terminal: { rows: 30 }, requestRender: () => {} };
            const fakeTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
            const comp = factory(fakeTui, fakeTheme, {}, () => {});
            try {
              comp.render(120);
            } finally {
              comp.dispose?.();
            }
            return undefined;
          },
        },
      } as any;
      await openCronStatusOverlay(ctx, {
        listTasks: () => { calls++; return tasks; },
        removeTask: () => true,
        togglePaused: () => ({ ok: true, paused: true }),
      });
      return calls;
    };

    const callsFor1 = await measureCalls(1);
    const callsFor10 = await measureCalls(10);
    assert.equal(callsFor10, callsFor1);
  });
});

describe("openCronStatusOverlay scope filter, persist toggle, add and edit (#1392)", () => {
  it("toggles a single focused session cron to persist on t", async () => {
    const { ctx, notifications } = makeCtx(["t"]);
    const moved: Array<[string, string]> = [];
    await openCronStatusOverlay(ctx, {
      listTasks: () => [{ ...row({ id: "1" }), isLocal: true }],
      removeTask: () => true,
      togglePaused: () => ({ ok: true, paused: false }),
      setScope: (id, scope) => {
        moved.push([id, scope]);
        return { ok: true, scope, id: `persist:1` };
      },
    });
    assert.deepEqual(moved, [["session:1", "project"]]);
    assert.match(notifications[0]?.message ?? "", /Moved #session:1 to persist/);
  });

  it("persists every selected session cron when pressing t on a mixed selection", async () => {
    const { ctx, notifications } = makeCtx([" ", "j", " ", "t"]);
    const moved: Array<[string, string]> = [];
    const tasks = [
      { ...row({ id: "1" }), id: "session:1", taskId: "session:1", isLocal: true },
      { ...row({ id: "2" }), id: "persist:2", taskId: "persist:2", isLocal: false },
    ];
    await openCronStatusOverlay(ctx, {
      listTasks: () => tasks,
      removeTask: () => true,
      togglePaused: () => ({ ok: true, paused: false }),
      setScope: (id, scope) => {
        moved.push([id, scope]);
        return { ok: true, scope, id: `persist:1` };
      },
    });
    assert.deepEqual(moved, [["session:1", "project"]]);
    assert.match(notifications[0]?.message ?? "", /persisted 2 crons/i);
  });

  it("moves every selected persisted cron to session when pressing t on all-persist selection", async () => {
    const { ctx, notifications } = makeCtx([" ", "j", " ", "t"]);
    const moved: Array<[string, string]> = [];
    const tasks = [
      { ...row({ id: "1" }), id: "persist:1", taskId: "persist:1", isLocal: false },
      { ...row({ id: "2" }), id: "persist:2", taskId: "persist:2", isLocal: false },
    ];
    await openCronStatusOverlay(ctx, {
      listTasks: () => tasks,
      removeTask: () => true,
      togglePaused: () => ({ ok: true, paused: false }),
      setScope: (id, scope) => {
        moved.push([id, scope]);
        return { ok: true, scope, id: id.replace("persist:", "session:") };
      },
    });
    assert.deepEqual(moved, [["persist:1", "session"], ["persist:2", "session"]]);
    assert.match(notifications[0]?.message ?? "", /moved to session 2 crons/i);
  });

  it("cycles all -> session -> persist scope filter on f", async () => {
    const tasks = [
      { ...row({ id: "1", description: "sess-only" }), id: "session:1", taskId: "session:1", isLocal: true },
      { ...row({ id: "2", description: "pers-only" }), id: "persist:2", taskId: "persist:2", isLocal: false },
    ];
    const renders: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        custom: async (factory: any) => {
          const fakeTui = { terminal: { rows: 24 }, requestRender: () => {} };
          const fakeTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
          const comp = factory(fakeTui, fakeTheme, { matches: () => false }, () => {});
          try {
            renders.push(comp.render(120).join("\n"));
            comp.handleInput("f");
            renders.push(comp.render(120).join("\n"));
            comp.handleInput("f");
            renders.push(comp.render(120).join("\n"));
          } finally {
            comp.dispose?.();
          }
          return null;
        },
      },
    } as any;
    await openCronStatusOverlay(ctx, {
      listTasks: () => tasks,
      removeTask: () => true,
      togglePaused: () => ({ ok: true, paused: false }),
    });
    assert.match(renders[0], /sess-only/);
    assert.match(renders[0], /pers-only/);
    assert.match(renders[1], /sess-only/);
    assert.doesNotMatch(renders[1], /pers-only/);
    assert.doesNotMatch(renders[2], /sess-only/);
    assert.match(renders[2], /pers-only/);
  });

  it("adds a new cron via n dialog", async () => {
    const added: any[] = [];
    const answers = ["Check CI", "10m", "CI watch", "y", "google/gemini-2.5-flash"];
    let open = 0;
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        custom: async (factory: any) => {
          open++;
          if (open === 1) {
            return await new Promise((resolve) => {
              const fakeTui = { terminal: { rows: 24 }, requestRender: () => {} };
              const fakeTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
              const comp = factory(fakeTui, fakeTheme, { matches: () => false }, (v: any) => resolve(v));
              comp.handleInput("n");
              comp.dispose?.();
            });
          }
          if (open >= 2 && open <= 6) {
            return answers[open - 2];
          }
          return null;
        },
      },
    } as any;
    await openCronStatusOverlay(ctx, {
      listTasks: () => [],
      removeTask: () => true,
      togglePaused: () => ({ ok: true, paused: false }),
      addTask: (input) => {
        added.push(input);
        return { ok: true, id: "persist:new-1" };
      },
    });
    assert.deepEqual(added, [
      {
        scope: "project",
        task: "Check CI",
        description: "CI watch",
        model: "google/gemini-2.5-flash",
        interval_seconds: 600,
      },
    ]);
  });

  it("edits the focused cron via e dialog", async () => {
    const edited: Array<[string, any]> = [];
    const answers = ["Updated desc", "Updated prompt", "15m", ""];
    let open = 0;
    const existing = {
      ...row({ id: "1", description: "Old desc", task: "Old prompt", intervalMs: 60_000, model: "google/gemini-2.5-flash" }),
      isLocal: true,
    };
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        custom: async (factory: any) => {
          open++;
          if (open === 1) {
            return await new Promise((resolve) => {
              const fakeTui = { terminal: { rows: 24 }, requestRender: () => {} };
              const fakeTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
              const comp = factory(fakeTui, fakeTheme, { matches: () => false }, (v: any) => resolve(v));
              comp.handleInput("e");
              comp.dispose?.();
            });
          }
          if (open >= 2 && open <= 5) {
            return answers[open - 2];
          }
          return null;
        },
      },
    } as any;
    await openCronStatusOverlay(ctx, {
      listTasks: () => [existing],
      removeTask: () => true,
      togglePaused: () => ({ ok: true, paused: false }),
      editTask: (id, patch) => {
        edited.push([id, patch]);
        return { ok: true, id };
      },
    });
    assert.deepEqual(edited, [
      [
        "session:1",
        {
          description: "Updated desc",
          task: "Updated prompt",
          interval_seconds: 900,
          model: "",
        },
      ],
    ]);
  });
});
