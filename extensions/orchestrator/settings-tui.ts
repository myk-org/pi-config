/**
 * Settings TUI — interactive editor for pi-config settings.
 *
 * /pi-config-settings [scope] opens a fullscreen overlay with box-drawing borders,
 * themed header/footer, colored source glyphs, and fuzzy-searchable pickers.
 * Matches the async-status / cron overlay design pattern.
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
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SETTINGS_KEYS,
  type SettingsKeyDef,
  getSetting,
  clearSettingsCache,
} from "./project-settings.js";
import { resolveRepoRoot } from "./utils.js";
import {
  CATEGORIES,
  detectSource,
  formatValue,
  parseRawValue,
  getFilePathForScope,
  readSettingsFile,
  writeSettingsFile,
  registerSettingsTuiCommand,
} from "./settings-tui-helpers.js";
import {
  OVERLAY_OPTS,
  borderSegment,
  padAnsi,
  splitRow,
} from "./overlay-dashboard.js";

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
  registerSettingsTuiCommand,
} from "./settings-tui-helpers.js";

// ── Provider/Model data helpers ─────────────────────────────────────

interface ProviderModelInfo {
  providers: SelectItem[];
  models: SelectItem[];
}

function getProviderModelInfo(modelRegistry: ModelRegistry | undefined): ProviderModelInfo {
  if (!modelRegistry) return { providers: [], models: [] };

  const models = modelRegistry.getAvailable?.() || modelRegistry.getAll?.() || [];

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
      value: m.id,
      label: m.id,
      description: m.provider,
    }));

  return { providers, models: modelItems };
}

// ── Available agent names ───────────────────────────────────────────

function getAvailableAgentNames(cwd: string): string[] {
  const agentsDir = join(resolveRepoRoot(cwd), "agents");
  try {
    return readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}

// ── Source glyph (colored) ──────────────────────────────────────────

function sourceGlyph(source: string, theme: Theme): string {
  switch (source) {
    case "P": return theme.fg("success", "P");
    case "G": return "\x1b[34mG\x1b[0m";  // blue
    case "E": return theme.fg("warning", "E");
    case "D": return theme.fg("dim", "D");
    default:  return theme.fg("dim", "?");
  }
}

// ── Input submenu component ─────────────────────────────────────────

class InputSubmenu implements Component {
  private input: Input;
  private label: string;
  private hint: string;
  private done: (value?: string) => void;
  private theme: Theme;

  constructor(label: string, currentValue: string, hint: string, theme: Theme, done: (value?: string) => void) {
    this.label = label;
    this.hint = hint;
    this.done = done;
    this.theme = theme;
    this.input = new Input();
    this.input.setValue(currentValue === "(empty)" ? "" : currentValue);
    this.input.onSubmit = (val: string) => this.done(val);
    this.input.onEscape = () => this.done(undefined);
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    lines.push(truncateToWidth(`  ${t.fg("accent", t.bold(this.label))}`, width));
    lines.push(truncateToWidth(`  ${t.fg("dim", this.hint)}`, width));
    lines.push("");
    const inputLines = this.input.render(Math.max(10, width - 4));
    for (const line of inputLines) {
      lines.push(truncateToWidth(`  ${line}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${t.fg("dim", "Enter: save · Esc: cancel")}`, width));
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
  private theme: Theme;

  constructor(
    label: string,
    currentValue: string,
    def: SettingsKeyDef,
    theme: Theme,
    done: (value?: string) => void,
  ) {
    this.label = label;
    this.min = def.min;
    this.max = def.max;
    this.isInt = def.type === "int" || def.type === "port";
    this.error = "";
    this.done = done;
    this.theme = theme;
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
    const t = this.theme;
    const lines: string[] = [];
    lines.push(truncateToWidth(`  ${t.fg("accent", t.bold(this.label))}`, width));

    const constraints: string[] = [];
    if (this.min !== undefined) constraints.push(`min: ${this.min}`);
    if (this.max !== undefined) constraints.push(`max: ${this.max}`);
    if (this.isInt) constraints.push("integer");
    if (constraints.length > 0) {
      lines.push(truncateToWidth(`  ${t.fg("dim", `(${constraints.join(", ")})`)}`, width));
    }

    lines.push("");
    const inputLines = this.input.render(Math.max(10, width - 4));
    for (const line of inputLines) {
      lines.push(truncateToWidth(`  ${line}`, width));
    }

    if (this.error) {
      lines.push(truncateToWidth(`  ${t.fg("error", `⚠ ${this.error}`)}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${t.fg("dim", "Enter: save · Esc: cancel")}`, width));
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
  private theme: Theme;

  constructor(label: string, items: SelectItem[], theme: Theme, done: (value?: string) => void) {
    this.label = label;
    this.allItems = items;
    this.done = done;
    this.theme = theme;

    this.searchInput = new Input();
    this.selectList = new SelectList(items, Math.min(items.length, 15), getSelectListTheme());
    this.selectList.onSelect = (item) => this.done(item.value);
    this.selectList.onCancel = () => this.done(undefined);

    const origHandleInput = this.searchInput.handleInput.bind(this.searchInput);
    this.searchInput.handleInput = (data: string) => {
      if (matchesKey(data, Key.escape)) {
        this.done(undefined);
        return;
      }
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
    const t = this.theme;
    const lines: string[] = [];
    lines.push(truncateToWidth(`  ${t.fg("accent", t.bold(this.label))}`, width));
    lines.push("");
    const inputLines = this.searchInput.render(Math.max(10, width - 6));
    for (const line of inputLines) {
      lines.push(truncateToWidth(`  ${t.fg("dim", "🔍")} ${line}`, width));
    }
    lines.push("");
    const listLines = this.selectList.render(Math.max(10, width - 4));
    for (const line of listLines) {
      lines.push(truncateToWidth(`  ${line}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${t.fg("dim", "↑↓ navigate · Enter select · Esc cancel · Type to filter")}`, width));
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
  private theme: Theme;

  constructor(label: string, available: string[], current: string[], theme: Theme, done: (value?: string) => void) {
    this.label = label;
    this.agents = available;
    this.selected = new Set(current);
    this.selectedIndex = 0;
    this.done = done;
    this.theme = theme;
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    lines.push(truncateToWidth(`  ${t.fg("accent", t.bold(this.label))}`, width));
    lines.push("");

    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[i];
      const checked = this.selected.has(agent)
        ? t.fg("success", "☑")
        : t.fg("dim", "☐");
      const cursor = i === this.selectedIndex
        ? t.fg("accent", "❯")
        : " ";
      const name = i === this.selectedIndex
        ? t.fg("accent", agent)
        : t.fg("text", agent);
      lines.push(truncateToWidth(`  ${cursor} ${checked} ${name}`, width));
    }

    if (this.agents.length === 0) {
      lines.push(truncateToWidth(`  ${t.fg("dim", "(no agents found)")}`, width));
    }

    lines.push("");
    lines.push(truncateToWidth(`  ${t.fg("dim", "↑↓ navigate · Space toggle · Enter save · Esc cancel")}`, width));
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
  private theme: Theme;
  private mode: "list" | "edit-provider" | "edit-model";
  private editingAgent: string;
  private editInput: Input;

  constructor(
    label: string,
    currentOverrides: Record<string, { provider?: string | null; model?: string | null }>,
    availableAgents: string[],
    theme: Theme,
    done: (value?: string) => void,
  ) {
    this.label = label;
    this.overrides = JSON.parse(JSON.stringify(currentOverrides || {}));
    this.agentNames = availableAgents;
    this.selectedIndex = 0;
    this.done = done;
    this.theme = theme;
    this.mode = "list";
    this.editingAgent = "";
    this.editInput = new Input();
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];
    lines.push(truncateToWidth(`  ${t.fg("accent", t.bold(this.label))}`, width));
    lines.push("");

    if (this.mode === "list") {
      for (let i = 0; i < this.agentNames.length; i++) {
        const agent = this.agentNames[i];
        const override = this.overrides[agent];
        const cursor = i === this.selectedIndex ? t.fg("accent", "❯") : " ";
        const name = i === this.selectedIndex ? t.fg("accent", agent) : t.fg("text", agent);
        let info = t.fg("dim", "(default)");
        if (override) {
          const parts: string[] = [];
          if (override.provider !== undefined) {
            parts.push(`provider: ${t.fg("success", String(override.provider ?? "parent"))}`);
          }
          if (override.model !== undefined) {
            parts.push(`model: ${t.fg("success", String(override.model ?? "parent"))}`);
          }
          info = parts.join(t.fg("dim", ", ")) || t.fg("dim", "(default)");
        }
        lines.push(truncateToWidth(`  ${cursor} ${name}${t.fg("dim", ":")} ${info}`, width));
      }

      if (this.agentNames.length === 0) {
        lines.push(truncateToWidth(`  ${t.fg("dim", "(no agents found)")}`, width));
      }

      lines.push("");
      lines.push(truncateToWidth(`  ${t.fg("dim", "↑↓ navigate · p provider · m model · d delete · Enter/Esc save")}`, width));
    } else {
      const field = this.mode === "edit-provider" ? "provider" : "model";
      lines.push(truncateToWidth(`  ${t.fg("text", `Set ${field} for:`)} ${t.fg("accent", this.editingAgent)}`, width));
      lines.push(truncateToWidth(`  ${t.fg("dim", 'Enter value (empty to clear, "null" to use parent model)')}`, width));
      lines.push("");
      const inputLines = this.editInput.render(Math.max(10, width - 4));
      for (const line of inputLines) {
        lines.push(truncateToWidth(`  ${line}`, width));
      }
      lines.push("");
      lines.push(truncateToWidth(`  ${t.fg("dim", "Enter: save · Esc: cancel")}`, width));
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
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
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
    // Category separator — themed like borderSegment
    items.push({
      id: `__category_${category.label}`,
      label: `${theme.fg("border", "──")} ${theme.fg("muted", category.label)} ${theme.fg("border", "──")}`,
      currentValue: "",
    });

    for (const key of category.keys) {
      const def = SETTINGS_KEYS[key];
      if (!def) continue;

      const effectiveValue = getSetting(cwd, key as any);
      const source = detectSource(key, def, cwd);
      const displayValue = formatValue(key, effectiveValue, def);
      const glyph = sourceGlyph(source, theme);

      const item: SettingItem = {
        id: key,
        label: `${glyph} ${key}`,
        currentValue: displayValue,
        description: def.env ? `env: ${def.env}` : undefined,
      };

      // Configure interaction based on type and key
      const isProviderKey = key === "agent_provider" || key === "internal_operations_provider";
      const isModelKey = key === "agent_model" || key === "internal_operations_model";

      if (isProviderKey && pmInfo.providers.length > 0) {
        item.submenu = (_current: string, done: (val?: string) => void): Component => {
          return new PickerSubmenu(`Select provider for ${key}`, pmInfo.providers, theme, done);
        };
      } else if (isModelKey && pmInfo.models.length > 0) {
        item.submenu = (_current: string, done: (val?: string) => void): Component => {
          return new PickerSubmenu(`Select model for ${key}`, pmInfo.models, theme, done);
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
                theme,
                done,
              );
            };
            break;

          case "string": {
            // For secret-like keys, prefill with the value from the CURRENT SCOPE's file only
            // (not the effective value which may come from env or another scope).
            // This prevents accidentally persisting env/global secrets into the project file.
            const SECRET_PATTERN = /token|secret|password|auth/i;
            const isSecret = SECRET_PATTERN.test(key);
            let scopeStringValue: string | null = null;
            if (isSecret) {
              const scopeFile = getFilePathForScope(editScope, cwd);
              const scopeData = readSettingsFile(scopeFile);
              scopeStringValue = scopeData && typeof scopeData[key] === "string" ? scopeData[key] as string : null;
            }
            item.submenu = (current: string, done: (val?: string) => void): Component => {
              const prefill = scopeStringValue !== null ? scopeStringValue : (isSecret ? "" : current);
              const hint = isSecret && scopeStringValue === null
                ? "Enter new value (not set in this scope)"
                : "Enter new value (empty to clear)";
              return new InputSubmenu(key, prefill, hint, theme, (val?: string) => {
                // For secrets not in this scope, treat empty submit as "no change"
                if (isSecret && scopeStringValue === null && (val === undefined || val?.trim() === "")) {
                  done(undefined); // cancel — don't persist empty string
                  return;
                }
                done(val);
              });
            };
            break;
          }

          case "int":
          case "port":
          case "number":
            item.submenu = (current: string, done: (val?: string) => void): Component => {
              return new NumberInputSubmenu(key, current, def, theme, done);
            };
            break;

          case "agent_list":
            item.submenu = (_current: string, done: (val?: string) => void): Component => {
              const currentAgents = Array.isArray(effectiveValue) ? effectiveValue as string[] : [];
              return new MultiSelectSubmenu(
                `${key} — select agents`,
                availableAgents,
                currentAgents,
                theme,
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
                theme,
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

function saveChange(key: string, value: unknown, scope: "project" | "global", cwd: string): boolean {
  const filePath = getFilePathForScope(scope, cwd);
  const current = readSettingsFile(filePath);
  if (current === null) return false; // corrupt file — refuse to clobber
  if (value === undefined) {
    if (!(key in current)) return true; // key not present — nothing to clear
    delete current[key]; // clear/unset the key
  } else {
    current[key] = value;
  }
  // Skip write if result would be empty and file doesn't exist yet
  if (Object.keys(current).length === 0 && !existsSync(filePath)) return true;
  writeSettingsFile(filePath, current);
  clearSettingsCache();
  return true;
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

// ── Settings overlay component ──────────────────────────────────────

class SettingsOverlay implements Component {
  private tui: TUI;
  private theme: Theme;
  private cwd: string;
  private modelRegistry: ModelRegistry | undefined;
  private editScope: "project" | "global";
  private done: (value: undefined) => void;
  private notify: (msg: string, level: "info" | "error") => void;
  private settingsList!: SettingsList;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    tui: TUI,
    theme: Theme,
    cwd: string,
    modelRegistry: ModelRegistry | undefined,
    initialScope: "project" | "global",
    done: (value: undefined) => void,
    notify: (msg: string, level: "info" | "error") => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.cwd = cwd;
    this.modelRegistry = modelRegistry;
    this.editScope = initialScope;
    this.done = done;
    this.notify = notify;
    this.rebuild();
  }

  private rebuild(): void {
    const items = buildSettingItems(this.cwd, this.editScope, this.theme, this.modelRegistry);

    this.settingsList = new SettingsList(
      items,
      20,
      getSettingsListTheme(),
      (id: string, newValue: string) => {
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
        const filePath = getFilePathForScope(this.editScope, this.cwd);
        if (!saveChange(id, parsed, this.editScope, this.cwd)) {
          this.notify(`Failed to save: settings file is corrupt (${filePath})`, "error");
          return;
        }
        if (filePath.endsWith(".jsonc")) {
          this.notify("Saved to .jsonc — comments were stripped", "info");
        }
        this.rebuild();
        this.tui.requestRender();
      },
      () => this.done(undefined),
      { enableSearch: true },
    );

    this.invalidate();
  }

  handleInput(data: string): void {
    // Tab to switch scope
    if (matchesKey(data, Key.tab)) {
      this.editScope = this.editScope === "project" ? "global" : "project";
      this.rebuild();
      this.tui.requestRender();
      return;
    }

    this.settingsList.handleInput?.(data);
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const rows = this.tui.terminal.rows || 30;
    const innerWidth = Math.max(0, width - 2);
    const lines: string[] = [];

    // Count non-category items
    const allKeys = CATEGORIES.flatMap((c) => c.keys);
    const keyCount = allKeys.length;
    const scopeLabel = this.editScope === "project" ? "Project" : "Global";

    // ── Header line ──
    const headerLeft = theme.fg("accent", theme.bold("Settings"));
    const headerRight = theme.fg("muted", `${keyCount} keys`);
    const headerPad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4);
    lines.push(truncateToWidth(`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `, width));

    // ── Top border with title ──
    const borderTitle = `${scopeLabel} scope`;
    lines.push(
      theme.fg("border", "╭") +
      borderSegment(theme, innerWidth, borderTitle) +
      theme.fg("border", "╮"),
    );

    // ── Settings list body ──
    const divider = theme.fg("border", "│");
    const bodyHeight = Math.max(6, rows - 5);
    const settingsLines = this.settingsList.render(innerWidth);

    for (let i = 0; i < bodyHeight; i++) {
      const line = settingsLines[i] ?? "";
      lines.push(divider + padAnsi(line, innerWidth) + divider);
    }

    // ── Bottom border ──
    lines.push(
      theme.fg("border", "╰") +
      theme.fg("border", "─".repeat(innerWidth)) +
      theme.fg("border", "╯"),
    );

    // ── Footer hints ──
    lines.push(truncateToWidth(
      theme.fg("dim", `  Tab: ${scopeLabel === "Project" ? "Global" : "Project"} scope · ↑↓ navigate · Enter edit · / search · Esc close`),
      width,
    ));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ── Main command handler ────────────────────────────────────────────

async function openSettingsTui(ctx: ExtensionCommandContext, initialScope?: string): Promise<void> {
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/pi-config-settings requires TUI mode", "error");
    return;
  }

  const editScope: "project" | "global" = initialScope === "global" ? "global" : "project";
  const cwd = ctx.cwd;
  const modelRegistry = ctx.modelRegistry;

  await ctx.ui.custom<undefined>(
    (tui, theme, _kb, done) =>
      new SettingsOverlay(tui, theme, cwd, modelRegistry, editScope, done, (msg, level) => ctx.ui.notify(msg, level)),
    OVERLAY_OPTS,
  );
}

// ── Registration ────────────────────────────────────────────────────

export function registerSettingsTui(pi: ExtensionAPI): void {
  registerSettingsTuiCommand(pi, async (args, ctx) => {
    const scope = args?.trim().toLowerCase();
    await openSettingsTui(ctx, scope || undefined);
  });
}
