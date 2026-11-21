import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  TOGGLE_ALL_WIDGETS_EVENT,
  WIDGET_MODE_CHANGED_EVENT,
  WIDGET_VISIBILITY_SYMBOL,
  applyWidgetAction,
  cycleWidgetMode,
  formatComsCollapsedHeader,
  formatComsTopBorder,
  formatWidgetShortcutHint,
  getConfiguredShortcut,
  getDefaultWidgetMode,
  getWidgetMode,
  nextWidgetMode,
  normalizeShortcut,
  normalizeWidgetMode,
  parseWidgetCommandAction,
  registerWidgetShortcut,
  resetWidgetVisibilityState,
  setWidgetMode,
  toggleAllWidgets,
} from "../../../extensions/shared/widget-visibility.js";
import {
  SETTINGS_KEYS,
  clearSettingsCache,
  getSetting,
  setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { TaskWidget } from "../../../extensions/pitasks/task-widget.js";
import { parseTasksCommand, TASKS_HINT, TASKS_USAGE } from "../../../extensions/pitasks/tasks-view.js";
import pitasks from "../../../extensions/pitasks/index.js";
import { registerComs } from "../../../extensions/coms/coms-wrapper.js";
import orchestrator from "../../../extensions/orchestrator/index.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

const createdBy = { type: "local" as const, origin: "system", session: "", project: "" };
const theme = {
  fg: (_color: string, text: string) => text,
  strikethrough: (text: string) => text,
};

interface FakePiHarness {
  pi: ExtensionAPI;
  shortcuts: Map<string, { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }>;
  commands: Map<string, any>;
  eventHandlers: Map<string, Array<(data: unknown) => void>>;
  lifecycleHandlers: Map<string, Array<(event: any, ctx: any) => any>>;
  emitEvent: (name: string, data: unknown) => void;
}

function createFakePi(): FakePiHarness {
  const shortcuts = new Map<string, { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const lifecycleHandlers = new Map<string, Array<(event: any, ctx: any) => any>>();

  const emitEvent = (name: string, data: unknown) => {
    for (const fn of [...(eventHandlers.get(name) ?? [])]) fn(data);
  };

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      const list = lifecycleHandlers.get(event) ?? [];
      list.push(handler);
      lifecycleHandlers.set(event, list);
    },
    registerTool() {},
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    registerShortcut(shortcut: string, options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }) {
      shortcuts.set(shortcut, options);
    },
    registerFlag() {},
    getFlag() { return undefined; },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    registerMarkdownTransformer() {},
    registerToolRenderer() {},
    sendMessage() {},
    appendEntry() {},
    getActiveTools() { return []; },
    setActiveTools() {},
    getCommands() { return []; },
    events: {
      on(name: string, fn: (data: unknown) => void) {
        const list = eventHandlers.get(name) ?? [];
        list.push(fn);
        eventHandlers.set(name, list);
        return () => {
          const cur = eventHandlers.get(name);
          if (!cur) return;
          const idx = cur.indexOf(fn);
          if (idx >= 0) cur.splice(idx, 1);
        };
      },
      emit: emitEvent,
    },
  } as unknown as ExtensionAPI;

  return { pi, shortcuts, commands, eventHandlers, lifecycleHandlers, emitEvent };
}

function makeFakeCtx(cwd: string, overrides: Record<string, any> = {}) {
  const notifications: Array<{ text: string; level: string }> = [];
  const widgetCalls: Array<{ key: string; value: any }> = [];
  let renderFn: ((width: number) => string[]) | null = null;
  const ctx: any = {
    cwd,
    mode: "interactive",
    hasUI: true,
    sessionManager: {
      getSessionId: () => "sess-widget-test",
      getEntries: () => [],
    },
    ui: {
      notify(text: string, level = "info") {
        notifications.push({ text, level });
      },
      setWidget(key: string, value: any) {
        widgetCalls.push({ key, value });
        if (typeof value === "function") {
          const comp = value({ terminal: { columns: 120 }, requestRender() {} }, theme);
          renderFn = (w = 120) => comp.render(w);
        } else if (value === undefined) {
          renderFn = null;
        }
      },
      setStatus() {},
    },
    ...overrides,
  };
  return { ctx, notifications, widgetCalls, getRender: () => renderFn };
}

