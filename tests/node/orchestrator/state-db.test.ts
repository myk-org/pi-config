/**
 * Tests for shared SQLite WAL state persistence (extensions/orchestrator/state-db.ts)
 * and the 5 migrated stores (issue #1399).
 *
 * Run with: npx tsx --test tests/node/orchestrator/state-db.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  blobToFloat32Array,
  closeStateDb,
  closeStateDbs,
  createSqliteStateStore,
  CURRENT_SCHEMA_VERSION,
  decodeFloat32Blob,
  encodeFloat32Blob,
  getProjectStateDbPath,
  getWorktreeStateDbPath,
  openStateDb,
  SKIP_MUTATE,
  STATE_DB_BUSY_TIMEOUT_MS,
  withTransaction,
} from "../../../extensions/orchestrator/state-db.js";
import {
  entryHash,
  getScoresRevision,
  loadScores,
  mutateScores,
  saveScores,
  type ScoredEntry,
} from "../../../extensions/orchestrator/memory-scoring.js";
import {
  EMBEDDING_POOLING,
  embedMissing,
  pruneEmbeddings,
  removeEmbedding,
  vectorSearch,
} from "../../../extensions/orchestrator/memory-embeddings.js";
import {
  getProvenancePendingPath,
  mergeProvenancePending,
  writeProvenancePending,
} from "../../../extensions/orchestrator/memory-provenance.js";
import {
  indexSessionSummary,
  searchSessions,
} from "../../../extensions/orchestrator/session-search.js";
import {
  addReviewerPending,
  isCommitAllowed,
  isReviewClean,
  markNeedsReview,
  markTestsPassed,
  readReviewState,
  recordReviewerResult,
  statePath,
} from "../../../extensions/orchestrator/pi-config-review-state.js";
import { evaluateBashPolicy } from "../../../extensions/orchestrator/bash-policy.js";
import { discoverAgents } from "../../../extensions/orchestrator/agents.js";
import { buildSubagentChildSpec } from "../../../extensions/orchestrator/subagent-child-spec.js";
import { registerMemoryTools } from "../../../extensions/orchestrator/memory-tools.js";
import { clearSettingsCache } from "../../../extensions/orchestrator/project-settings.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const cleanupDirs: string[] = [];

function trackTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  closeStateDbs();
  clearSettingsCache();
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Schema, Pragmas & Handle Lifecycle ─────────────────────────────────────

describe("state-db: schema init, WAL pragmas, and handle lifecycle", () => {
  it("initializes schema_version and configures WAL, NORMAL sync, and 5000ms busy_timeout", () => {
    const dir = trackTempDir("state-db-pragmas-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const db = openStateDb(dbPath);

    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    const version = db
      .prepare("SELECT MAX(version) AS v FROM schema_version")
      .get() as { v: number };

    assert.equal(journal.journal_mode.toLowerCase(), "wal");
    assert.equal(sync.synchronous, 1); // NORMAL = 1
    assert.equal(busy.timeout, STATE_DB_BUSY_TIMEOUT_MS);
    assert.equal(version.v, CURRENT_SCHEMA_VERSION);
  });

  it("caches handles per path and reopens after closeStateDb / closeStateDbs", () => {
    const dir = trackTempDir("state-db-cache-");
    const dbPath = join(dir, ".pi", "data", "state.db");

    const db1 = openStateDb(dbPath);
    const db2 = openStateDb(dbPath);
    assert.strictEqual(db1, db2);

    closeStateDb(dbPath);
    const db3 = openStateDb(dbPath);
    assert.notStrictEqual(db1, db3);

    closeStateDbs();
    const db4 = openStateDb(dbPath);
    assert.notStrictEqual(db3, db4);
  });

  it("returns null on read after the underlying db file is unlinked externally", () => {
    const dir = trackTempDir("state-db-reopen-read-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const store = createSqliteStateStore<{ v: number }>(dbPath, "test-key");
    store.write({ v: 1 });
    assert.deepEqual(store.read(), { v: 1 });

    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p)) unlinkSync(p);
    }

    assert.equal(store.read(), null);
  });

  it("persists new writes cleanly after the db file is unlinked and recreated", () => {
    const dir = trackTempDir("state-db-reopen-write-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const store = createSqliteStateStore<{ v: number }>(dbPath, "test-key");
    store.write({ v: 1 });

    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p)) unlinkSync(p);
    }

    store.write({ v: 2 });
    assert.deepEqual(store.read(), { v: 2 });
  });

  it("supports nested re-entrant transactions via SAVEPOINT with isolated rollback", () => {
    const dir = trackTempDir("state-db-nested-tx-");
    const dbPath = join(dir, ".pi", "data", "state.db");

    withTransaction(dbPath, (db) => {
      db.prepare(
        "INSERT INTO kv_state (store_key, payload, revision, updated_at) VALUES (?, ?, 1, ?)",
      ).run("outer", JSON.stringify({ ok: true }), new Date().toISOString());

      assert.throws(() => {
        withTransaction(dbPath, (innerDb) => {
          innerDb
            .prepare(
              "INSERT INTO kv_state (store_key, payload, revision, updated_at) VALUES (?, ?, 1, ?)",
            )
            .run("inner-fail", JSON.stringify({ ok: false }), new Date().toISOString());
          throw new Error("boom");
        });
      }, /boom/);
    });

    const db = openStateDb(dbPath);
    assert.ok(db.prepare("SELECT 1 FROM kv_state WHERE store_key = 'outer'").get());
    assert.equal(db.prepare("SELECT 1 FROM kv_state WHERE store_key = 'inner-fail'").get(), undefined);
  });

  it("upgrades a legacy v1 state.db to schema v2 without losing migrated_stores rows", () => {
    const cwd = trackTempDir("state-db-v1-upgrade-");
    const dbPath = getProjectStateDbPath(cwd);
    const legacyPath = join(cwd, ".pi", "memory", "memory-scores.jsonl");
    mkdirSync(dirname(dbPath), { recursive: true });

    const hash = entryHash("- [lesson] Preserve v1 rows on schema v2 upgrade");
    const existingEntry: ScoredEntry = {
      class: "lesson",
      score: 2.5,
      evidenceCount: 3,
      cue: "explicit",
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastReinforced: "2026-01-02T00:00:00.000Z",
      userState: "pinned",
      lifecycle: "active",
    };
    const existingPayload = {
      entries: { [hash]: existingEntry },
      lastRebuild: "2026-01-02T00:00:00.000Z",
      hashAlgo: "sha256-16",
    };

    // Build a real legacy v1 state.db whose migrated_stores has only (store_key, source_path, migrated_at)
    const v1Db = new DatabaseSync(dbPath);
    try {
      v1Db.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE kv_state (
          store_key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE migrated_stores (
          store_key TEXT PRIMARY KEY,
          source_path TEXT NOT NULL,
          migrated_at TEXT NOT NULL
        );
        CREATE TABLE embedding_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          model TEXT NOT NULL,
          dim INTEGER NOT NULL,
          pooling TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE embeddings (
          entry_key TEXT PRIMARY KEY,
          vector BLOB NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      v1Db
        .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(1, "2026-01-01T00:00:00.000Z");
      v1Db
        .prepare("INSERT INTO kv_state (store_key, payload, revision, updated_at) VALUES (?, ?, ?, ?)")
        .run("memory-scoring", JSON.stringify(existingPayload), 2, "2026-01-02T00:00:00.000Z");
      v1Db
        .prepare("INSERT INTO migrated_stores (store_key, source_path, migrated_at) VALUES (?, ?, ?)")
        .run("memory-scoring", legacyPath, "2026-01-01T00:00:00.000Z");
    } finally {
      v1Db.close();
    }

    // Opening and mutating via SqliteStateStore / loadScores / mutateScores must upgrade to v2 cleanly
    const loaded = loadScores(cwd);
    assert.equal(loaded.entries[hash]?.evidenceCount, 3);
    assert.equal(loaded.entries[hash]?.userState, "pinned");

    mutateScores(cwd, (s) => {
      s.entries[hash]!.evidenceCount = 4;
    });

    const db = openStateDb(dbPath);
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    assert.equal(version.v, CURRENT_SCHEMA_VERSION);
    assert.equal(version.v, 3);
    const approvalsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'restricted_folder_approvals'")
      .get() as { name?: string } | undefined;
    assert.equal(approvalsTable?.name, "restricted_folder_approvals");

    const migRow = db
      .prepare(
        "SELECT store_key, source_path, migrated_at, source_mtime_ms, source_size FROM migrated_stores WHERE store_key = ?",
      )
      .get("memory-scoring") as {
      store_key: string;
      source_path: string;
      migrated_at: string;
      source_mtime_ms: number;
      source_size: number;
    };
    assert.deepEqual(
      { ...migRow },
      {
        store_key: "memory-scoring",
        source_path: legacyPath,
        migrated_at: "2026-01-01T00:00:00.000Z",
        source_mtime_ms: 0,
        source_size: 0,
      },
    );
    assert.equal(loadScores(cwd).entries[hash]?.evidenceCount, 4);
  });
});

// ── Atomic mutate / SKIP_MUTATE & Revision Caching ─────────────────────────

describe("state-db: SqliteStateStore mutate, SKIP_MUTATE, and revision semantics", () => {
  it("preserves SKIP_MUTATE without bumping revision and clones initial without side effects", () => {
    const dir = trackTempDir("state-db-mutate-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const store = createSqliteStateStore<{ count: number; items: string[] }>(dbPath, "counter");

    const initial = { count: 0, items: ["seed"] };
    assert.equal(store.mutate(() => SKIP_MUTATE, initial), null);
    assert.equal(store.exists(), false);
    assert.equal(store.getRevision(), 0);

    const created = store.mutate((s) => {
      s.count += 1;
      s.items.push("first");
    }, initial);
    assert.deepEqual(created, { count: 1, items: ["seed", "first"] });
    assert.deepEqual(initial, { count: 0, items: ["seed"] }, "caller initial must not be mutated");
    assert.equal(store.getRevision(), 1);

    const refBefore = store.read();
    const skipped = store.mutate(() => SKIP_MUTATE);
    assert.equal(store.getRevision(), 1, "SKIP_MUTATE must not bump revision");
    assert.strictEqual(skipped, refBefore, "unchanged read preserves cached reference identity");

    store.mutate((s) => {
      s.count += 5;
    });
    assert.equal(store.getRevision(), 2);
    assert.deepEqual(store.read(), { count: 6, items: ["seed", "first"] });
  });

  it("re-reads fresh data when another handle updates the same row", () => {
    const dir = trackTempDir("state-db-cross-handle-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const store = createSqliteStateStore<{ msg: string }>(dbPath, "shared");
    store.write({ msg: "v1" });
    assert.deepEqual(store.read(), { msg: "v1" });

    // Independent SQLite handle simulates another process writing under WAL
    const external = new DatabaseSync(dbPath, { timeout: 5000 });
    try {
      external.exec("BEGIN IMMEDIATE");
      external
        .prepare(
          "UPDATE kv_state SET payload = ?, revision = revision + 1, updated_at = ? WHERE store_key = ?",
        )
        .run(JSON.stringify({ msg: "v2-from-peer" }), new Date().toISOString(), "shared");
      external.exec("COMMIT");
    } finally {
      external.close();
    }

    assert.deepEqual(store.read(), { msg: "v2-from-peer" });
    assert.equal(store.getRevision(), 2);
  });

  it("retries fallback migration after a transient read error even when another candidate is corrupt", () => {
    if (process.getuid?.() === 0) return; // root ignores chmod 0o000
    const dir = trackTempDir("state-db-transient-fallback-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const corruptJsonl = join(dir, "legacy.jsonl");
    const validJson = join(dir, "legacy.json");

    writeFileSync(corruptJsonl, "{not valid json\n", "utf-8");
    writeFileSync(validJson, JSON.stringify({ ok: 42 }), "utf-8");
    chmodSync(validJson, 0o000);

    try {
      const store = createSqliteStateStore<{ ok: number }>(dbPath, "transient-test", {
        legacyFiles: [corruptJsonl, validJson],
      });
      // First read sees corrupt .jsonl + unreadable .json -> must NOT permanently suppress retry
      assert.equal(store.read(), null);

      chmodSync(validJson, 0o600);
      assert.deepEqual(store.read(), { ok: 42 });
    } finally {
      try {
        chmodSync(validJson, 0o600);
      } catch {
        /* ignore */
      }
    }
  });

  it("reconciles newer post-migration legacy JSONL updates from pre-upgrade processes without clobbering newer SQLite writes", () => {
    const dir = trackTempDir("state-db-mixed-version-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const legacyPath = join(dir, "legacy.jsonl");

    // Initial legacy state imported into SQLite
    writeFileSync(legacyPath, JSON.stringify({ step: 1 }) + "\n", "utf-8");
    const t0 = new Date(Date.now() - 5000);
    utimesSync(legacyPath, t0, t0);

    const store = createSqliteStateStore<{ step: number }>(dbPath, "mixed-ver", {
      legacyFiles: [legacyPath],
    });
    assert.deepEqual(store.read(), { step: 1 });

    // Simulate an older still-running process appending to legacy.jsonl AFTER migration
    writeFileSync(
      legacyPath,
      JSON.stringify({ step: 1 }) + "\n" + JSON.stringify({ step: 2 }) + "\n",
      "utf-8",
    );
    const tFuture = new Date(Date.now() + 5000);
    utimesSync(legacyPath, tFuture, tFuture);
    assert.deepEqual(store.read(), { step: 2 }, "newer legacy write must be reconciled");

    // Now write a newer value in SQLite, then write an older-timestamped update to legacy
    store.write({ step: 3 });
    writeFileSync(
      legacyPath,
      JSON.stringify({ step: 1 }) + "\n" + JSON.stringify({ step: 2 }) + "\n" + JSON.stringify({ step: 99 }) + "\n",
      "utf-8",
    );
    const tOlder = new Date(Date.now() - 2000);
    utimesSync(legacyPath, tOlder, tOlder);
    assert.deepEqual(store.read(), { step: 3 }, "older legacy write must not overwrite newer SQLite state");
  });

  it("reconciles successor JSONL updates after initial migration from legacy JSON fallback", () => {
    const dir = trackTempDir("state-db-json-to-jsonl-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const legacyJsonl = join(dir, "legacy.jsonl");
    const legacyJson = join(dir, "legacy.json");

    // Initial migration imports from .json fallback
    writeFileSync(legacyJson, JSON.stringify({ step: 1 }), "utf-8");
    const t0 = new Date(Date.now() - 5000);
    utimesSync(legacyJson, t0, t0);

    const store = createSqliteStateStore<{ step: number }>(dbPath, "json-successor", {
      legacyFiles: [legacyJsonl, legacyJson],
    });
    assert.deepEqual(store.read(), { step: 1 });

    // Pre-upgrade process converts .json -> .jsonl, deletes .json, and appends newer state
    unlinkSync(legacyJson);
    writeFileSync(
      legacyJsonl,
      JSON.stringify({ step: 1 }) + "\n" + JSON.stringify({ step: 2 }) + "\n",
      "utf-8",
    );
    const t1 = new Date(Date.now() + 5000);
    utimesSync(legacyJsonl, t1, t1);
    assert.deepEqual(store.read(), { step: 2 });

    // Subsequent append to the successor .jsonl is also reconciled
    writeFileSync(
      legacyJsonl,
      JSON.stringify({ step: 1 }) + "\n" + JSON.stringify({ step: 2 }) + "\n" + JSON.stringify({ step: 3 }) + "\n",
      "utf-8",
    );
    const t2 = new Date(Date.now() + 8000);
    utimesSync(legacyJsonl, t2, t2);
    assert.deepEqual(store.read(), { step: 3 });
  });

  it("keeps reconciling valid JSON updates when a newly appearing JSONL successor is malformed", () => {
    const dir = trackTempDir("state-db-corrupt-successor-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const legacyJsonl = join(dir, "legacy.jsonl");
    const legacyJson = join(dir, "legacy.json");

    writeFileSync(legacyJson, JSON.stringify({ step: 1 }), "utf-8");
    const t0 = new Date(Date.now() - 5000);
    utimesSync(legacyJson, t0, t0);

    const store = createSqliteStateStore<{ step: number }>(dbPath, "corrupt-succ", {
      legacyFiles: [legacyJsonl, legacyJson],
    });
    assert.deepEqual(store.read(), { step: 1 });

    // Malformed .jsonl appears while .json advances to step 2
    writeFileSync(legacyJsonl, "{truncated-corrupt\n", "utf-8");
    writeFileSync(legacyJson, JSON.stringify({ step: 2 }), "utf-8");
    const t1 = new Date(Date.now() + 5000);
    utimesSync(legacyJson, t1, t1);
    assert.deepEqual(store.read(), { step: 2 }, "malformed successor must not hide valid .json updates");

    // Once .jsonl becomes valid with step 3, it reconciles cleanly
    writeFileSync(legacyJsonl, JSON.stringify({ step: 3 }) + "\n", "utf-8");
    const t2 = new Date(Date.now() + 8000);
    utimesSync(legacyJsonl, t2, t2);
    assert.deepEqual(store.read(), { step: 3 });
  });

  it("reconciles a valid JSONL successor whose mtime equals the SQLite row timestamp", () => {
    const dir = trackTempDir("state-db-equal-mtime-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const legacyJsonl = join(dir, "legacy.jsonl");
    const legacyJson = join(dir, "legacy.json");

    writeFileSync(legacyJson, JSON.stringify({ step: 1 }), "utf-8");
    const store = createSqliteStateStore<{ step: number }>(dbPath, "equal-ts", {
      legacyFiles: [legacyJsonl, legacyJson],
    });
    assert.deepEqual(store.read(), { step: 1 });

    // Read the exact SQLite row timestamp and set the new .jsonl successor to that exact mtime
    const db = openStateDb(dbPath);
    const row = db
      .prepare("SELECT updated_at FROM kv_state WHERE store_key = 'equal-ts'")
      .get() as { updated_at: string };
    const exactMs = Date.parse(row.updated_at);

    writeFileSync(legacyJsonl, JSON.stringify({ step: 2 }) + "\n", "utf-8");
    utimesSync(legacyJsonl, exactMs / 1000, exactMs / 1000);
    assert.deepEqual(store.read(), { step: 2 }, "equal-timestamp valid successor must be imported");
  });

  it("does not overwrite a post-import SQLite mutation with an equal-timestamp differing legacy successor", () => {
    const dir = trackTempDir("state-db-equal-mtime-rev2-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const legacyJsonl = join(dir, "legacy.jsonl");
    const legacyJson = join(dir, "legacy.json");

    writeFileSync(legacyJson, JSON.stringify({ step: 1 }), "utf-8");
    const store = createSqliteStateStore<{ step: number }>(dbPath, "equal-ts-rev2", {
      legacyFiles: [legacyJsonl, legacyJson],
    });
    assert.deepEqual(store.read(), { step: 1 });

    // Advance SQLite beyond initial import (revision becomes 2)
    store.write({ step: 10 });
    assert.equal(store.getRevision(), 2);

    const db = openStateDb(dbPath);
    const row = db
      .prepare("SELECT updated_at FROM kv_state WHERE store_key = 'equal-ts-rev2'")
      .get() as { updated_at: string };
    const exactMs = Date.parse(row.updated_at);

    // Supply a differing legacy successor with the exact same mtime as the SQLite mutation
    writeFileSync(legacyJsonl, JSON.stringify({ step: 99 }) + "\n", "utf-8");
    utimesSync(legacyJsonl, exactMs / 1000, exactMs / 1000);
    assert.deepEqual(store.read(), { step: 10 }, "post-import SQLite revision must survive equal-mtime legacy successor");
  });
});

// ── Float32Array BLOB Encoding & Embeddings Migration ──────────────────────

describe("state-db: Float32Array BLOB round-trip and memory-embeddings resilience", () => {
  it("round-trips Float32 vectors accurately, including unaligned byteOffset slices", () => {
    const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.17) * 0.5);
    const blob = encodeFloat32Blob(vec);
    assert.equal(blob.byteLength, 384 * 4);

    // Compact vs JSON float array (~4x+ smaller)
    const jsonSize = Buffer.byteLength(JSON.stringify(vec), "utf-8");
    assert.ok(
      blob.byteLength * 3 < jsonSize,
      `expected BLOB (${blob.byteLength}B) to be much smaller than JSON (${jsonSize}B)`,
    );

    const decoded = decodeFloat32Blob(blob);
    assert.equal(decoded.length, vec.length);
    for (let i = 0; i < vec.length; i++) {
      assert.ok(Math.abs(decoded[i]! - vec[i]!) < 1e-6);
    }

    // Unaligned byteOffset = 1 round-trip
    const padded = new Uint8Array(blob.byteLength + 1);
    padded.set(blob, 1);
    const unaligned = padded.subarray(1);
    assert.equal(unaligned.byteOffset % 4, 1);
    const f32 = blobToFloat32Array(unaligned);
    assert.equal(f32.length, 384);
    assert.ok(Math.abs(f32[10]! - vec[10]!) < 1e-6);
  });

  it("migrates legacy embeddings.jsonl to Float32 BLOBs losslessly and idempotently without modifying legacy file", () => {
    const cwd = trackTempDir("state-db-emb-mig-");
    const memDir = join(cwd, ".pi", "memory");
    mkdirSync(memDir, { recursive: true });

    const key = (text: string) =>
      createHash("sha256").update(`[lesson] ${text}`).digest("hex").slice(0, 16);
    const k1 = key("keep-one");
    const k2 = key("drop-two");
    const v1 = [0.25, -0.5, 0.75, 1.0];
    const v2 = [0.1, 0.2, 0.3, 0.4];

    const legacyPath = join(memDir, "embeddings.jsonl");
    const legacyRaw =
      JSON.stringify({ model: "Xenova/bge-small-en-v1.5", dim: 384, pooling: EMBEDDING_POOLING, entries: { [k1]: [0, 0, 0, 0] } }) +
      "\n" +
      JSON.stringify({ model: "Xenova/bge-small-en-v1.5", dim: 384, pooling: EMBEDDING_POOLING, entries: { [k1]: v1, [k2]: v2 } }) +
      "\n{truncated-tail";
    writeFileSync(legacyPath, legacyRaw, "utf-8");

    const pruned = pruneEmbeddings(cwd, [{ text: "keep-one", category: "lesson" }]);
    assert.equal(pruned, 1);

    const db = openStateDb(getProjectStateDbPath(cwd));
    const row = db
      .prepare("SELECT vector FROM embeddings WHERE entry_key = ?")
      .get(k1) as { vector: Uint8Array } | undefined;
    assert.ok(row && row.vector instanceof Uint8Array);
    assert.equal(row.vector.byteLength, 16);
    const decoded = decodeFloat32Blob(row.vector);
    for (let i = 0; i < v1.length; i++) {
      assert.ok(Math.abs(decoded[i]! - v1[i]!) < 1e-6);
    }

    assert.equal(readFileSync(legacyPath, "utf-8"), legacyRaw);

    // Idempotency: closing handles and removing remaining key does NOT re-import legacy file
    closeStateDbs();
    removeEmbedding(cwd, "keep-one", "lesson");
    const remaining = openStateDb(getProjectStateDbPath(cwd))
      .prepare("SELECT COUNT(*) AS cnt FROM embeddings")
      .get() as { cnt: number };
    assert.equal(remaining.cnt, 0);
  });

  it("returns empty results from vectorSearch and -1 from embedMissing when state.db cannot be opened", async () => {
    const cwd = trackTempDir("state-db-emb-failsoft-");
    // Place a directory at state.db so DatabaseSync fails to open it
    mkdirSync(join(cwd, ".pi", "data", "state.db"), { recursive: true });

    const searchResult = await vectorSearch(cwd, "test query", [
      { text: "Rule A", category: "lesson", pinned: false },
    ]);
    assert.deepEqual(searchResult, []);

    const embedded = await embedMissing(cwd, [{ text: "Rule A", category: "lesson" }]);
    assert.equal(embedded, -1);
  });

  it("retries embedding migration in memory_search after a transient DB failure while keeping keyword fallback", async () => {
    const cwd = trackTempDir("state-db-emb-retry-");
    const topicsDir = join(cwd, ".pi", "memory", "topics");
    mkdirSync(topicsDir, { recursive: true });
    writeFileSync(join(topicsDir, "lessons.md"), "# Lessons\n\n- [lesson] Always keep WAL enabled\n", "utf-8");

    // Initialize state.db then drop `embeddings` table so embedMissing fails while loadScores succeeds
    const dbPath = getProjectStateDbPath(cwd);
    const db = openStateDb(dbPath);
    db.exec("DROP TABLE embeddings");

    const tools = new Map<string, any>();
    const fakePi = {
      registerTool(def: any) {
        tools.set(def.name, def);
      },
    } as any;
    registerMemoryTools(fakePi);
    const searchTool = tools.get("memory_search");
    assert.ok(searchTool);

    // First search: embedMissing fails (returns -1) -> embeddingsMigrated stays false, keyword fallback still works
    const first = await searchTool.execute("id-1", { query: "WAL enabled" }, undefined, undefined, { cwd });
    assert.match(first.content?.[0]?.text ?? "", /Always keep WAL enabled/);
    assert.equal(await embedMissing(cwd, [{ text: "Always keep WAL enabled", category: "lesson" }]), -1);

    // Restore embeddings table and run second search -> retry succeeds cleanly
    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        entry_key TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const second = await searchTool.execute("id-2", { query: "WAL enabled" }, undefined, undefined, { cwd });
    assert.match(second.content?.[0]?.text ?? "", /Always keep WAL enabled/);
  });
});

// ── Lossless Migration Across All 5 Stores ─────────────────────────────────

describe("state-db: lossless one-time legacy migration for all 5 stores", () => {
  const sampleEntry = (evidenceCount: number): ScoredEntry => ({
    class: "lesson",
    score: 3.14,
    evidenceCount,
    cue: "explicit",
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastReinforced: "2026-01-02T00:00:00.000Z",
    userState: "pinned",
    lifecycle: "active",
  });

  it("migrates memory-scoring from legacy memory-scores.jsonl losslessly and idempotently", () => {
    const cwd = trackTempDir("state-db-score-jsonl-");
    const memDir = join(cwd, ".pi", "memory");
    mkdirSync(memDir, { recursive: true });
    const hash = entryHash("- [lesson] Always run typecheck");

    const legacyJsonl = join(memDir, "memory-scores.jsonl");
    writeFileSync(
      legacyJsonl,
      JSON.stringify({ entries: { [hash]: sampleEntry(2) }, lastRebuild: "2026-01-01T00:00:00.000Z", hashAlgo: "sha256-16" }) +
        "\n" +
        JSON.stringify({ entries: { [hash]: sampleEntry(5) }, lastRebuild: "2026-01-02T00:00:00.000Z", hashAlgo: "sha256-16" }) +
        "\n",
    );

    const loaded = loadScores(cwd);
    assert.equal(loaded.entries[hash]?.evidenceCount, 5);
    assert.equal(getScoresRevision(cwd), 1);
    assert.ok(existsSync(legacyJsonl), "legacy file preserved untouched");

    mutateScores(cwd, (s) => {
      s.entries[hash]!.evidenceCount = 9;
    });
    closeStateDbs();
    assert.equal(loadScores(cwd).entries[hash]?.evidenceCount, 9);
  });

  it("falls back to legacy memory-scores.json when memory-scores.jsonl is absent", () => {
    const cwd = trackTempDir("state-db-score-json-");
    const memDir = join(cwd, ".pi", "memory");
    mkdirSync(memDir, { recursive: true });
    const hash = entryHash("- [lesson] Always run typecheck");

    const legacyJson = join(memDir, "memory-scores.json");
    writeFileSync(
      legacyJson,
      JSON.stringify({ entries: { [hash]: sampleEntry(4) }, lastRebuild: "2026-01-02T00:00:00.000Z", hashAlgo: "sha256-16" }),
    );

    const loaded = loadScores(cwd);
    assert.equal(loaded.entries[hash]?.evidenceCount, 4);
    assert.equal(loaded.entries[hash]?.userState, "pinned");
    assert.ok(existsSync(legacyJson), "legacy file preserved untouched");
  });

  it("migrates session-search from legacy .jsonl without losing entries", () => {
    const cwd = trackTempDir("state-db-sess-mig-");
    const dataDir = join(cwd, ".pi", "data");
    mkdirSync(dataDir, { recursive: true });
    const legacyPath = join(dataDir, "session-search.jsonl");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        entries: [
          {
            sessionId: "sess-legacy-1",
            timestamp: "2026-02-01T00:00:00.000Z",
            summary: "Consolidated SQLite WAL storage migration benchmark",
          },
        ],
      }) + "\n",
    );

    const found = searchSessions(cwd, "WAL storage migration", 5);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.sessionId, "sess-legacy-1");
    assert.ok(existsSync(legacyPath));

    indexSessionSummary(cwd, "sess-new-2", "Added Float32 BLOB vector tests");
    closeStateDbs();
    assert.equal(searchSessions(cwd, "Float32 BLOB", 5).length, 1);
    assert.equal(searchSessions(cwd, "WAL storage migration", 5).length, 1);
  });

  it("filters null and malformed entries during indexSessionSummary after migrating a dirty legacy snapshot", () => {
    const cwd = trackTempDir("state-db-sess-malformed-");
    const dataDir = join(cwd, ".pi", "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "session-search.jsonl"),
      JSON.stringify({
        entries: [
          null,
          { sessionId: 123, timestamp: "2026-02-01T00:00:00.000Z" },
          {
            sessionId: "valid-1",
            timestamp: "2026-02-01T00:00:00.000Z",
            summary: "Valid historical session entry before corruption",
          },
        ],
      }) + "\n",
    );

    // Must not throw on null/malformed entries when indexing a new summary
    indexSessionSummary(cwd, "valid-2", "Fresh summary indexed after malformed legacy migration");
    assert.equal(searchSessions(cwd, "Fresh summary indexed", 5).length, 1);
    assert.equal(searchSessions(cwd, "Valid historical session", 5).length, 1);
  });

  it("migrates pi-config-review-state from legacy .json losslessly", () => {
    const cwd = trackTempDir("state-db-rev-mig-");
    const dataDir = dirname(statePath(cwd));
    const legacyJson = join(dataDir, "pi-config-review-state.json");
    writeFileSync(
      legacyJson,
      JSON.stringify({
        status: "has_findings",
        cycle: 2,
        findings_count: 3,
        reviewers_pending: [],
        reviewers_total: 2,
        tests_passed: false,
      }),
    );

    const state = readReviewState(cwd);
    assert.equal(state.status, "has_findings");
    assert.equal(state.cycle, 2);
    assert.equal(state.findings_count, 3);
    assert.ok(existsSync(legacyJson));
  });

  it("merges combined SQLite-pending and dream JSONL sidecar provenance entries", () => {
    const cwd = trackTempDir("state-db-prov-both-");
    const topicsDir = join(cwd, ".pi", "memory", "topics");
    mkdirSync(topicsDir, { recursive: true });
    const t1 = "Rule one from db";
    const t2 = "Rule two from sidecar";
    writeFileSync(
      join(topicsDir, "lessons.md"),
      `# Lessons\n\n- [lesson] ${t1}\n- [lesson] ${t2}\n`,
    );
    const h1 = entryHash(`- [lesson] ${t1}`);
    const h2 = entryHash(`- [lesson] ${t2}`);
    const base: ScoredEntry = {
      class: "lesson",
      score: 1,
      evidenceCount: 1,
      cue: "explicit",
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastReinforced: "2026-01-01T00:00:00.000Z",
      userState: "auto",
      lifecycle: "active",
    };
    saveScores(cwd, {
      entries: { [h1]: { ...base }, [h2]: { ...base } },
      lastRebuild: "2026-01-01T00:00:00.000Z",
      hashAlgo: "sha256-16",
    });

    writeProvenancePending(cwd, [{ category: "lesson", text: t1, sourceSession: "db-src" }]);
    writeFileSync(
      getProvenancePendingPath(cwd),
      JSON.stringify({ entries: [{ category: "lesson", text: t2, sourceSession: "sidecar-src" }] }) + "\n",
    );

    const updated = mergeProvenancePending(cwd);
    assert.equal(updated, 2);
    assert.equal(existsSync(getProvenancePendingPath(cwd)), false);
    const scores = loadScores(cwd);
    assert.equal(scores.entries[h1]?.sourceSession, "db-src");
    assert.equal(scores.entries[h2]?.sourceSession, "sidecar-src");
  });
});

