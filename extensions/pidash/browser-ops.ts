/**
 * browser-ops — pidash browser operations that need config/CLI access (#968 D/F/G).
 *
 * Settings: read/write through the SAME project-settings modules the TUI uses
 * (settings-keys.json is the single source of truth; writeSettingsFile is the
 * atomic writer). Never a direct ad-hoc file write from the daemon.
 * MCP: `pi mcp` CLI (list --json / login / logout).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { createLogger } from "../shared/logger.js";
import {
  SETTINGS_KEYS,
  clearSettingsCache,
  getGlobalSettingsPath,
  getSettingsPath,
  loadGlobalSettings,
  loadProjectSettings,
  parseSettingsFile,
} from "../orchestrator/project-settings.js";
import { readSettingsFile, writeSettingsFile } from "../orchestrator/settings-tui-helpers.js";

const log = createLogger("pidash-browser-ops");

export type SettingsScope = "project" | "global";

export interface SettingsKeyPayload {
  key: string;
  description: string;
  type: string;
  env?: string;
  default: unknown;
  group: string;
  enum?: string[];
  min?: number;
  max?: number;
  /** Value stored in the scope's file (undefined = not set there). */
  stored: unknown;
}

export interface SettingsPayload {
  scope: SettingsScope;
  keys: SettingsKeyPayload[];
  error?: string;
}

function isSettingsScope(v: unknown): v is SettingsScope {
  return v === "project" || v === "global";
}

/** Snapshot of every settings key for a scope, with the value stored in that scope's file. */
export function buildSettingsPayload(cwd: string, scope: unknown): SettingsPayload {
  if (!isSettingsScope(scope)) return { scope: "project", keys: [], error: "invalid scope" };
  try {
    clearSettingsCache();
    let stored: Record<string, unknown> = {};
    if (scope === "project") {
      stored = parseSettingsFile(getSettingsPath(cwd)) as unknown as Record<string, unknown>;
    } else {
      stored = loadGlobalSettings() as unknown as Record<string, unknown>;
    }
    const keys: SettingsKeyPayload[] = Object.entries(SETTINGS_KEYS).map(([key, def]) => ({
      key,
      description: def.description,
      type: def.type,
      env: def.env,
      default: def.default,
      group: (def as any).group ?? "General",
      enum: def.enum,
      min: def.min,
      max: def.max,
      stored: key in stored ? stored[key] : undefined,
    }));
    keys.sort((a, b) => (a.group === b.group ? a.key.localeCompare(b.key) : a.group.localeCompare(b.group)));
    log.debug("settings_payload_built", { scope, keys: keys.length });
    return { scope, keys };
  } catch (e: any) {
    log.warn("settings_payload_failed", { scope, error: e?.message });
    return { scope, keys: [], error: e?.message };
  }
}

/**
 * Validate a browser-supplied value against the settings-keys schema.
 * Mirrors the checks `parseSettingsFile` applies on read, so the browser can
 * never persist a value the terminal settings editor would reject or drop.
 * Returns an error string, or null when the value is valid.
 */
