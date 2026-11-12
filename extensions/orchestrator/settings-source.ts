import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import stripJsonComments from "strip-json-comments";

let log: { debug(message: string, context?: object): void; warn(message: string, context?: object): void } = {
  debug: () => {}, warn: () => {},
};
export function setSettingsSourceLogger(logger: typeof log): void {
  log = logger;
}

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
}

/** The only settings filename — one name, one precedence, project and global alike. */
export const SETTINGS_FILENAMES = ["pi-config-settings.json"];

/** Legacy settings file, no longer read: migrated away once, then ignored (issue #1086). */
export const LEGACY_SETTINGS_FILENAME = "pi-config-settings.jsonc";

/** Suffix the legacy file is moved to — it can never shadow the `.json` again. */
const LEGACY_MIGRATED_SUFFIX = ".migrated";

/** One warning per directory and reason: settings resolution runs on nearly every tool call, so a
 *  file that stays ignored/refused/corrupt must not re-log on each read. Path only, never values. */
const legacyWarned = new Set<string>();
function warnLegacyOnce(reason: string, message: string, file: string): void {
  const key = `${reason}\0${dirname(file)}`;
  if (legacyWarned.has(key)) return;
  legacyWarned.add(key);
  log.warn(message, { path: file });
}

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

export const SETTINGS_KEYS: Record<string, SettingsKeyDef> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "settings-keys.json"), "utf8"),
);

/** Test processes may only migrate inside the OS temp tree: a test that merely resolves
 *  settings must never rewrite the user's real `~/.pi` — the same safety net `writeSettingsFile`
 *  has. Production runs are unaffected. */
function migrationAllowed(dir: string): boolean {
  if (process.env.NODE_TEST_CONTEXT === undefined) return true;
  // Compare REAL paths: a lexical check passes for a fixture whose `.pi` links into a real project.
  // `nearestRealPath` on both sides, so a missing or bogus tmpdir cannot make resolution throw.
  const base = nearestRealPath(tmpdir());
  const target = nearestRealPath(dir);
  return target === base || target.startsWith(base + sep);
}

/** Whether git tracks the legacy file, in the repo that owns it. `"unknown"` (git failed for an
 *  unrelated reason) counts as tracked: a migration that MIGHT launder a clone's settings must not
 *  happen. Exit 1 means "not in the index" — the normal, migratable case. */
