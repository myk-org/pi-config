/**
 * Settings TUI helpers — pure functions extracted for testability.
 * No pi-coding-agent or pi-tui dependencies.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import stripJsonComments from "strip-json-comments";
import {
  type SettingsKeyDef,
  getSettingsPath,
  getGlobalSettingsPath,
} from "./project-settings.js";

/** Sentinel value displayed for empty strings in the TUI. Centralized to prevent divergence. */
export const EMPTY_VALUE_SENTINEL = "(empty)";

const LOG_PREFIX = "[settings-tui]";
const loggedErrors = new Set<string>();
function logWarn(msg: string): void {
  // Deduplicate: only log each unique message once per session to avoid spam
  if (loggedErrors.has(msg)) return;
  loggedErrors.add(msg);
  try {
    const logDir = joinPath(homedir(), ".pi", "logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = joinPath(logDir, "settings-tui.log");
    appendFileSync(logPath, `${new Date().toISOString()} ${LOG_PREFIX} ${msg}\n`);
  } catch {}
}

// ── Category grouping ───────────────────────────────────────────────

export interface CategoryDef {
  label: string;
  keys: string[];
}

import settingsSchema from "../../settings-keys.json" with { type: "json" };

// Build CATEGORIES dynamically from schema `group` field.
// Preserves insertion order from settings-keys.json — groups appear
// in the order their first key is declared.
export const CATEGORIES: CategoryDef[] = (() => {
  const groupMap = new Map<string, string[]>();
  for (const [key, def] of Object.entries(settingsSchema)) {
    const group = (def as any).group || "Other";
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group)!.push(key);
  }
  return [...groupMap.entries()].map(([label, keys]) => ({ label, keys }));
})();

// ── Source detection ─────────────────────────────────────────────────

export type SettingSource = "P" | "G" | "E" | "D";

export function detectSource(key: string, def: SettingsKeyDef, cwd: string): SettingSource {
  // Check project settings file
  const projectPath = getSettingsPath(cwd);
  if (existsSync(projectPath)) {
    try {
      const raw = JSON.parse(stripJsonComments(readFileSync(projectPath, "utf-8")));
      if (typeof raw === "object" && raw !== null && key in raw) return "P";
    } catch (e: any) { logWarn(`parse error in ${projectPath}: ${e?.message?.slice(0, 100)}`); }
  }

  // Check global settings file (honors setGlobalSettingsPath for tests)
  const globalPath = getGlobalSettingsPath();
  if (existsSync(globalPath)) {
    try {
      const raw = JSON.parse(stripJsonComments(readFileSync(globalPath, "utf-8")));
      if (typeof raw === "object" && raw !== null && key in raw) return "G";
    } catch (e: any) { logWarn(`parse error in ${globalPath}: ${e?.message?.slice(0, 100)}`); }
  }

  // Check env var
  if (def.env && process.env[def.env] !== undefined && process.env[def.env] !== "") return "E";

  return "D";
}

// ── Value formatting ────────────────────────────────────────────────

export function formatValue(key: string, value: unknown, def: SettingsKeyDef): string {
  if (value === undefined || value === null) return String(def.default);

  // Mask secret-like keys
  const SECRET_PATTERNS = /token|secret|password|auth/i;
  if (def.type === "string" && SECRET_PATTERNS.test(key) && typeof value === "string" && value !== "") {
    return value.length > 4 ? "••••" + value.slice(-4) : "••••••••";
  }

  switch (def.type) {
    case "bool":
    case "bool_enable":
      return value ? "true" : "false";
    case "bool_or_string":
      if (typeof value === "boolean") return value ? "true" : "false";
      return String(value);
    case "int":
    case "port":
    case "number":
      return String(value);
    case "string":
      return value === "" ? EMPTY_VALUE_SENTINEL : String(value);
    case "agent_list":
      if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : EMPTY_VALUE_SENTINEL;
      return String(value);
    case "agent_overrides":
      if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value);
        return entries.length > 0 ? `${entries.length} override(s)` : "(none)";
      }
      return "(none)";
    default:
      return String(value);
  }
}

// ── Parse raw value for saving ──────────────────────────────────────

