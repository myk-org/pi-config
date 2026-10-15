/**
 * review-learning.ts — distill addressed review findings into memory and
 * recall them at write time (issue #918 Parts A and B).
 *
 * Part A — a `tool_result` watcher recognizes `myk-pi-tools reviews address`
 * completions in main-session bash, then (fire-and-forget, never blocking the
 * tool result or the agent loop) distills the ADDRESSED findings for the
 * session's repo from `.pi/data/reviews.db` into one-line `lesson` memory
 * entries via the internal memory write path, with finding-id provenance
 * (`derivedFrom="reviews.db:<comment-id>;<owner>/<repo>"`) so re-fires
 * (multi-group address runs) reinforce instead of duplicating.
 *
 * Distillation is deterministic and model-free: the reviewer tool's finding
 * title (first meaningful line of the body, un-buried from badges/HTML/
 * Markdown) becomes the lesson, prefixed with the file path; exact title
 * collisions merge as duplicates of one issue. Zero model calls, zero cost,
 * fully testable (issue #918 decision: script-only engine).
 *
 * Distillation source is the DB, not the pr-*-reviews.json file — address
 * DELETES that JSON on the final status-group run. `skipped` findings are
 * excluded (ack-noise, false positives); only final `addressed` rows distill.
 *
 * Part B — write-time recall. Three injection surfaces surface past addressed
 * findings for files the agent is about to touch, ranked by recurrence:
 * 1. `before_agent_start` system-prompt section (paths named in the prompt +
 *    the issue-branch diff),
 * 2. a first-write `tool_result` hint for paths discovered mid-run,
 * 3. a `tool_call` rewrite appending the block to subagent task text.
 * All surfaces omit entirely when empty (zero added tokens), never make model
 * calls, and never throw.
 *
 * GUARD: these hooks assume `reviews address` runs in the main session (both
 * review-handler modes run Phases 2–8 in main-session bash); if address ever
 * moves into a poll worker, this goes blind — move the distillation trigger
 * with it.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { getSetting } from "./project-settings.js";
import { getProjectDataDir, resolveWorktreeRoot } from "./utils.js";
import { addMemoryEntry } from "./memory-write.js";
import { entryHash, loadScores, reinforce } from "./memory-scoring.js";
import { readAllTopicEntries } from "./memory-tree.js";

const log = createLogger("review-learning");

// ── Constants ──────────────────────────────────────────────────────────────

/** Per-fire caps (issue #918: per-cycle cap ~5 by severity protects the
 *  situation-report budget). */
const MAX_FINDINGS_PER_FIRE = 5;
const MAX_MEMORY_WRITES_PER_FIRE = 5;

/** Prompt-side body truncation per finding. */
const MAX_FINDING_BODY_CHARS = 500;
/** Hard ceiling on a distilled lesson line. */
const MAX_LESSON_CHARS = 100;

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
export function resolveRepoInfo(cwd: string): { owner: string; repo: string } | null {
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

/** Latest review row for owner/repo (append-only store — highest id is newest). */
export function getLatestReview(dbPath: string, owner: string, repo: string): ReviewRow | null {
  const db = openReviewsDb(dbPath);
  if (!db) return null;
  try {
    const row = db
      .prepare("SELECT id, commit_sha, owner, repo FROM reviews WHERE owner=? AND repo=? ORDER BY id DESC LIMIT 1")
      .get(owner, repo) as any;
    if (!row) return null;
    return { id: Number(row.id), commitSha: String(row.commit_sha), owner: String(row.owner), repo: String(row.repo) };
  } catch (error: any) {
    log.debug("reviews_db_query_failed", { dbPath, reason: String(error?.message ?? error).slice(0, 200) });
    return null;
  } finally {
    db.close();
  }
}

/** Addressed findings for a commit SHA (skipped rows excluded by design). */
export function getAddressedComments(dbPath: string, commitSha: string): AddressedFinding[] {
  const db = openReviewsDb(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        "SELECT c.id, c.path, c.line, c.body, c.priority, c.status " +
          "FROM comments c JOIN reviews r ON c.review_id = r.id " +
          "WHERE r.commit_sha=? AND c.status='addressed'",
      )
      .all(commitSha) as any[];
    return rows.map((row) => ({
      id: Number(row.id),
      path: typeof row.path === "string" ? row.path : null,
      line: row.line === null || row.line === undefined ? null : Number(row.line),
      body: String(row.body ?? ""),
      priority: typeof row.priority === "string" ? row.priority : null,
    }));
  } catch (error: any) {
    log.debug("reviews_db_query_failed", { dbPath, reason: String(error?.message ?? error).slice(0, 200) });
    return [];
  } finally {
    db.close();
  }
}

