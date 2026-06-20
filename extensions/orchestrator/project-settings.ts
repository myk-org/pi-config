/**
 * Project-level settings — loads .pi/pi-config-settings.json with env var fallback.
 *
 * Resolution order:
 * 1. Project .pi/pi-config-settings.json (wins if set)
 * 2. Global ~/.pi/pi-config-settings.json (fallback for all projects)
 * 3. Env var (PI_COMMIT_TRAILER, PI_USE_WORKTREES, PI_DREAM_INTERVAL_HOURS, PI_DCO)
 * 4. Default (only dream_interval_hours has a default of 3)
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ProjectSettings {
  commit_trailer?: boolean | string;
  allow_push_to_protected_branches?: boolean;
  use_worktrees?: boolean;
  dream_interval_hours?: number;
  dco?: boolean;
}

const SETTINGS_FILENAME = "pi-config-settings.json";

function getSettingsPath(cwd: string): string {
  return join(cwd, ".pi", SETTINGS_FILENAME);
}

function parseSettingsFile(filePath: string): ProjectSettings {
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const result: ProjectSettings = {};
    if (typeof raw.commit_trailer === "boolean" || typeof raw.commit_trailer === "string") result.commit_trailer = raw.commit_trailer;
    if (typeof raw.allow_push_to_protected_branches === "boolean") result.allow_push_to_protected_branches = raw.allow_push_to_protected_branches;
    if (typeof raw.use_worktrees === "boolean") result.use_worktrees = raw.use_worktrees;
    if (typeof raw.dream_interval_hours === "number" && Number.isFinite(raw.dream_interval_hours)) {
      result.dream_interval_hours = raw.dream_interval_hours;
    }
    if (typeof raw.dco === "boolean") result.dco = raw.dco;
    return result;
  } catch (e: any) {
    console.debug(`[project-settings] failed to parse ${filePath}:`, e?.message?.slice(0, 100));
    return {};
  }
}

function loadProjectSettings(cwd: string): ProjectSettings {
  return parseSettingsFile(getSettingsPath(cwd));
}

function loadGlobalSettings(): ProjectSettings {
  return parseSettingsFile(join(homedir(), ".pi", SETTINGS_FILENAME));
}

function parseBoolEnv(name: string): boolean | undefined {
  const val = process.env[name];
  if (val === undefined || val === "") return undefined;
  return ["true", "1", "yes", "on"].includes(val.toLowerCase());
}

function parseNumEnv(name: string): number | undefined {
  const val = process.env[name];
  if (val === undefined || val === "") return undefined;
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : undefined;
}

/** Cached settings per cwd */
let cachedCwd = "";
let cachedSettings: ProjectSettings = {};
let cachedMtime = 0;
let lastMtimeCheck = 0;
const MTIME_CHECK_INTERVAL_MS = 30_000; // Check file mtime at most every 30s

function getSettings(cwd: string): ProjectSettings {
  const now = Date.now();
  // Different cwd — always reload
  if (cwd !== cachedCwd) {
    const projectSettings = loadProjectSettings(cwd);
    const globalSettings = loadGlobalSettings();
    cachedSettings = { ...globalSettings, ...projectSettings };
    cachedCwd = cwd;
    try {
      const settingsPath = getSettingsPath(cwd);
      cachedMtime = existsSync(settingsPath) ? statSync(settingsPath).mtimeMs : 0;
    } catch { cachedMtime = 0; }
    lastMtimeCheck = now;
    return cachedSettings;
  }
  // Same cwd — throttle mtime checks
  if (now - lastMtimeCheck < MTIME_CHECK_INTERVAL_MS) return cachedSettings;
  lastMtimeCheck = now;
  const settingsPath = getSettingsPath(cwd);
  let mtime = 0;
  try { if (existsSync(settingsPath)) mtime = statSync(settingsPath).mtimeMs; } catch {}
  if (mtime === cachedMtime) return cachedSettings;
  cachedSettings = { ...loadGlobalSettings(), ...loadProjectSettings(cwd) };
  cachedMtime = mtime;
  return cachedSettings;
}

/** Clear cache — call after migration or manual edits */
export function clearSettingsCache(): void {
  cachedCwd = "";
  cachedSettings = {};
}

/**
 * Get a setting value. Resolution: project file → env var → default.
 */
export function getSetting(cwd: string, key: "commit_trailer"): boolean | string;
export function getSetting(cwd: string, key: "allow_push_to_protected_branches"): boolean;
export function getSetting(cwd: string, key: "use_worktrees"): boolean;
export function getSetting(cwd: string, key: "dream_interval_hours"): number;
export function getSetting(cwd: string, key: "dco"): boolean;
export function getSetting(cwd: string, key: string): boolean | string | number {
  const settings = getSettings(cwd);

  switch (key) {
    case "commit_trailer": {
      if (settings.commit_trailer !== undefined) return settings.commit_trailer;
      const envStr = process.env.PI_COMMIT_TRAILER;
      if (envStr !== undefined && envStr !== "") {
        if (["true", "1", "yes", "on"].includes(envStr.toLowerCase())) return true;
        if (["false", "0", "no", "off"].includes(envStr.toLowerCase())) return false;
        return envStr; // treat as custom trailer string
      }
      return false; // default: disabled
    }
    case "allow_push_to_protected_branches": {
      if (settings.allow_push_to_protected_branches !== undefined) return settings.allow_push_to_protected_branches;
      const env = parseBoolEnv("PI_ALLOW_PUSH_TO_PROTECTED_BRANCHES");
      if (env !== undefined) return env;
      return false; // default: block pushes to protected branches
    }
    case "use_worktrees": {
      if (settings.use_worktrees !== undefined) return settings.use_worktrees;
      const env = parseBoolEnv("PI_USE_WORKTREES");
      if (env !== undefined) return env;
      return false; // default: disabled
    }
    case "dream_interval_hours": {
      if (settings.dream_interval_hours !== undefined) return settings.dream_interval_hours;
      const env = parseNumEnv("PI_DREAM_INTERVAL_HOURS");
      if (env !== undefined) return env;
      return 3; // default: 3 hours
    }
    case "dco": {
      if (settings.dco !== undefined) return settings.dco;
      const env = parseBoolEnv("PI_DCO");
      if (env !== undefined) return env;
      return false; // default: disabled
    }
    default:
      return false;
  }
}

/**
 * Register project settings — runs migration on session_start.
 */
export function registerProjectSettings(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.on("session_start", (_event, ctx) => {
    clearSettingsCache();
  });
}
