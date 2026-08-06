/**
 * Settings TUI — interactive editor for pi-config settings.
 *
 * /pi-config-settings [scope] opens a fullscreen SettingsList overlay
 * showing all keys grouped by category with scope indicators [P]/[G]/[E]/[D].
 * Tab switches between project and global scope.
 * Phase 2: provider/model pickers, agent list multi-select, agent overrides editor.
 */

import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
  matchesKey,
  Key,
  truncateToWidth,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SETTINGS_KEYS,
  type SettingsKeyDef,
  getSetting,
  clearSettingsCache,
} from "./project-settings.js";
import {
  CATEGORIES,
  detectSource,
  formatValue,
  parseRawValue,
  getFilePathForScope,
  readSettingsFile,
  writeSettingsFile,
} from "./settings-tui-helpers.js";

// Re-export helpers for external consumers
export {
  CATEGORIES,
  type CategoryDef,
  type SettingSource,
  detectSource,
  formatValue,
  parseRawValue,
  getFilePathForScope,
  readSettingsFile,
  writeSettingsFile,
} from "./settings-tui-helpers.js";

// ── Provider/Model data helpers ─────────────────────────────────────

interface ProviderModelInfo {
  providers: SelectItem[];
  models: SelectItem[];
}

function getProviderModelInfo(modelRegistry: ModelRegistry | undefined): ProviderModelInfo {
  if (!modelRegistry) return { providers: [], models: [] };

  const models = modelRegistry.getAvailable?.() || modelRegistry.getAll?.() || [];

  // Unique providers (exclude acpx-* which can't work in subagents)
  const providerSet = new Set<string>();
  for (const m of models) {
    if (!(m.provider || "").startsWith("acpx-")) {
      providerSet.add(m.provider);
    }
  }

  const providers: SelectItem[] = [...providerSet].sort().map((p) => ({
    value: p,
    label: p,
  }));

  const modelItems: SelectItem[] = models
    .filter((m) => !(m.provider || "").startsWith("acpx-"))
    .map((m) => ({
      value: `${m.provider}/${m.id}`,
      label: m.id,
      description: m.provider,
    }));

  return { providers, models: modelItems };
}

// ── Available agent names ───────────────────────────────────────────

