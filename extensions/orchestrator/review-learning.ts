/**
 * review-learning.ts — distill addressed review findings into memory (issue #918 Part A).
 *
 * A `tool_result` watcher recognizes `myk-pi-tools reviews address` completions
 * in main-session bash, then (fire-and-forget, never blocking the tool result
 * or the agent loop) distills the ADDRESSED findings for the session's repo
 * from `.pi/data/reviews.db` into one-line `lesson` memory entries via the
 * internal memory write path, with finding-id provenance
 * (`derivedFrom="reviews.db:<comment-id>;<owner>/<repo>"`) so re-fires
 * (multi-group address runs) reinforce instead of duplicating.
 *
 * Distillation source is the DB, not the pr-*-reviews.json file — address
 * DELETES that JSON on the final status-group run. `skipped` findings are
 * excluded (ack-noise, false positives); only final `addressed` rows distill.
 *
 * GUARD: this hook assumes `reviews address` runs in the main session (both
 * review-handler modes run Phases 2–8 in main-session bash); if address ever
 * moves into a poll worker, this goes blind — move the distillation trigger
 * with it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { getSetting } from "./project-settings.js";
import { getProjectDataDir } from "./utils.js";
import { addMemoryEntry } from "./memory-write.js";
import { entryHash, loadScores, reinforce } from "./memory-scoring.js";
import { readAllTopicEntries } from "./memory-tree.js";

const log = createLogger("review-learning");

// ── Constants ──────────────────────────────────────────────────────────────

/** EnMaaS OpenAI-completions gateway (issue #918: small free distillation model). */
const ENMAAS_BASE_URL = "https://api.enmaas.devshift.net/v1";
const DEFAULT_MODEL = "rits/zai-org/glm-5-3";
const ENMAAS_TIMEOUT_MS = 60_000;
const ENMAAS_MAX_TOKENS = 2000;

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

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type CallModel = (messages: ChatMessage[]) => Promise<string>;

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

