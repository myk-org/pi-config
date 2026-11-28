/**
 * Git diff and worktree helpers for pidiff-server.
 *
 * Uses `git cat-file --batch` to read all object blobs for a diff pass in a
 * single subprocess instead of spawning `git show` up to twice per file.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../extensions/shared/logger.ts";

const execFileAsync = promisify(execFile);

const log = createLogger("pidiff");

export interface FileContentsData {
  name: string;
  oldContents: string;
  newContents: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface ParsedDiffEntry {
  name: string;
  oldName: string;
  status: FileContentsData["status"];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

/** Parse `git diff --name-status` stdout into structured entries. */
export function parseDiffEntries(raw: string): ParsedDiffEntry[] {
  const entries: ParsedDiffEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2 || !parts[0]) continue;
    const statusChar = parts[0][0];
    const name = parts.length > 2 ? parts[2] : parts[1];
    const oldName = parts.length > 2 ? parts[1] : name;
    let status: FileContentsData["status"] = "modified";
    if (statusChar === "A") status = "added";
    else if (statusChar === "D") status = "deleted";
    else if (statusChar === "R") status = "renamed";
    entries.push({ name, oldName, status });
  }
  return entries;
}

export interface CatFileBatchParsed {
  blobs: Map<string, string>;
  /** Specs that resolved to a non-blob git object (e.g. a locally present submodule commit). */
  nonBlobSpecs: string[];
}

/**
 * Parse raw Buffer stdout from `git cat-file --batch`, returning decoded blobs
 * and listing any resolved non-blob specs (e.g. gitlink commit objects) so
 * callers can fall back to `git show` for exact parity.
 *
 * Git emits byte lengths (not UTF-16 code units), so parsing MUST slice the
 * Buffer by byte offsets before decoding UTF-8.
 */
export function parseCatFileBatchDetailed(specs: readonly string[], output: Buffer): CatFileBatchParsed {
  const blobs = new Map<string, string>();
  const nonBlobSpecs: string[] = [];
  let offset = 0;

  for (const spec of specs) {
    if (offset >= output.length) break;
    const nl = output.indexOf(0x0a, offset);
    if (nl === -1) break;
    const header = output.toString("utf-8", offset, nl);
    offset = nl + 1;

    // Found object header is "<oid> <type> <size>"; missing/ambiguous lines have no body.
    const parts = header.split(" ");
    if (parts.length !== 3 || !/^\d+$/.test(parts[2])) {
      continue;
    }

    const type = parts[1];
    const size = parseInt(parts[2], 10);
    if (offset + size > output.length) {
      log.warn("cat-file batch truncated", { spec, size, remaining: output.length - offset });
      break;
    }

    if (type === "blob") {
      blobs.set(spec, output.toString("utf-8", offset, offset + size));
    } else {
      nonBlobSpecs.push(spec);
    }
    // Skip payload bytes plus the trailing LF emitted by `git cat-file --batch`.
    offset += size + 1;
  }

  return { blobs, nonBlobSpecs };
}

/**
 * Parse raw Buffer stdout from `git cat-file --batch` into a spec → blob map.
 */
export function parseCatFileBatch(specs: readonly string[], output: Buffer): Map<string, string> {
  return parseCatFileBatchDetailed(specs, output).blobs;
}

const CAT_FILE_BATCH_MAX_BUFFER = 64 * 1024 * 1024;
const CAT_FILE_BATCH_TIMEOUT_MS = 15000;
const FALLBACK_SHOW_MAX_BUFFER = 5 * 1024 * 1024;
const FALLBACK_SHOW_TIMEOUT_MS = 5000;

/**
 * Read multiple `<ref>:<path>` git objects in one `git cat-file --batch` call.
 * Falls back to individual `git show` calls if a spec contains line breaks or
 * if the batch call fails (e.g. ENOBUFS on very large repos).
 */
export function batchReadGitObjects(
  gitBin: string,
  cwd: string,
  specs: readonly string[],
  onEnoent?: () => string,
): Map<string, string> {
  if (specs.length === 0) return new Map();

  const batchable: string[] = [];
  const fallbackSpecs: string[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    if (spec.includes("\n") || spec.includes("\r")) fallbackSpecs.push(spec);
    else batchable.push(spec);
  }

  const results = new Map<string, string>();
  let bin = gitBin;

  const runShowFallback = (targetSpecs: readonly string[]) => {
    for (const spec of targetSpecs) {
      try {
        const content = execFileSync(bin, ["show", spec], {
          cwd,
          encoding: "utf-8",
          timeout: FALLBACK_SHOW_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: FALLBACK_SHOW_MAX_BUFFER,
        });
        results.set(spec, content);
      } catch {
        // Missing or unreadable object maps to empty string at caller.
      }
    }
  };

  if (batchable.length > 0) {
    const input = `${batchable.join("\n")}\n`;
    const runBatch = () =>
      execFileSync(bin, ["cat-file", "--batch"], {
        cwd,
        input,
        timeout: CAT_FILE_BATCH_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: CAT_FILE_BATCH_MAX_BUFFER,
      });

    const applyBatchOutput = (output: Buffer) => {
      const { blobs, nonBlobSpecs } = parseCatFileBatchDetailed(batchable, output);
      for (const [k, v] of blobs) {
        results.set(k, v);
      }
      if (nonBlobSpecs.length > 0) {
        if (log.isDebugEnabled()) {
          log.debug("batchReadGitObjects falling back to git show for non-blob objects", { count: nonBlobSpecs.length });
        }
        runShowFallback(nonBlobSpecs);
      }
    };

    try {
      applyBatchOutput(runBatch());
      if (log.isDebugEnabled()) {
        log.debug("batchReadGitObjects", { cwd, requested: batchable.length, resolved: results.size });
      }
    } catch (e: any) {
      if (e?.code === "ENOENT" && onEnoent) {
        bin = onEnoent();
        try {
          applyBatchOutput(runBatch());
        } catch (retryErr: any) {
          log.warn("batchReadGitObjects retry failed, falling back to git show", { err: retryErr?.message });
          runShowFallback(batchable);
        }
      } else {
        log.warn("batchReadGitObjects failed, falling back to git show", { count: batchable.length, err: e?.message });
        runShowFallback(batchable);
      }
    }
  }

  if (fallbackSpecs.length > 0) {
    runShowFallback(fallbackSpecs);
  }

  return results;
}

