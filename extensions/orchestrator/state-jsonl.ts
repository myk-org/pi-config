/**
 * JSONL-backed synchronous state persistence.
 *
 * Replaces ad-hoc JSON read/write with an append-only JSONL file.
 * Each mutation appends a single JSON line — if the process crashes mid-write,
 * the previous state is still intact (worst case: a truncated last line that
 * gets skipped on read). Provides:
 *
 *   - **Append-only durability** — writes never corrupt existing data
 *   - **Crash recovery** — last valid JSON line wins
 *   - **State history** — the JSONL file is a log of all state transitions
 *   - **Compaction** — rewrites to a single line when the file grows too large
 *
 * All operations are synchronous to match the existing extension API surface
 * (enforcement hooks, status bar pollers, transition callbacks).
 *
 * Part of issue #724: migrate state persistence to JSONL.
 */

import { appendFileSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "../shared/logger.js";

const log = createLogger("state-jsonl");

export interface JsonlStateStoreOptions {
  /** Maximum number of lines before automatic compaction (default: 100). */
  compactThreshold?: number;
}

const DEFAULT_COMPACT_THRESHOLD = 100;

/** Locked-mutation retry policy (Qodo #6, PR #916): retry the locked RMW
 *  with linear backoff before failing explicitly. Never fall back to an
 *  unlocked read-modify-write — that can erase a concurrent writer's update. */
const MUTATE_LOCK_RETRY_ATTEMPTS = 5;
const MUTATE_LOCK_BACKOFF_MS = 25;

/** Synchronous sleep for lock backoff (Atomics.wait works on Node's main thread). */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Synchronous JSONL state store.
 *
 * Usage:
 * ```ts
 * const store = new JsonlStateStore<MyState>(filePath);
 * const state = store.read();          // null if no state
 * store.write({ ...state, field: 1 }); // appends a line
 * store.mutate(s => { s.field = 1 });  // locked read-modify-write
 * ```
 */
export class JsonlStateStore<T> {
  private readonly filePath: string;
  private readonly compactThreshold: number;
  private lineCount: number;
  // mtime+size read cache (issue #915): parsing the whole file on every
  // read() is O(file size) — embeddings stores can be multi-MB. The cache
  // invalidates on our own writes and on external mtime/size changes
  // (cross-process writers).
  private cachedState: T | null = null;
  private cachedMtimeMs = 0;
  private cachedSize = -1;

  constructor(filePath: string, options?: JsonlStateStoreOptions) {
    this.filePath = filePath;
    this.compactThreshold = options?.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    // Initialize lineCount from existing file to ensure compaction triggers
    // correctly across process restarts and multi-process writers.
    this.lineCount = this.countExistingLines();
  }

  /** Count non-empty lines in the existing JSONL file. Returns 0 if file doesn't exist. */
  private countExistingLines(): number {
    if (!existsSync(this.filePath)) return 0;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      let count = 0;
      for (const line of raw.split("\n")) {
        if (line.trim()) count++;
      }
      return count;
    } catch {
      return 0;
    }
  }

  /** Read the latest state from the JSONL file. Returns null if no valid state exists.
   *  Cached by mtime+size — repeated reads of an unchanged file do not re-parse. */
  read(): T | null {
    if (!existsSync(this.filePath)) {
      this.cachedState = null;
      this.cachedSize = -1;
      return null;
    }
    let raw: string;
    try {
      const st = statSync(this.filePath);
      if (
        this.cachedState !== null &&
        this.cachedSize === st.size &&
        this.cachedMtimeMs === st.mtimeMs
      ) {
        return this.cachedState;
      }
      raw = readFileSync(this.filePath, "utf-8");
      const state = parseLastValidLine<T>(raw);
      this.cachedState = state;
      this.cachedMtimeMs = st.mtimeMs;
      this.cachedSize = st.size;
      return state;
    } catch {
      this.cachedState = null;
      this.cachedSize = -1;
      return null;
    }
  }

  /** Update the read cache after a write or compaction. */
  private refreshWriteCache(state: T): void {
    this.cachedState = state;
    try {
      const st = statSync(this.filePath);
      this.cachedMtimeMs = st.mtimeMs;
      this.cachedSize = st.size;
    } catch {
      this.cachedSize = -1;
    }
  }

  /** Append a new state snapshot as a JSON line. Auto-compacts when threshold is exceeded.
   *  Uses a cross-process lock to prevent concurrent write+compact races. */
  write(state: T): void {
    ensureDir(this.filePath);
    const locked = withFileLock(this.filePath, () => {
      const line = JSON.stringify(state) + "\n";
      appendFileSync(this.filePath, line);
      this.lineCount++;

      // Check if compaction is needed using in-memory counter (no file re-read)
      if (this.lineCount >= this.compactThreshold) {
        this.compactInner();
      }
      // Refresh the cache while still holding the lock: our state IS the
      // latest, so pairing it with fresh file metadata cannot race a
      // concurrent writer. Refreshing after lock release could pair this
      // (now stale) state with a newer writer's size/mtime (Qodo #7, PR #916).
      this.refreshWriteCache(state);
    });
    if (!locked) {
      // Lock failed — append-only without compaction to prevent data loss.
      // Compaction will happen on a future write when the lock is available.
      const line = JSON.stringify(state) + "\n";
      appendFileSync(this.filePath, line);
      this.lineCount++;
      // Another writer may have appended after us, so pairing OUR state
      // with post-append metadata would be wrong — invalidate instead and
      // let the next read parse the file fresh (Qodo #7, PR #916).
      this.cachedState = null;
      this.cachedSize = -1;
      log.warn("write lock unavailable — appended unlocked, read cache invalidated", { path: this.filePath });
    }
  }

  /**
   * Locked read-modify-write (issue #915): re-reads the latest state under
   * the cross-process lock, applies the mutator, and writes the result.
   * Prevents concurrent sessions from clobbering each other's changes
   * between a load and a save. If the store is empty, `initial` seeds it.
   *
   * The mutator may return a new state object or mutate in place and return
   * undefined. Returns the written state, or null when the store is empty
   * and no initial value was provided (nothing written).
   */
  mutate(fn: (state: T) => T | void, initial?: T): T | null {
    const apply = (current: T): T => {
      const out = fn(current);
      this.write(out === undefined ? current : out);
      return out === undefined ? current : out;
    };
    const seed = (): T | null => {
      if (initial === undefined) return null;
      // Clone so a failed write does not leave the caller's initial mutated
      return apply(JSON.parse(JSON.stringify(initial)) as T);
    };
    // Retry the locked RMW with backoff. An unlocked fallback would append a
    // snapshot derived from a possibly-stale read and erase a concurrent
    // writer's reinforcement/enforcement/provenance update (Qodo #6, PR #916).
    // If the lock stays unavailable, fail explicitly — a refused mutation is
    // recoverable; a silently clobbered one is not.
    for (let attempt = 0; ; attempt++) {
      const locked = withFileLock(this.filePath, () => {
        const current = this.read();
        if (current === null) {
          seed();
          return;
        }
        apply(current);
      });
      if (locked) return this.read();
      if (attempt >= MUTATE_LOCK_RETRY_ATTEMPTS) {
        log.error("mutate: lock unavailable after retries — refusing unlocked read-modify-write", {
          path: this.filePath,
          attempts: attempt + 1,
        });
        throw new Error(
          `JsonlStateStore: could not acquire lock for ${this.filePath} after ${attempt + 1} attempts — ` +
            `refusing to append a state derived from an unlocked read`,
        );
      }
      log.debug("mutate: lock contention — backing off before retry", { path: this.filePath, attempt });
      syncSleep(MUTATE_LOCK_BACKOFF_MS * (attempt + 1));
    }
  }

  /** Compact the JSONL file to a single line containing the latest state.
   *  Always re-reads the file to get the latest state — prevents overwriting
   *  newer data from concurrent writers. Uses atomic rename + cross-process lock. */
  compact(currentState?: T): void {
    withFileLock(this.filePath, () => {
      this.compactInner(currentState);
    });
  }

  /** Internal compact — must be called within a lock. */
  private compactInner(currentState?: T): void {
    const state = currentState ?? this.read();
    if (state === null) return;
    const tmp = `${this.filePath}.${process.pid}.compact`;
    try {
      writeFileSync(tmp, JSON.stringify(state) + "\n");
      renameSync(tmp, this.filePath);
      this.lineCount = 1;
      this.refreshWriteCache(state);
    } catch {
      // Compaction failure is non-fatal — the JSONL file still has valid data.
      // Silent: no logging because extensions must not use console.* (AGENTS.md policy).
      // The file simply retains extra lines until the next successful compaction.
    }
  }

  /** Check if the file exists. */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  /** Get the file path. */
  get path(): string {
    return this.filePath;
  }

}

