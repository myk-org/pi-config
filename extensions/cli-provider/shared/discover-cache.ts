/**
 * Shared helpers for CLI model discovery (cache + binary resolve).
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { DiscoveredCliModel } from "../types.js";

export function modelIdToDisplayName(modelId: string): string {
  const bracketIdx = modelId.indexOf("[");
  const baseName = bracketIdx >= 0 ? modelId.substring(0, bracketIdx) : modelId;
  return baseName
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Cache keyed by `${binary}\0${PATH}` — successful resolves only (no negative cache). */
const resolveBinaryCache = new Map<string, string>();

/** Parse PATHEXT into uppercase extensions (e.g. ".EXE"). Exported for tests. */
export function parsePathext(pathextEnv?: string): string[] {
  const raw = pathextEnv ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith(".") ? s : `.${s}`).toUpperCase());
}

/**
 * True when filePath has an extension listed in PATHEXT (case-insensitive).
 * Extensionless files are not CreateProcess-launchable on Windows.
 */
export function isLaunchableWin32(
  filePath: string,
  pathextEnv?: string,
): boolean {
  const ext = extname(filePath);
  if (!ext) return false;
  return parsePathext(pathextEnv).includes(ext.toUpperCase());
}

/**
 * Suffixes to try when scanning PATH for `binary`.
 * On win32: if `binary` already has a PATHEXT extension, try as-is only;
 * otherwise try each PATHEXT suffix (no bare/empty suffix).
 */
export function candidateSuffixesFor(
  binary: string,
  platform: NodeJS.Platform = process.platform,
  pathextEnv?: string,
): string[] {
  if (platform !== "win32") return [""];
  const ext = extname(binary);
  if (ext && parsePathext(pathextEnv).includes(ext.toUpperCase())) {
    return [""];
  }
  return parsePathext(pathextEnv);
}

function isExecutable(filePath: string): boolean {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return false;
  }
  // Directories are often X_OK (searchable); only regular files are binaries.
  if (!st.isFile()) return false;
  if (process.platform === "win32") return isLaunchableWin32(filePath);
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function finalizeResolved(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Resolve a binary name (or absolute path) via an in-process PATH scan.
 * Avoids spawnSync("which") on auth/filter hot paths.
 * Returns realpath when possible, null if missing.
 */
export function resolveBinary(binary: string): string | null {
  if (!binary) return null;

  const pathEnv = process.env.PATH ?? "";
  const cacheKey = `${binary}\0${pathEnv}`;
  const cached = resolveBinaryCache.get(cacheKey);
  if (cached !== undefined) {
    if (isExecutable(cached)) return cached;
    resolveBinaryCache.delete(cacheKey);
  }

  // Absolute or explicit relative path — check directly (mirrors `which /path`).
  if (isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) {
    if (!isExecutable(binary)) return null;
    const resolved = finalizeResolved(binary);
    resolveBinaryCache.set(cacheKey, resolved);
    return resolved;
  }

  const suffixes = candidateSuffixesFor(binary);
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, binary + suffix);
      if (!isExecutable(candidate)) continue;
      const resolved = finalizeResolved(candidate);
      resolveBinaryCache.set(cacheKey, resolved);
      return resolved;
    }
  }

  // Do not cache misses — mid-session install with same PATH must rediscover.
  return null;
}

/** Clear PATH resolve cache (tests / PATH mutation). */
export function clearResolveBinaryCache(): void {
  resolveBinaryCache.clear();
}

function cacheDir(): string {
  return join(homedir(), ".pi", "cli-model-cache");
}

export function readModelCache(key: string): DiscoveredCliModel[] | null {
  const path = join(cacheDir(), `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(data?.models)) return null;
    return data.models.filter(
      (m: any) => typeof m?.id === "string" && typeof m?.name === "string",
    );
  } catch {
    return null;
  }
}

export function writeModelCache(key: string, models: DiscoveredCliModel[]): void {
  try {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(cacheDir(), `${key}.json`),
      JSON.stringify({ updatedAt: new Date().toISOString(), models }, null, 0),
      { mode: 0o600 },
    );
  } catch {
    /* ignore */
  }
}

export function cacheKeyForFile(agent: string, filePath: string): string {
  const st = statSync(filePath);
  const raw = `${agent}\0${filePath}\0${st.size}\0${st.mtimeMs}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}
