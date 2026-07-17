/**
 * Gemini CLI agent — flags + installed-bundle discovery (isVisible models).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { CliProviderDef, DiscoveredCliModel } from "../types.js";
import {
  cacheKeyForFile,
  modelIdToDisplayName,
  readModelCache,
  resolveBinary,
  writeModelCache,
} from "../shared/discover-cache.js";

/**
 * Parse user-facing models from gemini-cli bundle source.
 * Matches entries like: "gemini-2.5-pro": { ... isVisible: true ... }
 */
export function parseGeminiCliVisibleModels(bundleText: string): DiscoveredCliModel[] {
  const re =
    /"((?:gemini|gemma|auto)[^"]+)"\s*:\s*\{[^}]{0,500}?isVisible:\s*true/g;
  const models: DiscoveredCliModel[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(bundleText))) {
    const id = m[1];
    if (id.endsWith("-base") || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: modelIdToDisplayName(id) });
  }
  return models;
}

function discoverGeminiModels(): DiscoveredCliModel[] {
  const binary = resolveBinary("gemini");
  if (!binary) return [];

  try {
    const key = cacheKeyForFile("gemini", binary);
    const cached = readModelCache(key);
    if (cached && cached.length > 0) return cached;

    const bundleDir = dirname(binary);
    const candidates = readdirSync(bundleDir)
      .filter((f) => f.endsWith(".js") && (f.startsWith("chunk-") || f === "gemini.js"))
      .map((f) => join(bundleDir, f))
      .filter((p) => existsSync(p))
      .map((p) => ({ path: p, size: statSync(p).size }))
      .filter((f) => f.size > 0 && f.size <= 80 * 1024 * 1024)
      .sort((a, b) => b.size - a.size);

    const models: DiscoveredCliModel[] = [];
    const seen = new Set<string>();
    for (const { path } of candidates) {
      const text = readFileSync(path, "utf-8");
      for (const m of parseGeminiCliVisibleModels(text)) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        models.push(m);
      }
      if (models.length > 0) break;
    }

    if (models.length > 0) writeModelCache(key, models);
    return models;
  } catch (err) {
    console.debug(`[cli-provider] gemini: CLI bundle parse failed:`, err);
    return [];
  }
}

export const geminiProvider: CliProviderDef = {
  name: "gemini",
  binary: "gemini",
  buildBaseArgs: (model) => {
    // --skip-trust: workspace; --yolo: auto-approve all tool actions
    const args = [
      "--skip-trust",
      "--yolo",
      "--output-format",
      "stream-json",
    ];
    if (model && model !== "default") {
      args.unshift("--model", model);
    }
    return args;
  },
  resumeFlag: "--resume",
  continueFlags: ["--resume"],
  outputFormat: "stream-json",
  promptOnStdin: true,
  discoverModels: discoverGeminiModels,
};