export function validateSettingValue(key: string, value: unknown): string | null {
  const def = (SETTINGS_KEYS as Record<string, any>)[key];
  if (!def) return `unknown setting key: ${key}`;
  // Security-sensitive: the dangerous-command allowlist has a dedicated
  // writer with trust/escaping checks (settings-tui) — never accept it over
  // the browser websocket.
  if (key === "dangerous_command_allowlist") {
    return "dangerous_command_allowlist is managed by the terminal settings editor only";
  }
  if (value === null) return null; // clear — removing the key is always valid
  const t = def.type as string;
  const isStr = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  switch (t) {
    case "bool":
    case "bool_enable":
      return typeof value === "boolean" ? null : `${key} must be a boolean`;
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${key} must be an integer`;
      if (def.min !== undefined && value < def.min) return `${key} must be >= ${def.min}`;
      if (def.max !== undefined && value > def.max) return `${key} must be <= ${def.max}`;
      return null;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${key} must be a finite number`;
      if (def.min !== undefined && value < def.min) return `${key} must be >= ${def.min}`;
      if (def.max !== undefined && value > def.max) return `${key} must be <= ${def.max}`;
      return null;
    case "port":
      return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535
        ? null
        : `${key} must be an integer between 1 and 65535`;
    case "string":
    case "enum":
    case "model":
    case "provider":
      if (!isStr(value)) return `${key} must be a non-empty string`;
      if (Array.isArray(def.enum) && def.enum.length > 0 && !def.enum.includes(value)) {
        return `${key} must be one of: ${def.enum.join(", ")}`;
      }
      return null;
    case "bool_or_string":
      return typeof value === "boolean" || isStr(value) ? null : `${key} must be a boolean or non-empty string`;
    case "string_list":
      if (!Array.isArray(value) || !value.every((v: unknown) => typeof v === "string")) {
        return `${key} must be an array of strings`;
      }
      return null;
    case "agent_list":
      if (typeof value === "string" || (Array.isArray(value) && value.every((v: unknown) => typeof v === "string"))) {
        return null;
      }
      return `${key} must be a string or array of strings`;
    case "agent_overrides":
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${key} must be an object mapping agent name to {provider?, model?}`;
      }
      return null;
    default:
      return `${key} has unsupported type ${t} for browser edits`;
  }
}

/** Apply one setting to a scope's file. value === null removes the key. */
export function applySetting(
  cwd: string,
  scope: unknown,
  key: string,
  value: unknown,
): { ok: boolean; error?: string } {
  if (!isSettingsScope(scope)) return { ok: false, error: "invalid scope" };
  if (!(key in SETTINGS_KEYS)) return { ok: false, error: `unknown setting key: ${key}` };
  const validationError = validateSettingValue(key, value);
  if (validationError) {
    log.warn("browser_setting_rejected", { scope, key, error: validationError });
    return { ok: false, error: validationError };
  }
  try {
    clearSettingsCache();
    const filePath = scope === "project" ? getSettingsPath(cwd) : getGlobalSettingsPath();
    // Read the RAW file — parseSettingsFile drops unknown keys and invalid
    // values, so a read-modify-write through it would rewrite the file
    // without them; and for malformed JSON it returns {} which would replace
    // the user's file with a one-key file. readSettingsFile preserves every
    // key and returns null for malformed files — refuse to save instead.
    const data = readSettingsFile(filePath);
    if (data === null) {
      log.warn("browser_setting_save_refused_malformed_file", { scope, key, filePath });
      return { ok: false, error: `${filePath} is malformed (invalid JSON or not an object) — fix it before saving from the browser` };
    }
    if (value === null) delete data[key];
    else data[key] = value;
    writeSettingsFile(filePath, data);
    clearSettingsCache();
    log.info("browser_setting_applied", { scope, key, cleared: value === null });
    return { ok: true };
  } catch (e: any) {
    log.error("browser_setting_apply_failed", { scope, key, error: e?.message });
    return { ok: false, error: e?.message };
  }
}

/**
 * Run `pi mcp <args>` and resolve stdout (rejects with .stdout attached on failure).
 *
 * Async on purpose: this runs inside the live Pi process's websocket handler,
 * and `pi mcp login` can wait on OAuth browser completion for minutes — a
 * synchronous exec would block the event loop (TUI, agent streaming, timers,
 * every pidash socket) for the whole timeout window.
 */
export async function runMcp(args: string[], cwd: string, timeoutMs = 60000): Promise<string> {
  const { stdout } = await execFileAsync("pi", ["mcp", ...args], {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, PI_MCP_NO_BROWSER: process.env.PI_MCP_NO_BROWSER },
  });
  return stdout;
}

/** Parse `pi mcp list --json` output. Returns servers array or error. */
export async function mcpList(cwd: string): Promise<{ servers?: unknown[]; raw?: string; error?: string }> {
  try {
    const out = await runMcp(["list", "--json"], cwd);
    try {
      const parsed = JSON.parse(out);
      return { servers: Array.isArray(parsed) ? parsed : parsed?.servers ?? [parsed] };
    } catch {
      // Not JSON — return raw text for display
      return { raw: out };
    }
  } catch (e: any) {
    log.warn("mcp_list_failed", { error: e?.message });
    return { error: (e?.stderr || e?.message || String(e)).slice(0, 2000) };
  }
}
