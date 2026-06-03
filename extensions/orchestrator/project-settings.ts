/**
 * Project-level settings — loads .pi/pi-config-settings.json with env var fallback.
 *
 * Resolution order:
 * 1. Project .pi/pi-config-settings.json (wins if set)
 * 2. Global env var (PI_CO_AUTHOR, PI_USE_WORKTREES, PI_DREAM_INTERVAL_HOURS)
 * 3. Default (only dream_interval_hours has a default of 3)
 */

import { existsSync, lstatSync, statSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ProjectSettings {
  co_author?: boolean;
  use_worktrees?: boolean;
  dream_interval_hours?: number;
}

const SETTINGS_FILENAME = "pi-config-settings.json";

function getSettingsPath(cwd: string): string {
  return join(cwd, ".pi", SETTINGS_FILENAME);
}

function loadProjectSettings(cwd: string): ProjectSettings {
  const settingsPath = getSettingsPath(cwd);
  if (!existsSync(settingsPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const result: ProjectSettings = {};
    if (typeof raw.co_author === "boolean") result.co_author = raw.co_author;
    if (typeof raw.use_worktrees === "boolean") result.use_worktrees = raw.use_worktrees;
    if (typeof raw.dream_interval_hours === "number" && Number.isFinite(raw.dream_interval_hours)) {
      result.dream_interval_hours = raw.dream_interval_hours;
    }
    return result;
  } catch {
    return {};
  }
}

function saveProjectSettings(cwd: string, settings: ProjectSettings): void {
  const settingsPath = getSettingsPath(cwd);
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
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
    cachedSettings = loadProjectSettings(cwd);
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
  cachedSettings = loadProjectSettings(cwd);
  cachedMtime = mtime;
  return cachedSettings;
}

/** Clear cache — call after migration or manual edits */
function clearSettingsCache(): void {
  cachedCwd = "";
  cachedSettings = {};
}

/**
 * Get a setting value. Resolution: project file → env var → default.
 */
export function getSetting(cwd: string, key: "co_author"): boolean;
export function getSetting(cwd: string, key: "use_worktrees"): boolean;
export function getSetting(cwd: string, key: "dream_interval_hours"): number;
export function getSetting(cwd: string, key: string): boolean | number {
  const settings = getSettings(cwd);

  switch (key) {
    case "co_author": {
      if (settings.co_author !== undefined) return settings.co_author;
      const env = parseBoolEnv("PI_CO_AUTHOR");
      if (env !== undefined) return env;
      return false; // default: disabled
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
    default:
      return false;
  }
}

/**
 * One-time migration: .pi-co-author file → pi-config-settings.json
 * Call on session_start. If .pi-co-author exists, migrate and delete it.
 */
function migrateCoAuthorFile(cwd: string): void {
  const legacyPath = join(cwd, ".pi-co-author");
  if (!existsSync(legacyPath)) return;

  try {
    const settingsPath = getSettingsPath(cwd);
    const dir = dirname(settingsPath);
    // Guard against symlink attacks — skip migration if .pi or settings file is a symlink
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
      console.debug("[project-settings] .pi dir is a symlink — skipping write, deleting legacy file");
      try { unlinkSync(legacyPath); } catch {}
      return;
    }
    if (existsSync(settingsPath) && lstatSync(settingsPath).isSymbolicLink()) {
      console.debug("[project-settings] settings file is a symlink — skipping write, deleting legacy file");
      try { unlinkSync(legacyPath); } catch {}
      return;
    }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Read raw JSON to preserve unknown keys
    let raw: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { raw = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) raw = {};
    }
    if (raw.co_author === undefined) {
      raw.co_author = true;
    }
    writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    unlinkSync(legacyPath);
    console.debug("[project-settings] Migrated .pi-co-author → pi-config-settings.json");
    clearSettingsCache();
  } catch (e: any) {
    console.debug("[project-settings] migration failed:", e?.message?.slice(0, 100));
  }
}

/**
 * Register project settings — runs migration on session_start.
 */
export function registerProjectSettings(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.on("session_start", (_event, ctx) => {
    migrateCoAuthorFile(ctx.cwd);
    clearSettingsCache();
  });
}
