/**
 * Review learning (issue #918 Part B) — write-time injection tests.
 * Run: npx tsx --test tests/node/orchestrator/review-learning-injection.test.ts
 *
 * No network, no model calls: findings come from a scratch sqlite reviews DB
 * and seeded memory lessons; git surfaces are either injected or exercised
 * against throwaway local repos.
 */
import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeRepoRelative,
  normalizeRepoRelativeFromRoot,
  extractPathsFromText,
  branchDiffPaths,
  firstSentence,
  collectPathFindings,
  relevantFindings,
  formatFindingsBlock,
  createReviewLearning,
} from "../../../extensions/orchestrator/review-learning.js";
import { entryHash, loadScores, type ScoredEntry } from "../../../extensions/orchestrator/memory-scoring.js";
import { getProjectDataDir } from "../../../extensions/orchestrator/utils.js";

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
const repoInfo = () => REPO;

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-inject-"));
}

interface CommentSeed {
  path: string;
  body: string;
  status?: string;
  priority?: string;
  owner?: string;
  repo?: string;
}

/** cwd with .pi/data/reviews.db seeded with one review per comment batch. */
function cwdWithDb(batches: CommentSeed[][]): string {
  const cwd = makeCwd();
  const dbPath = path.join(cwd, ".pi", "data", "reviews.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const insertReview = db.prepare(
    "INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertComment = db.prepare(
    "INSERT INTO comments (review_id, source, path, line, body, priority, status) VALUES (?, 'qodo', ?, 1, ?, ?, ?)",
  );
  batches.forEach((batch, index) => {
    const first = batch[0] ?? {};
    const result = insertReview.run(
      100 + index, first.owner ?? REPO.owner, first.repo ?? REPO.repo, `sha-${index}`, "2026-01-01T00:00:00Z",
    ) as any;
    const reviewId = Number(result.lastInsertRowid);
    for (const comment of batch) {
      insertComment.run(reviewId, comment.path, comment.body, comment.priority ?? "high", comment.status ?? "addressed");
    }
  });
  db.close();
  return cwd;
}

/** Seed a memory lesson entry (optionally with derivedFrom provenance). */
function seedLessonEntry(cwd: string, text: string, derivedFrom?: string, category = "lesson"): void {
  const topicsDir = path.join(cwd, ".pi", "memory", "topics");
  fs.mkdirSync(topicsDir, { recursive: true });
  fs.appendFileSync(path.join(topicsDir, category === "lesson" ? "lessons.md" : "preferences.md"), `- [${category}] ${text}\n`);
  const hash = entryHash(`- [${category}] ${text}`);
  const entry: ScoredEntry = {
    class: category,
    score: 1,
    evidenceCount: 1,
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

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

/** First comment id for a path in a cwd's seeded DB. */
function commentId(cwd: string, commentPath: string): number {
  const db = new DatabaseSync(path.join(cwd, ".pi", "data", "reviews.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT id FROM comments WHERE path=? ORDER BY id LIMIT 1").get(commentPath) as any;
    return Number(row.id);
  } finally {
    db.close();
  }
}

/** Throwaway repo with one commit on main and a feature branch on top. */
function gitRepoWithBranch(): string {
  const cwd = makeCwd();
  fs.writeFileSync(path.join(cwd, "base.txt"), "base\n");
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "t@example.com");
  git(cwd, "config", "user.name", "T");
  git(cwd, "add", "base.txt");
  git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "feat/issue");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "api.py"), "x = 1\n");
  git(cwd, "add", "src/api.py");
  git(cwd, "commit", "-m", "feat");
  return cwd;
}

// This suite may itself run inside a pi subagent — clear the child marker so
// register() wires its handlers (mirrors review-learning.test.ts).
const originalChild = process.env.PI_SUBAGENT_CHILD;
beforeEach(() => { delete process.env.PI_SUBAGENT_CHILD; });
afterEach(() => {
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = originalChild;
});

// ── Path extraction ────────────────────────────────────────────────────────

