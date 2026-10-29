/**
 * review-learning.ts — distill addressed review findings into memory and
 * recall them at write time (issue #918 Parts A and B).
 *
 * Part A — a `tool_result` watcher recognizes `myk-pi-tools reviews address`
 * AND `myk-pi-tools reviews store-session` completions in main-session bash, then (fire-and-forget — scheduled via
 * setImmediate so the handler returns before any synchronous I/O starts)
 * distills the ADDRESSED findings of the review that command stored from
 * `.pi/data/reviews.db` into one-line `lesson` memory entries via the internal
 * memory write path, with finding-id provenance
 * (`derivedFrom="reviews.db:<comment-id>;<owner>/<repo>"`).
 *
 * Review selection: the addressed PR is identified from the command's
 * address `--json` file or the store-session JSON's `pr_url`. For a known
 * PR, ALL stored review rows of that PR distill — session loops store one
 * row per commit (Qodo 16d84431). Lessons already successfully written are
 * tracked per review in `.pi/data/review-learning-state.json`, so re-fires
 * (multi-group address runs, partial runs, every store-session round) never
 * re-write them, and the per-fire lesson cap walks forward to the remaining
 * findings — evidence only grows
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
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { getSetting } from "./project-settings.js";
import { getProjectDataDir, resolveWorktreeRoot } from "./utils.js";
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

/** `reviews store-session` as a subcommand invocation (not `store-session-foo`). */
const REVIEWS_STORE_SESSION_RE = /(?:^|[\s;&|])reviews\s+store-session(?=[\s;&|]|$)/i;

/** Positional JSON path of a `reviews store-session <path>` invocation —
 *  stops at shell separators so a chained command
 *  (`store-session /tmp/x.json; echo done`) does not capture the `;`. */
const REVIEWS_STORE_SESSION_PATH_RE = /(?:^|[\s;&|])reviews\s+store-session\s+([^;\s&|]+)/i;

/** owner/repo/pr from a GitHub PR URL (`https://github.com/o/r/pull/N`). */
const PR_URL_PARTS_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;

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

/**
 * True when a bash command invokes `myk-pi-tools reviews store-session` —
 * the command a Qodo pr-review-session loop runs after every completed
 * round (issue #942/#944 coupling: session-stored reviews must distill the
 * same way address-stored ones do). `reviews store` alone never matches.
 */
export function isReviewsStoreSessionCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const normalized = command.trim();
  if (!/\bmyk-pi-tools\b/i.test(normalized)) return false;
  return REVIEWS_STORE_SESSION_RE.test(normalized);
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
 * All review rows for owner/repo/PR, oldest first — a session loop stores
 * ONE review row per commit (issue #942), so a PR's findings live in MANY
 * rows; distillation must process every group, not just the highest id
 * (Qodo 16d84431).
 */
export function getReviewsForPr(dbPath: string, owner: string, repo: string, prNumber: number): ReviewRow[] {
  const db = openReviewsDb(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        "SELECT id, pr_number, commit_sha, owner, repo FROM reviews WHERE owner=? AND repo=? AND pr_number=? ORDER BY id ASC",
      )
      .all(owner, repo, prNumber) as any[];
    return rows.map((row) => ({
      id: Number(row.id),
      prNumber: Number(row.pr_number),
      commitSha: String(row.commit_sha),
      owner: String(row.owner),
      repo: String(row.repo),
    }));
  } catch (error: any) {
    log.debug("reviews_db_query_failed", { dbPath, reason: String(error?.message ?? error).slice(0, 200) });
    return [];
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
    return new Set(ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0));
  } catch {
    return new Set();
  }
}

/**
 * Lesson texts already successfully written per review — persisted so a
 * retry after rejected writes re-attempts ONLY the rejected lessons (already
 * added/reinforced lessons must not be re-processed: reinforcement bumps
 * evidence without a new occurrence). Fail-soft.
 */
