/**
 * Shared helpers for CLI model discovery (cache + binary resolve).
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

export function resolveBinary(binary: string): string | null {
  const r = spawnSync("which", [binary], { encoding: "utf-8" });
  const path = r.stdout?.trim();
  if (r.status !== 0 || !path) return null;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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
