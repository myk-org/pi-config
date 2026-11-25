/**
 * Provenance pending merge — stores pending provenance in `.pi/data/state.db`
 * (`kv_state` key `"memory-provenance"`, issue #1399) and also ingests any
 * dream-written sidecar file (`.pi/memory/provenance-pending.jsonl` or legacy
 * `.json`) so background LLM dream agents never have to touch `state.db` directly.
 *
 * Sidecar shape per line: { entries: [{ category, text, sourceSession?, derivedFrom?, informs? }] }
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../shared/logger.js";
import type { MemoryCategory } from "./memory-scoring.js";
import { applyEntryProvenance } from "./memory-store.js";
import {
  createSqliteStateStore,
  getProjectStateDbPath,
  parseLastValidLine,
  type SqliteStateStore,
} from "./state-db.js";
import { getProjectMemoryDir } from "./utils.js";

const log = createLogger("memory");

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

const PROVENANCE_STORE_KEY = "memory-provenance";
const PROVENANCE_FILENAME_JSONL = "provenance-pending.jsonl";
const LEGACY_PROVENANCE_FILENAME = "provenance-pending.json";

function getProvenanceStore(cwd: string): SqliteStateStore<ProvenancePendingFile> {
  return createSqliteStateStore<ProvenancePendingFile>(
    getProjectStateDbPath(cwd),
    PROVENANCE_STORE_KEY,
  );
}

/** Path where background dream agents write optional provenance sidecars. */
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

/** Read and parse any dream-written or legacy sidecar file on disk. */
function readSidecarEntries(cwd: string): {
  entries: ProvenancePendingItem[];
  consumedPaths: string[];
} {
  const memDir = getProjectMemoryDir(cwd);
  const candidates = [
    join(memDir, PROVENANCE_FILENAME_JSONL),
    join(memDir, LEGACY_PROVENANCE_FILENAME),
  ];
  const entries: ProvenancePendingItem[] = [];
  const consumedPaths: string[] = [];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf-8");
      if (!raw.trim()) {
        consumedPaths.push(filePath);
        continue;
      }
      const parsed = parseLastValidLine<ProvenancePendingFile>(raw);
      if (parsed && Array.isArray(parsed.entries)) {
        entries.push(...parsed.entries);
        consumedPaths.push(filePath);
      } else {
        log.warn("provenance_sidecar_parse_failed", { path: filePath });
      }
    } catch (err) {
      log.warn("provenance_sidecar_read_failed", { path: filePath }, err);
    }
  }
  return { entries, consumedPaths };
}

/**
 * Merge pending provenance (from `state.db` and any dream sidecar file) into
 * memory-scoring, then clear the pending state only after commit succeeds.
 * Returns number of entries updated.
 */
export function mergeProvenancePending(cwd: string): number {
  const store = getProvenanceStore(cwd);
  const dbPending = store.read()?.entries ?? [];
  const sidecar = readSidecarEntries(cwd);
  const combined = [...dbPending, ...sidecar.entries];

  if (combined.length === 0) {
    if (dbPending.length > 0 || store.exists()) {
      store.delete();
    }
    for (const p of sidecar.consumedPaths) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    return 0;
  }

  const updated = applyEntryProvenance(cwd, combined);

  // Only clear pending state / sidecars AFTER applyEntryProvenance commits.
  store.delete();
  for (const p of sidecar.consumedPaths) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  log.debug("provenance_merged", {
    pending: combined.length,
    updated,
    sidecarFiles: sidecar.consumedPaths.length,
  });
  return updated;
}