// ── Shared store factory ───────────────────────────────────────────────────

/** Global store cache — keyed by directory path. */
const storeCache = new Map<string, JsonlStateStore<any>>();
/** Track stores where migration failed — prevents infinite retry per-process. */
const migrationFailed = new Set<string>();

/**
 * Create a cached JsonlStateStore with automatic legacy JSON migration.
 * Deduplicates the identical cache+migrate pattern across all JSONL-migrated files.
 */
export function createCachedStore<T>(
  dir: string,
  jsonlFilename: string,
  legacyFilename: string,
  options?: JsonlStateStoreOptions,
): JsonlStateStore<T> {
  const cacheKey = join(dir, jsonlFilename);
  let store = storeCache.get(cacheKey) as JsonlStateStore<T> | undefined;
  if (!store) {
    store = new JsonlStateStore<T>(join(dir, jsonlFilename), options);
    storeCache.set(cacheKey, store);
  }
  // Retry migration when JSONL has no valid state — covers:
  // - File doesn't exist (first run or previous migration didn't write)
  // - File exists but is empty/corrupt (crash during first append)
  // Without this, callers fall back to defaults which can be unsafe
  // (e.g., review state defaults to "none" → isReviewClean returns true).
  // Check exists() first to avoid expensive read/parse when JSONL is healthy.
  if (!migrationFailed.has(cacheKey) && (!store.exists() || store.read() === null)) {
    const legacyPath = join(dir, legacyFilename);
    if (existsSync(legacyPath)) {
      try {
        const raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as T;
        store.write(raw);
        unlinkSync(legacyPath);
      } catch (err: unknown) {
        // Only mark permanent failures (corrupt JSON) — transient I/O errors should retry.
        // SyntaxError = JSON.parse failed on corrupt content → permanent, won't self-heal.
        // Other errors (EACCES, ENOENT race, disk full) → transient, may succeed next call.
        if (err instanceof SyntaxError) {
          migrationFailed.add(cacheKey);
        }
        // Silent: extensions must not use console.* per AGENTS.md policy.
      }
    }
  }
  return store;
}

