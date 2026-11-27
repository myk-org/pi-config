/**
 * Git-backed per-turn file snapshots with `/undo` and `/redo` (#1449).
 *
 * - Captures lightweight shadow git trees asynchronously via a temporary `GIT_INDEX_FILE`
 *   outside the working tree (`git read-tree HEAD` + `git add -A` + `git write-tree`),
 *   never touching the user's real `.git/index`, HEAD, branches, reflog, or `git stash`.
 * - Records an entry on `agent_end` only when files actually changed (`postTree !== preTree`),
 *   keeping a bounded per-session undo/redo stack (default 20 entries).
 * - `/undo` and `/redo` derive affected paths strictly from the recorded `preTree`/`postTree`
 *   diff (leaving unrelated post-turn user edits untouched), reject conflicting changes to
 *   affected paths, protect originally-ignored and currently-ignored untracked files,
 *   preflight file/directory collisions & symlink/filesystem confinement before mutating,
 *   and roll back partial deletions if checkout fails.
 * - Safely no-ops outside git repos, in headless subagents (`PI_SUBAGENT_CHILD=1`),
 *   or when `turn_snapshots` is `false`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { createLogger } from "../shared/logger.js";
import { resolveBridgeSessionKey } from "../shared/session-bridge.js";
import { runGitAsync, type GitAsyncRunner } from "./git-helpers.js";
import { getSetting } from "./project-settings.js";

const log = createLogger("snapshots");

export const MAX_SNAPSHOT_STACK = 20;
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 30_000;
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

const MAX_SESSIONS = 32;
const MAX_SUMMARY_CHARS = 72;
const MAX_LISTED_FILES = 15;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 300_000;
const TREE_HASH_RE = /^[0-9a-f]{40,64}$/;

export interface SnapshotEntry {
  repoRoot: string;
  preTree: string;
  postTree: string;
  /** Paths that were ignored & untracked before the turn and later became visible in postTree. */
  originallyIgnored: string[];
  turnSummary: string;
  timestamp: number;
}

export interface SnapshotDiff {
  restored: string[];
  removed: string[];
}

export interface CaptureResult {
  ok: boolean;
  tree?: string;
  error?: string;
}

export interface RestoreResult {
  ok: boolean;
  restored: string[];
  removed: string[];
  error?: string;
}

export interface SnapshotGitOptions {
  /** Override async git timeout in ms (defaults to PI_TURN_SNAPSHOTS_TIMEOUT_MS or 30000ms). */
  timeoutMs?: number;
  /** Override async git runner (for unit tests). */
  runGit?: GitAsyncRunner;
}

export interface RestoreSnapshotOptions extends SnapshotGitOptions {
  /** Paths that were ignored before the turn and must never be deleted/overwritten. */
  originallyIgnored?: readonly string[];
}

export interface RegisterSnapshotsOptions extends SnapshotGitOptions {
  /** Override max undo/redo stack depth (default 20). */
  maxStack?: number;
}

interface PendingTurnSnapshot {
  repoRoot: string;
  preTree: string;
  preIgnored: Set<string>;
  turnSummary: string;
  startedAt: number;
}

interface SessionSnapshotState {
  generation: number;
  undoStack: SnapshotEntry[];
  redoStack: SnapshotEntry[];
  pendingTurn: PendingTurnSnapshot | null;
  pendingCapturePromise: Promise<void> | null;
  pendingCaptureError: string | null;
  lastCaptureError: string | null;
  latestPromptSummary: string;
}

// ── Guards & helpers ─────────────────────────────────────────────────────────

export function isSnapshotsEnabled(cwd: string): boolean {
  if (process.env.PI_SUBAGENT_CHILD === "1") return false;
  return Boolean(getSetting(cwd, "turn_snapshots"));
}

export function resolveSnapshotTimeoutMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(override)));
  }
  const raw = process.env.PI_TURN_SNAPSHOTS_TIMEOUT_MS?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(parsed)));
    }
  }
  return DEFAULT_SNAPSHOT_TIMEOUT_MS;
}

/** Resolve the git working-tree root containing `cwd`, or `null` outside a git worktree. */
export async function resolveGitWorktreeRoot(
  cwd: string,
  opts: SnapshotGitOptions = {},
): Promise<string | null> {
  const git = opts.runGit ?? runGitAsync;
  const timeoutMs = resolveSnapshotTimeoutMs(opts.timeoutMs);
  const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd, undefined, timeoutMs);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return null;
  const top = await git(["rev-parse", "--show-toplevel"], cwd, undefined, timeoutMs);
  if (top.code !== 0 || !top.stdout.trim()) return null;
  return top.stdout.trim();
}

