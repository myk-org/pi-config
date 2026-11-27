/**
 * browser-ops — pidash browser operations that need config/CLI/git access (#968 D/F/G, #1427).
 *
 * Settings: read/write through the SAME project-settings modules the TUI uses
 * (settings-keys.json is the single source of truth; writeSettingsFile is the
 * atomic writer). Never a direct ad-hoc file write from the daemon.
 * MCP: `pi mcp` CLI (list --json / login / logout).
 * Worktrees: reuse the SAME orchestrator worktree modules (`worktree.ts`,
 * `worktree-helpers.ts`, `git-helpers.ts`) the TUI `/worktree` overlay uses.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { createLogger } from "../shared/logger.js";
import type {
  WorktreeDetailPayload,
  WorktreeItem,
  WorktreeListPayload,
  WorktreeOpResult,
} from "../shared/types.js";
import {
  countLinkedWorktrees,
  detectWorktreePresence,
  isInLinkedWorktree,
  listWorktreesCheckedAsync,
} from "../orchestrator/git-helpers.js";
import {
  executeGuardedWorktreeRemove,
  loadWorktreeDetail,
  loadWorktreeViewsChecked,
  runWorktreePrune,
  type WorktreeDeps,
} from "../orchestrator/worktree.js";
import {
  canRemoveWorktree,
  displayWorktreePath,
  formatDirtyText,
  formatWorktreeLabel,
  formatWorktreeTags,
  type WorktreeView,
} from "../orchestrator/worktree-helpers.js";
import {
  SETTINGS_KEYS,
  clearSettingsCache,
  getSettingsPath,
  loadGlobalSettings,
  loadProjectSettings,
  updateSetting,
  validateSetting,
  type SettingsScope,
} from "../orchestrator/project-settings.js";

const log = createLogger("pidash-browser-ops");

export type { SettingsScope };

export interface SettingsKeyPayload {
  key: string;
  description: string;
  type: string;
  env?: string;
  default: unknown;
  group: string;
  enum?: string[];
  min?: number;
  max?: number;
  /** Value stored in the scope's file (undefined = not set there). */
  stored: unknown;
}

export interface SettingsPayload {
  scope: SettingsScope;
  keys: SettingsKeyPayload[];
  error?: string;
  /** Resolved settings file path (project scope) — lets browsers decide
   * whether a broadcast describes THEIR settings file even when their session
   * cwd is a different worktree/subdir of the same repo (Qodo R5). */
  settingsPath?: string;
}

function isSettingsScope(v: unknown): v is SettingsScope {
  return v === "project" || v === "global";
}

/** Snapshot of every settings key for a scope, with the value stored in that scope's file. */
export function buildSettingsPayload(cwd: string, scope: unknown): SettingsPayload {
  if (!isSettingsScope(scope)) return { scope: "project", keys: [], error: "invalid scope" };
  try {
    clearSettingsCache();
    const stored = (
      scope === "project" ? loadProjectSettings(cwd) : loadGlobalSettings()
    ) as Record<string, unknown>;
    const keys: SettingsKeyPayload[] = Object.entries(SETTINGS_KEYS).map(([key, def]) => ({
      key,
      description: def.description,
      type: def.type,
      env: def.env,
      default: def.default,
      group: def.group ?? "General",
      enum: def.enum,
      min: def.min,
      max: def.max,
      stored: key in stored ? stored[key] : undefined,
    }));
    keys.sort((a, b) => (a.group === b.group ? a.key.localeCompare(b.key) : a.group.localeCompare(b.group)));
    log.debug("settings_payload_built", { scope, keys: keys.length });
    // Resolved file path (project scope only) — identity of the settings
    // file being described, independent of the session's cwd (Qodo R5).
    return { scope, keys, settingsPath: scope === "project" ? getSettingsPath(cwd) : undefined };
  } catch (e: any) {
    log.warn("settings_payload_failed", { scope, error: e?.message });
    return { scope, keys: [], error: e?.message };
  }
}

/**
 * Validate a browser-supplied value against the unified settings schema.
 * Adds the browser-only security policy blocking `dangerous_command_allowlist`,
 * `restricted_folders`, and `tool_permissions`.
 * Returns an error string, or null when the value is valid.
 */
export function validateSettingValue(key: string, value: unknown): string | null {
  if (key === "dangerous_command_allowlist" || key === "restricted_folders" || key === "tool_permissions") {
    return `${key} is managed by the terminal settings editor only`;
  }
  const result = validateSetting(key, value, { allowNull: true });
  return result.ok ? null : result.error;
}

