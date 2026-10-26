/**
 * browser-ops — pidash browser operations that need config/CLI access (#968 D/F/G).
 *
 * Settings: read/write through the SAME project-settings modules the TUI uses
 * (settings-keys.json is the single source of truth; writeSettingsFile is the
 * atomic writer). Never a direct ad-hoc file write from the daemon.
 * MCP: `pi mcp` CLI (list --json / login / logout).
 */

import { execFileSync } from "node:child_process";
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
import { writeSettingsFile } from "../orchestrator/settings-tui-helpers.js";

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

/** Apply one setting to a scope's file. value === null removes the key. */
export function applySetting(
  cwd: string,
  scope: unknown,
  key: string,
  value: unknown,
): { ok: boolean; error?: string } {
  if (!isSettingsScope(scope)) return { ok: false, error: "invalid scope" };
  if (!(key in SETTINGS_KEYS)) return { ok: false, error: `unknown setting key: ${key}` };
  try {
    clearSettingsCache();
    let filePath: string;
    let data: Record<string, unknown>;
    if (scope === "project") {
      filePath = getSettingsPath(cwd);
      data = parseSettingsFile(filePath) as unknown as Record<string, unknown>;
    } else {
      filePath = getGlobalSettingsPath();
      data = loadGlobalSettings() as unknown as Record<string, unknown>;
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

/** Run `pi mcp <args>` and return stdout (throws with .stdout attached on failure). */
export function runMcp(args: string[], cwd: string, timeoutMs = 60000): string {
  const out = execFileSync("pi", ["mcp", ...args], {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_MCP_NO_BROWSER: process.env.PI_MCP_NO_BROWSER },
  });
  return out;
}

/** Parse `pi mcp list --json` output. Returns servers array or error. */
export function mcpList(cwd: string): { servers?: unknown[]; raw?: string; error?: string } {
  try {
    const out = runMcp(["list", "--json"], cwd);
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