/**
 * Parse the last valid JSON line from raw JSONL content.
 * Scans from the end for efficiency — the last line is what we want.
 * Handles truncated last lines (crash recovery) by falling back to the previous line.
 */
export function parseLastValidLine<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try whole-file parse first — handles both single-line JSON and multi-line
  // pretty-printed JSON (e.g., from LLM dream agents). For well-formed JSONL
  // with multiple entries this fails fast (multiple root values → SyntaxError).
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed)) return parsed as T;
  } catch {
    // Not a single JSON value — fall through to line-by-line scan
  }

  // Line-by-line scan from end — for JSONL files with multiple entries.
  // Only accepts plain objects to avoid matching JSON primitives or arrays
  // that could appear as individual lines inside pretty-printed content.
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (isPlainObject(parsed)) return parsed as T;
    } catch {
      continue;
    }
  }
  return null;
}

/** Check if value is a plain object (not null, not array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── JsonlAppendLog ─────────────────────────────────────────────────────────

export interface JsonlAppendLogOptions {
  /** Maximum file size in bytes before truncation (default: 512KB). */
  maxSizeBytes?: number;
  /** Number of lines to keep when truncating (default: 200). */
  keepLines?: number;
}

const DEFAULT_MAX_SIZE = 512_000; // 512KB
const DEFAULT_KEEP_LINES = 200;

/**
 * Synchronous append-only JSONL log.
 *
 * Unlike JsonlStateStore (which reads the latest state), this is for
 * append-only event logs like telemetry. Each append adds a JSON line
 * with an auto-incremented sequence number. Size-based truncation
 * prevents unbounded growth.
 *
 * Usage:
 * ```ts
 * const log = new JsonlAppendLog<TelemetryEvent>(filePath);
 * log.append({ event: "inject", count: 3 }); // adds { seq: 1, ts: "...", ...data }
 * ```
 */
export class JsonlAppendLog<T extends object> {
  private readonly filePath: string;
  private readonly maxSizeBytes: number;
  private readonly keepLines: number;
  private seq: number;

  constructor(filePath: string, options?: JsonlAppendLogOptions) {
    this.filePath = filePath;
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE;
    this.keepLines = options?.keepLines ?? DEFAULT_KEEP_LINES;
    // Initialize seq from existing log to prevent reset on restart
    this.seq = this.readLastSeq();
  }