/** Apply one setting to a scope's file. value === null removes the key. */
export function applySetting(
  cwd: string,
  scope: unknown,
  key: string,
  value: unknown,
): { ok: boolean; error?: string } {
  if (!isSettingsScope(scope)) return { ok: false, error: "invalid scope" };
  const validationError = validateSettingValue(key, value);
  if (validationError) {
    log.warn("browser_setting_rejected", { scope, key, error: validationError });
    return { ok: false, error: validationError };
  }
  const result = updateSetting(cwd, scope, key, value);
  if (!result.ok) {
    if (result.reason === "corrupt") {
      log.warn("browser_setting_save_refused_malformed_file", { scope, key, filePath: result.file });
    } else {
      log.error("browser_setting_apply_failed", { scope, key, error: result.error });
    }
    return { ok: false, error: result.error };
  }
  log.info("browser_setting_applied", { scope, key, cleared: value === null });
  return { ok: true };
}

/**
 * Run `pi mcp <args>` and resolve stdout (rejects with .stdout attached on failure).
 *
 * Async on purpose: this runs inside the live Pi process's websocket handler,
 * and `pi mcp login` can wait on OAuth browser completion for minutes — a
 * synchronous exec would block the event loop (TUI, agent streaming, timers,
 * every pidash socket) for the whole timeout window.
 */
export async function runMcp(args: string[], cwd: string, timeoutMs = 60000): Promise<string> {
  const { stdout } = await execFileAsync("pi", ["mcp", ...args], {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, PI_MCP_NO_BROWSER: process.env.PI_MCP_NO_BROWSER },
  });
  return stdout;
}

/** Parse `pi mcp list --json` output. Returns servers array or error. */
export async function mcpList(cwd: string): Promise<{ servers?: unknown[]; raw?: string; error?: string }> {
  try {
    const out = await runMcp(["list", "--json"], cwd);
    try {
      const parsed = JSON.parse(out);
      return { servers: Array.isArray(parsed) ? parsed : parsed?.servers ?? [parsed] };
    } catch {
      // Not JSON — return raw text for display
      return { raw: out };
    }
  } catch (e: any) {
    log.warn("mcp_list_failed", { error: e?.message });
    return { error: (e?.stderr || e?.message || String(e)).slice(0, 2000) };
  }
}

// ── #1427: Worktrees panel operations (single source of truth with TUI /worktree) ──

export const MAX_WORKTREE_STATUS_LINES = 60;

export const WORKTREE_DIRTY_POLL_INTERVAL_MS = 60_000;

export interface WorktreeSummary {
  worktreeCount: number;
  worktreeDirtyCount: number;
  inLinkedWorktree: boolean;
}

export function worktreeSummaryEqual(a: WorktreeSummary | null, b: WorktreeSummary): boolean {
  return (
    a !== null &&
    a.worktreeCount === b.worktreeCount &&
    a.worktreeDirtyCount === b.worktreeDirtyCount &&
    a.inLinkedWorktree === b.inLinkedWorktree
  );
}

/**
 * Fast worktree summary for the InfoBar badge. Uses `detectWorktreePresence` first
 * to avoid spawning git in single-checkout repositories. When `includeDirty` is false
 * (the 10s periodic tick), avoids spawning `git status` across every worktree and
 * preserves `fallbackDirtyCount` (clamped when no linked worktrees exist).
 * Returns `null` on a failed git listing so callers retain the last valid summary
 * instead of overwriting the badge with zeros.
 */
export async function getWorktreeSummary(
  cwd: string,
  deps: Pick<WorktreeDeps, "runGitAsync"> & {
    hasLinkedWorktreesHint?: (dir: string) => boolean | null;
    includeDirty?: boolean;
    fallbackDirtyCount?: number;
  } = {},
): Promise<WorktreeSummary | null> {
  const checkPresence = deps.hasLinkedWorktreesHint ?? detectWorktreePresence;
  const includeDirty = deps.includeDirty ?? false;
  try {
    if (checkPresence(cwd) === false) {
      return { worktreeCount: 0, worktreeDirtyCount: 0, inLinkedWorktree: false };
    }
    const listed = await listWorktreesCheckedAsync(cwd, {
      includeDirty,
      forceRefresh: false,
      runGitAsync: deps.runGitAsync,
    });
    if (!listed.ok) {
      log.debug("worktree_summary_git_failed", { cwd, error: listed.error });
      return null;
    }
    const entries = listed.entries;
    const worktreeCount = countLinkedWorktrees(entries);
    const worktreeDirtyCount = includeDirty
      ? entries.filter((w) => (w.dirty?.total ?? 0) > 0).length
      : worktreeCount > 0
        ? Math.max(0, deps.fallbackDirtyCount ?? 0)
        : 0;
    return {
      worktreeCount,
      worktreeDirtyCount,
      inLinkedWorktree: isInLinkedWorktree(entries),
    };
  } catch (e: any) {
    log.debug("worktree_summary_failed", { cwd, error: e?.message || String(e) });
    return null;
  }
}

