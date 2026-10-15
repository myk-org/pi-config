/**
 * review-learning.ts — distill addressed review findings into memory and
 * recall them at write time (issue #918 Parts A and B).
 *
 * Part A — a `tool_result` watcher recognizes `myk-pi-tools reviews address`
 * completions in main-session bash, then (fire-and-forget — scheduled via
 * setImmediate so the handler returns before any synchronous I/O starts)
 * distills the ADDRESSED findings of the review that command stored from
 * `.pi/data/reviews.db` into one-line `lesson` memory entries via the internal
 * memory write path, with finding-id provenance
 * (`derivedFrom="reviews.db:<comment-id>;<owner>/<repo>"`).
 *
 * Review selection: the addressed PR is identified from the command's
 * `--json` file (or the newest `pr-*-reviews.json` in the project tmp dir —
 * mirroring address.py's default), and the newest stored review row for that
 * PR is distilled. Already-distilled review ids are tracked in
 * `.pi/data/review-learning-state.json`, so re-fires (multi-group address
 * runs, partial runs that did not store) are no-ops — evidence only grows
 * when a NEW review stores a NEW comment row for the same issue (a real
 * recurrence, via addMemoryEntry's duplicate detection).
 *
 * Distillation is deterministic and model-free: the reviewer tool's finding
 * title (the stored `comments.title` when present — populated by
 * myk-pi-tools at store time — else the first meaningful line of the body,
 * un-buried from badges/HTML/Markdown) becomes the lesson, prefixed with the
 * file path; exact title collisions merge as duplicates of one issue,
 * carrying every contributing finding id. Zero model calls, zero cost,
 * fully testable (issue #918 decision: script-only engine).
 *
 * Distillation source is the DB, not the pr-*-reviews.json file — address
 * DELETES that JSON on the final status-group run. `skipped` findings are
 * excluded (ack-noise, false positives); only final `addressed` rows distill.
 *
 * Part B — write-time recall. Three injection surfaces surface past addressed
 * findings for files the agent is about to touch, ranked by per-issue
 * recurrence (same path + title across reviews — distinct issues on one file
 * are counted and rendered separately, never as recurrences of each other):
 * 1. `before_agent_start` system-prompt section (paths named in the prompt +
 *    the issue-branch diff, diff paths resolved against the worktree root so
 *    nested sessions match repo-relative DB paths),
 * 2. a first-write `tool_result` hint for paths discovered mid-run,
 * 3. a `tool_call` rewrite appending the block to subagent task text —
 *    single mode, `tasks[]` (parallel), and `chain[]` (sequential) alike.
 * All surfaces omit entirely when empty (zero added tokens), never make model
 * calls, and never throw. Recall is repo-isolated (owner/repo from the git
 * remote) and pushes path/repo filtering into SQL so hook latency does not
 * grow with the whole review history; paths checked once per session
 * (findings or not) are never re-queried on later writes.
 *
 * GUARD: these hooks assume `reviews address` runs in the main session (both
 * review-handler modes run Phases 2–8 in main-session bash); if address ever
 * moves into a poll worker, this goes blind — move the distillation trigger
 * with it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { getSetting } from "./project-settings.js";
import { getProjectDataDir, getProjectTmpDir, resolveWorktreeRoot } from "./utils.js";
import { addMemoryEntry } from "./memory-write.js";
import { entryHash, loadScores } from "./memory-scoring.js";
import { readAllTopicEntries } from "./memory-tree.js";

const log = createLogger("review-learning");

// ── Constants ──────────────────────────────────────────────────────────────

/** Per-fire caps (issue #918: per-cycle cap ~5 by severity protects the
 *  situation-report budget). The cap applies AFTER lesson extraction, so
 *  findings with unusable bodies never consume slots. */
const MAX_FINDINGS_PER_FIRE = 5;
const MAX_MEMORY_WRITES_PER_FIRE = 5;

/** Prompt-side body truncation per finding. */
const MAX_FINDING_BODY_CHARS = 500;
/** Hard ceiling on a distilled lesson line. */
const MAX_LESSON_CHARS = 100;

/** Persisted distilled-review state: `.pi/data/review-learning-state.json`. */
const STATE_FILE_NAME = "review-learning-state.json";
/** Cap on tracked review ids — old reviews never re-distill in practice. */
const MAX_TRACKED_REVIEWS = 200;

// ── Command matching ───────────────────────────────────────────────────────

/** `reviews address` as a subcommand invocation (not `reviews address-foo`). */
const REVIEWS_ADDRESS_RE = /(?:^|[\s;&|])reviews\s+address(?=[\s;&|]|$)/i;

/**
 * True when a bash command invokes `myk-pi-tools reviews address`.
 * Tolerates `uv run ... myk-pi-tools ... reviews address` and `uv run --group X ...`
 * wrappers; `reviews store` / `reviews fetch` / bare `reviews address` never match.
 */
export function isReviewsAddressCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const normalized = command.trim();
  if (!/\bmyk-pi-tools\b/i.test(normalized)) return false;
  return REVIEWS_ADDRESS_RE.test(normalized);
}

// ── Repo resolution ────────────────────────────────────────────────────────

export interface RepoInfo {
  owner: string;
  repo: string;
}

