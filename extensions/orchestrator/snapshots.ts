/**
 * Git-backed per-turn file snapshots with `/undo` and `/redo` (#1449).
 *
 * - Captures lightweight shadow git trees via a temporary `GIT_INDEX_FILE`
 *   outside the working tree (`git read-tree HEAD` + `git add -A` + `git write-tree`),
 *   never touching the user's real `.git/index`, HEAD, branches, reflog, or `git stash`.
 * - Records an entry on `agent_end` only when files actually changed (`postTree !== preTree`),
 *   keeping a bounded per-session undo/redo stack (default 20 entries).
 * - `/undo` restores the working tree to `preTree` and deletes files created during the turn
 *   while preserving gitignored files (`.env`, `.pi/`, `node_modules`, etc.) and staged changes.
 * - `/redo` re-applies the undone turn's `postTree`.
 * - Safely no-ops outside git repos, in headless subagents (`PI_SUBAGENT_CHILD=1`),
 *   or when `turn_snapshots` is `false`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { createLogger } from "../shared/logger.js";
import { resolveBridgeSessionKey } from "../shared/session-bridge.js";
import { runGit } from "./git-helpers.js";
import { getSetting } from "./project-settings.js";

const log = createLogger("snapshots");

export const MAX_SNAPSHOT_STACK = 20;
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

const MAX_SESSIONS = 32;
const MAX_SUMMARY_CHARS = 72;
const MAX_LISTED_FILES = 15;
const TREE_HASH_RE = /^[0-9a-f]{40,64}$/;

export interface SnapshotEntry {
  repoRoot: string;
  preTree: string;
  postTree: string;
  turnSummary: string;
  timestamp: number;
}

export interface SnapshotDiff {
  restored: string[];
  removed: string[];
}

export interface RestoreResult {
  ok: boolean;
  restored: string[];
  removed: string[];
  previousTree?: string;
  error?: string;
}

export interface RegisterSnapshotsOptions {
  /** Override max undo/redo stack depth (default 20). */
  maxStack?: number;
}

interface PendingTurnSnapshot {
  repoRoot: string;
  preTree: string;
  turnSummary: string;
  startedAt: number;
}

interface SessionSnapshotState {
  undoStack: SnapshotEntry[];
  redoStack: SnapshotEntry[];
  pendingTurn: PendingTurnSnapshot | null;
  latestPromptSummary: string;
}

// ── Guards & helpers ─────────────────────────────────────────────────────────

export function isSnapshotsEnabled(cwd: string): boolean {
  if (process.env.PI_SUBAGENT_CHILD === "1") return false;
  return Boolean(getSetting(cwd, "turn_snapshots"));
}

/** Resolve the git working-tree root containing `cwd`, or `null` outside a git worktree. */
export function resolveGitWorktreeRoot(cwd: string): string | null {
  const inside = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return null;
  const top = runGit(["rev-parse", "--show-toplevel"], cwd);
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

/**
 * Allocate an ephemeral directory outside the working tree for `GIT_INDEX_FILE`
 * and remove it unconditionally in `finally`. The index file itself is intentionally
 * NOT pre-created so git initializes a valid empty index instead of failing on 0 bytes.
 */
function withTempIndex<T>(fn: (indexPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-snapshot-"));
  const indexPath = join(dir, "index");
  try {
    return fn(indexPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e: any) {
      log.debug("snapshot_temp_index_cleanup_failed", { dir, error: e?.message || String(e) });
    }
  }
}

// ── Shadow git tree capture & restore ────────────────────────────────────────

/**
 * Capture a shadow git tree of `repoRoot`'s working tree (tracked + non-ignored untracked
 * files) using an ephemeral `GIT_INDEX_FILE`. Never touches `.git/index`, HEAD, or stash.
 */
export function captureShadowTree(repoRoot: string): string | null {
  try {
    return withTempIndex((indexPath) => {
      const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexPath };
      // Seed from HEAD when present so tracked-but-gitignored files remain tracked in the shadow index.
      const hasHead = runGit(["rev-parse", "--verify", "--quiet", "HEAD"], repoRoot).code === 0;
      if (hasHead) {
        const readRes = runGit(["read-tree", "HEAD"], repoRoot, undefined, env);
        if (readRes.code !== 0) {
          log.warn("snapshot_read_tree_head_failed", { repoRoot, code: readRes.code });
          return null;
        }
      }

      const addRes = runGit(["add", "-A"], repoRoot, undefined, env);
      if (addRes.code !== 0) {
        log.warn("snapshot_shadow_add_failed", { repoRoot, code: addRes.code });
        return null;
      }

      const writeRes = runGit(["write-tree"], repoRoot, undefined, env);
      if (writeRes.code !== 0) {
        log.warn("snapshot_write_tree_failed", { repoRoot, code: writeRes.code });
        return null;
      }

      const hash = writeRes.stdout.trim();
      if (!TREE_HASH_RE.test(hash)) {
        log.warn("snapshot_invalid_tree_hash", { repoRoot, hash });
        return null;
      }
      return hash;
    });
  } catch (e: any) {
    log.warn("snapshot_capture_exception", { repoRoot, error: e?.message || String(e) });
    return null;
  }
}

/** Parse `git diff-tree -r --no-commit-id --raw --no-renames -z <from> <to>` output. */
export function parseDiffTreeRawZ(stdout: string): SnapshotDiff {
  const restored: string[] = [];
  const removed: string[] = [];
  if (!stdout) return { restored, removed };

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
    } else if (code === "A" || code === "M" || code === "T") {
      restored.push(filePath);
    }
  }
  return { restored, removed };
}