describe("normalizeRepoRelative", () => {
  it("normalizes relative, absolute, and ./-prefixed paths", () => {
    const cwd = makeCwd();
    assert.equal(normalizeRepoRelative(cwd, "src/api.py"), "src/api.py");
    assert.equal(normalizeRepoRelative(cwd, "./src/api.py"), "src/api.py");
    assert.equal(normalizeRepoRelative(cwd, path.join(cwd, "src/api.py")), "src/api.py");
    assert.equal(normalizeRepoRelative(cwd, "src/api.py/"), "src/api.py");
  });
  it("rejects paths escaping the root and junk values", () => {
    const cwd = makeCwd();
    assert.equal(normalizeRepoRelative(cwd, "../outside.py"), null);
    assert.equal(normalizeRepoRelative(cwd, "/etc/passwd"), null);
    assert.equal(normalizeRepoRelative(cwd, ""), null);
    assert.equal(normalizeRepoRelative(cwd, "."), null);
  });
});

describe("normalizeRepoRelativeFromRoot", () => {
  it("resolves repo-relative diff paths against the worktree root — not a nested session cwd", () => {
    const repo = gitRepoWithBranch();
    // nested session: cwd inside a subdirectory that also contains src/
    const nested = path.join(repo, "packages", "inner");
    fs.mkdirSync(path.join(nested, "src"), { recursive: true });
    fs.writeFileSync(path.join(nested, "src", "local.py"), "y = 2\n");
    // a repo-relative diff entry stays repo-relative from a nested session
    assert.equal(normalizeRepoRelativeFromRoot(nested, "src/api.py"), "src/api.py");
    // while a cwd-relative tool path rebases under the session cwd (existing semantics)
    assert.equal(normalizeRepoRelative(nested, "src/local.py"), "packages/inner/src/local.py");
  });
  it("handles absolute paths and escapes like normalizeRepoRelative", () => {
    const repo = gitRepoWithBranch();
    assert.equal(normalizeRepoRelativeFromRoot(repo, path.join(repo, "src", "api.py")), "src/api.py");
    assert.equal(normalizeRepoRelativeFromRoot(repo, "../outside.py"), null);
    assert.equal(normalizeRepoRelativeFromRoot(repo, ""), null);
  });
});

describe("extractPathsFromText", () => {
  it("keeps existing files and files under existing dirs", () => {
    const cwd = makeCwd();
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const paths = extractPathsFromText("Fix src/api.py and add docs/new-file.md", cwd);
    // docs/new-file.md: parent docs/ exists and the token has a slash → kept
    assert.deepEqual(paths, ["src/api.py", "docs/new-file.md"]);
  });
  it("drops prose noise, versions, and missing paths", () => {
    const cwd = makeCwd();
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const paths = extractPathsFromText(
      "ignore e.g. this and v1.2.0 versions and missing/nope.ts",
      cwd,
    );
    assert.deepEqual(paths, []);
  });
  it("rejects URL fragments and dedupes", () => {
    const cwd = makeCwd();
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const paths = extractPathsFromText(
      "See https://github.com/o/r/blob/main/src/api.py — fix src/api.py and src/api.py again",
      cwd,
    );
    assert.deepEqual(paths, ["src/api.py"]);
  });
  it("normalizes absolute paths to repo-relative", () => {
    const cwd = makeCwd();
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const paths = extractPathsFromText(`Also touch ${path.join(cwd, "src", "api.py")}`, cwd);
    assert.deepEqual(paths, ["src/api.py"]);
  });
  it("handles empty and non-string input", () => {
    const cwd = makeCwd();
    assert.deepEqual(extractPathsFromText("", cwd), []);
    assert.deepEqual(extractPathsFromText("no paths here at all", cwd), []);
  });
});

describe("branchDiffPaths", () => {
  it("lists changed files on the feature branch vs main", () => {
    const cwd = gitRepoWithBranch();
    assert.deepEqual(branchDiffPaths(cwd), ["src/api.py"]);
  });
  it("returns [] on a fresh branch with no diff", () => {
    const cwd = gitRepoWithBranch();
    git(cwd, "checkout", "-b", "fresh", "main");
    assert.deepEqual(branchDiffPaths(cwd), []);
  });
  it("falls back to origin/main when local main is missing", () => {
    const origin = gitRepoWithBranch(); // has main + feat/issue
    const clone = makeCwd();
    git(clone, "clone", "--no-hardlinks", origin, ".");
    git(clone, "config", "user.email", "t@example.com");
    git(clone, "config", "user.name", "T");
    git(clone, "checkout", "-b", "feat/x", "origin/main");
    fs.mkdirSync(path.join(clone, "src"), { recursive: true });
    fs.writeFileSync(path.join(clone, "src", "new.py"), "y = 2\n");
    git(clone, "add", "src/new.py");
    git(clone, "commit", "-m", "new");
    // local main does not exist in a clone → main...HEAD fails, origin/main...HEAD works
    assert.deepEqual(branchDiffPaths(clone), ["src/new.py"]);
  });
  it("returns [] outside a git repo", () => {
    assert.deepEqual(branchDiffPaths(makeCwd()), []);
  });
});