/** Parse `owner/repo` from a git remote URL (https, ssh://, and SCP-like forms). */
export function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } | null {
  if (typeof remoteUrl !== "string") return null;
  let url = remoteUrl.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!url) return null;
  // SCP-like: git@github.com:owner/repo (or any user@host:path)
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  const urlMatch = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?[^/\s]+\/(.+)$/.exec(url);
  if (!urlMatch) return null;
  const segments = urlMatch[1]!.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const repo = segments.pop()!;
  const owner = segments.pop()!;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/** Resolve owner/repo from the session cwd via `git remote get-url origin`. Fail-soft. */
export function resolveRepoInfo(cwd: string): RepoInfo | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const repo = parseGitHubRepo(url);
    if (!repo) log.debug("repo_url_unparsable", { cwd, url: url.slice(0, 120) });
    return repo;
  } catch (error: any) {
    log.debug("repo_resolution_failed", { cwd, reason: String(error?.message ?? error).slice(0, 200) });
    return null;
  }
}

// ── Reviews DB access ──────────────────────────────────────────────────────

export interface ReviewRow {
  id: number;
  prNumber: number;
  commitSha: string;
  owner: string;
  repo: string;
}

export interface AddressedFinding {
  id: number;
  path: string | null;
  line: number | null;
  body: string;
  priority: string | null;
  /** Clean finding title from the `comments.title` column (null on legacy rows). */
  title: string | null;
}

function openReviewsDb(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (error: any) {
    log.debug("reviews_db_open_failed", { dbPath, reason: String(error?.message ?? error).slice(0, 200) });
    return null;
  }
}

/**
 * Newest review row for owner/repo, optionally narrowed to one PR — the review
 * an `address` command stored (append-only store — highest id is newest).
 */
export function getLatestReview(dbPath: string, owner: string, repo: string, prNumber?: number | null): ReviewRow | null {
  const db = openReviewsDb(dbPath);
  if (!db) return null;
  try {
    const sql = prNumber
      ? "SELECT id, pr_number, commit_sha, owner, repo FROM reviews WHERE owner=? AND repo=? AND pr_number=? ORDER BY id DESC LIMIT 1"
      : "SELECT id, pr_number, commit_sha, owner, repo FROM reviews WHERE owner=? AND repo=? ORDER BY id DESC LIMIT 1";
    const row = (prNumber
      ? db.prepare(sql).get(owner, repo, prNumber)
      : db.prepare(sql).get(owner, repo)) as any;
    if (!row) return null;
    return {
      id: Number(row.id),
      prNumber: Number(row.pr_number),
      commitSha: String(row.commit_sha),
      owner: String(row.owner),
      repo: String(row.repo),
    };
  } catch (error: any) {
    log.debug("reviews_db_query_failed", { dbPath, reason: String(error?.message ?? error).slice(0, 200) });
    return null;
  } finally {
    db.close();
  }
}

/**
 * Addressed findings for one review id — the review the address command
 * stored, not every review sharing its commit SHA (skipped rows excluded by
 * design). Reads `comments.title` when the column exists (populated by
 * myk-pi-tools at store time); falls back to body-only selection on legacy
 * databases, where `title` is null.
 */
export function getAddressedComments(dbPath: string, reviewId: number): AddressedFinding[] {
  const db = openReviewsDb(dbPath);
  if (!db) return [];
  try {
    let rows: any[];
    try {
      rows = db
        .prepare(
          "SELECT c.id, c.path, c.line, c.body, c.priority, c.title " +
            "FROM comments c WHERE c.review_id=? AND c.status='addressed'",
        )
        .all(reviewId) as any[];
    } catch {
      // Legacy DB without the `title` column — select without it.
      rows = db
        .prepare(
          "SELECT c.id, c.path, c.line, c.body, c.priority " +
            "FROM comments c WHERE c.review_id=? AND c.status='addressed'",
        )
        .all(reviewId) as any[];
      return rows.map((row) => ({
        id: Number(row.id),
        path: typeof row.path === "string" ? row.path : null,
        line: row.line === null || row.line === undefined ? null : Number(row.line),
        body: String(row.body ?? ""),
        priority: typeof row.priority === "string" ? row.priority : null,
        title: null,
      }));
    }
    return rows.map((row) => ({
      id: Number(row.id),
      path: typeof row.path === "string" ? row.path : null,
      line: row.line === null || row.line === undefined ? null : Number(row.line),
      body: String(row.body ?? ""),
      priority: typeof row.priority === "string" ? row.priority : null,
      title: typeof row.title === "string" && row.title.trim() ? row.title : null,
    }));
  } catch (error: any) {
    log.debug("reviews_db_query_failed", { dbPath, reason: String(error?.message ?? error).slice(0, 200) });
    return [];
  } finally {
    db.close();
  }
}

// ── Distilled-review state ─────────────────────────────────────────────────

function stateFilePath(dataDir: string): string {
  return join(dataDir, STATE_FILE_NAME);
}

/** Review ids already distilled — persisted so partial address runs (no store)
 *  and re-fires never re-distill the same review. Fail-soft. */
export function loadDistilledReviews(dataDir: string): Set<number> {
  try {
    const raw = JSON.parse(readFileSync(stateFilePath(dataDir), "utf-8"));
    const ids = Array.isArray(raw?.distilledReviews) ? raw.distilledReviews : [];
    return new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0));
  } catch {
    return new Set();
  }
}

