import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

export const SETTINGS_FILENAMES = ["pi-config-settings.jsonc", "pi-config-settings.json"];

export const SETTINGS_KEYS: Record<string, SettingsKeyDef> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "settings-keys.json"), "utf8"),
);

export function findSettingsFile(dir: string): string | null {
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
