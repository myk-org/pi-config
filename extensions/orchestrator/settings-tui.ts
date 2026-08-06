/**
 * Settings TUI — interactive editor for pi-config settings.
 *
 * /pi-config-settings [scope] opens a fullscreen overlay with box-drawing borders,
 * themed header/footer, colored source glyphs, and fuzzy-searchable pickers.
 * Matches the async-status / cron overlay design pattern.
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
  resolveWritePath,
  registerSettingsTuiCommand,
  isSecretNoChange,
  resolveSecretPrefill,
  sourceGlyph,
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
  resolveWritePath,
  registerSettingsTuiCommand,
  isSecretNoChange,
  resolveSecretPrefill,
  sourceGlyph,
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
  // Read from the .json write target (not .jsonc) so TUI-saved values accumulate correctly.
  const writePath = resolveWritePath(filePath);
  const current = readSettingsFile(writePath);
  if (current === null) return false; // corrupt file — refuse to clobber
  if (value === undefined) {
    if (!(key in current)) return true; // key not present — nothing to clear
    delete current[key]; // clear/unset the key
  } else {
    current[key] = value;
  }
  // Skip write if result would be empty and file doesn't exist yet
  if (Object.keys(current).length === 0 && !existsSync(writePath)) return true;
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
          this.notify("Saved to .json (comments preserved in .jsonc)", "info");
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
