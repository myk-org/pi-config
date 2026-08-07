/**
 * Settings TUI — interactive editor for pi-config settings.
 *
 * /pi-config-settings [scope] opens a fullscreen overlay with category tabs,
 * themed header/footer, colored source glyphs, and fuzzy-searchable pickers.
 * Left/Right arrows switch categories. Tab switches project/global scope.
 */

import type { ExtensionAPI, ExtensionCommandContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  type SelectItem,
  type SettingItem,
  SettingsList,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import {
  SETTINGS_KEYS,
  type SettingsKeyDef,
  getSetting,
  clearSettingsCache,
} from "./project-settings.js";
import { discoverAgents } from "./agents.js";
import {
  CATEGORIES,
  detectSource,
  formatValue,
  parseRawValue,
  getFilePathForScope,
  readSettingsFile,
  writeSettingsFile,
  registerSettingsTuiCommand,
  isSecretNoChange,
  resolveSecretPrefill,
  sourceGlyph,
  filterModelsByProvider,
} from "./settings-tui-helpers.js";
import {
  OVERLAY_OPTS,
  borderSegment,
  padAnsi,
} from "./overlay-dashboard.js";
import {
  InputSubmenu,
  NumberInputSubmenu,
  PickerSubmenu,
  MultiSelectSubmenu,
  AgentOverridesSubmenu,
} from "./settings-tui-submenus.js";

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
  isSecretNoChange,
  resolveSecretPrefill,
  sourceGlyph,
  filterModelsByProvider,
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

// ── Available agent names (for agent_overrides) ─────────────────────

function getAvailableAgentNames(cwd: string): string[] {
  const { agents } = discoverAgents(cwd, "both");
  return agents.map((a) => a.name).sort();
}

// ── Known CLI/ACPX provider names (for acpx_agents / cli_agents) ──

const KNOWN_CLI_PROVIDERS = ["cursor", "claude", "gemini"];

// ── Refresh a single item's label + value in-place ──────────────────

function refreshItem(item: SettingItem, cwd: string, theme: Theme): void {
  const def = SETTINGS_KEYS[item.id];
  if (!def) return;
  const effectiveValue = getSetting(cwd, item.id as any);
  const source = detectSource(item.id, def, cwd);
  const displayValue = formatValue(item.id, effectiveValue, def);
  const glyph = sourceGlyph(source, theme);
  // Mutate in-place — SettingsList stores items array by reference (verified in pi-tui source)
  item.label = `${glyph} ${item.id}`;
  item.currentValue = displayValue;
}

// ── Build setting items for a single category ───────────────────────

export function buildCategoryItems(
  categoryIndex: number,
  cwd: string,
  editScope: "project" | "global",
  theme: Theme,
  modelRegistry?: ModelRegistry,
): SettingItem[] {
  const category = CATEGORIES[categoryIndex];
  if (!category) return [];

  const items: SettingItem[] = [];
  const pmInfo = getProviderModelInfo(modelRegistry);
  const availableAgents = getAvailableAgentNames(cwd);

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
        // Filter models by the paired provider setting
        const pairedProvider = key === "agent_model"
          ? getSetting(cwd, "agent_provider")
          : getSetting(cwd, "internal_operations_provider");
        const filteredModels = filterModelsByProvider(pmInfo.models, pairedProvider || undefined);
        return new PickerSubmenu(`Select model for ${key}`, filteredModels.length > 0 ? filteredModels : pmInfo.models, theme, done);
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
          const SECRET_PATTERN = /token|secret|password|auth/i;
          const isSecret = SECRET_PATTERN.test(key);
          const secretInfo = isSecret ? resolveSecretPrefill(key, editScope, cwd) : null;
          item.submenu = (current: string, done: (val?: string) => void): Component => {
            const prefill = secretInfo ? secretInfo.prefill : current;
            const hint = secretInfo ? secretInfo.hint : "Enter new value (empty to clear)";
            return new InputSubmenu(key, prefill, hint, theme, (val?: string) => {
              if (isSecret && secretInfo && isSecretNoChange(val, secretInfo.scopeValue !== null)) {
                done(undefined);
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
              `${key} — select providers`,
              KNOWN_CLI_PROVIDERS,
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
              pmInfo.providers,
              pmInfo.models,
            );
          };
          break;
      }
    }

    items.push(item);
  }

  return items;
}

