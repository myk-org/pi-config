/**
 * Review learning (issue #918 Part A) — address-hook distillation tests.
 * Run: npx tsx --test tests/node/orchestrator/review-learning.test.ts
 *
 * No network, no model calls: findings come from a scratch sqlite reviews DB
 * (with and without the `comments.title` column) and seeded memory lessons.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isReviewsAddressCommand,
  isReviewsStoreSessionCommand,
  parseGitHubRepo,
  resolveRepoInfo,
  getLatestReview,
  getReviewsForPr,
  getAddressedComments,
  rankFindings,
  extractFindingTitle,
  lessonFromFinding,
  distillLessons,
  findMemoryLineByDerivedFrom,
  writeLessonsToMemory,
  findingProvenance,
  createReviewLearning,
  loadDistilledReviews,
  loadReviewLessons,
  moduleMtimeStamp,
  emitReviewLearningLoaded,
  markReviewDistilled,
  prNumberFromCommand,
  type AddressedFinding,
  type DistilledLesson,
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
    code_diff TEXT DEFAULT NULL,
    title TEXT DEFAULT NULL
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
  // review 1 (id 1): myk-org/demo PR 10 @ sha-aaa (older)
  insertReview.run(10, "myk-org", "demo", "sha-aaa", "2026-01-01T00:00:00Z");
  insertComment.run(1, "src/api.py", 10, "Missing strip_sensitive_from_response on the endpoint", "critical", "addressed");
  insertComment.run(1, "src/api.py", 42, "Same redaction gap on the list endpoint", "high", "addressed");
  insertComment.run(1, "src/util.py", 5, "Ack-only nit", "low", "skipped");
  // review 2 (id 2): other/repo PR 11 @ sha-bbb (wrong repo — must never be picked)
  insertReview.run(11, "other", "repo", "sha-bbb", "2026-01-02T00:00:00Z");
  insertComment.run(2, "src/other.py", 1, "Addressed but wrong repo", "critical", "addressed");
  // review 3 (id 3): myk-org/demo PR 12 @ sha-ccc (newest for the repo — the one that must win)
  insertReview.run(12, "myk-org", "demo", "sha-ccc", "2026-01-03T00:00:00Z");
  insertComment.run(3, "src/api.py", 7, "Unhandled None on the endpoint response", "high", "addressed");
  insertComment.run(3, "src/api.py", 9, "Skipped false positive", "high", "skipped");
  // review 4 (id 4): myk-org/demo PR 10 again @ sha-aaa (same PR, older review —
  // PR-narrowed selection must still pick the newest ROW for the PR)
  insertReview.run(10, "myk-org", "demo", "sha-aaa2", "2026-01-04T00:00:00Z");
  insertComment.run(4, "src/api.py", 11, "Older PR-10 review finding", "high", "addressed");
  db.close();
  return { dir, dbPath };
}

function finding(
  id: number,
  priority: string | null,
  body = `finding ${id}`,
  title: string | null = null,
): AddressedFinding {
  return { id, path: `src/f${id}.py`, line: id, body, priority, title };
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

describe("isReviewsStoreSessionCommand", () => {
  it("matches direct and uv-wrapped invocations", () => {
    assert.equal(isReviewsStoreSessionCommand("myk-pi-tools reviews store-session .pi/tmp/qodo-943-abc.json"), true);
    assert.equal(isReviewsStoreSessionCommand("uv run myk-pi-tools reviews store-session x.json"), true);
    assert.equal(isReviewsStoreSessionCommand("cd /repo && uv run myk-pi-tools reviews store-session x.json"), true);
  });
  it("rejects plain store, other subcommands, and non-strings", () => {
    assert.equal(isReviewsStoreSessionCommand("myk-pi-tools reviews store pr-1-reviews.json"), false);
    assert.equal(isReviewsStoreSessionCommand("myk-pi-tools reviews fetch"), false);
    assert.equal(isReviewsStoreSessionCommand("myk-pi-tools reviews store-session-logs x.json"), false);
    assert.equal(isReviewsStoreSessionCommand("reviews store-session x.json"), false);
    assert.equal(isReviewsStoreSessionCommand(undefined), false);
    assert.equal(isReviewsStoreSessionCommand(42), false);
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

describe("resolveRepoInfo (git remote origin)", () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  }
  function tempRepo(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-repo-"));
    git(cwd, "init", "-b", "main");
    return cwd;
  }
  it("parses owner/repo from the origin remote", () => {
    const cwd = tempRepo();
    git(cwd, "remote", "add", "origin", "git@github.com:myk-org/demo.git");
    assert.deepEqual(resolveRepoInfo(cwd), { owner: "myk-org", repo: "demo" });
  });
  it("fail-soft nulls: no origin, invalid remote, non-repo", () => {
    const noOrigin = tempRepo();
    assert.equal(resolveRepoInfo(noOrigin), null);
    const badRemote = tempRepo();
    git(badRemote, "remote", "add", "origin", "/just/a/local/path");
    assert.equal(resolveRepoInfo(badRemote), null);
    assert.equal(resolveRepoInfo(fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-norepo-"))), null);
  });
});

// ── DB queries ─────────────────────────────────────────────────────────────

describe("reviews DB queries", () => {
  it("getReviewsForPr returns every row of the PR, oldest first (Qodo 16d84431)", () => {
    const { dbPath } = seedDb();
    // PR 10 has two rows (reviews 1 and 4) — a session loop stores one row
    // per commit, and every group must distill, not just the highest id.
    const rows = getReviewsForPr(dbPath, "myk-org", "demo", 10);
    assert.deepEqual(rows.map((r) => r.id), [1, 4]);
    assert.deepEqual(rows.map((r) => r.commitSha), ["sha-aaa", "sha-aaa2"]);
    assert.deepEqual(getReviewsForPr(dbPath, "myk-org", "demo", 999), []);
    assert.deepEqual(getReviewsForPr(path.join(dbPath, "missing.db"), "myk-org", "demo", 10), []);
    // Another repo's rows for the same PR number never leak in.
    assert.deepEqual(getReviewsForPr(dbPath, "other", "repo", 11).map((r) => r.id), [2]);
  });
  it("getLatestReview picks the newest row for owner/repo", () => {
    const { dbPath } = seedDb();
    const latest = getLatestReview(dbPath, "myk-org", "demo");
    assert.ok(latest);
    assert.equal(latest.commitSha, "sha-aaa2");
    assert.equal(latest.prNumber, 10);
    assert.equal(getLatestReview(dbPath, "nope", "nope"), null);
    assert.equal(getLatestReview(path.join(dbPath, "missing.db"), "myk-org", "demo"), null);
  });
  it("getLatestReview narrows to the addressed PR — an older PR never wins by repo recency", () => {
    const { dbPath } = seedDb();
    // PR 12's newest row is review 3 even though review 4 (PR 10) is newer overall
    const pr12 = getLatestReview(dbPath, "myk-org", "demo", 12);
    assert.ok(pr12);
    assert.equal(pr12.id, 3);
    assert.equal(pr12.commitSha, "sha-ccc");
    // PR narrowing with no stored review for that PR → null
    assert.equal(getLatestReview(dbPath, "myk-org", "demo", 999), null);
  });
  it("getAddressedComments returns only addressed rows for the review id", () => {
    const { dbPath } = seedDb();
    const review1 = getAddressedComments(dbPath, 1);
    assert.equal(review1.length, 2);
    assert.deepEqual(review1.map((f) => f.priority).sort(), ["critical", "high"]);
    assert.ok(review1.every((f) => typeof f.body === "string" && f.path));
    // review 3: only its own addressed row — not the older reviews of the same
    // repo and not the other repo's (selection is by review id, not commit SHA)
    const review3 = getAddressedComments(dbPath, 3);
    assert.equal(review3.length, 1);
    assert.equal(review3[0]!.body, "Unhandled None on the endpoint response");
    assert.deepEqual(getAddressedComments(dbPath, 999), []);
    assert.deepEqual(getAddressedComments(path.join(dbPath, "missing.db"), 1), []);
  });
  it("getAddressedComments falls back to title-less rows on legacy DBs without the title column", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-legacy-"));
    const dbPath = path.join(dir, "reviews.db");
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA.replace(",\n    title TEXT DEFAULT NULL", ""));
    db.prepare("INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) VALUES (1, 'o', 'r', 's', 't')").run();
    db.prepare(
      "INSERT INTO comments (review_id, source, path, line, body, priority, status) VALUES (1, 'qodo', 'a.py', 1, 'x', 'high', 'addressed')",
    ).run();
    db.close();
    const rows = getAddressedComments(dbPath, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.title, null);
  });
});

// ── Distilled-review state + addressed-PR identification ───────────────────

describe("distilled-review state", () => {
  it("round-trips review ids and survives reload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-state-"));
    assert.equal(loadDistilledReviews(dir).size, 0);
    markReviewDistilled(dir, 7);
    markReviewDistilled(dir, 9);
    assert.deepEqual([...loadDistilledReviews(dir)].sort((a, b) => a - b), [7, 9]);
  });
  it("loadDistilledReviews tolerates a missing/corrupt state file", () => {
    assert.equal(loadDistilledReviews("/nonexistent-dir").size, 0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-state-"));
    fs.writeFileSync(path.join(dir, "review-learning-state.json"), "not json{");
    assert.equal(loadDistilledReviews(dir).size, 0);
  });
});

describe("prNumberFromCommand", () => {
  it("reads the PR number only from the command's explicit --json file", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-pr-"));
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "pr-42-reviews.json"),
      JSON.stringify({ metadata: { owner: "myk-org", repo: "demo", pr_number: 42 } }),
    );
    const pr = prNumberFromCommand("myk-pi-tools reviews address --json .pi/tmp/pr-42-reviews.json --set addressed", cwd);
    assert.equal(pr, 42);
  });
  it("reads the PR number from a store-session positional JSON via pr_url", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-pr-"));
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "qodo-943-abc1234.json"),
      JSON.stringify({ pr_url: "https://github.com/myk-org/pi-config/pull/943", findings: [] }),
    );
    const pr = prNumberFromCommand("uv run myk-pi-tools reviews store-session .pi/tmp/qodo-943-abc1234.json", cwd);
    assert.equal(pr, 943);
  });
  it("store-session with an unreadable or pr_url-less JSON yields null", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-pr-"));
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "tmp", "qodo-bad.json"), JSON.stringify({ findings: [] }));
    assert.equal(prNumberFromCommand("myk-pi-tools reviews store-session .pi/tmp/qodo-bad.json", cwd), null);
    assert.equal(prNumberFromCommand("myk-pi-tools reviews store-session .pi/tmp/gone.json", cwd), null);
  });
  it("no --json → null even when leftover pr-*-reviews.json files linger (final runs delete their own)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-pr-"));
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    // a STALE JSON from another PR must never be picked up by a fallback
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "pr-99-reviews.json"),
      JSON.stringify({ metadata: { pr_number: 99 } }),
    );
    assert.equal(prNumberFromCommand("myk-pi-tools reviews address --set addressed", cwd), null);
  });
  it("returns null when nothing is readable", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-pr-"));
    assert.equal(prNumberFromCommand("myk-pi-tools reviews address --json .pi/tmp/gone.json --set addressed", cwd), null);
    assert.equal(prNumberFromCommand("myk-pi-tools reviews address --set addressed", cwd), null);
    assert.equal(prNumberFromCommand(undefined, cwd), null);
  });
  it("a combined poll+store command resolves the PR from the session JSON — the --json 2>/dev/null redirect never wins (Qodo beb11c94)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-pr-"));
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "qodo-943-0d6ad31.json"),
      JSON.stringify({ pr_url: "https://github.com/myk-org/pi-config/pull/943", findings: [] }),
    );
    const command =
      "qodo read pr-review-session findings --pr-url https://github.com/myk-org/pi-config/pull/943 --json 2>/dev/null | head -1 > .pi/tmp/qodo-943-0d6ad31.json && " +
      "uv run myk-pi-tools reviews store-session .pi/tmp/qodo-943-0d6ad31.json";
    assert.equal(prNumberFromCommand(command, cwd), 943);
  });
  it("expands ${PROJECT_TMP_DIR} in a store-session path (Qodo 657c5633)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-pr-"));
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "qodo-77-abc.json"),
      JSON.stringify({ pr_url: "https://github.com/myk-org/demo/pull/77", findings: [] }),
    );
    const previous = process.env.PROJECT_TMP_DIR;
    process.env.PROJECT_TMP_DIR = path.join(cwd, ".pi", "tmp");
    try {
      const command = "uv run myk-pi-tools reviews store-session ${PROJECT_TMP_DIR}/qodo-77-abc.json";
      assert.equal(prNumberFromCommand(command, cwd), 77);
    } finally {
      if (previous === undefined) delete process.env.PROJECT_TMP_DIR;
      else process.env.PROJECT_TMP_DIR = previous;
    }
  });
});

// ── Ranking ────────────────────────────────────────────────────────────────

describe("rankFindings", () => {
  it("sorts critical/high first, then by id — no cap (distillLessons caps after extraction)", () => {
    const ranked = rankFindings([
      finding(7, "low"),
      finding(2, "high"),
      finding(1, "critical"),
      finding(9, "medium"),
      finding(4, "high"),
      finding(3, "critical"),
      finding(8, null),
    ]);
    assert.deepEqual(ranked.map((f) => f.id), [1, 3, 2, 4, 9, 7, 8]);
  });
});

// ── Deterministic distillation (script-only engine — no model) ─────────────

describe("extractFindingTitle", () => {
  it("un-buries the title from real Qodo-shaped bodies", () => {
    const qodoNumbered =
      '<img src="https://img.shields.io/badge/High-634FD1" alt="Action required">\n\n' +
      "1\\. Formatted tool permissions bypass pinned-rule protection <code>\ud83e\ude7e Bug</code> <code>\u2261 Correctness</code>\n\n" +
      "<pre>ONLY_PERMIT_RE requires the first character...</pre>";
    assert.equal(
      extractFindingTitle(qodoNumbered),
      "Formatted tool permissions bypass pinned-rule protection",
    );
  });
  it("lifts markdown-bold titles and strips emphasis", () => {
    const coderabbit = "**Formatted tool permissions bypass pinned-rule protection**\n\n<b><i>ONLY_PERMIT_RE</i></b> requires the first character after only";
    assert.equal(
      extractFindingTitle(coderabbit),
      "Formatted tool permissions bypass pinned-rule protection",
    );
  });
  it("skips badge, image, and URL-only lines", () => {
    assert.equal(extractFindingTitle('<img src="https://shields.io/badge/x">'), null);
    assert.equal(extractFindingTitle("![badge](https://img.example/x.svg)"), null);
    assert.equal(extractFindingTitle("https://example.com/finding/1"), null);
  });
  it("rejects fragments shorter than 15 chars and empty bodies", () => {
    assert.equal(extractFindingTitle("1\\. too short"), null);
    assert.equal(extractFindingTitle(""), null);
  });
  it("caps the title at 100 chars on one line", () => {
    const title = extractFindingTitle("**" + "y".repeat(150) + "** tail");
    assert.equal(title!.length, 100);
  });
});

describe("lessonFromFinding", () => {
  it("prefixes the repo-relative path and sanitizes to one line", () => {
    const lesson = lessonFromFinding(finding(1, "high", "**Missing redaction guard** on the endpoint\nsecond line"));
    assert.equal(lesson, "src/f1.py: Missing redaction guard on the endpoint");
  });
  it("prefers the stored title column over body extraction", () => {
    const lesson = lessonFromFinding(
      finding(1, "high", '<img src="https://badge">\nirrelevant body', "Stored clean title from the column"),
    );
    assert.equal(lesson, "src/f1.py: Stored clean title from the column");
  });
  it("returns null when no title can be extracted", () => {
    assert.equal(lessonFromFinding(finding(1, "high", '<img src="https://x">')), null);
  });
});

describe("distillLessons", () => {
  it("derives path-prefixed lessons, ranked by priority", () => {
    const lessons = distillLessons([
      finding(2, "medium", "Medium issue on the endpoint"),
      finding(1, "critical", "Critical issue on the endpoint"),
    ]);
    assert.deepEqual(lessons, [
      { findingIds: [1], text: "src/f1.py: Critical issue on the endpoint" },
      { findingIds: [2], text: "src/f2.py: Medium issue on the endpoint" },
    ]);
  });
  it("merges duplicate findings with identical path+title, keeping every finding id", () => {
    const a = finding(1, "critical", "Same title on the endpoint");
    const b = { ...finding(2, "high", "Same title on the endpoint"), path: "src/f1.py" };
    assert.deepEqual(distillLessons([a, b]), [{ findingIds: [1, 2], text: "src/f1.py: Same title on the endpoint" }]);
  });
  it("keeps same title under different paths separate", () => {
    const a = finding(1, "high", "Same title on the endpoint");
    const b = { ...finding(2, "high", "Same title on the endpoint"), path: "src/other.py" };
    assert.equal(distillLessons([a, b]).length, 2);
  });
  it("excludes completed lessons upstream of the cap — the next fire walks forward (Qodo 16d84431)", () => {
    const findings = [1, 2, 3, 4, 5, 6, 7].map((id) => finding(id, "high", `Distinct issue number ${id} on the endpoint`));
    const first = distillLessons(findings);
    assert.equal(first.length, 5, "per-fire cap");
    const completed = new Set(first.map((l) => l.text));
    const second = distillLessons(findings, completed);
    assert.equal(second.length, 2, "remaining findings distill on the next fire");
    assert.deepEqual(
      second.map((l) => l.findingIds),
      [[6], [7]],
      "the same top slice is never re-picked",
    );
    for (const lesson of second) assert.ok(!completed.has(lesson.text), "no overlap with written lessons");
    const third = distillLessons(findings, new Set([...completed, ...second.map((l) => l.text)]));
    assert.equal(third.length, 0, "fully distilled review yields no pending lessons");
  });
  it("keeps distinct findings whose titles first differ past the 100-char display cap", () => {
    // Same path; titles identical for the first 100+ chars, differing only at
    // the tail — the truncated DISPLAY text is the same, but the untruncated
    // identity keeps them two distinct issues (no false recurrence).
    const base = "A very long finding title that stays identical for well over one hundred characters and then";
    const a = finding(1, "high", `${base} diverges alpha`);
    const b = finding(2, "high", `${base} diverges beta`);
    const lessons = distillLessons([a, b]);
    assert.equal(lessons.length, 2);
    assert.deepEqual(lessons.map((l) => l.findingIds), [[1], [2]]);
    // Truncated lesson texts carry a stable digest suffix of the full line,
    // so the two memories stay distinct instead of the second reinforcing
    // the first (identical 100-char prefixes must not collide).
    assert.notEqual(lessons[0]!.text, lessons[1]!.text, "distinct lesson texts");
    for (const l of lessons) {
      assert.ok(l.text.length <= 100, `lesson capped: ${l.text.length}`);
      assert.match(l.text, /~[0-9a-f]{8}$/, "truncated lessons carry a digest suffix");
    }
  });
  it("successive memory writes of >100-char twins never exact-collide — digest keeps texts distinct", async () => {
    const base = "A very long finding title that stays identical for well over one hundred characters and then";
    const cwd = makeCwd();
    const write = async (finding: AddressedFinding) =>
      writeLessonsToMemory(cwd, distillLessons([finding]), REPO);
    const first = await write(finding(1, "high", `${base} diverges alpha`));
    assert.equal(first.added, 1);
    const second = await write(finding(2, "high", `${base} diverges beta`));
    // The digest suffix prevents the EXACT-text collision (the second twin
    // used to reinforce the first purely because both truncated to the same
    // 100-char prefix). If the memory system's near-duplicate gate (issue
    // #915) still judges the twins similar enough to reinforce, that is its
    // intended recurrence semantics — either way the write completes and is
    // never lost or rejected.
    assert.equal(second.added + second.reinforced, 1, "added or near-duplicate reinforced");
    assert.equal(second.rejected, 0);
    assert.equal(second.completed.length, 1, "retry bookkeeping records the completion");
  });
  it("skips findings whose body yields no title — eligible findings below them still distill", () => {
    const lessons = distillLessons([
      finding(1, "high", '<img src="https://badge">'),
      finding(2, "high", "Real issue on the endpoint"),
    ]);
    assert.deepEqual(lessons, [{ findingIds: [2], text: "src/f2.py: Real issue on the endpoint" }]);
  });
  it("caps at 5 lessons AFTER extraction — unusable bodies never consume slots", () => {
    const findings = [
      ...Array.from({ length: 6 }, (_, i) => finding(i + 1, "critical", '<img src="https://badge">')), // unusable
      ...Array.from({ length: 6 }, (_, i) => finding(i + 10, "high", `Eligible issue number ${i} on the endpoint`)),
    ];
    const lessons = distillLessons(findings);
    assert.equal(lessons.length, 5);
    assert.ok(lessons.every((l) => l.text.includes("Eligible issue")), "cap filled by eligible findings only");
  });
  it("returns [] for empty findings", () => {
    assert.deepEqual(distillLessons([]), []);
  });
});

// ── Reload-status stamp ─────────────────────────────────────────────────────

describe("reload-status stamp", () => {
  it("moduleMtimeStamp returns a valid ISO timestamp for the running module", () => {
    const stamp = moduleMtimeStamp();
    assert.ok(stamp, "stamp returned");
    assert.ok(!Number.isNaN(Date.parse(stamp!)), `valid ISO: ${stamp}`);
  });
  it("moduleMtimeStamp is fail-soft null when the stat lookup throws", () => {
    assert.equal(moduleMtimeStamp(path.join(os.tmpdir(), "no-such-module-file.ts")), null);
  });
  it("emitReviewLearningLoaded logs review_learning_loaded with the stamp (injectable logger)", () => {
    const events: Array<{ event: string; data?: unknown }> = [];
    emitReviewLearningLoaded({
      info: (event: string, data?: unknown) => events.push({ event, data }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, "review_learning_loaded");
    const mtime = (events[0]!.data as { moduleMtime: string }).moduleMtime;
    assert.ok(!Number.isNaN(Date.parse(mtime)), `valid ISO mtime: ${mtime}`);
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
  it("skips an existing entry with matching derivedFrom — no evidence inflation on re-fires", async () => {
    const cwd = makeCwd();
    const provenance = findingProvenance(101, REPO);
    seedLessonEntry(cwd, "existing lesson text", provenance);
    const result = await writeLessonsToMemory(cwd, [{ findingIds: [101], text: "freshly distilled wording" }], REPO);
    assert.equal(result.skipped, 1);
    assert.equal(result.added, 0);
    assert.equal(result.reinforced, 0);
    // no new topic line, evidence NOT bumped (re-fire is not a recurrence)
    const entries = readAllTopicEntries(cwd).filter((e) => e.category === "lesson");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.text, "existing lesson text");
    const hash = entryHash("- [lesson] existing lesson text");
    assert.equal(loadScores(cwd).entries[hash]!.evidenceCount, 1);
  });
  it("adds a new lesson with provenance and informs", async () => {
    const cwd = makeCwd();
    const result = await writeLessonsToMemory(cwd, [{ findingIds: [202], text: "new distilled lesson" }], REPO);
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
  it("a NEW finding with the same lesson text is a real recurrence — reinforced via duplicate detection", async () => {
    const cwd = makeCwd();
    const first = await writeLessonsToMemory(cwd, [{ findingIds: [301], text: "same issue keeps recurring" }], REPO);
    assert.equal(first.added, 1);
    // finding 302 = the same issue re-raised in a NEW review (different id, same text)
    const second = await writeLessonsToMemory(cwd, [{ findingIds: [302], text: "same issue keeps recurring" }], REPO);
    assert.equal(second.reinforced, 1);
    assert.equal(second.added, 0);
    assert.equal(readAllTopicEntries(cwd).filter((e) => e.category === "lesson").length, 1, "still one topic line");
    const hash = entryHash("- [lesson] same issue keeps recurring");
    assert.equal(loadScores(cwd).entries[hash]!.evidenceCount, 2, "recurrence bumps evidence");
  });
  it("caps writes at 5 per fire", async () => {
    const cwd = makeCwd();
    const lessons = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ findingIds: [id], text: `lesson ${id}` }));
    const result = await writeLessonsToMemory(cwd, lessons, REPO);
    assert.equal(result.added + result.reinforced + result.rejected + result.skipped, 5);
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

/**
 * Fire EVERY registered tool_result handler and collect return values —
 * identifies handlers by observable behavior instead of registration order,
 * so adding or reordering an unrelated handler cannot break these tests.
 */
