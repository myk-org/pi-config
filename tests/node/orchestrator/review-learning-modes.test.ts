/**
 * Review learning (issue #918 build-order step 4) — review-handler MODE tests.
 * Run: npx tsx --test tests/node/orchestrator/review-learning-modes.test.ts
 *
 * The address hook must fire in BOTH review-handler modes (prompts/review-handler.md):
 * - Interactive mode — Phase 8 runs `myk-pi-tools reviews address` in main-session bash:
 *     myk-pi-tools reviews address --json {json_path} --replies {mapping_file} --set addressed
 *     myk-pi-tools reviews address --json {json_path} --replies {mapping_file} --set skipped
 * - Auto mode (--autorabbit / --autoqodo) — Phase 9 spawns poll workers that run
 *   `myk-pi-tools reviews poll --output-dir {dir} --source {coderabbit|qodo}`; when a
 *   worker returns new comments, the main session "process[es] them (Phases 2-8)" —
 *   the SAME Phase 8 address command, replayed in main-session bash. Phase 8 also
 *   documents the --json-omitted form ("picks the newest pr-*-reviews.json in .pi/tmp").
 * - The poll worker process itself never calls address (myk_pi_tools/reviews/poll.py
 *   only runs fetch and gh-api status calls) — poll/fetch/store commands must NOT fire.
 *
 * No network: the model call is injected.
 */
import { afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createReviewLearning, findingProvenance } from "../../../extensions/orchestrator/review-learning.js";
import { entryHash, loadScores } from "../../../extensions/orchestrator/memory-scoring.js";
import { readAllTopicEntries } from "../../../extensions/orchestrator/memory-tree.js";
import { embedEntry } from "../../../extensions/orchestrator/memory-embeddings.js";

// ── Scratch reviews DB (schema mirrors myk_pi_tools/reviews/store.py) ──────

const SCHEMA = `
CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_number INTEGER NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL REFERENCES reviews(id),
    source TEXT NOT NULL,
    thread_id TEXT,
    node_id TEXT,
    comment_id INTEGER,
    author TEXT,
    path TEXT,
    line INTEGER,
    body TEXT,
    priority TEXT,
    status TEXT,
    reply TEXT,
    skip_reason TEXT,
    posted_at TEXT,
    resolved_at TEXT,
    type TEXT DEFAULT NULL,
    quality_label TEXT DEFAULT NULL,
    code_diff TEXT DEFAULT NULL
);
`;

const REPO = { owner: "myk-org", repo: "demo" };

/** Seed a scratch DB: one myk-org/demo review @ sha-mode with addressed ids 1,2 and a skipped id 3. */
function seedModeDb(): { dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-modes-"));
  const dbPath = path.join(dir, "reviews.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)").run(
    325, REPO.owner, REPO.repo, "sha-mode", "2026-01-01T00:00:00Z",
  );
  const insertComment = db.prepare(
    "INSERT INTO comments (review_id, source, path, line, body, priority, status) VALUES (?, 'qodo', ?, ?, ?, ?, ?)",
  );
  insertComment.run(1, "src/api.py", 10, "Missing strip_sensitive_from_response on the endpoint", "critical", "addressed");
  insertComment.run(1, "src/api.py", 42, "Unhandled None on the list endpoint", "high", "addressed");
  insertComment.run(1, "src/util.py", 5, "Ack-only nit", "low", "skipped");
  db.close();
  return { dbPath };
}

