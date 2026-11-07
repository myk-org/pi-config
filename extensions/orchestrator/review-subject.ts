/**
 * What a review loop is reviewing, resolved from the worktree.
 *
 * The review state needs a subject to count rounds per loop; the caller cannot always know it
 * (a reviewer spawn knows its cwd, not the PR), so it is derived here: the open PR for the branch
 * if there is one, otherwise the commit being reviewed. Plan and issue reviews pass their own
 * subject explicitly.
 */
import { execFileSync } from "node:child_process";
import type { Logger } from "../shared/logger.js";
import { subjectKey, type ReviewSubject } from "./pi-config-review-state.js";

/** Resolved subjects are reused within a batch of reviewer spawns (`resolveReviewSubject` runs
 *  once per reviewer) but never across a change of HEAD or branch. */
const cache = new Map<string, { subject: ReviewSubject; at: number }>();
const CACHE_MS = 5_000;

function git(cwd: string, args: string[], logger: Logger): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    logger.debug("review_subject_git_failed", { args: args.join(" "), cwd });
    return null;
  }
}

/** `owner/name` from the remote, so a fork PR number cannot collide with ours. */
function repoSlug(cwd: string, logger: Logger): string | null {
  const url = git(cwd, ["remote", "get-url", "origin"], logger);
  if (!url) return null;
  const match = /github\.com[:/]+([^/]+)\/([^/.]+)/i.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Parse `gh pr view --json number,headRefOid,state`. Kept pure so the shape is tested without a
 *  network call — and so no value ever travels through a jq filter (in JavaScript `"\(.x)"` loses
 *  its backslash to string escaping, which silently turned the number into "(.number)"). */
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

function openPr(cwd: string, logger: Logger): { number: number; head_sha: string } | null {
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "view", "--json", "number,headRefOid,state"],
      { cwd, encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const pr = parseOpenPr(raw);
    if (!pr) logger.debug("review_subject_pr_unusable", { cwd });
    return pr;
  } catch {
    logger.debug("review_subject_no_open_pr", { cwd });
    return null;
  }
}

/** The subject this worktree is reviewing right now: its open PR, else its HEAD commit.
 *  Returns null only when the directory is not a git worktree — the caller then has nothing
 *  to count and must not start a round. */
export function resolveReviewSubject(cwd: string, logger: Logger): ReviewSubject | null {
  const head = git(cwd, ["rev-parse", "HEAD"], logger);
  if (!head) return null;
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], logger) ?? "detached";
  const cacheKey = `${cwd}\u0000${branch}\u0000${head}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.subject;

  let subject: ReviewSubject | null = null;
  const repo = repoSlug(cwd, logger);
  const pr = repo ? openPr(cwd, logger) : null;
  if (repo && pr) subject = { kind: "pr", repo, number: pr.number, head_sha: pr.head_sha };
  else subject = { kind: "local", head_sha: head }; // no PR yet, or not GitHub

  if (subject) cache.set(cacheKey, { subject, at: Date.now() });
  logger.debug("review_subject_resolved", { cwd, subject: subject ? subjectKey(subject) : null });
  return subject;
}
