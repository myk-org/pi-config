/**
 * Project-level settings — loads .pi/pi-config-settings.json with env var fallback.
 *
 * Resolution order:
 * 1. Project .pi/pi-config-settings.json (wins if set)
 * 2. Global env var (PI_CO_AUTHOR, PI_USE_WORKTREES, PI_DREAM_INTERVAL_HOURS)
 * 3. Default (only dream_interval_hours has a default of 3)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
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
    return JSON.parse(readFileSync(settingsPath, "utf-8")) as ProjectSettings;
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

function getSettings(cwd: string): ProjectSettings {
  if (cwd === cachedCwd) return cachedSettings;
  cachedSettings = loadProjectSettings(cwd);
  cachedCwd = cwd;
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
export function migrateCoAuthorFile(cwd: string): void {
  const legacyPath = join(cwd, ".pi-co-author");
  if (!existsSync(legacyPath)) return;

  try {
    const settings = loadProjectSettings(cwd);
    if (settings.co_author === undefined) {
      settings.co_author = true;
    }
    saveProjectSettings(cwd, settings);
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