/** Project a `WorktreeView` into the browser wire representation using shared TUI helpers. */
export function buildWorktreeItem(wt: WorktreeView, cwd: string): WorktreeItem {
  const guard = canRemoveWorktree(wt);
  return {
    id: wt.id,
    path: wt.path,
    relativePath: displayWorktreePath(wt.path, cwd),
    label: formatWorktreeLabel(wt),
    head: wt.head,
    branch: wt.branch,
    detached: wt.detached,
    bare: wt.bare,
    isMain: wt.isMain,
    isCurrent: wt.isCurrent,
    locked: wt.locked,
    ...(wt.lockedReason ? { lockedReason: wt.lockedReason } : {}),
    prunable: wt.prunable,
    ...(wt.prunableReason ? { prunableReason: wt.prunableReason } : {}),
    ...(wt.dirty ? { dirty: wt.dirty } : {}),
    dirtyText: formatDirtyText(wt),
    tags: formatWorktreeTags(wt),
    peers: wt.peers.map((p) => ({ ...p })),
    ...(wt.peersUnverifiedReason ? { peersUnverifiedReason: wt.peersUnverifiedReason } : {}),
    ...(wt.pr ? { pr: { number: wt.pr.number, url: wt.pr.url } } : {}),
    canRemove: guard.allowed,
    ...(guard.allowed ? {} : { removeBlockedReason: guard.reason }),
  };
}

/** Load the full worktree list payload for PiDash using `loadWorktreeViewsChecked`. */
export async function loadWorktreesPayload(
  cwd: string,
  opts: {
    forceRefresh?: boolean;
    forceRefreshPrs?: boolean;
    includePrs?: boolean;
    deps?: Pick<WorktreeDeps, "runGitAsync" | "readLivePeers" | "inspectLivePeers" | "fetchOpenPrs">;
  } = {},
): Promise<WorktreeListPayload> {
  try {
    const res = await loadWorktreeViewsChecked(cwd, opts.deps ?? {}, opts.forceRefresh ?? true, {
      includePrs: opts.includePrs ?? true,
      forceRefreshPrs: opts.forceRefreshPrs ?? false,
    });
    if (!res.ok) {
      const error = res.error || "Failed to list git worktrees.";
      log.warn("worktrees_payload_git_failed", { cwd, error });
      return {
        cwd,
        linkedCount: 0,
        dirtyCount: 0,
        inLinkedWorktree: false,
        worktrees: [],
        error,
      };
    }
    const views = res.views;
    const linkedCount = countLinkedWorktrees(views);
    const dirtyCount = views.filter((w) => (w.dirty?.total ?? 0) > 0).length;
    const inLinked = isInLinkedWorktree(views);
    const repoRoot = views.find((w) => w.isMain)?.path;
    const worktrees = views.map((w) => buildWorktreeItem(w, cwd));
    log.debug("worktrees_payload_built", { cwd, count: worktrees.length, linkedCount, dirtyCount });
    return {
      cwd,
      ...(repoRoot ? { repoRoot } : {}),
      linkedCount,
      dirtyCount,
      inLinkedWorktree: inLinked,
      worktrees,
    };
  } catch (e: any) {
    const error = e?.message || String(e);
    log.warn("worktrees_payload_failed", { cwd, error });
    return {
      cwd,
      linkedCount: 0,
      dirtyCount: 0,
      inLinkedWorktree: false,
      worktrees: [],
      error,
    };
  }
}

/**
 * Load HEAD subject and `git status --short` (capped at 60 lines) for one registered worktree.
 * Validates the exact registered path via `listWorktreesCheckedAsync` with `includeDirty: false`
 * (avoiding per-worktree status scans) and rejects unregistered paths or git listing failures.
 */