function getAvailableAgentNames(cwd: string): string[] {
  const agentsDir = join(cwd, "agents");
  try {
    return readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}

// ── Input submenu component ─────────────────────────────────────────

class InputSubmenu implements Component {
  private input: Input;
  private label: string;
  private hint: string;
  private done: (value?: string) => void;

  constructor(label: string, currentValue: string, hint: string, done: (value?: string) => void) {
    this.label = label;
    this.hint = hint;
    this.done = done;
    this.input = new Input();
    this.input.setValue(currentValue === "(empty)" ? "" : currentValue);
    this.input.onSubmit = (val: string) => this.done(val);
    this.input.onEscape = () => this.done(undefined);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(`  ${this.label}`, width));
    lines.push(truncateToWidth(`  ${this.hint}`, width));
    lines.push("");
    const inputLines = this.input.render(Math.max(10, width - 4));
    for (const line of inputLines) {
      lines.push(truncateToWidth(`  ${line}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth("  Enter: save · Esc: cancel", width));
    return lines;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {}
}

// ── Number input submenu ────────────────────────────────────────────

class NumberInputSubmenu implements Component {
  private input: Input;
  private label: string;
  private min?: number;
  private max?: number;
  private isInt: boolean;
  private error: string;
  private done: (value?: string) => void;

  constructor(
    label: string,
    currentValue: string,
    def: SettingsKeyDef,
    done: (value?: string) => void,
  ) {
    this.label = label;
    this.min = def.min;
    this.max = def.max;
    this.isInt = def.type === "int" || def.type === "port";
    this.error = "";
    this.done = done;
    this.input = new Input();
    this.input.setValue(currentValue);
    this.input.onSubmit = (val: string) => this.validate(val);
    this.input.onEscape = () => this.done(undefined);
  }

  private validate(val: string): void {
    const trimmed = val.trim();
    if (trimmed === "") {
      this.done(trimmed);
      return;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      this.error = "Invalid number";
      return;
    }
    if (this.isInt && !Number.isInteger(num)) {
      this.error = "Must be an integer";
      return;
    }
    if (this.min !== undefined && num < this.min) {
      this.error = `Minimum: ${this.min}`;
      return;
    }
    if (this.max !== undefined && num > this.max) {
      this.error = `Maximum: ${this.max}`;
      return;
    }
    this.done(trimmed);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(`  ${this.label}`, width));

    const constraints: string[] = [];
    if (this.min !== undefined) constraints.push(`min: ${this.min}`);
    if (this.max !== undefined) constraints.push(`max: ${this.max}`);
    if (this.isInt) constraints.push("integer");
    if (constraints.length > 0) {
      lines.push(truncateToWidth(`  (${constraints.join(", ")})`, width));
    }

    lines.push("");
    const inputLines = this.input.render(Math.max(10, width - 4));
    for (const line of inputLines) {
      lines.push(truncateToWidth(`  ${line}`, width));
    }

    if (this.error) {
      lines.push(truncateToWidth(`  ⚠ ${this.error}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth("  Enter: save · Esc: cancel", width));
    return lines;
  }

  handleInput(data: string): void {
    this.error = "";
    this.input.handleInput(data);
  }

  invalidate(): void {}
}

// ── Picker submenu (SelectList + search Input) ──────────────────────

class PickerSubmenu implements Component {
  private searchInput: Input;
  private selectList: SelectList;
  private allItems: SelectItem[];
  private label: string;
  private done: (value?: string) => void;

  constructor(label: string, items: SelectItem[], done: (value?: string) => void) {
    this.label = label;
    this.allItems = items;
    this.done = done;

    this.searchInput = new Input();
    this.selectList = new SelectList(items, Math.min(items.length, 15), getSelectListTheme());
    this.selectList.onSelect = (item) => this.done(item.value);
    this.selectList.onCancel = () => this.done(undefined);

    // Wire search input to filter the list
    const origHandleInput = this.searchInput.handleInput.bind(this.searchInput);
    this.searchInput.handleInput = (data: string) => {
      // Let Escape cancel the whole picker
      if (matchesKey(data, Key.escape)) {
        this.done(undefined);
        return;
      }
      // Pass arrow keys and Enter to the select list
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
        this.selectList.handleInput(data);
        return;
      }
      origHandleInput(data);
      this.applyFilter();
    };
  }

  private applyFilter(): void {
    const query = this.searchInput.getValue().trim();
    if (!query) {
      this.selectList = new SelectList(this.allItems, Math.min(this.allItems.length, 15), getSelectListTheme());
    } else {
      const filtered = fuzzyFilter(this.allItems, query, (item) => `${item.label} ${item.description || ""}`);
      this.selectList = new SelectList(filtered, Math.min(filtered.length, 15), getSelectListTheme());
    }
    this.selectList.onSelect = (item) => this.done(item.value);
    this.selectList.onCancel = () => this.done(undefined);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(`  ${this.label}`, width));
    lines.push("");

    // Search input
    const inputLines = this.searchInput.render(Math.max(10, width - 6));
    for (const line of inputLines) {
      lines.push(truncateToWidth(`  🔍 ${line}`, width));
    }
    lines.push("");

    // Select list
    const listLines = this.selectList.render(Math.max(10, width - 4));
    for (const line of listLines) {
      lines.push(truncateToWidth(`  ${line}`, width));
    }

    lines.push("");
    lines.push(truncateToWidth("  ↑↓ navigate · Enter: select · Esc: cancel · Type to filter", width));
    return lines;
  }

  handleInput(data: string): void {
    this.searchInput.handleInput(data);
  }

  invalidate(): void {}
}

// ── Multi-select submenu (agent list) ───────────────────────────────

class MultiSelectSubmenu implements Component {
  private agents: string[];
  private selected: Set<string>;
  private selectedIndex: number;
  private done: (value?: string) => void;
  private label: string;

