/**
 * memory-embeddings.ts — Vector embedding support for memory search
 *
 * Embeds memory entries and search queries using Xenova/bge-small-en-v1.5 via
 * @huggingface/transformers (in-process ONNX, no Python, no subprocess).
 * Stores embeddings as compact binary Float32Array BLOBs in `.pi/data/state.db`
 * (`embedding_meta` + `embeddings` tables, issue #1399).
 * Legacy `.pi/memory/embeddings.jsonl` and `embeddings.json` are auto-migrated
 * once on first access.
 *
 * Falls back gracefully when the model is unavailable — callers always get a
 * result (possibly empty) and never throw.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  blobToFloat32Array,
  encodeFloat32Blob,
  getProjectStateDbPath,
  isStoreMigratedInCache,
  isStoreMigrationFailedInCache,
  markStoreMigratedInCache,
  markStoreMigrationFailedInCache,
  openStateDb,
  parseLastValidLine,
  withTransaction,
} from "./state-db.js";
import { getProjectMemoryDir } from "./utils.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("memory");

const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
const EMBEDDING_DIM = 384;
export const EMBEDDING_POOLING = "mean";

const EMBEDDINGS_STORE_KEY = "memory-embeddings";
const STORE_FILENAME_JSONL = "embeddings.jsonl";
const LEGACY_STORE_FILENAME = "embeddings.json";

// Lazy-loaded pipeline — initialized once per process
let pipelineInstance: any = null;
let pipelineLoading: Promise<any> | null = null;
// Failed-init backoff (issue #915): a failed model load (offline, corrupt
// cache) previously retried the full ~2.7s init on EVERY call. Now we back
// off for 10 minutes before retrying.
let pipelineFailedAt = 0;
const PIPELINE_RETRY_BACKOFF_MS = 10 * 60 * 1000;

// In-memory embedding cache for queries
const queryCache = new Map<string, number[]>();

interface LegacyEmbeddingStore {
  model?: string;
  dim?: number;
  pooling?: string;
  entries?: Record<string, unknown>;
}

function upsertEmbeddingMeta(db: DatabaseSync, now: string): void {
  db.prepare(
    `INSERT INTO embedding_meta (id, model, dim, pooling, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       model = excluded.model,
       dim = excluded.dim,
       pooling = excluded.pooling,
       updated_at = excluded.updated_at`,
  ).run(EMBEDDING_MODEL, EMBEDDING_DIM, EMBEDDING_POOLING, now);
}

/** One-time idempotent lossless migration from legacy JSONL/JSON embedding files into Float32 BLOBs. */
function ensureEmbeddingsMigrated(cwd: string): string {
  const dbPath = getProjectStateDbPath(cwd);
  if (
    isStoreMigratedInCache(dbPath, EMBEDDINGS_STORE_KEY) ||
    isStoreMigrationFailedInCache(dbPath, EMBEDDINGS_STORE_KEY)
  ) {
    return dbPath;
  }

  const db = openStateDb(dbPath);
  if (
    db.prepare("SELECT 1 FROM embedding_meta WHERE id = 1").get() ||
    db.prepare("SELECT 1 FROM migrated_stores WHERE store_key = ?").get(EMBEDDINGS_STORE_KEY)
  ) {
    markStoreMigratedInCache(dbPath, EMBEDDINGS_STORE_KEY);
    return dbPath;
  }

  const memDir = getProjectMemoryDir(cwd);
  const legacyCandidates = [
    join(memDir, STORE_FILENAME_JSONL),
    join(memDir, LEGACY_STORE_FILENAME),
  ].filter((p) => existsSync(p));
  if (legacyCandidates.length === 0) return dbPath;

  let migratedSource: string | null = null;
  let migratedCount = 0;
  let migratedPooling = "";
  let sawCorrupt = false;
  let sawReadError = false;

  withTransaction(dbPath, (txDb) => {
    if (
      txDb.prepare("SELECT 1 FROM embedding_meta WHERE id = 1").get() ||
      txDb.prepare("SELECT 1 FROM migrated_stores WHERE store_key = ?").get(EMBEDDINGS_STORE_KEY)
    ) {
      return;
    }

    for (const legacyPath of legacyCandidates) {
      let raw: string;
      try {
        raw = readFileSync(legacyPath, "utf-8");
      } catch (err) {
        sawReadError = true;
        log.warn("embeddings_legacy_read_failed", { sourcePath: legacyPath }, err);
        continue;
      }
      if (!raw.trim()) continue;
      const parsed = parseLastValidLine<LegacyEmbeddingStore>(raw);
      if (!parsed) {
        sawCorrupt = true;
        log.warn("embeddings_legacy_parse_failed", { sourcePath: legacyPath });
        continue;
      }

      const now = new Date().toISOString();
      const model = typeof parsed.model === "string" && parsed.model ? parsed.model : EMBEDDING_MODEL;
      const dim = typeof parsed.dim === "number" && Number.isFinite(parsed.dim) && parsed.dim > 0
        ? Math.floor(parsed.dim)
        : EMBEDDING_DIM;
      // Preserve absent pooling as "" so pooling-change invalidation clears incompatible vectors.
      const pooling = typeof parsed.pooling === "string" ? parsed.pooling : "";

      txDb
        .prepare(
          "INSERT INTO embedding_meta (id, model, dim, pooling, updated_at) VALUES (1, ?, ?, ?, ?)",
        )
        .run(model, dim, pooling, now);

      const insertVec = txDb.prepare(
        "INSERT OR REPLACE INTO embeddings (entry_key, vector, updated_at) VALUES (?, ?, ?)",
      );
      if (parsed.entries && typeof parsed.entries === "object" && !Array.isArray(parsed.entries)) {
        for (const [key, vec] of Object.entries(parsed.entries)) {
          if (
            Array.isArray(vec) &&
            vec.length > 0 &&
            vec.every((n) => typeof n === "number" && Number.isFinite(n))
          ) {
            insertVec.run(key, encodeFloat32Blob(vec as number[]), now);
            migratedCount++;
          }
        }
      }

      txDb
        .prepare(
          "INSERT INTO migrated_stores (store_key, source_path, migrated_at) VALUES (?, ?, ?)",
        )
        .run(EMBEDDINGS_STORE_KEY, legacyPath, now);
      migratedSource = legacyPath;
      migratedPooling = pooling;
      break;
    }
  });

  if (migratedSource) {
    markStoreMigratedInCache(dbPath, EMBEDDINGS_STORE_KEY);
    log.info("embeddings_migrated_legacy", {
      sourcePath: migratedSource,
      count: migratedCount,
      pooling: migratedPooling,
    });
  } else if (sawCorrupt && !sawReadError) {
    markStoreMigrationFailedInCache(dbPath, EMBEDDINGS_STORE_KEY);
  } else if (
    db.prepare("SELECT 1 FROM embedding_meta WHERE id = 1").get() ||
    db.prepare("SELECT 1 FROM migrated_stores WHERE store_key = ?").get(EMBEDDINGS_STORE_KEY)
  ) {
    markStoreMigratedInCache(dbPath, EMBEDDINGS_STORE_KEY);
  }

  return dbPath;
}

