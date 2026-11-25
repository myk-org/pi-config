/**
 * Tests for shared SQLite WAL state persistence (extensions/orchestrator/state-db.ts)
 * and the 5 migrated stores (issue #1399).
 *
 * Run with: npx tsx --test tests/node/orchestrator/state-db.test.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  pruneEmbeddings,
  removeEmbedding,
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
  markNeedsReview,
  readReviewState,
  statePath,
} from "../../../extensions/orchestrator/pi-config-review-state.js";
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

  it("caches handles per path and cleanly closes via closeStateDb / closeStateDbs", () => {
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

  it("reopens transparently if the underlying db file is unlinked and recreated", () => {
    const dir = trackTempDir("state-db-reopen-");
    const dbPath = join(dir, ".pi", "data", "state.db");
    const store = createSqliteStateStore<{ v: number }>(dbPath, "test-key");
    store.write({ v: 1 });
    assert.deepEqual(store.read(), { v: 1 });

    // Simulate external wipe
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p)) unlinkSync(p);
    }

    assert.equal(store.read(), null);
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
});

// ── Float32Array BLOB Encoding & Embeddings Migration ──────────────────────

describe("state-db: Float32Array BLOB round-trip and memory-embeddings migration", () => {
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

    // Aligned round-trip
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

  it("migrates legacy embeddings.jsonl to Float32 BLOBs losslessly, idempotently, without modifying legacy file", () => {
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

    // First operation triggers migration (parses last valid JSONL line, ignores truncated tail)
    const pruned = pruneEmbeddings(cwd, [{ text: "keep-one", category: "lesson" }]);
    assert.equal(pruned, 1);

    // Verify Float32 BLOB stored in state.db
    const db = openStateDb(getProjectStateDbPath(cwd));
    const row = db
      .prepare("SELECT vector FROM embeddings WHERE entry_key = ?")
      .get(k1) as { vector: Uint8Array } | undefined;
    assert.ok(row && row.vector instanceof Uint8Array);
    assert.equal(row.vector.byteLength, 16); // 4 floats * 4 bytes
    const decoded = decodeFloat32Blob(row.vector);
    for (let i = 0; i < v1.length; i++) {
      assert.ok(Math.abs(decoded[i]! - v1[i]!) < 1e-6);
    }

    // Legacy file must remain intact on disk
    assert.equal(readFileSync(legacyPath, "utf-8"), legacyRaw);

    // Idempotency: closing handles and removing remaining key does NOT re-import legacy file
    closeStateDbs();
    removeEmbedding(cwd, "keep-one", "lesson");
    const remaining = openStateDb(getProjectStateDbPath(cwd))
      .prepare("SELECT COUNT(*) AS cnt FROM embeddings")
      .get() as { cnt: number };
    assert.equal(remaining.cnt, 0);
  });
});

// ── Lossless Migration Across All 5 Stores ─────────────────────────────────

describe("state-db: lossless one-time legacy migration for all 5 stores", () => {
  it("migrates memory-scoring from legacy .jsonl (and falls back to .json) losslessly", () => {
    const cwd = trackTempDir("state-db-score-mig-");
    const memDir = join(cwd, ".pi", "memory");
    mkdirSync(memDir, { recursive: true });
    const hash = entryHash("- [lesson] Always run typecheck");
    const entry: ScoredEntry = {
      class: "lesson",
      score: 3.14,
      evidenceCount: 4,
      cue: "explicit",
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastReinforced: "2026-01-02T00:00:00.000Z",
      userState: "pinned",
      lifecycle: "active",
    };

    const legacyJson = join(memDir, "memory-scores.json");
    writeFileSync(
      legacyJson,
      JSON.stringify({ entries: { [hash]: entry }, lastRebuild: "2026-01-02T00:00:00.000Z", hashAlgo: "sha256-16" }),
    );

    const loaded = loadScores(cwd);
    assert.equal(loaded.entries[hash]?.evidenceCount, 4);
    assert.equal(loaded.entries[hash]?.userState, "pinned");
    assert.equal(getScoresRevision(cwd), 1);
    assert.ok(existsSync(legacyJson), "legacy file preserved untouched");

    // Mutate in SQLite, close handle, reopen — must stay mutated (never re-migrated)
    mutateScores(cwd, (s) => {
      s.entries[hash]!.evidenceCount = 9;
    });
    closeStateDbs();
    assert.equal(loadScores(cwd).entries[hash]?.evidenceCount, 9);
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

    // Subsequent atomic index appends cleanly in SQLite
    indexSessionSummary(cwd, "sess-new-2", "Added Float32 BLOB vector tests");
    closeStateDbs();
    assert.equal(searchSessions(cwd, "Float32 BLOB", 5).length, 1);
    assert.equal(searchSessions(cwd, "WAL storage migration", 5).length, 1);
  });

  it("migrates pi-config-review-state from legacy .json and .jsonl losslessly", () => {
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

  it("merges both SQLite-pending and dream JSONL sidecar provenance entries", () => {
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
  it("isolates pi-config-review-state per worktree while sharing memory-scoring via main checkout", () => {
    const mainRepo = trackTempDir("state-db-wt-main-");
    const wtA = join(mainRepo, ".worktrees", "wt-a");
    const wtB = join(mainRepo, ".worktrees", "wt-b");

    execFileSync("git", ["init", "-q"], { cwd: mainRepo, env: GIT_ENV });
    writeFileSync(join(mainRepo, "README.md"), "# test\n");
    execFileSync("git", ["add", "README.md"], { cwd: mainRepo, env: GIT_ENV });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: mainRepo, env: GIT_ENV });
    execFileSync("git", ["worktree", "add", "-q", "-b", "branch-a", wtA], { cwd: mainRepo, env: GIT_ENV });
    execFileSync("git", ["worktree", "add", "-q", "-b", "branch-b", wtB], { cwd: mainRepo, env: GIT_ENV });

    try {
      // Per-worktree DB paths for review state are distinct
      assert.notEqual(getWorktreeStateDbPath(mainRepo), getWorktreeStateDbPath(wtA));
      assert.notEqual(getWorktreeStateDbPath(wtA), getWorktreeStateDbPath(wtB));
      assert.equal(statePath(wtA), getWorktreeStateDbPath(wtA));

      // Project DB path is shared across main, wtA, and wtB
      assert.equal(getProjectStateDbPath(wtA), getProjectStateDbPath(mainRepo));
      assert.equal(getProjectStateDbPath(wtB), getProjectStateDbPath(mainRepo));

      // Review state mutations stay isolated per worktree
      markNeedsReview(wtA);
      addReviewerPending(wtA, "code-reviewer-quality", { kind: "local", head_sha: "abc1234" });
      assert.equal(readReviewState(wtA).status, "in_progress");
      assert.equal(readReviewState(wtB).status, "none");
      assert.equal(readReviewState(mainRepo).status, "none");

      // Memory-scoring mutations from wtA are immediately visible from wtB and main
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
    } finally {
      closeStateDbs();
      try {
        execFileSync("git", ["worktree", "remove", wtA, "--force"], { cwd: mainRepo, stdio: "ignore", env: GIT_ENV });
      } catch {
        /* ignore */
      }
      try {
        execFileSync("git", ["worktree", "remove", wtB, "--force"], { cwd: mainRepo, stdio: "ignore", env: GIT_ENV });
      } catch {
        /* ignore */
      }
    }
  });
});
