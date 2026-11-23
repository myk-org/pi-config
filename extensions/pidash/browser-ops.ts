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
  getSettingsPath,
  loadGlobalSettings,
  loadProjectSettings,
  updateSetting,
  validateSetting,
  type SettingsScope,
} from "../orchestrator/project-settings.js";

const log = createLogger("pidash-browser-ops");

export type { SettingsScope };

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
  /** Resolved settings file path (project scope) — lets browsers decide
   * whether a broadcast describes THEIR settings file even when their session
   * cwd is a different worktree/subdir of the same repo (Qodo R5). */
  settingsPath?: string;
}

function isSettingsScope(v: unknown): v is SettingsScope {
  return v === "project" || v === "global";
}

/** Snapshot of every settings key for a scope, with the value stored in that scope's file. */
export function buildSettingsPayload(cwd: string, scope: unknown): SettingsPayload {
  if (!isSettingsScope(scope)) return { scope: "project", keys: [], error: "invalid scope" };
  try {
    clearSettingsCache();
    const stored = (
      scope === "project" ? loadProjectSettings(cwd) : loadGlobalSettings()
    ) as Record<string, unknown>;
    const keys: SettingsKeyPayload[] = Object.entries(SETTINGS_KEYS).map(([key, def]) => ({
      key,
      description: def.description,
      type: def.type,
      env: def.env,
      default: def.default,
      group: def.group ?? "General",
      enum: def.enum,
      min: def.min,
      max: def.max,
      stored: key in stored ? stored[key] : undefined,
    }));
    keys.sort((a, b) => (a.group === b.group ? a.key.localeCompare(b.key) : a.group.localeCompare(b.group)));
    log.debug("settings_payload_built", { scope, keys: keys.length });
    // Resolved file path (project scope only) — identity of the settings
    // file being described, independent of the session's cwd (Qodo R5).
    return { scope, keys, settingsPath: scope === "project" ? getSettingsPath(cwd) : undefined };
  } catch (e: any) {
    log.warn("settings_payload_failed", { scope, error: e?.message });
    return { scope, keys: [], error: e?.message };
  }
}

/**
 * Validate a browser-supplied value against the unified settings schema.
 * Adds the browser-only security policy blocking `dangerous_command_allowlist`.
 * Returns an error string, or null when the value is valid.
 */
export function validateSettingValue(key: string, value: unknown): string | null {
  if (key === "dangerous_command_allowlist") {
    return "dangerous_command_allowlist is managed by the terminal settings editor only";
  }
  const result = validateSetting(key, value, { allowNull: true });
  return result.ok ? null : result.error;
}

/** Apply one setting to a scope's file. value === null removes the key. */
export function applySetting(
  cwd: string,
  scope: unknown,
  key: string,
  value: unknown,
): { ok: boolean; error?: string } {
  if (!isSettingsScope(scope)) return { ok: false, error: "invalid scope" };
  const validationError = validateSettingValue(key, value);
  if (validationError) {
    log.warn("browser_setting_rejected", { scope, key, error: validationError });
    return { ok: false, error: validationError };
  }
  const result = updateSetting(cwd, scope, key, value);
  if (!result.ok) {
    if (result.reason === "corrupt") {
      log.warn("browser_setting_save_refused_malformed_file", { scope, key, filePath: result.file });
    } else {
      log.error("browser_setting_apply_failed", { scope, key, error: result.error });
    }
    return { ok: false, error: result.error };
  }
  log.info("browser_setting_applied", { scope, key, cleared: value === null });
  return { ok: true };
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