/** Check pooling inside an active write transaction; clears incompatible vectors if pooling changed. */
function enforcePoolingInTx(txDb: DatabaseSync, now: string): boolean {
  const meta = txDb
    .prepare("SELECT pooling FROM embedding_meta WHERE id = 1")
    .get() as { pooling?: string } | undefined;
  if (meta && meta.pooling !== EMBEDDING_POOLING) {
    txDb.exec("DELETE FROM embeddings");
    upsertEmbeddingMeta(txDb, now);
    queryCache.clear();
    log.info("embeddings_pooling_invalidated", { from: meta.pooling, to: EMBEDDING_POOLING });
    return true;
  }
  return false;
}

/** Migrate legacy store if needed and invalidate cached vectors if pooling strategy changed. */
function ensureReadyEmbeddingsDb(cwd: string): string {
  const dbPath = ensureEmbeddingsMigrated(cwd);
  const db = openStateDb(dbPath);
  const meta = db
    .prepare("SELECT pooling FROM embedding_meta WHERE id = 1")
    .get() as { pooling?: string } | undefined;
  if (meta && meta.pooling !== EMBEDDING_POOLING) {
    withTransaction(dbPath, (txDb) => {
      enforcePoolingInTx(txDb, new Date().toISOString());
    });
  }
  return dbPath;
}

