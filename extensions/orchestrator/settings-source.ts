import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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

const legacyIgnoredLogged = new Set<string>();

export const SETTINGS_KEYS: Record<string, SettingsKeyDef> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "settings-keys.json"), "utf8"),
);

/** Test processes may only migrate inside the OS temp tree: a test that merely resolves
 *  settings must never rewrite the user's real `~/.pi` — the same safety net `writeSettingsFile`
 *  has. Production runs are unaffected. */
function migrationAllowed(dir: string): boolean {
  if (process.env.NODE_TEST_CONTEXT === undefined) return true;
  const base = resolve(tmpdir());
  const target = resolve(dir);
  return target === base || target.startsWith(base + sep);
}

/**
 * ONE-TIME migration away from the legacy `.jsonc` file (issue #1086). The legacy file used
 * to win over `.json`, silently hiding settings written to `.json` — including
 * `dangerous_command_allowlist` entries added by an approval, which made the gate re-prompt.
 *
 * - `.json` exists        → migrate nothing; the legacy file is ignored (logged once per dir).
 * - `.json` missing       → write its parsed content to `.json` (atomic create, temp + rename),
 *                           then move the legacy file to `*.jsonc.migrated`.
 * - legacy unparseable    → refuse: nothing written, nothing renamed, nothing read from it.
 *
 * Race-safe: the `.json` create is exclusive (`COPYFILE_EXCL`), so a process that lost the
 * race keeps the winner's file, and a legacy file already gone counts as migrated.
 */
export function migrateLegacySettingsFile(dir: string): void {
  if (!migrationAllowed(dir)) return;
  const legacy = join(dir, LEGACY_SETTINGS_FILENAME);
  if (!existsSync(legacy)) return;
  const target = join(dir, SETTINGS_FILENAMES[0]);
  if (existsSync(target)) {
    if (!legacyIgnoredLogged.has(dir)) {
      legacyIgnoredLogged.add(dir);
      log.warn("settings_legacy_jsonc_ignored", { path: legacy });
    }
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(stripJsonComments(readFileSync(legacy, "utf8")));
  } catch {
    data = null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    // Same contract as the corrupt-file refusal on write: a file a human can still repair by
    // hand is never replaced by generated content. Path only — values never reach the log.
    log.warn("settings_legacy_jsonc_corrupt", { path: legacy });
    return;
  }

  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    log.warn("settings_legacy_jsonc_migrate_failed", { path: legacy });
    return;
  }
  try {
    copyFileSync(tmp, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      log.warn("settings_legacy_jsonc_migrate_failed", { path: legacy });
      return;
    }
    // Lost the race: the other process created `.json` and owns the migration. Renaming the
    // legacy file away is still ours to do — a racer that got there first reports ENOENT.
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* temp file left behind */ }
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

export function findSettingsFile(dir: string): string | null {
  migrateLegacySettingsFile(dir);
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
    ["global", findSettingsFile(join(process.env.HOME || homedir(), ".pi"))],
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