/** Parse `git worktree list --porcelain` stdout into WorktreeInfo records. */
export function parseWorktreeList(raw: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  const pushIfValid = () => {
    if (current.path) {
      worktrees.push({
        path: current.path,
        branch: current.branch || "(unknown)",
        head: current.head || "",
        isMain: current.isMain || false,
      });
    }
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      pushIfValid();
      current = { path: line.slice(9), isMain: worktrees.length === 0 };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      // "branch refs/heads/main" → "main"
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "detached") {
      current.branch = "(detached)";
    } else if (line === "") {
      pushIfValid();
      current = {};
    }
  }
  pushIfValid();
  return worktrees;
}

function normalizeCheckoutPath(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function resolveGitCommonDir(gitBin: string, cwd: string): string | null {
  try {
    const out = execFileSync(gitBin, ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    return normalizeCheckoutPath(path.resolve(cwd, out));
  } catch {
    return null;
  }
}

async function resolveGitCommonDirAsync(gitBin: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(gitBin, ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
    });
    const out = stdout.trim();
    if (!out) return null;
    return normalizeCheckoutPath(path.resolve(cwd, out));
  } catch {
    return null;
  }
}

/**
 * Return true when `candidateCwd` is the same checkout as `projectCwd` or a
 * linked worktree (or subdirectory) belonging to the same git repository.
 */
export function isSameGitRepoCheckout(
  projectCwd: string,
  candidateCwd: string,
  gitBin = "git",
): boolean {
  if (!projectCwd) return true;
  if (!candidateCwd) return false;
  if (normalizeCheckoutPath(projectCwd) === normalizeCheckoutPath(candidateCwd)) return true;
  const projectCommon = resolveGitCommonDir(gitBin, projectCwd);
  if (!projectCommon) return false;
  const candidateCommon = resolveGitCommonDir(gitBin, candidateCwd);
  const same = candidateCommon !== null && projectCommon === candidateCommon;
  log.debug("isSameGitRepoCheckout", { projectCwd, candidateCwd, same });
  return same;
}

export interface RepoCheckoutMatcher {
  isExactMatch: (candidateCwd: string) => boolean;
  matchesAsync: (candidateCwd: string) => Promise<boolean>;
}

/**
 * Non-blocking checkout matcher for `pidiff-server`'s `register` path.
 * Resolves `projectCwd`'s git common dir once asynchronously, deduplicates
 * concurrent in-flight candidate lookups, and revalidates each registration's
 * candidate checkout against Git so a replaced path can never reuse a stale match.
 */
export function createRepoCheckoutMatcher(
  projectCwd: string,
  getGitBin: () => string = () => "git",
  resolveCommonDir: (gitBin: string, cwd: string) => Promise<string | null> = resolveGitCommonDirAsync,
): RepoCheckoutMatcher {
  const normalizedProject = projectCwd ? normalizeCheckoutPath(projectCwd) : "";
  const inFlight = new Map<string, Promise<string | null>>();
  let projectCommonPromise: Promise<string | null> | null = normalizedProject
    ? resolveCommonDir(getGitBin(), projectCwd)
    : null;

  function isExactMatch(candidateCwd: string): boolean {
    if (!normalizedProject) return true;
    if (!candidateCwd) return false;
    return normalizeCheckoutPath(candidateCwd) === normalizedProject;
  }

  async function getProjectCommonDir(): Promise<string | null> {
    if (!normalizedProject) return null;
    if (!projectCommonPromise) {
      projectCommonPromise = resolveCommonDir(getGitBin(), projectCwd);
    }
    const common = await projectCommonPromise;
    if (common === null) projectCommonPromise = null;
    return common;
  }

  async function getCandidateCommonDir(normalizedCandidate: string, rawCandidate: string): Promise<string | null> {
    let pending = inFlight.get(normalizedCandidate);
    if (!pending) {
      pending = resolveCommonDir(getGitBin(), rawCandidate).finally(() => {
        inFlight.delete(normalizedCandidate);
      });
      inFlight.set(normalizedCandidate, pending);
    }
    return pending;
  }

  async function matchesAsync(candidateCwd: string): Promise<boolean> {
    if (!normalizedProject) return true;
    if (!candidateCwd) return false;
    const normalizedCandidate = normalizeCheckoutPath(candidateCwd);
    if (normalizedCandidate === normalizedProject) return true;
    const [projectCommon, candidateCommon] = await Promise.all([
      getProjectCommonDir(),
      getCandidateCommonDir(normalizedCandidate, candidateCwd),
    ]);
    const same = projectCommon !== null && candidateCommon !== null && projectCommon === candidateCommon;
    log.debug("repoCheckoutMatcher.matchesAsync", { projectCwd, candidateCwd, same });
    return same;
  }

  return { isExactMatch, matchesAsync };
}