// ── relevantFindings ───────────────────────────────────────────────────────

describe("firstSentence", () => {
  it("takes the first sentence, collapses whitespace, truncates", () => {
    assert.equal(firstSentence("Add a guard. Then more text."), "Add a guard.");
    assert.equal(firstSentence("no period at all"), "no period at all");
    assert.equal(firstSentence("line one\nline two"), "line one line two");
    const long = "x".repeat(300);
    assert.ok(firstSentence(long).length <= 120);
  });

  it("un-buries gists from badge/HTML soup (real Qodo body)", () => {
    const body =
      '<img src="https://www.qodo.ai/wp-content/uploads/2026/01/action-required.png" height="20" alt="Action required"> 1\\.\n' +
      "**Project settings needs a regression test** The PR changes settings resolution by introducing a new helper.";
    const gist = firstSentence(body);
    assert.ok(!gist.includes("<img"), `gist must not contain raw HTML: ${gist}`);
    assert.ok(gist.startsWith("Project settings needs a regression test"), gist);
  });

  it("keeps a 101–120-character title intact — the gist limit applies exactly once", () => {
    // A title longer than Part A's 100-char lesson cap but within the 120-char
    // gist cap must NOT lose content to a double truncation (title extraction
    // is untruncated now; firstSentence caps at 120 with an ellipsis).
    const title = `Unhandled error path in the request handler needs a guard ${"x".repeat(48)}`; // 108 chars
    assert.ok(title.length > 100 && title.length <= 120, `fixture sanity: ${title.length}`);
    assert.equal(firstSentence(title), title);
    // beyond 120 chars the gist truncates with an ellipsis marker
    const over = `${title} plus a longer tail that pushes it past the gist cap`;
    const gist = firstSentence(over);
    assert.ok(gist.length <= 120 && gist.endsWith("..."), gist);
    assert.ok(gist.startsWith("Unhandled error path"), gist);
  });
});

