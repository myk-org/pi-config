/**
 * What a review loop is reviewing, resolved from the worktree.
 *
 * The review state needs a subject to count rounds per loop; the caller cannot always know it (a
 * reviewer spawn knows its cwd, not the PR), so it is derived here: the open PR for the branch if
 * there is one, otherwise the commit being reviewed.
 *
 * The PR never comes from a synchronous `gh` call. `git-helpers` already owns that lookup with its
 * own cache, in-flight coalescing and refresh path (`getOpenPr` / `refreshOpenPr`), so this reads
 * the cache and asks for a background refresh — dispatch stays free of network waits.
 *
 * The subject carries the LOCAL head, never the PR's remote head: a round reviews the working tree,
 * so an unpushed commit is a new loop rather than an echo of the PR's previous count.
 */
import { execFileSync } from "node:child_process";
import type { Logger } from "../shared/logger.js";
import { getOpenPr, parseOpenPrJson, refreshOpenPr } from "./git-helpers.js";
import { subjectKey, type ReviewSubject } from "./pi-config-review-state.js";

/** Injectable lookups, so the subject shapes are testable without git, gh or a network. */
export interface ReviewSubjectDeps {
  headSha?: (cwd: string) => string | null;
  remoteUrl?: (cwd: string) => string | null;
  /** The open PR's number for this worktree, from cache only. */
  openPrNumber?: (cwd: string) => number | null;
}

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

/** Cold-cache fallbacks: one bounded `gh` call per worktree per minute, so the FIRST round of a
 *  session already names the PR instead of recording `local` and resetting to `pr` a round later. */
const COLD_LOOKUP_MS = 60_000;
const coldPr = new Map<string, { number: number | null; at: number }>();

function coldOpenPrNumber(cwd: string): number | null {
  // Keyed by branch as well as cwd (like `getOpenPr`): a cached number must never survive the
  // worktree switching branches, or the next round is attributed to the previous branch's PR.
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "detached";
  const key = `${cwd}\u0000${branch}`;
  const entry = coldPr.get(key);
  if (entry && Date.now() - entry.at < COLD_LOOKUP_MS) return entry.number;
  let number: number | null = null;
  try {
    // Same `--json` shape the shared parser expects; git-helpers keeps its own cache warm through
    // its async refresh, which is asked for below.
    const raw = execFileSync("gh", ["pr", "view", "--json", "number,url,state"], {
      cwd, encoding: "utf-8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"],
    });
    number = parseOpenPrJson(raw)?.number ?? null;
  } catch {
    number = null; // no PR, not a GitHub repo, or gh unavailable — the commit is the honest answer
  }
  coldPr.set(key, { number, at: Date.now() });
  return number;
}

/** The subject this worktree is reviewing right now: its open PR at the local head, else the commit.
 *  Returns null only when HEAD cannot be read (not a repo) — the caller then has nothing to count. */
export function resolveReviewSubject(cwd: string, logger: Logger, deps: ReviewSubjectDeps = {}): ReviewSubject | null {
  const head = (deps.headSha ?? ((dir: string) => git(dir, ["rev-parse", "HEAD"])))(cwd);
  if (!head) {
    logger.debug("review_subject_no_head", { cwd });
    return null;
  }
  const repo = parseRepoSlug((deps.remoteUrl ?? ((dir: string) => git(dir, ["remote", "get-url", "origin"])))(cwd));

  let number: number | null = null;
  if (repo) {
    number = (deps.openPrNumber ?? ((dir: string) => getOpenPr(dir)?.number ?? coldOpenPrNumber(dir)))(cwd);
    // Keep the shared cache warm for the rest of the session; never awaited here.
    if (number === null && !deps.openPrNumber) {
      void refreshOpenPr(cwd).catch(() => undefined);
      logger.debug("review_subject_refresh_scheduled", { cwd });
    }
  }

  const subject: ReviewSubject = repo && number !== null
    ? { kind: "pr", repo, number, head_sha: head }
    : { kind: "local", head_sha: head };
  logger.debug("review_subject_resolved", { cwd, subject: subjectKey(subject) });
  return subject;
}