// Keep legacy buildSettingItems for backward compat / tests
export function buildSettingItems(
  cwd: string,
  editScope: "project" | "global",
  theme: Theme,
  modelRegistry?: ModelRegistry,
): SettingItem[] {
  const all: SettingItem[] = [];
  for (let i = 0; i < CATEGORIES.length; i++) {
    all.push(...buildCategoryItems(i, cwd, editScope, theme, modelRegistry));
  }
  return all;
}

// ── Safe SettingsList state access ──────────────────────────────────
// SettingsList fields are TypeScript-private (compile-time only) — accessible at runtime.

function getSettingsListState(list: SettingsList): {
  hasActiveSearch: boolean;
  hasActiveSubmenu: boolean;
  selectedIndex: number;
  displayItems: SettingItem[];
} {
  const raw = list as any;
  const searchInput = raw.searchInput;
  const hasActiveSearch = !!(searchInput && searchInput.getValue && searchInput.getValue().length > 0);
  const hasActiveSubmenu = !!raw.submenuComponent;
  const selectedIndex: number = raw.selectedIndex ?? 0;
  const displayItems: SettingItem[] = raw.searchEnabled ? (raw.filteredItems ?? raw.items) : (raw.items ?? []);
  return { hasActiveSearch, hasActiveSubmenu, selectedIndex, displayItems };
}

// ── Save a single change ────────────────────────────────────────

function saveChange(key: string, value: unknown, scope: "project" | "global", cwd: string): boolean {
  const filePath = getFilePathForScope(scope, cwd);
  const current = readSettingsFile(filePath);
  if (current === null) return false;
  if (value === undefined) {
    if (!(key in current)) return true;
    delete current[key];
  } else {
    current[key] = value;
  }
  if (Object.keys(current).length === 0 && !existsSync(filePath)) return true;
  writeSettingsFile(filePath, current);
  clearSettingsCache();
  return true;
}

// ── Delete a key from the current scope ─────────────────────────

function deleteFromScope(key: string, scope: "project" | "global", cwd: string): boolean {
  const filePath = getFilePathForScope(scope, cwd);
  const current = readSettingsFile(filePath);
  if (current === null) return false;
  if (!(key in current)) return true;
  delete current[key];
  writeSettingsFile(filePath, current);
  clearSettingsCache();
  return true;
}

// ── Parse value for agent_overrides ─────────────────────────────

