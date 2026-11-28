import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  TOGGLE_ALL_WIDGETS_EVENT,
  WIDGET_MODE_CHANGED_EVENT,
  WIDGET_VISIBILITY_SYMBOL,
  cycleWidgetMode,
  formatComsCollapsedHeader,
  formatComsTopBorder,
  formatWidgetShortcutHint,
  getConfiguredShortcut,
  getDefaultWidgetMode,
  getRegisteredWidgetShortcut,
  getWidgetMode,
  nextWidgetMode,
  normalizeShortcut,
  normalizeWidgetMode,
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
import pitasks from "../../../extensions/pitasks/index.js";
import { registerComs } from "../../../extensions/coms/coms-wrapper.js";
import orchestrator from "../../../extensions/orchestrator/index.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { useSupportedPiVersion } from "../helpers/pi-version-env.js";

useSupportedPiVersion();

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

function createFakePi(opts: { throwOnShortcut?: boolean } = {}): FakePiHarness {
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
      if (opts.throwOnShortcut) throw new Error("shortcut already bound");
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

describe("widget-visibility settings, state, shortcuts, headers", () => {
  let tempDir: string;
  let otherProjectDir: string;
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
    otherProjectDir = makeTempDir("widget-vis-other-");
    mkdirSync(join(otherProjectDir, ".git"), { recursive: true });
    mkdirSync(join(otherProjectDir, ".pi"), { recursive: true });
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
    rmSync(otherProjectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("declares widget settings with expected defaults in settings-keys.json", () => {
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

  it("toggles mode between expanded/collapsed", () => {
    assert.equal(nextWidgetMode("expanded"), "collapsed");
    assert.equal(nextWidgetMode("collapsed"), "expanded");
    assert.equal(getWidgetMode("tasks", tempDir), "expanded");
    assert.equal(cycleWidgetMode("tasks", tempDir), "collapsed");
    assert.equal(cycleWidgetMode("tasks", tempDir), "expanded");
  });

  it("formats shortcut hint badges for expanded or collapsed states", () => {
    assert.equal(formatWidgetShortcutHint("alt+t", "expanded"), "[alt+t collapse]");
    assert.equal(formatWidgetShortcutHint("alt+t", "collapsed"), "[alt+t expand]");
    assert.equal(formatWidgetShortcutHint(null, "expanded"), "");
  });

  it("honors widgets_default_mode from project settings", () => {
    writeFileSync(
      join(tempDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({ widgets_default_mode: "collapsed" }),
    );
    clearSettingsCache();
    assert.equal(getDefaultWidgetMode(tempDir), "collapsed");
    assert.equal(getWidgetMode("tasks", tempDir), "collapsed");
    assert.equal(getWidgetMode("coms", tempDir), "collapsed");
  });

  it("normalizes mode aliases while falling back on invalid values", () => {
    assert.equal(normalizeWidgetMode("HIDDEN"), "collapsed");
    assert.equal(normalizeWidgetMode("compact"), "collapsed");
    assert.equal(normalizeWidgetMode("show"), "expanded");
    assert.equal(normalizeWidgetMode("bogus"), "expanded");
  });

  it("deduplicates invalid setting warnings across repeated reads", () => {
    normalizeWidgetMode("bogus-repeat");
    normalizeWidgetMode("bogus-repeat");
    const store = (globalThis as Record<symbol, any>)[WIDGET_VISIBILITY_SYMBOL];
    assert.equal(store?.warnedKeys?.has("invalid_widget_mode:bogus-repeat"), true);
    assert.equal(store?.warnedKeys?.size, 1);
  });

  it("normalizes valid shortcut key strings while rejecting malformed ones", () => {
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
  });

  it("registers configured shortcuts while disabling empty or invalid entries", () => {
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
    assert.equal(getRegisteredWidgetShortcut("widget_tasks_shortcut"), null);
    assert.equal(getRegisteredWidgetShortcut("widget_coms_shortcut"), "ctrl+shift+c");
  });

  it("records null registered shortcut when registerShortcut throws", () => {
    const failingHarness = createFakePi({ throwOnShortcut: true });
    const bound = registerWidgetShortcut(failingHarness.pi, "widget_coms_shortcut", tempDir, "coms", () => {});
    assert.equal(bound, null);
    assert.equal(getRegisteredWidgetShortcut("widget_coms_shortcut"), null);
  });

  it("keeps registered shortcut hint fixed until reload after settings edits", () => {
    const harness = createFakePi();
    registerWidgetShortcut(harness.pi, "widget_coms_shortcut", tempDir, "coms", () => {});
    assert.equal(getRegisteredWidgetShortcut("widget_coms_shortcut"), "alt+c");

    // Editing settings without /reload must not advertise the unbound key
    writeFileSync(
      join(tempDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({ widget_coms_shortcut: "alt+x" }),
    );
    clearSettingsCache();
    assert.equal(getConfiguredShortcut(tempDir, "widget_coms_shortcut"), "alt+x");
    assert.equal(getRegisteredWidgetShortcut("widget_coms_shortcut"), "alt+c");
  });

  it("collapses both widgets via toggleAllWidgets then restores prior mixed state", () => {
    setWidgetMode("tasks", "expanded", tempDir);
    setWidgetMode("coms", "collapsed", tempDir);

    const first = toggleAllWidgets(tempDir);
    assert.deepEqual(first, { tasks: "collapsed", coms: "collapsed" });
    assert.equal(getWidgetMode("tasks", tempDir), "collapsed");
    assert.equal(getWidgetMode("coms", tempDir), "collapsed");

    const second = toggleAllWidgets(tempDir);
    assert.deepEqual(second, { tasks: "expanded", coms: "collapsed" });
    assert.equal(getWidgetMode("tasks", tempDir), "expanded");
    assert.equal(getWidgetMode("coms", tempDir), "collapsed");
  });

  it("expands both widgets via toggleAllWidgets when both are collapsed without a snapshot", () => {
    setWidgetMode("tasks", "collapsed", tempDir);
    setWidgetMode("coms", "collapsed", tempDir);
    assert.deepEqual(toggleAllWidgets(tempDir), { tasks: "expanded", coms: "expanded" });
  });

  it("clears the toggleAllWidgets snapshot after a manual mode change", () => {
    setWidgetMode("tasks", "expanded", tempDir);
    setWidgetMode("coms", "expanded", tempDir);
    assert.deepEqual(toggleAllWidgets(tempDir), { tasks: "collapsed", coms: "collapsed" });
    setWidgetMode("coms", "expanded", tempDir);
    assert.deepEqual(toggleAllWidgets(tempDir), { tasks: "collapsed", coms: "collapsed" });
    assert.deepEqual(toggleAllWidgets(tempDir), { tasks: "collapsed", coms: "expanded" });
  });

  it("persists active modes on globalThis across simulated /reload within a project", () => {
    setWidgetMode("tasks", "collapsed", tempDir);
    setWidgetMode("coms", "expanded", tempDir);
    const persisted = (globalThis as Record<symbol, any>)[WIDGET_VISIBILITY_SYMBOL];
    assert.ok(persisted?.projects);
    assert.equal(getWidgetMode("tasks", tempDir), "collapsed");
    assert.equal(getWidgetMode("coms", tempDir), "expanded");
  });

  it("isolates persisted widget modes between different projects", () => {
    writeFileSync(
      join(otherProjectDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({ widgets_default_mode: "expanded" }),
    );
    clearSettingsCache();

    setWidgetMode("tasks", "collapsed", tempDir);
    assert.equal(getWidgetMode("tasks", tempDir), "collapsed");
    assert.equal(getWidgetMode("tasks", otherProjectDir), "expanded");
  });

  it("formats expanded COMS top border with collapse hint at exact width", () => {
    const wide = formatComsTopBorder({
      width: 80,
      identity: { name: "peer-ui", color: "#ff8800" },
      pendingCount: 2,
      shortcutHint: "alt+c",
      theme,
      colorizeName: (_c, text) => text,
    });
    assert.equal(visibleWidth(wide), 80);
    assert.match(wide, /^┏━ coms \[alt\+c collapse\] ━+ peer-ui \(2 pending\) ━┓$/);
  });

  it("drops expanded COMS shortcut hint cleanly on narrow widths or disabled shortcuts", () => {
    const narrow = formatComsTopBorder({
      width: 40,
      identity: { name: "peer-ui", color: "#ff8800" },
      pendingCount: 2,
      shortcutHint: "alt+c",
      theme,
      colorizeName: (_c, text) => text,
    });
    assert.equal(visibleWidth(narrow), 40);
    assert.match(narrow, /^┏━ coms ━+ peer-ui \(2 pending\) ━┓$/);

    const disabled = formatComsTopBorder({
      width: 60,
      identity: { name: "peer-ui", color: "#ff8800" },
      pendingCount: 0,
      shortcutHint: null,
      theme,
      colorizeName: (_c, text) => text,
    });
    assert.equal(visibleWidth(disabled), 60);
    assert.doesNotMatch(disabled, /collapse|expand/);
  });

  it("formats collapsed 1-line COMS header with expand hint at exact width", () => {
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
    assert.equal(visibleWidth(wide), 90);
    assert.match(wide, /^┏━ coms \[alt\+c expand\] · 5 peers \(3 busy\) ━+ fm-audit \(2 pending\) ━┓$/);
  });

  it("falls back cleanly in collapsed COMS header for singular peer or narrow widths", () => {
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
    assert.equal(visibleWidth(singleNoHint), 70);
    assert.match(singleNoHint, /^┏━ coms · 1 peer \(0 busy\) ━+ solo \(0 pending\) ━┓$/);

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
    assert.equal(visibleWidth(mediumNarrow), 55);
    assert.match(mediumNarrow, /^┏━ coms · 5 peers \(3 busy\) ━+ fm-audit \(0 pending\) ━┓$/);
  });

  it("measures wide Unicode peer names by display width without overflowing collapsed COMS header", () => {
    const line = formatComsCollapsedHeader({
      width: 46,
      identity: { name: "界", color: "#ff8800" },
      pendingCount: 0,
      shortcutHint: null,
      peerCount: 1,
      busyCount: 0,
      theme,
      colorizeName: (_c, text) => text,
    });
    assert.ok(visibleWidth(line) <= 46, `expected visibleWidth <= 46, got ${visibleWidth(line)}: ${line}`);
  });
});

describe("TaskWidget collapse/expand rendering", () => {
  it("reports current mode via getMode after construction or setMode", () => {
    const store = new TaskStore();
    const widget = new TaskWidget(store);
    try {
      assert.equal(widget.getMode(), "expanded");
      widget.setMode("collapsed");
      assert.equal(widget.getMode(), "collapsed");
      widget.setMode("expanded");
      assert.equal(widget.getMode(), "expanded");
    } finally {
      widget.dispose();
    }
  });

  it("keeps header visible with collapse/expand badge while pausing spinner timer when collapsed", () => {
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

      const expandedRender = getRender();
      assert.ok(expandedRender);
      assert.equal(widget.getMode(), "expanded");
      assert.equal(widget.hasActiveTimer(), true);
      const expandedLines = expandedRender();
      assert.equal(expandedLines.length, 3);
      assert.equal(expandedLines[0], "● 2 tasks (1 in progress, 1 open) [alt+t collapse]");

      widget.setMode("collapsed");
      const collapsedRender = getRender();
      assert.ok(collapsedRender, "header widget must remain registered when collapsed");
      assert.equal(widget.getMode(), "collapsed");
      assert.equal(widgetCalls.some((c) => c.value === undefined), false, "must never hide to 0 lines when tasks exist");
      assert.equal(widget.hasActiveTimer(), false, "150ms spinner timer must pause while collapsed");
      const collapsedLines = collapsedRender();
      assert.equal(collapsedLines.length, 1);
      assert.equal(collapsedLines[0], "● 2 tasks (1 in progress, 1 open) [alt+t expand]");

      widget.setActiveTask(t1.id, true);
      widget.update();
      assert.equal(widget.hasActiveTimer(), false);
      assert.equal(collapsedRender().length, 1);

      widget.setShortcutHint(null);
      assert.equal(collapsedRender()[0], "● 2 tasks (1 in progress, 1 open)");
      widget.setShortcutHint("alt+t");

      widget.setMode("expanded");
      const resumedRender = getRender();
      assert.ok(resumedRender);
      assert.equal(widget.getMode(), "expanded");
      assert.equal(widget.hasActiveTimer(), true);
      assert.equal(resumedRender().length, 3);
      assert.equal(resumedRender()[0], "● 2 tasks (1 in progress, 1 open) [alt+t collapse]");
    } finally {
      widget.dispose();
    }
  });
});

describe("extension widget command wiring", () => {
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

  it("wires pitasks shortcut and zero-arg /tasks command", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      pitasks(harness.pi);
      return undefined;
    });
    const shortcut = harness.shortcuts.get("alt+t");
    const tasksCmd = harness.commands.get("tasks");
    assert.ok(shortcut);
    assert.ok(tasksCmd);
    assert.equal(tasksCmd.getArgumentCompletions, undefined);

    try {
      const { ctx } = makeFakeCtx(tempDir);
      for (const fn of harness.lifecycleHandlers.get("session_start") ?? []) {
        await fn({ reason: "startup" }, ctx);
      }

      await shortcut.handler(ctx);
      assert.equal(getWidgetMode("tasks", tempDir), "collapsed");
      await shortcut.handler(ctx);
      assert.equal(getWidgetMode("tasks", tempDir), "expanded");
    } finally {
      for (const fn of harness.lifecycleHandlers.get("session_shutdown") ?? []) {
        await fn({}, {});
      }
    }
  });

  it("keeps pitasks subscribed to ui:toggle-all-widgets after session_shutdown then session_start", async () => {
    const harness = createFakePi();
    withSubagentChildEnv(undefined, () => {
      pitasks(harness.pi);
      return undefined;
    });

    try {
      const { ctx, getRender } = makeFakeCtx(tempDir);
      for (const fn of harness.lifecycleHandlers.get("session_start") ?? []) {
        await fn({ reason: "startup" }, ctx);
      }

      // Simulate /new session switch: shutdown followed by session_start on the same extension instance
      for (const fn of harness.lifecycleHandlers.get("session_shutdown") ?? []) {
        await fn({}, {});
      }
      for (const fn of harness.lifecycleHandlers.get("session_start") ?? []) {
        await fn({ reason: "new" }, ctx);
      }

      // Seed a task so the widget renders and verify toggle-all updates the rendered lines
      const { createTask } = await import("../../../extensions/pitasks/index.js");
      createTask("Post-switch task", "desc", createdBy);
      const renderBefore = getRender();
      assert.ok(renderBefore);
      assert.equal(renderBefore(120).length, 2);

      const collapsedModes = toggleAllWidgets(tempDir);
      harness.emitEvent(TOGGLE_ALL_WIDGETS_EVENT, { modes: collapsedModes, cwd: tempDir });
      assert.equal(getRender()?.(120).length, 1);

      const restoredModes = toggleAllWidgets(tempDir);
      harness.emitEvent(TOGGLE_ALL_WIDGETS_EVENT, { modes: restoredModes, cwd: tempDir });
      assert.equal(getRender()?.(120).length, 2);
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

  it("wires coms shortcut and zero-arg /coms command", async () => {
    const harness = createFakePi();
    const emitted: Array<{ widget: string; mode: string; cwd?: string }> = [];
    harness.pi.events.on(WIDGET_MODE_CHANGED_EVENT, (data: unknown) => {
      emitted.push(data as { widget: string; mode: string; cwd?: string });
    });

    withSubagentChildEnv(undefined, () => {
      registerComs(harness.pi);
      return undefined;
    });
    const shortcut = harness.shortcuts.get("alt+c");
    const comsCmd = harness.commands.get("coms");
    assert.ok(shortcut);
    assert.ok(comsCmd);
    assert.equal(comsCmd.getArgumentCompletions, undefined);

    const { ctx } = makeFakeCtx(tempDir);
    await shortcut.handler(ctx);
    assert.equal(getWidgetMode("coms", tempDir), "collapsed");
    assert.deepEqual(emitted.at(-1), { widget: "coms", mode: "collapsed", cwd: tempDir });
  });

  it("skips orchestrator widget_all_shortcut when PI_SUBAGENT_CHILD=1", () => {
    const childHarness = createFakePi();
    withSubagentChildEnv("1", () => {
      orchestrator(childHarness.pi);
      return undefined;
    });
    assert.equal(childHarness.shortcuts.has("alt+w"), false);
  });

  it("emits ui:toggle-all-widgets from orchestrator widget_all_shortcut", async () => {
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
      setWidgetMode("tasks", "expanded", tempDir);
      setWidgetMode("coms", "collapsed", tempDir);

      await allShortcut.handler(ctx);
      assert.deepEqual(received.at(-1), { modes: { tasks: "collapsed", coms: "collapsed" }, cwd: tempDir });

      await allShortcut.handler(ctx);
      assert.deepEqual(received.at(-1), { modes: { tasks: "expanded", coms: "collapsed" }, cwd: tempDir });
    } finally {
      for (const fn of parentHarness.lifecycleHandlers.get("session_shutdown") ?? []) {
        await fn({}, {});
      }
    }
  });
});
