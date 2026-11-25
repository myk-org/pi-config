/**
 * Shared SQLite state persistence using built-in `node:sqlite` (`DatabaseSync`).
 *
 * Consolidates project/worktree runtime state stores into WAL-mode SQLite
 * databases (`.pi/data/state.db` for project-wide stores; worktree-scoped
 * `<worktree-root>/.pi/data/state.db` for `pi-config-review-state`), replacing
 * whole-file JSONL rewrites and polling PID lockfiles with native SQLite
 * concurrency (`WAL` + `busy_timeout = 5000` + `BEGIN IMMEDIATE` transactions)
 * and compact binary `Float32Array` BLOB storage for embeddings.
 *
 * Issue #1399. Zero external dependencies.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../shared/logger.js";
import { parseLastValidLine, SKIP_MUTATE } from "./state-jsonl.js";
import { getProjectDataDir, resolveWorktreeRoot } from "./utils.js";

export { parseLastValidLine, SKIP_MUTATE };

const log = createLogger("state-db");

export const STATE_DB_FILENAME = "state.db";
export const CURRENT_SCHEMA_VERSION = 1;
export const STATE_DB_BUSY_TIMEOUT_MS = 5000;

interface CachedStateDb {
  db: DatabaseSync;
  dbPath: string;
  dev: number;
  ino: number;
  txDepth: number;
  migratedKeys: Set<string>;
  migrationFailedKeys: Set<string>;
}

const dbCache = new Map<string, CachedStateDb>();
const kvStoreCache = new Map<string, SqliteStateStore<any>>();

// ── Path Helpers ───────────────────────────────────────────────────────────

/** Shared project-wide state DB under `<main-checkout>/.pi/data/state.db`. */
export function getProjectStateDbPath(cwd: string): string {
  return join(getProjectDataDir(cwd), STATE_DB_FILENAME);
}

/** Per-worktree state DB under `<worktree-root>/.pi/data/state.db`.
 *  Preserves worktree isolation for per-branch state like `pi-config-review-state`. */
export function getWorktreeStateDbPath(cwd: string): string {
  const dir = join(resolveWorktreeRoot(cwd), ".pi", "data");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, STATE_DB_FILENAME);
}

// ── Schema Initialization ──────────────────────────────────────────────────

function readSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db
      .prepare("SELECT MAX(version) AS v FROM schema_version")
      .get() as { v?: number | null } | undefined;
    return typeof row?.v === "number" ? row.v : 0;
  } catch {
    return 0;
  }
}