  constructor(label: string, available: string[], current: string[], done: (value?: string) => void) {
    this.label = label;
    this.agents = available;
    this.selected = new Set(current);
    this.selectedIndex = 0;
    this.done = done;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(`  ${this.label}`, width));
    lines.push("");

    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i];
      const checked = this.selected.has(agent) ? "☑" : "☐";
      const cursor = i === this.selectedIndex ? "❯" : " ";
      lines.push(truncateToWidth(`  ${cursor} ${checked} ${agent}`, width));
    }

    if (this.agents.length === 0) {
      lines.push(truncateToWidth("  (no agents found)", width));
    }

    lines.push("");
    lines.push(truncateToWidth("  ↑↓ navigate · Space: toggle · Enter: save · Esc: cancel", width));
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const result = [...this.selected].sort().join(", ");
      this.done(result || "(empty)");
      return;
    }
    if (matchesKey(data, Key.up) && this.selectedIndex > 0) {
      this.selectedIndex--;
      return;
    }
    if (matchesKey(data, Key.down) && this.selectedIndex < this.agents.length - 1) {
      this.selectedIndex++;
      return;
    }
    if (matchesKey(data, Key.space) || data === " ") {
      const agent = this.agents[this.selectedIndex];
      if (agent) {
        if (this.selected.has(agent)) {
          this.selected.delete(agent);
        } else {
          this.selected.add(agent);
        }
      }
    }
  }

  invalidate(): void {}
}

// ── Agent overrides editor ──────────────────────────────────────────

class AgentOverridesSubmenu implements Component {
  private overrides: Record<string, { provider?: string | null; model?: string | null }>;
  private agentNames: string[];
  private selectedIndex: number;
  private done: (value?: string) => void;
  private label: string;
  private mode: "list" | "edit-provider" | "edit-model";
  private editingAgent: string;
  private editInput: Input;

  constructor(
    label: string,
    currentOverrides: Record<string, { provider?: string | null; model?: string | null }>,
    availableAgents: string[],
    done: (value?: string) => void,
  ) {
    this.label = label;
    // Deep copy
    this.overrides = JSON.parse(JSON.stringify(currentOverrides || {}));
    this.agentNames = availableAgents;
    this.selectedIndex = 0;
    this.done = done;
    this.mode = "list";
    this.editingAgent = "";
    this.editInput = new Input();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(`  ${this.label}`, width));
    lines.push("");

    if (this.mode === "list") {
      for (let i = 0; i < this.agentNames.length; i++) {
        const agent = this.agentNames[i];
        const override = this.overrides[agent];
        const cursor = i === this.selectedIndex ? "❯" : " ";
        let info = "(default)";
        if (override) {
          const parts: string[] = [];
          if (override.provider !== undefined) parts.push(`provider: ${override.provider ?? "parent"}`);
          if (override.model !== undefined) parts.push(`model: ${override.model ?? "parent"}`);
          info = parts.join(", ") || "(default)";
        }
        lines.push(truncateToWidth(`  ${cursor} ${agent}: ${info}`, width));
      }

      if (this.agentNames.length === 0) {
        lines.push(truncateToWidth("  (no agents found)", width));
      }

      lines.push("");
      lines.push(truncateToWidth("  ↑↓ navigate · p: set provider · m: set model · d: delete override · Enter/Esc: save & close", width));
    } else {
      const field = this.mode === "edit-provider" ? "provider" : "model";
      lines.push(truncateToWidth(`  Set ${field} for: ${this.editingAgent}`, width));
      lines.push(truncateToWidth(`  Enter value (empty to clear, "null" to use parent model):`, width));
      lines.push("");
      const inputLines = this.editInput.render(Math.max(10, width - 4));
      for (const line of inputLines) {
        lines.push(truncateToWidth(`  ${line}`, width));
      }
      lines.push("");
      lines.push(truncateToWidth("  Enter: save · Esc: cancel", width));
    }

