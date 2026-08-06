/**
 * Provenance pending merge — dream writes a sidecar JSONL; onComplete merges
 * into memory-scores.jsonl without asking the LLM to edit scores JSONL.
 *
 * Sidecar: `.pi/memory/provenance-pending.jsonl`
 * Shape per line: { category, text, sourceSession?, derivedFrom?, informs? }
 *
 * Persistence: JsonlStateStore (issue #724). Legacy JSON auto-migrated.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { entryHash, loadScores, saveScores, type MemoryCategory } from "./memory-scoring.js";
import { JsonlStateStore } from "./state-jsonl.js";

export interface ProvenancePendingItem {
  category: MemoryCategory | string;
  text: string;
  sourceSession?: string;
  derivedFrom?: string;
  informs?: string[];
}

export interface ProvenancePendingFile {
  entries: ProvenancePendingItem[];
}

const PROVENANCE_FILENAME_JSONL = "provenance-pending.jsonl";
const LEGACY_PROVENANCE_FILENAME = "provenance-pending.json";

/** Per-cwd provenance store cache. */
const provenanceStoreCache = new Map<string, JsonlStateStore<ProvenancePendingFile>>();

function getProvenanceStore(cwd: string): JsonlStateStore<ProvenancePendingFile> {
  const dir = join(cwd, ".pi", "memory");
  const cached = provenanceStoreCache.get(dir);
  if (cached) return cached;
  const store = new JsonlStateStore<ProvenancePendingFile>(join(dir, PROVENANCE_FILENAME_JSONL));
  provenanceStoreCache.set(dir, store);
  // One-time migration from legacy JSON
  if (!store.exists()) {
    const legacyPath = join(dir, LEGACY_PROVENANCE_FILENAME);
    if (existsSync(legacyPath)) {
      try {
        const raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as ProvenancePendingFile;
        store.write(raw);
        unlinkSync(legacyPath);
        console.debug("[memory-provenance] migrated legacy JSON to JSONL");
      } catch (e: any) {
        console.debug("[memory-provenance] legacy migration failed:", e?.message);
      }
    }
  }
  return store;
}

export function getProvenancePendingPath(cwd: string): string {
  return join(cwd, ".pi", "memory", PROVENANCE_FILENAME_JSONL);
}

export function writeProvenancePending(
  cwd: string,
  entries: ProvenancePendingItem[],
): void {
  const payload: ProvenancePendingFile = { entries };
  getProvenanceStore(cwd).write(payload);
}

/**
 * Merge provenance-pending.jsonl into scores, then delete the sidecar.
 * Returns number of entries updated.
 */
export function mergeProvenancePending(cwd: string): number {
  const store = getProvenanceStore(cwd);
  const pending = store.read();
  if (!pending?.entries?.length) {
    // Clean up empty/absent sidecar
    const p = getProvenancePendingPath(cwd);
    try { unlinkSync(p); } catch { /* ignore */ }
    return 0;
  }

  const scores = loadScores(cwd);
  let updated = 0;

  for (const item of pending.entries) {
    if (!item?.category || !item?.text) continue;
    const hash = entryHash(`- [${item.category}] ${item.text}`);
    const entry = scores.entries[hash];
    if (!entry) continue;

    if (item.sourceSession) entry.sourceSession = item.sourceSession;
    if (item.derivedFrom) entry.derivedFrom = item.derivedFrom;
    if (item.informs?.length) entry.informs = item.informs;
    updated += 1;
  }

  if (updated > 0) saveScores(cwd, scores);

  // Delete the consumed sidecar and clear cache
  try { unlinkSync(getProvenancePendingPath(cwd)); } catch { /* ignore */ }
  provenanceStoreCache.delete(join(cwd, ".pi", "memory"));
  return updated;
}