// ── Distillation (model call, injectable for tests) ────────────────────────

export interface DistilledLesson {
  findingId: number;
  text: string;
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function priorityRank(priority: string | null): number {
  return PRIORITY_ORDER[(priority ?? "").toLowerCase()] ?? 4;
}

/** Cap to MAX_FINDINGS_PER_FIRE, critical/high first, then by id. */
export function rankFindings(findings: AddressedFinding[]): AddressedFinding[] {
  return [...findings]
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.id - b.id)
    .slice(0, MAX_FINDINGS_PER_FIRE);
}

/**
 * Extract the finding's title line from a raw review body — deterministic,
 * no model. Reviewer tools (Qodo, CodeRabbit) write a human-readable title as
 * the first meaningful line, buried in badge images, HTML tags, and Markdown
 * emphasis. Skips badge/label lines, strips markup, returns null when no
 * meaningful line exists.
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
  const title = extractFindingTitle(f.body);
  if (!title) return null;
  const where = f.path ? `${f.path}: ` : "";
  const line = sanitizeLesson(`${where}${title}`);
  return line && line.length >= 15 ? line : null;
}

/**
 * Distill findings into lessons — pure, synchronous, zero model calls.
 * Findings whose cleaned titles (path + title) collide are duplicates of the
 * same issue (address.py dedupes by title at fetch time; reworded duplicates
 * across sources still collide only when identical) — the first by priority
 * rank wins and carries the provenance; the rest merge into it silently.
 */
export function distillLessons(findings: AddressedFinding[]): DistilledLesson[] {
  const seen = new Set<string>();
  const out: DistilledLesson[] = [];
  for (const finding of rankFindings(findings)) {
    const text = lessonFromFinding(finding);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue; // duplicate of an already-distilled lesson
    seen.add(key);
    out.push({ findingId: finding.id, text });
  }
  return out;
}


// ── Memory write with provenance dedupe ────────────────────────────────────

/** Provenance key for a review finding (issue #918: drill-down stays in the DB). */
export function findingProvenance(findingId: number, repo: { owner: string; repo: string }): string {
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
}

/**
 * Write distilled lessons through the internal memory path.
 * Existing `derivedFrom` provenance → reinforce (bump evidence — the
 * recurrence signal); otherwise add as category=lesson with provenance +
 * informs=["review-learning"]. Capped at MAX_MEMORY_WRITES_PER_FIRE.
 */