function legacyTracked(dir: string, legacy: string): boolean {
  try {
    const out = execFileSync("git", ["ls-files", "--error-unmatch", "--", legacy], {
      cwd: dir, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out !== "";
  } catch (error) {
    const { status, stderr } = error as { status?: number; stderr?: string };
    if (status === 1) return false;
    // No repo here: nothing could have been cloned in.
    if (status === 128 && /not a git repository/i.test(String(stderr ?? ""))) return false;
    log.warn("settings_legacy_jsonc_git_check_failed", { path: legacy, fallback: "not migrated" });
    return true;
  }
}

/** Directories whose tracked legacy file was already refused in THIS process: settings resolution
 *  runs on nearly every tool call, so the git check must run once per directory, not per read. A
 *  stale entry can only keep NOT migrating (the safe side); untracking the file is picked up by a
 *  fresh process, which runs the check again. */
const legacyTrackedRefused = new Set<string>();
function legacyTrackedRefusal(dir: string, legacy: string): boolean {
  if (legacyTrackedRefused.has(dirname(legacy))) return true;
  if (!legacyTracked(dir, legacy)) return false;
  legacyTrackedRefused.add(dirname(legacy));
  return true;
}

/** The settings object at `file`, or `null` when it is missing or not a JSON object. */
function readSettingsObjectOrNull(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Publishing is the step that can be DENIED (Windows EPERM), and a denied publish must not strand
 *  the legacy file — so it is a seam, like `setRepoRootResolverForTests`. */
let publishSettingsFile: (from: string, to: string) => void = renameSync;

export function setPublishSettingsFileForTests(publish: ((from: string, to: string) => void) | null): void {
  publishSettingsFile = publish ?? renameSync;
}

/** A legacy file that exists while its `.json` does not, and cannot be parsed. Writing `.json` now
 *  would make the legacy file "ignored", so a file a human repairs afterwards could never be
 *  migrated — settings writes to this directory are refused until the legacy file is fixed. */
export function legacyMigrationBlocked(dir: string): boolean {
  const legacy = join(dir, LEGACY_SETTINGS_FILENAME);
  if (!existsSync(legacy) || existsSync(join(dir, SETTINGS_FILENAMES[0]))) return false;
  // Vanished between the two checks: nothing left to protect.
  return readLegacySettings(legacy) === null && existsSync(legacy);
}

/** Reads and parses the legacy file; `null` means "nothing to migrate".
 *  Exported so the read-after-vanish window (a racing process renamed the file away between
 *  the existence check and this read) is testable — the ENOENT branch is unreachable on disk. */
export function readLegacySettings(file: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
  } catch (error) {
    // A racer got there first: the file is already migrated, so this is not corruption.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    data = null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    // Same contract as the corrupt-file refusal on write: a file a human can still repair by
    // hand is never replaced by generated content. Path only — values never reach the log.
    warnLegacyOnce("corrupt", "settings_legacy_jsonc_corrupt", file);
    return null;
  }
  return data as Record<string, unknown>;
}

/**
 * ONE-TIME migration away from the legacy `.jsonc` file (issue #1086). The legacy file used
 * to win over `.json`, silently hiding settings written to `.json` — including
 * `dangerous_command_allowlist` entries added by an approval, which made the gate re-prompt.
 *
 * - `.json` exists        → migrate nothing; the legacy file is ignored (logged once per dir).
 * - `.json` missing       → write its parsed content to `.json` (temp file, then atomic rename),
 *                           then move the legacy file to `*.jsonc.migrated`.
 * - legacy unparseable    → refuse: nothing written, nothing renamed, nothing read from it.
 * - legacy tracked        → refuse, PROJECT scope only: laundering a clone's tracked file into a new
 *                           untracked `.json` would hand it the trust `projectSettingsTrust` withholds.
 * - legacy a symlink      → refuse: reading through it would copy a file from elsewhere into the
 *                           settings dir as a real file.
 *
 * Race-safe: the `.json` is published by rename, so a concurrent reader never sees a partial
 * file; a target that already exists (another process won) is kept, and a legacy file already
 * gone counts as migrated.
 */
export function migrateLegacySettingsFile(dir: string, options: FindSettingsOptions = {}): void {
  if (!migrationAllowed(dir)) return;
  const scope = options.scope ?? "project";
  const legacy = join(dir, LEGACY_SETTINGS_FILENAME);
  let legacyStat;
  try { legacyStat = lstatSync(legacy); } catch { return; }
  if (legacyStat.isSymbolicLink()) {
    warnLegacyOnce("symlink", "settings_legacy_jsonc_symlink_refused", legacy);
    return;
  }
  const target = join(dir, SETTINGS_FILENAMES[0]);
  if (existsSync(target)) {
    warnLegacyOnce("ignored", "settings_legacy_jsonc_ignored", legacy);
    return;
  }

  // Parse BEFORE the git check: a corrupt legacy file never migrates, so it must not cost a git
  // exec on every settings resolution.
  const data = readLegacySettings(legacy);
  if (data === null) return;
  // Project scope only: a repo can hand itself approvals by shipping a tracked settings file, so
  // its tracked legacy file must not be laundered into the untracked `.json`. The user's own home
  // directory cannot be attacked that way, and refusing there breaks a dotfiles-managed `~/.pi`
  // (this machine: `~/.pi` links into a repo that tracks `pi-config-settings.json`).
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
    // Publish by RENAME, not by creating the target first: the `.json` pathname appears with its
    // full content, so a concurrent reader never parses a partial file and falls back to defaults.
    // A target that already exists means another process published it — keep theirs, and the
    // legacy rename below is still ours to do (a racer that got there first reports ENOENT).
    if (!existsSync(target)) publishSettingsFile(tmp, target);
  } catch (error) {
    // Windows refuses to replace an existing target instead of returning EEXIST on rename, and a
    // denied rename is indistinguishable by code from one lost to a racer — so decide by the RESULT.
    publishError = error as NodeJS.ErrnoException;
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* temp file left behind */ }
  }

  // Nothing may be renamed unless a readable target exists: renaming the legacy file after a DENIED
  // publish would leave neither file readable, and the user's settings would simply be gone.
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
      // The content is safe in `.json` and the legacy name is no longer read, so this is
      // cosmetic — report it and move on rather than retry on every read.
      log.warn("settings_legacy_jsonc_rename_failed", { path: legacy });
      return;
    }
    // Already renamed by the process that won the race — success.
  }
  log.warn("settings_legacy_jsonc_migrated", { path: legacy });
}