/** SHA-256 hash for embedding keys — includes category to avoid cross-category collisions */
function embeddingKey(text: string, category?: string): string {
  const input = category ? `[${category}] ${text}` : text;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Get or initialize the embedding pipeline.
 * Lazy-loaded on first use, cached for process lifetime.
 */
async function getPipeline(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  if (pipelineLoading) return pipelineLoading;
  if (Date.now() - pipelineFailedAt < PIPELINE_RETRY_BACKOFF_MS) return null;

  pipelineLoading = (async () => {
    try {
      const { pipeline } = await import("@huggingface/transformers");
      // q8 quantized weights: ~4x smaller and faster than fp32, negligible
      // accuracy loss for embedding similarity (dtype replaced `quantized` in
      // @huggingface/transformers v4 — issue #951 follow-up).
      const extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
      pipelineInstance = extractor;
      return extractor;
    } catch {
      // model init failed — vector search unavailable until the backoff
      // window passes, then retried automatically
      pipelineFailedAt = Date.now();
      return null;
    } finally {
      pipelineLoading = null;
    }
  })();

  return pipelineLoading;
}

/**
 * Embed texts using the in-process ONNX model.
 * Returns array of vectors, or null if model is unavailable.
 */
async function embed(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return null;

  const extractor = await getPipeline();
  if (!extractor) return null;

  try {
    // Mean pooling produces more discriminative embeddings for sentence-to-sentence
    // similarity (dedup) vs CLS which over-weights structural patterns.
    const result = await extractor(texts, { pooling: EMBEDDING_POOLING, normalize: true });
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      vectors.push(Array.from(result[i].data as Float32Array));
    }
    return vectors;
  } catch {
    // embed failed — return null, caller handles gracefully
    return null;
  }
}

/**
 * Embed a single query text with caching.
 */
