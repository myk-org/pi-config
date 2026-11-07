/**
 * What a review loop is reviewing, resolved from the worktree.
 *
 * The review state needs a subject to count rounds per loop; the caller cannot always know it (a
 * reviewer spawn knows its cwd, not the PR), so it is derived here: the open PR for the branch if
 * there is one, otherwise the commit being reviewed.
 *
 * Two things this deliberately does NOT do:
 * - It never returns a stale identity as if it were current: the subject carries the LOCAL head, so
 *   unpushed commits start a new loop instead of hiding behind the PR's remote head.
 * - It never turns a failed `gh` call into "no PR": a network or auth error would restart the same
 *   PR's counting at 1 every round. A failure reuses what was resolved for that branch before.
 */
import { execFileSync } from "node:child_process";
import type { Logger } from "../shared/logger.js";
import { subjectKey, type ReviewSubject } from "./pi-config-review-state.js";

/** `gh pr view` outcomes: an open PR, genuinely no PR, or a lookup we could not complete. */
export type PrLookup =
  | { status: "open"; number: number }
  | { status: "none" }
  | { status: "error" };

/** Injectable lookups, so the PR branch is testable without git, gh or a network. */
export interface ReviewSubjectDeps {
  headSha?: (cwd: string) => string | null;
  branch?: (cwd: string) => string | null;
  remoteUrl?: (cwd: string) => string | null;
  openPr?: (cwd: string) => PrLookup;
}

/** A PR lookup is reused for this long: a reviewer batch must not pay a `gh` round-trip per spawn. */
const PR_CACHE_MS = 60_000;
const prCache = new Map<string, { number: number; at: number }>();

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** `owner/name` from the remote. Only a trailing `.git` is stripped — repository names may contain
 *  dots (`owner/my.repo`), and truncating at the first dot invented a different repository. */
export function parseRepoSlug(url: string | null): string | null {
  if (!url) return null;
  const match = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Parse `gh pr view --json number,headRefOid,state`. Pure so the shape is asserted without a
 *  network call — and so no value travels through a jq filter (in JavaScript `"\\(.x)"` loses its
 *  backslash to string escaping, which silently turned the number into "(.number)"). */
export function parseOpenPr(raw: string): { number: number; head_sha: string } | null {
  try {
    const data = JSON.parse(raw);
    if (data?.state !== "OPEN") return null;
    if (!Number.isInteger(data?.number) || data.number <= 0) return null;
    if (typeof data?.headRefOid !== "string" || data.headRefOid.length === 0) return null;
    return { number: data.number, head_sha: data.headRefOid };
  } catch {
    return null;
  }
}

function ghOpenPr(cwd: string): PrLookup {
  try {
    const raw = execFileSync("gh", ["pr", "view", "--json", "number,headRefOid,state"], {
      cwd, encoding: "utf-8", timeout: 3_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const pr = parseOpenPr(raw);
    return pr ? { status: "open", number: pr.number } : { status: "none" };
  } catch (error: any) {
    // `gh` exits non-zero for "no PR for this branch" too — that is a real answer, not a failure.
    const stderr = String(error?.stderr ?? "") + String(error?.message ?? "");
    return /no (?:open )?pull requests? found/i.test(stderr) ? { status: "none" } : { status: "error" };
  }
}

/** The subject this worktree is reviewing right now: its open PR at the local head, else the commit.
 *  Returns null only when HEAD cannot be read (not a repo) — the caller then has nothing to count. */
export function resolveReviewSubject(cwd: string, logger: Logger, deps: ReviewSubjectDeps = {}): ReviewSubject | null {
  const head = (deps.headSha ?? ((dir: string) => git(dir, ["rev-parse", "HEAD"])))(cwd);
  if (!head) {
    logger.debug("review_subject_no_head", { cwd });
    return null;
  }
  const branch = (deps.branch ?? ((dir: string) => git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])))(cwd) ?? "detached";
  const repo = parseRepoSlug((deps.remoteUrl ?? ((dir: string) => git(dir, ["remote", "get-url", "origin"])))(cwd));

  let number: number | null = null;
  if (repo) {
    const key = `${cwd}\u0000${branch}`;
    const cached = prCache.get(key);
    if (cached && Date.now() - cached.at < PR_CACHE_MS) {
      number = cached.number;
    } else {
      const lookup = (deps.openPr ?? ghOpenPr)(cwd);
      if (lookup.status === "open") {
        number = lookup.number;
        prCache.set(key, { number, at: Date.now() });
      } else if (lookup.status === "error") {
        // Reuse what this branch resolved before: a transient failure must not restart the loop.
        number = cached?.number ?? null;
        logger.warn("review_subject_pr_unavailable", { cwd, branch, reused: cached?.number ?? null });
      } else {
        prCache.delete(key);
      }
    }
  }

  // The local head, not the PR's remote head: a round reviews the working tree, and an unpushed
  // commit is a different loop even when the PR number has not changed.
  const subject: ReviewSubject = repo && number !== null
    ? { kind: "pr", repo, number, head_sha: head }
    : { kind: "local", head_sha: head };
  logger.debug("review_subject_resolved", { cwd, subject: subjectKey(subject) });
  return subject;
}

/** Test seam: drop cached PR lookups between assertions. */
export function resetReviewSubjectCache(): void {
  prCache.clear();
}