describe("widget-visibility settings, collapse/expand toggle, shortcuts, and toggle-all", () => {
  let tempDir: string;
  let globalDir: string;
  let globalSettingsPath: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "PI_WIDGET_TASKS_SHORTCUT",
    "PI_WIDGET_COMS_SHORTCUT",
    "PI_WIDGET_ALL_SHORTCUT",
    "PI_WIDGETS_DEFAULT_MODE",
    "PI_TASKS",
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    tempDir = makeTempDir("widget-vis-proj-");
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    globalDir = makeTempDir("widget-vis-global-");
    globalSettingsPath = join(globalDir, "pi-config-settings.json");
    setGlobalSettingsPath(globalSettingsPath);
    clearSettingsCache();
    resetWidgetVisibilityState();
  });

  afterEach(() => {
    resetWidgetVisibilityState();
    setGlobalSettingsPath(null);
    clearSettingsCache();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("registers the 4 widget settings in settings-keys.json with expected defaults", () => {
    assert.equal(SETTINGS_KEYS.widget_tasks_shortcut?.default, "alt+t");
    assert.equal(SETTINGS_KEYS.widget_coms_shortcut?.default, "alt+c");
    assert.equal(SETTINGS_KEYS.widget_all_shortcut?.default, "alt+w");
    assert.equal(SETTINGS_KEYS.widgets_default_mode?.default, "expanded");
    assert.deepEqual(SETTINGS_KEYS.widgets_default_mode?.enum, ["expanded", "collapsed"]);

    assert.equal(getSetting(tempDir, "widget_tasks_shortcut"), "alt+t");
    assert.equal(getSetting(tempDir, "widget_coms_shortcut"), "alt+c");
    assert.equal(getSetting(tempDir, "widget_all_shortcut"), "alt+w");
    assert.equal(getSetting(tempDir, "widgets_default_mode"), "expanded");
  });

  it("toggles cleanly between expanded and collapsed", () => {
    assert.equal(nextWidgetMode("expanded"), "collapsed");
    assert.equal(nextWidgetMode("collapsed"), "expanded");
    assert.equal(formatWidgetShortcutHint("alt+t", "expanded"), "[alt+t collapse]");
    assert.equal(formatWidgetShortcutHint("alt+t", "collapsed"), "[alt+t expand]");
    assert.equal(formatWidgetShortcutHint(null, "expanded"), "");

    assert.equal(getWidgetMode("tasks", tempDir), "expanded");
    assert.equal(cycleWidgetMode("tasks", tempDir), "collapsed");
    assert.equal(cycleWidgetMode("tasks", tempDir), "expanded");
  });

  it("honors widgets_default_mode and accepts friendly/legacy aliases", () => {
    writeFileSync(
      join(tempDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({ widgets_default_mode: "collapsed" }),
    );
    clearSettingsCache();
    assert.equal(getDefaultWidgetMode(tempDir), "collapsed");
    assert.equal(getWidgetMode("tasks", tempDir), "collapsed");
    assert.equal(getWidgetMode("coms", tempDir), "collapsed");

    assert.equal(normalizeWidgetMode("HIDDEN"), "collapsed");
    assert.equal(normalizeWidgetMode("compact"), "collapsed");
    assert.equal(normalizeWidgetMode("show"), "expanded");
    assert.equal(normalizeWidgetMode("bogus"), "expanded");
  });

  it("parses widget command actions including expand/collapse/toggle and show/hide aliases", () => {
    assert.equal(parseWidgetCommandAction(undefined), "toggle");
    assert.equal(parseWidgetCommandAction(""), "toggle");
    assert.equal(parseWidgetCommandAction("toggle"), "toggle");
    assert.equal(parseWidgetCommandAction("expand"), "expanded");
    assert.equal(parseWidgetCommandAction("expanded"), "expanded");
    assert.equal(parseWidgetCommandAction("show"), "expanded");
    assert.equal(parseWidgetCommandAction("collapse"), "collapsed");
    assert.equal(parseWidgetCommandAction("collapsed"), "collapsed");
    assert.equal(parseWidgetCommandAction("compact"), "collapsed");
    assert.equal(parseWidgetCommandAction("hide"), "collapsed");
    assert.equal(parseWidgetCommandAction("hidden"), "collapsed");
    assert.equal(parseWidgetCommandAction("invalid"), null);

    assert.equal(applyWidgetAction("coms", "collapsed", tempDir), "collapsed");
    assert.equal(applyWidgetAction("coms", "toggle", tempDir), "expanded");
  });

  it("validates and normalizes shortcuts and allows empty string to disable", () => {
    assert.equal(normalizeShortcut("alt+t"), "alt+t");
    assert.equal(normalizeShortcut("Alt+Shift+W"), "alt+shift+w");
    assert.equal(normalizeShortcut("ctrl++"), "ctrl++");
    assert.equal(normalizeShortcut("ctrl+pageup"), "ctrl+pageUp");
    assert.equal(normalizeShortcut("f6"), "f6");
    assert.equal(normalizeShortcut(""), null);
    assert.equal(normalizeShortcut("   "), null);
    assert.equal(normalizeShortcut("alt+"), null);
    assert.equal(normalizeShortcut("ctrl+ctrl+t"), null);
    assert.equal(normalizeShortcut("bogus+t"), null);

    writeFileSync(
      join(tempDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({
        widget_tasks_shortcut: "",
        widget_coms_shortcut: "Ctrl+Shift+C",
        widget_all_shortcut: "not-a-key",
      }),
    );
    clearSettingsCache();
    assert.equal(getConfiguredShortcut(tempDir, "widget_tasks_shortcut"), null);
    assert.equal(getConfiguredShortcut(tempDir, "widget_coms_shortcut"), "ctrl+shift+c");
    assert.equal(getConfiguredShortcut(tempDir, "widget_all_shortcut"), null);

    const harness = createFakePi();
    assert.equal(registerWidgetShortcut(harness.pi, "widget_tasks_shortcut", tempDir, "tasks", () => {}), null);
    assert.equal(registerWidgetShortcut(harness.pi, "widget_coms_shortcut", tempDir, "coms", () => {}), "ctrl+shift+c");
    assert.equal(harness.shortcuts.size, 1);
    assert.ok(harness.shortcuts.has("ctrl+shift+c"));
  });

  it("toggleAllWidgets collapses both when either is expanded and restores previous mixed state on second press", () => {
    setWidgetMode("tasks", "expanded");
    setWidgetMode("coms", "collapsed");

    const first = toggleAllWidgets(tempDir);
    assert.deepEqual(first, { tasks: "collapsed", coms: "collapsed" });
    assert.equal(getWidgetMode("tasks", tempDir), "collapsed");
    assert.equal(getWidgetMode("coms", tempDir), "collapsed");

    const second = toggleAllWidgets(tempDir);
    assert.deepEqual(second, { tasks: "expanded", coms: "collapsed" });
    assert.equal(getWidgetMode("tasks", tempDir), "expanded");
    assert.equal(getWidgetMode("coms", tempDir), "collapsed");
  });

  it("toggleAllWidgets expands both if already collapsed with no snapshot, and manual edit clears snapshot", () => {
    setWidgetMode("tasks", "collapsed");
    setWidgetMode("coms", "collapsed");
    assert.deepEqual(toggleAllWidgets(tempDir), { tasks: "expanded", coms: "expanded" });

    // Collapse both via toggle-all, then manually expand coms -> next toggle-all collapses both again
    assert.deepEqual(toggleAllWidgets(tempDir), { tasks: "collapsed", coms: "collapsed" });
    setWidgetMode("coms", "expanded");
    assert.deepEqual(toggleAllWidgets(tempDir), { tasks: "collapsed", coms: "collapsed" });
    assert.deepEqual(toggleAllWidgets(tempDir), { tasks: "collapsed", coms: "expanded" });
  });

  it("persists active modes on globalThis across simulated /reload", () => {
    setWidgetMode("tasks", "collapsed");
    setWidgetMode("coms", "expanded");
    const persisted = (globalThis as Record<symbol, any>)[WIDGET_VISIBILITY_SYMBOL];
    assert.equal(persisted?.modes?.tasks, "collapsed");
    assert.equal(persisted?.modes?.coms, "expanded");

    // Even when widgets_default_mode is "expanded", persisted modes win after reload
    assert.equal(getWidgetMode("tasks", tempDir), "collapsed");
    assert.equal(getWidgetMode("coms", tempDir), "expanded");
  });

  it("formats expanded COMS top border with [<key> collapse], exact width alignment, and narrow fallback", () => {
    const wide = formatComsTopBorder({
      width: 80,
      identity: { name: "peer-ui", color: "#ff8800" },
      pendingCount: 2,
      shortcutHint: "alt+c",
      theme,
      colorizeName: (_c, text) => text,
    });
    assert.equal(wide.length, 80);
    assert.match(wide, /^┏━ coms \[alt\+c collapse\] ━+ peer-ui \(2 pending\) ━┓$/);

    // Narrow terminal where hint no longer fits alongside identity: drops hint cleanly, preserves exact width
    const narrow = formatComsTopBorder({
      width: 40,
      identity: { name: "peer-ui", color: "#ff8800" },
      pendingCount: 2,
      shortcutHint: "alt+c",
      theme,
      colorizeName: (_c, text) => text,
    });
    assert.equal(narrow.length, 40);
    assert.match(narrow, /^┏━ coms ━+ peer-ui \(2 pending\) ━┓$/);

    // Disabled shortcut (null): omits hint
    const disabled = formatComsTopBorder({
      width: 60,
      identity: { name: "peer-ui", color: "#ff8800" },
      pendingCount: 0,
      shortcutHint: null,
      theme,
      colorizeName: (_c, text) => text,
    });
    assert.equal(disabled.length, 60);
    assert.doesNotMatch(disabled, /collapse|expand/);
  });

  it("formats collapsed 1-line COMS header with [<key> expand], peer/busy counts, and exact width alignment", () => {
    const wide = formatComsCollapsedHeader({
      width: 90,
      identity: { name: "fm-audit", color: "#ff8800" },
      pendingCount: 2,
      shortcutHint: "alt+c",
      peerCount: 5,
      busyCount: 3,
      theme,
      colorizeName: (_c, text) => text,
    });
    assert.equal(wide.length, 90);
    assert.match(wide, /^┏━ coms \[alt\+c expand\] · 5 peers \(3 busy\) ━+ fm-audit \(2 pending\) ━┓$/);

    // Singular peer, disabled shortcut
    const singleNoHint = formatComsCollapsedHeader({
      width: 70,
      identity: { name: "solo", color: "#00aa00" },
      pendingCount: 0,
      shortcutHint: null,
      peerCount: 1,
      busyCount: 0,
      theme,
      colorizeName: (_c, text) => text,
    });
    assert.equal(singleNoHint.length, 70);
    assert.match(singleNoHint, /^┏━ coms · 1 peer \(0 busy\) ━+ solo \(0 pending\) ━┓$/);

    // Narrow fallback drops hint first while keeping counts + identity aligned
    const mediumNarrow = formatComsCollapsedHeader({
      width: 55,
      identity: { name: "fm-audit", color: "#ff8800" },
      pendingCount: 0,
      shortcutHint: "alt+c",
      peerCount: 5,
      busyCount: 3,
      theme,
      colorizeName: (_c, text) => text,
    });
    assert.equal(mediumNarrow.length, 55);
    assert.match(mediumNarrow, /^┏━ coms · 5 peers \(3 busy\) ━+ fm-audit \(0 pending\) ━┓$/);
  });
});

describe("TaskWidget collapse/expand rendering and collapsed spinner timer pause", () => {
  it("always keeps header visible with [alt+t collapse]/[alt+t expand] and pauses spinner timer when collapsed", () => {
    const store = new TaskStore();
    const widget = new TaskWidget(store);
    const widgetCalls: Array<{ key: string; value: any }> = [];
    let render: (() => readonly string[]) | undefined;
    const getRender = (): (() => readonly string[]) | undefined => render;
    try {
      widget.setShortcutHint("alt+t");
      widget.setUICtx({
        setWidget(key: string, value: any) {
          widgetCalls.push({ key, value });
          if (typeof value === "function") {
            render = value({ terminal: { columns: 120 }, requestRender() {} }, theme).render;
          } else if (value === undefined) {
            render = undefined;
          }
        },
      });
      const t1 = store.create("Build feature", "desc", createdBy);
      store.create("Write tests", "desc", createdBy);
      store.update(t1.id, { status: "in_progress" });
      widget.setActiveTask(t1.id, true);

      // Expanded mode: header with [alt+t collapse] + task rows, spinner timer running
      const expandedRender = getRender();
      assert.ok(expandedRender);
      assert.equal(widget.hasActiveTimer(), true);
      const expandedLines = expandedRender();
      assert.equal(expandedLines.length, 3);
      assert.equal(expandedLines[0], "● 2 tasks (1 in progress, 1 open) [alt+t collapse]");

      // Collapsed mode: 1-line header stays visible (never unregistered!), body hidden, spinner timer paused
      widget.setMode("collapsed");
      const collapsedRender = getRender();
      assert.ok(collapsedRender, "header widget must remain registered when collapsed");
      assert.equal(widgetCalls.some((c) => c.value === undefined), false, "must never hide to 0 lines when tasks exist");
      assert.equal(widget.hasActiveTimer(), false, "150ms spinner timer must pause while collapsed");
      const collapsedLines = collapsedRender();
      assert.equal(collapsedLines.length, 1);
      assert.equal(collapsedLines[0], "● 2 tasks (1 in progress, 1 open) [alt+t expand]");

      // Calling setActiveTask or update while collapsed must NOT restart the timer
      widget.setActiveTask(t1.id, true);
      widget.update();
      assert.equal(widget.hasActiveTimer(), false);
      assert.equal(collapsedRender().length, 1);

      // Disabled shortcut (null): omits [alt+t expand] cleanly
      widget.setShortcutHint(null);
      assert.equal(collapsedRender()[0], "● 2 tasks (1 in progress, 1 open)");
      widget.setShortcutHint("alt+t");

      // Expand again: body rows return and 150ms spinner timer automatically resumes
      widget.setMode("expanded");
      const resumedRender = getRender();
      assert.ok(resumedRender);
      assert.equal(widget.hasActiveTimer(), true);
      assert.equal(resumedRender().length, 3);
      assert.equal(resumedRender()[0], "● 2 tasks (1 in progress, 1 open) [alt+t collapse]");
    } finally {
      widget.dispose();
    }
  });
});

describe("/tasks widget, /coms widget, and orchestrator toggle-all wiring", () => {
  let tempDir: string;
  let globalDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["PI_TASKS", "PI_WIDGET_TASKS_SHORTCUT", "PI_WIDGET_COMS_SHORTCUT", "PI_WIDGET_ALL_SHORTCUT", "PI_WIDGETS_DEFAULT_MODE"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PI_TASKS = "off";
    tempDir = makeTempDir("widget-wire-proj-");
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    globalDir = makeTempDir("widget-wire-global-");
    setGlobalSettingsPath(join(globalDir, "pi-config-settings.json"));
    clearSettingsCache();
    resetWidgetVisibilityState();
  });

  afterEach(() => {
    resetWidgetVisibilityState();
    setGlobalSettingsPath(null);
    clearSettingsCache();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("parses /tasks widget subcommands (and show/hide aliases) and includes widget in usage/hint", () => {
    assert.deepEqual(parseTasksCommand("widget"), { kind: "widget", action: "toggle" });
    assert.deepEqual(parseTasksCommand("widget collapse"), { kind: "widget", action: "collapsed" });
    assert.deepEqual(parseTasksCommand("widget hide"), { kind: "widget", action: "collapsed" });
    assert.deepEqual(parseTasksCommand("widget expand"), { kind: "widget", action: "expanded" });
    assert.deepEqual(parseTasksCommand("widget show"), { kind: "widget", action: "expanded" });
    assert.deepEqual(parseTasksCommand("widget toggle"), { kind: "widget", action: "toggle" });
    assert.deepEqual(parseTasksCommand("widget bogus"), { kind: "usage" });
    assert.deepEqual(parseTasksCommand("widget collapse extra"), { kind: "usage" });
    assert.match(TASKS_USAGE, /widget \[expand\|collapse\|toggle\]/);
    assert.match(TASKS_HINT, /widget \[expand\|collapse\|toggle\]/);
  });

  it("wires pitasks shortcut, /tasks widget command, autocomplete, and toggle-all event bridge", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      pitasks(harness.pi);
      return undefined;
    });
    const shortcut = harness.shortcuts.get("alt+t");
    const tasksCmd = harness.commands.get("tasks");
    assert.ok(shortcut);
    assert.ok(tasksCmd);

    try {
      // Autocomplete for /tasks widget
      const topCompletions = tasksCmd.getArgumentCompletions("");
      assert.ok(topCompletions?.some((item: any) => item.label === "widget"));
      const widgetCompletions = tasksCmd.getArgumentCompletions("widget ");
      assert.deepEqual(
        widgetCompletions?.map((item: any) => item.label),
        ["expand", "collapse", "toggle"],
      );

      const { ctx, notifications } = makeFakeCtx(tempDir);
      for (const fn of harness.lifecycleHandlers.get("session_start") ?? []) {
        await fn({ reason: "startup" }, ctx);
      }

      // Shortcut toggles expanded <-> collapsed
      await shortcut.handler(ctx);
      assert.equal(getWidgetMode("tasks", tempDir), "collapsed");
      await shortcut.handler(ctx);
      assert.equal(getWidgetMode("tasks", tempDir), "expanded");

      // /tasks widget collapse + expand
      await tasksCmd.handler("widget collapse", ctx);
      assert.equal(getWidgetMode("tasks", tempDir), "collapsed");
      assert.match(notifications.at(-1)?.text ?? "", /Tasks widget: collapsed/);

      await tasksCmd.handler("widget expand", ctx);
      assert.equal(getWidgetMode("tasks", tempDir), "expanded");
      assert.match(notifications.at(-1)?.text ?? "", /Tasks widget: expanded/);

      // Toggle-all event bridge collapses and restores
      const collapsedModes = toggleAllWidgets(tempDir);
      harness.emitEvent(TOGGLE_ALL_WIDGETS_EVENT, { modes: collapsedModes });
      assert.equal(getWidgetMode("tasks", tempDir), "collapsed");

      const restoredModes = toggleAllWidgets(tempDir);
      harness.emitEvent(TOGGLE_ALL_WIDGETS_EVENT, { modes: restoredModes });
      assert.equal(getWidgetMode("tasks", tempDir), "expanded");
    } finally {
      for (const fn of harness.lifecycleHandlers.get("session_shutdown") ?? []) {
        await fn({}, {});
      }
    }
  });

  it("skips pitasks shortcut registration when PI_SUBAGENT_CHILD=1", () => {
    const harness = createFakePi();
    withSubagentChildEnv("1", () => {
      pitasks(harness.pi);
      return undefined;
    });
    assert.equal(harness.shortcuts.size, 0);
  });

  it("wires coms shortcut, /coms widget command, autocomplete, and mode-changed event", async () => {
    const harness = createFakePi();
    const emitted: Array<{ widget: string; mode: string }> = [];
    harness.pi.events.on(WIDGET_MODE_CHANGED_EVENT, (data: unknown) => {
      emitted.push(data as { widget: string; mode: string });
    });

    withSubagentChildEnv(undefined, () => {
      registerComs(harness.pi);
      return undefined;
    });
    const shortcut = harness.shortcuts.get("alt+c");
    const comsCmd = harness.commands.get("coms");
    assert.ok(shortcut);
    assert.ok(comsCmd);

    // Autocomplete includes widget and expand/collapse/toggle
    const topCompletions = comsCmd.getArgumentCompletions("");
    assert.ok(topCompletions?.some((item: any) => item.label === "widget"));
    const widgetCompletions = comsCmd.getArgumentCompletions("widget ");
    assert.deepEqual(
      widgetCompletions?.map((item: any) => item.label),
      ["expand", "collapse", "toggle"],
    );

    const { ctx, notifications } = makeFakeCtx(tempDir);
    await shortcut.handler(ctx);
    assert.equal(getWidgetMode("coms", tempDir), "collapsed");
    assert.deepEqual(emitted.at(-1), { widget: "coms", mode: "collapsed" });

    await comsCmd.handler("widget expand", ctx);
    assert.equal(getWidgetMode("coms", tempDir), "expanded");
    assert.match(notifications.at(-1)?.text ?? "", /coms widget: expanded/);

    await comsCmd.handler("widget hide", ctx);
    assert.equal(getWidgetMode("coms", tempDir), "collapsed");
    assert.match(notifications.at(-1)?.text ?? "", /coms widget: collapsed/);

    await comsCmd.handler("widget bogus", ctx);
    assert.equal(notifications.at(-1)?.level, "warning");
  });

  it("wires orchestrator widget_all_shortcut emitting ui:toggle-all-widgets and skips in subagent child", async () => {
    const childHarness = createFakePi();
    withSubagentChildEnv("1", () => {
      orchestrator(childHarness.pi);
      return undefined;
    });
    assert.equal(childHarness.shortcuts.has("alt+w"), false);

    const parentHarness = createFakePi();
    const received: any[] = [];
    parentHarness.pi.events.on(TOGGLE_ALL_WIDGETS_EVENT, (data: unknown) => received.push(data));
    withSubagentChildEnv(undefined, () => {
      orchestrator(parentHarness.pi);
      return undefined;
    });
    const allShortcut = parentHarness.shortcuts.get("alt+w");
    assert.ok(allShortcut);

    try {
      const { ctx } = makeFakeCtx(tempDir);
      setWidgetMode("tasks", "expanded");
      setWidgetMode("coms", "collapsed");

      await allShortcut.handler(ctx);
      assert.deepEqual(received.at(-1), { modes: { tasks: "collapsed", coms: "collapsed" } });

      await allShortcut.handler(ctx);
      assert.deepEqual(received.at(-1), { modes: { tasks: "expanded", coms: "collapsed" } });
    } finally {
      for (const fn of parentHarness.lifecycleHandlers.get("session_shutdown") ?? []) {
        await fn({}, {});
      }
    }
  });
});