async function embedQuery(query: string): Promise<number[] | null> {
  const cached = queryCache.get(query);
  if (cached) return cached;

  const vectors = await embed([query]);
  if (!vectors || vectors.length === 0) return null;

  queryCache.set(query, vectors[0]);
  // Cap cache size
  if (queryCache.size > 200) {
    const firstKey = queryCache.keys().next().value;
    if (firstKey !== undefined) queryCache.delete(firstKey);
  }

  return vectors[0];
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Embed a single memory entry and store it as a Float32 BLOB. Called on memory_add.
 * No-op if model is unavailable.
 */
export async function embedEntry(cwd: string, text: string, category?: string): Promise<void> {
  try {
    const dbPath = ensureReadyEmbeddingsDb(cwd);
    const hash = embeddingKey(text, category);
    const existing = openStateDb(dbPath)
      .prepare("SELECT 1 FROM embeddings WHERE entry_key = ?")
      .get(hash);
    if (existing) return; // Already embedded

    const vectors = await embed([text]);
    if (!vectors || vectors.length === 0) return;

    const now = new Date().toISOString();
    withTransaction(dbPath, (txDb) => {
      enforcePoolingInTx(txDb, now);
      upsertEmbeddingMeta(txDb, now);
      txDb
        .prepare(
          "INSERT OR REPLACE INTO embeddings (entry_key, vector, updated_at) VALUES (?, ?, ?)",
        )
        .run(hash, encodeFloat32Blob(vectors[0]!), now);
    });
    markStoreMigratedInCache(dbPath, EMBEDDINGS_STORE_KEY);
  } catch (err) {
    log.warn("embed_entry_failed", { category }, err);
  }
}

/**
 * Remove one or more entries' embeddings from the store in a single atomic transaction.
 */
export function removeEmbeddings(
  cwd: string,
  entries: { text: string; category?: string }[],
): number {
  if (entries.length === 0) return 0;
  try {
    const dbPath = ensureReadyEmbeddingsDb(cwd);
    const keysToRemove = entries.map((e) => embeddingKey(e.text, e.category));

    let removed = 0;
    withTransaction(dbPath, (txDb) => {
      if (enforcePoolingInTx(txDb, new Date().toISOString())) return;
      const del = txDb.prepare("DELETE FROM embeddings WHERE entry_key = ?");
      for (const hash of keysToRemove) {
        const info = del.run(hash);
        removed += Number(info.changes ?? 0);
      }
    });
    if (removed > 0) {
      log.debug("embeddings_removed", { removed });
    }
    return removed;
  } catch (err) {
    log.warn("embeddings_remove_failed", { count: entries.length }, err);
    return 0;
  }
}

/**
 * Remove an entry's embedding from the store. Called on memory_remove.
 */
export function removeEmbedding(cwd: string, text: string, category?: string): void {
  removeEmbeddings(cwd, [{ text, category }]);
}

/**
 * Prune orphaned embeddings whose keys no longer match any live topic entry.
 * Guards against empty liveEntries (never wipes embeddings on an empty/failed read)
 * and revalidates live entries inside the write transaction when `getFreshLiveEntries`
 * is supplied so concurrent adds are never lost.
 */
export function pruneEmbeddings(
  cwd: string,
  liveEntries: { text: string; category: string }[],
  getFreshLiveEntries?: () => { text: string; category: string }[],
): number {
  if (liveEntries.length === 0) return 0;
  try {
    const dbPath = ensureReadyEmbeddingsDb(cwd);
    const existingRows = openStateDb(dbPath)
      .prepare("SELECT entry_key FROM embeddings")
      .all() as Array<{ entry_key: string }>;
    if (existingRows.length === 0) return 0;

    const snapshotKeys = new Set(liveEntries.map((e) => embeddingKey(e.text, e.category)));
    if (!existingRows.some((r) => !snapshotKeys.has(r.entry_key))) return 0;

    let pruned = 0;
    let remaining = existingRows.length;
    withTransaction(dbPath, (txDb) => {
      if (enforcePoolingInTx(txDb, new Date().toISOString())) {
        remaining = 0;
        return;
      }
      const currentLive = getFreshLiveEntries ? getFreshLiveEntries() : liveEntries;
      const allRows = txDb
        .prepare("SELECT entry_key FROM embeddings")
        .all() as Array<{ entry_key: string }>;
      if (currentLive.length === 0) {
        remaining = allRows.length;
        return;
      }
      const liveKeys = new Set(currentLive.map((e) => embeddingKey(e.text, e.category)));
      const del = txDb.prepare("DELETE FROM embeddings WHERE entry_key = ?");
      for (const row of allRows) {
        if (!liveKeys.has(row.entry_key)) {
          const info = del.run(row.entry_key);
          pruned += Number(info.changes ?? 0);
        }
      }
      remaining = allRows.length - pruned;
    });
    if (pruned > 0) {
      log.info("embeddings_pruned", { pruned, remaining });
    }
    return pruned;
  } catch (err) {
    log.warn("embeddings_prune_failed", { liveCount: liveEntries.length }, err);
    return 0;
  }
}

/**
 * Search memory entries by vector similarity.
 * Returns entries sorted by similarity score (highest first).
 * Returns empty array if model is unavailable, DB fails, or no embeddings exist.
 */
export async function vectorSearch(
  cwd: string,
  query: string,
  entries: { text: string; category: string; pinned: boolean }[],
  topK: number = 20,
): Promise<{ text: string; category: string; pinned: boolean; similarity: number }[]> {
  try {
    const dbPath = ensureReadyEmbeddingsDb(cwd);
    const countRow = openStateDb(dbPath)
      .prepare("SELECT COUNT(*) AS cnt FROM embeddings")
      .get() as { cnt?: number } | undefined;
    if (!countRow || !countRow.cnt) return [];

    const queryVec = await embedQuery(query);
    if (!queryVec || queryVec.length === 0) return [];

    // Precompute query norm once outside the entry loop
    let normQuery = 0;
    for (let i = 0; i < queryVec.length; i++) {
      const q = queryVec[i]!;
      normQuery += q * q;
    }
    if (normQuery === 0) return [];
    const sqrtNormQuery = Math.sqrt(normQuery);

    // Re-acquire handle via openStateDb after await (closeStateDbs or unlink may have closed prior handle).
    const rows = openStateDb(dbPath)
      .prepare("SELECT entry_key, vector FROM embeddings")
      .all() as Array<{ entry_key: string; vector: Uint8Array }>;
    const vectorsByKey = new Map<string, Float32Array>();
    for (const row of rows) {
      if (row.vector instanceof Uint8Array && row.vector.byteLength > 0 && row.vector.byteLength % 4 === 0) {
        vectorsByKey.set(row.entry_key, blobToFloat32Array(row.vector));
      }
    }

    // Score all entries that have embeddings
    const scored: { text: string; category: string; pinned: boolean; similarity: number }[] = [];
    for (const entry of entries) {
      const hash = embeddingKey(entry.text, entry.category);
      const entryVec = vectorsByKey.get(hash);
      if (!entryVec || entryVec.length === 0) continue;
      let similarity: number;
      if (entryVec.length === queryVec.length) {
        let dot = 0;
        let normEntry = 0;
        for (let i = 0; i < queryVec.length; i++) {
          const e = entryVec[i]!;
          dot += queryVec[i]! * e;
          normEntry += e * e;
        }
        similarity = normEntry === 0 ? 0 : dot / (sqrtNormQuery * Math.sqrt(normEntry));
      } else {
        similarity = cosineSimilarity(queryVec, entryVec);
      }
      scored.push({ ...entry, similarity });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  } catch (err) {
    log.warn("vector_search_failed", { entryCount: entries.length }, err);
    return [];
  }
}

/**
 * Embed all entries that don't have embeddings yet.
 * Used for initial migration when vector search is first enabled.
 * Returns count of newly embedded entries (`>= 0`), or `-1` on a database error
 * so callers can retry later without breaking keyword-search fallback.
 */
export async function embedMissing(
  cwd: string,
  entries: { text: string; category: string }[],
): Promise<number> {
  try {
    const dbPath = ensureReadyEmbeddingsDb(cwd);
    const existingRows = openStateDb(dbPath)
      .prepare("SELECT entry_key FROM embeddings")
      .all() as Array<{ entry_key: string }>;
    const existing = new Set(existingRows.map((r) => r.entry_key));

    const missing = entries.filter((e) => !existing.has(embeddingKey(e.text, e.category)));
    if (missing.length === 0) return 0;

    // Batch embed all missing entries
    const texts = missing.map((e) => e.text);
    const vectors = await embed(texts);
    if (!vectors || vectors.length !== texts.length) return 0;

    let stored = 0;
    const now = new Date().toISOString();
    withTransaction(dbPath, (txDb) => {
      enforcePoolingInTx(txDb, now);
      upsertEmbeddingMeta(txDb, now);
      const insertVec = txDb.prepare(
        "INSERT OR REPLACE INTO embeddings (entry_key, vector, updated_at) VALUES (?, ?, ?)",
      );
      for (let i = 0; i < missing.length; i++) {
        const vec = vectors[i];
        // Validate vector dimensions — skip corrupted results
        if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) continue;
        insertVec.run(
          embeddingKey(missing[i]!.text, missing[i]!.category),
          encodeFloat32Blob(vec),
          now,
        );
        stored++;
      }
    });
    markStoreMigratedInCache(dbPath, EMBEDDINGS_STORE_KEY);
    return stored;
  } catch (err) {
    log.warn("embed_missing_failed", { entryCount: entries.length }, err);
    return -1;
  }
}

/**
 * Check if vector search is available (model can load).
 */
export async function isVectorSearchAvailable(): Promise<boolean> {
  const pipeline = await getPipeline();
  return pipeline !== null;
}