export type SettingsScope = "project" | "global";

export interface FindSettingsOptions {
  /** Which settings root `dir` is. Defaults to `"project"`: every existing caller keeps its
   *  behaviour, and only the global-scope callers opt into the weaker refusals. */
  scope?: SettingsScope;
}

export function findSettingsFile(dir: string, options: FindSettingsOptions = {}): string | null {
  migrateLegacySettingsFile(dir, options);
  for (const name of SETTINGS_FILENAMES) {
    const file = join(dir, name);
    if (existsSync(file)) {
      log.debug("found settings file", { path: file });
      return file;
    }
  }
  log.debug("settings file not found", { path: dir });
  return null;
}

export function readSettingsObject(file: string | null, key?: string): Record<string, unknown> {
  if (!file) {
    log.debug("settings read skipped", { path: null, key });
    return {};
  }
  try {
    const value = JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
    log.debug("settings read", { path: file, key, validObject: Boolean(value && typeof value === "object" && !Array.isArray(value)) });
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    log.warn("settings read or parse failed", { path: file, key, error: error instanceof Error ? error.message : String(error) });
    return {};
  }
}

const repoRootCache = new Map<string, string>();
let repoRootResolver = resolveRepoRootUncached;

export function setRepoRootResolverForTests(resolver: (cwd: string) => string): void {
  repoRootResolver = resolver;
  repoRootCache.clear();
}

function resolveRepoRoot(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const cached = repoRootCache.get(resolvedCwd);
  if (cached) return cached;
  const root = repoRootResolver(resolvedCwd);
  repoRootCache.set(resolvedCwd, root);
  return root;
}

function resolveRepoRootUncached(cwd: string): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const root = dirname(resolve(cwd, common));
    log.debug("resolved standalone settings repository root", { cwd, root });
    return root;
  } catch (error) {
    let current = resolve(cwd);
    while (true) {
      const dotGit = join(current, ".git");
      if (existsSync(dotGit)) {
        if (statSync(dotGit).isDirectory()) return current;
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (match) {
          const gitDir = resolve(current, match[1].trim());
          const commonFile = join(gitDir, "commondir");
          if (existsSync(commonFile)) {
            const root = dirname(resolve(gitDir, readFileSync(commonFile, "utf8").trim()));
            log.debug("resolved standalone worktree repository root", { cwd, root });
            return root;
          }
        }
        return current;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    log.debug("standalone settings repository root fallback", { cwd, error: error instanceof Error ? error.message : String(error) });
    return cwd;
  }
}

function isValidCandidate(value: unknown, definition: SettingsKeyDef | undefined): boolean {
  if (!definition) return false;
  const typeValid = definition.type === "string" ? typeof value === "string"
    : definition.type === "bool" ? typeof value === "boolean"
    : definition.type === "int" ? Number.isInteger(value)
    : true;
  const valid = typeValid && (!definition.enum || definition.enum.includes(value as string));
  log.debug("validated standalone setting candidate", { type: definition.type, hasEnum: Boolean(definition.enum), valid });
  return valid;
}

export function getStandaloneSetting(cwd: string, key: string): unknown {
  const definition = SETTINGS_KEYS[key];
  const root = resolveRepoRoot(cwd);
  for (const [source, file] of [
    ["project", findSettingsFile(join(root, ".pi"))],
    ["global", findSettingsFile(join(process.env.HOME || homedir(), ".pi"), { scope: "global" })],
  ] as const) {
    const settings = readSettingsObject(file, key);
    if (key in settings && isValidCandidate(settings[key], definition)) {
      log.debug("resolved standalone setting", { key, source, path: file });
      return settings[key];
    }
  }
  const fromEnv = definition?.env && process.env[definition.env] !== undefined;
  log.debug("resolved standalone setting fallback", { key, source: fromEnv ? "environment" : "default" });
  return fromEnv ? process.env[definition!.env!] : definition?.default;
}