/** cwd with the seeded reviews.db at the location getProjectDataDir resolves to. */
function cwdWithDb(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-modes-cwd-"));
  const dataDir = path.join(cwd, ".pi", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(seedModeDb().dbPath, path.join(dataDir, "reviews.db"));
  return cwd;
}

function disableSetting(cwd: string): void {
  fs.writeFileSync(path.join(cwd, ".pi", "pi-config-settings.json"), JSON.stringify({ review_learning: false }));
}

type Handler = (event: any, ctx: any) => Promise<any> | any;

function mockPi() {
  const handlers = new Map<string, Handler[]>();
  return {
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    handlers,
  };
}

/**
 * Fire EVERY registered tool_result handler — behavior over registration
 * order, so adding or reordering an unrelated handler cannot break tests.
 * Returns the first non-undefined result (the write hint on write events;
 * undefined for bash events, which the watcher handles via scheduling).
 */
function fireAllToolResult(handlers: Map<string, Handler[]>, event: any = undefined, ctx: any = undefined): any {
  if (!event) {
    // deferred form: returns a function that fires all handlers on demand
    return (ev: any, c: any) => fireAllToolResult(handlers, ev, c);
  }
  return (handlers.get("tool_result") ?? []).map((h) => h(event, ctx)).find((r: any) => r !== undefined);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

const lessonsIn = (cwd: string) => readAllTopicEntries(cwd).filter((e) => e.category === "lesson");

// This suite may itself run inside a pi subagent — clear the child marker so
// register() wires its handler (mirrors review-learning.test.ts).
const originalChild = process.env.PI_SUBAGENT_CHILD;
beforeEach(() => { delete process.env.PI_SUBAGENT_CHILD; });
afterEach(() => {
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChild;
});

// Warm the ONNX embedding pipeline BEFORE the assertion windows (issue #918
// phase 4 full-suite isolation): addMemoryEntry awaits embedEntry per lesson,
// and the FIRST call pays the ~1s pipeline init (128MB bge-small model from
// the shared node_modules/@huggingface/transformers/.cache). The second
// lesson write is serialized behind it, so under the full node suite's
// parallel load that init exceeds the 2s waitFor budget and this file's
// "two lessons written" assertions time out (full-suite-only failure — the
// file passes standalone because ~1s init fits the 2s budget). Warming once
// up front moves the init outside the measured window; warmed embeds are
// ~7ms. When the model is unavailable, warmup fails fast and the embeds
// inside the write path fail fast too — no behavior change either way.
before(async () => {
  const warmupDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-modes-warmup-"));
  try {
    await embedEntry(warmupDir, "pipeline warmup", "lesson");
  } finally {
    fs.rmSync(warmupDir, { recursive: true, force: true });
  }
});

// Phase 8 documented shapes (prompts/review-handler.md lines 461-465).
const INTERACTIVE_ADDRESS = (setStatus: string) =>
  `myk-pi-tools reviews address --json .pi/tmp/pr-325-reviews.json --replies .pi/tmp/replies-${setStatus}.json --set ${setStatus}`;
// Auto-mode Phase 9 replay: same Phase 8 CLI; the --json-omitted form Phase 8
// documents ("picks the newest pr-*-reviews.json in .pi/tmp when --json is omitted").
const AUTO_ADDRESS = (setStatus: string) =>
  `myk-pi-tools reviews address --replies .pi/tmp/replies-${setStatus}.json --set ${setStatus}`;
// Phase 9 worker task shapes — run inside the poll worker process, never address.
const POLL_WORKER_COMMANDS = [
  "uv run myk-pi-tools reviews poll --output-dir .pi/tmp --source coderabbit",
  "myk-pi-tools reviews poll --output-dir .pi/tmp --source qodo",
  "myk-pi-tools reviews fetch --output-dir .pi/tmp --source coderabbit",
  "myk-pi-tools reviews store .pi/tmp/pr-325-reviews.json",
];

describe("review-learning review-handler modes", () => {
  it("interactive-mode Phase 8 address shape distills lessons with provenance", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    const handler = fireAllToolResult(handlers);
    handler(
      { toolName: "bash", input: { command: INTERACTIVE_ADDRESS("addressed") }, isError: false },
      { cwd },
    );
    assert.ok(await waitFor(() => lessonsIn(cwd).length === 2), "two lessons written");
    // finding-id provenance on both score entries
    const scores = loadScores(cwd);
    for (const [id, text] of [[1, 'src/api.py: Missing strip_sensitive_from_response on the endpoint'], [2, 'src/api.py: Unhandled None on the list endpoint']] as const) {
      const hash = entryHash(`- [lesson] ${text}`);
      assert.equal(scores.entries[hash]!.derivedFrom, findingProvenance(id, REPO), `provenance for finding ${id}`);
    }
  });

  it("auto-mode Phase 9 replay address shape distills lessons (skipped-set variant, --json omitted)", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    const handler = fireAllToolResult(handlers);
    handler(
      { toolName: "bash", input: { command: AUTO_ADDRESS("addressed") }, isError: false },
      { cwd },
    );
    assert.ok(await waitFor(() => lessonsIn(cwd).length === 2), "two lessons written from auto-mode replay");
    assert.equal(loadScores(cwd).entries[entryHash("- [lesson] " + 'src/api.py: Missing strip_sensitive_from_response on the endpoint')]!.derivedFrom, findingProvenance(1, REPO));
  });

  it("poll-worker / fetch / store command shapes never trigger", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    const handler = fireAllToolResult(handlers);
    for (const command of POLL_WORKER_COMMANDS) {
      handler({ toolName: "bash", input: { command }, isError: false }, { cwd });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(lessonsIn(cwd).length, 0);
  });

  it("re-firing the same address command is a no-op — no duplicates, no evidence inflation", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    const handler = fireAllToolResult(handlers);
    // first group run (Phase 8: one `reviews address` call per status group)
    handler(
      { toolName: "bash", input: { command: INTERACTIVE_ADDRESS("addressed") }, isError: false },
      { cwd },
    );
    assert.ok(await waitFor(() => lessonsIn(cwd).length === 2), "first fire writes");
    const hash = () => loadScores(cwd).entries[entryHash("- [lesson] " + 'src/api.py: Missing strip_sensitive_from_response on the endpoint')]!;
    const evidenceAfterFirst = hash().evidenceCount;
    // re-fire (multi-group / Phase 9 replay of the same findings) — the review
    // is already distilled, so nothing changes: no new topic lines, no bump
    handler(
      { toolName: "bash", input: { command: AUTO_ADDRESS("addressed") }, isError: false },
      { cwd },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(lessonsIn(cwd).length, 2, "no duplicates");
    assert.equal(hash().evidenceCount, evidenceAfterFirst, "no evidence inflation on re-fire");
  });

  it("a NEW review re-raising the same issue is a real recurrence — reinforced, not duplicated", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    const handler = fireAllToolResult(handlers);
    handler(
      { toolName: "bash", input: { command: INTERACTIVE_ADDRESS("addressed") }, isError: false },
      { cwd },
    );
    assert.ok(await waitFor(() => lessonsIn(cwd).length === 2), "first fire writes");
    // a later cycle stores a NEW review (new commit SHA) re-raising the same issues
    const db = new DatabaseSync(path.join(cwd, ".pi", "data", "reviews.db"));
    const result = db
      .prepare("INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(325, REPO.owner, REPO.repo, "sha-mode-2", "2026-01-02T00:00:00Z") as any;
    const insert = db.prepare(
      "INSERT INTO comments (review_id, source, path, line, body, priority, status) VALUES (?, 'qodo', ?, ?, ?, ?, ?)",
    );
    insert.run(Number(result.lastInsertRowid), "src/api.py", 10, "Missing strip_sensitive_from_response on the endpoint", "critical", "addressed");
    insert.run(Number(result.lastInsertRowid), "src/api.py", 42, "Unhandled None on the list endpoint", "high", "addressed");
    db.close();
    handler(
      { toolName: "bash", input: { command: AUTO_ADDRESS("addressed") }, isError: false },
      { cwd },
    );
    // same issue, new finding ids → duplicate text detection reinforces
    const evidenceBumped = () =>
      loadScores(cwd).entries[entryHash("- [lesson] " + 'src/api.py: Missing strip_sensitive_from_response on the endpoint')]!.evidenceCount >= 2;
    assert.ok(await waitFor(evidenceBumped), "real recurrence bumps evidence");
    // still exactly two topic lines — no duplicates
    assert.deepEqual(
      lessonsIn(cwd).map((e) => e.text).sort(),
      ['src/api.py: Unhandled None on the list endpoint', 'src/api.py: Missing strip_sensitive_from_response on the endpoint'].sort(),
    );
  });

  it("disabled review_learning setting no-ops in both modes", async () => {
    const cwd = cwdWithDb();
    disableSetting(cwd);
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    const handler = fireAllToolResult(handlers);
    handler(
      { toolName: "bash", input: { command: INTERACTIVE_ADDRESS("addressed") }, isError: false },
      { cwd },
    );
    handler(
      { toolName: "bash", input: { command: AUTO_ADDRESS("skipped") }, isError: false },
      { cwd },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(lessonsIn(cwd).length, 0);
  });
});