export async function loadWorktreeDetailPayload(
  cwd: string,
  targetPath: unknown,
  deps: Pick<WorktreeDeps, "runGitAsync" | "readLivePeers" | "inspectLivePeers"> = {},
): Promise<WorktreeDetailPayload> {
  const pathStr = typeof targetPath === "string" ? targetPath.trim() : "";
  if (!pathStr) {
    return {
      path: "",
      headSubject: "",
      statusLines: [],
      truncatedCount: 0,
      statusOk: false,
      error: "Worktree path is required.",
    };
  }
  try {
    const listed = await listWorktreesCheckedAsync(cwd, {
      includeDirty: false,
      forceRefresh: false,
      runGitAsync: deps.runGitAsync,
    });
    if (!listed.ok) {
      const error = listed.error || "Failed to list git worktrees.";
      log.warn("worktree_detail_list_failed", { cwd, path: pathStr, error });
      return {
        path: pathStr,
        headSubject: "",
        statusLines: [],
        truncatedCount: 0,
        statusOk: false,
        error,
      };
    }
    const entry = listed.entries.find((w) => w.path === pathStr);
    if (!entry) {
      log.warn("worktree_detail_not_found", { cwd, path: pathStr });
      return {
        path: pathStr,
        headSubject: "",
        statusLines: [],
        truncatedCount: 0,
        statusOk: false,
        error: "Worktree not found in this repository.",
      };
    }
    const detail = await loadWorktreeDetail({ ...entry, id: entry.path, peers: [] }, deps.runGitAsync);
    const total = detail.statusLines.length;
    const statusLines = detail.statusLines.slice(0, MAX_WORKTREE_STATUS_LINES);
    const truncatedCount = Math.max(0, total - MAX_WORKTREE_STATUS_LINES);
    log.debug("worktree_detail_loaded", { path: entry.path, lines: statusLines.length, truncatedCount });
    return {
      path: entry.path,
      headSubject: detail.headSubject,
      statusLines,
      truncatedCount,
      statusOk: detail.statusOk !== false,
      ...(detail.statusError ? { statusError: detail.statusError } : {}),
    };
  } catch (e: any) {
    const error = e?.message || String(e);
    log.warn("worktree_detail_failed", { cwd, path: pathStr, error });
    return {
      path: pathStr,
      headSubject: "",
      statusLines: [],
      truncatedCount: 0,
      statusOk: false,
      error,
    };
  }
}

/** Run `git worktree prune -v` via the shared `runWorktreePrune` helper. */
export async function pruneWorktreesOp(
  cwd: string,
  deps: Pick<WorktreeDeps, "runGitAsync" | "onWorktreesChanged"> = {},
): Promise<WorktreeOpResult> {
  try {
    const res = await runWorktreePrune(cwd, deps);
    log.info("browser_worktree_prune", { cwd, ok: res.ok, pruned: res.pruned.length });
    return {
      op: "prune",
      ok: res.ok,
      message: res.message,
      pruned: res.pruned,
    };
  } catch (e: any) {
    const error = e?.message || String(e);
    log.warn("browser_worktree_prune_failed", { cwd, error });
    return {
      op: "prune",
      ok: false,
      message: `Worktree prune failed: ${error}`,
      pruned: [],
    };
  }
}

/**
 * Guarded single or bulk `git worktree remove` via `executeGuardedWorktreeRemove`.
 * Server-side enforces main, current, locked, dirty, unknown dirty, active COMS peer,
 * and unverifiable COMS registry protections for every target path.
 */
export async function removeWorktreesOp(
  cwd: string,
  rawPaths: unknown,
  deps: Pick<WorktreeDeps, "runGitAsync" | "readLivePeers" | "inspectLivePeers" | "onWorktreesChanged"> = {},
): Promise<WorktreeOpResult> {
  const inputList = Array.isArray(rawPaths)
    ? rawPaths
    : typeof rawPaths === "string"
      ? [rawPaths]
      : [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const item of inputList) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    paths.push(trimmed);
  }

  if (paths.length === 0) {
    return {
      op: "remove",
      ok: false,
      message: "No worktree paths specified.",
      removed: [],
      failed: [],
    };
  }

  const removed: string[] = [];
  const failed: Array<{ path: string; relativePath: string; reason: string }> = [];
  let singleMessage = "";

  for (const targetPath of paths) {
    try {
      const res = await executeGuardedWorktreeRemove(cwd, targetPath, deps);
      if (paths.length === 1) singleMessage = res.message;
      if (res.ok) {
        removed.push(targetPath);
      } else {
        failed.push({
          path: targetPath,
          relativePath: displayWorktreePath(targetPath, cwd),
          reason: res.message,
        });
      }
    } catch (e: any) {
      const reason = e?.message || String(e);
      if (paths.length === 1) singleMessage = reason;
      failed.push({
        path: targetPath,
        relativePath: displayWorktreePath(targetPath, cwd),
        reason,
      });
    }
  }

  const ok = failed.length === 0 && removed.length > 0;
  let message: string;
  if (paths.length === 1) {
    message = singleMessage || (ok ? `Removed worktree: ${displayWorktreePath(paths[0], cwd)}` : "Failed to remove worktree.");
  } else if (ok) {
    message = `Removed ${removed.length} worktrees.`;
  } else if (removed.length > 0) {
    message = `Removed ${removed.length}/${paths.length} worktrees (${failed.length} skipped/failed: ${failed.map((f) => f.relativePath).join(", ")}).`;
  } else {
    message = `Cannot remove ${failed.length} worktree${failed.length === 1 ? "" : "s"}: ${failed.map((f) => `${f.relativePath} (${f.reason})`).join("; ")}`;
  }

  log.info("browser_worktree_remove", {
    cwd,
    requested: paths.length,
    removed: removed.length,
    failed: failed.length,
  });

  return { op: "remove", ok, message, removed, failed };
}
