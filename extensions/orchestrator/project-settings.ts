/**
 * Deep settings store — single source of truth for pi-config settings.
 *
 * Driven directly from `settings-keys.json` (zero parallel key tables or manual
 * per-key overloads). Owns:
 * - Schema validation and parsing (`validateSetting`, `parseSettingInput`, `parseSettingsFile`)
 * - Legacy `.jsonc` one-time migration (`findSettingsFile`, `migrateLegacySettingsFile`)
 * - Single coordinated layer cache (`layerCache`, `clearSettingsCache`, `resolveSetting`, `getSetting`)
 * - Locked atomic persistence with backup rotation and TUI visit snapshots (`readSettingsFile`,
 *   `writeSettingsFile`, `updateSetting`, `beginSettingsEditSession`, `endSettingsEditSession`)
 *
 * Cycle-free by design: imports only Node built-ins and `strip-json-comments` so
 * `extensions/shared/file-logger.ts` can read `log_*` settings through the exact
 * same cache and validator. `extensions/shared/logger.ts` injects a bootstrap logger
 * via `setSettingsLogger`.
 *
 * Resolution order:
 * 1. Project `.pi/pi-config-settings.json`
 * 2. Global `~/.pi/pi-config-settings.json`
 * 3. Environment variable declared in `settings-keys.json`
 * 4. Default value declared in `settings-keys.json`
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import stripJsonComments from "strip-json-comments";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
type SettingsKeysSchema = typeof import("../../settings-keys.json");

// ── Injected bootstrap logger (avoids cycle with extensions/shared/logger.ts) ──

export interface SettingsLogger {
  debug(message: string, context?: object): void;
  info(message: string, context?: object): void;
  warn(message: string, context?: object): void;
  error(message: string, context?: object): void;
}

const noop = (): void => {};
let log: SettingsLogger = { debug: noop, info: noop, warn: noop, error: noop };

/** Inject logger (wired at bootstrap by `extensions/shared/logger.ts` with bypassLevelResolution). */
export function setSettingsLogger(logger: Partial<SettingsLogger>): void {
  log = {
    debug: logger.debug ?? noop,
    info: logger.info ?? noop,
    warn: logger.warn ?? noop,
    error: logger.error ?? noop,
  };
}

// ── Schema & derived types (directly from settings-keys.json) ───────

export type SettingKey = keyof SettingsKeysSchema;
export type AgentOverrideEntry = { provider?: string | null; model?: string | null };
export type AgentOverrides = Record<string, AgentOverrideEntry>;

type SpecialSettingValueMap = {
  commit_trailer: boolean | string;
  dangerous_command_allowlist: string[];
  restricted_folders: string[];
  agent_overrides: AgentOverrides;
};

export type SettingValue<K extends SettingKey> =
  K extends keyof SpecialSettingValueMap
    ? SpecialSettingValueMap[K]
    : SettingsKeysSchema[K]["default"] extends boolean
      ? boolean
      : SettingsKeysSchema[K]["default"] extends number
        ? number
        : SettingsKeysSchema[K]["default"] extends string
          ? string
          : unknown;

export type ProjectSettings = { [K in SettingKey]?: SettingValue<K> };
export type AnySettingValue = boolean | string | number | string[] | AgentOverrides;
export type SettingsScope = "project" | "global";
export type SettingSource = "P" | "G" | "E" | "D";

export interface SettingsKeyDef {
  description: string;
  type: string;
  env?: string;
  default: unknown;
  min?: number;
  max?: number;
  strict_digits?: boolean;
  per_key_resolution?: boolean;
  enum?: string[];
  group?: string;
}

export const SETTINGS_KEYS: Record<string, SettingsKeyDef> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "settings-keys.json"), "utf8"),
);

/** Sentinel value displayed for empty strings in the TUI. */
export const EMPTY_VALUE_SENTINEL = "(empty)";

/** The only settings filename — one name, one precedence, project and global alike. */
export const SETTINGS_FILENAMES = ["pi-config-settings.json"];

/** Legacy settings file, no longer read: migrated away once, then ignored (issue #1086). */
export const LEGACY_SETTINGS_FILENAME = "pi-config-settings.jsonc";

/** Suffix the legacy file is moved to — it can never shadow the `.json` again. */
const LEGACY_MIGRATED_SUFFIX = ".migrated";

// ── Path & sandbox helpers ──────────────────────────────────────────

/** `realpath` of the nearest path that exists, so a symlinked parent cannot hide the target. */
export function nearestRealPath(target: string): string {
  const absolute = resolve(target);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.push(basename(current));
      current = parent;
    }
  }
}

function isInsideTempTree(targetPath: string): boolean {
  const base = nearestRealPath(tmpdir());
  const target = nearestRealPath(targetPath);
  return target === base || target.startsWith(base + sep);
}

// ── Canonical repository root resolution (cached, cycle-free) ───────

const REPO_ROOT_CACHE_MAX = 512;
/** Cached main-checkout root per resolved cwd ("" represents "not a git repo"). LRU-evicted. */
const mainCheckoutRootCache = new Map<string, string>();
let repoRootResolverOverride: ((cwd: string) => string) | null = null;
const overrideRepoRootCache = new Map<string, string>();

export function setRepoRootResolverForTests(resolver: ((cwd: string) => string) | null): void {
  repoRootResolverOverride = resolver;
  overrideRepoRootCache.clear();
  mainCheckoutRootCache.clear();
  clearSettingsCache();
}

