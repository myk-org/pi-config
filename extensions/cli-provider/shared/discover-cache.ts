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
import { delimiter, isAbsolute, join } from "node:path";
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

function winPathSuffixes(): string[] {
  const pathext = process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM";
  return ["", ...pathext.split(";").filter(Boolean)];
}

function candidateSuffixes(): string[] {
  return process.platform === "win32" ? winPathSuffixes() : [""];
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
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

  const suffixes = candidateSuffixes();
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