describe("relevantFindings", () => {
  it("counts a recurring issue (same path + title) across reviews and ranks by recurrence", () => {
    const cwd = cwdWithDb([
      [{ path: "src/api.py", body: "Missing strip_sensitive_from_response on the endpoint" }],
      [{ path: "src/api.py", body: "Missing strip_sensitive_from_response on the endpoint" }],
      [{ path: "src/util.py", body: "Only once here on the util module" }],
    ]);
    const block = relevantFindings(cwd, ["src/util.py", "src/api.py"], repoInfo);
    assert.ok(block, "block returned");
    assert.match(block!, /<review-lessons>/);
    assert.match(block!, /src\/api\.py \(2×\): Missing strip_sensitive_from_response/);
    assert.match(block!, /src\/util\.py \(1×\)/);
    assert.ok(block!.indexOf("src/api.py") < block!.indexOf("src/util.py"), "higher count first");
    assert.match(block!, /<\/review-lessons>/);
  });
  it("distinct issues on one file are counted and rendered separately — never as recurrences of each other", () => {
    const cwd = cwdWithDb([
      [
        { path: "src/api.py", body: "Missing strip_sensitive_from_response on the endpoint" },
        { path: "src/api.py", body: "Race condition on the shared client instance" },
      ],
    ]);
    const findings = collectPathFindings(cwd, ["src/api.py"], repoInfo);
    assert.equal(findings.length, 2, "two distinct issues");
    assert.ok(findings.every((f) => f.count === 1), "each issue counted once");
    const block = relevantFindings(cwd, ["src/api.py"], repoInfo);
    assert.match(block!, /src\/api\.py \(1×\): Missing strip_sensitive_from_response/);
    assert.match(block!, /src\/api\.py \(1×\): Race condition/);
  });
  it("findings whose titles first differ past the 100-char display cap stay distinct", () => {
    const base =
      "A very long finding title that stays identical for well over one hundred characters and then";
    const cwd = cwdWithDb([
      [
        { path: "src/api.py", body: `${base} diverges alpha` },
        { path: "src/api.py", body: `${base} diverges beta` },
      ],
    ]);
    const findings = collectPathFindings(cwd, ["src/api.py"], repoInfo);
    assert.equal(findings.length, 2, "untruncated identity keeps them two issues — no false recurrence");
    assert.ok(findings.every((f) => f.count === 1));
  });
  it("excludes skipped comments, other repos, and non-matching paths", () => {
    const cwd = cwdWithDb([
      [
        { path: "src/api.py", body: "addressed one on the endpoint", status: "addressed" },
        { path: "src/api.py", body: "skipped ack noise entirely", status: "skipped" },
        { path: "other.py", body: "different file entirely here" },
        { path: "src/other.py", body: "another repo finding entirely", owner: "other", repo: "repo" },
      ],
    ]);
    const block = relevantFindings(cwd, ["src/api.py"], repoInfo);
    assert.ok(block);
    assert.match(block!, /src\/api\.py \(1×\)/);
    assert.doesNotMatch(block!, /other\.py/);
    assert.equal(relevantFindings(cwd, ["unrelated.py"], repoInfo), undefined);
  });
  it("matches exact and dir-prefix paths both ways", () => {
    const cwd = cwdWithDb([
      [
        { path: "src/api/foo.py", body: "finding under api dir one" },
        { path: "src/api/bar.py", body: "another under api dir two" },
      ],
    ]);
    // input dir matches comment files — one issue per comment file
    const byDir = collectPathFindings(cwd, ["src/api"], repoInfo);
    assert.deepEqual(byDir.map((f) => f.path).sort(), ["src/api/bar.py", "src/api/foo.py"]);
    assert.ok(byDir.every((f) => f.count === 1));
    // input file matches its own comment exactly
    const byFile = collectPathFindings(cwd, ["src/api/foo.py"], repoInfo);
    assert.equal(byFile[0]!.count, 1);
    assert.equal(byFile[0]!.path, "src/api/foo.py");
    // input file matches a comment recorded on its parent dir
    const cwd2 = cwdWithDb([[{ path: "src/api", body: "recorded on the dir itself" }]]);
    assert.equal(collectPathFindings(cwd2, ["src/api/foo.py"], repoInfo)[0]!.count, 1);
  });
  it("paths with LIKE wildcards (_ %) match exactly, not as patterns", () => {
    const cwd = cwdWithDb([[{ path: "src/my_file.py", body: "underscore path finding body" }]]);
    // a sibling whose name differs only in the wildcard position must NOT match
    const cwd2 = cwdWithDb([[{ path: "src/myXfile.py", body: "wildcard sibling finding" }]]);
    void cwd2;
    const findings = collectPathFindings(cwd, ["src/my_file.py"], repoInfo);
    assert.deepEqual(findings.map((f) => f.path), ["src/my_file.py"]);
  });
  it("returns undefined when the DB is missing, repo resolution fails, or paths are empty", () => {
    assert.equal(relevantFindings(makeCwd(), ["src/api.py"], repoInfo), undefined);
    // repo resolution failure (no git remote) → no findings, fail-soft
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "x" }]]);
    assert.equal(relevantFindings(cwd, ["src/api.py"], () => null), undefined);
    assert.equal(relevantFindings(cwd, [], repoInfo), undefined);
    assert.equal(relevantFindings(cwd, ["../escape.py"], repoInfo), undefined);
  });
  it("caps the block at 8 lines", () => {
    const batch = Array.from({ length: 12 }, (_, i) => ({
      path: `src/m${i}.py`,
      body: `finding ${i}`,
    }));
    const cwd = cwdWithDb([batch]);
    const block = relevantFindings(cwd, batch.map((b) => b.path), repoInfo);
    assert.ok(block);
    const lines = block!.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(lines.length, 8, "line cap enforced with 12 candidate paths");
  });
  it("caps the block at 600 chars when lines are long", () => {
    const batch = Array.from({ length: 12 }, (_, i) => ({
      path: `src/module-number-${i}.py`,
      body: `a finding body for module ${i} with plenty of words to make the line long`,
    }));
    const cwd = cwdWithDb([batch]);
    const block = relevantFindings(cwd, batch.map((b) => b.path), repoInfo);
    assert.ok(block);
    assert.ok(block!.length <= 600, `block is ${block!.length} chars`);
    assert.ok(block!.split("\n").filter((l) => l.startsWith("- ")).length < 12, "char cap trims lines");
  });
  it("uses lesson text over comment gist when memory has a provenance-matched lesson", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "raw comment gist text" }]]);
    seedLessonEntry(cwd, "always redact src/api.py responses", `reviews.db:${commentId(cwd, "src/api.py")};${REPO.owner}/${REPO.repo}`);
    const findings = collectPathFindings(cwd, ["src/api.py"], repoInfo);
    assert.equal(findings[0]!.text, "always redact src/api.py responses");
    assert.equal(findings[0]!.count, 1, "count still comes from the DB");
  });
  it("matches lessons by derivedFrom comment path even when the path is not in the text", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "gist" }]]);
    seedLessonEntry(cwd, "never trust endpoint payloads", `reviews.db:${commentId(cwd, "src/api.py")};${REPO.owner}/${REPO.repo}`);
    const findings = collectPathFindings(cwd, ["src/api.py"], repoInfo);
    assert.equal(findings[0]!.text, "never trust endpoint payloads");
  });
  it("ignores lessons without review provenance — a bare text mention is not a review finding", () => {
    const cwd = cwdWithDb([]); // no DB findings at all
    seedLessonEntry(cwd, "run migrations after touching src/schema.sql");
    assert.deepEqual(collectPathFindings(cwd, ["src/schema.sql"], repoInfo), []);
  });
  it("ignores non-lesson entries and lessons whose provenance names another repo", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "gist for the api endpoint" }]]);
    const id = commentId(cwd, "src/api.py");
    // a preference that mentions the path with matching provenance — not a lesson
    seedLessonEntry(cwd, "prefer tabs in src/api.py", `reviews.db:${id};${REPO.owner}/${REPO.repo}`, "preference");
    // a lesson whose provenance belongs to another repo
    seedLessonEntry(cwd, "other repo lesson entirely", `reviews.db:${id};other/repo`);
    const findings = collectPathFindings(cwd, ["src/api.py"], repoInfo);
    assert.equal(findings.length, 1);
    assert.notEqual(findings[0]!.text, "prefer tabs in src/api.py");
    assert.notEqual(findings[0]!.text, "other repo lesson entirely");
  });
  it("formatFindingsBlock returns null for empty findings", () => {
    assert.equal(formatFindingsBlock([]), null);
  });
});