function tryResolveMainCheckoutRootUncached(cwd: string): string | null {
  const runGit = (args: string[]): string | null => {
    try {
      const out = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out && !out.startsWith("fatal") ? out : null;
    } catch {
      return null;
    }
  };
  const common =
    runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]) ??
    runGit(["rev-parse", "--git-common-dir"]);
  if (common !== null) {
    return dirname(resolve(cwd, common));
  }

  // Fallback for fake/offline repos or linked worktrees when git CLI fails
  let current = resolve(cwd);
  for (;;) {
    const dotGit = join(current, ".git");
    if (existsSync(dotGit)) {
      try {
        if (statSync(dotGit).isDirectory()) return current;
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (match) {
          const gitDir = resolve(current, match[1].trim());
          if (!gitDir.split(sep).join("/").includes("/.git/modules/")) {
            const commonFile = join(gitDir, "commondir");
            if (existsSync(commonFile)) {
              return dirname(resolve(gitDir, readFileSync(commonFile, "utf8").trim()));
            }
          }
        }
      } catch {
        // Fall through to returning current directory
      }
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Resolve the main checkout root (the repo owning a worktree), or null when
 * `cwd` is not inside a git repository. Single canonical implementation shared
 * by `project-settings.ts` and `utils.ts` so settings, memory, and data dirs
 * always resolve identically (even when git CLI fails).
 */
export function tryResolveMainCheckoutRoot(cwd: string): string | null {
  const resolvedCwd = resolve(cwd);
  const cached = mainCheckoutRootCache.get(resolvedCwd);
  if (cached !== undefined) {
    // Promote to MRU so hot roots like process.cwd() are never evicted by temp-dir bursts.
    mainCheckoutRootCache.delete(resolvedCwd);
    mainCheckoutRootCache.set(resolvedCwd, cached);
    return cached === "" ? null : cached;
  }
  const root = tryResolveMainCheckoutRootUncached(resolvedCwd);
  if (mainCheckoutRootCache.size >= REPO_ROOT_CACHE_MAX) {
    const oldest = mainCheckoutRootCache.keys().next().value;
    if (oldest !== undefined) mainCheckoutRootCache.delete(oldest);
  }
  mainCheckoutRootCache.set(resolvedCwd, root ?? "");
  return root;
}

/** Main checkout root, or `resolve(cwd)` when not inside a git repo. */
export function resolveMainCheckoutRoot(cwd: string): string {
  return tryResolveMainCheckoutRoot(cwd) ?? resolve(cwd);
}

function resolveRepoRoot(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  if (repoRootResolverOverride) {
    const cached = overrideRepoRootCache.get(resolvedCwd);
    if (cached !== undefined) return cached;
    const root = repoRootResolverOverride(resolvedCwd);
    if (overrideRepoRootCache.size >= REPO_ROOT_CACHE_MAX) {
      const oldest = overrideRepoRootCache.keys().next().value;
      if (oldest !== undefined) overrideRepoRootCache.delete(oldest);
    }
    overrideRepoRootCache.set(resolvedCwd, root);
    return root;
  }
  return resolveMainCheckoutRoot(resolvedCwd);
}

// ── Legacy `.jsonc` one-time migration (issue #1086) ────────────────

/** One warning per directory and reason: settings resolution runs on nearly every tool call, so a
 *  file that stays ignored/refused/corrupt must not re-log on each read. Path only, never values. */
const legacyWarned = new Set<string>();
function warnLegacyOnce(reason: string, message: string, file: string): void {
  const key = `${reason}\0${dirname(file)}`;
  if (legacyWarned.has(key)) return;
  legacyWarned.add(key);
  log.warn(message, { path: file });
}

/** Test processes may only migrate inside the OS temp tree: a test that merely resolves
 *  settings must never rewrite the user's real `~/.pi` — the same safety net `writeSettingsFile`
 *  has. Production runs are unaffected. */
function migrationAllowed(dir: string): boolean {
  if (process.env.NODE_TEST_CONTEXT === undefined) return true;
  return isInsideTempTree(dir);
}

/** Whether git tracks the legacy file, in the repo that owns it. `"unknown"` (git failed for an
 *  unrelated reason) counts as tracked: a migration that MIGHT launder a clone's settings must not
 *  happen. Exit 1 means "not in the index" — the normal, migratable case. */
function legacyTracked(dir: string, legacy: string): boolean {
  try {
    const out = execFileSync("git", ["ls-files", "--error-unmatch", "--", legacy], {
      cwd: dir,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out !== "";
  } catch (error) {
    const { status, stderr } = error as { status?: number; stderr?: string };
    if (status === 1) return false;
    if (status === 128 && /not a git repository/i.test(String(stderr ?? ""))) return false;
    log.warn("settings_legacy_jsonc_git_check_failed", { path: legacy, fallback: "not migrated" });
    return true;
  }
}

/** Directories whose tracked legacy file was already refused in THIS process. */
const legacyTrackedRefused = new Set<string>();
function legacyTrackedRefusal(dir: string, legacy: string): boolean {
  if (legacyTrackedRefused.has(dirname(legacy))) return true;
  if (!legacyTracked(dir, legacy)) return false;
  legacyTrackedRefused.add(dirname(legacy));
  return true;
}

/** The nearest ancestor (or self) that contains `.git`, lexically — no git exec per resolution. */
function lexicalRepoRoot(dir: string): string | null {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

/** Whether a repo could have SHIPPED the settings dir as a link: the dir itself, or a component
 *  between it and the repo root. Symlinks above the repo root are the user's own layout and must
 *  not block a migration. */
function projectDirShippedAsSymlink(dir: string): boolean {
  const leaf = resolve(dir);
  try {
    if (lstatSync(leaf).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  const root = lexicalRepoRoot(leaf);
  if (root === null || root === leaf) return false;
  for (let current = dirname(leaf); current !== root; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** The settings object at `file`, or `null` when it is missing or not a JSON object. */
function readSettingsObjectOrNull(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

let publishSettingsFile: (from: string, to: string) => void = renameSync;

export function setPublishSettingsFileForTests(publish: ((from: string, to: string) => void) | null): void {
  publishSettingsFile = publish ?? renameSync;
}

/** A legacy file that exists while its `.json` does not, and cannot be parsed. */
export function legacyMigrationBlocked(dir: string): boolean {
  const legacy = join(dir, LEGACY_SETTINGS_FILENAME);
  if (!existsSync(legacy) || existsSync(join(dir, SETTINGS_FILENAMES[0]))) return false;
  return readLegacySettings(legacy) === null && existsSync(legacy);
}

/** Reads and parses the legacy file; `null` means "nothing to migrate". */
export function readLegacySettings(file: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    data = null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    warnLegacyOnce("corrupt", "settings_legacy_jsonc_corrupt", file);
    return null;
  }
  return data as Record<string, unknown>;
}

export interface FindSettingsOptions {
  /** Which settings root `dir` is. Defaults to `"project"`. */
  scope?: SettingsScope;
}

/** ONE-TIME migration away from the legacy `.jsonc` file (issue #1086). */
export function migrateLegacySettingsFile(dir: string, options: FindSettingsOptions = {}): void {
  if (!migrationAllowed(dir)) return;
  const scope = options.scope ?? "project";
  if (scope === "project" && projectDirShippedAsSymlink(dir)) {
    warnLegacyOnce("dir_symlink", "settings_legacy_jsonc_dir_symlink_refused", dir);
    return;
  }
  const legacy = join(dir, LEGACY_SETTINGS_FILENAME);
  let legacyStat;
  try {
    legacyStat = lstatSync(legacy);
  } catch {
    return;
  }
  if (legacyStat.isSymbolicLink()) {
    warnLegacyOnce("symlink", "settings_legacy_jsonc_symlink_refused", legacy);
    return;
  }
  const target = join(dir, SETTINGS_FILENAMES[0]);
  if (existsSync(target)) {
    warnLegacyOnce("ignored", "settings_legacy_jsonc_ignored", legacy);
    return;
  }

  const data = readLegacySettings(legacy);
  if (data === null) return;
  if (scope === "project" && legacyTrackedRefusal(dir, legacy)) {
    warnLegacyOnce("tracked", "settings_legacy_jsonc_tracked_refused", legacy);
    return;
  }

  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    log.warn("settings_legacy_jsonc_migrate_failed", { path: legacy });
    return;
  }
  let publishError: NodeJS.ErrnoException | undefined;
  try {
    if (!existsSync(target)) publishSettingsFile(tmp, target);
  } catch (error) {
    publishError = error as NodeJS.ErrnoException;
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* temp file left behind */
    }
  }

  if (readSettingsObjectOrNull(target) === null) {
    log.warn("settings_legacy_jsonc_migrate_failed", {
      path: legacy,
      code: publishError?.code ?? (existsSync(target) ? "invalid_target" : "ENOENT"),
    });
    return;
  }

  try {
    renameSync(legacy, join(dir, `${LEGACY_SETTINGS_FILENAME}${LEGACY_MIGRATED_SUFFIX}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("settings_legacy_jsonc_rename_failed", { path: legacy });
      return;
    }
  }
  log.info("settings_legacy_jsonc_migrated", { path: legacy });
}

export function findSettingsFile(dir: string, options: FindSettingsOptions = {}): string | null {
  migrateLegacySettingsFile(dir, options);
  for (const name of SETTINGS_FILENAMES) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

// ── File path resolution ────────────────────────────────────────────

/** Override global settings path for testing. Pass null to restore default. Clears cache. */
let globalSettingsPathOverride: string | null = null;

export function setGlobalSettingsPath(path: string | null): void {
  globalSettingsPathOverride = path;
  clearSettingsCache();
}

export function getSettingsPath(cwd: string): string {
  const piDir = join(resolveRepoRoot(cwd), ".pi");
  return findSettingsFile(piDir) ?? join(piDir, SETTINGS_FILENAMES[0]);
}

/**
 * Resolved global settings file path (honors test override).
 *
 * Under `node:test` (`NODE_TEST_CONTEXT`), an unset override with a real (non-temp)
 * `HOME` redirects to a throwaway per-process temp file so a test can never read or
 * mutate the user's real `~/.pi/pi-config-settings.json`. Tests that explicitly point
 * `process.env.HOME` inside the OS temp tree still use `<HOME>/.pi/pi-config-settings.json`.
 */
export function getGlobalSettingsPath(): string {
  if (globalSettingsPathOverride) return globalSettingsPathOverride;
  const home = process.env.HOME || homedir();
  if (process.env.NODE_TEST_CONTEXT !== undefined && !isInsideTempTree(home)) {
    return join(tmpdir(), `pi-config-test-global-settings-${process.pid}.json`);
  }
  const piDir = join(home, ".pi");
  return findSettingsFile(piDir, { scope: "global" }) ?? join(piDir, SETTINGS_FILENAMES[0]);
}

export function getFilePathForScope(scope: SettingsScope, cwd: string): string {
  return scope === "project" ? getSettingsPath(cwd) : getGlobalSettingsPath();
}

// ── Unified schema validator & parser (single source of truth) ──────

export type ValidationResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ValidateSettingOptions {
  /** Treat `null` as a valid "clear key" sentinel (used by browser/API edits). */
  allowNull?: boolean;
  /**
   * - `"strict"` (default, writes/TUI/browser): rejects invalid entries inside arrays/objects.
   * - `"lenient"` (file reads): drops malformed entries inside `string_list`/`agent_overrides`
   *   so one bad entry does not discard valid siblings, while still enforcing type/enum/min/max.
   */
  mode?: "strict" | "lenient";
}

function validateAgentOverrides(
  key: string,
  value: unknown,
  mode: "strict" | "lenient",
): ValidationResult<AgentOverrides> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `${key} must be an object mapping agent name to {provider?, model?}` };
  }
  const rawEntries = Object.entries(value as Record<string, unknown>);
  const overrides: AgentOverrides = {};
  for (const [name, val] of rawEntries) {
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      if (mode === "strict") {
        return { ok: false, error: `${key}.${name} must be an object with {provider?, model?}` };
      }
      continue;
    }
    const v = val as { provider?: unknown; model?: unknown };
    const entry: AgentOverrideEntry = {};
    if (v.provider === null) {
      entry.provider = null;
    } else if (typeof v.provider === "string") {
      entry.provider = v.provider.trim() || undefined;
    } else if (v.provider !== undefined) {
      if (mode === "strict") {
        return { ok: false, error: `${key}.${name}.provider must be a string or null` };
      }
    }
    if (v.model === null) {
      entry.model = null;
    } else if (typeof v.model === "string") {
      entry.model = v.model.trim() || undefined;
    } else if (v.model !== undefined) {
      if (mode === "strict") {
        return { ok: false, error: `${key}.${name}.model must be a string or null` };
      }
    }
    if (entry.provider !== undefined || entry.model !== undefined) {
      overrides[name] = entry;
    } else if (mode === "strict") {
      overrides[name] = entry;
    }
  }
  if (mode === "lenient" && rawEntries.length > 0 && Object.keys(overrides).length === 0) {
    return { ok: false, error: `${key} has no valid override entries` };
  }
  return { ok: true, value: overrides };
}

/**
 * Validate and normalize a single setting value against `settings-keys.json`.
 * Used consistently across file parsing, env resolution, TUI edits, and browser edits.
 */
export function validateSetting(
  key: string,
  value: unknown,
  options: ValidateSettingOptions = {},
): ValidationResult {
  const def = SETTINGS_KEYS[key];
  if (!def) return { ok: false, error: `unknown setting key: ${key}` };
  if (value === null && options.allowNull) return { ok: true, value: null };
  const mode = options.mode ?? "strict";

  switch (def.type) {
    case "bool":
    case "bool_enable":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, error: `${key} must be a boolean` };

    case "bool_or_string":
      if (typeof value === "boolean") return { ok: true, value };
      if (typeof value === "string") return { ok: true, value: value.trim() };
      return { ok: false, error: `${key} must be a boolean or string` };

    case "int": {
      let num: number;
      if (typeof value === "number") {
        if (!Number.isInteger(value)) return { ok: false, error: `${key} must be an integer` };
        num = value;
      } else if (typeof value === "string" && def.strict_digits) {
        const trimmed = value.trim();
        if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) {
          return { ok: false, error: `${key} must be an integer` };
        }
        num = Number(trimmed);
        if (!Number.isSafeInteger(num)) return { ok: false, error: `${key} must be an integer` };
      } else {
        return { ok: false, error: `${key} must be an integer` };
      }
      if (def.min !== undefined && num < def.min) return { ok: false, error: `${key} must be >= ${def.min}` };
      if (def.max !== undefined && num > def.max) return { ok: false, error: `${key} must be <= ${def.max}` };
      return { ok: true, value: num };
    }

    case "port": {
      const min = def.min ?? 1;
      const max = def.max ?? 65535;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        return { ok: false, error: `${key} must be an integer between ${min} and ${max}` };
      }
      return { ok: true, value };
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `${key} must be a finite number` };
      }
      if (def.min !== undefined && value < def.min) return { ok: false, error: `${key} must be >= ${def.min}` };
      if (def.max !== undefined && value > def.max) return { ok: false, error: `${key} must be <= ${def.max}` };
      return { ok: true, value };
    }

    case "string": {
      if (typeof value !== "string") return { ok: false, error: `${key} must be a string` };
      const trimmed = value.trim();
      if (Array.isArray(def.enum) && def.enum.length > 0 && !def.enum.includes(trimmed)) {
        return { ok: false, error: `${key} must be one of: ${def.enum.join(", ")}` };
      }
      return { ok: true, value: trimmed };
    }

    case "string_list": {
      if (!Array.isArray(value)) return { ok: false, error: `${key} must be an array of strings` };
      if (mode === "lenient") {
        const list = value.filter((e): e is string => typeof e === "string" && e.length > 0);
        if (value.length > 0 && list.length === 0) {
          return { ok: false, error: `${key} has no valid string entries` };
        }
        return { ok: true, value: list };
      }
      if (!value.every((e) => typeof e === "string" && e.length > 0)) {
        return { ok: false, error: `${key} must be an array of non-empty strings` };
      }
      return { ok: true, value: [...value] };
    }

    case "agent_overrides":
      return validateAgentOverrides(key, value, mode);

    default:
      return { ok: false, error: `${key} has unsupported type ${def.type}` };
  }
}

/**
 * Parse and validate a string input (from TUI or CLI) against `settings-keys.json`.
 * Empty string for numeric types returns `{ ok: true, value: undefined }` (clear/unset).
 */
export function parseSettingInput(key: string, rawValue: string): ValidationResult {
  const def = SETTINGS_KEYS[key];
  if (!def) return { ok: false, error: `unknown setting key: ${key}` };

  switch (def.type) {
    case "bool":
    case "bool_enable":
      if (rawValue === "true") return { ok: true, value: true };
      if (rawValue === "false") return { ok: true, value: false };
      return { ok: false, error: `${key} must be "true" or "false"` };

    case "bool_or_string":
      if (rawValue === "true") return { ok: true, value: true };
      if (rawValue === "false") return { ok: true, value: false };
      return validateSetting(key, rawValue);

    case "int": {
      const trimmed = rawValue.trim();
      if (trimmed === "") return { ok: true, value: undefined };
      if (def.strict_digits) return validateSetting(key, trimmed);
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: `${key} must be an integer` };
      return validateSetting(key, Number(trimmed));
    }

    case "port": {
      const trimmed = rawValue.trim();
      if (trimmed === "") return { ok: true, value: undefined };
      if (!/^\d+$/.test(trimmed)) {
        const min = def.min ?? 1;
        const max = def.max ?? 65535;
        return { ok: false, error: `${key} must be an integer between ${min} and ${max}` };
      }
      return validateSetting(key, Number(trimmed));
    }

    case "number": {
      const trimmed = rawValue.trim();
      if (trimmed === "") return { ok: true, value: undefined };
      return validateSetting(key, Number(trimmed));
    }

    case "string": {
      const normalized = rawValue === EMPTY_VALUE_SENTINEL ? "" : rawValue;
      return validateSetting(key, normalized);
    }

    case "string_list": {
      // StringListSubmenu commits JSON; accept a hand-typed single pattern too.
      try {
        const parsed = JSON.parse(rawValue);
        if (Array.isArray(parsed)) {
          const list = parsed.filter((e): e is string => typeof e === "string" && e.length > 0);
          return { ok: true, value: list };
        }
      } catch {
        // Fall through to single-pattern parsing
      }
      const trimmed = rawValue.trim();
      return { ok: true, value: trimmed !== "" ? [trimmed] : [] };
    }

    case "agent_overrides": {
      try {
        const parsed = JSON.parse(rawValue);
        return validateSetting(key, parsed);
      } catch {
        return { ok: false, error: `${key} must be a valid JSON object` };
      }
    }

    default:
      return { ok: false, error: `${key} has unsupported type ${def.type}` };
  }
}

/**
 * Parse `review_loop_max_cycles` from a raw settings-file or env value.
 * Delegates to the unified schema validator (`strict_digits`, `min: 1`, `max: 10`).
 */
export function parseReviewLoopMaxCycles(raw: unknown): number | undefined {
  const res = validateSetting("review_loop_max_cycles", raw);
  return res.ok ? (res.value as number) : undefined;
}

/** Parse and validate an env var for `key` using the unified schema validator. */
function parseEnvSetting(key: string, def: SettingsKeyDef): unknown | undefined {
  if (!def.env) return undefined;
  const raw = process.env[def.env];
  if (raw === undefined || raw === "") return undefined;

  switch (def.type) {
    case "bool":
      return ["true", "1", "yes", "on"].includes(raw.trim().toLowerCase());
    case "bool_enable":
      return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
    case "bool_or_string": {
      const lower = raw.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(lower)) return true;
      if (["false", "0", "no", "off"].includes(lower)) return false;
      return raw;
    }
    case "int": {
      const trimmed = raw.trim();
      const res = def.strict_digits
        ? validateSetting(key, trimmed)
        : /^-?\d+$/.test(trimmed)
          ? validateSetting(key, Number(trimmed))
          : { ok: false as const, error: "not an integer" };
      return res.ok ? res.value : undefined;
    }
    case "port": {
      const trimmed = raw.trim();
      if (!/^\d+$/.test(trimmed)) return undefined;
      const res = validateSetting(key, Number(trimmed));
      return res.ok ? res.value : undefined;
    }
    case "number": {
      const trimmed = raw.trim();
      if (trimmed === "") return undefined;
      const res = validateSetting(key, Number(trimmed));
      return res.ok ? res.value : undefined;
    }
    case "string": {
      const res = validateSetting(key, raw);
      return res.ok ? res.value : undefined;
    }
    default:
      return undefined;
  }
}

/** True when a model id looks like a Google/Gemini image-generation model. */
export function isImageGenModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes("imagen") ||
    lower.includes("image-generation") ||
    /(?:^|[-_./])image(?:[-_./]|$)/.test(lower)
  );
}

// ── File reading & schema-driven parsing ────────────────────────────

/**
 * Read raw JSON object from a settings file (preserving unknown keys).
 * Returns `{}` if the file does not exist, or `null` if it exists but cannot be parsed
 * as a JSON object (corrupt/array/primitive).
 */
export function readSettingsFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(stripJsonComments(readFileSync(filePath, "utf-8")));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    log.warn("settings file is not a JSON object", { path: filePath });
  } catch (error) {
    log.warn("settings read or parse failed", {
      path: filePath,
      error: error instanceof Error ? error.message.slice(0, 120) : String(error),
    });
  }
  return null;
}

/** Read the full raw settings object, returning `{}` when missing or unparseable (non-mutating callers). */
export function readSettingsObject(file: string | null): Record<string, unknown> {
  if (!file) return {};
  return readSettingsFile(file) ?? {};
}

/** Parse and validate all known schema keys from a settings file. */
export function parseSettingsFile(filePath: string): ProjectSettings {
  if (!existsSync(filePath)) return {};
  const raw = readSettingsFile(filePath);
  if (raw === null) return {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(SETTINGS_KEYS)) {
    if (!(key in raw)) continue;
    const validated = validateSetting(key, raw[key], { mode: "lenient" });
    if (validated.ok) {
      result[key] = validated.value;
    }
  }
  return result as ProjectSettings;
}

export function loadProjectSettings(cwd: string): ProjectSettings {
  return parseSettingsFile(getSettingsPath(cwd));
}

export function loadGlobalSettings(): ProjectSettings {
  return parseSettingsFile(getGlobalSettingsPath());
}

// ── Single coordinated layer cache ──────────────────────────────────

const SETTINGS_CACHE_TTL_MS = 30_000;
const SETTINGS_CACHE_MAX = 32;

interface CachedLayer {
  checkedAt: number;
  file: string | null;
  mtimeMs: number;
  parsed: ProjectSettings;
}

const layerCache = new Map<string, CachedLayer>();

/** Clear the unified settings cache (shared by getSetting, file-logger, TUI, and browser-ops). */
export function clearSettingsCache(): void {
  layerCache.clear();
}

function readCachedLayer(scope: SettingsScope, cwd: string): CachedLayer {
  const now = Date.now();
  let cacheKey: string;
  let resolveFile: () => string | null;

  if (scope === "project") {
    const dir = join(resolveRepoRoot(cwd), ".pi");
    cacheKey = `project\0${dir}`;
    resolveFile = () => findSettingsFile(dir);
  } else if (globalSettingsPathOverride) {
    const override = globalSettingsPathOverride;
    cacheKey = `global-file\0${override}`;
    resolveFile = () => (existsSync(override) ? override : null);
  } else {
    const home = process.env.HOME || homedir();
    if (process.env.NODE_TEST_CONTEXT !== undefined && !isInsideTempTree(home)) {
      const testGlobal = join(tmpdir(), `pi-config-test-global-settings-${process.pid}.json`);
      cacheKey = `global-file\0${testGlobal}`;
      resolveFile = () => (existsSync(testGlobal) ? testGlobal : null);
    } else {
      const dir = join(home, ".pi");
      cacheKey = `global\0${dir}`;
      resolveFile = () => findSettingsFile(dir, { scope: "global" });
    }
  }

  const cached = layerCache.get(cacheKey);
  if (cached && now - cached.checkedAt < SETTINGS_CACHE_TTL_MS) {
    layerCache.delete(cacheKey);
    layerCache.set(cacheKey, cached);
    return cached;
  }

  const file = resolveFile();
  let mtimeMs = 0;
  if (file) {
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
  }
  if (cached && cached.file === file && cached.mtimeMs === mtimeMs) {
    cached.checkedAt = now;
    return cached;
  }

  const parsed = file ? parseSettingsFile(file) : {};
  const entry: CachedLayer = { checkedAt: now, file, mtimeMs, parsed };
  if (layerCache.size >= SETTINGS_CACHE_MAX) {
    const oldest = layerCache.keys().next().value;
    if (oldest !== undefined) layerCache.delete(oldest);
  }
  layerCache.set(cacheKey, entry);
  return entry;
}

// ── Unified resolution & source detection ───────────────────────────

export interface ResolvedSetting<T = AnySettingValue> {
  value: T;
  source: SettingSource;
  path?: string | null;
}

/**
 * Resolve a setting value and its winning source (`P` | `G` | `E` | `D`) through the
 * single coordinated cache and schema validator. Returns `null` for unknown keys.
 *
 * Pass `{ audit: true }` only from low-frequency bootstrap callers (e.g. `file-logger.ts`,
 * cached 30s per logger) so hot `getSetting` calls never append to the bypass logger.
 */
export function resolveSetting(
  cwd: string,
  key: string,
  options?: { audit?: boolean },
): ResolvedSetting | null {
  const def = SETTINGS_KEYS[key];
  if (!def) return null;
  const audit = options?.audit === true;

  const projectLayer = readCachedLayer("project", cwd);
  const projectVal = (projectLayer.parsed as Record<string, unknown>)[key];
  if (projectVal !== undefined) {
    if (audit) log.debug("resolved setting", { key, source: "project", path: projectLayer.file });
    return { value: projectVal as AnySettingValue, source: "P", path: projectLayer.file };
  }

  const globalLayer = readCachedLayer("global", cwd);
  const globalVal = (globalLayer.parsed as Record<string, unknown>)[key];
  if (globalVal !== undefined) {
    if (audit) log.debug("resolved setting", { key, source: "global", path: globalLayer.file });
    return { value: globalVal as AnySettingValue, source: "G", path: globalLayer.file };
  }

  const envVal = parseEnvSetting(key, def);
  if (envVal !== undefined) {
    if (audit) log.debug("resolved setting", { key, source: "environment" });
    return { value: envVal as AnySettingValue, source: "E" };
  }

  if (audit) log.debug("resolved setting", { key, source: "default" });
  const defaultVal =
    def.type === "string_list"
      ? (Array.isArray(def.default) ? [...(def.default as string[])] : [])
      : def.type === "agent_overrides"
        ? (typeof def.default === "object" && def.default !== null ? { ...(def.default as AgentOverrides) } : {})
        : (def.default as AnySettingValue);
  return { value: defaultVal, source: "D" };
}

/**
 * Get a typed setting value for any key defined in `settings-keys.json`.
 * Resolution: project file → global ~/.pi/pi-config-settings.json → env var → default.
 */
export function getSetting<K extends SettingKey>(cwd: string, key: K): SettingValue<K> {
  const resolved = resolveSetting(cwd, key);
  return (resolved ? resolved.value : false) as SettingValue<K>;
}

/**
 * Dynamic-key variant for callers that build setting keys at runtime (e.g.
 * `rules.ts` `{{SETTINGS:...}}`, `file-logger.ts`). Prefer typed `getSetting`
 * when the key is statically known.
 */
export function getSettingDynamic(cwd: string, key: string): AnySettingValue {
  const resolved = resolveSetting(cwd, key);
  return resolved ? resolved.value : false;
}

export interface SettingsSourceSnapshot {
  project: ProjectSettings | null;
  global: ProjectSettings | null;
}

/** Read project and global parsed settings once so per-key source detection avoids N×2 file reads. */
export function loadSettingsSourceSnapshot(cwd: string): SettingsSourceSnapshot {
  const projectPath = getSettingsPath(cwd);
  const globalPath = getGlobalSettingsPath();
  return {
    project: existsSync(projectPath) ? parseSettingsFile(projectPath) : null,
    global: existsSync(globalPath) ? parseSettingsFile(globalPath) : null,
  };
}

export function detectSource(
  key: string,
  def: SettingsKeyDef,
  cwd: string,
  snapshot?: SettingsSourceSnapshot,
): SettingSource {
  const project = snapshot
    ? snapshot.project
    : (existsSync(getSettingsPath(cwd)) ? parseSettingsFile(getSettingsPath(cwd)) : null);
  if (project && (project as Record<string, unknown>)[key] !== undefined) return "P";

  const global = snapshot
    ? snapshot.global
    : (existsSync(getGlobalSettingsPath()) ? parseSettingsFile(getGlobalSettingsPath()) : null);
  if (global && (global as Record<string, unknown>)[key] !== undefined) return "G";

  if (parseEnvSetting(key, def) !== undefined) return "E";
  return "D";
}

// ── Locked atomic persistence, backups & edit sessions ──────────────

/** Thrown instead of writing when the target file cannot be parsed. */
export class SettingsFileCorruptError extends Error {
  constructor(readonly filePath: string) {
    super(`refusing to overwrite unparseable settings file: ${filePath}`);
    this.name = "SettingsFileCorruptError";
    log.error("settings_write_refused_corrupt", { filePath });
  }
}

/** Thrown when the previous version could not be preserved, so nothing is written. */
export class SettingsBackupError extends Error {
  constructor(readonly filePath: string, readonly cause?: unknown) {
    super(`refusing to write settings without a backup: ${filePath}`);
    this.name = "SettingsBackupError";
  }
}

/** Path of the newest previous-version copy kept next to a settings file. */
export function settingsBackupPath(filePath: string, slot = 1): string {
  return `${filePath}.bak.${slot}`;
}

/** The cwd whose settings govern this file: project root for a project file, null for global. */
function settingCwdFor(filePath: string): string | null {
  const parent = dirname(filePath);
  if (basename(parent) === ".pi") {
    const root = dirname(parent);
    if (root === homedir()) return null;
    return root;
  }
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

/** Backup retention for this file: project setting where owned by a project, env/default for global. */
function backupCountFor(filePath: string): number {
  const def = SETTINGS_KEYS.settings_backup_count;
  const fallback = Number(def?.default ?? 5);
  const min = Number(def?.min ?? 0);
  const max = Number(def?.max ?? 20);
  const accept = (value: number): number | null =>
    Number.isInteger(value) && value >= min && value <= max ? value : null;

  const raw = process.env.PI_SETTINGS_BACKUP_COUNT;
  const envCount = raw !== undefined && raw.trim() !== "" ? accept(Number(raw)) : null;
  if (raw !== undefined && raw.trim() !== "" && envCount === null) {
    log.warn("settings_backup_count_invalid", { raw, min, max, fallback });
  }

  const cwd = settingCwdFor(filePath);
  if (cwd !== null) {
    const resolved = accept(Number(getSetting(cwd, "settings_backup_count")));
    if (resolved !== null) return resolved;
  }
  return envCount ?? fallback;
}

/** Drop slots beyond the configured count, so lowering retention removes old copies. */
function pruneExtraBackups(filePath: string, count: number): void {
  const prefix = `${basename(filePath)}.bak.`;
  let entries: string[] = [];
  try {
    entries = readdirSync(dirname(filePath));
  } catch (e: unknown) {
    log.warn("settings_backup_prune_scan_failed", { filePath, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const slot = Number(name.slice(prefix.length));
    if (!Number.isFinite(slot) || slot <= count) continue;
    try {
      unlinkSync(join(dirname(filePath), name));
    } catch (e: unknown) {
      log.warn("settings_backup_prune_failed", { filePath, slot: name, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

let editSessionDepth = 0;
const backedUpInSession = new Set<string>();
const createdInSession = new Set<string>();
const visitSnapshots = new Set<string>();

function visitSnapshotPath(filePath: string): string {
  return `${filePath}.bak.visit-${process.pid}`;
}

/** Reusable 4-byte buffer for synchronous lock backoff. */
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/** Serialize chain mutations across processes with an O_EXCL pid lockfile. */
function withChainLock<T>(filePath: string, fn: () => T): T {
  const lockPath = `${filePath}.bak.lock`;
  let locked = false;
  try {
    for (let attempt = 0; attempt < 100 && !locked; attempt++) {
      try {
        writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
        locked = true;
      } catch {
        let stale = false;
        try {
          const ownerPid = Number(readFileSync(lockPath, "utf-8").trim());
          if (Number.isInteger(ownerPid) && ownerPid > 0) {
            try {
              process.kill(ownerPid, 0);
            } catch {
              stale = true;
            }
          } else {
            stale = Date.now() - statSync(lockPath).mtimeMs > 200;
          }
        } catch {
          // Vanished between failed create and read — retry immediately
        }
        if (stale) {
          const grave = `${lockPath}.stale-${process.pid}-${Date.now()}`;
          try {
            renameSync(lockPath, grave);
            unlinkSync(grave);
          } catch {
            /* another writer claimed it */
          }
        }
        Atomics.wait(sleepBuf, 0, 0, 20);
      }
    }
    if (!locked) {
      log.error("settings_backup_lock_timeout", { filePath });
      throw new SettingsBackupError(filePath, new Error("backup lock timeout"));
    }
    return fn();
  } finally {
    if (locked) {
      try {
        if (readFileSync(lockPath, "utf-8").trim() === String(process.pid)) unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
}

function shiftBackupSlots(filePath: string, count: number): void {
  const oldest = settingsBackupPath(filePath, count);
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let slot = count - 1; slot >= 1; slot--) {
    const from = settingsBackupPath(filePath, slot);
    if (existsSync(from)) renameSync(from, settingsBackupPath(filePath, slot + 1));
  }
}

function promoteSnapshotLocked(snapshotPath: string, filePath: string): void {
  const count = backupCountFor(filePath);
  if (count <= 0) {
    unlinkSync(snapshotPath);
    return;
  }
  shiftBackupSlots(filePath, count);
  renameSync(snapshotPath, settingsBackupPath(filePath, 1));
}

function promoteSnapshot(snapshotPath: string): void {
  const filePath = snapshotPath.replace(/\.bak\.visit-\d+$/, "");
  if (!existsSync(snapshotPath)) return;
  withChainLock(filePath, () => promoteSnapshotLocked(snapshotPath, filePath));
}

function reapStaleVisitSnapshots(filePath: string): void {
  const dir = dirname(filePath);
  const marker = `${basename(filePath)}.bak.visit-`;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(marker)) continue;
    const pid = Number(name.slice(marker.length));
    if (!Number.isInteger(pid)) continue;
    if (pid === process.pid && visitSnapshots.has(join(dir, name))) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch {
      /* dead owner — promote snapshot */
    }
    try {
      promoteSnapshot(join(dir, name));
      log.info("settings_visit_snapshot_recovered", { filePath, pid });
    } catch (e: unknown) {
      log.warn("settings_visit_snapshot_recover_failed", {
        filePath,
        pid,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

function promoteVisitSnapshots(): void {
  const failed = new Set<string>();
  for (const snapshot of [...visitSnapshots]) {
    try {
      promoteSnapshot(snapshot);
    } catch (e: unknown) {
      failed.add(snapshot);
      log.warn("settings_visit_snapshot_promote_failed", {
        snapshot,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  visitSnapshots.clear();
  for (const snapshot of failed) visitSnapshots.add(snapshot);
}

export function beginSettingsEditSession(): void {
  editSessionDepth++;
}

export function endSettingsEditSession(): void {
  editSessionDepth = Math.max(0, editSessionDepth - 1);
  if (editSessionDepth === 0) {
    promoteVisitSnapshots();
    backedUpInSession.clear();
    createdInSession.clear();
  }
}

function shouldBackUp(filePath: string, dedupe: boolean): boolean {
  if (!dedupe || editSessionDepth === 0) return true;
  if (createdInSession.has(filePath)) return false;
  return !backedUpInSession.has(filePath);
}

function rotateSettingsBackups(filePath: string, count: number): void {
  if (count <= 0) return;
  withChainLock(filePath, () => {
    try {
      shiftBackupSlots(filePath, count);
      copyFileSync(filePath, settingsBackupPath(filePath, 1));
    } catch (e: unknown) {
      log.error("settings_backup_failed", { filePath, error: e instanceof Error ? e.message : String(e) });
      throw new SettingsBackupError(filePath, e);
    }
  });
}

/**
 * Atomically write a settings object to `filePath` with sandbox guard, corrupt-file
 * refusal, locked backup rotation / visit snapshots, and automatic cache invalidation.
 */
export function writeSettingsFile(
  filePath: string,
  data: Record<string, unknown>,
  options: { dedupeBackup?: boolean } = {},
): void {
  const dir = dirname(filePath);

  if (process.env.NODE_TEST_CONTEXT !== undefined && !isInsideTempTree(filePath)) {
    const real = nearestRealPath(filePath);
    throw new Error(`test process refused to write settings outside the temp tree: ${real}`);
  }

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (SETTINGS_FILENAMES.includes(basename(filePath)) && legacyMigrationBlocked(dir)) {
    throw new SettingsFileCorruptError(join(dir, LEGACY_SETTINGS_FILENAME));
  }

  const existedBefore = existsSync(filePath);
  if (!existedBefore && options.dedupeBackup === true && editSessionDepth > 0) {
    createdInSession.add(filePath);
  }

  if (existedBefore) {
    if (readSettingsFile(filePath) === null) throw new SettingsFileCorruptError(filePath);
    const count = backupCountFor(filePath);
    pruneExtraBackups(filePath, count);
    if (options.dedupeBackup === true && editSessionDepth > 0) {
      if (shouldBackUp(filePath, true) && count > 0) {
        try {
          reapStaleVisitSnapshots(filePath);
          copyFileSync(filePath, visitSnapshotPath(filePath));
          backedUpInSession.add(filePath);
          visitSnapshots.add(visitSnapshotPath(filePath));
        } catch (e: unknown) {
          log.error("settings_backup_failed", { filePath, error: e instanceof Error ? e.message : String(e) });
          throw new SettingsBackupError(filePath, e);
        }
      }
    } else {
      rotateSettingsBackups(filePath, count);
    }
  }

  const content = JSON.stringify(data, null, 2) + "\n";
  const tmpPath = `${filePath}.${process.pid}.${Date.now().toString(36)}`;
  try {
    writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw e;
  }

  // Always invalidate the unified cache after a successful write.
  clearSettingsCache();
}

export type UpdateSettingResult =
  | { ok: true; file: string; changed?: boolean }
  | { ok: false; reason: "invalid" | "corrupt" | "write_error"; file: string; error: string; cause?: unknown };

/**
 * Validate and persist one setting in `scope`. Passing `undefined` or `null` deletes
 * the key from that scope's file. Preserves unknown keys, rotates backups, and
 * invalidates the unified cache.
 */
export function updateSetting(
  cwd: string,
  scope: SettingsScope,
  key: string,
  value: unknown,
  options: { dedupeBackup?: boolean } = {},
): UpdateSettingResult {
  const filePath = getFilePathForScope(scope, cwd);
  const clearing = value === undefined || value === null;

  let validatedValue: unknown;
  if (clearing) {
    if (!(key in SETTINGS_KEYS)) {
      return { ok: false, reason: "invalid", file: filePath, error: `unknown setting key: ${key}` };
    }
  } else {
    const validated = validateSetting(key, value);
    if (!validated.ok) {
      return { ok: false, reason: "invalid", file: filePath, error: validated.error };
    }
    validatedValue = validated.value;
  }

  const current = readSettingsFile(filePath);
  if (current === null) {
    return {
      ok: false,
      reason: "corrupt",
      file: filePath,
      error: `${filePath} is malformed (invalid JSON or not an object) — fix it before saving`,
    };
  }

  if (clearing) {
    if (!(key in current)) return { ok: true, file: filePath, changed: false };
    delete current[key];
    if (Object.keys(current).length === 0 && !existsSync(filePath)) return { ok: true, file: filePath, changed: false };
  } else {
    current[key] = validatedValue;
  }

  try {
    writeSettingsFile(filePath, current, options);
    return { ok: true, file: filePath, changed: true };
  } catch (error) {
    if (error instanceof SettingsFileCorruptError) {
      return { ok: false, reason: "corrupt", file: filePath, error: error.message, cause: error };
    }
    return {
      ok: false,
      reason: "write_error",
      file: filePath,
      error: error instanceof Error ? error.message : String(error),
      cause: error,
    };
  }
}

// ── Pi extension hook ───────────────────────────────────────────────

/**
 * Register project settings — clears cache and syncs env vars for standalone
 * packages on `session_start`.
 */
export function registerProjectSettings(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.on("session_start", (_event, ctx) => {
    clearSettingsCache();

    const cwd = ctx.cwd;
    const vertexClaude1m = getSetting(cwd, "vertex_claude_1m");
    if (vertexClaude1m) process.env.VERTEX_CLAUDE_1M = "true";
    else delete process.env.VERTEX_CLAUDE_1M;

    const sidecarLogLevel = getSetting(cwd, "sidecar_log_level");
    if (sidecarLogLevel) process.env.PI_SIDECAR_LOG_LEVEL = sidecarLogLevel;
    else delete process.env.PI_SIDECAR_LOG_LEVEL;

    const imageModel = getSetting(cwd, "image_model");
    if (imageModel) process.env.PI_IMAGE_MODEL = imageModel;
    else delete process.env.PI_IMAGE_MODEL;
  });
}