function summarizePrompt(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= MAX_SUMMARY_CHARS) return compact;
  return `${compact.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

function isSafeRelativeRepoPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith("/") || relPath.startsWith("\\")) return false;
  const segments = relPath.split("/");
  if (segments[0] === ".git") return false;
  return segments.every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function pathsCollide(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Whether `relPath` is matched by an entry from `git ls-files --others --ignored --exclude-standard --directory`. */
export function isCoveredByIgnoredEntries(relPath: string, ignoredEntries: ReadonlySet<string>): boolean {
  if (ignoredEntries.size === 0) return false;
  if (ignoredEntries.has(relPath)) return true;
  let slash = relPath.indexOf("/");
  while (slash !== -1) {
    if (ignoredEntries.has(relPath.slice(0, slash + 1))) return true;
    slash = relPath.indexOf("/", slash + 1);
  }
  return false;
}

/**
 * Allocate an ephemeral directory outside the working tree for `GIT_INDEX_FILE`
 * and remove it unconditionally in `finally`. The index file itself is intentionally
 * NOT pre-created so git initializes a valid empty index instead of failing on 0 bytes.
 */
async function withTempIndex<T>(fn: (indexPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pi-snapshot-"));
  const indexPath = join(dir, "index");
  try {
    return await fn(indexPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e: any) {
      log.debug("snapshot_temp_index_cleanup_failed", { dir, error: e?.message || String(e) });
    }
  }
}

// ── Path confinement & preflight checks ──────────────────────────────────────

function openConfinedDirectory(dirPath: string, expectedDev: number, expectedIno: number, label: string): void {
  const flags =
    constants.O_RDONLY |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(dirPath, flags);
  try {
    const fst = fstatSync(fd);
    if (!fst.isDirectory() || fst.dev !== expectedDev || fst.ino !== expectedIno) {
      throw new Error(`Parent directory changed during confinement check: ${label}`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Verify that every intermediate parent directory of `relPath` under `realRoot` is a real
 * directory (not a symlink) on the same filesystem (`rootDev`), and that `relPath` stays
 * strictly confined within `realRoot`.
 */
function assertConfinedRepoPath(
  realRoot: string,
  rootDev: number,
  relPath: string,
  opts: { allowMissingLeaf: boolean; allowNonDirParent?: ReadonlySet<string> },
): { absPath: string; missingParent: boolean } {
  if (!isSafeRelativeRepoPath(relPath)) {
    throw new Error(`Refused unsafe path outside repository: ${relPath}`);
  }
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  const segments = relPath.split("/");
  let cur = realRoot;

  for (let i = 0; i < segments.length - 1; i++) {
    const subRel = segments.slice(0, i + 1).join("/");
    cur = join(cur, segments[i]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        const absPath = resolve(realRoot, relPath);
        if (!absPath.startsWith(rootPrefix)) {
          throw new Error(`Path escapes repository root: ${relPath}`);
        }
        return { absPath, missingParent: true };
      }
      throw e;
    }
    if (st.isSymbolicLink()) {
      // A symlink parent scheduled for removal (dir-replaces-symlink) is only allowed
      // during preflight when it is explicitly listed in allowNonDirParent.
      if (opts.allowNonDirParent?.has(subRel) && st.dev === rootDev) {
        const absPath = resolve(realRoot, relPath);
        if (!absPath.startsWith(rootPrefix)) {
          throw new Error(`Path escapes repository root: ${relPath}`);
        }
        return { absPath, missingParent: true };
      }
      throw new Error(`Refused symlinked parent directory: ${subRel}`);
    }
    if (!st.isDirectory()) {
      if (opts.allowNonDirParent?.has(subRel) && st.dev === rootDev) {
        const absPath = resolve(realRoot, relPath);
        if (!absPath.startsWith(rootPrefix)) {
          throw new Error(`Path escapes repository root: ${relPath}`);
        }
        return { absPath, missingParent: true };
      }
      throw new Error(`Parent path "${subRel}" is not a directory`);
    }
    if (st.dev !== rootDev) {
      throw new Error(`Refused cross-filesystem parent directory: ${subRel}`);
    }
    openConfinedDirectory(cur, rootDev, st.ino, subRel);
  }

  const absPath = join(cur, segments[segments.length - 1]!);
  if (!absPath.startsWith(rootPrefix)) {
    throw new Error(`Path escapes repository root: ${relPath}`);
  }
  try {
    const leafStat = lstatSync(absPath);
    if (leafStat.dev !== rootDev) {
      throw new Error(`Refused cross-filesystem path: ${relPath}`);
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
    if (!opts.allowMissingLeaf) {
      return { absPath, missingParent: false };
    }
  }
  return { absPath, missingParent: false };
}

function collectDirectoryChildren(
  realRoot: string,
  rootDev: number,
  relDir: string,
  out: string[],
  isNested = false,
): { ok: true } | { ok: false; error: string } {
  const absDir = join(realRoot, relDir);
  const st = lstatSync(absDir);
  if (st.isSymbolicLink()) {
    return { ok: false, error: `Refused symlinked directory "${relDir}"` };
  }
  if (st.dev !== rootDev) {
    return { ok: false, error: `Refused cross-filesystem directory "${relDir}"` };
  }
  openConfinedDirectory(absDir, rootDev, st.ino, relDir);
  const entries = readdirSync(absDir);
  if (entries.length === 0 && isNested) {
    // An empty subdirectory will not be pruned by file removals and would block replacing the parent dir with a file.
    out.push(`${relDir}/`);
    return { ok: true };
  }
  for (const name of entries) {
    const childRel = `${relDir}/${name}`;
    const childAbs = join(absDir, name);
    const cst = lstatSync(childAbs);
    if (cst.dev !== rootDev) {
      return { ok: false, error: `Refused cross-filesystem entry "${childRel}"` };
    }
    if (cst.isDirectory()) {
      const sub = collectDirectoryChildren(realRoot, rootDev, childRel, out, true);
      if (!sub.ok) return sub;
    } else {
      out.push(childRel);
    }
  }
  return { ok: true };
}

function pruneEmptyParentDirs(realRoot: string, rootDev: number, relPath: string): void {
  const segments = relPath.split("/");
  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const subRel = segments.slice(0, depth).join("/");
    const dirPath = join(realRoot, subRel);
    try {
      const st = lstatSync(dirPath);
      if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== rootDev) break;
      openConfinedDirectory(dirPath, rootDev, st.ino, subRel);
      // rmdirSync only removes strictly empty directories — preserves dirs holding gitignored files.
      rmdirSync(dirPath);
    } catch {
      break;
    }
  }
}

// ── Shadow git tree capture & ignore inspection ──────────────────────────────

/**
 * List currently ignored, untracked entries (with `--directory` so huge ignored dirs
 * like `node_modules/` collapse to one entry). Never touches `.git/index`.
 */
export async function listIgnoredUntrackedEntries(
  repoRoot: string,
  opts: SnapshotGitOptions = {},
): Promise<{ ok: true; entries: Set<string> } | { ok: false; error: string }> {
  const git = opts.runGit ?? runGitAsync;
  const timeoutMs = resolveSnapshotTimeoutMs(opts.timeoutMs);
  const res = await git(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    repoRoot,
    undefined,
    timeoutMs,
  );
  if (res.code !== 0) {
    const reason = res.timedOut
      ? `git ls-files (ignored) timed out after ${timeoutMs}ms`
      : `git ls-files (ignored) failed (exit ${res.code})`;
    log.warn("snapshot_list_ignored_failed", { repoRoot, code: res.code, timedOut: res.timedOut });
    return { ok: false, error: reason };
  }
  const entries = new Set<string>();
  if (res.stdout) {
    for (const item of res.stdout.split("\0")) {
      if (item) entries.add(item);
    }
  }
  return { ok: true, entries };
}

/** Check which candidate paths are currently ignored and untracked on disk (fails closed on git error). */
async function findCurrentlyIgnoredUntracked(
  repoRoot: string,
  candidates: readonly string[],
  opts: SnapshotGitOptions = {},
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  if (candidates.length === 0) return { ok: true, paths: [] };
  const git = opts.runGit ?? runGitAsync;
  const timeoutMs = resolveSnapshotTimeoutMs(opts.timeoutMs);
  const CHUNK_SIZE = 500;
  const matched: string[] = [];
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    const res = await git(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...chunk],
      repoRoot,
      undefined,
      timeoutMs,
    );
    if (res.code !== 0) {
      const reason = res.timedOut
        ? `git ls-files (ignored check) timed out after ${timeoutMs}ms`
        : `git ls-files (ignored check) failed (exit ${res.code})`;
      log.warn("snapshot_check_ignored_failed", { repoRoot, code: res.code, timedOut: res.timedOut });
      return { ok: false, error: reason };
    }
    if (res.stdout) {
      for (const p of res.stdout.split("\0")) {
        if (p.length > 0) matched.push(p);
      }
    }
  }
  return { ok: true, paths: matched };
}

/**
 * Capture a shadow git tree of `repoRoot`'s working tree (tracked + non-ignored untracked
 * files) using an ephemeral `GIT_INDEX_FILE`. Never touches `.git/index`, HEAD, or stash.
 */
export async function captureShadowTreeDetailed(
  repoRoot: string,
  opts: SnapshotGitOptions = {},
): Promise<CaptureResult> {
  const git = opts.runGit ?? runGitAsync;
  const timeoutMs = resolveSnapshotTimeoutMs(opts.timeoutMs);
  try {
    return await withTempIndex<CaptureResult>(async (indexPath) => {
      const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexPath };
      // Seed from HEAD when present so tracked-but-gitignored files remain tracked in the shadow index.
      const headRes = await git(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot, undefined, timeoutMs);
      if (headRes.timedOut) {
        log.warn("snapshot_head_check_timed_out", { repoRoot, timeoutMs });
        return { ok: false, error: `git rev-parse timed out after ${timeoutMs}ms` };
      }
      if (headRes.code === 0) {
        const readRes = await git(["read-tree", "HEAD"], repoRoot, env, timeoutMs);
        if (readRes.code !== 0) {
          const reason = readRes.timedOut
            ? `git read-tree timed out after ${timeoutMs}ms`
            : `git read-tree failed (exit ${readRes.code})`;
          log.warn("snapshot_read_tree_head_failed", { repoRoot, code: readRes.code, timedOut: readRes.timedOut });
          return { ok: false, error: reason };
        }
      }

      const addRes = await git(["add", "-A"], repoRoot, env, timeoutMs);
      if (addRes.code !== 0) {
        const reason = addRes.timedOut
          ? `git add -A timed out after ${timeoutMs}ms`
          : `git add -A failed (exit ${addRes.code})`;
        log.warn("snapshot_shadow_add_failed", { repoRoot, code: addRes.code, timedOut: addRes.timedOut });
        return { ok: false, error: reason };
      }

      const writeRes = await git(["write-tree"], repoRoot, env, timeoutMs);
      if (writeRes.code !== 0) {
        const reason = writeRes.timedOut
          ? `git write-tree timed out after ${timeoutMs}ms`
          : `git write-tree failed (exit ${writeRes.code})`;
        log.warn("snapshot_write_tree_failed", { repoRoot, code: writeRes.code, timedOut: writeRes.timedOut });
        return { ok: false, error: reason };
      }

      const hash = writeRes.stdout.trim();
      if (!TREE_HASH_RE.test(hash)) {
        log.warn("snapshot_invalid_tree_hash", { repoRoot, hash });
        return { ok: false, error: "git write-tree returned an invalid tree hash" };
      }
      return { ok: true, tree: hash };
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    log.warn("snapshot_capture_exception", { repoRoot, error: msg });
    return { ok: false, error: msg };
  }
}

/** Convenience wrapper returning the captured tree hash or `null` on failure. */
export async function captureShadowTree(
  repoRoot: string,
  opts: SnapshotGitOptions = {},
): Promise<string | null> {
  const res = await captureShadowTreeDetailed(repoRoot, opts);
  return res.ok && res.tree ? res.tree : null;
}

interface DetailedSnapshotDiff extends SnapshotDiff {
  /** Paths present in targetTree and absent from expectedTree (status A). */
  added: string[];
  /** Paths present in both trees with modified content, mode, or type (status M/T). */
  modified: string[];
}

function parseDiffTreeDetailed(stdout: string): DetailedSnapshotDiff {
  const restored: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  const modified: string[] = [];
  if (!stdout) return { restored, removed, added, modified };

  const tokens = stdout.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i];
    const filePath = tokens[i + 1];
    if (!meta || !filePath) continue;
    const parts = meta.replace(/^:/, "").split(/\s+/);
    if (parts.length < 5) continue;
    const [srcMode, dstMode, , , status] = parts;
    // Skip submodule gitlinks so we never unlink or overwrite nested repos.
    if (srcMode === "160000" || dstMode === "160000") continue;
    if (!isSafeRelativeRepoPath(filePath)) {
      log.warn("snapshot_skipped_unsafe_path", { filePath });
      continue;
    }
    const code = status[0];
    if (code === "D") {
      removed.push(filePath);
    } else if (code === "A") {
      restored.push(filePath);
      added.push(filePath);
    } else if (code === "M" || code === "T") {
      restored.push(filePath);
      modified.push(filePath);
    }
  }
  return { restored, removed, added, modified };
}

/** Parse `git diff-tree -r --no-commit-id --raw --no-renames -z <from> <to>` output. */
export function parseDiffTreeRawZ(stdout: string): SnapshotDiff {
  const { restored, removed } = parseDiffTreeDetailed(stdout);
  return { restored, removed };
}

async function diffShadowTrees(
  repoRoot: string,
  fromTree: string,
  toTree: string,
  opts: SnapshotGitOptions,
): Promise<{ ok: true; diff: DetailedSnapshotDiff } | { ok: false; error: string }> {
  const git = opts.runGit ?? runGitAsync;
  const timeoutMs = resolveSnapshotTimeoutMs(opts.timeoutMs);
  const diffRes = await git(
    ["diff-tree", "-r", "--no-commit-id", "--raw", "--no-renames", "-z", fromTree, toTree],
    repoRoot,
    undefined,
    timeoutMs,
  );
  if (diffRes.code !== 0) {
    log.warn("snapshot_diff_tree_failed", { repoRoot, code: diffRes.code, timedOut: diffRes.timedOut });
    return {
      ok: false,
      error: diffRes.timedOut
        ? `git diff-tree timed out after ${timeoutMs}ms`
        : "Failed to compute snapshot diff",
    };
  }
  return { ok: true, diff: parseDiffTreeDetailed(diffRes.stdout) };
}

async function rollbackPartialRestore(
  repoRoot: string,
  realRoot: string,
  rootDev: number,
  expectedTree: string,
  removedPaths: readonly string[],
  modifiedPaths: readonly string[],
  addedPaths: readonly string[],
  opts: SnapshotGitOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pathsToCheckout = [...removedPaths, ...modifiedPaths];
  if (pathsToCheckout.length === 0 && addedPaths.length === 0) return { ok: true };

  const errors: string[] = [];

  // 1. Remove any newly created paths (absent from expectedTree) that may have been written before failure.
  for (const relPath of addedPaths) {
    try {
      const { absPath, missingParent } = assertConfinedRepoPath(realRoot, rootDev, relPath, {
        allowMissingLeaf: false,
      });
      if (missingParent) continue;
      unlinkSync(absPath);
      pruneEmptyParentDirs(realRoot, rootDev, relPath);
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        errors.push(`remove ${relPath}: ${e?.message || String(e)}`);
      }
    }
  }

  // 2. Restore both deleted paths and potentially overwritten modified paths from expectedTree.
  if (pathsToCheckout.length > 0) {
    const git = opts.runGit ?? runGitAsync;
    const timeoutMs = resolveSnapshotTimeoutMs(opts.timeoutMs);
    try {
      for (const relPath of pathsToCheckout) {
        assertConfinedRepoPath(realRoot, rootDev, relPath, { allowMissingLeaf: true });
      }
      const checkoutRollbackErr = await withTempIndex<string | null>(async (indexPath) => {
        const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexPath };
        const readRes = await git(["read-tree", expectedTree], repoRoot, env, timeoutMs);
        if (readRes.code !== 0) {
          return readRes.timedOut
            ? `rollback git read-tree timed out after ${timeoutMs}ms`
            : `rollback git read-tree failed (exit ${readRes.code})`;
        }
        const stdin = `${pathsToCheckout.join("\0")}\0`;
        const coRes = await git(["checkout-index", "-f", "--stdin", "-z"], repoRoot, env, timeoutMs, stdin);
        if (coRes.code !== 0) {
          return coRes.timedOut
            ? `rollback git checkout-index timed out after ${timeoutMs}ms`
            : `rollback git checkout-index failed (exit ${coRes.code})`;
        }
        return null;
      });
      if (checkoutRollbackErr) errors.push(checkoutRollbackErr);
    } catch (e: any) {
      errors.push(e?.message || String(e));
    }
  }

  if (errors.length > 0) {
    const error = errors.join("; ");
    log.error("snapshot_rollback_failed", { repoRoot, error });
    return { ok: false, error };
  }

  log.warn("snapshot_restore_rolled_back", {
    repoRoot,
    restoredCount: pathsToCheckout.length,
    removedAddedCount: addedPaths.length,
  });
  return { ok: true };
}

/**
 * Restore ONLY the paths changed between `expectedTree` and `targetTree` in `repoRoot`:
 * - Leaves unrelated post-turn user edits untouched.
 * - Aborts with a conflict if any affected/colliding path changed since `expectedTree`.
 * - Protects originally-ignored and currently-ignored untracked files (conflict, never delete/overwrite).
 * - Preflights file/directory collisions (including ignored children) and symlink/mount confinement
 *   before mutating any file, and rolls back deletions if checkout fails mid-flight.
 */
export async function restoreShadowTree(
  repoRoot: string,
  expectedTree: string,
  targetTree: string,
  opts: RestoreSnapshotOptions = {},
): Promise<RestoreResult> {
  if (!TREE_HASH_RE.test(expectedTree) || !TREE_HASH_RE.test(targetTree)) {
    return { ok: false, restored: [], removed: [], error: "Invalid snapshot tree hash" };
  }

  if (expectedTree === targetTree) {
    return { ok: true, restored: [], removed: [] };
  }

  const git = opts.runGit ?? runGitAsync;
  const timeoutMs = resolveSnapshotTimeoutMs(opts.timeoutMs);

  let realRoot: string;
  let rootDev: number;
  try {
    realRoot = realpathSync(repoRoot);
    rootDev = lstatSync(realRoot).dev;
  } catch (e: any) {
    return { ok: false, restored: [], removed: [], error: `Repository root unavailable: ${e?.message || String(e)}` };
  }

  // 1. Derive affected paths strictly from the recorded turn trees.
  const turnDiffRes = await diffShadowTrees(repoRoot, expectedTree, targetTree, opts);
  if (!turnDiffRes.ok) {
    return { ok: false, restored: [], removed: [], error: turnDiffRes.error };
  }
  const { restored, removed, added, modified } = turnDiffRes.diff;
  if (restored.length === 0 && removed.length === 0) {
    return { ok: true, restored: [], removed: [] };
  }
  const affectedPaths = [...removed, ...restored];

  // 2. Capture current working tree and detect conflicting edits on affected/colliding paths.
  const currentRes = await captureShadowTreeDetailed(repoRoot, opts);
  if (!currentRes.ok || !currentRes.tree) {
    return {
      ok: false,
      restored: [],
      removed: [],
      error: `Failed to inspect current working tree: ${currentRes.error || "unknown error"}`,
    };
  }
  if (currentRes.tree !== expectedTree) {
    const driftRes = await diffShadowTrees(repoRoot, expectedTree, currentRes.tree, opts);
    if (!driftRes.ok) {
      return { ok: false, restored: [], removed: [], error: driftRes.error };
    }
    const drifted = [...driftRes.diff.restored, ...driftRes.diff.removed];
    const conflicts = drifted.filter((d) => affectedPaths.some((a) => pathsCollide(d, a)));
    if (conflicts.length > 0) {
      return {
        ok: false,
        restored: [],
        removed: [],
        error: `Conflicting changes made since the turn on: ${formatFileList(conflicts)}`,
      };
    }
  }

  // 3. Protect files that were originally ignored before the turn or are currently ignored & untracked.
  const originallyIgnoredSet = new Set(opts.originallyIgnored ?? []);
  const protectedOriginal = affectedPaths.filter((p) => originallyIgnoredSet.has(p));
  if (protectedOriginal.length > 0) {
    return {
      ok: false,
      restored: [],
      removed: [],
      error: `Refused to modify previously gitignored file(s): ${formatFileList(protectedOriginal)}`,
    };
  }
  const currentlyIgnoredRes = await findCurrentlyIgnoredUntracked(repoRoot, affectedPaths, opts);
  if (!currentlyIgnoredRes.ok) {
    return { ok: false, restored: [], removed: [], error: currentlyIgnoredRes.error };
  }
  if (currentlyIgnoredRes.paths.length > 0) {
    return {
      ok: false,
      restored: [],
      removed: [],
      error: `Refused to modify currently gitignored file(s): ${formatFileList(currentlyIgnoredRes.paths)}`,
    };
  }

  // 4. Preflight targetTree existence, symlink/filesystem confinement, and file↔directory collisions
  //    BEFORE mutating any file on disk.
  const targetType = await git(["cat-file", "-t", targetTree], repoRoot, undefined, timeoutMs);
  if (targetType.code !== 0 || targetType.stdout.trim() !== "tree") {
    return { ok: false, restored: [], removed: [], error: "Target snapshot tree object is no longer available" };
  }

  const removedSet = new Set(removed);
  try {
    for (const relPath of removed) {
      assertConfinedRepoPath(realRoot, rootDev, relPath, { allowMissingLeaf: false });
    }
    for (const relPath of restored) {
      const { absPath, missingParent } = assertConfinedRepoPath(realRoot, rootDev, relPath, {
        allowMissingLeaf: true,
        allowNonDirParent: removedSet,
      });
      if (missingParent) continue;
      // File-replaces-directory check: every child inside the directory must be in removedSet
      // (catches ignored or unrelated files nested inside the directory before deleting anything).
      let st;
      try {
        st = lstatSync(absPath);
      } catch (e: any) {
        if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
      }
      if (st?.isDirectory()) {
        const children: string[] = [];
        const walk = collectDirectoryChildren(realRoot, rootDev, relPath, children);
        if (!walk.ok) {
          return { ok: false, restored: [], removed: [], error: walk.error };
        }
        const blocking = children.filter((c) => !removedSet.has(c));
        if (blocking.length > 0) {
          return {
            ok: false,
            restored: [],
            removed: [],
            error: `Cannot restore file "${relPath}": directory contains preserved/ignored file(s): ${formatFileList(blocking)}`,
          };
        }
      }
    }
  } catch (e: any) {
    return { ok: false, restored: [], removed: [], error: e?.message || String(e) };
  }

  // 5. Remove paths absent from targetTree (re-checking confinement immediately before each unlink).
  const actuallyRemoved: string[] = [];
  for (const relPath of removed) {
    try {
      const { absPath, missingParent } = assertConfinedRepoPath(realRoot, rootDev, relPath, {
        allowMissingLeaf: false,
      });
      if (missingParent) continue;
      unlinkSync(absPath);
      pruneEmptyParentDirs(realRoot, rootDev, relPath);
      actuallyRemoved.push(relPath);
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        log.error("snapshot_unlink_failed", { relPath, error: e?.message || String(e) });
        const rb = await rollbackPartialRestore(
          repoRoot,
          realRoot,
          rootDev,
          expectedTree,
          actuallyRemoved,
          [],
          [],
          opts,
        );
        const rbNote = rb.ok ? "" : ` (rollback failed: ${rb.error})`;
        return {
          ok: false,
          restored: [],
          removed: [],
          error: `Failed to remove ${relPath}: ${e?.message || String(e)}${rbNote}`,
        };
      }
    }
  }

  // 6. Checkout restored paths from targetTree via ephemeral GIT_INDEX_FILE.
  if (restored.length > 0) {
    try {
      // Re-verify confinement right before checkout writes.
      for (const relPath of restored) {
        assertConfinedRepoPath(realRoot, rootDev, relPath, { allowMissingLeaf: true });
      }
      const checkoutErr = await withTempIndex<string | null>(async (indexPath) => {
        const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexPath };
        const readRes = await git(["read-tree", targetTree], repoRoot, env, timeoutMs);
        if (readRes.code !== 0) {
          log.error("snapshot_restore_read_tree_failed", { repoRoot, code: readRes.code });
          return "Failed to load snapshot tree into shadow index";
        }
        const stdin = `${restored.join("\0")}\0`;
        const coRes = await git(["checkout-index", "-f", "--stdin", "-z"], repoRoot, env, timeoutMs, stdin);
        if (coRes.code !== 0) {
          log.error("snapshot_checkout_index_failed", { repoRoot, code: coRes.code });
          return coRes.timedOut
            ? `git checkout-index timed out after ${timeoutMs}ms`
            : "Failed to restore files from snapshot";
        }
        return null;
      });
      if (checkoutErr) {
        const rb = await rollbackPartialRestore(
          repoRoot,
          realRoot,
          rootDev,
          expectedTree,
          actuallyRemoved,
          modified,
          added,
          opts,
        );
        const rbNote = rb.ok ? "" : ` (rollback failed: ${rb.error})`;
        return { ok: false, restored: [], removed: [], error: `${checkoutErr}${rbNote}` };
      }
    } catch (e: any) {
      log.error("snapshot_restore_exception", { repoRoot, error: e?.message || String(e) });
      const rb = await rollbackPartialRestore(
        repoRoot,
        realRoot,
        rootDev,
        expectedTree,
        actuallyRemoved,
        modified,
        added,
        opts,
      );
      const rbNote = rb.ok ? "" : ` (rollback failed: ${rb.error})`;
      return { ok: false, restored: [], removed: [], error: `${e?.message || String(e)}${rbNote}` };
    }
  }

  return { ok: true, restored, removed: actuallyRemoved };
}

// ── Formatting & UI output ───────────────────────────────────────────────────

function formatFileList(files: readonly string[]): string {
  if (files.length <= MAX_LISTED_FILES) return files.join(", ");
  const shown = files.slice(0, MAX_LISTED_FILES).join(", ");
  return `${shown}, … (+${files.length - MAX_LISTED_FILES} more)`;
}

export function formatSnapshotActionSummary(
  verb: "Undid" | "Redid",
  entry: SnapshotEntry,
  result: RestoreResult,
  undoRemaining: number,
  redoRemaining: number,
): string {
  const header = entry.turnSummary ? `${verb} turn: "${entry.turnSummary}"` : `${verb} turn`;
  const lines = [header];
  if (result.restored.length === 0 && result.removed.length === 0) {
    lines.push("Working tree already matched snapshot (0 files changed).");
  } else {
    if (result.restored.length > 0) {
      lines.push(`Restored (${result.restored.length}): ${formatFileList(result.restored)}`);
    }
    if (result.removed.length > 0) {
      lines.push(`Removed (${result.removed.length}): ${formatFileList(result.removed)}`);
    }
  }
  lines.push(`(${undoRemaining} undo, ${redoRemaining} redo available)`);
  return lines.join("\n");
}

function emitOutput(
  pi: ExtensionAPI,
  ctx: any,
  text: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx?.hasUI && isLiveExtensionCtx(ctx)) {
    try {
      ctx.ui.notify(text, level);
      return;
    } catch (e: any) {
      log.debug("snapshots_notify_failed", { error: e?.message || String(e) });
    }
  }
  try {
    pi.sendMessage({ customType: "snapshots", content: text, display: true }, { triggerTurn: false });
  } catch {
    try {
      ctx?.ui?.notify?.(text, level);
    } catch {
      // No output surface available.
    }
  }
}

// ── Extension registration ───────────────────────────────────────────────────

export function registerSnapshots(pi: ExtensionAPI, opts: RegisterSnapshotsOptions = {}): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    log.debug("snapshots skipped for subagent child");
    return;
  }

  const maxStack = Math.max(1, opts.maxStack ?? MAX_SNAPSHOT_STACK);
  const gitOpts: SnapshotGitOptions = { timeoutMs: opts.timeoutMs, runGit: opts.runGit };
  const sessions = new Map<string, SessionSnapshotState>();

  const getState = (ctx: any): SessionSnapshotState => {
    const key = resolveBridgeSessionKey(ctx);
    const existing = sessions.get(key);
    if (existing) return existing;
    if (sessions.size >= MAX_SESSIONS) {
      const oldestKey = sessions.keys().next().value;
      if (oldestKey !== undefined) sessions.delete(oldestKey);
    }
    const fresh: SessionSnapshotState = {
      generation: 0,
      undoStack: [],
      redoStack: [],
      pendingTurn: null,
      pendingCapturePromise: null,
      pendingCaptureError: null,
      lastCaptureError: null,
      latestPromptSummary: "",
    };
    sessions.set(key, fresh);
    return fresh;
  };

  pi.on("before_agent_start", (event: any, ctx) => {
    const state = getState(ctx);
    state.generation += 1;
    state.pendingTurn = null;
    state.pendingCapturePromise = null;
    state.pendingCaptureError = null;
    if (typeof event?.prompt === "string" && event.prompt.trim()) {
      state.latestPromptSummary = summarizePrompt(event.prompt);
    }
  });

  pi.on("tool_call", async (event: any, ctx) => {
    const toolName = typeof event?.toolName === "string" ? event.toolName : "";
    if (!MUTATING_TOOL_NAMES.has(toolName)) return;

    const cwd = ctx?.cwd || process.cwd();
    if (!isSnapshotsEnabled(cwd)) return;

    const state = getState(ctx);
    if (state.pendingTurn !== null || state.pendingCaptureError !== null) return;
    if (state.pendingCapturePromise) {
      await state.pendingCapturePromise;
      return;
    }

    const gen = state.generation;
    const captureJob = (async () => {
      const repoRoot = await resolveGitWorktreeRoot(cwd, gitOpts);
      if (!repoRoot) {
        log.debug("snapshot_skipped_not_git_repo", { cwd });
        return;
      }

      const [captureRes, preIgnoredRes] = await Promise.all([
        captureShadowTreeDetailed(repoRoot, gitOpts),
        listIgnoredUntrackedEntries(repoRoot, gitOpts),
      ]);

      if (state.generation !== gen) return;

      if (!captureRes.ok || !captureRes.tree || !preIgnoredRes.ok) {
        const reason = !captureRes.ok
          ? (captureRes.error || "unknown error")
          : (!preIgnoredRes.ok ? preIgnoredRes.error : "unknown error");
        state.pendingCaptureError = reason;
        state.lastCaptureError = reason;
        log.warn("snapshot_pre_turn_capture_failed", { repoRoot, tool: toolName, reason });
        emitOutput(
          pi,
          ctx,
          `Turn snapshot capture failed (${reason}) — this turn will not be undoable via /undo.`,
          "warning",
        );
        return;
      }

      state.lastCaptureError = null;
      state.pendingTurn = {
        repoRoot,
        preTree: captureRes.tree,
        preIgnored: preIgnoredRes.entries,
        turnSummary: state.latestPromptSummary || toolName,
        startedAt: Date.now(),
      };
      log.debug("snapshot_pre_turn_captured", {
        repoRoot,
        preTree: captureRes.tree.slice(0, 10),
        tool: toolName,
      });
    })();

    state.pendingCapturePromise = captureJob;
    try {
      await captureJob;
    } finally {
      if (state.pendingCapturePromise === captureJob) {
        state.pendingCapturePromise = null;
      }
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const key = resolveBridgeSessionKey(ctx);
    const state = sessions.get(key);
    if (!state) return;

    if (state.pendingCapturePromise) {
      await state.pendingCapturePromise;
    }
    if (!state.pendingTurn) return;

    const pending = state.pendingTurn;
    state.pendingTurn = null;

    const cwd = ctx?.cwd || pending.repoRoot;
    if (!isSnapshotsEnabled(cwd)) return;

    const postRes = await captureShadowTreeDetailed(pending.repoRoot, gitOpts);
    if (!postRes.ok || !postRes.tree) {
      const reason = postRes.error || "unknown error";
      state.lastCaptureError = reason;
      log.warn("snapshot_post_turn_capture_failed", { repoRoot: pending.repoRoot, reason });
      emitOutput(
        pi,
        ctx,
        `Post-turn snapshot capture failed (${reason}) — this turn was not recorded for /undo.`,
        "warning",
      );
      return;
    }

    if (postRes.tree === pending.preTree) {
      log.debug("snapshot_turn_unchanged", { repoRoot: pending.repoRoot });
      return;
    }

    // Record any paths that were ignored & untracked before the turn and became visible in postTree.
    let originallyIgnored: string[] = [];
    if (pending.preIgnored.size > 0) {
      const turnDiff = await diffShadowTrees(pending.repoRoot, pending.preTree, postRes.tree, gitOpts);
      if (!turnDiff.ok) {
        const reason = turnDiff.error || "failed to diff turn trees for ignored-file protection";
        state.lastCaptureError = reason;
        log.warn("snapshot_post_turn_diff_failed", { repoRoot: pending.repoRoot, reason });
        emitOutput(
          pi,
          ctx,
          `Post-turn snapshot capture failed (${reason}) — this turn was not recorded for /undo.`,
          "warning",
        );
        return;
      }
      originallyIgnored = [...turnDiff.diff.restored, ...turnDiff.diff.removed].filter((p) =>
        isCoveredByIgnoredEntries(p, pending.preIgnored),
      );
    }

    state.undoStack.push({
      repoRoot: pending.repoRoot,
      preTree: pending.preTree,
      postTree: postRes.tree,
      originallyIgnored,
      turnSummary: pending.turnSummary,
      timestamp: Date.now(),
    });
    while (state.undoStack.length > maxStack) {
      state.undoStack.shift();
    }
    state.redoStack.length = 0;

    log.info("snapshot_turn_recorded", {
      repoRoot: pending.repoRoot,
      preTree: pending.preTree.slice(0, 10),
      postTree: postRes.tree.slice(0, 10),
      originallyIgnored: originallyIgnored.length,
      stackDepth: state.undoStack.length,
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const key = resolveBridgeSessionKey(ctx);
    if (sessions.delete(key)) {
      log.debug("snapshot_session_cleared", { key });
    }
  });

  pi.registerCommand("undo", {
    description: "Revert working-tree file changes from the last mutating turn (preserves staged index, unrelated edits & gitignored files)",
    handler: async (_args, ctx) => {
      const cwd = ctx?.cwd || process.cwd();
      if (!isSnapshotsEnabled(cwd)) {
        emitOutput(pi, ctx, "Turn snapshots are disabled (turn_snapshots=false).", "warning");
        return;
      }
      const state = getState(ctx);
      if (state.undoStack.length === 0) {
        const extra = state.lastCaptureError ? ` (last snapshot capture failed: ${state.lastCaptureError})` : "";
        emitOutput(
          pi,
          ctx,
          `Nothing to undo — no file-mutating turns recorded in this session.${extra}`,
          "info",
        );
        return;
      }
      const entry = state.undoStack[state.undoStack.length - 1]!;
      const result = await restoreShadowTree(entry.repoRoot, entry.postTree, entry.preTree, {
        ...gitOpts,
        originallyIgnored: entry.originallyIgnored,
      });
      if (!result.ok) {
        log.error("snapshot_undo_failed", { error: result.error, repoRoot: entry.repoRoot });
        emitOutput(pi, ctx, `Failed to undo turn snapshot: ${result.error || "unknown error"}`, "error");
        return;
      }
      state.undoStack.pop();
      state.redoStack.push(entry);
      while (state.redoStack.length > maxStack) {
        state.redoStack.shift();
      }
      const summary = formatSnapshotActionSummary(
        "Undid",
        entry,
        result,
        state.undoStack.length,
        state.redoStack.length,
      );
      log.info("snapshot_undo_applied", {
        repoRoot: entry.repoRoot,
        restored: result.restored.length,
        removed: result.removed.length,
        undoRemaining: state.undoStack.length,
        redoAvailable: state.redoStack.length,
      });
      emitOutput(pi, ctx, summary, "info");
    },
  });

  pi.registerCommand("redo", {
    description: "Re-apply working-tree file changes from the last undone turn snapshot",
    handler: async (_args, ctx) => {
      const cwd = ctx?.cwd || process.cwd();
      if (!isSnapshotsEnabled(cwd)) {
        emitOutput(pi, ctx, "Turn snapshots are disabled (turn_snapshots=false).", "warning");
        return;
      }
      const state = getState(ctx);
      if (state.redoStack.length === 0) {
        emitOutput(pi, ctx, "Nothing to redo.", "info");
        return;
      }
      const entry = state.redoStack[state.redoStack.length - 1]!;
      const result = await restoreShadowTree(entry.repoRoot, entry.preTree, entry.postTree, {
        ...gitOpts,
        originallyIgnored: entry.originallyIgnored,
      });
      if (!result.ok) {
        log.error("snapshot_redo_failed", { error: result.error, repoRoot: entry.repoRoot });
        emitOutput(pi, ctx, `Failed to redo turn snapshot: ${result.error || "unknown error"}`, "error");
        return;
      }
      state.redoStack.pop();
      state.undoStack.push(entry);
      while (state.undoStack.length > maxStack) {
        state.undoStack.shift();
      }
      const summary = formatSnapshotActionSummary(
        "Redid",
        entry,
        result,
        state.undoStack.length,
        state.redoStack.length,
      );
      log.info("snapshot_redo_applied", {
        repoRoot: entry.repoRoot,
        restored: result.restored.length,
        removed: result.removed.length,
        undoAvailable: state.undoStack.length,
        redoRemaining: state.redoStack.length,
      });
      emitOutput(pi, ctx, summary, "info");
    },
  });

  log.debug("snapshots lifecycle registered", { maxStack, timeoutMs: resolveSnapshotTimeoutMs(opts.timeoutMs) });
}