export function loadReviewLessons(dataDir: string): Map<number, Set<string>> {
  const byReview = new Map<number, Set<string>>();
  try {
    const raw = JSON.parse(readFileSync(stateFilePath(dataDir), "utf-8"));
    const entries = raw?.reviewLessons && typeof raw.reviewLessons === "object" ? raw.reviewLessons : {};
    for (const [id, texts] of Object.entries(entries)) {
      if (!Array.isArray(texts)) continue;
      byReview.set(Number(id), new Set(texts.filter((t): t is string => typeof t === "string")));
    }
  } catch {
    // fresh state
  }
  return byReview;
}

function writeStateFile(dataDir: string, distilledReviews: number[], reviewLessons: Map<number, Set<string>>): void {
  const lessons: Record<string, string[]> = {};
  const ids = [...reviewLessons.keys()];
  for (const id of ids.slice(-MAX_TRACKED_REVIEWS)) lessons[String(id)] = [...reviewLessons.get(id)!];
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    stateFilePath(dataDir),
    `${JSON.stringify({ distilledReviews: distilledReviews.slice(-MAX_TRACKED_REVIEWS), reviewLessons: lessons }, null, 2)}\n`,
  );
}

/** Record a review id as distilled (bounded — oldest entries drop off). Fail-soft. */
export function markReviewDistilled(dataDir: string, reviewId: number): void {
  try {
    // Dedupe: the PR walk re-marks already-distilled reviews on every fire
    // (their completed lessons make it a no-op walk), which would append the
    // same id once per fire and grow the state file without bound.
    const distilled = [...new Set(loadDistilledReviews(dataDir))];
    if (!distilled.includes(reviewId)) distilled.push(reviewId);
    writeStateFile(dataDir, distilled, loadReviewLessons(dataDir));
  } catch (error: any) {
    log.debug("distilled_state_write_failed", { reason: String(error?.message ?? error).slice(0, 200) });
  }
}

/** Record lesson texts completed for a review (retry bookkeeping). Fail-soft. */
export function recordReviewLessons(dataDir: string, reviewId: number, texts: string[]): void {
  try {
    const byReview = loadReviewLessons(dataDir);
    const done = byReview.get(reviewId) ?? new Set<string>();
    for (const t of texts) done.add(t);
    byReview.set(reviewId, done);
    writeStateFile(dataDir, [...loadDistilledReviews(dataDir)], byReview);
  } catch (error: any) {
    log.debug("review_lessons_state_write_failed", { reason: String(error?.message ?? error).slice(0, 200) });
  }
}

// ── Addressed-PR identification ────────────────────────────────────────────

/**
 * Expand `$VAR` / `${VAR}` shell expressions in a captured command path and
 * strip surrounding shell quotes. Bash expands these before the tool runs,
 * so the hook normally sees the literal path — but a command recorded with
 * the variable expression or quoted path (a combined poll+store line
 * submitted verbatim, `store-session "${PROJECT_TMP_DIR}/x.json"`) must
 * not read a nonexistent literal `"${...}"` path (Qodo 657c5633,
 * bda69aff). Unset variables expand to the empty string, matching shell
 * semantics.
 */