function parseOverridesValue(rawValue: string): Record<string, { provider?: string | null; model?: string | null }> {
  try {
    const parsed = JSON.parse(rawValue);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return {};
}

// ── Settings overlay component ──────────────────────────────────

class SettingsOverlay implements Component {
  private tui: TUI;
  private theme: Theme;
  private cwd: string;
  private modelRegistry: ModelRegistry | undefined;
  private editScope: "project" | "global";
  private categoryIndex: number;
  private done: (value: undefined) => void;
  private notify: (msg: string, level: "info" | "error") => void;
  private settingsList!: SettingsList;
  private currentItems: SettingItem[];
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
    this.categoryIndex = 0;
    this.done = done;
    this.notify = notify;
    this.currentItems = [];
    this.rebuild();
  }

  private rebuild(): void {
    this.currentItems = buildCategoryItems(this.categoryIndex, this.cwd, this.editScope, this.theme, this.modelRegistry);

    this.settingsList = new SettingsList(
      this.currentItems,
      20,
      getSettingsListTheme(),
      (id: string, newValue: string) => {
        const def = SETTINGS_KEYS[id];
        if (!def) return;

        let parsed: unknown;
        if (def.type === "agent_overrides") {
          parsed = parseOverridesValue(newValue);
        } else {
          parsed = parseRawValue(id, newValue, def);
        }

        const filePath = getFilePathForScope(this.editScope, this.cwd);
        if (!saveChange(id, parsed, this.editScope, this.cwd)) {
          this.notify(`Failed to save: settings file is corrupt (${filePath})`, "error");
          return;
        }
        if (filePath.endsWith(".jsonc")) {
          this.notify("Note: comments were stripped from .jsonc file", "info");
        }

        // When provider changes, auto-clear the paired model to prevent stale cross-provider model
        if (id === "agent_provider") {
          saveChange("agent_model", "", this.editScope, this.cwd);
          const modelItem = this.currentItems.find((i) => i.id === "agent_model");
          if (modelItem) refreshItem(modelItem, this.cwd, this.theme);
        } else if (id === "internal_operations_provider") {
          saveChange("internal_operations_model", "", this.editScope, this.cwd);
          const modelItem = this.currentItems.find((i) => i.id === "internal_operations_model");
          if (modelItem) refreshItem(modelItem, this.cwd, this.theme);
        }

        // Update label + value in-place (SettingsList stores items by reference, no render cache)
        const item = this.currentItems.find((i) => i.id === id);
        if (item) refreshItem(item, this.cwd, this.theme);
        // SettingsOverlay render cache must be cleared; SettingsList has no render cache
        this.invalidate();
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

    // Left/Right to switch category tabs
    if (matchesKey(data, Key.left)) {
      this.categoryIndex = (this.categoryIndex - 1 + CATEGORIES.length) % CATEGORIES.length;
      this.rebuild();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.categoryIndex = (this.categoryIndex + 1) % CATEGORIES.length;
      this.rebuild();
      this.tui.requestRender();
      return;
    }

    // Delete key: remove setting from current scope (skip when search active or submenu open)
    if (matchesKey(data, Key.delete)) {
      const state = getSettingsListState(this.settingsList);
      if (!state.hasActiveSubmenu && !state.hasActiveSearch) {
        const selectedItem = state.displayItems[state.selectedIndex];
        if (selectedItem) {
          const filePath = getFilePathForScope(this.editScope, this.cwd);
          if (!deleteFromScope(selectedItem.id, this.editScope, this.cwd)) {
            this.notify(`Failed to delete: settings file is corrupt (${filePath})`, "error");
          } else {
            this.notify(`Deleted ${selectedItem.id} from ${this.editScope} scope`, "info");
            refreshItem(selectedItem, this.cwd, this.theme);
          }
          this.invalidate();
          this.tui.requestRender();
          return;
        }
      }
    }

    // Forward all input to SettingsList (handles navigation, enter, space, escape, search)
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

    const currentCategory = CATEGORIES[this.categoryIndex];
    const scopeLabel = this.editScope === "project" ? "Project" : "Global";

    // ── Header: category tabs ──
    const tabs: string[] = [];
    for (let i = 0; i < CATEGORIES.length; i++) {
      const cat = CATEGORIES[i];
      if (i === this.categoryIndex) {
        tabs.push(theme.fg("accent", theme.bold(` ${cat.label} `)));
      } else {
        tabs.push(theme.fg("dim", ` ${cat.label} `));
      }
    }
    const headerLeft = theme.fg("accent", theme.bold("Settings"));
    lines.push(truncateToWidth(`  ${headerLeft}  ${tabs.join(theme.fg("border", "│"))}`, width));

    // ── Top border with title ──
    const borderTitle = `${currentCategory.label} · ${scopeLabel} · ${currentCategory.keys.length} keys`;
    lines.push(
      theme.fg("border", "╭") +
      borderSegment(theme, innerWidth, borderTitle) +
      theme.fg("border", "╮"),
    );

    // ── Settings list body ──
    const divider = theme.fg("border", "│");
    const bodyHeight = Math.max(6, rows - 6);
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

    // ── Footer legend + hints ──
    const legend = `  ${theme.fg("success", "P")}=${theme.fg("dim", "project")}  ${theme.fg("accent", "G")}=${theme.fg("dim", "global")}  ${theme.fg("warning", "E")}=${theme.fg("dim", "env")}  ${theme.fg("dim", "D")}=${theme.fg("dim", "default")}`;
    lines.push(truncateToWidth(legend, width));
    lines.push(truncateToWidth(
      theme.fg("dim", `  ←→ category · Tab: ${scopeLabel === "Project" ? "Global" : "Project"} scope · ↑↓ navigate · Enter edit · Del remove · Esc close`),
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

// ── Main command handler ────────────────────────────────────────

async function openSettingsTui(ctx: ExtensionCommandContext, initialScope?: string): Promise<void> {
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/pi-config-settings requires TUI mode", "error");
    return;
  }

  const editScope: "project" | "global" = initialScope === "global" ? "global" : "project";
  const cwd = ctx.cwd;
  const modelRegistry = ctx.modelRegistry;

  // Clear cached settings so TUI always shows fresh values
  clearSettingsCache();

  await ctx.ui.custom<undefined>(
    (tui, theme, _kb, done) =>
      new SettingsOverlay(tui, theme, cwd, modelRegistry, editScope, done, (msg, level) => ctx.ui.notify(msg, level)),
    OVERLAY_OPTS,
  );
}

// ── Registration ────────────────────────────────────────────

export function registerSettingsTui(pi: ExtensionAPI): void {
  registerSettingsTuiCommand(pi, async (args, ctx) => {
    const scope = args?.trim().toLowerCase();
    await openSettingsTui(ctx, scope || undefined);
  });
}
