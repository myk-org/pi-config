/**
 * Claude Code CLI agent — flags + binary-catalog discovery.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createLogger } from "../../shared/logger.js";
const log = createLogger("cli_provider");
import type { CliProviderDef, DiscoveredCliModel } from "../types.js";
import {
  cacheKeyForFile,
  readModelCache,
  resolveBinary,
  writeModelCache,
} from "../shared/discover-cache.js";

/** Catalog entries embedded in the Claude Code binary (minified JS/strings). */
const CATALOG_RE =
  /\{id:"(claude-[^"]+)",family:"([^"]+)",display_name:"([^"]+)"/g;

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
/** Enough overlap that a catalog match cannot split across chunks. */
const DEFAULT_OVERLAP = 512;

/** Parse selectable catalog from a string (tests / small fixtures). */
export function parseClaudeBinaryCatalog(
  binaryContents: string,
): DiscoveredCliModel[] {
  const models: DiscoveredCliModel[] = [];
  const seen = new Set<string>();
  CATALOG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CATALOG_RE.exec(binaryContents))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: m[3] });
  }
  return models;
}

/**
 * Scan a Claude binary for the embedded model catalog without loading the
 * whole file into a JS string (binaries are ~250MB+ ELF).
 */
export function scanClaudeBinaryCatalog(
  filePath: string,
  opts?: { chunkSize?: number; overlap?: number },
): DiscoveredCliModel[] {
  const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = Math.min(opts?.overlap ?? DEFAULT_OVERLAP, chunkSize - 1);
  const size = statSync(filePath).size;
  const fd = openSync(filePath, "r");
  const readBuf = Buffer.alloc(chunkSize);
  let prev = Buffer.alloc(0);
  const models: DiscoveredCliModel[] = [];
  const seen = new Set<string>();
  let offset = 0;

  try {
    while (offset < size) {
      const n = readSync(fd, readBuf, 0, chunkSize, offset);
      if (n <= 0) break;

      const chunk = Buffer.concat([prev, readBuf.subarray(0, n)]);
      // latin1 = 1:1 byte mapping; catalog ids are ASCII
      const text = chunk.toString("latin1");
      CATALOG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CATALOG_RE.exec(text))) {
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({ id, name: m[3] });
      }

      prev =
        overlap > 0
          ? chunk.subarray(Math.max(0, chunk.length - overlap))
          : Buffer.alloc(0);
      offset += n;
    }
  } finally {
    closeSync(fd);
  }

  return models;
}

function discoverClaudeModels(): DiscoveredCliModel[] {
  const binary = resolveBinary("claude");
  if (!binary) return [];
  try {
    const key = cacheKeyForFile("claude", binary);
    const cached = readModelCache(key);
    if (cached && cached.length > 0) return cached;

    const models = scanClaudeBinaryCatalog(binary);
    if (models.length > 0) writeModelCache(key, models);
    return models;
  } catch (err) {
    log.error("claude: binary catalog failed", err);
    return [];
  }
}

export const claudeProvider: CliProviderDef = {
  name: "claude",
  binary: "claude",
  buildBaseArgs: (model) => {
    // -p skips workspace trust; stream-json requires --verbose
    const args = [
      "-p",
      "--verbose",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
    ];
    if (model && model !== "default") {
      args.unshift("--model", model);
    }
    return args;
  },
  resumeFlag: "--resume",
  continueFlags: ["--continue"],
  outputFormat: "stream-json",
  promptOnStdin: true,
  discoverModels: discoverClaudeModels,
};