  /** Read the last seq number from the existing log file. Returns 0 if no log exists. */
  private readLastSeq(): number {
    if (!existsSync(this.filePath)) return 0;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry.seq === "number") return entry.seq;
        } catch { continue; }
      }
    } catch { /* ignore */ }
    return 0;
  }

  /** Append a log entry. Adds `seq` (auto-incremented) and `ts` (ISO timestamp) fields.
   *  Auto-truncates when file exceeds size limit.
   *  Uses cross-process lock to prevent seq duplicates and protect truncation. */
  append(data: T): void {
    ensureDir(this.filePath);
    const locked = withFileLock(this.filePath, () => {
      this.seq++;
      const entry = { seq: this.seq, ts: new Date().toISOString(), ...data };
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n");

      // Size-based truncation inside lock to prevent overwriting concurrent appends
      this.truncateIfNeeded();
    });
    if (!locked) {
      // Lock failed — skip this telemetry event rather than appending unlocked.
      // An unlocked append can race with truncateIfNeeded's read+rename in another
      // process, causing the append to be silently lost anyway. Dropping one event
      // under extreme lock contention is acceptable for best-effort telemetry.
      // Lock uses immediate retries with no backoff — failure can occur even with
      // brief contention, not just sustained overload.
    }
  }

  /** Read all valid log entries. Returns empty array if file doesn't exist. */
  readAll(): Array<T & { seq: number; ts: string }> {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const entries: Array<T & { seq: number; ts: string }> = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Skip corrupt/truncated lines
        continue;
      }
    }
    return entries;
  }

  /** Check if the log file exists. */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  /** Get the file path. */
  get path(): string {
    return this.filePath;
  }

  /** Truncate file to keepLines if it exceeds maxSizeBytes. */
  private truncateIfNeeded(): void {
    try {
      const stat = statSync(this.filePath);
      if (stat.size <= this.maxSizeBytes) return;

      const raw = readFileSync(this.filePath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const kept = lines.slice(-this.keepLines);
      const tmp = `${this.filePath}.${process.pid}.truncate`;
      writeFileSync(tmp, kept.join("\n") + "\n");
      renameSync(tmp, this.filePath);
    } catch {
      // Truncation failure is non-fatal — log file retains extra entries until next success.
      // Silent: extensions must not use console.* per AGENTS.md policy.
    }
  }
}

// ── Cross-process file lock ────────────────────────────────────────────────
// Prevents concurrent write+compact races between orchestrator and subagents.
// Same pattern as pi-config-review-state.ts lock mechanism.

const fileLockDepth = new Map<string, number>();

/** Execute fn while holding a cross-process lock on the JSONL file.
 *  Lock file: <path>.wlock with PID. Uses ".wlock" suffix to avoid collision
 *  with pi-config-review-state's ".lock" suffix (separate depth maps). */
function withFileLock(filePath: string, fn: () => void): boolean {
  const lockFile = filePath + ".wlock";
  const depth = fileLockDepth.get(lockFile) || 0;
  if (depth === 0) {
    if (!acquireFileLock(lockFile)) {
      // Lock acquisition failed — return false so caller can skip compaction.
      return false;
    }
  }
  fileLockDepth.set(lockFile, depth + 1);
  try {
    fn();
  } finally {
    const newDepth = (fileLockDepth.get(lockFile) || 1) - 1;
    if (newDepth <= 0) {
      fileLockDepth.delete(lockFile);
      releaseFileLock(lockFile);
    } else {
      fileLockDepth.set(lockFile, newDepth);
    }
  }
  return true;
}

function acquireFileLock(lockFile: string): boolean {
  const maxRetries = 50;
  for (let i = 0; i < maxRetries; i++) {
    try {
      ensureDir(lockFile);
      writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const pid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
        if (pid === process.pid) return true; // Reentrant
        if (pid) {
          try { process.kill(pid, 0); } catch {
            try { unlinkSync(lockFile); } catch { /* race */ }
            continue;
          }
        }
      } catch {
        try { unlinkSync(lockFile); } catch { /* race */ }
        continue;
      }
    }
  }
  return false;
}

function releaseFileLock(lockFile: string): void {
  try { unlinkSync(lockFile); } catch { /* ignore */ }
}

/** Ensure the parent directory exists. */
function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