function buildMessages(ranked: AddressedFinding[], repo: { owner: string; repo: string } | null): ChatMessage[] {
  const system =
    "You distill addressed code-review findings into durable, repo-scoped engineering lessons.\n" +
    "Return ONLY a JSON array of strings — exactly one lesson per finding, in the same order as given.\n" +
    "Rules for each lesson:\n" +
    "- ONE line, at most 100 characters\n" +
    "- concrete and actionable: name the file pattern, API, endpoint, or command involved\n" +
    `- repo-scoped: mention this repository's domain, e.g. "rootcoz endpoints returning sensitive fields must call strip_sensitive_from_response"\n` +
    "- no fluff, no markdown, no surrounding quotes";
  const repoLine = repo ? `${repo.owner}/${repo.repo}` : "(unknown)";
  const findingLines = ranked.map(
    (f) =>
      `- id ${f.id} [${f.priority ?? "unknown"}] ${f.path ?? "(no path)"}:${f.line ?? "?"}\n` +
      `  ${f.body.slice(0, MAX_FINDING_BODY_CHARS)}`,
  );
  const user =
    `Repository: ${repoLine}\n\n` +
    `Addressed review findings:\n${findingLines.join("\n")}\n\n` +
    `Distill each finding into one lesson. Respond with the JSON array only.`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Sanitize one lesson: single line, non-empty, ≤ MAX_LESSON_CHARS. */
function sanitizeLesson(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  return oneLine.slice(0, MAX_LESSON_CHARS);
}

/**
 * Defensively parse the model response into lesson lines.
 * Strips code fences, extracts the outermost JSON array, accepts plain strings
 * or {lesson|text} objects. Throws on unparseable output.
 */
export function parseLessonsResponse(raw: string): string[] {
  if (typeof raw !== "string") throw new Error("model response is not a string");
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  const parsed = JSON.parse(text); // throws on garbage — caller logs and aborts
  if (!Array.isArray(parsed)) throw new Error("model response is not a JSON array");
  const lessons: string[] = [];
  for (const item of parsed) {
    const raw2 = typeof item === "string" ? item : (item as any)?.lesson ?? (item as any)?.text;
    const lesson = sanitizeLesson(raw2);
    if (lesson) lessons.push(lesson);
  }
  return lessons;
}

/**
 * Distill findings into lessons via the injected model call.
 * Model failures and parse failures are graceful: log.warn + empty result,
 * never a throw into the agent loop.
 */
export async function distillFindings(
  findings: AddressedFinding[],
  callModel: CallModel,
  repo: { owner: string; repo: string } | null = null,
): Promise<DistilledLesson[]> {
  const ranked = rankFindings(findings);
  if (ranked.length === 0) return [];
  let raw: string;
  try {
    raw = await callModel(buildMessages(ranked, repo));
  } catch (error: any) {
    log.warn("distill_model_failed", { findings: ranked.length, reason: String(error?.message ?? error).slice(0, 200) });
    return [];
  }
  let lessons: string[];
  try {
    lessons = parseLessonsResponse(raw);
  } catch (error: any) {
    log.warn("distill_parse_failed", { reason: String(error?.message ?? error).slice(0, 200) });
    return [];
  }
  // Index-mapped: the prompt demands one lesson per finding, same order.
  const out: DistilledLesson[] = [];
  for (let i = 0; i < lessons.length && i < ranked.length; i++) {
    out.push({ findingId: ranked[i]!.id, text: lessons[i]! });
  }
  return out;
}

// ── EnMaaS model call (thin wrapper — the only network touchpoint) ─────────

export function reviewLearningModel(): string {
  return process.env.REVIEW_LEARNING_MODEL?.trim() || DEFAULT_MODEL;
}

/** Key resolution: ENMAAS_API_KEY env → ~/.pi/agent/auth.json `EnMaaS.key`. */
export function resolveEnmaasApiKey(): string | null {
  const env = process.env.ENMAAS_API_KEY?.trim();
  if (env) return env;
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(authPath)) return null;
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    const key = auth?.EnMaaS?.key;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

/**
 * POST {baseUrl}/chat/completions, non-streaming, 60s timeout via
 * AbortSignal.timeout, single retry on 5xx/network error. 4xx fails fast.
 */
async function callEnmaas(messages: ChatMessage[]): Promise<string> {
  const key = resolveEnmaasApiKey();
  if (!key) throw new Error("EnMaaS API key unavailable (ENMAAS_API_KEY or ~/.pi/agent/auth.json EnMaaS.key)");
  const body = JSON.stringify({ model: reviewLearningModel(), messages, max_tokens: ENMAAS_MAX_TOKENS });
  let lastError: unknown = new Error("EnMaaS call failed");
  for (let attempt = 0; attempt < 2; attempt++) {
    let retryable = false;
    try {
      const res = await fetch(`${ENMAAS_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(ENMAAS_TIMEOUT_MS),
      });
      if (res.ok) {
        const data: any = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        return typeof content === "string" ? content : "";
      }
      lastError = new Error(`EnMaaS HTTP ${res.status}`);
      retryable = res.status >= 500;
    } catch (error) {
      lastError = error; // network / timeout / abort — retryable
      retryable = true;
    }
    if (!retryable || attempt === 1) throw lastError;
    log.debug("enmaas_retry", { attempt: attempt + 1, reason: String((lastError as any)?.message ?? lastError).slice(0, 200) });
  }
  throw lastError;
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

// ── Extension wiring ───────────────────────────────────────────────────────

export interface ReviewLearningOptions {
  /** Model call — injectable for tests (default: EnMaaS fetch wrapper). */
  callModel?: CallModel;
  /** Repo resolution — injectable for tests (default: git remote origin). */
  repoInfo?: (cwd: string) => { owner: string; repo: string } | null;
}

export function createReviewLearning(options: ReviewLearningOptions = {}) {
  const callModel = options.callModel ?? callEnmaas;
  const repoInfo = options.repoInfo ?? resolveRepoInfo;

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
    const lessons = await distillFindings(findings, callModel, repo);
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
    // Subagent children never run `reviews address` (main-session bash by design).
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
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
  };

  return { register, distill };
}

export function registerReviewLearning(pi: ExtensionAPI): void {
  createReviewLearning().register(pi);
}