export function parseRawValue(key: string, rawValue: string, def: SettingsKeyDef): unknown {
  switch (def.type) {
    case "bool":
    case "bool_enable":
      return rawValue === "true";

    case "bool_or_string":
      if (rawValue === "true") return true;
      if (rawValue === "false") return false;
      return rawValue;

    case "int":
    case "port": {
      if (rawValue.trim() === "") return undefined;
      const n = Number(rawValue);
      return Number.isFinite(n) && Number.isInteger(n) ? n : def.default;
    }

    case "number": {
      if (rawValue.trim() === "") return undefined;
      const n = Number(rawValue);
      return Number.isFinite(n) ? n : def.default;
    }

    case "string":
      return rawValue === EMPTY_VALUE_SENTINEL ? "" : rawValue;

    case "agent_list":
      if (!rawValue || rawValue === EMPTY_VALUE_SENTINEL) return [];
      return rawValue.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

    default:
      return rawValue;
  }
}

// ── Scope-aware file read/write ─────────────────────────────────────

export function getFilePathForScope(scope: "project" | "global", cwd: string): string {
  if (scope === "project") {
    return getSettingsPath(cwd);
  }
  return getGlobalSettingsPath();
}

export function readSettingsFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(stripJsonComments(readFileSync(filePath, "utf-8")));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw;
  } catch (e: any) { logWarn(`parse error in ${filePath}: ${e?.message?.slice(0, 100)}`); }
  return null;
}

export function writeSettingsFile(filePath: string, data: Record<string, unknown>): void {
  // Write directly to target file. Per issue spec: "comments are lost on write — acceptable
  // since the example.jsonc is the reference."
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const content = JSON.stringify(data, null, 2) + "\n";
  const tmpPath = `${filePath}.${process.pid}.${Date.now().toString(36)}`;
  try {
    writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    renameSync(tmpPath, filePath);
  } catch (e: any) {
    // Clean up temp file on failure
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

// ── Secret submit guard (extracted for testability) ────────────────

/** Check if a secret input should be treated as "no change" (cancel). */
export function isSecretNoChange(val: string | undefined, scopeHasValue: boolean): boolean {
  if (scopeHasValue) return false; // value exists in scope — user is editing, not creating
  // Treat undefined, empty, whitespace-only, and the literal "(empty)" as no-change.
  // "(empty)" is the display placeholder that parseRawValue converts to "".
  return val === undefined || val?.trim() === "" || val?.trim() === EMPTY_VALUE_SENTINEL;
}

/** Resolve the prefill value for a secret key from the current scope's file only. */
export function resolveSecretPrefill(
  key: string,
  editScope: "project" | "global",
  cwd: string,
): { scopeValue: string | null; prefill: string; hint: string } {
  const scopeFile = getFilePathForScope(editScope, cwd);
  const scopeData = readSettingsFile(scopeFile);
  const scopeValue = scopeData && typeof scopeData[key] === "string" ? scopeData[key] as string : null;
  // Never prefill with the raw secret — always start empty to avoid exposing it on screen.
  // The user must type a new value; empty submit is handled by isSecretNoChange.
  const prefill = "";
  const hint = scopeValue !== null
    ? "Value set in this scope — enter new value or empty to clear"
    : "Enter new value (not set in this scope)";
  return { scopeValue, prefill, hint };
}

// ── Provider-filtered model items ───────────────────────────────

/** Filter model SelectItems by provider. Returns all models if provider is empty/undefined. */
export function filterModelsByProvider(
  allModels: Array<{ value: string; label: string; description?: string }>,
  provider?: string,
): Array<{ value: string; label: string; description?: string }> {
  if (!provider) return allModels;
  return allModels.filter((m) => m.description === provider);
}

// ── Source glyph (colored) ──────────────────────────────────────

export function sourceGlyph(source: string, theme: { fg: (color: string, text: string) => string }): string {
  switch (source) {
    case "P": return theme.fg("success", "P");
    case "G": return theme.fg("accent", "G");
    case "E": return theme.fg("warning", "E");
    case "D": return theme.fg("dim", "D");
    default:  return theme.fg("dim", "?");
  }
}

// ── Registration helper (testable without pi-coding-agent) ──────────

/**
 * Core registration logic extracted for testability.
 * Accepts a minimal pi-like object with registerCommand.
 */
export function registerSettingsTuiCommand(
  pi: { registerCommand: (name: string, opts: { description: string; handler: (...args: any[]) => any }) => void },
  handler: (args: string, ctx: any) => Promise<void>,
): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.registerCommand("pi-config-settings", {
    description: "Interactive settings editor for pi-config",
    handler,
  });
}