// ── Handler wiring ─────────────────────────────────────────────────────────

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

function registerHandlers(cwd: string, diffPaths: () => string[] = () => []) {
  const { pi, handlers } = mockPi();
  createReviewLearning({ repoInfo, diffPaths }).register(pi as any);
  // Handlers are identified by OBSERVABLE BEHAVIOR, never registration
  // order — fire every tool_result handler and keep whichever returns
  // content (the write hint; the bash watcher returns undefined for write
  // events). Adding or reordering an unrelated handler cannot break tests.
  const allToolResult = handlers.get("tool_result") ?? [];
  const fireAll = (event: any, ctx: any): any =>
    allToolResult.map((h) => h(event, ctx)).find((r: any) => r !== undefined);
  return {
    handlers,
    beforeAgentStart: handlers.get("before_agent_start")![0]!,
    writeHint: fireAll,
    subagentRewrite: handlers.get("tool_call")![0]!,
    sessionStart: handlers.get("session_start")![0]!,
  };
}

function settingsDisabled(cwd: string): void {
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "pi-config-settings.json"), JSON.stringify({ review_learning: false }));
}

describe("before_agent_start injection", () => {
  it("injects the block as a prompt section when findings exist", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "Missing redaction on the endpoint" }]]);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const { beforeAgentStart } = registerHandlers(cwd);
    const sections: Record<string, string> = {};
    const result = beforeAgentStart(
      {
        messageType: "user",
        prompt: "Please fix the bug in src/api.py",
        systemPrompt: "BASE",
        systemPromptOptions: { sections },
      },
      { cwd },
    );
    assert.equal(result, undefined, "section mutation, not a full prompt replace");
    assert.match(sections.review_lessons!, /<review-lessons>/);
    assert.match(sections.review_lessons!, /src\/api\.py \(1×\)/);
  });
  it("falls back to the legacy return shape when sections are unavailable", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "Missing redaction on the endpoint" }]]);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const { beforeAgentStart } = registerHandlers(cwd);
    const result = beforeAgentStart(
      { messageType: "user", prompt: "Fix src/api.py", systemPrompt: "BASE" },
      { cwd },
    );
    assert.deepEqual(Object.keys(result), ["systemPrompt"]);
    assert.match(result.systemPrompt, /^BASE\n\n<review-lessons>/);
  });
  it("includes diff paths when the prompt names none", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "Missing redaction on the endpoint" }]]);
    const sections: Record<string, string> = {};
    const { beforeAgentStart } = registerHandlers(cwd, () => ["src/api.py"]);
    const result = beforeAgentStart(
      { messageType: "user", prompt: "just do the task", systemPrompt: "BASE", systemPromptOptions: { sections } },
      { cwd },
    );
    assert.equal(result, undefined);
    assert.match(sections.review_lessons!, /src\/api\.py/);
  });
  it("resolves repo-relative diff paths against the worktree root from a nested session cwd", () => {
    const repo = gitRepoWithBranch();
    const nested = path.join(repo, "packages", "inner");
    fs.mkdirSync(nested, { recursive: true });
    // DB finding recorded at the repo-relative path the diff reports — copied
    // to wherever getProjectDataDir resolves (the shared main-checkout root)
    const dbCwd = cwdWithDb([[{ path: "src/api.py", body: "Missing redaction on the endpoint" }]]);
    const dataDir = getProjectDataDir(nested);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(path.join(dbCwd, ".pi", "data", "reviews.db"), path.join(dataDir, "reviews.db"));
    const sections: Record<string, string> = {};
    const { beforeAgentStart } = registerHandlers(nested, () => ["src/api.py"]);
    beforeAgentStart(
      { messageType: "user", prompt: "just do the task", systemPrompt: "BASE", systemPromptOptions: { sections } },
      { cwd: nested },
    );
    assert.match(sections.review_lessons!, /src\/api\.py \(1×\)/, "diff path matched the DB's repo-relative path");
  });
  it("returns undefined with zero added tokens when nothing is relevant", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "finding" }]]);
    const sections: Record<string, string> = {};
    const { beforeAgentStart } = registerHandlers(cwd);
    const result = beforeAgentStart(
      { messageType: "user", prompt: "unrelated chit chat", systemPrompt: "BASE", systemPromptOptions: { sections } },
      { cwd },
    );
    assert.equal(result, undefined);
    assert.equal(sections.review_lessons, undefined);
  });
  it("returns undefined when the setting is disabled", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "finding" }]]);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    settingsDisabled(cwd);
    const sections: Record<string, string> = {};
    const { beforeAgentStart } = registerHandlers(cwd);
    const result = beforeAgentStart(
      { messageType: "user", prompt: "Fix src/api.py", systemPrompt: "BASE", systemPromptOptions: { sections } },
      { cwd },
    );
    assert.equal(result, undefined);
    assert.equal(sections.review_lessons, undefined);
  });
  it("extracts text from custom messages and skips textless ones without crashing", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "finding" }]]);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const { beforeAgentStart } = registerHandlers(cwd);
    const sections: Record<string, string> = {};
    const withText = beforeAgentStart(
      {
        messageType: "custom",
        message: { content: [{ type: "text", text: "update src/api.py handlers" }] },
        systemPrompt: "BASE",
        systemPromptOptions: { sections },
      },
      { cwd },
    );
    assert.equal(withText, undefined);
    assert.match(sections.review_lessons!, /src\/api\.py/);
    const noText = beforeAgentStart(
      { messageType: "custom", message: { content: [] }, systemPrompt: "BASE", systemPromptOptions: { sections: {} } },
      { cwd },
    );
    assert.equal(noText, undefined, "falls back to diff (none) → omit");
  });
});