export async function writeLessonsToMemory(
  cwd: string,
  lessons: DistilledLesson[],
  repo: { owner: string; repo: string },
): Promise<WriteLessonsResult> {
  const result: WriteLessonsResult = { added: 0, reinforced: 0, rejected: 0 };
  for (const lesson of lessons.slice(0, MAX_MEMORY_WRITES_PER_FIRE)) {
    const derivedFrom = findingProvenance(lesson.findingId, repo);
    const existing = findMemoryLineByDerivedFrom(cwd, derivedFrom);
    if (existing && reinforce(cwd, existing)) {
      result.reinforced++;
      log.debug("lesson_reinforced", { derivedFrom });
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
    else result.rejected++;
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

/** Normalize a repo-relative or absolute path to repo-relative ("/" separators), or null when it escapes the worktree root. */
export function normalizeRepoRelative(cwd: string, value: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!trimmed || trimmed === "." || trimmed === "..") return null;
  const root = resolveWorktreeRoot(cwd);
  const abs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
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

/** All addressed comments with a path, across every review/commit SHA. */
function allAddressedComments(dbPath: string): { id: number; path: string; body: string }[] {
  const db = openReviewsDb(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare("SELECT id, path, body FROM comments WHERE status='addressed' AND path IS NOT NULL")
      .all() as any[];
    return rows.map((row) => ({ id: Number(row.id), path: String(row.path), body: String(row.body ?? "") }));
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
  /** Repo-relative path the agent is touching. */
  path: string;
  /** Addressed-comment occurrences across ALL commit SHAs (recurrence signal). */
  count: number;
  /** Lesson text when memory has one for this path, else the top comment's gist. */
  text: string;
}

/**
 * Collect findings relevant to `paths` from both sources:
 * - reviews DB: addressed comments matching any path (exact + dir-prefix),
 *   counted across all commit SHAs — recurrence is the ranking signal;
 * - memory lessons: entries whose `derivedFrom` provenance points at a matched
 *   DB comment, or whose text mentions a path (cheap scan — lessons already
 *   carry repo-scoped phrasing).
 * Ranked by count desc, then path asc. Never throws.
 */
export function collectPathFindings(cwd: string, paths: string[]): PathFindings[] {
  const inputs = [
    ...new Set(paths.map((p) => normalizeRepoRelative(cwd, p)).filter((p): p is string => Boolean(p))),
  ];
  if (inputs.length === 0) return [];

  const dbPath = join(getProjectDataDir(cwd), "reviews.db");
  const rows = allAddressedComments(dbPath);
  const counts = new Map<string, number>();
  const gists = new Map<string, string>();
  const pathById = new Map<number, string>();
  for (const row of rows) {
    pathById.set(row.id, row.path);
    for (const input of inputs) {
      if (pathMatches(row.path, input)) {
        counts.set(input, (counts.get(input) ?? 0) + 1);
        if (!gists.has(input)) gists.set(input, firstSentence(row.body));
      }
    }
  }

  // Memory lessons: derivedFrom provenance (`reviews.db:<id>;<owner>/<repo>`)
  // resolving to a matched comment path, or a plain text scan.
  const lessonByPath = new Map<string, string>();
  try {
    const scores = loadScores(cwd);
    for (const entry of readAllTopicEntries(cwd)) {
      const hash = entryHash(`- [${entry.category}] ${entry.text}`);
      const derivedFrom = scores.entries[hash]?.derivedFrom;
      let matched: string | null = null;
      const provenance = derivedFrom ? /^reviews\.db:(\d+);/.exec(derivedFrom) : null;
      if (provenance) {
        const commentPath = pathById.get(Number(provenance[1]));
        if (commentPath) matched = inputs.find((input) => pathMatches(commentPath, input)) ?? null;
      }
      if (!matched) matched = inputs.find((input) => entry.text.includes(input)) ?? null;
      if (matched && !lessonByPath.has(matched)) lessonByPath.set(matched, entry.text);
    }
  } catch (error: any) {
    log.debug("lesson_scan_failed", { reason: String(error?.message ?? error).slice(0, 200) });
  }

  const findings: PathFindings[] = [];
  for (const input of inputs) {
    const count = counts.get(input);
    if (!count && !lessonByPath.has(input)) continue;
    findings.push({ path: input, count: count ?? 1, text: lessonByPath.get(input) ?? gists.get(input) ?? "" });
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

/** Bounded markdown block of past findings for `paths`, or undefined when empty — the shared query behind all three injection surfaces. */
export function relevantFindings(cwd: string, paths: string[]): string | undefined {
  return formatFindingsBlock(collectPathFindings(cwd, paths)) ?? undefined;
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
  repoInfo?: (cwd: string) => { owner: string; repo: string } | null;
  /** Branch-diff path source — injectable for tests (default: git diff main...HEAD). */
  diffPaths?: (cwd: string) => string[];
}

export function createReviewLearning(options: ReviewLearningOptions = {}) {
  const repoInfo = options.repoInfo ?? resolveRepoInfo;
  const diffPaths = options.diffPaths ?? branchDiffPaths;

  // Write-time recall session state (Part B): paths that already received a
  // full injection this session, and whether any full block went out yet —
  // later per-path hints degrade to one-liners to protect the budget.
  const recall = { injectedPaths: new Set<string>(), fullBlockInjected: false };

  /** Full distillation pipeline for one address fire. Settings-gated, fail-soft. */
  const distill = async (cwd: string): Promise<void> => {
    if (!getSetting(cwd, "review_learning")) {
      log.debug("disabled_by_setting", { cwd });
      return;
    }
    const repo = repoInfo(cwd);
    if (!repo) {
      log.debug("skipped_no_repo", { cwd });
      return;
    }
    const dbPath = join(getProjectDataDir(cwd), "reviews.db");
    const review = getLatestReview(dbPath, repo.owner, repo.repo);
    if (!review) {
      log.debug("skipped_no_review_row", { owner: repo.owner, repo: repo.repo });
      return;
    }
    const findings = getAddressedComments(dbPath, review.commitSha);
    if (findings.length === 0) {
      log.debug("skipped_no_addressed_findings", { commitSha: review.commitSha.slice(0, 12) });
      return;
    }
    log.info("distill_start", { owner: repo.owner, repo: repo.repo, findings: findings.length });
    const lessons = distillLessons(findings);
    if (lessons.length === 0) {
      log.info("distill_finish", { findings: findings.length, lessons: 0, reason: "no lessons distilled" });
      return;
    }
    const written = await writeLessonsToMemory(cwd, lessons, repo);
    log.info("distill_finish", {
      findings: findings.length,
      lessons: lessons.length,
      added: written.added,
      reinforced: written.reinforced,
      rejected: written.rejected,
    });
  };

  const register = (pi: ExtensionAPI): void => {
    // Subagent children never run `reviews address` (main-session bash by design)
    // and receive their findings via the dispatch rewrite below, not by re-querying.
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    pi.on("session_start", () => {
      recall.injectedPaths.clear();
      recall.fullBlockInjected = false;
    });

    // Part A — address-fire distillation watcher (first among tool_result
    // handlers; tests index it as handlers.get("tool_result")[0]).
    pi.on("tool_result", (event: any, ctx: any) => {
      try {
        if (event?.isError) return;
        const tool = String(event?.toolName ?? "").toLowerCase();
        if (tool !== "bash") return;
        if (!isReviewsAddressCommand(event?.input?.command)) return;
        log.debug("address_detected", { cwd: ctx?.cwd });
        // Fire-and-forget (precedent: graft's `void refresh()`) — must not
        // delay the tool result or the agent loop. All failures are handled
        // inside `distill` (log.warn, never throw).
        void distill(ctx.cwd).catch((error) =>
          log.warn("distill_unexpected_failure", { reason: String((error as any)?.message ?? error).slice(0, 300) }),
        );
      } catch (error: any) {
        log.warn("tool_result_handler_failed", { reason: String(error?.message ?? error).slice(0, 300) });
      }
    });

    // Surface 1 — before_agent_start injection (graft-gate pattern).
    // Purely mechanical path extraction (prompt tokens + branch diff), sync
    // DB/git with timeouts, no model calls. Must be fast and never throw —
    // other before_agent_start handlers (graft gate, rules) must not stall.
    pi.on("before_agent_start", (event: any, ctx: any) => {
      try {
        const cwd = ctx?.cwd;
        if (typeof cwd !== "string" || !getSetting(cwd, "review_learning")) return;
        const prompt = event?.messageType === "user" && typeof event.prompt === "string"
          ? event.prompt
          : customMessageText(event?.message);
        const paths = [...extractPathsFromText(prompt, cwd), ...diffPaths(cwd)];
        const findings = collectPathFindings(cwd, paths);
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
    // once per path per session; one-liners after the first full block.
    pi.on("tool_result", (event: any, ctx: any) => {
      try {
        if (event?.isError) return;
        const tool = String(event?.toolName ?? "").toLowerCase();
        if (tool !== "write" && tool !== "edit") return;
        const cwd = ctx?.cwd;
        if (typeof cwd !== "string" || !getSetting(cwd, "review_learning")) return;
        const written = typeof event?.input?.path === "string" ? normalizeRepoRelative(cwd, event.input.path) : null;
        if (!written || recall.injectedPaths.has(written)) return;
        const findings = collectPathFindings(cwd, [written]);
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
    // injection, so append the block to the subagent task text (enforcement
    // tool_call rewrite pattern — mutate input in place, never other args).
    pi.on("tool_call", (event: any, ctx: any) => {
      try {
        if (String(event?.toolName ?? "").toLowerCase() !== "subagent") return;
        const input = event?.input;
        if (!input || typeof input.task !== "string" || !input.task.trim()) return;
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : ctx?.cwd;
        if (typeof cwd !== "string" || !getSetting(cwd, "review_learning")) return;
        const paths = extractPathsFromText(input.task, cwd);
        if (paths.length === 0) return;
        const block = relevantFindings(cwd, paths);
        if (!block) return;
        input.task = `${input.task}\n\n${block}`;
        log.info("recall_injected_subagent", { paths: paths.length, chars: block.length });
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
