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
import type { MemoryCategory } from "./memory-scoring.js";
import { applyEntryProvenance } from "./memory-store.js";
import { createCachedStore } from "./state-jsonl.js";
import type { JsonlStateStore } from "./state-jsonl.js";
import { getProjectMemoryDir } from "./utils.js";

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
    getProjectMemoryDir(cwd), PROVENANCE_FILENAME_JSONL, LEGACY_PROVENANCE_FILENAME,
  );
}

export function getProvenancePendingPath(cwd: string): string {
  return join(getProjectMemoryDir(cwd), PROVENANCE_FILENAME_JSONL);
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

  const updated = applyEntryProvenance(cwd, pending.entries);

  // Delete the consumed sidecar
  try { unlinkSync(getProvenancePendingPath(cwd)); } catch { /* ignore */ }
  return updated;
}