function expandEnvVars(value: string): string {
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced: string | undefined, plain: string | undefined) => process.env[braced ?? plain ?? ""] ?? "",
  );
  return expanded.replace(/^["']+|["']+$/g, "");
}

/**
 * True when a captured `--json` token is a shell redirection (e.g.
 * `2>/dev/null`), not a file path — the documented Qodo poll pipes
 * `--json 2>/dev/null`, and treating the redirect as a path makes the read
 * fail and lose the PR identity (Qodo beb11c94).
 */
function isRedirectionToken(token: string): boolean {
  return /^\d*>>?\S/.test(token) || token.startsWith(">") || token.includes("/dev/null");
}

/**
 * PR number of the review an address or store-session command targeted —
 * ONLY from the command's explicit inputs (the address `--json` file or the
 * store-session session JSON's `pr_url`).
 *
 * Order and failure semantics (Qodo beb11c94/86f1855b):
 * - A readable address `--json` file wins (partial runs keep it on disk).
 * - An unreadable/invalid `--json` token (redirection capture, deleted file
 *   on the final storing run) FALLS THROUGH to the store-session path
 *   instead of failing the whole lookup — a combined poll+store command
 *   still resolves its PR from the session JSON.
 * - An unreadable store-session JSON is logged (warn) — the caller decides
 *   not to fall back to the repository's newest review, which would distill
 *   a DIFFERENT PR's findings.
 * - No explicit input at all → null — callers then select the newest review
 *   for the repo (final storing runs), never a different explicit PR.
 */
export function prNumberFromCommand(command: string | undefined, cwd: string): number | null {
  const cmd = command ?? "";
  const m = /(?:^|\s)--json(?:\s+|=)(\S+)/.exec(cmd);
  if (m && !isRedirectionToken(m[1]!)) {
    try {
      const pr = Number(JSON.parse(readFileSync(resolve(cwd, expandEnvVars(m[1]!)), "utf-8"))?.metadata?.pr_number);
      if (Number.isInteger(pr) && pr > 0) return pr;
      log.debug("pr_from_address_json_invalid", { token: m[1]!.slice(0, 120) });
    } catch (error: any) {
      // Deleted file (final storing run) or bad token — fall through to the
      // store-session path; a null here would trigger the repo-newest
      // fallback and could distill another PR.
      log.debug("pr_from_address_json_unreadable", {
        token: m[1]!.slice(0, 120),
        reason: String(error?.message ?? error).slice(0, 120),
      });
    }
  }
  // `reviews store-session <path>`: the session JSON identifies its PR via
  // pr_url (issue #944) — the positional path replaces address's --json.
  const s = REVIEWS_STORE_SESSION_PATH_RE.exec(cmd);
  if (s) {
    try {
      const prUrl: unknown = JSON.parse(readFileSync(resolve(cwd, expandEnvVars(s[1]!)), "utf-8"))?.pr_url;
      if (typeof prUrl === "string") {
        const pr = Number(/\/pull\/(\d+)/.exec(prUrl)?.[1]);
        if (Number.isInteger(pr) && pr > 0) return pr;
        log.debug("pr_from_session_json_invalid", { prUrl: prUrl.slice(0, 120) });
      } else {
        log.debug("pr_from_session_json_no_pr_url", { path: s[1]!.slice(0, 200) });
      }
    } catch (error: any) {
      // The session JSON is never deleted by the loop — unreadable means a
      // real error (bad path, race). Loud, because the caller must NOT fall
      // back to the newest review: that would distill another PR's findings
      // (Qodo 86f1855b).
      log.warn("pr_from_session_json_unreadable", {
        path: s[1]!.slice(0, 200),
        reason: String(error?.message ?? error).slice(0, 200),
      });
    }
  }
  return null;
}

/**
 * The FULL review target a command names — owner/repo/prNumber from the
 * address `--json` metadata or the store-session pr_url — or null when the
 * command carries no readable target. Used by distill() to query the repo
 * the rows were actually STORED under: a fork-hosted session stores rows
 * under the pr_url's upstream repo while origin names the fork, and a
 * PR-number-only lookup against origin would find nothing (Qodo befc495a).
 */
export function prTargetFromCommand(
  command: string | undefined,
  cwd: string,
): { owner: string; repo: string; prNumber: number } | null {
  const cmd = command ?? "";
  const m = /(?:^|\s)--json(?:\s+|=)(\S+)/.exec(cmd);
  if (m && !isRedirectionToken(m[1]!)) {
    try {
      const meta = JSON.parse(readFileSync(resolve(cwd, expandEnvVars(m[1]!)), "utf-8"))?.metadata;
      const owner = typeof meta?.owner === "string" ? meta.owner : null;
      const repo = typeof meta?.repo === "string" ? meta.repo : null;
      const pr = Number(meta?.pr_number);
      if (owner && repo && Number.isInteger(pr) && pr > 0) return { owner, repo, prNumber: pr };
    } catch {
      // unreadable --json — try the store-session path
    }
  }
  const s = REVIEWS_STORE_SESSION_PATH_RE.exec(cmd);
  if (s) {
    try {
      const prUrl: unknown = JSON.parse(readFileSync(resolve(cwd, expandEnvVars(s[1]!)), "utf-8"))?.pr_url;
      if (typeof prUrl === "string") {
        const parts = PR_URL_PARTS_RE.exec(prUrl.trim());
        if (parts) {
          const pr = Number(parts[3]);
          if (Number.isInteger(pr) && pr > 0) return { owner: parts[1]!, repo: parts[2]!, prNumber: pr };
        }
      }
    } catch {
      // unreadable session JSON — prNumberFromCommand already warned
    }
  }
  return null;
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
 * The finding's cleaned title line — UNTRUNCATED (only the body scan is
 * bounded by MAX_FINDING_BODY_CHARS). Deterministic, no model. Reviewer tools
 * (Qodo, CodeRabbit) write a human-readable title as the first meaningful
 * line, buried in badge images, HTML tags, and Markdown emphasis. Skips
 * badge/label lines, strips markup, returns null when no meaningful line
 * exists. The untruncated form is the IDENTITY for issue grouping and
 * dedupe — truncating before grouping would collapse distinct findings
 * whose titles first differ past the display limit.
 */
export function cleanTitleLine(body: string): string | null {
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
    return line;
  }
  return null;
}