function fireToolResult(
  handlers: Map<string, Handler[]>,
  event: Parameters<Handler>[0],
  ctx: Parameters<Handler>[1],
): Array<unknown> {
  return (handlers.get("tool_result") ?? []).map((h) => h(event, ctx));
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

const lessonsIn = (cwd: string) => readAllTopicEntries(cwd).filter((e) => e.category === "lesson");

describe("review-learning hook", () => {
  it("distills on a non-error bash tool_result for reviews address", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    const results = fireToolResult(handlers, { toolName: "bash", input: { command: "uv run --group dev myk-pi-tools reviews address --json x --set addressed" }, isError: false }, { cwd });
    assert.ok(results.every((r) => r === undefined), "bash watcher returns no content");
    assert.ok(await waitFor(() => lessonsIn(cwd).length > 0), "lesson written");
    assert.deepEqual(lessonsIn(cwd).map((e) => e.text), ["src/api.py: Older PR-10 review finding"]);
  });
  it("distills on a reviews store-session tool_result naming the PR via pr_url", async () => {
    const cwd = cwdWithDb();
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "qodo-12-abc1234.json"),
      JSON.stringify({ pr_url: "https://github.com/myk-org/demo/pull/12", findings: [] }),
    );
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    const results = fireToolResult(handlers, {
      toolName: "bash",
      input: { command: "uv run myk-pi-tools reviews store-session .pi/tmp/qodo-12-abc1234.json" },
      isError: false,
    }, { cwd });
    assert.ok(results.every((r) => r === undefined), "bash watcher returns no content");
    assert.ok(await waitFor(() => lessonsIn(cwd).length > 0), "lesson written from the session-stored review");
    assert.deepEqual(lessonsIn(cwd).map((e) => e.text), ["src/api.py: Unhandled None on the endpoint response"]);
  });
  it("a store-session fire for a multi-round PR distills EVERY review row — earlier commit groups are not skipped (Qodo 16d84431)", async () => {
    const cwd = cwdWithDb();
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "qodo-10-abc1234.json"),
      JSON.stringify({ pr_url: "https://github.com/myk-org/demo/pull/10", findings: [] }),
    );
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    fireToolResult(handlers, {
      toolName: "bash",
      input: { command: "uv run myk-pi-tools reviews store-session .pi/tmp/qodo-10-abc1234.json" },
      isError: false,
    }, { cwd });
    // PR 10 has two review rows (ids 1 and 4, 3 addressed findings total):
    // both groups must distill — the highest-ID row alone is not enough.
    assert.ok(
      await waitFor(() => lessonsIn(cwd).length >= 3),
      "lessons from every review row of the PR",
    );
    const texts = lessonsIn(cwd).map((e) => e.text).sort();
    assert.deepEqual(texts, [
      "src/api.py: Missing strip_sensitive_from_response on the endpoint",
      "src/api.py: Older PR-10 review finding",
      "src/api.py: Same redaction gap on the list endpoint",
    ]);
  });
  it("one fire drains a multi-review PR in budgeted bursts — auto-continuation completes the walk (Qodo 062e8e28, eceb273e)", async () => {
    const cwd = makeCwd();
    const dataDir = path.join(cwd, ".pi", "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "reviews.db");
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    const insertReview = db.prepare(
      "INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) VALUES (55, 'myk-org', 'demo', ?, ?)",
    );
    const insertComment = db.prepare(
      "INSERT INTO comments (review_id, source, path, line, body, priority, status) VALUES (?, 'qodo', ?, ?, ?, 'high', 'addressed')",
    );
    // review 1: 4 findings, review 2: 3 findings → 7 DISTINCT lessons
    // (titles differ enough that the memory write path never merges them).
    const roundOne = [
      "Missing validation on the submit handler",
      "Parser drops trailing fields on records",
      "Retries lack backoff on the worker loop",
      "Cache never invalidates on rotation",
    ];
    const roundTwo = [
      "Exporter buffers rows without a flush",
      "Health check ignores the readiness port",
      "Shutdown skips draining in-flight work",
    ];
    insertReview.run("sha-r1", "2026-01-01T00:00:00Z");
    roundOne.forEach((body, i) => insertComment.run(1, `src/a${i}.py`, i, body));
    insertReview.run("sha-r2", "2026-01-02T00:00:00Z");
    roundTwo.forEach((body, i) => insertComment.run(2, `src/b${i}.py`, i, body));
    db.close();
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    const sessionJson = path.join(cwd, ".pi", "tmp", "qodo-55.json");
    fs.writeFileSync(sessionJson, JSON.stringify({ pr_url: "https://github.com/myk-org/demo/pull/55", findings: [] }));
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    const fire = () =>
      fireToolResult(handlers, {
        toolName: "bash",
        input: { command: `uv run myk-pi-tools reviews store-session ${sessionJson}` },
        isError: false,
      }, { cwd });
    fire();
    // One trigger drains the PR: bursts are capped at 5 writes, and a burst
    // with remaining lessons schedules its own continuation (Qodo eceb273e)
    // — a session's FINAL store must not leave lessons unwritten.
    assert.ok(await waitFor(() => lessonsIn(cwd).length >= 7, 6000), "auto-continuation drains all lessons");
    assert.equal(lessonsIn(cwd).length, 7, "all lessons written, no duplicates");
    const texts = lessonsIn(cwd).map((e) => e.text);
    assert.equal(new Set(texts).size, texts.length, "no duplicate lesson lines");
    // A re-fire is a stable no-op.
    fire();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(lessonsIn(cwd).length, 7);
  });
  it("a fork-hosted session still distills — rows are queried under the pr_url repo when origin names a fork (Qodo befc495a)", async () => {
    const cwd = cwdWithDb(); // rows under myk-org/demo
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "qodo-12.json"),
      JSON.stringify({ pr_url: "https://github.com/myk-org/demo/pull/12", findings: [] }),
    );
    const { pi, handlers } = mockPi();
    // origin is a FORK — the checkout's repo does not match the stored rows' repo.
    createReviewLearning({ repoInfo: () => ({ owner: "somefork", repo: "demo" }) }).register(pi as any);
    fireToolResult(handlers, {
      toolName: "bash",
      input: { command: "uv run myk-pi-tools reviews store-session .pi/tmp/qodo-12.json" },
      isError: false,
    }, { cwd });
    assert.ok(await waitFor(() => lessonsIn(cwd).length > 0), "pr_url repo fallback found the stored rows");
    assert.deepEqual(lessonsIn(cwd).map((e) => e.text), ["src/api.py: Unhandled None on the endpoint response"]);
  });

  it("a finding APPENDED to an already-distilled review row distills on the next store-session fire (Qodo 16d84431)", async () => {
    const cwd = cwdWithDb();
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    const sessionJson = path.join(cwd, ".pi", "tmp", "qodo-12-abc1234.json");
    fs.writeFileSync(sessionJson, JSON.stringify({ pr_url: "https://github.com/myk-org/demo/pull/12", findings: [] }));
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    const fire = () =>
      fireToolResult(handlers, {
        toolName: "bash",
        input: { command: `uv run myk-pi-tools reviews store-session ${sessionJson}` },
        isError: false,
      }, { cwd });
    fire();
    assert.ok(await waitFor(() => lessonsIn(cwd).length > 0), "first fire distills the stored review");
    // A later round appends a finding to the SAME review row (store-session's
    // same-commit append path).
    const db = new DatabaseSync(path.join(cwd, ".pi", "data", "reviews.db"));
    db.prepare(
      "INSERT INTO comments (review_id, source, path, line, body, priority, status) VALUES (3, 'qodo', 'src/new.py', 1, 'Late finding appended on the endpoint', 'high', 'addressed')",
    ).run();
    db.close();
    fire();
    assert.ok(
      await waitFor(() => lessonsIn(cwd).some((e) => e.text === "src/new.py: Late finding appended on the endpoint")),
      "appended finding distills on the re-fire",
    );
  });
  it("a store-session fire whose session JSON is unreadable never falls back to the repo-newest review (Qodo 86f1855b)", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    fireToolResult(handlers, {
      toolName: "bash",
      input: { command: "uv run myk-pi-tools reviews store-session .pi/tmp/gone-qodo.json" },
      isError: false,
    }, { cwd });
    // The newest review for the repo exists (id 4) and would distill under a
    // repo-wide fallback — it must NOT: an unreadable session JSON is an
    // error, not license to teach another PR's findings.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(lessonsIn(cwd).length, 0, "no fallback distillation");
  });
  it("distills the PR named by the command's --json file, not the newest-for-repo", async () => {
    const cwd = cwdWithDb();
    // command addresses PR 12 — its newest review (id 3) must win over review 4
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "pr-12-reviews.json"),
      JSON.stringify({ metadata: { owner: "myk-org", repo: "demo", pr_number: 12 } }),
    );
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    fireToolResult(handlers, {
      toolName: "bash",
      input: { command: "myk-pi-tools reviews address --json .pi/tmp/pr-12-reviews.json --set addressed" },
      isError: false,
    }, { cwd });
    assert.ok(await waitFor(() => lessonsIn(cwd).length > 0), "lesson written");
    assert.deepEqual(lessonsIn(cwd).map((e) => e.text), ["src/api.py: Unhandled None on the endpoint response"]);
  });
  it("--json naming a PR with no stored review is a no-op — never another PR's review", async () => {
    const cwd = cwdWithDb();
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "pr-999-reviews.json"),
      JSON.stringify({ metadata: { owner: "myk-org", repo: "demo", pr_number: 999 } }),
    );
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    fireToolResult(handlers, {
      toolName: "bash",
      input: { command: "myk-pi-tools reviews address --json .pi/tmp/pr-999-reviews.json --set addressed" },
      isError: false,
    }, { cwd });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(lessonsIn(cwd).length, 0, "no review row for PR 999 — nothing distilled, no cross-PR fallback");
  });
  it("an already-distilled explicit PR is a no-op even when a NEWER undistilled review exists for another PR", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    fs.mkdirSync(path.join(cwd, ".pi", "tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".pi", "tmp", "pr-12-reviews.json"),
      JSON.stringify({ metadata: { owner: "myk-org", repo: "demo", pr_number: 12 } }),
    );
    const fire = (pr: number) =>
      fireToolResult(handlers, {
        toolName: "bash",
        input: { command: `myk-pi-tools reviews address --json .pi/tmp/pr-${pr}-reviews.json --set addressed` },
        isError: false,
      }, { cwd });
    fire(12);
    assert.ok(await waitFor(() => lessonsIn(cwd).length > 0), "first fire distills PR 12");
    // review 4 (PR 10, newer, undistilled) exists — a later partial re-run
    // of PR 12 must NOT distill it
    fire(12);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(
      lessonsIn(cwd).map((e) => e.text),
      ["src/api.py: Unhandled None on the endpoint response"],
      "revisit of PR 12 stays a no-op — no other PR distilled",
    );
  });
  it("re-firing for the same review is a no-op — no duplicate lessons, no evidence inflation", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    fireToolResult(handlers, { toolName: "bash", input: { command: "myk-pi-tools reviews address --set addressed" }, isError: false }, { cwd });
    assert.ok(await waitFor(() => lessonsIn(cwd).length > 0), "first fire writes");
    const hash = entryHash("- [lesson] src/api.py: Older PR-10 review finding");
    const evidenceAfterFirst = loadScores(cwd).entries[hash]!.evidenceCount;
    fireToolResult(handlers, { toolName: "bash", input: { command: "myk-pi-tools reviews address --set addressed" }, isError: false }, { cwd });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(lessonsIn(cwd).length, 1, "no duplicates");
    assert.equal(loadScores(cwd).entries[hash]!.evidenceCount, evidenceAfterFirst, "no evidence inflation");
  });
  it("rejected lesson writes retry ONLY the unwritten lessons — no evidence inflation", async () => {
    // one review (PR 7) with two distinct findings → two lessons
    const cwd = makeCwd();
    const dbPath = path.join(cwd, ".pi", "data", "reviews.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    db.prepare(
      "INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) VALUES (7, 'myk-org', 'demo', 'sha-7', '2026-01-01T00:00:00Z')",
    ).run();
    const insert = db.prepare(
      "INSERT INTO comments (review_id, source, path, line, body, priority, status) VALUES (1, 'qodo', 'src/api.py', ?, ?, 'high', 'addressed')",
    );
    insert.run(10, "First lesson title on the endpoint");
    insert.run(20, "Second lesson title on the handler");
    db.close();

    const dataDir = path.join(cwd, ".pi", "data");
    const attempts: string[][] = [];
    let rejectSecond = true;
    const writeLessons = async (_cwd: string, lessons: DistilledLesson[]) => {
      attempts.push(lessons.map((l) => l.text));
      // while rejecting, the LAST pending lesson is the rejected one
      return rejectSecond
        ? {
            added: lessons.length - 1,
            reinforced: 0,
            rejected: 1,
            skipped: 0,
            completed: lessons.slice(0, -1).map((l) => l.text),
          }
        : { added: lessons.length, reinforced: 0, rejected: 0, skipped: 0, completed: lessons.map((l) => l.text) };
    };
    const { distill } = createReviewLearning({ repoInfo: () => REPO, writeLessons });
    await distill(cwd); // fire 1: both attempted, second rejected
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.length, 2, "first fire attempts both lessons");
    assert.equal(loadReviewLessons(dataDir).get(1)?.size, 1, "the completed lesson is recorded");
    assert.equal(loadDistilledReviews(dataDir).size, 0, "review NOT marked distilled");
    await distill(cwd); // fire 2: only the rejected lesson retried
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]!.length, 1, "retry attempts ONLY the unwritten lesson");
    assert.equal(attempts[1]![0], attempts[0]![1], "and it is the rejected one");
    rejectSecond = false;
    await distill(cwd); // fire 3: succeeds → review completes
    assert.equal(attempts.length, 3);
    assert.equal(loadDistilledReviews(dataDir).size, 1, "success marks the review distilled");
    await distill(cwd); // fire 4: marked → no-op
    assert.equal(attempts.length, 3, "marked review is not re-attempted");
  });

  it("overlapping distill fires for the same review serialize — no double lesson writes", async () => {
    // one review (PR 8) with two distinct findings → two lessons
    const cwd = makeCwd();
    const dbPath = path.join(cwd, ".pi", "data", "reviews.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    db.prepare(
      "INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) VALUES (8, 'myk-org', 'demo', 'sha-8', '2026-01-01T00:00:00Z')",
    ).run();
    const insert = db.prepare(
      "INSERT INTO comments (review_id, source, path, line, body, priority, status) VALUES (1, 'qodo', 'src/api.py', ?, ?, 'high', 'addressed')",
    );
    insert.run(10, "First overlapping title on the endpoint");
    insert.run(20, "Second overlapping title on the handler");
    db.close();

    const attempts: string[][] = [];
    const writeLessons = async (_cwd: string, lessons: DistilledLesson[]) => {
      attempts.push(lessons.map((l) => l.text));
      // slow write — the second concurrent fire MUST wait behind it instead
      // of reading the pre-write completed-lesson state
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { added: lessons.length, reinforced: 0, rejected: 0, skipped: 0, completed: lessons.map((l) => l.text) };
    };
    const { distill } = createReviewLearning({ repoInfo: () => REPO, writeLessons });
    await Promise.all([distill(cwd), distill(cwd)]); // two overlapping fires
    assert.equal(attempts.length, 1, "second fire serializes behind the first, re-reads state, and no-ops");
    assert.equal(attempts[0]!.length, 2, "first fire writes both lessons exactly once");
    assert.equal(loadDistilledReviews(path.join(cwd, ".pi", "data")).size, 1, "review marked distilled");
  });

  it("no-ops when the setting is disabled", async () => {
    const cwd = cwdWithDb();
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "pi-config-settings.json"), JSON.stringify({ review_learning: false }));
    const { distill } = createReviewLearning({ repoInfo: () => REPO });
    await distill(cwd);
    assert.equal(readAllTopicEntries(cwd).length, 0);
  });
  it("distills when the setting is enabled (default)", async () => {
    const cwd = cwdWithDb();
    const { distill } = createReviewLearning({ repoInfo: () => REPO });
    await distill(cwd);
    const lessons = lessonsIn(cwd);
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0]!.text, "src/api.py: Older PR-10 review finding");
  });
  it("ignores error results, other tools, and non-address commands", async () => {
    const cwd = cwdWithDb();
    const { pi, handlers } = mockPi();
    createReviewLearning({ repoInfo: () => REPO }).register(pi as any);
    fireToolResult(handlers, { toolName: "bash", input: { command: "myk-pi-tools reviews address --json x" }, isError: true }, { cwd });
    fireToolResult(handlers, { toolName: "read", input: { path: "x" }, isError: false }, { cwd });
    fireToolResult(handlers, { toolName: "bash", input: { command: "myk-pi-tools reviews store x.json" }, isError: false }, { cwd });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(readAllTopicEntries(cwd).length, 0);
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

it("markReviewDistilled is idempotent — repeated fires never duplicate ids", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-mark-"));
  const dataDir = path.join(cwd, ".pi", "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const { markReviewDistilled, loadDistilledReviews } = await import(
    "../../../extensions/orchestrator/review-learning.js"
  );

  markReviewDistilled(dataDir, 42);
  markReviewDistilled(dataDir, 42);
  markReviewDistilled(dataDir, 42);

  const distilled = loadDistilledReviews(dataDir);
  assert.equal(distilled.size, 1, "no duplicate ids accumulate across fires");
  assert.ok(distilled.has(42));
});