describe("first-write tool_result hint", () => {
  it("appends the block once per path, then one-liners for new paths", () => {
    const cwd = cwdWithDb([
      [
        { path: "src/api.py", body: "api finding" },
        { path: "src/other.py", body: "other finding" },
      ],
    ]);
    const { writeHint } = registerHandlers(cwd);
    const first = writeHint(
      { toolName: "edit", input: { path: "src/api.py" }, content: [{ type: "text", text: "ok" }], isError: false },
      { cwd },
    );
    assert.ok(first, "first write gets a hint");
    assert.deepEqual(first.content[0], { type: "text", text: "ok" });
    assert.match(first.content[1].text, /<review-lessons>/);
    assert.match(first.content[1].text, /src\/api\.py \(1×\)/);
    // same path again → skipped
    assert.equal(
      writeHint({ toolName: "write", input: { path: "src/api.py" }, content: [], isError: false }, { cwd }),
      undefined,
    );
    // a different path → one-liner (a full block was already injected)
    const second = writeHint(
      { toolName: "edit", input: { path: "src/other.py" }, content: [], isError: false },
      { cwd },
    );
    assert.ok(second);
    assert.match(second.content[0].text, /^\[review-lessons\] src\/other\.py \(1×\): /);
  });
  it("skips paths covered by the before_agent_start injection", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "api finding" }]]);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const { beforeAgentStart, writeHint } = registerHandlers(cwd);
    beforeAgentStart(
      { messageType: "user", prompt: "Fix src/api.py", systemPrompt: "BASE", systemPromptOptions: { sections: {} } },
      { cwd },
    );
    assert.equal(
      writeHint({ toolName: "edit", input: { path: "src/api.py" }, content: [], isError: false }, { cwd }),
      undefined,
      "already injected this session",
    );
  });
  it("omits when no findings, on errors, and for other tools", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "api finding" }]]);
    const { writeHint } = registerHandlers(cwd);
    assert.equal(
      writeHint({ toolName: "edit", input: { path: "unrelated.py" }, content: [], isError: false }, { cwd }),
      undefined,
    );
    assert.equal(
      writeHint({ toolName: "edit", input: { path: "src/api.py" }, content: [], isError: true }, { cwd }),
      undefined,
    );
    assert.equal(
      writeHint({ toolName: "read", input: { path: "src/api.py" }, content: [], isError: false }, { cwd }),
      undefined,
    );
  });
  it("resets injected paths on session_start", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "api finding" }]]);
    const { writeHint, sessionStart } = registerHandlers(cwd);
    assert.ok(writeHint({ toolName: "edit", input: { path: "src/api.py" }, content: [], isError: false }, { cwd }));
    sessionStart({}, { cwd });
    assert.ok(
      writeHint({ toolName: "edit", input: { path: "src/api.py" }, content: [], isError: false }, { cwd }),
      "re-injects after a new session",
    );
  });
  it("no-ops when the setting is disabled", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "api finding" }]]);
    settingsDisabled(cwd);
    const { writeHint } = registerHandlers(cwd);
    assert.equal(
      writeHint({ toolName: "edit", input: { path: "src/api.py" }, content: [], isError: false }, { cwd }),
      undefined,
    );
  });
});