/**
 * The finding's display title: the cleaned title line truncated to `max`
 * (default MAX_LESSON_CHARS — Part A's lesson cap). Legacy-DB fallback for
 * rows without `comments.title`.
 */
export function extractFindingTitle(body: string, max: number = MAX_LESSON_CHARS): string | null {
  const line = cleanTitleLine(body);
  return line ? line.slice(0, max) : null;
}

/** Sanitize one lesson: single line, non-empty, ≤ MAX_LESSON_CHARS. */
function sanitizeLesson(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  // NOT capped here — callers decide how to truncate (lessonFromFinding
  // reserves room for a digest suffix so truncated twins stay distinct).
  return oneLine;
}

/** Stable short digest (FNV-1a, 8 hex chars) — distinguishes truncated twins. */
function shortDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Deterministic lesson line for one finding: `<path>: <title>`, capped at
 * MAX_LESSON_CHARS. When the full line needs truncation, a stable digest of
 * the UNTRUNCATED line is appended — two distinct findings whose titles
 * first differ past the cap must not collapse into one memory entry (their
 * identical truncated text would make the second write a reinforcement of
 * the first instead of a distinct lesson).
 */
export function lessonFromFinding(f: AddressedFinding): string | null {
  const title = f.title ?? extractFindingTitle(f.body);
  if (!title) return null;
  const where = f.path ? `${f.path}: ` : "";
  const full = sanitizeLesson(`${where}${title}`);
  if (!full || full.length < 15) return null;
  if (full.length <= MAX_LESSON_CHARS) return full;
  const digest = shortDigest(full);
  return `${full.slice(0, MAX_LESSON_CHARS - digest.length - 1)}~${digest}`;
}

/** Untruncated issue identity for one finding: `<path>: <full title>` (lowercased) — see cleanTitleLine. */
function findingIdentity(f: AddressedFinding): string | null {
  const full = cleanTitleLine(f.body) ?? f.title;
  if (!full) return null;
  return `${f.path ?? ""}\0${full.toLowerCase()}`;
}

/**
 * Distill findings into lessons — pure, synchronous, zero model calls.
 * Findings are ranked, lessons extracted and validated for ALL of them, and
 * only then capped at MAX_FINDINGS_PER_FIRE (unusable bodies never consume
 * slots). Findings whose lessons collide are duplicates of the same issue —
 * they merge into one lesson that carries every contributing finding id, so
 * provenance lookups can distinguish new occurrences from re-fires. The
 * dedupe key is the UNTRUNCATED identity (two findings whose titles first
 * differ past the 100-char display cap stay distinct lessons).
 *
 * `completedTexts` (lesson texts already written for this review, from the
 * persisted reviewLessons state) are excluded BEFORE the cap — a review with
 * more findings than the per-fire cap distills its remaining lessons on the
 * NEXT fire instead of re-picking the same top slice forever (Qodo
 * 16d84431): session loops re-fire store-session every round, so the walk
 * completes across rounds. It also makes findings APPENDED to an
 * already-processed review row distill: their lessons are not in the
 * completed set, so they surface as pending work.
 */
