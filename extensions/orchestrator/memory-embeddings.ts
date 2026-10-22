/**
 * memory-embeddings.ts — Vector embedding support for memory search
 *
 * Embeds memory entries and search queries using Xenova/bge-small-en-v1.5 via
 * @huggingface/transformers (in-process ONNX, no Python, no subprocess).
 * Stores embeddings in .pi/memory/embeddings.jsonl (JSONL persistence, issue #724).
 * Legacy embeddings.json auto-migrated on first access.
 *
 * Falls back gracefully when the model is unavailable — callers always get a
 * result (possibly empty) and never throw.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCachedStore } from "./state-jsonl.js";
import type { JsonlStateStore } from "./state-jsonl.js";
import { getProjectMemoryDir } from "./utils.js";

const EMBEDDING_DIM = 384;
export const EMBEDDING_POOLING = "mean";

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

interface EmbeddingStore {
  model: string;
  dim: number;
  pooling?: string;
  entries: Record<string, number[]>; // text hash → vector
}

const STORE_FILENAME_JSONL = "embeddings.jsonl";
const LEGACY_STORE_FILENAME = "embeddings.json";

function getEmbeddingStore(cwd: string): JsonlStateStore<EmbeddingStore> {
  return createCachedStore<EmbeddingStore>(
    getProjectMemoryDir(cwd), STORE_FILENAME_JSONL, LEGACY_STORE_FILENAME, { compactThreshold: 30 },
  );
}

function getStorePath(cwd: string): string {
  return join(getProjectMemoryDir(cwd), STORE_FILENAME_JSONL);
}

function loadStore(cwd: string): EmbeddingStore {
  const store = getEmbeddingStore(cwd);
  const data = store.read();
  if (data !== null) {
    // Invalidate cache when pooling strategy changes — CLS and mean vectors are incompatible
    if (data.pooling !== EMBEDDING_POOLING) {
      // pooling strategy changed — clear incompatible cached embeddings
      data.entries = {};
      data.pooling = EMBEDDING_POOLING;
      queryCache.clear();
      saveStore(cwd, data);
    }
    return data;
  }
  return { model: "Xenova/bge-small-en-v1.5", dim: EMBEDDING_DIM, pooling: EMBEDDING_POOLING, entries: {} };
}

function saveStore(cwd: string, store: EmbeddingStore): void {
  try {
    getEmbeddingStore(cwd).write(store);
  } catch {
    // save failed — non-fatal, embeddings will be recomputed on next access
  }
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
      // #951: `quantized: true` was removed in @huggingface/transformers v4 (replaced by
      // `dtype`); passing it was a silent no-op, so the model loads with the default dtype.
      // Latent bug — the intended q8/quantized load is not restored here; see follow-up issue.
      const extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
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

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Embed a single memory entry and store it. Called on memory_add.
 * No-op if model is unavailable.
 */
export async function embedEntry(cwd: string, text: string, category?: string): Promise<void> {
  try {
    const store = loadStore(cwd);
    const hash = embeddingKey(text, category);
    if (store.entries[hash]) return; // Already embedded

    const vectors = await embed([text]);
    if (!vectors || vectors.length === 0) return;

    store.entries[hash] = vectors[0];
    saveStore(cwd, store);
  } catch {
    // embedEntry failed — non-fatal
  }
}

/**
 * Remove an entry's embedding from the store. Called on memory_remove.
 */
export function removeEmbedding(cwd: string, text: string, category?: string): void {
  try {
    const store = loadStore(cwd);
    const hash = embeddingKey(text, category);
    if (store.entries[hash]) {
      delete store.entries[hash];
      saveStore(cwd, store);
    }
  } catch {
    // removeEmbedding failed — non-fatal, stale embedding is harmless
  }
}

/**
 * Search memory entries by vector similarity.
 * Returns entries sorted by similarity score (highest first).
 * Returns empty array if model is unavailable or no embeddings exist.
 */
export async function vectorSearch(
  cwd: string,
  query: string,
  entries: { text: string; category: string; pinned: boolean }[],
  topK: number = 20,
): Promise<{ text: string; category: string; pinned: boolean; similarity: number }[]> {
  const store = loadStore(cwd);
  if (Object.keys(store.entries).length === 0) return [];

  const queryVec = await embedQuery(query);
  if (!queryVec) return [];

  // Score all entries that have embeddings
  const scored: { text: string; category: string; pinned: boolean; similarity: number }[] = [];
  for (const entry of entries) {
    const hash = embeddingKey(entry.text, entry.category);
    const entryVec = store.entries[hash];
    if (!entryVec) continue;
    const similarity = cosineSimilarity(queryVec, entryVec);
    scored.push({ ...entry, similarity });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

/**
 * Embed all entries that don't have embeddings yet.
 * Used for initial migration when vector search is first enabled.
 * Returns count of newly embedded entries.
 */
export async function embedMissing(
  cwd: string,
  entries: { text: string; category: string }[],
): Promise<number> {
  const store = loadStore(cwd);
  const missing = entries.filter(e => !store.entries[embeddingKey(e.text, e.category)]);
  if (missing.length === 0) return 0;

  // Batch embed all missing entries
  const texts = missing.map(e => e.text);
  const vectors = await embed(texts);
  if (!vectors || vectors.length !== texts.length) return 0;

  let stored = 0;
  for (let i = 0; i < missing.length; i++) {
    const vec = vectors[i];
    // Validate vector dimensions — skip corrupted results
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) continue;
    store.entries[embeddingKey(missing[i].text, missing[i].category)] = vec;
    stored++;
  }
  saveStore(cwd, store);
  return stored;
}

/**
 * Check if vector search is available (model can load).
 */
export async function isVectorSearchAvailable(): Promise<boolean> {
  const pipeline = await getPipeline();
  return pipeline !== null;
}