function pruneEmptyParentDirs(filePath: string, resolvedRoot: string): void {
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  let current = dirname(filePath);
  while (current !== resolvedRoot && current.startsWith(rootPrefix)) {
    try {
      // rmdirSync only removes strictly empty directories — preserves dirs containing gitignored files.
      rmdirSync(current);
    } catch {
      break;
    }
    current = dirname(current);
  }
}

/**
 * Restore `repoRoot`'s working tree to `targetTree` without modifying `.git/index`
 * or deleting gitignored files.
 */
export function restoreShadowTree(repoRoot: string, targetTree: string): RestoreResult {
  if (!TREE_HASH_RE.test(targetTree)) {
    return { ok: false, restored: [], removed: [], error: "Invalid target tree hash" };
  }

  const currentTree = captureShadowTree(repoRoot);
  if (!currentTree) {
    return { ok: false, restored: [], removed: [], error: "Failed to inspect current working tree" };
  }

  if (currentTree === targetTree) {
    return { ok: true, restored: [], removed: [], previousTree: currentTree };
  }

  const diffRes = runGit(
    ["diff-tree", "-r", "--no-commit-id", "--raw", "--no-renames", "-z", currentTree, targetTree],
    repoRoot,
  );
  if (diffRes.code !== 0) {
    log.warn("snapshot_diff_tree_failed", { repoRoot, code: diffRes.code });
    return { ok: false, restored: [], removed: [], error: "Failed to compute snapshot diff" };
  }

  const { restored, removed } = parseDiffTreeRawZ(diffRes.stdout);
  const resolvedRoot = resolve(repoRoot);
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;

  // Remove files absent from targetTree first so file↔directory replacements clear cleanly.
  const actuallyRemoved: string[] = [];
  for (const relPath of removed) {
    const absPath = resolve(resolvedRoot, relPath);
    if (!absPath.startsWith(rootPrefix)) {
      log.warn("snapshot_blocked_out_of_root_remove", { relPath, absPath });
      continue;
    }
    try {
      unlinkSync(absPath);
      pruneEmptyParentDirs(absPath, resolvedRoot);
      actuallyRemoved.push(relPath);
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        log.error("snapshot_unlink_failed", { relPath, error: e?.message || String(e) });
        return {
          ok: false,
          restored: [],
          removed: actuallyRemoved,
          error: `Failed to remove ${relPath}: ${e?.message || String(e)}`,
        };
      }
    }
  }

  if (restored.length > 0) {
    try {
      const checkoutErr = withTempIndex<string | null>((indexPath) => {
        const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexPath };
        const readRes = runGit(["read-tree", targetTree], repoRoot, undefined, env);
        if (readRes.code !== 0) {
          log.error("snapshot_restore_read_tree_failed", { repoRoot, code: readRes.code });
          return "Failed to load snapshot tree into shadow index";
        }
        const stdin = `${restored.join("\0")}\0`;
        const coRes = runGit(["checkout-index", "-f", "--stdin", "-z"], repoRoot, stdin, env);
        if (coRes.code !== 0) {
          log.error("snapshot_checkout_index_failed", { repoRoot, code: coRes.code });
          return "Failed to restore files from snapshot";
        }
        return null;
      });
      if (checkoutErr) {
        return { ok: false, restored: [], removed: actuallyRemoved, error: checkoutErr };
      }
    } catch (e: any) {
      log.error("snapshot_restore_exception", { repoRoot, error: e?.message || String(e) });
      return {
        ok: false,
        restored: [],
        removed: actuallyRemoved,
        error: e?.message || String(e),
      };
    }
  }

  return { ok: true, restored, removed: actuallyRemoved, previousTree: currentTree };
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
      undoStack: [],
      redoStack: [],
      pendingTurn: null,
      latestPromptSummary: "",
    };
    sessions.set(key, fresh);
    return fresh;
  };

  pi.on("before_agent_start", (event: any, ctx) => {
    const state = getState(ctx);
    state.pendingTurn = null;
    if (typeof event?.prompt === "string" && event.prompt.trim()) {
      state.latestPromptSummary = summarizePrompt(event.prompt);
    }
  });

  pi.on("tool_call", (event: any, ctx) => {
    const toolName = typeof event?.toolName === "string" ? event.toolName : "";
    if (!MUTATING_TOOL_NAMES.has(toolName)) return;

    const cwd = ctx?.cwd || process.cwd();
    if (!isSnapshotsEnabled(cwd)) return;

    const state = getState(ctx);
    if (state.pendingTurn !== null) return;

    const repoRoot = resolveGitWorktreeRoot(cwd);
    if (!repoRoot) {
      log.debug("snapshot_skipped_not_git_repo", { cwd });
      return;
    }

    const preTree = captureShadowTree(repoRoot);
    if (!preTree) return;

    state.pendingTurn = {
      repoRoot,
      preTree,
      turnSummary: state.latestPromptSummary || toolName,
      startedAt: Date.now(),
    };
    log.debug("snapshot_pre_turn_captured", {
      repoRoot,
      preTree: preTree.slice(0, 10),
      tool: toolName,
    });
  });

  pi.on("agent_end", (_event, ctx) => {
    const key = resolveBridgeSessionKey(ctx);
    const state = sessions.get(key);
    if (!state?.pendingTurn) return;

    const pending = state.pendingTurn;
    state.pendingTurn = null;

    const cwd = ctx?.cwd || pending.repoRoot;
    if (!isSnapshotsEnabled(cwd)) return;

    const postTree = captureShadowTree(pending.repoRoot);
    if (!postTree) return;

    if (postTree === pending.preTree) {
      log.debug("snapshot_turn_unchanged", { repoRoot: pending.repoRoot });
      return;
    }

    state.undoStack.push({
      repoRoot: pending.repoRoot,
      preTree: pending.preTree,
      postTree,
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
      postTree: postTree.slice(0, 10),
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
    description: "Revert working-tree file changes from the last mutating turn (preserves staged index & gitignored files)",
    handler: async (_args, ctx) => {
      const cwd = ctx?.cwd || process.cwd();
      if (!isSnapshotsEnabled(cwd)) {
        emitOutput(pi, ctx, "Turn snapshots are disabled (turn_snapshots=false).", "warning");
        return;
      }
      const state = getState(ctx);
      if (state.undoStack.length === 0) {
        emitOutput(pi, ctx, "Nothing to undo — no file-mutating turns recorded in this session.", "info");
        return;
      }
      const entry = state.undoStack[state.undoStack.length - 1]!;
      const result = restoreShadowTree(entry.repoRoot, entry.preTree);
      if (!result.ok) {
        log.error("snapshot_undo_failed", { error: result.error, repoRoot: entry.repoRoot });
        emitOutput(pi, ctx, `Failed to undo turn snapshot: ${result.error || "unknown error"}`, "error");
        return;
      }
      state.undoStack.pop();
      state.redoStack.push({
        ...entry,
        postTree: result.previousTree ?? entry.postTree,
      });
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
      const result = restoreShadowTree(entry.repoRoot, entry.postTree);
      if (!result.ok) {
        log.error("snapshot_redo_failed", { error: result.error, repoRoot: entry.repoRoot });
        emitOutput(pi, ctx, `Failed to redo turn snapshot: ${result.error || "unknown error"}`, "error");
        return;
      }
      state.redoStack.pop();
      state.undoStack.push({
        ...entry,
        preTree: result.previousTree ?? entry.preTree,
      });
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

  log.debug("snapshots lifecycle registered", { maxStack });
}