    return lines;
  }

  handleInput(data: string): void {
    if (this.mode !== "list") {
      if (matchesKey(data, Key.escape)) {
        this.mode = "list";
        return;
      }
      this.editInput.handleInput(data);
      // Check if Enter was pressed (onSubmit handles it)
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
      // Serialize overrides back
      const result = JSON.stringify(this.overrides);
      this.done(result);
      return;
    }
    if (matchesKey(data, Key.up) && this.selectedIndex > 0) {
      this.selectedIndex--;
      return;
    }
    if (matchesKey(data, Key.down) && this.selectedIndex < this.agentNames.length - 1) {
      this.selectedIndex++;
      return;
    }

    const agent = this.agentNames[this.selectedIndex];
    if (!agent) return;

    if (data === "p") {
      this.editingAgent = agent;
      this.mode = "edit-provider";
      const current = this.overrides[agent]?.provider;
      this.editInput = new Input();
      this.editInput.setValue(current === null ? "null" : current ?? "");
      this.editInput.onSubmit = (val: string) => {
        this.applyOverride(agent, "provider", val);
        this.mode = "list";
      };
      this.editInput.onEscape = () => { this.mode = "list"; };
      return;
    }

    if (data === "m") {
      this.editingAgent = agent;
      this.mode = "edit-model";
      const current = this.overrides[agent]?.model;
      this.editInput = new Input();
      this.editInput.setValue(current === null ? "null" : current ?? "");
      this.editInput.onSubmit = (val: string) => {
        this.applyOverride(agent, "model", val);
        this.mode = "list";
      };
      this.editInput.onEscape = () => { this.mode = "list"; };
      return;
    }

    if (data === "d") {
      delete this.overrides[agent];
    }
  }

  private applyOverride(agent: string, field: "provider" | "model", val: string): void {
    const trimmed = val.trim();
    if (!this.overrides[agent]) this.overrides[agent] = {};

    if (trimmed === "") {
      delete this.overrides[agent]![field];
      // Clean up empty entry
      if (Object.keys(this.overrides[agent]!).length === 0) {
        delete this.overrides[agent];
      }
    } else if (trimmed === "null") {
      this.overrides[agent]![field] = null;
    } else {
      this.overrides[agent]![field] = trimmed;
    }
  }

  invalidate(): void {}
}

// ── Build setting items ─────────────────────────────────────────────

export function buildSettingItems(
  cwd: string,
  editScope: "project" | "global",
  theme: Theme,
  modelRegistry?: ModelRegistry,
): SettingItem[] {
  const items: SettingItem[] = [];
  const pmInfo = getProviderModelInfo(modelRegistry);
  const availableAgents = getAvailableAgentNames(cwd);

  for (const category of CATEGORIES) {
    // Category header as a non-editable item
    items.push({
      id: `__category_${category.label}`,
      label: `── ${category.label} ──`,
      currentValue: "",
    });

    for (const key of category.keys) {
      const def = SETTINGS_KEYS[key];
      if (!def) continue;

      const effectiveValue = getSetting(cwd, key as any);
      const source = detectSource(key, def, cwd);
      const displayValue = formatValue(key, effectiveValue, def);
      const sourceTag = `[${source}]`;

      const item: SettingItem = {
        id: key,
        label: `${sourceTag} ${key}`,
        currentValue: displayValue,
        description: def.env ? `env: ${def.env}` : undefined,
      };

      // Configure interaction based on type and key
      const isProviderKey = key === "agent_provider" || key === "internal_operations_provider";
      const isModelKey = key === "agent_model" || key === "internal_operations_model";

      if (isProviderKey && pmInfo.providers.length > 0) {
        // Provider picker with fuzzy search
        item.submenu = (_current: string, done: (val?: string) => void): Component => {
          return new PickerSubmenu(`Select provider for ${key}`, pmInfo.providers, done);
        };
      } else if (isModelKey && pmInfo.models.length > 0) {
        // Model picker with fuzzy search (shows provider/model-id)
        item.submenu = (_current: string, done: (val?: string) => void): Component => {
          return new PickerSubmenu(`Select model for ${key}`, pmInfo.models, done);
        };
      } else {
        switch (def.type) {
          case "bool":
          case "bool_enable":
            item.values = ["true", "false"];
            break;

          case "bool_or_string":
            item.submenu = (current: string, done: (val?: string) => void): Component => {
              return new InputSubmenu(
                `${key} (bool or custom string)`,
                current === "true" || current === "false" ? current : current,
                'Enter "true", "false", or a custom string',
                done,
              );
            };
            break;

          case "string":
            item.submenu = (current: string, done: (val?: string) => void): Component => {
              return new InputSubmenu(key, current, "Enter new value (empty to clear)", done);
            };
            break;

          case "int":
          case "port":
          case "number":
            item.submenu = (current: string, done: (val?: string) => void): Component => {
              return new NumberInputSubmenu(key, current, def, done);
            };
            break;

          case "agent_list":
            item.submenu = (_current: string, done: (val?: string) => void): Component => {
              const currentAgents = Array.isArray(effectiveValue) ? effectiveValue as string[] : [];
              return new MultiSelectSubmenu(
                `${key} — select agents`,
                availableAgents,
                currentAgents,
                done,
              );
            };
            break;

          case "agent_overrides":
            item.submenu = (_current: string, done: (val?: string) => void): Component => {
              const currentOverrides = (typeof effectiveValue === "object" && effectiveValue !== null && !Array.isArray(effectiveValue))
                ? effectiveValue as Record<string, { provider?: string | null; model?: string | null }>
                : {};
              return new AgentOverridesSubmenu(
                "Agent overrides — per-agent provider/model",
                currentOverrides,
                availableAgents,
                done,
              );
            };
            break;
        }
      }

      items.push(item);
    }
  }

  return items;
}

