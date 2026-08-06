/**
 * Provenance pending merge — dream writes a sidecar JSONL; onComplete merges
 * into memory-scores.jsonl without asking the LLM to edit scores JSONL.
 *
 * Sidecar: `.pi/memory/provenance-pending.jsonl`
 * Shape per line: { category, text, sourceSession?, derivedFrom?, informs? }
 *
 * Persistence: JsonlStateStore (issue #724). Legacy JSON auto-migrated.
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { entryHash, loadScores, saveScores, type MemoryCategory } from "./memory-scoring.js";
import { createCachedStore } from "./state-jsonl.js";
import type { JsonlStateStore } from "./state-jsonl.js";

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

function getProvenanceStore(cwd: string): JsonlStateStore<ProvenancePendingFile> {
  return createCachedStore<ProvenancePendingFile>(
    join(cwd, ".pi", "memory"), PROVENANCE_FILENAME_JSONL, LEGACY_PROVENANCE_FILENAME,
  );
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

  // Delete the consumed sidecar
  try { unlinkSync(getProvenancePendingPath(cwd)); } catch { /* ignore */ }
  return updated;
}