function initSchema(db: DatabaseSync, dbPath: string): void {
  // Fast read-only check avoids taking a write lock on every process open
  // once the database is already at CURRENT_SCHEMA_VERSION.
  if (readSchemaVersion(db) >= CURRENT_SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (readSchemaVersion(db) < CURRENT_SCHEMA_VERSION) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS kv_state (
          store_key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS migrated_stores (
          store_key TEXT PRIMARY KEY,
          source_path TEXT NOT NULL,
          migrated_at TEXT NOT NULL,
          source_mtime_ms REAL NOT NULL DEFAULT 0,
          source_size INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS embedding_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          model TEXT NOT NULL,
          dim INTEGER NOT NULL,
          pooling TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS embeddings (
          entry_key TEXT PRIMARY KEY,
          vector BLOB NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(
        "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)",
      ).run(CURRENT_SCHEMA_VERSION, new Date().toISOString());
      log.info("state_db_schema_initialized", {
        path: dbPath,
        version: CURRENT_SCHEMA_VERSION,
      });
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    log.error("state_db_schema_init_failed", { path: dbPath }, err);
    throw err;
  }
}

// ── Handle Lifecycle ───────────────────────────────────────────────────────

function getOrOpenStateDb(dbPath: string): CachedStateDb {
  const absPath = resolve(dbPath);
  const existing = dbCache.get(absPath);
  if (existing) {
    // Detect external unlink/replacement (common in temp-dir tests) so we never
    // keep writing to an unlinked inode.
    try {
      const st = statSync(absPath);
      if (existing.ino === 0 || (st.ino === existing.ino && st.dev === existing.dev)) {
        return existing;
      }
    } catch {
      // File removed externally — fall through to close & reopen
    }
    log.debug("state_db_reopening_replaced_handle", { path: absPath });
    closeStateDb(absPath);
  }

  mkdirSync(dirname(absPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(absPath, { timeout: STATE_DB_BUSY_TIMEOUT_MS });
  try {
    db.exec(`PRAGMA busy_timeout = ${STATE_DB_BUSY_TIMEOUT_MS};`);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    initSchema(db, absPath);
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore close error */
    }
    throw err;
  }

  let dev = 0;
  let ino = 0;
  try {
    const st = statSync(absPath);
    dev = st.dev;
    ino = st.ino;
  } catch {
    /* ignore */
  }

  const cached: CachedStateDb = {
    db,
    dbPath: absPath,
    dev,
    ino,
    txDepth: 0,
    migratedKeys: new Set(),
    migrationFailedKeys: new Set(),
  };
  dbCache.set(absPath, cached);
  log.debug("state_db_opened", { path: absPath, schemaVersion: CURRENT_SCHEMA_VERSION });
  return cached;
}

/** Open (or return cached) WAL-mode SQLite handle for `dbPath`. */
export function openStateDb(dbPath: string): DatabaseSync {
  return getOrOpenStateDb(dbPath).db;
}

/** Close a single cached state DB handle and clear associated store caches. */
export function closeStateDb(dbPath: string): void {
  const absPath = resolve(dbPath);
  const cached = dbCache.get(absPath);
  if (cached) {
    dbCache.delete(absPath);
    try {
      cached.db.close();
    } catch (err) {
      log.warn("state_db_close_failed", { path: absPath }, err);
    }
    log.debug("state_db_closed", { path: absPath });
  }
  const prefix = `${absPath}\0`;
  for (const key of kvStoreCache.keys()) {
    if (key.startsWith(prefix)) kvStoreCache.delete(key);
  }
}

/** Close all cached state DB handles (for tests and session shutdown). */
export function closeStateDbs(): void {
  const count = dbCache.size;
  for (const [absPath, cached] of dbCache) {
    try {
      cached.db.close();
    } catch (err) {
      log.warn("state_db_close_failed", { path: absPath }, err);
    }
  }
  dbCache.clear();
  kvStoreCache.clear();
  if (count > 0) {
    log.debug("state_db_closed_all", { count });
  }
}

/**
 * Execute `fn` inside an atomic `BEGIN IMMEDIATE` transaction (re-entrant via
 * `SAVEPOINT` for nested in-process calls). Rolls back on error.
 */
export function withTransaction<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const entry = getOrOpenStateDb(dbPath);
  if (entry.txDepth === 0) {
    entry.db.exec("BEGIN IMMEDIATE");
    entry.txDepth = 1;
    try {
      const result = fn(entry.db);
      entry.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        entry.db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    } finally {
      entry.txDepth = 0;
    }
  }

  const sp = `state_db_sp_${entry.txDepth}`;
  entry.db.exec(`SAVEPOINT ${sp}`);
  entry.txDepth++;
  try {
    const result = fn(entry.db);
    entry.db.exec(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    try {
      entry.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
    } catch {
      /* ignore savepoint rollback failure */
    }
    throw err;
  } finally {
    entry.txDepth--;
  }
}

// ── Handle-scoped Migration Cache Helpers ──────────────────────────────────

export function isStoreMigratedInCache(dbPath: string, storeKey: string): boolean {
  return getOrOpenStateDb(dbPath).migratedKeys.has(storeKey);
}

export function markStoreMigratedInCache(dbPath: string, storeKey: string): void {
  getOrOpenStateDb(dbPath).migratedKeys.add(storeKey);
}

export function isStoreMigrationFailedInCache(dbPath: string, storeKey: string): boolean {
  return getOrOpenStateDb(dbPath).migrationFailedKeys.has(storeKey);
}

export function markStoreMigrationFailedInCache(dbPath: string, storeKey: string): void {
  getOrOpenStateDb(dbPath).migrationFailedKeys.add(storeKey);
}

// ── Binary Float32Array BLOB Helpers (Embeddings) ──────────────────────────

/** Encode a numeric vector into a compact Float32Array byte view (4 bytes/dim). */
export function encodeFloat32Blob(vec: readonly number[] | Float32Array): Uint8Array {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** View (or align-copy) a SQLite BLOB as a Float32Array without allocating JS numbers. */
export function blobToFloat32Array(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`Invalid Float32Array BLOB byte length: ${blob.byteLength}`);
  }
  if (blob.byteOffset % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  const aligned = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(aligned);
}

/** Decode a SQLite Float32Array BLOB into a plain number array. */
export function decodeFloat32Blob(blob: Uint8Array): number[] {
  return Array.from(blobToFloat32Array(blob));
}

// ── Typed Key-Value SQLite State Store ─────────────────────────────────────

export interface SqliteStateStoreOptions {
  /** Ordered candidate legacy files (`.jsonl` / `.json`) to migrate on first access.
   *  First valid plain object wins; legacy files are never modified or deleted. */
  legacyFiles?: string[];
}

export class SqliteStateStore<T> {
  private readonly dbPath: string;
  private readonly storeKey: string;
  private readonly legacyFiles: string[];
  private cachedValue: T | null = null;
  private cachedRevision = -1;
  private cachedUpdatedAt = "";
  private legacySourcePath: string | null = null;
  private legacySourceMtimeMs = -1;
  private legacySourceSize = -1;

  constructor(dbPath: string, storeKey: string, options?: SqliteStateStoreOptions) {
    this.dbPath = resolve(dbPath);
    this.storeKey = storeKey;
    this.legacyFiles = options?.legacyFiles ? [...options.legacyFiles] : [];
  }

  get path(): string {
    return this.dbPath;
  }

  get key(): string {
    return this.storeKey;
  }

  /**
   * Reconcile post-migration legacy writes from an older pre-upgrade process
   * still running alongside upgraded processes (mixed-version cutover).
   * Only imports a newer legacy snapshot when its mtime is strictly newer than
   * SQLite's `kv_state.updated_at` so newer SQLite updates are never clobbered.
   */
  private reconcilePostMigrationLegacy(entry: CachedStateDb): void {
    if (this.legacySourcePath === null) {
      const migRow = entry.db
        .prepare(
          "SELECT source_path, source_mtime_ms, source_size FROM migrated_stores WHERE store_key = ?",
        )
        .get(this.storeKey) as
        | { source_path?: string; source_mtime_ms?: number; source_size?: number }
        | undefined;
      if (!migRow?.source_path) {
        this.legacySourcePath = "";
        return;
      }
      this.legacySourcePath = migRow.source_path;
      this.legacySourceMtimeMs = Number(migRow.source_mtime_ms ?? 0);
      this.legacySourceSize = Number(migRow.source_size ?? 0);
    }
    if (!this.legacySourcePath) return;

    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(this.legacySourcePath);
    } catch {
      return;
    }
    if (st.mtimeMs === this.legacySourceMtimeMs && st.size === this.legacySourceSize) {
      return;
    }

    const sourcePath = this.legacySourcePath;
    let reconciled = false;
    let superseded = false;
    withTransaction(this.dbPath, (txDb) => {
      const migRow = txDb
        .prepare(
          "SELECT source_mtime_ms, source_size FROM migrated_stores WHERE store_key = ?",
        )
        .get(this.storeKey) as { source_mtime_ms?: number; source_size?: number } | undefined;
      if (
        migRow &&
        Number(migRow.source_mtime_ms ?? 0) === st.mtimeMs &&
        Number(migRow.source_size ?? 0) === st.size
      ) {
        return;
      }

      const kvRow = txDb
        .prepare("SELECT updated_at FROM kv_state WHERE store_key = ?")
        .get(this.storeKey) as { updated_at?: string } | undefined;
      const sqliteUpdatedMs = kvRow?.updated_at ? Date.parse(kvRow.updated_at) : 0;

      if (!kvRow || Number.isNaN(sqliteUpdatedMs) || st.mtimeMs > sqliteUpdatedMs) {
        let raw: string;
        try {
          raw = readFileSync(sourcePath, "utf-8");
        } catch (err) {
          log.warn("state_db_legacy_reconcile_read_failed", { storeKey: this.storeKey, sourcePath }, err);
          return;
        }
        const parsed = parseLastValidLine<T>(raw);
        if (parsed === null) {
          log.warn("state_db_legacy_reconcile_parse_failed", { storeKey: this.storeKey, sourcePath });
          return;
        }
        const nextUpdatedAt = new Date(Math.max(Date.now(), Math.ceil(st.mtimeMs))).toISOString();
        txDb
          .prepare(
            `INSERT INTO kv_state (store_key, payload, revision, updated_at)
             VALUES (?, ?, 1, ?)
             ON CONFLICT(store_key) DO UPDATE SET
               payload = excluded.payload,
               revision = kv_state.revision + 1,
               updated_at = excluded.updated_at`,
          )
          .run(this.storeKey, JSON.stringify(parsed), nextUpdatedAt);
        txDb
          .prepare(
            "UPDATE migrated_stores SET source_mtime_ms = ?, source_size = ? WHERE store_key = ?",
          )
          .run(st.mtimeMs, st.size, this.storeKey);
        reconciled = true;
      } else {
        txDb
          .prepare(
            "UPDATE migrated_stores SET source_mtime_ms = ?, source_size = ? WHERE store_key = ?",
          )
          .run(st.mtimeMs, st.size, this.storeKey);
        superseded = true;
      }
    });

    this.legacySourceMtimeMs = st.mtimeMs;
    this.legacySourceSize = st.size;
    if (reconciled) {
      this.cachedValue = null;
      this.cachedRevision = -1;
      this.cachedUpdatedAt = "";
      log.info("state_db_reconciled_legacy_update", {
        storeKey: this.storeKey,
        sourcePath,
        dbPath: this.dbPath,
      });
    } else if (superseded) {
      log.debug("state_db_legacy_update_superseded", {
        storeKey: this.storeKey,
        sourcePath,
      });
    }
  }

  /** One-time idempotent lossless migration from legacy `.jsonl` / `.json` files,
   *  plus mixed-version post-migration reconciliation if an older process appends later. */
  private ensureMigrated(): void {
    if (this.legacyFiles.length === 0) return;
    const entry = getOrOpenStateDb(this.dbPath);
    if (entry.migratedKeys.has(this.storeKey)) {
      this.reconcilePostMigrationLegacy(entry);
      return;
    }
    if (entry.migrationFailedKeys.has(this.storeKey)) {
      return;
    }

    const db = entry.db;
    const hasState = db
      .prepare("SELECT 1 FROM kv_state WHERE store_key = ?")
      .get(this.storeKey);
    if (hasState) {
      entry.migratedKeys.add(this.storeKey);
      this.reconcilePostMigrationLegacy(entry);
      return;
    }
    const alreadyMigrated = db
      .prepare("SELECT 1 FROM migrated_stores WHERE store_key = ?")
      .get(this.storeKey);
    if (alreadyMigrated) {
      entry.migratedKeys.add(this.storeKey);
      this.reconcilePostMigrationLegacy(entry);
      return;
    }

    const existingLegacy = this.legacyFiles.filter((p) => existsSync(p));
    if (existingLegacy.length === 0) return;

    let migratedSource: string | null = null;
    let migratedMtimeMs = 0;
    let migratedSize = 0;
    let sawCorrupt = false;
    let sawReadError = false;
    withTransaction(this.dbPath, (txDb) => {
      // Re-check inside BEGIN IMMEDIATE — a concurrent process may have migrated first.
      if (
        txDb.prepare("SELECT 1 FROM kv_state WHERE store_key = ?").get(this.storeKey) ||
        txDb.prepare("SELECT 1 FROM migrated_stores WHERE store_key = ?").get(this.storeKey)
      ) {
        return;
      }

      for (const legacyPath of existingLegacy) {
        let raw: string;
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(legacyPath);
          raw = readFileSync(legacyPath, "utf-8");
        } catch (err) {
          sawReadError = true;
          log.warn("state_db_legacy_read_failed", {
            storeKey: this.storeKey,
            sourcePath: legacyPath,
          }, err);
          continue;
        }
        if (!raw.trim()) continue;
        const parsed = parseLastValidLine<T>(raw);
        if (parsed === null) {
          sawCorrupt = true;
          log.warn("state_db_legacy_parse_failed", {
            storeKey: this.storeKey,
            sourcePath: legacyPath,
          });
          continue;
        }
        const now = new Date(Math.max(Date.now(), Math.ceil(st.mtimeMs))).toISOString();
        txDb
          .prepare(
            "INSERT INTO kv_state (store_key, payload, revision, updated_at) VALUES (?, ?, 1, ?)",
          )
          .run(this.storeKey, JSON.stringify(parsed), now);
        txDb
          .prepare(
            "INSERT INTO migrated_stores (store_key, source_path, migrated_at, source_mtime_ms, source_size) VALUES (?, ?, ?, ?, ?)",
          )
          .run(this.storeKey, legacyPath, now, st.mtimeMs, st.size);
        migratedSource = legacyPath;
        migratedMtimeMs = st.mtimeMs;
        migratedSize = st.size;
        break;
      }
    });

    if (migratedSource) {
      entry.migratedKeys.add(this.storeKey);
      this.legacySourcePath = migratedSource;
      this.legacySourceMtimeMs = migratedMtimeMs;
      this.legacySourceSize = migratedSize;
      log.info("state_db_migrated_legacy", {
        storeKey: this.storeKey,
        sourcePath: migratedSource,
        dbPath: this.dbPath,
      });
    } else if (sawCorrupt && !sawReadError) {
      // Every existing candidate was read cleanly and none held valid state —
      // avoid re-reading corrupt files on every access. Transient read errors
      // leave migration retryable on the next access.
      entry.migrationFailedKeys.add(this.storeKey);
    } else {
      // Re-check if a concurrent process beat us inside the transaction.
      if (
        db.prepare("SELECT 1 FROM kv_state WHERE store_key = ?").get(this.storeKey) ||
        db.prepare("SELECT 1 FROM migrated_stores WHERE store_key = ?").get(this.storeKey)
      ) {
        entry.migratedKeys.add(this.storeKey);
        this.reconcilePostMigrationLegacy(entry);
      }
    }
  }

  /** Monotonic revision counter stored in SQLite (`0` when no row exists).
   *  Reflects both in-process and cross-process writes immediately under WAL. */
  getRevision(): number {
    this.ensureMigrated();
    const db = openStateDb(this.dbPath);
    const row = db
      .prepare("SELECT revision FROM kv_state WHERE store_key = ?")
      .get(this.storeKey) as { revision?: number } | undefined;
    return typeof row?.revision === "number" ? row.revision : 0;
  }

  /** True when a persisted row exists for this store key. */
  exists(): boolean {
    this.ensureMigrated();
    const db = openStateDb(this.dbPath);
    const row = db
      .prepare("SELECT 1 FROM kv_state WHERE store_key = ?")
      .get(this.storeKey);
    return row !== undefined;
  }

  private readInternal(throwOnCorrupt: boolean): T | null {
    this.ensureMigrated();
    const db = openStateDb(this.dbPath);
    const meta = db
      .prepare("SELECT revision, updated_at FROM kv_state WHERE store_key = ?")
      .get(this.storeKey) as { revision?: number; updated_at?: string } | undefined;

    if (!meta || typeof meta.revision !== "number") {
      this.cachedValue = null;
      this.cachedRevision = -1;
      this.cachedUpdatedAt = "";
      return null;
    }

    if (
      this.cachedValue !== null &&
      meta.revision === this.cachedRevision &&
      meta.updated_at === this.cachedUpdatedAt
    ) {
      return this.cachedValue;
    }

    const row = db
      .prepare("SELECT payload, revision, updated_at FROM kv_state WHERE store_key = ?")
      .get(this.storeKey) as
      | { payload?: string; revision?: number; updated_at?: string }
      | undefined;
    if (!row) {
      this.cachedValue = null;
      this.cachedRevision = -1;
      this.cachedUpdatedAt = "";
      return null;
    }
    if (typeof row.payload !== "string" || typeof row.revision !== "number") {
      this.cachedValue = null;
      this.cachedRevision = -1;
      this.cachedUpdatedAt = "";
      const err = new Error(`Corrupt kv_state row for ${this.storeKey}: non-string payload`);
      log.error("state_db_corrupt_payload", { storeKey: this.storeKey, dbPath: this.dbPath }, err);
      if (throwOnCorrupt) throw err;
      return null;
    }

    try {
      const parsed = JSON.parse(row.payload) as T;
      this.cachedValue = parsed;
      this.cachedRevision = row.revision;
      this.cachedUpdatedAt = row.updated_at ?? "";
      return parsed;
    } catch (err) {
      log.error("state_db_corrupt_payload", { storeKey: this.storeKey, dbPath: this.dbPath }, err);
      this.cachedValue = null;
      this.cachedRevision = -1;
      this.cachedUpdatedAt = "";
      if (throwOnCorrupt) throw err;
      return null;
    }
  }

  /** Read the latest state, cached in memory by `(revision, updated_at)`.
   *  Returns `null` when no row exists or the stored payload is corrupt JSON. */
  read(): T | null {
    return this.readInternal(false);
  }

  /** Strict read: returns `null` ONLY when no row exists; throws if an existing
   *  row contains malformed JSON (so security gates can fail closed). */
  readStrict(): T | null {
    return this.readInternal(true);
  }

  /** Atomically write a full state snapshot and bump the DB revision. */
  write(state: T): void {
    const payload = JSON.stringify(state);
    const now = new Date().toISOString();
    const saved = withTransaction(this.dbPath, (db) => {
      db.prepare(
        `INSERT INTO kv_state (store_key, payload, revision, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(store_key) DO UPDATE SET
           payload = excluded.payload,
           revision = kv_state.revision + 1,
           updated_at = excluded.updated_at`,
      ).run(this.storeKey, payload, now);
      const meta = db
        .prepare("SELECT revision, updated_at FROM kv_state WHERE store_key = ?")
        .get(this.storeKey) as { revision: number; updated_at: string };
      return meta;
    });

    this.cachedValue = state;
    this.cachedRevision = saved.revision;
    this.cachedUpdatedAt = saved.updated_at;
    markStoreMigratedInCache(this.dbPath, this.storeKey);
  }

  /**
   * Atomic read-modify-write inside `BEGIN IMMEDIATE ... COMMIT`.
   *
   * - Re-reads latest state from SQLite inside the write lock.
   * - Returning `SKIP_MUTATE` skips writing and leaves `revision` unchanged.
   * - If empty and `initial` is provided, clones `initial` to seed the mutator.
   * - If empty and `initial` is omitted, returns `null` without writing.
   */
  mutate(fn: (state: T) => T | void | typeof SKIP_MUTATE, initial?: T): T | null {
    this.ensureMigrated();
    const outcome = withTransaction(this.dbPath, (db) => {
      const row = db
        .prepare("SELECT payload, revision, updated_at FROM kv_state WHERE store_key = ?")
        .get(this.storeKey) as
        | { payload?: string; revision?: number; updated_at?: string }
        | undefined;

      let current: T | null = null;
      let existingRev = -1;
      let existingUpdatedAt = "";
      if (row && typeof row.payload === "string") {
        try {
          current = JSON.parse(row.payload) as T;
          existingRev = typeof row.revision === "number" ? row.revision : 1;
          existingUpdatedAt = row.updated_at ?? "";
        } catch (err) {
          log.warn("state_db_mutate_corrupt_payload", { storeKey: this.storeKey }, err);
          current = null;
        }
      }

      if (current === null) {
        if (initial === undefined) {
          return { changed: false as const, state: null, revision: -1, updatedAt: "" };
        }
        const seeded = JSON.parse(JSON.stringify(initial)) as T;
        const out = fn(seeded);
        if (out === SKIP_MUTATE) {
          return { changed: false as const, state: null, revision: -1, updatedAt: "" };
        }
        const next = out === undefined ? seeded : out;
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO kv_state (store_key, payload, revision, updated_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(store_key) DO UPDATE SET
             payload = excluded.payload,
             revision = kv_state.revision + 1,
             updated_at = excluded.updated_at`,
        ).run(this.storeKey, JSON.stringify(next), now);
        const meta = db
          .prepare("SELECT revision, updated_at FROM kv_state WHERE store_key = ?")
          .get(this.storeKey) as { revision: number; updated_at: string };
        return {
          changed: true as const,
          state: next,
          revision: meta.revision,
          updatedAt: meta.updated_at,
        };
      }

      const out = fn(current);
      if (out === SKIP_MUTATE) {
        return {
          changed: false as const,
          state: current,
          revision: existingRev,
          updatedAt: existingUpdatedAt,
        };
      }

      const next = out === undefined ? current : out;
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE kv_state
         SET payload = ?, revision = revision + 1, updated_at = ?
         WHERE store_key = ?`,
      ).run(JSON.stringify(next), now, this.storeKey);
      const meta = db
        .prepare("SELECT revision, updated_at FROM kv_state WHERE store_key = ?")
        .get(this.storeKey) as { revision: number; updated_at: string };
      return {
        changed: true as const,
        state: next,
        revision: meta.revision,
        updatedAt: meta.updated_at,
      };
    });

    if (outcome.changed) {
      this.cachedValue = outcome.state;
      this.cachedRevision = outcome.revision;
      this.cachedUpdatedAt = outcome.updatedAt;
      markStoreMigratedInCache(this.dbPath, this.storeKey);
      return outcome.state;
    }

    if (outcome.state === null) {
      this.cachedValue = null;
      this.cachedRevision = -1;
      this.cachedUpdatedAt = "";
      return null;
    }

    // Preserve cached reference identity if DB row did not change.
    if (
      this.cachedValue !== null &&
      this.cachedRevision === outcome.revision &&
      this.cachedUpdatedAt === outcome.updatedAt
    ) {
      return this.cachedValue;
    }
    this.cachedValue = outcome.state;
    this.cachedRevision = outcome.revision;
    this.cachedUpdatedAt = outcome.updatedAt;
    return outcome.state;
  }

  /** Atomically remove this store's row from `kv_state`. */
  delete(): boolean {
    const deleted = withTransaction(this.dbPath, (db) => {
      const info = db
        .prepare("DELETE FROM kv_state WHERE store_key = ?")
        .run(this.storeKey);
      return Number(info.changes ?? 0) > 0;
    });
    this.cachedValue = null;
    this.cachedRevision = -1;
    this.cachedUpdatedAt = "";
    return deleted;
  }
}

/** Return a cached `SqliteStateStore<T>` for `(dbPath, storeKey)`. */
export function createSqliteStateStore<T>(
  dbPath: string,
  storeKey: string,
  options?: SqliteStateStoreOptions,
): SqliteStateStore<T> {
  const absPath = resolve(dbPath);
  const cacheKey = `${absPath}\0${storeKey}`;
  let store = kvStoreCache.get(cacheKey) as SqliteStateStore<T> | undefined;
  if (!store) {
    store = new SqliteStateStore<T>(absPath, storeKey, options);
    kvStoreCache.set(cacheKey, store);
  }
  return store;
}