// ── Review-State Fail-Soft Reads, Fail-Closed Gate & Bash Enforcement ──────

describe("state-db: review-state resilience and bash commit-gate enforcement", () => {
  it("falls back to defaultState in readReviewState while failing closed in isCommitAllowed/isReviewClean when state.db is unreadable", () => {
    const cwd = trackTempDir("state-db-rev-failclosed-");
    // Corrupt state.db file (not a valid SQLite database)
    const dbPath = statePath(cwd);
    writeFileSync(dbPath, "NOT A VALID SQLITE DATABASE", "utf-8");

    const state = readReviewState(cwd);
    assert.equal(state.status, "none");
    assert.equal(isReviewClean(cwd), false, "isReviewClean must fail closed on corrupt state.db");
    assert.equal(isCommitAllowed(cwd), false, "isCommitAllowed must fail closed on corrupt state.db");
  });

  it("blocks bash commands modifying state.db via node:sqlite even without spelling pi-config-review-state literally", async () => {
    const cwd = trackTempDir("state-db-bash-guard-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ review_loop_enforcement: true }),
      "utf-8",
    );
    clearSettingsCache();

    // Dynamic key construction + node:sqlite against .pi/data/state.db
    const forgedCmd = `node -e 'import { DatabaseSync } from "node:sqlite"; const k = "pi-config-" + "review-state"; const db = new DatabaseSync(".pi/data/state.db"); db.prepare("UPDATE kv_state SET payload=? WHERE store_key=?").run("{\\"status\\":\\"clean\\",\\"tests_passed\\":true}", k);'`;
    const decision = await evaluateBashPolicy({
      command: forgedCmd,
      cwd,
      hasTimeout: false,
      inContainer: false,
      isSubagentChild: false,
      ui: null,
    });
    assert.equal(decision.action, "block");

    // Also blocks dynamic filename construction using node:sqlite on .pi/data
    const splitPathCmd = `node -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(".pi/data/" + "sta" + "te.db"); db.exec("DELETE FROM kv_state");'`;
    const decision2 = await evaluateBashPolicy({
      command: splitPathCmd,
      cwd,
      hasTimeout: false,
      inContainer: false,
      isSubagentChild: false,
      ui: null,
    });
    assert.equal(decision2.action, "block");

    // Also blocks WAL/SHM deletion
    const walCmd = "rm -f .pi/data/state.db-wal .pi/data/state.db-shm";
    const decision3 = await evaluateBashPolicy({
      command: walCmd,
      cwd,
      hasTimeout: false,
      inContainer: false,
      isSubagentChild: false,
      ui: null,
    });
    assert.equal(decision3.action, "block");

    // Also blocks redirect writes into .pi/data/state.db
    const redirectCmd = "echo corrupt > .pi/data/state.db";
    const decision4 = await evaluateBashPolicy({
      command: redirectCmd,
      cwd,
      hasTimeout: false,
      inContainer: false,
      isSubagentChild: false,
      ui: null,
    });
    assert.equal(decision4.action, "block");
  });

  it("fails closed in isCommitAllowed/isReviewClean when kv_state review payload is malformed JSON while readReviewState stays fail-soft", () => {
    const cwd = trackTempDir("state-db-rev-badjson-");
    const dbPath = statePath(cwd);
    const db = openStateDb(dbPath);
    db.prepare(
      "INSERT OR REPLACE INTO kv_state (store_key, payload, revision, updated_at) VALUES (?, ?, 1, ?)",
    ).run("pi-config-review-state", "{invalid-json", new Date().toISOString());

    assert.equal(readReviewState(cwd).status, "none");
    assert.equal(isReviewClean(cwd), false, "isReviewClean must fail closed on malformed JSON payload");
    assert.equal(isCommitAllowed(cwd), false, "isCommitAllowed must fail closed on malformed JSON payload");
  });

  it("fails closed in isCommitAllowed if a tracked worktree's state.db is wiped mid-session", () => {
    const cwd = trackTempDir("state-db-rev-wiped-");
    markNeedsReview(cwd);
    assert.equal(isCommitAllowed(cwd), false);

    // Simulate external deletion of state.db while review was active
    const dbPath = statePath(cwd);
    closeStateDbs();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p)) unlinkSync(p);
    }

    assert.equal(isReviewClean(cwd), false, "isReviewClean must fail closed when tracked DB is wiped");
    assert.equal(isCommitAllowed(cwd), false, "isCommitAllowed must fail closed when tracked DB is wiped");
  });

  it("fails closed in a fresh process after a tracked review row is deleted from state.db", () => {
    const cwd = trackTempDir("state-db-rev-wiped-fresh-proc-");
    markNeedsReview(cwd);
    assert.equal(isCommitAllowed(cwd), false);

    // Delete the review row directly from state.db
    const db = openStateDb(statePath(cwd));
    db.prepare("DELETE FROM kv_state WHERE store_key = 'pi-config-review-state'").run();
    closeStateDbs();

    // Check isCommitAllowed in a brand-new Node process with empty in-memory state
    const modulePath = join(import.meta.dirname, "../../../extensions/orchestrator/pi-config-review-state.ts");
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { isCommitAllowed, isReviewClean } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify({ commit: isCommitAllowed(process.argv[1]), clean: isReviewClean(process.argv[1]) }));`,
        cwd,
      ],
      { encoding: "utf-8" },
    ).trim();
    assert.deepEqual(JSON.parse(out), { commit: false, clean: false });
  });

  it("rejects commits when a cached clean review payload is corrupted without changing revision or updated_at", () => {
    const cwd = trackTempDir("state-db-rev-cached-corrupt-");
    markNeedsReview(cwd);
    addReviewerPending(cwd, "code-reviewer-quality", { kind: "local", head_sha: "abc1234" });
    recordReviewerResult(cwd, "code-reviewer-quality", 0);
    markTestsPassed(cwd);

    // Prime the in-memory read cache with the clean state
    assert.equal(readReviewState(cwd).status, "clean");
    assert.equal(isCommitAllowed(cwd), true);

    // Corrupt ONLY payload without touching revision or updated_at
    const db = openStateDb(statePath(cwd));
    db.prepare("UPDATE kv_state SET payload = '{corrupt' WHERE store_key = 'pi-config-review-state'").run();

    assert.equal(isReviewClean(cwd), false, "isReviewClean must not trust cached clean state when payload is corrupt");
    assert.equal(isCommitAllowed(cwd), false, "isCommitAllowed must not trust cached clean state when payload is corrupt");
  });

  it("unconditionally blocks nested shell deletion bash -c 'rm .pi/data/state.db' even when UI approves", async () => {
    const cwd = trackTempDir("state-db-bash-nested-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ review_loop_enforcement: true }),
      "utf-8",
    );
    clearSettingsCache();

    const approvingUi = {
      async select() {
        return "Yes, run it";
      },
      notify() {},
    };
    const decision = await evaluateBashPolicy({
      command: "bash -c 'rm .pi/data/state.db'",
      cwd,
      hasTimeout: false,
      inContainer: false,
      isSubagentChild: false,
      ui: approvingUi,
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason ?? "", /review state storage/i);
  });

  it("unconditionally blocks eval deletion of both state.db and review-tracked marker before approval", async () => {
    const cwd = trackTempDir("state-db-bash-eval-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ review_loop_enforcement: true }),
      "utf-8",
    );
    clearSettingsCache();

    const approvingUi = {
      async select() {
        return "Yes, run it";
      },
      notify() {},
    };
    const decision = await evaluateBashPolicy({
      command: "eval 'rm .pi/data/state.db .pi/run/review-tracked'",
      cwd,
      hasTimeout: false,
      inContainer: false,
      isSubagentChild: false,
      ui: approvingUi,
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason ?? "", /review state storage/i);
  });

  it("blocks deletion of state.db and review-tracked marker via shell variable indirection", async () => {
    const cwd = trackTempDir("state-db-bash-vars-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ review_loop_enforcement: true }),
      "utf-8",
    );
    clearSettingsCache();

    const cmd = 'db=.pi/data/state.db; marker=.pi/run/review-tracked; rm "$db" "$marker"';
    const decision = await evaluateBashPolicy({
      command: cmd,
      cwd,
      hasTimeout: false,
      inContainer: false,
      isSubagentChild: false,
      ui: null,
    });
    assert.equal(decision.action, "block");
    assert.match(decision.reason ?? "", /review state storage/i);
  });

  it("unconditionally blocks mutating commands using doubled separators or dot-segments targeting state.db and marker", async () => {
    const cwd = trackTempDir("state-db-bash-norm-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ review_loop_enforcement: true }),
      "utf-8",
    );
    clearSettingsCache();

    const approvingUi = {
      async select() {
        return "Yes, run it";
      },
      notify() {},
    };
    const commands = [
      "rm -f .pi/data//state.db .pi/data//state.db-wal .pi/data//state.db-shm .pi/run//review-tracked",
      "rm -f ./.pi/./data/../data/state.db ./.pi/./run/../run/review-tracked",
    ];
    for (const command of commands) {
      const decision = await evaluateBashPolicy({
        command,
        cwd,
        hasTimeout: false,
        inContainer: false,
        isSubagentChild: false,
        ui: approvingUi,
      });
      assert.equal(decision.action, "block", `expected normalized path command to be blocked: ${command}`);
      assert.match(decision.reason ?? "", /review state storage/i);
    }
  });

  it("fails closed when .pi/data is writable but .pi/run marker cannot be created", () => {
    if (process.getuid?.() === 0) return; // root ignores chmod 0o500
    const cwd = trackTempDir("state-db-marker-unwritable-");
    const runDir = join(cwd, ".pi", "run");
    mkdirSync(runDir, { recursive: true });
    chmodSync(runDir, 0o500);

    try {
      assert.throws(() => markNeedsReview(cwd));
      assert.equal(isCommitAllowed(cwd), false, "commit gate must fail closed when marker write failed");
      assert.equal(isReviewClean(cwd), false, "review clean check must fail closed when marker write failed");
    } finally {
      try {
        chmodSync(runDir, 0o700);
      } catch {
        /* ignore */
      }
    }
  });

  it("keeps durable review-tracked marker consistent with final persisted state under overlapping reset and markNeedsReview processes", async () => {
    const cwd = trackTempDir("state-db-marker-race-");
    markNeedsReview(cwd);
    const modulePath = join(import.meta.dirname, "../../../extensions/orchestrator/pi-config-review-state.ts");

    const runChild = (fnName: "resetReviewState" | "markNeedsReview") =>
      new Promise<void>((res, rej) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `import { ${fnName} } from ${JSON.stringify(modulePath)}; for (let i = 0; i < 8; i++) ${fnName}(process.argv[1]);`,
            cwd,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("exit", (code) => {
          if (code === 0) res();
          else rej(new Error(`${fnName} child exited ${code}: ${stderr}`));
        });
        child.on("error", rej);
      });

    await Promise.all([runChild("resetReviewState"), runChild("markNeedsReview")]);

    const finalState = readReviewState(cwd);
    const markerExists = existsSync(join(cwd, ".pi", "run", "review-tracked"));
    assert.equal(
      markerExists,
      finalState.status !== "none",
      `marker presence (${markerExists}) must match final persisted status (${finalState.status})`,
    );
  });

  it("allows ordinary file removals with trailing whitespace when not targeting protected review paths", async () => {
    const cwd = trackTempDir("state-db-bash-ordinary-rm-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ review_loop_enforcement: true }),
      "utf-8",
    );
    clearSettingsCache();

    for (const command of ["rm harmless ", "rm -f .pi/tmp/scratch.txt ", "rm -f .pi/data/reviews.db "]) {
      const decision = await evaluateBashPolicy({
        command,
        cwd,
        hasTimeout: false,
        inContainer: false,
        isSubagentChild: false,
        ui: null,
      });
      assert.notEqual(decision.action, "block", `expected ordinary command not to be blocked: ${command}`);
    }
  });

  it("blocks glob, brace-expansion, directory wipe, and adjacent-redirect attempts targeting .pi/data/state.db", async () => {
    const cwd = trackTempDir("state-db-bash-evasion-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ review_loop_enforcement: true }),
      "utf-8",
    );
    clearSettingsCache();

    const evasionCommands = [
      "rm .pi/data/state.d?",
      "rm .pi/data/state.*",
      "mv .pi/data/state.db{,.bak}",
      ":>.pi/data/state.db",
      "rm -rf .pi/data",
    ];
    for (const command of evasionCommands) {
      const decision = await evaluateBashPolicy({
        command,
        cwd,
        hasTimeout: false,
        inContainer: false,
        isSubagentChild: false,
        ui: null,
      });
      assert.equal(decision.action, "block", `expected evasion command to be blocked: ${command}`);
    }
  });

  it("allows inert mentions, read-only commands, unrelated state.db, and commit messages mentioning state.db", async () => {
    const cwd = trackTempDir("state-db-bash-allow-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pi-config-settings.json"),
      JSON.stringify({ review_loop_enforcement: true }),
      "utf-8",
    );
    clearSettingsCache();

    const allowedCommands = [
      "grep kv_state src/",
      "ls state.db",
      "ls .pi/data/state.db",
      'sqlite3 .pi/data/reviews.db "SELECT 1"',
    ];
    for (const command of allowedCommands) {
      const decision = await evaluateBashPolicy({
        command,
        cwd,
        hasTimeout: false,
        inContainer: false,
        isSubagentChild: false,
        ui: null,
      });
      assert.notEqual(decision.action, "block", `expected ${command} not to be blocked`);
    }

    // Commit message mentioning state.db must NOT be blocked by the review-state storage guard
    const commitDecision = await evaluateBashPolicy({
      command: 'git commit -m "feat: consolidate stores into state.db"',
      cwd,
      hasTimeout: false,
      inContainer: false,
      isSubagentChild: true,
      agentName: "git-expert",
      ui: null,
    });
    if (commitDecision.action === "block") {
      assert.doesNotMatch(commitDecision.reason ?? "", /review state storage/i);
    }
  });

  it("includes review_status in the spawned git-expert tool allowlist", () => {
    const repoRoot = join(import.meta.dirname, "../../..");
    const { agents } = discoverAgents(repoRoot, "both");
    const gitExpert = agents.find((a) => a.name === "git-expert");
    assert.ok(gitExpert, "git-expert agent definition must be discovered");
    assert.ok(
      gitExpert.tools?.includes("review_status"),
      "git-expert frontmatter tools must include review_status",
    );

    const spec = buildSubagentChildSpec({
      mode: "sync",
      agentName: "git-expert",
      agent: gitExpert,
      task: "Commit changes",
      cwd: repoRoot,
      persistSession: false,
    });
    const toolsIdx = spec.args.indexOf("--tools");
    assert.notEqual(toolsIdx, -1);
    const spawnedTools = (spec.args[toolsIdx + 1] ?? "").split(",");
    assert.ok(
      spawnedTools.includes("review_status"),
      `expected --tools to include review_status, got: ${spec.args[toolsIdx + 1]}`,
    );
  });
});

// ── Concurrent Multi-Handle & Multi-Process WAL Writes ─────────────────────

describe("state-db: concurrent multi-handle and multi-process WAL writes", () => {
  it("serializes concurrent multi-process writes without SQLITE_BUSY or lost updates", async () => {
    const dir = trackTempDir("state-db-concurrency-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const store = createSqliteStateStore<{ count: number; writers: string[] }>(dbPath, "concurrent");
    store.write({ count: 0, writers: [] });

    const workers = 4;
    const incrementsPerWorker = 15;
    const workerScript = `
      import { DatabaseSync } from "node:sqlite";
      const [dbPath, workerId, countStr] = process.argv.slice(1);
      const iterations = Number(countStr);
      const db = new DatabaseSync(dbPath, { timeout: 5000 });
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      for (let i = 0; i < iterations; i++) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const row = db.prepare("SELECT payload FROM kv_state WHERE store_key = ?").get("concurrent");
          const data = JSON.parse(row.payload);
          data.count += 1;
          data.writers.push(workerId + ":" + i);
          db.prepare(
            "UPDATE kv_state SET payload = ?, revision = revision + 1, updated_at = ? WHERE store_key = ?"
          ).run(JSON.stringify(data), new Date().toISOString(), "concurrent");
          db.exec("COMMIT");
        } catch (err) {
          try { db.exec("ROLLBACK"); } catch {}
          throw err;
        }
      }
      db.close();
    `;

    const runs = Array.from({ length: workers }, (_, idx) =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", workerScript, dbPath, `w${idx}`, String(incrementsPerWorker)],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("exit", (code) => {
          if (code === 0) resolvePromise();
          else rejectPromise(new Error(`worker ${idx} exited ${code}: ${stderr}`));
        });
        child.on("error", rejectPromise);
      }),
    );

    await Promise.all(runs);

    const finalState = store.read();
    assert.ok(finalState);
    assert.equal(finalState.count, workers * incrementsPerWorker);
    assert.equal(finalState.writers.length, workers * incrementsPerWorker);
    assert.equal(store.getRevision(), 1 + workers * incrementsPerWorker);
  });
});

// ── Worktree Isolation vs Shared Project State DB ──────────────────────────

describe("state-db: worktree isolation for pi-config-review-state vs shared project stores", () => {
  let mainRepo: string;
  let wtA: string;
  let wtB: string;

  beforeEach(() => {
    mainRepo = trackTempDir("state-db-wt-main-");
    wtA = join(mainRepo, ".worktrees", "wt-a");
    wtB = join(mainRepo, ".worktrees", "wt-b");

    execFileSync("git", ["init", "-q"], { cwd: mainRepo, env: GIT_ENV });
    writeFileSync(join(mainRepo, "README.md"), "# test\n");
    execFileSync("git", ["add", "README.md"], { cwd: mainRepo, env: GIT_ENV });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: mainRepo, env: GIT_ENV });
    execFileSync("git", ["worktree", "add", "-q", "-b", "branch-a", wtA], { cwd: mainRepo, env: GIT_ENV });
    execFileSync("git", ["worktree", "add", "-q", "-b", "branch-b", wtB], { cwd: mainRepo, env: GIT_ENV });
  });

  afterEach(() => {
    closeStateDbs();
    for (const wt of [wtA, wtB]) {
      try {
        execFileSync("git", ["worktree", "remove", wt, "--force"], {
          cwd: mainRepo,
          stdio: "ignore",
          env: GIT_ENV,
        });
      } catch {
        /* ignore */
      }
    }
  });

  it("resolves distinct per-worktree review DB paths and a single shared project DB path", () => {
    assert.notEqual(getWorktreeStateDbPath(mainRepo), getWorktreeStateDbPath(wtA));
    assert.notEqual(getWorktreeStateDbPath(wtA), getWorktreeStateDbPath(wtB));
    assert.equal(statePath(wtA), getWorktreeStateDbPath(wtA));

    assert.equal(getProjectStateDbPath(wtA), getProjectStateDbPath(mainRepo));
    assert.equal(getProjectStateDbPath(wtB), getProjectStateDbPath(mainRepo));
  });

  it("isolates pi-config-review-state mutations per worktree", () => {
    markNeedsReview(wtA);
    addReviewerPending(wtA, "code-reviewer-quality", { kind: "local", head_sha: "abc1234" });

    assert.equal(readReviewState(wtA).status, "in_progress");
    assert.equal(readReviewState(wtB).status, "none");
    assert.equal(readReviewState(mainRepo).status, "none");
  });

  it("shares memory-scoring state across worktrees via the main checkout state.db", () => {
    const hash = entryHash("- [lesson] Shared across worktrees");
    saveScores(wtA, {
      entries: {
        [hash]: {
          class: "lesson",
          score: 2.0,
          evidenceCount: 2,
          cue: "explicit",
          firstSeen: "2026-01-01T00:00:00.000Z",
          lastReinforced: "2026-01-01T00:00:00.000Z",
          userState: "auto",
          lifecycle: "active",
        },
      },
      lastRebuild: "2026-01-01T00:00:00.000Z",
      hashAlgo: "sha256-16",
    });

    assert.equal(loadScores(wtB).entries[hash]?.evidenceCount, 2);
    assert.equal(loadScores(mainRepo).entries[hash]?.evidenceCount, 2);
  });
});
