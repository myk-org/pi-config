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
  extractPathsFromText,
  branchDiffPaths,
  firstSentence,
  collectPathFindings,
  relevantFindings,
  formatFindingsBlock,
  createReviewLearning,
} from "../../../extensions/orchestrator/review-learning.js";
import { entryHash, loadScores, type ScoredEntry } from "../../../extensions/orchestrator/memory-scoring.js";

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

function makeCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-learning-inject-"));
}

interface CommentSeed {
  path: string;
  body: string;
  status?: string;
  priority?: string;
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
    const result = insertReview.run(100 + index, REPO.owner, REPO.repo, `sha-${index}`, "2026-01-01T00:00:00Z") as any;
    const reviewId = Number(result.lastInsertRowid);
    for (const comment of batch) {
      insertComment.run(reviewId, comment.path, comment.body, comment.priority ?? "high", comment.status ?? "addressed");
    }
  });
  db.close();
  return cwd;
}

/** Seed a memory lesson entry (optionally with derivedFrom provenance). */
function seedLessonEntry(cwd: string, text: string, derivedFrom?: string): void {
  const topicsDir = path.join(cwd, ".pi", "memory", "topics");
  fs.mkdirSync(topicsDir, { recursive: true });
  fs.appendFileSync(path.join(topicsDir, "lessons.md"), `- [lesson] ${text}\n`);
  const hash = entryHash(`- [lesson] ${text}`);
  const entry: ScoredEntry = {
    class: "lesson",
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

describe("extractPathsFromText", () => {
  it("keeps existing files and files under existing dirs, drops noise", () => {
    const cwd = makeCwd();
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "api.py"), "x");
    const paths = extractPathsFromText(
      "Fix src/api.py, add docs/new-file.md, ignore e.g. this and v1.2.0 versions and missing/nope.ts",
      cwd,
    );
    // docs/new-file.md: parent docs/ exists and the token has a slash → kept
    assert.deepEqual(paths, ["src/api.py", "docs/new-file.md"]);
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
});

describe("relevantFindings", () => {
  it("counts addressed comments per path across all SHAs and ranks by recurrence", () => {
    const cwd = cwdWithDb([
      [{ path: "src/api.py", body: "Missing strip_sensitive_from_response on the endpoint" }],
      [{ path: "src/api.py", body: "Same redaction gap again" }],
      [{ path: "src/util.py", body: "Only once here" }],
    ]);
    const block = relevantFindings(cwd, ["src/util.py", "src/api.py"]);
    assert.ok(block, "block returned");
    assert.match(block!, /<review-lessons>/);
    assert.match(block!, /src\/api\.py \(2×\): Missing strip_sensitive_from_response/);
    assert.match(block!, /src\/util\.py \(1×\)/);
    assert.ok(block!.indexOf("src/api.py") < block!.indexOf("src/util.py"), "higher count first");
    assert.match(block!, /<\/review-lessons>/);
  });
  it("excludes skipped comments and non-matching paths", () => {
    const cwd = cwdWithDb([
      [
        { path: "src/api.py", body: "addressed one", status: "addressed" },
        { path: "src/api.py", body: "skipped ack noise", status: "skipped" },
        { path: "other.py", body: "different file entirely" },
      ],
    ]);
    const block = relevantFindings(cwd, ["src/api.py"]);
    assert.ok(block);
    assert.match(block!, /src\/api\.py \(1×\)/);
    assert.doesNotMatch(block!, /other\.py/);
    assert.equal(relevantFindings(cwd, ["unrelated.py"]), undefined);
  });
  it("matches exact and dir-prefix paths both ways", () => {
    const cwd = cwdWithDb([
      [
        { path: "src/api/foo.py", body: "finding under api dir" },
        { path: "src/api/bar.py", body: "another under api dir" },
      ],
    ]);
    // input dir matches comment files
    const byDir = collectPathFindings(cwd, ["src/api"]);
    assert.deepEqual(byDir.map((f) => f.path), ["src/api"]);
    assert.equal(byDir[0]!.count, 2);
    // input file matches its own comment exactly
    const byFile = collectPathFindings(cwd, ["src/api/foo.py"]);
    assert.equal(byFile[0]!.count, 1);
    // input file matches a comment recorded on its parent dir
    const cwd2 = cwdWithDb([[{ path: "src/api", body: "recorded on the dir" }]]);
    assert.equal(collectPathFindings(cwd2, ["src/api/foo.py"])[0]!.count, 1);
  });
  it("returns undefined when the DB is missing or paths are empty", () => {
    assert.equal(relevantFindings(makeCwd(), ["src/api.py"]), undefined);
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "x" }]]);
    assert.equal(relevantFindings(cwd, []), undefined);
    assert.equal(relevantFindings(cwd, ["../escape.py"]), undefined);
  });
  it("caps the block at 8 lines and 600 chars", () => {
    const batch = Array.from({ length: 12 }, (_, i) => ({
      path: `src/m${i}.py`,
      body: `finding ${i}`,
    }));
    const cwd = cwdWithDb([batch]);
    const block = relevantFindings(cwd, batch.map((b) => b.path));
    assert.ok(block);
    const lines = block!.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(lines.length, 8, "line cap enforced with 12 candidate paths");
    assert.ok(block!.length <= 600, `block is ${block!.length} chars`);
  });
  it("truncates the block to 600 chars when lines are long", () => {
    const batch = Array.from({ length: 12 }, (_, i) => ({
      path: `src/module-number-${i}.py`,
      body: `a finding body for module ${i} with plenty of words to make the line long`,
    }));
    const cwd = cwdWithDb([batch]);
    const block = relevantFindings(cwd, batch.map((b) => b.path));
    assert.ok(block);
    assert.ok(block!.length <= 600, `block is ${block!.length} chars`);
    assert.ok(block!.split("\n").filter((l) => l.startsWith("- ")).length < 12, "char cap trims lines");
  });
  it("uses lesson text over comment gist when memory has a matching lesson", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "raw comment gist text" }]]);
    seedLessonEntry(cwd, "always redact src/api.py responses", `reviews.db:${commentId(cwd, "src/api.py")};${REPO.owner}/${REPO.repo}`);
    const findings = collectPathFindings(cwd, ["src/api.py"]);
    assert.equal(findings[0]!.text, "always redact src/api.py responses");
    assert.equal(findings[0]!.count, 1, "count still comes from the DB");
  });
  it("matches lessons by derivedFrom comment path even when the path is not in the text", () => {
    const cwd = cwdWithDb([[{ path: "src/api.py", body: "gist" }]]);
    seedLessonEntry(cwd, "never trust endpoint payloads", `reviews.db:${commentId(cwd, "src/api.py")};${REPO.owner}/${REPO.repo}`);
    const findings = collectPathFindings(cwd, ["src/api.py"]);
    assert.equal(findings[0]!.text, "never trust endpoint payloads");
  });
  it("matches lessons by plain text scan without provenance", () => {
    const cwd = cwdWithDb([]); // no DB findings at all
    seedLessonEntry(cwd, "run migrations after touching src/schema.sql");
    const findings = collectPathFindings(cwd, ["src/schema.sql"]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.text, "run migrations after touching src/schema.sql");
    assert.equal(findings[0]!.count, 1, "no DB occurrences → count 1");
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
  createReviewLearning({ repoInfo: () => REPO, diffPaths }).register(pi as any);
  assert.equal(handlers.get("tool_result")!.length, 2, "bash watcher + write hint");
  return {
    handlers,
    beforeAgentStart: handlers.get("before_agent_start")![0]!,
    writeHint: handlers.get("tool_result")![1]!,
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
  it("falls back to the graft return shape when sections are unavailable", () => {
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