/** Record a review id as distilled (bounded — oldest entries drop off). Fail-soft. */
export function markReviewDistilled(dataDir: string, reviewId: number): void {
  try {
    const ids = [...loadDistilledReviews(dataDir), reviewId];
    const trimmed = ids.slice(-MAX_TRACKED_REVIEWS);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(stateFilePath(dataDir), `${JSON.stringify({ distilledReviews: trimmed }, null, 2)}\n`);
  } catch (error: any) {
    log.debug("distilled_state_write_failed", { reason: String(error?.message ?? error).slice(0, 200) });
  }
}

// ── Addressed-PR identification ────────────────────────────────────────────

/** Newest `pr-*-reviews.json` in the project tmp dir by mtime — mirrors address.py's default discovery. */
function newestReviewsJson(cwd: string): string | null {
  try {
    const dir = getProjectTmpDir(cwd);
    const candidates = readdirSync(dir).filter((f) => /^pr-\d+-reviews\.json$/.test(f));
    let best: { file: string; mtime: number } | null = null;
    for (const file of candidates) {
      const mtime = statSync(join(dir, file)).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    }
    return best ? join(dir, best.file) : null;
  } catch {
    return null;
  }
}

/**
 * PR number of the review an address command targeted: parsed from the
 * command's `--json` file (still on disk for partial runs), else the newest
 * `pr-*-reviews.json` in the project tmp dir (address.py's default). Returns
 * null when neither is readable — callers fall back to newest-for-repo,
 * which is exactly the just-stored review on final (storing) runs.
 */
export function prNumberFromCommand(command: string | undefined, cwd: string): number | null {
  try {
    const m = /(?:^|\s)--json(?:\s+|=)(\S+)/.exec(command ?? "");
    const jsonPath = m ? resolve(cwd, m[1]!) : newestReviewsJson(cwd);
    if (!jsonPath) return null;
    const pr = Number(JSON.parse(readFileSync(jsonPath, "utf-8"))?.metadata?.pr_number);
    return Number.isInteger(pr) && pr > 0 ? pr : null;
  } catch {
    return null;
  }
}

// ── Distillation (script-only engine) ──────────────────────────────────────

export interface DistilledLesson {
  /** Every contributing finding id — merged duplicates keep their identities. */
  findingIds: number[];
  text: string;
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function priorityRank(priority: string | null): number {
  return PRIORITY_ORDER[(priority ?? "").toLowerCase()] ?? 4;
}

/**
 * Rank ALL findings: critical/high first, then by id. No cap here — the
 * per-fire cap applies in distillLessons AFTER lesson extraction, so findings
 * with unusable (badge-only) bodies never consume slots that eligible
 * findings below them could have used.
 */
export function rankFindings(findings: AddressedFinding[]): AddressedFinding[] {
  return [...findings].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.id - b.id);
}

/**
 * Extract the finding's title line from a raw review body — deterministic,
 * no model. Reviewer tools (Qodo, CodeRabbit) write a human-readable title as
 * the first meaningful line, buried in badge images, HTML tags, and Markdown
 * emphasis. Skips badge/label lines, strips markup, returns null when no
 * meaningful line exists. Fallback for legacy DB rows without `comments.title`.
 */
