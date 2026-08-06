/**
 * Settings TUI — interactive editor for pi-config settings.
 *
 * /pi-config-settings [scope] opens a fullscreen SettingsList overlay
 * showing all keys grouped by category with scope indicators [P]/[G]/[E]/[D].
 * Tab switches between project and global scope.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  type SettingItem,
  SettingsList,
  Text,
  matchesKey,
  Key,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
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

// ── Build setting items ─────────────────────────────────────────────

export function buildSettingItems(
  cwd: string,
  editScope: "project" | "global",
  theme: Theme,
): SettingItem[] {
  const items: SettingItem[] = [];

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

      // Configure interaction based on type
      switch (def.type) {
        case "bool":
        case "bool_enable":
          item.values = ["true", "false"];
          break;

        case "bool_or_string":
          // Submenu to toggle or enter custom string
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
          // Phase 2: multi-select submenu
          item.submenu = (current: string, done: (val?: string) => void): Component => {
            return new InputSubmenu(
              `${key} (comma-separated list)`,
              current === "(empty)" ? "" : current,
              "Enter agent names separated by commas",
              done,
            );
          };
          break;

        case "agent_overrides":
          // Phase 2: nested editor
          item.description = "Phase 2: nested editor";
          break;
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

// ── Main command handler ────────────────────────────────────────────

async function openSettingsTui(ctx: ExtensionCommandContext, initialScope?: string): Promise<void> {
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/pi-config-settings requires TUI mode", "error");
    return;
  }

  let editScope: "project" | "global" = initialScope === "global" ? "global" : "project";
  const cwd = ctx.cwd;

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

      items = buildSettingItems(cwd, editScope, theme);

      settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 20),
        getSettingsListTheme(),
        (id: string, newValue: string) => {
          // Skip category headers
          if (id.startsWith("__category_")) return;

          const def = SETTINGS_KEYS[id];
          if (!def) return;

          const parsed = parseRawValue(id, newValue, def);

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