export function distillLessons(
  findings: AddressedFinding[],
  completedTexts: Set<string> = new Set(),
  cap: number = MAX_FINDINGS_PER_FIRE,
): DistilledLesson[] {
  const byIdentity = new Map<string, DistilledLesson>();
  for (const finding of rankFindings(findings)) {
    const text = lessonFromFinding(finding);
    if (!text) continue;
    const key = findingIdentity(finding) ?? text.toLowerCase();
    const existing = byIdentity.get(key);
    if (existing) existing.findingIds.push(finding.id); // merged duplicate keeps its identity
    else byIdentity.set(key, { findingIds: [finding.id], text });
  }
  const pool = completedTexts.size > 0
    ? [...byIdentity.values()].filter((lesson) => !completedTexts.has(lesson.text))
    : [...byIdentity.values()];
  return pool.slice(0, Math.max(0, cap));
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
  /** Lesson texts COMPLETED in this call (added/reinforced/skipped — not rejected). */
  completed: string[];
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
  const result: WriteLessonsResult = { added: 0, reinforced: 0, rejected: 0, skipped: 0, completed: [] };
  for (const lesson of lessons.slice(0, MAX_MEMORY_WRITES_PER_FIRE)) {
    const derivedFrom = findingProvenance(lesson.findingIds[0]!, repo);
    if (findMemoryLineByDerivedFrom(cwd, derivedFrom)) {
      result.skipped++;
      result.completed.push(lesson.text);
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
    if (add.status !== "rejected") result.completed.push(lesson.text);
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
  // body only when no title line can be extracted. The UNTRUNCATED title is
  // used so the gist limit applies exactly once — a 101–120-character title
  // keeps its full content (with the normal ellipsis beyond 120) instead of
  // being silently cut at Part A's 100-character lesson cap.
  const title = cleanTitleLine(body);
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
 * Collect findings relevant to `paths` — repo-isolated (owner/repo resolved
 * from the git remote, so another repository's reviews in the shared DB never
 * leak into this task) and grouped by distinct issue identity (path +
 * UNTRUNCATED title): each issue is counted and rendered separately, so
 * unrelated findings on one file never masquerade as recurrences of the
 * displayed one, and findings whose titles first differ past the 100-char
 * display cap stay distinct.
 *
 * Inputs are repo-relative paths: they are normalized against the worktree
 * ROOT only (never reinterpreted cwd-relative — in a nested session a
 * repo-relative path must not be rebased onto a nested copy of the file).
 * Callers with cwd-relative TOOL paths (write/edit inputs) normalize them
 * cwd-side first. Memory lessons surface only via review provenance
 * (`derivedFrom` matching a matched comment of this repo) — never by bare
 * text mention. The topic scan runs only when the DB matched at least one
 * comment. Ranked by per-issue count desc, then path asc. Never throws.
 */
export function collectPathFindings(
  cwd: string,
  paths: string[],
  repoInfoFn: (cwd: string) => RepoInfo | null = resolveRepoInfo,
): PathFindings[] {
  const inputs = [
    ...new Set(
      paths.map((p) => normalizeRepoRelativeFromRoot(cwd, p)).filter((p): p is string => Boolean(p)),
    ),
  ];
  if (inputs.length === 0) return [];
  const repo = repoInfoFn(cwd);
  if (!repo) return [];

  const dbPath = join(getProjectDataDir(cwd), "reviews.db");
  const rows = matchedAddressedComments(dbPath, repo.owner, repo.repo, inputs);

  // Group matched comments by distinct issue (path + untruncated title identity).
  const issues = new Map<string, IssueGroup>();
  const issueByCommentId = new Map<number, string>();
  for (const row of rows) {
    if (!inputs.some((input) => pathMatches(row.path, input))) continue; // LIKE-wildcard defense
    // Identity: the UNTRUNCATED title recovered from the raw body (both
    // thread and sticky bodies carry the full title line) — never the
    // 100-char display title, which would collapse distinct findings.
    const full = cleanTitleLine(row.body) ?? row.title;
    const identity = full ?? `body:${row.body.slice(0, 120)}`;
    const key = `${row.path}\0${identity.toLowerCase()}`;
    const group = issues.get(key) ?? {
      path: row.path,
      title: row.title ?? (full ? full.slice(0, MAX_LESSON_CHARS) : null),
      body: row.body,
      ids: [],
    };
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
  /** Lesson writer — injectable for tests (default: writeLessonsToMemory). */
  writeLessons?: typeof writeLessonsToMemory;
}

/**
 * The running module's mtime as an ISO stamp — the reload-observability
 * signal. Fail-soft: returns null when the stat lookup throws (a broken
 * stamp must never fail registration).
 */
export function moduleMtimeStamp(modulePath: string = fileURLToPath(import.meta.url)): string | null {
  try {
    return statSync(modulePath).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Emit the reload-status stamp through `logger` (injectable for tests). */
export function emitReviewLearningLoaded(
  logger: { info: (event: string, data?: unknown) => void } = log,
): void {
  const moduleMtime = moduleMtimeStamp();
  if (moduleMtime) logger.info("review_learning_loaded", { moduleMtime });
}

export function createReviewLearning(options: ReviewLearningOptions = {}) {
  const repoInfo = options.repoInfo ?? resolveRepoInfo;
  const diffPaths = options.diffPaths ?? branchDiffPaths;
  const writeLessons = options.writeLessons ?? writeLessonsToMemory;
  /** In-flight distill gates per review id — serializes overlapping fires. */
  const distillLocks = new Map<number, Promise<void>>();

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
   * Full distillation pipeline for one address or store-session fire.
   * `command` identifies the addressed PR (address `--json` file →
   * metadata.pr_number, or the store-session JSON's pr_url — no
   * newest-JSON fallback, which could target a leftover file from another
   * PR after the final run deletes its own). Selection is PR-SCOPED when
   * the PR is known: ALL review rows of that PR are processed — session
   * loops store one row per commit, so earlier groups and findings appended
   * to already-processed rows must distill too (Qodo 16d84431). A store-
   * session command whose PR cannot be resolved is a NO-OP (never the
   * repo-newest fallback — that would distill another PR, Qodo 86f1855b).
   * Repo-wide newest selection happens ONLY when no explicit target exists
   * (prNumber null — the final storing run whose JSON was just deleted).
   * A review whose lesson writes were REJECTED stays retryable, but only its
   * UNWRITTEN lessons are re-attempted (completed lessons are persisted per
   * review — re-processing them would inflate evidence without a new
   * occurrence). Settings-gated, fail-soft.
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
    const distilled = loadDistilledReviews(dataDir);
    const prNumber = prNumberFromCommand(command, cwd);
    if (prNumber === null && command !== undefined && isReviewsStoreSessionCommand(command)) {
      // The session JSON is the loop's own record and is never deleted — an
      // unresolved PR means the read failed; falling back to the newest
      // review would distill a DIFFERENT PR's findings.
      log.warn("skipped_store_session_pr_unresolved", {
        cwd,
        command: String(command).slice(0, 120),
      });
      return;
    }
    let reviews: ReviewRow[];
    /** The repo the matched rows are stored under — lesson provenance must
     *  name it, not the checkout origin: a fork session stores rows (and
     *  recalls them) under the pr_url repo, and provenance keyed to the
     *  fork would never match at write time (Qodo 66cc6bfe). */
    let rowsRepo: RepoInfo = repo;
    if (prNumber !== null) {
      // Explicit target: every review row of the PR, oldest first. The
      // command-named repo (address --json metadata or session pr_url) is
      // AUTHORITATIVE — rows are always stored under the repo the fetch/
      // store ran as, so a target with no rows is a no-op, NEVER a fall
      // back to origin: an unrelated same-numbered PR there would distill
      // the wrong repository's findings (Qodo 1c8fc091). A fork checkout
      // (origin = fork, rows under the upstream pr_url repo) still finds
      // its rows through the target.
      const target = prTargetFromCommand(command, cwd);
      if (target) {
        rowsRepo = { owner: target.owner, repo: target.repo };
        reviews = getReviewsForPr(dbPath, target.owner, target.repo, prNumber);
      } else {
        reviews = getReviewsForPr(dbPath, repo.owner, repo.repo, prNumber);
      }
      if (reviews.length === 0) {
        log.debug("skipped_no_review_row", {
          owner: rowsRepo.owner, repo: rowsRepo.repo, prNumber,
          origin: `${repo.owner}/${repo.repo}`,
        });
        return;
      }
    } else {
      // No explicit target (final storing run deleted its JSON): the newest
      // review for the repo is exactly the just-stored row. Already
      // distilled → no-op (nothing can have been appended without a PR).
      const latest = getLatestReview(dbPath, repo.owner, repo.repo);
      if (!latest) {
        log.debug("skipped_no_review_row", { owner: repo.owner, repo: repo.repo, prNumber: null });
        return;
      }
      if (distilled.has(latest.id)) {
        log.debug("skipped_review_already_distilled", { reviewId: latest.id, prNumber: latest.prNumber });
        return;
      }
      reviews = [latest];
    }
    // Per-FIRE write budget across ALL reviews of the PR (Qodo 062e8e28):
    // the docs' "~5 lessons per fire" cap is per distill() call, not per
    // review row — a multi-round PR must not dump 5×N lessons into memory
    // at once. Remaining lessons distill on the next fire (completed-aware
    // lesson selection walks forward).
    let budget = MAX_MEMORY_WRITES_PER_FIRE;
    let writes = 0;
    let remainingLessons = 0;
    for (const review of reviews) {
      if (budget <= 0) {
        log.debug("distill_budget_exhausted", { reviewId: review.id, prNumber: review.prNumber });
        remainingLessons += 1; // at least this review still has pending work
        continue;
      }
      const result = await distillWithLock(cwd, review, dataDir, dbPath, rowsRepo, budget);
      budget -= result.consumed;
      writes += result.writes;
      remainingLessons += result.remaining;
    }
    if (remainingLessons > 0 && writes > 0) {
      // Lessons remain and this fire made progress — schedule the next
      // burst so a session's FINAL store still drains every lesson (no
      // later trigger exists after convergence, Qodo eceb273e). Progress
      // gating (writes > 0) prevents an infinite loop when every remaining
      // lesson is persistently rejected.
      log.debug("distill_continuation_scheduled", { remainingLessons, writes });
      setImmediate(() => {
        void distill(cwd, command).catch((error) =>
          log.warn("distill_unexpected_failure", { reason: String((error as any)?.message ?? error).slice(0, 300) }),
        );
      });
    }
  };

  /**
   * Per-review serialization: overlapping address fires (two bash results in
   * one turn, a retried command) would otherwise both read the completed-
   * lesson state before either async write finishes and double-write the
   * same lessons — inflating counts and evidence. The second fire waits for
   * the first, then re-reads state (the first may have just completed the
   * review) before doing any work. Returns the number of memory writes
   * consumed (bounded by `budget` — the per-fire cap is shared across all
   * reviews of the PR, Qodo 062e8e28).
   */
  const distillWithLock = async (
    cwd: string,
    review: ReviewRow,
    dataDir: string,
    dbPath: string,
    repo: RepoInfo,
    budget: number,
  ): Promise<{ consumed: number; writes: number; remaining: number }> => {
    const previous = distillLocks.get(review.id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    distillLocks.set(review.id, current);
    try {
      await previous;
      return await distillLockedReview(cwd, review, dataDir, dbPath, repo, budget);
    } finally {
      release();
      if (distillLocks.get(review.id) === current) distillLocks.delete(review.id);
    }
  };

  /**
   * The distill pipeline body — runs holding the per-review lock. Budget is
   * the fire's remaining write allowance; REJECTED lessons do not consume
   * it (a persistently rejected lesson must not starve the PR's later
   * reviews, Qodo 850bb32d — it is re-attempted on later fires for free).
   * A review whose lessons were cut short by the budget is not marked
   * distilled-error: the completed-aware lesson walk picks up its remainder
   * on the next fire.
   */
  const distillLockedReview = async (
    cwd: string,
    review: ReviewRow,
    dataDir: string,
    dbPath: string,
    repo: RepoInfo,
    budget: number,
  ): Promise<{ consumed: number; writes: number; remaining: number }> => {
    const findings = getAddressedComments(dbPath, review.id);
    if (findings.length === 0) {
      log.debug("skipped_no_addressed_findings", { reviewId: review.id });
      return { consumed: 0, writes: 0, remaining: 0 };
    }
    log.info("distill_start", {
      owner: repo.owner, repo: repo.repo, prNumber: review.prNumber, reviewId: review.id, findings: findings.length,
    });
    // Per-lesson retry bookkeeping BEFORE the cap: lessons already written
    // for this review are excluded upstream of MAX_FINDINGS_PER_FIRE, so a
    // review with more findings than one fire's cap distills its remaining
    // lessons on the next fire (Qodo 16d84431).
    const completed = loadReviewLessons(dataDir).get(review.id) ?? new Set<string>();
    const lessons = distillLessons(findings, completed);
    if (lessons.length === 0) {
      log.info("distill_finish", { findings: findings.length, lessons: 0, reason: "no lessons distilled" });
      markReviewDistilled(dataDir, review.id);
      return { consumed: 0, writes: 0, remaining: 0 };
    }
    const pending = lessons.slice(0, Math.max(0, budget));
    if (pending.length === 0) {
      log.debug("distill_budget_exhausted_before_review", { reviewId: review.id });
      return { consumed: 0, writes: 0, remaining: 1 };
    }
    const written = await writeLessons(cwd, pending, repo);
    if (written.completed.length > 0) recordReviewLessons(dataDir, review.id, written.completed);
    // Only actual memory writes consume the budget — rejected lessons are
    // re-attempted on later fires without starving anyone (Qodo 850bb32d).
    const consumed = written.added + written.reinforced + written.skipped;
    if (written.rejected > 0) {
      // Rejected writes are retryable, not complete — the review stays
      // unmarked; the next fire re-attempts ONLY the still-unwritten lessons.
      log.warn("distill_incomplete", {
        reviewId: review.id,
        rejected: written.rejected,
        completed: written.completed.length,
        pending: pending.length,
      });
    }
    // The review is marked distilled only when every distinct lesson was
    // completed; a review cut short by the budget (or with rejected
    // lessons) stays unmarked — the next fire re-runs it (completed-aware)
    // and writes the remainder.
    const totalLessons = distillLessons(findings, new Set(), Number.MAX_SAFE_INTEGER).length;
    const doneAfter = completed.size + written.completed.length;
    if (doneAfter >= totalLessons) {
      markReviewDistilled(dataDir, review.id);
    }
    log.info("distill_finish", {
      reviewId: review.id,
      findings: findings.length,
      lessons: lessons.length,
      added: written.added,
      reinforced: written.reinforced,
      rejected: written.rejected,
      skipped: written.skipped,
      budgetRemaining: budget - consumed,
    });
    return { consumed, writes: consumed, remaining: doneAfter >= totalLessons ? 0 : 1 };
  };

  const register = (pi: ExtensionAPI): void => {
    // Reload observability: stamp the running module's mtime at registration
    // (registration re-runs on /reload). Comparing this against the deployed
    // file's mtime answers "is the session running the deployed code?"
    // mechanically — no guessing about whether a reload happened.
    emitReviewLearningLoaded();

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
        if (!isReviewsAddressCommand(command) && !isReviewsStoreSessionCommand(command)) return;
        log.debug("address_detected", { cwd: ctx?.cwd, command: String(command).slice(0, 120) });
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

    // Surface 1 — before_agent_start injection (trail-gate pattern).
    // Purely mechanical path extraction (prompt tokens + branch diff), sync
    // DB/git with timeouts, no model calls. Diff paths are repo-relative —
    // normalized against the worktree ROOT so nested sessions still match
    // the DB's repo-relative paths. Must be fast and never throw — other
    // before_agent_start handlers (trail gate, rules) must not stall.
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
        // prompt prefixes); fall back to a replacement prompt when a prior
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

    // Surface 2 — first-write tool_result hint (trail blastHint pattern):
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
          // Extract paths relative to BOTH the specialist cwd and the
          // worktree root: a nested-cwd specialist asked about a root-relative
          // path (src/api.py) would otherwise lose it — existence is checked
          // beneath the extraction base only, and the child registers no
          // recall hooks of its own.
          const root = resolveWorktreeRoot(cwd);
          const paths = [...new Set([...extractPathsFromText(item.task, cwd), ...extractPathsFromText(item.task, root)])];
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