export function extractFindingTitle(body: string): string | null {
  if (typeof body !== "string" || !body.trim()) return null;
  const scan = body.slice(0, MAX_FINDING_BODY_CHARS);
  for (let rawLine of scan.split("\n")) {
    let line = rawLine.trim();
    if (!line) continue;
    // Badge lines: shield <img>, markdown images, and bare URL lines.
    if (/^<img\b/i.test(line) || /^!\[[^\]]*\]\([^)]*\)/.test(line) || /^https?:\/\/\S+$/.test(line)) continue;
    // Drop inline label spans FIRST (Qodo type tags like <code>🐞 Bug</code>)
    // so their contents do not leak into the title.
    line = line.replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, " ");
    line = line.replace(/<[^>]+>/g, " "); // remaining HTML tags
    line = line.replace(/^\d+\\?\.\s*/, ""); // leading list number ("1\. ")
    line = line.replace(/[*`#>|]/g, " "); // Markdown emphasis/fence chars (keep _ — identifiers use it)
    line = line.replace(/\s+/g, " ").trim();
    if (line.length < 15) continue; // fragments, separators, leftovers
    return line.slice(0, MAX_LESSON_CHARS);
  }
  return null;
}

/** Sanitize one lesson: single line, non-empty, ≤ MAX_LESSON_CHARS. */
function sanitizeLesson(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  return oneLine.slice(0, MAX_LESSON_CHARS);
}

/** Deterministic lesson line for one finding: `<path>: <title>`. */
export function lessonFromFinding(f: AddressedFinding): string | null {
  const title = f.title ?? extractFindingTitle(f.body);
  if (!title) return null;
  const where = f.path ? `${f.path}: ` : "";
  const line = sanitizeLesson(`${where}${title}`);
  return line && line.length >= 15 ? line : null;
}

/**
 * Distill findings into lessons — pure, synchronous, zero model calls.
 * Findings are ranked, lessons extracted and validated for ALL of them, and
 * only then capped at MAX_FINDINGS_PER_FIRE (unusable bodies never consume
 * slots). Findings whose lessons (path + title) collide are duplicates of the
 * same issue — they merge into one lesson that carries every contributing
 * finding id, so provenance lookups can distinguish new occurrences from
 * re-fires.
 */
export function distillLessons(findings: AddressedFinding[]): DistilledLesson[] {
  const byText = new Map<string, DistilledLesson>();
  for (const finding of rankFindings(findings)) {
    const text = lessonFromFinding(finding);
    if (!text) continue;
    const key = text.toLowerCase();
    const existing = byText.get(key);
    if (existing) existing.findingIds.push(finding.id); // merged duplicate keeps its identity
    else byText.set(key, { findingIds: [finding.id], text });
  }
  return [...byText.values()].slice(0, MAX_FINDINGS_PER_FIRE);
}

// ── Memory write with provenance dedupe ────────────────────────────────────

/** Provenance key for a review finding (issue #918: drill-down stays in the DB). */
export function findingProvenance(findingId: number, repo: RepoInfo): string {
  return `reviews.db:${findingId};${repo.owner}/${repo.repo}`;
}

/**
 * Find the canonical topic line of the memory entry carrying `derivedFrom`.
 * Read-only lookup over topics + memory-scores.jsonl (via the scoring store).
 */
export function findMemoryLineByDerivedFrom(cwd: string, derivedFrom: string): string | null {
  try {
    const scores = loadScores(cwd);
    for (const te of readAllTopicEntries(cwd)) {
      const hash = entryHash(`- [${te.category}] ${te.text}`);
      if (scores.entries[hash]?.derivedFrom === derivedFrom) {
        return `- [${te.category}] ${te.text}`;
      }
    }
  } catch (error: any) {
    log.debug("derived_from_lookup_failed", { reason: String(error?.message ?? error).slice(0, 200) });
  }
  return null;
}

export interface WriteLessonsResult {
  added: number;
  reinforced: number;
  rejected: number;
  /** Skipped: this exact finding was already distilled (existing provenance). */
  skipped: number;
}

/**
 * Write distilled lessons through the internal memory path.
 * Existing `derivedFrom` provenance → SKIP (the finding was already distilled;
 * re-fires must not inflate evidence — review-level tracking normally prevents
 * reaching this point, this is the belt). New findings whose lesson text
 * already exists (the same issue re-raised in a NEW review — a real
 * recurrence) are reinforced by addMemoryEntry's duplicate detection.
 * Capped at MAX_MEMORY_WRITES_PER_FIRE.
 */
export async function writeLessonsToMemory(
  cwd: string,
  lessons: DistilledLesson[],
  repo: RepoInfo,
): Promise<WriteLessonsResult> {
  const result: WriteLessonsResult = { added: 0, reinforced: 0, rejected: 0, skipped: 0 };
  for (const lesson of lessons.slice(0, MAX_MEMORY_WRITES_PER_FIRE)) {
    const derivedFrom = findingProvenance(lesson.findingIds[0]!, repo);
    if (findMemoryLineByDerivedFrom(cwd, derivedFrom)) {
      result.skipped++;
      log.debug("lesson_already_distilled", { derivedFrom });
      continue;
    }
    const add = await addMemoryEntry(cwd, {
      text: lesson.text,
      category: "lesson",
      derivedFrom,
      informs: ["review-learning"],
    });
    if (add.status === "added") result.added++;
    else if (add.status === "reinforced") result.reinforced++;
    else {
      result.rejected++;
      // Visible, not debug: a rejected lesson is silent knowledge loss — the
      // contradiction detector occasionally false-positives on review-derived
      // titles (e.g. "one review can teach another" vs an unrelated pinned
      // lesson), and without this line the only trace is an aggregate count.
      log.warn("lesson_rejected", {
        derivedFrom,
        text: lesson.text,
        reason: String((add as { message?: string }).message ?? "").slice(0, 300),
      });
    }
    log.debug("lesson_write", { derivedFrom, status: add.status });
  }
  return result;
}

// ── Write-time recall (issue #918 Part B) ─────────────────────────────────────

/** Path-shaped tokens: `src/api/foo.py`, `docs/readme.md`, `.env.local`. */
const PATH_TOKEN_RE = /[\w./-]+\.[a-z]{1,4}/gi;

/** Bounded block caps: ~8 lines, ~600 chars — protects the prompt budget. */
const MAX_BLOCK_LINES = 8;
const MAX_BLOCK_CHARS = 600;
/** Per-line gist truncation. */
const MAX_GIST_CHARS = 120;

const BLOCK_HEADER =
  "<review-lessons>\nPast review findings for files you're about to touch (addressed N× — avoid repeating):";
const BLOCK_TAIL = "</review-lessons>";

/**
 * Normalize a cwd-relative or absolute path (tool paths) to repo-relative
 * ("/" separators), or null when it escapes the worktree root.
 */
export function normalizeRepoRelative(cwd: string, value: string): string | null {
  return normalizeAgainst(cwd, value, false);
}

/**
 * Normalize a repo-relative or absolute path that came from Git or the review
 * DB (branch diffs, comment paths) — resolved against the worktree ROOT, not
 * the session cwd, so a nested session does not rebase `src/api.ts` under its
 * subdirectory and lose the match against the DB's repo-relative paths.
 */
export function normalizeRepoRelativeFromRoot(cwd: string, value: string): string | null {
  return normalizeAgainst(cwd, value, true);
}

function normalizeAgainst(cwd: string, value: string, fromRoot: boolean): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!trimmed || trimmed === "." || trimmed === "..") return null;
  const root = resolveWorktreeRoot(cwd);
  const base = fromRoot ? root : cwd;
  const abs = isAbsolute(trimmed) ? trimmed : resolve(base, trimmed);
  const rel = relative(root, abs);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * Mechanically extract file paths from free text, resolved against `cwd`.
 * A token survives only when the file exists, or the token names a directory
 * prefix that exists (e.g. `docs/new-file.md` in an existing `docs/`) — this
 * filters prose noise like "e.g." and version numbers. URL fragments contain
 * "//" and are rejected.
 */
export function extractPathsFromText(text: string, cwd: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN_RE)) {
    const token = match[0]!;
    if (token.includes("//")) continue; // URL path fragments
    const abs = resolve(cwd, token);
    if (!existsSync(abs) && !(token.includes("/") && existsSync(dirname(abs)))) continue;
    const rel = normalizeRepoRelative(cwd, token);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/**
 * Paths changed on the current branch vs main: `git diff --name-only main...HEAD`,
 * falling back to `origin/main...HEAD`. Fresh branches / missing main / no git →
 * [] (fail-soft by design — the write-time hint covers what this misses).
 * Output is repo-relative — normalize with normalizeRepoRelativeFromRoot.
 */
export function branchDiffPaths(cwd: string): string[] {
  for (const range of ["main...HEAD", "origin/main...HEAD"]) {
    try {
      const out = execFileSync("git", ["diff", "--name-only", range], {
        cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
      });
      return out.split("\n").map((line) => line.trim()).filter(Boolean);
    } catch {
      // try the next base ref
    }
  }
  return [];
}

/** First sentence of a comment body, whitespace-collapsed, ≤ `max` chars. */
export function firstSentence(body: string, max = MAX_GIST_CHARS): string {
  // Prefer the un-buried finding title (badges/HTML/Markdown stripped — the
  // same extraction Part A distills with); fall back to the raw collapsed
  // body only when no title line can be extracted. Sentence-splitting then
  // applies to whichever text we got.
  const title = extractFindingTitle(body);
  const text = title ?? (body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const match = /^(.{2,}?[.!?])(?:\s|$)/.exec(text);
  const sentence = match?.[1] ?? text;
  return sentence.length > max ? `${sentence.slice(0, max - 3)}...` : sentence;
}

interface MatchedComment {
  id: number;
  path: string;
  body: string;
  title: string | null;
}

/**
 * Addressed comments for owner/repo matching any input path — path and repo
 * filtering pushed into SQL (hook latency must not grow with the entire
 * review history), with the `comments.title` column preferred and a
 * body-only fallback for legacy databases. LIKE patterns are re-verified in
 * memory (pathMatches) because `_` in paths is a LIKE wildcard.
 */
function matchedAddressedComments(dbPath: string, owner: string, repo: string, inputs: string[]): MatchedComment[] {
  if (inputs.length === 0) return [];
  const db = openReviewsDb(dbPath);
  if (!db) return [];
  try {
    const conds = inputs.map(() => "(c.path = ? OR c.path LIKE ? ESCAPE '\\' OR ? LIKE c.path || '/%' ESCAPE '\\')").join(" OR ");
    const params: string[] = [owner, repo];
    const like = (input: string) => input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    for (const input of inputs) params.push(input, `${like(input)}/%`, input);
    const query = (titleCol: string) =>
      db
        .prepare(
          `SELECT c.id, c.path, c.body${titleCol} FROM comments c ` +
            `JOIN reviews r ON c.review_id = r.id ` +
            `WHERE r.owner=? AND r.repo=? AND c.status='addressed' AND c.path IS NOT NULL AND (${conds})`,
        )
        .all(...params) as any[];
    let rows: any[];
    try {
      rows = query(", c.title");
    } catch {
      rows = query(""); // legacy DB without the `title` column
    }
    return rows.map((row) => ({
      id: Number(row.id),
      path: String(row.path),
      body: String(row.body ?? ""),
      title: typeof row.title === "string" && row.title.trim() ? row.title : null,
    }));
  } catch (error: any) {
    log.debug("reviews_db_query_failed", { dbPath, reason: String(error?.message ?? error).slice(0, 200) });
    return [];
  } finally {
    db.close();
  }
}

/** True when a DB comment path matches an input path (exact, or either side is a dir prefix of the other). */
function pathMatches(commentPath: string, inputPath: string): boolean {
  return commentPath === inputPath || commentPath.startsWith(`${inputPath}/`) || inputPath.startsWith(`${commentPath}/`);
}

export interface PathFindings {
  /** Repo-relative path of the finding (issue location). */
  path: string;
  /** Recurrences of THIS issue (same path + title) across all reviews. */
  count: number;
  /** Lesson text when memory has one for this issue, else the finding title. */
  text: string;
}

interface IssueGroup {
  path: string;
  title: string | null;
  body: string;
  ids: number[];
}

/**
 * Normalize one recall input: cwd-based (tool paths) by default, but when
 * only the worktree-root resolution exists (a repo-relative diff path seen
 * from a nested session cwd), prefer the root-based one — the DB stores
 * repo-relative paths, so the diff entry `src/api.py` must not be rebased
 * under `packages/inner/`.
 */
function normalizeInputPath(cwd: string, value: string): string | null {
  const cwdRel = normalizeRepoRelative(cwd, value);
  const rootRel = normalizeRepoRelativeFromRoot(cwd, value);
  if (cwdRel === null || rootRel === null) return cwdRel ?? rootRel;
  if (cwdRel === rootRel) return cwdRel;
  const root = resolveWorktreeRoot(cwd);
  const rootExists = existsSync(resolve(root, rootRel));
  const cwdExists = existsSync(resolve(cwd, cwdRel));
  if (rootExists && !cwdExists) return rootRel;
  return cwdRel;
}

/**
 * Collect findings relevant to `paths` — repo-isolated (owner/repo resolved
 * from the git remote, so another repository's reviews in the shared DB never
 * leak into this task) and grouped by distinct issue identity (path + title):
 * each issue is counted and rendered separately, so unrelated findings on one
 * file never masquerade as recurrences of the displayed one.
 *
 * Memory lessons surface only via review provenance (`derivedFrom` matching a
 * matched comment of this repo) — never by bare text mention, so unrelated
 * memories do not appear as review findings. The topic scan runs only when
 * the DB matched at least one comment.
 *
 * Ranked by per-issue count desc, then path asc. Never throws.
 */
export function collectPathFindings(
  cwd: string,
  paths: string[],
  repoInfoFn: (cwd: string) => RepoInfo | null = resolveRepoInfo,
): PathFindings[] {
  const inputs = [
    ...new Set(paths.map((p) => normalizeInputPath(cwd, p)).filter((p): p is string => Boolean(p))),
  ];
  if (inputs.length === 0) return [];
  const repo = repoInfoFn(cwd);
  if (!repo) return [];

  const dbPath = join(getProjectDataDir(cwd), "reviews.db");
  const rows = matchedAddressedComments(dbPath, repo.owner, repo.repo, inputs);

  // Group matched comments by distinct issue (path + title identity).
  const issues = new Map<string, IssueGroup>();
  const issueByCommentId = new Map<number, string>();
  for (const row of rows) {
    if (!inputs.some((input) => pathMatches(row.path, input))) continue; // LIKE-wildcard defense
    const title = row.title ?? extractFindingTitle(row.body);
    const identity = title ?? `body:${row.body.slice(0, 80)}`;
    const key = `${row.path}\0${identity.toLowerCase()}`;
    const group = issues.get(key) ?? { path: row.path, title, body: row.body, ids: [] };
    group.ids.push(row.id);
    issues.set(key, group);
    issueByCommentId.set(row.id, key);
  }

  // Memory lessons: only lesson entries whose reviews.db provenance resolves
  // to a matched comment of THIS repo (category + provenance + repo suffix).
  const lessonTextByIssue = new Map<string, string>();
  if (rows.length > 0) {
    try {
      const scores = loadScores(cwd);
      for (const entry of readAllTopicEntries(cwd)) {
        if (entry.category !== "lesson") continue;
        const hash = entryHash(`- [${entry.category}] ${entry.text}`);
        const derivedFrom = scores.entries[hash]?.derivedFrom;
        const provenance = derivedFrom ? /^reviews\.db:(\d+);([^/\s]+\/[^\s;]+)$/.exec(derivedFrom) : null;
        if (!provenance) continue;
        if (provenance[2] !== `${repo.owner}/${repo.repo}`) continue;
        const issue = issueByCommentId.get(Number(provenance[1]));
        if (issue && !lessonTextByIssue.has(issue)) lessonTextByIssue.set(issue, entry.text);
      }
    } catch (error: any) {
      log.debug("lesson_scan_failed", { reason: String(error?.message ?? error).slice(0, 200) });
    }
  }

  const findings: PathFindings[] = [];
  for (const [key, group] of issues) {
    const text = lessonTextByIssue.get(key) ?? group.title ?? firstSentence(group.body);
    if (!text) continue; // nothing displayable — skip rather than render an empty gist
    findings.push({ path: group.path, count: group.ids.length, text });
  }
  findings.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return findings;
}

/** Render findings as the bounded `<review-lessons>` block, or null when empty / nothing fits. */
export function formatFindingsBlock(findings: PathFindings[]): string | null {
  if (findings.length === 0) return null;
  let budget = MAX_BLOCK_CHARS - BLOCK_HEADER.length - BLOCK_TAIL.length - 1;
  const lines: string[] = [];
  for (const finding of findings) {
    if (lines.length >= MAX_BLOCK_LINES) break;
    let line = `- ${finding.path} (${finding.count}×): ${finding.text}`;
    const cost = (lines.length > 0 ? 1 : 0) + line.length;
    if (cost > budget) {
      if (lines.length === 0 && budget > 4) {
        lines.push(line.slice(0, budget));
        budget = 0;
      }
      break;
    }
    lines.push(line);
    budget -= cost;
  }
  if (lines.length === 0) return null;
  return `${BLOCK_HEADER}\n${lines.join("\n")}\n${BLOCK_TAIL}`;
}

/**
 * Bounded markdown block of past findings for `paths`, or undefined when
 * empty — the shared query behind all three injection surfaces. `repoInfoFn`
 * is injectable for tests (default: git remote origin).
 */
export function relevantFindings(
  cwd: string,
  paths: string[],
  repoInfoFn: (cwd: string) => RepoInfo | null = resolveRepoInfo,
): string | undefined {
  return formatFindingsBlock(collectPathFindings(cwd, paths, repoInfoFn)) ?? undefined;
}

/** Extract plain text from a `before_agent_start` custom message (string or content parts). */
export function customMessageText(message: any): string {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

// ── Extension wiring ───────────────────────────────────────────────────────

export interface ReviewLearningOptions {
  /** Repo resolution — injectable for tests (default: git remote origin). */
  repoInfo?: (cwd: string) => RepoInfo | null;
  /** Branch-diff path source — injectable for tests (default: git diff main...HEAD). */
  diffPaths?: (cwd: string) => string[];
}

export function createReviewLearning(options: ReviewLearningOptions = {}) {
  const repoInfo = options.repoInfo ?? resolveRepoInfo;
  const diffPaths = options.diffPaths ?? branchDiffPaths;

  // Write-time recall session state (Part B): paths that already received a
  // full injection this session, paths already checked (findings or not —
  // a no-findings path must not re-query the DB on every later write), and
  // whether any full block went out yet — later per-path hints degrade to
  // one-liners to protect the budget.
  const recall = {
    injectedPaths: new Set<string>(),
    checkedPaths: new Set<string>(),
    fullBlockInjected: false,
  };

  /**
   * Full distillation pipeline for one address fire. `command` identifies the
   * addressed PR (`--json` file → metadata.pr_number). Settings-gated,
   * fail-soft, and idempotent per review (distilled ids persist under
   * `.pi/data`).
   */
  const distill = async (cwd: string, command?: string): Promise<void> => {
    if (!getSetting(cwd, "review_learning")) {
      log.debug("disabled_by_setting", { cwd });
      return;
    }
    const repo = repoInfo(cwd);
    if (!repo) {
      log.debug("skipped_no_repo", { cwd });
      return;
    }
    const dataDir = getProjectDataDir(cwd);
    const dbPath = join(dataDir, "reviews.db");
    const prNumber = prNumberFromCommand(command, cwd);
    const review = getLatestReview(dbPath, repo.owner, repo.repo, prNumber);
    if (!review) {
      log.debug("skipped_no_review_row", { owner: repo.owner, repo: repo.repo, prNumber });
      return;
    }
    const distilled = loadDistilledReviews(dataDir);
    if (distilled.has(review.id)) {
      log.debug("skipped_review_already_distilled", { reviewId: review.id, prNumber: review.prNumber });
      return;
    }
    const findings = getAddressedComments(dbPath, review.id);
    if (findings.length === 0) {
      log.debug("skipped_no_addressed_findings", { reviewId: review.id });
      return;
    }
    log.info("distill_start", {
      owner: repo.owner, repo: repo.repo, prNumber: review.prNumber, reviewId: review.id, findings: findings.length,
    });
    const lessons = distillLessons(findings);
    if (lessons.length === 0) {
      log.info("distill_finish", { findings: findings.length, lessons: 0, reason: "no lessons distilled" });
      markReviewDistilled(dataDir, review.id);
      return;
    }
    const written = await writeLessonsToMemory(cwd, lessons, repo);
    markReviewDistilled(dataDir, review.id);
    log.info("distill_finish", {
      reviewId: review.id,
      findings: findings.length,
      lessons: lessons.length,
      added: written.added,
      reinforced: written.reinforced,
      rejected: written.rejected,
      skipped: written.skipped,
    });
  };

  const register = (pi: ExtensionAPI): void => {
    // Subagent children never run `reviews address` (main-session bash by design)
    // and receive their findings via the dispatch rewrite below, not by re-querying.
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    pi.on("session_start", () => {
      recall.injectedPaths.clear();
      recall.checkedPaths.clear();
      recall.fullBlockInjected = false;
    });

    // Part A — address-fire distillation watcher (first among tool_result
    // handlers; tests index it as handlers.get("tool_result")[0]).
    pi.on("tool_result", (event: any, ctx: any) => {
      try {
        if (event?.isError) return;
        const tool = String(event?.toolName ?? "").toLowerCase();
        if (tool !== "bash") return;
        const command = event?.input?.command;
        if (!isReviewsAddressCommand(command)) return;
        log.debug("address_detected", { cwd: ctx?.cwd });
        // Fire-and-forget, deferred past the handler's synchronous frame —
        // the tool result must not wait for git exec, SQLite queries, or the
        // provenance lookup (all sync I/O inside `distill` before its first
        // await). All failures are handled inside `distill` (log.warn, never
        // throw).
        setImmediate(() => {
          void distill(ctx.cwd, command).catch((error) =>
            log.warn("distill_unexpected_failure", { reason: String((error as any)?.message ?? error).slice(0, 300) }),
          );
        });
      } catch (error: any) {
        log.warn("tool_result_handler_failed", { reason: String(error?.message ?? error).slice(0, 300) });
      }
    });

    // Surface 1 — before_agent_start injection (graft-gate pattern).
    // Purely mechanical path extraction (prompt tokens + branch diff), sync
    // DB/git with timeouts, no model calls. Diff paths are repo-relative —
    // normalized against the worktree ROOT so nested sessions still match
    // the DB's repo-relative paths. Must be fast and never throw — other
    // before_agent_start handlers (graft gate, rules) must not stall.
    pi.on("before_agent_start", (event: any, ctx: any) => {
      try {
        const cwd = ctx?.cwd;
        if (typeof cwd !== "string" || !getSetting(cwd, "review_learning")) return;
        const prompt = event?.messageType === "user" && typeof event.prompt === "string"
          ? event.prompt
          : customMessageText(event?.message);
        const diff = diffPaths(cwd)
          .map((p) => normalizeRepoRelativeFromRoot(cwd, p))
          .filter((p): p is string => Boolean(p));
        const paths = [...extractPathsFromText(prompt, cwd), ...diff];
        const findings = collectPathFindings(cwd, paths, repoInfo);
        const block = formatFindingsBlock(findings);
        if (!block) return;
        for (const finding of findings) recall.injectedPaths.add(finding.path);
        recall.fullBlockInjected = true;
        log.info("recall_injected_prompt", { paths: findings.length, chars: block.length });
        // Prefer a custom prompt section (rules.ts pattern — preserves cached
        // prompt prefixes); fall back to the graft return shape when a prior
        // handler forced the whole prompt or sections are unavailable.
        const opts = event?.systemPromptOptions;
        const sections = opts?.sections;
        if (opts?.forceSystemPrompt === undefined && sections && typeof sections === "object") {
          sections.review_lessons = block;
          return;
        }
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      } catch (error: any) {
        log.debug("recall_prompt_failed", { reason: String(error?.message ?? error).slice(0, 300) });
        return undefined;
      }
    });

    // Surface 2 — first-write tool_result hint (graft blastHint pattern):
    // catches paths discovered mid-run that prompt extraction missed. Appends
    // once per path per session; a path is checked once per session whether
    // or not it has findings (a no-findings path must not re-query the DB on
    // every later write); one-liners after the first full block.
    pi.on("tool_result", (event: any, ctx: any) => {
      try {
        if (event?.isError) return;
        const tool = String(event?.toolName ?? "").toLowerCase();
        if (tool !== "write" && tool !== "edit") return;
        const cwd = ctx?.cwd;
        if (typeof cwd !== "string" || !getSetting(cwd, "review_learning")) return;
        const written = typeof event?.input?.path === "string" ? normalizeRepoRelative(cwd, event.input.path) : null;
        if (!written || recall.injectedPaths.has(written) || recall.checkedPaths.has(written)) return;
        recall.checkedPaths.add(written);
        const findings = collectPathFindings(cwd, [written], repoInfo);
        if (findings.length === 0) return;
        const top = findings[0]!;
        recall.injectedPaths.add(written);
        const hint = recall.fullBlockInjected
          ? `[review-lessons] ${top.path} (${top.count}×): ${top.text}`
          : formatFindingsBlock(findings);
        if (!hint) return;
        recall.fullBlockInjected = true;
        log.info("recall_injected_write", { path: written, count: top.count });
        return { content: [...(event.content ?? []), { type: "text", text: hint }] };
      } catch (error: any) {
        log.debug("recall_write_failed", { reason: String(error?.message ?? error).slice(0, 300) });
      }
    });

    // Surface 3 — specialist dispatch hook: specialists get no memory
    // injection, so append the block to each subagent task text — the
    // top-level task (single mode), every `tasks[]` entry (parallel), and
    // every `chain[]` entry (sequential), each resolving its own cwd
    // (item.cwd → input.cwd → ctx.cwd). In-place mutation only (enforcement
    // tool_call rewrite pattern — never other args).
    pi.on("tool_call", (event: any, ctx: any) => {
      try {
        if (String(event?.toolName ?? "").toLowerCase() !== "subagent") return;
        const input = event?.input;
        if (!input || typeof input !== "object") return;
        const targets: any[] = [];
        if (typeof input.task === "string" && input.task.trim()) targets.push(input);
        for (const key of ["tasks", "chain"]) {
          if (!Array.isArray(input[key])) continue;
          for (const item of input[key]) {
            if (item && typeof item === "object" && typeof item.task === "string" && item.task.trim()) targets.push(item);
          }
        }
        for (const item of targets) {
          const cwd =
            (typeof item.cwd === "string" && item.cwd.trim() && item.cwd) ||
            (typeof input.cwd === "string" && input.cwd.trim() && input.cwd) ||
            ctx?.cwd;
          if (typeof cwd !== "string" || !getSetting(cwd, "review_learning")) continue;
          const paths = extractPathsFromText(item.task, cwd);
          if (paths.length === 0) continue;
          const block = relevantFindings(cwd, paths, repoInfo);
          if (!block) continue;
          item.task = `${item.task}\n\n${block}`;
          log.info("recall_injected_subagent", { paths: paths.length, chars: block.length });
        }
      } catch (error: any) {
        log.debug("recall_subagent_failed", { reason: String(error?.message ?? error).slice(0, 300) });
      }
    });
  };

  return { register, distill };
}

export function registerReviewLearning(pi: ExtensionAPI): void {
  createReviewLearning().register(pi);
}
