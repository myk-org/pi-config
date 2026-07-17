/**
 * Provenance pending merge — dream writes a sidecar JSON; onComplete merges
 * into memory-scores.json without asking the LLM to edit scores JSON.
 *
 * Sidecar: `.pi/memory/provenance-pending.json`
 * Shape: { entries: [{ category, text, sourceSession?, derivedFrom?, informs? }] }
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { entryHash, loadScores, saveScores, type MemoryCategory } from "./memory-scoring.js";

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

export function getProvenancePendingPath(cwd: string): string {
  return join(cwd, ".pi", "memory", "provenance-pending.json");
}

export function writeProvenancePending(
  cwd: string,
  entries: ProvenancePendingItem[],
): void {
  const path = getProvenancePendingPath(cwd);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload: ProvenancePendingFile = { entries };
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

/**
 * Merge provenance-pending.json into scores, then delete the sidecar.
 * Returns number of entries updated.
 */
export function mergeProvenancePending(cwd: string): number {
  const path = getProvenancePendingPath(cwd);
  if (!existsSync(path)) return 0;

  let pending: ProvenancePendingFile;
  try {
    pending = JSON.parse(readFileSync(path, "utf-8")) as ProvenancePendingFile;
  } catch (e: any) {
    console.debug("[memory-provenance] parse failed:", e?.message || e);
    return 0;
  }

  if (!pending?.entries?.length) {
    try { unlinkSync(path); } catch { /* ignore */ }
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

  try { unlinkSync(path); } catch { /* ignore */ }
  return updated;
}