// ── Save a single change ────────────────────────────────────────────

function saveChange(key: string, value: unknown, scope: "project" | "global", cwd: string): void {
  const filePath = getFilePathForScope(scope, cwd);
  const current = readSettingsFile(filePath);
  current[key] = value;
  writeSettingsFile(filePath, current);
  clearSettingsCache();
}

// ── Parse value for agent_overrides ─────────────────────────────────

function parseOverridesValue(rawValue: string): Record<string, { provider?: string | null; model?: string | null }> {
  try {
    const parsed = JSON.parse(rawValue);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return {};
}

// ── Main command handler ────────────────────────────────────────────

async function openSettingsTui(ctx: ExtensionCommandContext, initialScope?: string): Promise<void> {
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/pi-config-settings requires TUI mode", "error");
    return;
  }

  let editScope: "project" | "global" = initialScope === "global" ? "global" : "project";
  const cwd = ctx.cwd;
  const modelRegistry = ctx.modelRegistry;

  await ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    let settingsList: SettingsList;
    let items: SettingItem[];

    function rebuild(): void {
      container.clear();

      // Header
      const scopeLabel = editScope === "project" ? "Project" : "Global";
      const headerText = theme.fg("accent", theme.bold(" Settings")) +
        theme.fg("dim", "  ") +
        theme.fg("text", `[${scopeLabel}]`) +
        theme.fg("dim", "  Tab: switch scope");
      container.addChild(new Text(headerText, 0, 0));
      container.addChild(new Text("", 0, 0));

      items = buildSettingItems(cwd, editScope, theme, modelRegistry);

      settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 20),
        getSettingsListTheme(),
        (id: string, newValue: string) => {
          // Skip category headers
          if (id.startsWith("__category_")) return;

          const def = SETTINGS_KEYS[id];
          if (!def) return;

          let parsed: unknown;
          if (def.type === "agent_overrides") {
            parsed = parseOverridesValue(newValue);
          } else {
            parsed = parseRawValue(id, newValue, def);
          }

          // Save immediately to the current scope
          saveChange(id, parsed, editScope, cwd);

          // Rebuild to refresh source indicators
          rebuild();
          tui.requestRender();
        },
        () => done(undefined),
        { enableSearch: true },
      );

      container.addChild(settingsList);
    }

    rebuild();

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // Tab to switch scope
        if (matchesKey(data, Key.tab)) {
          editScope = editScope === "project" ? "global" : "project";
          rebuild();
          tui.requestRender();
          return;
        }

        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

// ── Registration ────────────────────────────────────────────────────

export function registerSettingsTui(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.registerCommand("pi-config-settings", {
    description: "Interactive settings editor for pi-config",
    handler: async (args, ctx) => {
      const scope = args?.trim().toLowerCase();
      await openSettingsTui(ctx, scope || undefined);
    },
  });
}
