/**
 * Review learning (issue #918 Part A) — address-hook distillation tests.
 * Run: npx tsx --test tests/node/orchestrator/review-learning.test.ts
 *
 * No network: the model call is injected; the EnMaaS fetch wrapper is a thin
 * shell around it and stays untested here by design.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isReviewsAddressCommand,
  parseGitHubRepo,
  getLatestReview,
  getAddressedComments,
  rankFindings,
  parseLessonsResponse,
  distillFindings,
  findMemoryLineByDerivedFrom,
  writeLessonsToMemory,
  findingProvenance,
  createReviewLearning,
  type AddressedFinding,
} from "../../../extensions/orchestrator/review-learning.js";
import { entryHash, loadScores, type ScoredEntry } from "../../../extensions/orchestrator/memory-scoring.js";
import { readAllTopicEntries } from "../../../extensions/orchestrator/memory-tree.js";

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

interface SeededDb {
  dir: string;
  dbPath: string;
}

function seedDb(): SeededDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-"));
  const dbPath = path.join(dir, "reviews.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const insertReview = db.prepare(
    "INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertComment = db.prepare(
    "INSERT INTO comments (review_id, source, path, line, body, priority, status) VALUES (?, 'qodo', ?, ?, ?, ?, ?)",
  );
  // review 1: myk-org/demo @ sha-aaa (older)
  insertReview.run(10, "myk-org", "demo", "sha-aaa", "2026-01-01T00:00:00Z");
  insertComment.run(1, "src/api.py", 10, "Missing strip_sensitive_from_response on the endpoint", "critical", "addressed");
  insertComment.run(1, "src/api.py", 42, "Same redaction gap on the list endpoint", "high", "addressed");
  insertComment.run(1, "src/util.py", 5, "Ack-only nit", "low", "skipped");
  // review 2: other/repo @ sha-bbb (wrong repo — must never be picked)
  insertReview.run(11, "other", "repo", "sha-bbb", "2026-01-02T00:00:00Z");
  insertComment.run(2, "src/other.py", 1, "Addressed but wrong repo", "critical", "addressed");
  // review 3: myk-org/demo @ sha-ccc (newest for the repo — the one that must win)
  insertReview.run(12, "myk-org", "demo", "sha-ccc", "2026-01-03T00:00:00Z");
  insertComment.run(3, "src/api.py", 7, "Unhandled None on the endpoint response", "high", "addressed");
  insertComment.run(3, "src/api.py", 9, "Skipped false positive", "high", "skipped");
  db.close();
  return { dir, dbPath };
}

function finding(id: number, priority: string | null, body = `finding ${id}`): AddressedFinding {
  return { id, path: `src/f${id}.py`, line: id, body, priority };
}

// ── Command matcher ────────────────────────────────────────────────────────

describe("isReviewsAddressCommand", () => {
  it("matches direct and uv-wrapped invocations", () => {
    assert.equal(isReviewsAddressCommand("myk-pi-tools reviews address --json x --replies y --set addressed"), true);
    assert.equal(isReviewsAddressCommand("uv run myk-pi-tools reviews address --json x"), true);
    assert.equal(isReviewsAddressCommand("uv run --group dev myk-pi-tools reviews address --set addressed"), true);
    assert.equal(isReviewsAddressCommand("cd /tmp && uv run --group dev myk-pi-tools reviews address --json x"), true);
    assert.equal(isReviewsAddressCommand("  myk-pi-tools reviews address  "), true);
  });
  it("rejects non-address commands", () => {
    assert.equal(isReviewsAddressCommand("myk-pi-tools reviews store pr-1-reviews.json"), false);
    assert.equal(isReviewsAddressCommand("myk-pi-tools reviews fetch"), false);
    assert.equal(isReviewsAddressCommand("myk-pi-tools reviews status"), false);
    assert.equal(isReviewsAddressCommand("myk-pi-tools reviews poll --source qodo"), false);
  });
  it("requires the myk-pi-tools binary", () => {
    assert.equal(isReviewsAddressCommand("reviews address --json x --set addressed"), false);
    assert.equal(isReviewsAddressCommand("uv run other-tool reviews address"), false);
  });
  it("rejects adjacent subcommand names and non-strings", () => {
    assert.equal(isReviewsAddressCommand("myk-pi-tools reviews address-logs --json x"), false);
    assert.equal(isReviewsAddressCommand(undefined), false);
    assert.equal(isReviewsAddressCommand(42), false);
    assert.equal(isReviewsAddressCommand(""), false);
  });
});

// ── Repo parsing ───────────────────────────────────────────────────────────

describe("parseGitHubRepo", () => {
  it("parses https, ssh, and SCP-like remotes", () => {
    assert.deepEqual(parseGitHubRepo("https://github.com/myk-org/pi-config.git"), { owner: "myk-org", repo: "pi-config" });
    assert.deepEqual(parseGitHubRepo("https://github.com/myk-org/pi-config"), { owner: "myk-org", repo: "pi-config" });
    assert.deepEqual(parseGitHubRepo("git@github.com:myk-org/pi-config.git"), { owner: "myk-org", repo: "pi-config" });
    assert.deepEqual(parseGitHubRepo("ssh://git@github.com/myk-org/pi-config.git"), { owner: "myk-org", repo: "pi-config" });
  });
  it("returns null for unusable remotes", () => {
    assert.equal(parseGitHubRepo(""), null);
    assert.equal(parseGitHubRepo("https://github.com/onlyowner"), null);
    assert.equal(parseGitHubRepo("/local/path"), null);
  });
});

// ── DB queries ─────────────────────────────────────────────────────────────

describe("reviews DB queries", () => {
  it("getLatestReview picks the newest row for owner/repo", () => {
    const { dbPath } = seedDb();
    const latest = getLatestReview(dbPath, "myk-org", "demo");
    assert.ok(latest);
    assert.equal(latest.commitSha, "sha-ccc");
    assert.equal(getLatestReview(dbPath, "nope", "nope"), null);
    assert.equal(getLatestReview(path.join(dbPath, "missing.db"), "myk-org", "demo"), null);
  });
  it("getAddressedComments returns only addressed rows for the SHA", () => {
    const { dbPath } = seedDb();
    const aaa = getAddressedComments(dbPath, "sha-aaa");
    assert.equal(aaa.length, 2);
    assert.deepEqual(aaa.map((f) => f.priority).sort(), ["critical", "high"]);
    assert.ok(aaa.every((f) => typeof f.body === "string" && f.path));
    // the newest demo review's SHA: only its own addressed row, not the older
    // review's (sha-aaa) and not the other repo's (sha-bbb) — wrong-SHA rows excluded
    const ccc = getAddressedComments(dbPath, "sha-ccc");
    assert.equal(ccc.length, 1);
    assert.equal(ccc[0]!.body, "Unhandled None on the endpoint response");
    assert.deepEqual(getAddressedComments(dbPath, "sha-zzz"), []);
    assert.deepEqual(getAddressedComments(path.join(dbPath, "missing.db"), "sha-aaa"), []);
  });
});

// ── Ranking ────────────────────────────────────────────────────────────────

describe("rankFindings", () => {
  it("caps at 5, critical/high first, then by id", () => {
    const ranked = rankFindings([
      finding(7, "low"),
      finding(2, "high"),
      finding(1, "critical"),
      finding(9, "medium"),
      finding(4, "high"),
      finding(3, "critical"),
      finding(8, null),
    ]);
    assert.deepEqual(ranked.map((f) => f.id), [1, 3, 2, 4, 9]);
  });
});

// ── Response parsing ───────────────────────────────────────────────────────

describe("parseLessonsResponse", () => {
  it("parses plain and fenced JSON arrays of strings", () => {
    assert.deepEqual(parseLessonsResponse('["a","b"]'), ["a", "b"]);
    assert.deepEqual(parseLessonsResponse('```json\n["a","b"]\n```'), ["a", "b"]);
    assert.deepEqual(parseLessonsResponse('Here you go:\n["a"]'), ["a"]);
  });
  it("accepts {lesson}/{text} objects and sanitizes lines", () => {
    assert.deepEqual(parseLessonsResponse('[{"lesson":"a"},{"text":"b"}]'), ["a", "b"]);
    assert.deepEqual(parseLessonsResponse('["  multi\\nline  "]'), ["multi line"]);
    assert.deepEqual(parseLessonsResponse('["", "   ", null, "x"]'), ["x"]);
    assert.equal(parseLessonsResponse('["' + "y".repeat(150) + '"]')[0]!.length, 100);
  });
  it("throws on unparseable output", () => {
    assert.throws(() => parseLessonsResponse("not json at all"));
    assert.throws(() => parseLessonsResponse('{"lessons": "object not array"}'));
  });
});

// ── Distill orchestration (injected model call — no network) ───────────────

describe("distillFindings", () => {
  it("maps lessons to findings by order", async () => {
    const calls: any[] = [];
    const lessons = await distillFindings(
      [finding(1, "critical"), finding(2, "high")],
      async (messages) => {
        calls.push(messages);
        return '["lesson for one", "lesson for two"]';
      },
      { owner: "myk-org", repo: "demo" },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 2);
    assert.match(calls[0][0].content, /JSON array of strings/);
    assert.match(calls[0][1].content, /myk-org\/demo/);
    assert.deepEqual(lessons, [
      { findingId: 1, text: "lesson for one" },
      { findingId: 2, text: "lesson for two" },
    ]);
  });
  it("aborts gracefully on model failure", async () => {
    const lessons = await distillFindings([finding(1, "high")], async () => {
      throw new Error("boom");
    });
    assert.deepEqual(lessons, []);
  });
  it("aborts gracefully on parse failure", async () => {
    const lessons = await distillFindings([finding(1, "high")], async () => "certainly not json");
    assert.deepEqual(lessons, []);
  });
  it("returns [] for empty findings without calling the model", async () => {
    let called = 0;
    const lessons = await distillFindings([], async () => {
      called++;
      return "[]";
    });
    assert.deepEqual(lessons, []);
    assert.equal(called, 0);
  });
  it("ignores extra lessons beyond the findings", async () => {
    const lessons = await distillFindings([finding(5, "high")], async () => '["one","two","three"]');
    assert.deepEqual(lessons, [{ findingId: 5, text: "one" }]);
  });
});

// ── Memory dedupe + write ──────────────────────────────────────────────────

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-mem-"));
}

function seedLessonEntry(cwd: string, text: string, derivedFrom?: string, evidenceCount = 1): void {
  const topicsDir = path.join(cwd, ".pi", "memory", "topics");
  fs.mkdirSync(topicsDir, { recursive: true });
  fs.appendFileSync(path.join(topicsDir, "lessons.md"), `- [lesson] ${text}\n`);
  const hash = entryHash(`- [lesson] ${text}`);
  const entry: ScoredEntry = {
    class: "lesson",
    score: 1,
    evidenceCount,
    cue: "explicit",
    firstSeen: new Date().toISOString(),
    lastReinforced: new Date().toISOString(),
    userState: "auto",
    lifecycle: "active",
  };
  if (derivedFrom) entry.derivedFrom = derivedFrom;
  const scores = loadScores(cwd);
  scores.entries[hash] = entry;
  const storePath = path.join(cwd, ".pi", "memory", "memory-scores.jsonl");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({ ...scores, hashAlgo: "sha256-16" }) + "\n");
}

const REPO = { owner: "myk-org", repo: "demo" };

// This suite may itself run inside a pi subagent — clear the child marker so
// register() wires its handler (mirrors graft.test.ts).
const originalChild = process.env.PI_SUBAGENT_CHILD;
beforeEach(() => { delete process.env.PI_SUBAGENT_CHILD; });
afterEach(() => {
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChild;
});

describe("writeLessonsToMemory", () => {
  it("reinforces an existing entry with matching derivedFrom instead of adding", async () => {
    const cwd = makeCwd();
    const provenance = findingProvenance(101, REPO);
    seedLessonEntry(cwd, "existing lesson text", provenance);
    const result = await writeLessonsToMemory(cwd, [{ findingId: 101, text: "freshly distilled wording" }], REPO);
    assert.equal(result.reinforced, 1);
    assert.equal(result.added, 0);
    // no new topic line, evidence bumped
    const entries = readAllTopicEntries(cwd).filter((e) => e.category === "lesson");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.text, "existing lesson text");
    const hash = entryHash("- [lesson] existing lesson text");
    assert.equal(loadScores(cwd).entries[hash]!.evidenceCount, 2);
  });
  it("adds a new lesson with provenance and informs", async () => {
    const cwd = makeCwd();
    const result = await writeLessonsToMemory(cwd, [{ findingId: 202, text: "new distilled lesson" }], REPO);
    assert.equal(result.added, 1);
    const entries = readAllTopicEntries(cwd).filter((e) => e.category === "lesson");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.text, "new distilled lesson");
    const hash = entryHash("- [lesson] new distilled lesson");
    const scored = loadScores(cwd).entries[hash]!;
    assert.ok(scored, "score entry exists");
    assert.equal(scored.derivedFrom, findingProvenance(202, REPO));
    assert.deepEqual(scored.informs, ["review-learning"]);
  });
  it("caps writes at 5 per fire", async () => {
    const cwd = makeCwd();
    const lessons = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ findingId: id, text: `lesson ${id}` }));
    const result = await writeLessonsToMemory(cwd, lessons, REPO);
    assert.equal(result.added + result.reinforced + result.rejected, 5);
    assert.equal(readAllTopicEntries(cwd).filter((e) => e.category === "lesson").length, 5);
  });
  it("findMemoryLineByDerivedFrom returns null when absent", () => {
    const cwd = makeCwd();
    seedLessonEntry(cwd, "some lesson", "reviews.db:999;other/repo");
    assert.equal(findMemoryLineByDerivedFrom(cwd, "reviews.db:1;myk-org/demo"), null);
    assert.equal(findMemoryLineByDerivedFrom(cwd, "reviews.db:999;other/repo"), "- [lesson] some lesson");
  });
});

// ── Settings gate + hook wiring ────────────────────────────────────────────

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

/** cwd with a seeded reviews.db at the location getProjectDataDir resolves to. */
function cwdWithDb(): string {
  const cwd = makeCwd();
  const { dbPath } = seedDb();
  const dataDir = path.join(cwd, ".pi", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(dbPath, path.join(dataDir, "reviews.db"));
  return cwd;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("review-learning hook", () => {
  it("distills on a non-error bash tool_result for reviews address", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({
      callModel: async () => '["redaction guard required on endpoints"]',
      repoInfo: () => REPO,
    }).register(pi as any);
    const handler = handlers.get("tool_result")![0]!;
    handler(
      { toolName: "bash", input: { command: "uv run --group dev myk-pi-tools reviews address --json x --set addressed" }, isError: false },
      { cwd },
    );
    const lessonsIn = () => readAllTopicEntries(cwd).filter((e) => e.category === "lesson");
    assert.ok(await waitFor(() => lessonsIn().length > 0), "lesson written");
    assert.deepEqual(lessonsIn().map((e) => e.text), ["redaction guard required on endpoints"]);
  });
  it("no-ops when the setting is disabled", async () => {
    const cwd = cwdWithDb();
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "pi-config-settings.json"), JSON.stringify({ review_learning: false }));
    const { distill } = createReviewLearning({
      callModel: async () => {
        calls++;
        return '["should never appear"]';
      },
      repoInfo: () => REPO,
    });
    let calls = 0;
    await distill(cwd);
    assert.equal(calls, 0);
    assert.equal(readAllTopicEntries(cwd).length, 0);
  });
  it("distills when the setting is enabled (default)", async () => {
    const cwd = cwdWithDb();
    let calls = 0;
    const { distill } = createReviewLearning({
      callModel: async () => {
        calls++;
        return '["distilled lesson"]';
      },
      repoInfo: () => REPO,
    });
    await distill(cwd);
    assert.equal(calls, 1);
    const lessons = readAllTopicEntries(cwd).filter((e) => e.category === "lesson");
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0]!.text, "distilled lesson");
  });
  it("ignores error results, other tools, and non-address commands", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    let calls = 0;
    createReviewLearning({
      callModel: async () => {
        calls++;
        return '["x"]';
      },
      repoInfo: () => REPO,
    }).register(pi as any);
    const handler = handlers.get("tool_result")![0]!;
    handler({ toolName: "bash", input: { command: "myk-pi-tools reviews address --json x" }, isError: true }, { cwd });
    handler({ toolName: "read", input: { path: "x" }, isError: false }, { cwd });
    handler({ toolName: "bash", input: { command: "myk-pi-tools reviews store x.json" }, isError: false }, { cwd });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls, 0);
  });
  it("registers nothing in subagent children", () => {
    const original = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      const { pi, handlers } = mockPi();
      createReviewLearning().register(pi as any);
      assert.equal(handlers.size, 0);
    } finally {
      if (original === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = original;
    }
  });
});
