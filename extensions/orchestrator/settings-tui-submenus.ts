/**
 * Settings TUI submenu components — input, picker, multi-select, agent overrides.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  type SelectItem,
  SelectList,
  matchesKey,
  Key,
  truncateToWidth,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { SettingsKeyDef } from "./project-settings.js";

// ── Input submenu component ─────────────────────────────────────────

export class InputSubmenu implements Component {
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

export class NumberInputSubmenu implements Component {
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

export class PickerSubmenu implements Component {
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
    this.selectList = new SelectList(items, Math.max(1, Math.min(items.length, 15)), getSelectListTheme());
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
      this.selectList = new SelectList(this.allItems, Math.max(1, Math.min(this.allItems.length, 15)), getSelectListTheme());
    } else {
      const filtered = fuzzyFilter(this.allItems, query, (item) => `${item.label} ${item.description || ""}`);
      this.selectList = new SelectList(filtered, Math.max(1, Math.min(filtered.length, 15)), getSelectListTheme());
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

export class MultiSelectSubmenu implements Component {
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

export class AgentOverridesSubmenu implements Component {
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
      // Return undefined for empty overrides so saveChange deletes the key
      if (Object.keys(this.overrides).length === 0) {
        this.done(undefined);
      } else {
        this.done(JSON.stringify(this.overrides));
      }
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
