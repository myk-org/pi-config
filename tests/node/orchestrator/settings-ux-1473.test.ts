/**
 * Unit tests for #1473: strict scope-aware Settings TUI, scrollable left
 * category sidebar, and cross-category search.
 *
 * Run with: npx tsx --test tests/node/orchestrator/settings-ux-1473.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  SETTINGS_KEYS,
  clearSettingsCache,
  resolveSettingForScope,
  setGlobalSettingsPath,
  updateSetting,
} from "../../../extensions/orchestrator/project-settings.js";
import {
  CATEGORIES,
  SettingsOverlay,
  buildCategoryItems,
  computeSidebarWindow,
  filterSettingsAcrossCategories,
  refreshItem,
} from "../../../extensions/orchestrator/settings-tui.js";
import { AgentOverridesSubmenu } from "../../../extensions/orchestrator/settings-tui-submenus.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

initTheme();

const stubTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

const TAB = "\t";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const ESC = "\x1b";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeFakeTui(rows = 30) {
  let renders = 0;
  return {
    terminal: { rows },
    requestRender: () => { renders++; },
    getRenders: () => renders,
  } as any;
}

describe("scope-aware settings display (#1473)", () => {
  let projectDir: string;
  let globalDir: string;

  beforeEach(() => {
    projectDir = makeTempDir("settings-1473-proj-");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    globalDir = makeTempDir("settings-1473-global-");
    setGlobalSettingsPath(join(globalDir, "pi-config-settings.json"));
    clearSettingsCache();
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("hides project dangerous_command_allowlist overrides when viewing global scope", () => {
    const tenPatterns = Array.from({ length: 10 }, (_, i) => `cmd-${i}`);
    writeFileSync(
      join(projectDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({ dangerous_command_allowlist: tenPatterns }),
      "utf8",
    );
    clearSettingsCache();

    const enforcementIdx = CATEGORIES.findIndex((c) => c.keys.includes("dangerous_command_allowlist"));
    assert.ok(enforcementIdx >= 0);

    const projectItems = buildCategoryItems(enforcementIdx, projectDir, "project", stubTheme);
    const projRow = projectItems.find((i) => i.id === "dangerous_command_allowlist")!;
    assert.equal(projRow.currentValue, "10 pattern(s)");
    assert.equal(projRow.label, "P dangerous_command_allowlist");

    const globalItems = buildCategoryItems(enforcementIdx, projectDir, "global", stubTheme);
    const globRow = globalItems.find((i) => i.id === "dangerous_command_allowlist")!;
    assert.equal(globRow.currentValue, "(empty)");
    assert.equal(globRow.label, "D dangerous_command_allowlist");
  });

  it("shows global source glyph when key is set in global scope", () => {
    writeFileSync(
      join(globalDir, "pi-config-settings.json"),
      JSON.stringify({ dangerous_command_allowlist: ["git status", "ls"] }),
      "utf8",
    );
    clearSettingsCache();

    const enforcementIdx = CATEGORIES.findIndex((c) => c.keys.includes("dangerous_command_allowlist"));
    const globalItems = buildCategoryItems(enforcementIdx, projectDir, "global", stubTheme);
    const globRow = globalItems.find((i) => i.id === "dangerous_command_allowlist")!;
    assert.equal(globRow.currentValue, "2 pattern(s)");
    assert.equal(globRow.label, "G dangerous_command_allowlist");
  });

  it("inherits global value in project scope when project has no override", () => {
    writeFileSync(join(globalDir, "pi-config-settings.json"), JSON.stringify({ dco: true }), "utf8");
    clearSettingsCache();

    const resolved = resolveSettingForScope(projectDir, "dco", "project");
    assert.equal(resolved?.value, true);
    assert.equal(resolved?.source, "G");
  });

  it("refreshItem respects global scope without leaking project overrides", () => {
    writeFileSync(
      join(projectDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({ dco: true }),
      "utf8",
    );
    clearSettingsCache();

    const item = { id: "dco", label: "P dco", currentValue: "true" };
    refreshItem(item, projectDir, "global", stubTheme);
    assert.equal(item.label, "D dco");
    assert.equal(item.currentValue, "false");
  });

  it("opens agent_overrides submenu strictly from active scope without cross-scope leak", () => {
    writeFileSync(
      join(projectDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({ agent_overrides: { worker: { provider: "proj-prov", model: "proj-model" } } }),
      "utf8",
    );
    writeFileSync(
      join(globalDir, "pi-config-settings.json"),
      JSON.stringify({ agent_overrides: { scout: { provider: "glob-prov", model: "glob-model" } } }),
      "utf8",
    );
    clearSettingsCache();

    const providerIdx = CATEGORIES.findIndex((c) => c.keys.includes("agent_overrides"));
    const globalItems = buildCategoryItems(providerIdx, projectDir, "global", stubTheme, undefined, {
      getProviderModelInfo: () => ({ providers: [], models: [] }),
      getAvailableAgents: () => ["worker", "scout"],
    });
    const globalSub = globalItems.find((i) => i.id === "agent_overrides")!.submenu!("", () => {});
    const globalRender = stripAnsi(globalSub.render(100).join("\n"));
    assert.match(globalRender, /glob-prov/);
    assert.doesNotMatch(globalRender, /proj-prov/);

    const projectItems = buildCategoryItems(providerIdx, projectDir, "project", stubTheme, undefined, {
      getProviderModelInfo: () => ({ providers: [], models: [] }),
      getAvailableAgents: () => ["worker", "scout"],
    });
    const projSub = projectItems.find((i) => i.id === "agent_overrides")!.submenu!("", () => {});
    const projRender = stripAnsi(projSub.render(100).join("\n"));
    assert.match(projRender, /proj-prov/);
    assert.doesNotMatch(projRender, /glob-prov/);
  });

  it("closes untouched AgentOverridesSubmenu without emitting a write", () => {
    let submitted: string | undefined = "sentinel";
    const sub = new AgentOverridesSubmenu(
      "Agent overrides",
      { worker: { model: "m1" } },
      ["worker"],
      stubTheme,
      (val) => { submitted = val; },
      [],
      [],
    );
    sub.handleInput(ESC);
    assert.equal(submitted, undefined);
  });

  it("refreshes displayed rows immediately on Tab scope toggle in SettingsOverlay", () => {
    const tenPatterns = Array.from({ length: 10 }, (_, i) => `cmd-${i}`);
    writeFileSync(
      join(projectDir, ".pi", "pi-config-settings.json"),
      JSON.stringify({ dangerous_command_allowlist: tenPatterns }),
      "utf8",
    );
    clearSettingsCache();

    const overlay = new SettingsOverlay(
      makeFakeTui(30),
      stubTheme,
      projectDir,
      undefined,
      "project",
      () => {},
      () => {},
    );

    // Search for dangerous_command_allowlist from any category
    for (const ch of "dangerous_command_allowlist") overlay.handleInput(ch);
    const projText = stripAnsi(overlay.render(120).join("\n"));
    assert.match(projText, /10 pattern\(s\)/);
    assert.match(projText, /\[Project\]/);

    // Press Tab to switch to Global scope — row must refresh immediately to (empty)
    overlay.handleInput(TAB);
    const globalText = stripAnsi(overlay.render(120).join("\n"));
    assert.match(globalText, /\[Global\]/);
    assert.match(globalText, /\(empty\)/);
    assert.doesNotMatch(globalText, /10 pattern\(s\)/);
  });
});

describe("left category sidebar and cross-category search (#1473)", () => {
  let projectDir: string;
  let globalDir: string;

  beforeEach(() => {
    projectDir = makeTempDir("settings-sidebar-proj-");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    globalDir = makeTempDir("settings-sidebar-global-");
    setGlobalSettingsPath(join(globalDir, "pi-config-settings.json"));
    clearSettingsCache();
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("renders all categories vertically in the left sidebar without horizontal clipping", () => {
    const overlay = new SettingsOverlay(
      makeFakeTui(32),
      stubTheme,
      projectDir,
      undefined,
      "project",
      () => {},
      () => {},
    );
    const rendered = stripAnsi(overlay.render(120).join("\n"));
    assert.match(rendered, new RegExp(`Categories \\(${CATEGORIES.length}\\)`));
    assert.match(rendered, /Git/);
    assert.match(rendered, /Subagent/);
    assert.match(rendered, /Session/);
  });

  it("scrolls sidebar window to expose tail categories on short terminals", () => {
    const win = computeSidebarWindow(18, 17, 10);
    assert.equal(win.start, 8);
    assert.equal(win.end, 18);

    const overlay = new SettingsOverlay(
      makeFakeTui(16),
      stubTheme,
      projectDir,
      undefined,
      "project",
      () => {},
      () => {},
    );
    overlay.handleInput(LEFT); // focus sidebar
    for (let i = 0; i < CATEGORIES.length - 1; i++) overlay.handleInput(DOWN);
    const rendered = stripAnsi(overlay.render(100).join("\n"));
    assert.match(rendered, /Session/);
  });

  it("switches focus from items pane to category sidebar via arrow keys", () => {
    const overlay = new SettingsOverlay(
      makeFakeTui(30),
      stubTheme,
      projectDir,
      undefined,
      "project",
      () => {},
      () => {},
    );
    // Focus sidebar, move down once from Git to Review, move right back to items
    overlay.handleInput(LEFT);
    overlay.handleInput(DOWN);
    overlay.handleInput(RIGHT);
    const rendered = stripAnsi(overlay.render(120).join("\n"));
    assert.match(rendered, /Review · Project/);
    assert.match(rendered, /review_loop_enforcement/);
  });

  it("surfaces matching keys from any category with category labels during cross-category search", () => {
    const overlay = new SettingsOverlay(
      makeFakeTui(30),
      stubTheme,
      projectDir,
      undefined,
      "project",
      () => {},
      () => {},
    );
    // Starts on category 0 (Git); typing "turn_snapshots" finds key in Session category
    for (const ch of "turn_snapshots") overlay.handleInput(ch);
    const rendered = stripAnsi(overlay.render(120).join("\n"));
    assert.match(rendered, /turn_snapshots \[Session\]/);
    assert.match(rendered, /Search: "turn_snapshots"/);
  });

  it("matches real Trail category keys via cross-category search helper", () => {
    const items = Object.entries(SETTINGS_KEYS).map(([id, def]) => ({
      id,
      description: def.description,
    }));
    const matches = filterSettingsAcrossCategories(items, "trail");
    assert.ok(matches.some((m) => m.id === "trail_enable"));
    assert.ok(matches.some((m) => m.id === "log_trail"));
  });

  it("shows focus-specific footer hints in items pane versus sidebar pane", () => {
    const overlay = new SettingsOverlay(
      makeFakeTui(30),
      stubTheme,
      projectDir,
      undefined,
      "project",
      () => {},
      () => {},
    );
    const itemsFooter = stripAnsi(overlay.render(120).at(-1) ?? "");
    assert.match(itemsFooter, /← sidebar/);
    assert.doesNotMatch(itemsFooter, /\/hl/);

    overlay.handleInput(LEFT);
    const sidebarFooter = stripAnsi(overlay.render(120).at(-1) ?? "");
    assert.match(sidebarFooter, /↑↓\/jk category/);
    assert.match(sidebarFooter, /→\/l\/Enter items/);
  });

  it("clears active search on first Escape before closing overlay on second Escape", () => {
    let closed = false;
    const overlay = new SettingsOverlay(
      makeFakeTui(30),
      stubTheme,
      projectDir,
      undefined,
      "project",
      () => { closed = true; },
      () => {},
    );
    for (const ch of "turn_snapshots") overlay.handleInput(ch);
    overlay.handleInput(ESC);
    assert.equal(closed, false);
    const afterClear = stripAnsi(overlay.render(120).join("\n"));
    assert.match(afterClear, /Git · Project/);

    overlay.handleInput(ESC);
    assert.equal(closed, true);
  });

  it("blocks writing global_only keys to project scope in updateSetting", () => {
    const orig = SETTINGS_KEYS.dco.global_only;
    SETTINGS_KEYS.dco.global_only = true;
    try {
      const res = updateSetting(projectDir, "project", "dco", true);
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.error, /global-only/);
    } finally {
      if (orig === undefined) delete SETTINGS_KEYS.dco.global_only;
      else SETTINGS_KEYS.dco.global_only = orig;
    }
  });
});