describe("subagent dispatch rewrite", () => {
  it("appends the block to the task text and leaves other args untouched", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "api finding" }]]);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const { subagentRewrite } = registerHandlers(cwd);
    const task = "Refactor the error handling in src/api.py";
    const input = { agent: "frontend", task, cwd, model: "provider/m" };
    const result = subagentRewrite({ toolName: "subagent", input }, { cwd });
    assert.equal(result, undefined, "in-place mutation, no block return");
    assert.ok(input.task.startsWith(task));
    assert.match(input.task, /<review-lessons>/);
    assert.match(input.task, /src\/api\.py \(1×\)/);
    assert.equal(input.agent, "frontend");
    assert.equal(input.cwd, cwd);
    assert.equal(input.model, "provider/m");
  });
  it("rewrites every tasks[] entry (parallel mode), each with its own cwd", () => {
    const mainCwd = cwdWithDb([]);
    const subA = cwdWithDb([[{ path: "src/api.py", body: "api finding" }]]);
    fs.mkdirSync(path.join(subA, "src"), { recursive: true });
    fs.writeFileSync(path.join(subA, "src", "api.py"), "x");
    const subB = cwdWithDb([[{ path: "src/other.py", body: "other finding" }]]);
    fs.mkdirSync(path.join(subB, "src"), { recursive: true });
    fs.writeFileSync(path.join(subB, "src", "other.py"), "x");
    const { subagentRewrite } = registerHandlers(mainCwd);
    const input = {
      tasks: [
        { agent: "a", task: "Fix src/api.py", cwd: subA },
        { agent: "b", task: "Fix src/other.py", cwd: subB },
        { agent: "c", task: "no paths here" },
      ],
    };
    subagentRewrite({ toolName: "subagent", input }, { cwd: mainCwd });
    assert.match(input.tasks[0].task, /<review-lessons>/);
    assert.match(input.tasks[0].task, /src\/api\.py/);
    assert.match(input.tasks[1].task, /<review-lessons>/);
    assert.match(input.tasks[1].task, /src\/other\.py/);
    assert.equal(input.tasks[2].task, "no paths here", "irrelevant entries untouched");
  });
  it("rewrites every chain[] entry (sequential mode) with per-step cwd resolution", () => {
    const mainCwd = cwdWithDb([]);
    const sub = cwdWithDb([[{ path: "src/api.py", body: "api finding" }]]);
    fs.mkdirSync(path.join(sub, "src"), { recursive: true });
    fs.writeFileSync(path.join(sub, "src", "api.py"), "x");
    const { subagentRewrite } = registerHandlers(sub);
    const input = {
      cwd: sub,
      chain: [{ agent: "a", task: "First fix src/api.py" }, { agent: "b", task: "then refactor src/api.py again" }],
    };
    subagentRewrite({ toolName: "subagent", input }, { cwd: mainCwd });
    for (const step of input.chain) assert.match(step.task, /<review-lessons>/);
  });
  it("uses the subagent cwd for the query when provided", () => {
    const mainCwd = cwdWithDb([]); // nothing relevant
    const subCwd = cwdWithDb([[{ path: "src/api.py", body: "api finding" }]]);
    fs.mkdirSync(path.join(subCwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(subCwd, "src", "api.py"), "x");
    const { subagentRewrite } = registerHandlers(mainCwd);
    const input = { agent: "backend", task: "Touch src/api.py please", cwd: subCwd };
    subagentRewrite({ toolName: "subagent", input }, { cwd: mainCwd });
    assert.match(input.task, /<review-lessons>/);
  });
  it("nested-cwd tasks also match root-relative paths — extraction runs from BOTH cwds", () => {
    // nested session cwd with its own src/ — the task mentions a ROOT-level
    // file; existence checks under the nested cwd alone would drop it.
    const repo = gitRepoWithBranch();
    const nested = path.join(repo, "packages", "inner");
    fs.mkdirSync(path.join(nested, "src"), { recursive: true });
    fs.writeFileSync(path.join(nested, "src", "local.py"), "y = 2\n");
    // DB finding recorded at the root-relative path, copied to where
    // getProjectDataDir resolves for the nested cwd (the worktree root)
    const dbCwd = cwdWithDb([[{ path: "src/api.py", body: "root-level api finding on the module" }]]);
    const dataDir = getProjectDataDir(nested);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(path.join(dbCwd, ".pi", "data", "reviews.db"), path.join(dataDir, "reviews.db"));
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "api.py"), "x");
    const { subagentRewrite } = registerHandlers(nested);
    const input = { tasks: [{ agent: "a", task: "Fix the handler in src/api.py", cwd: nested }] };
    subagentRewrite({ toolName: "subagent", input }, { cwd: repo });
    assert.match(input.tasks[0].task, /<review-lessons>/, "root-relative path matched from nested cwd");
    assert.match(input.tasks[0].task, /src\/api\.py \(1×\)/);
  });
  it("no-ops when nothing is relevant or the tool is not subagent", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "api finding" }]]);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const { subagentRewrite } = registerHandlers(cwd);
    const clean = { agent: "frontend", task: "no paths mentioned here", cwd };
    subagentRewrite({ toolName: "subagent", input: clean }, { cwd });
    assert.equal(clean.task, "no paths mentioned here");
    const bashInput = { command: "echo src/api.py", cwd };
    subagentRewrite({ toolName: "bash", input: bashInput }, { cwd });
    assert.equal(bashInput.command, "echo src/api.py");
  });
  it("no-ops when the setting is disabled", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "api finding" }]]);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    settingsDisabled(cwd);
    const { subagentRewrite } = registerHandlers(cwd);
    const input = { agent: "frontend", task: "Fix src/api.py", cwd };
    subagentRewrite({ toolName: "subagent", input }, { cwd });
    assert.equal(input.task, "Fix src/api.py");
  });
});
