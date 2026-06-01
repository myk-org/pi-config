/**
 * memory-embeddings.ts — Vector embedding support for memory search
 *
 * Embeds memory entries and search queries using BAAI/bge-small-en-v1.5 via
 * a Python subprocess (fastembed). Stores embeddings in .pi/memory/embeddings.json.
 *
 * Falls back gracefully when fastembed is unavailable — callers always get a
 * result (possibly empty) and never throw.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const EMBEDDING_DIM = 384;
const EMBED_TIMEOUT_MS = 30_000;

// In-memory cache of the Python embed script path
let embedScriptPath: string | null = null;
// In-memory embedding cache for queries (avoids re-embedding the same query)
const queryCache = new Map<string, number[]>();
// Track if fastembed is known unavailable (don't retry every call)
let fastembedUnavailable = false;

interface EmbeddingStore {
  model: string;
  dim: number;
  entries: Record<string, number[]>; // text hash → vector
}

function getStorePath(cwd: string): string {
  return join(cwd, ".pi", "memory", "embeddings.json");
}

function loadStore(cwd: string): EmbeddingStore {
  const storePath = getStorePath(cwd);
  if (existsSync(storePath)) {
    try {
      return JSON.parse(readFileSync(storePath, "utf-8")) as EmbeddingStore;
    } catch {
      // Corrupted file — start fresh
    }
  }
  return { model: "BAAI/bge-small-en-v1.5", dim: EMBEDDING_DIM, entries: {} };
}

function saveStore(cwd: string, store: EmbeddingStore): void {
  const dir = join(cwd, ".pi", "memory");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getStorePath(cwd), JSON.stringify(store), "utf-8");
}

/** Simple hash for embedding keys — same as memory-scoring entryHash would work but we use the raw text */
function textHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const chr = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}

function getEmbedScript(): string {
  if (embedScriptPath) return embedScriptPath;
  // Write the Python embed script to a temp location
  const script = `
import sys, json
from fastembed import TextEmbedding
model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
texts = json.loads(sys.stdin.read())
embeddings = list(model.embed(texts))
json.dump([e.tolist() for e in embeddings], sys.stdout)
`.trim();
  const scriptPath = join("/tmp", "pi-memory-embed.py");
  writeFileSync(scriptPath, script, "utf-8");
  embedScriptPath = scriptPath;
  return scriptPath;
}

/**
 * Call the Python subprocess to embed texts.
 * Returns array of vectors, or null if fastembed is unavailable.
 */
function runEmbedProcess(texts: string[]): number[][] | null {
  if (fastembedUnavailable || texts.length === 0) return null;

  try {
    const script = getEmbedScript();
    const input = JSON.stringify(texts);
    const result = execFileSync("uv", ["run", "--with", "fastembed", "--with", "numpy", "python3", script], {
      input,
      encoding: "utf-8",
      timeout: EMBED_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(result) as number[][];
  } catch (err: any) {
    // If uv or fastembed not available, mark as unavailable to avoid retrying
    if (err?.message?.includes("ENOENT") || err?.message?.includes("No module named")) {
      fastembedUnavailable = true;
    }
    console.debug("[memory-embeddings] embed failed:", err?.message?.slice(0, 100));
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
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
 * No-op if fastembed is unavailable.
 */
export function embedEntry(cwd: string, text: string): void {
  const store = loadStore(cwd);
  const hash = textHash(text);
  if (store.entries[hash]) return; // Already embedded

  const vectors = runEmbedProcess([text]);
  if (!vectors || vectors.length === 0) return;

  store.entries[hash] = vectors[0];
  saveStore(cwd, store);
}

/**
 * Remove an entry's embedding from the store. Called on memory_remove.
 */
export function removeEmbedding(cwd: string, text: string): void {
  const store = loadStore(cwd);
  const hash = textHash(text);
  if (store.entries[hash]) {
    delete store.entries[hash];
    saveStore(cwd, store);
  }
}

/**
 * Search memory entries by vector similarity.
 * Returns entries sorted by similarity score (highest first).
 * Returns empty array if fastembed is unavailable or no embeddings exist.
 */
export function vectorSearch(
  cwd: string,
  query: string,
  entries: { text: string; category: string; pinned: boolean }[],
  topK: number = 20,
): { text: string; category: string; pinned: boolean; similarity: number }[] {
  const store = loadStore(cwd);
  if (Object.keys(store.entries).length === 0) return [];

  // Get query embedding (cached)
  let queryVec = queryCache.get(query);
  if (!queryVec) {
    const vectors = runEmbedProcess([query]);
    if (!vectors || vectors.length === 0) return [];
    queryVec = vectors[0];
    queryCache.set(query, queryVec);
    // Cap cache size
    if (queryCache.size > 100) {
      const firstKey = queryCache.keys().next().value;
      if (firstKey) queryCache.delete(firstKey);
    }
  }

  // Score all entries that have embeddings
  const scored: { text: string; category: string; pinned: boolean; similarity: number }[] = [];
  for (const entry of entries) {
    const hash = textHash(entry.text);
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
export function embedMissing(
  cwd: string,
  entries: { text: string }[],
): number {
  const store = loadStore(cwd);
  const missing = entries.filter(e => !store.entries[textHash(e.text)]);
  if (missing.length === 0) return 0;

  // Batch embed all missing entries
  const texts = missing.map(e => e.text);
  const vectors = runEmbedProcess(texts);
  if (!vectors || vectors.length !== texts.length) return 0;

  for (let i = 0; i < texts.length; i++) {
    store.entries[textHash(texts[i])] = vectors[i];
  }
  saveStore(cwd, store);
  return texts.length;
}

/**
 * Check if vector search is available (fastembed installed).
 */
export function isVectorSearchAvailable(): boolean {
  if (fastembedUnavailable) return false;
  // Try a trivial embed to check
  const result = runEmbedProcess(["test"]);
  if (!result) return false;
  return true;
}
