/**
 * Restricted folders enforcement & tiered approval grants (issue #1416).
 *
 * Enforces explicit user approval whenever a tool accesses a path inside any
 * configured `restricted_folders` entry:
 * - Covers `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash` (effective `cwd` + `cd`/`pushd` targets).
 * - Expands `~`, resolves relative paths against `cwd`, canonicalizes symlinks
 *   (including symlinked parents of non-existent paths via `nearestRealPath`),
 *   and enforces strict path-boundary prefix matching (`/a/foo` never matches `/a/foobar`).
 * - Unions global and project `restricted_folders` so a project settings file can
 *   never clear or weaken global folder restrictions.
 * - Fails closed (denies) in headless / non-TUI contexts where interactive approval
 *   cannot be prompted.
 * - Supports tiered grants:
 *   - `Approve Once` (single call, not stored)
 *   - `Approve File` (exact canonical path; session-only or persistent in `.pi/data/state.db`)
 *   - `Approve Directory (direct children only)` (directory itself + direct children only,
 *     never grandchildren; session-only or persistent in `.pi/data/state.db`)
 * - Exposes `/forget-approvals` to clear session and persistent grants.
 */

import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createLogger, type Logger } from "../shared/logger.js";
import { resolveEffectiveCwd, unquotedSegments } from "./bash-policy.js";
import { loadGlobalSettings, loadProjectSettings } from "./project-settings.js";
import { getProjectStateDbPath, openStateDb, withTransaction } from "./state-db.js";

const defaultLog = createLogger("restricted-folders");

export type ApprovalScope = "file" | "directory";
export type ApprovalPersistence = "session" | "persistent";

export interface RestrictedFolderApproval {
  scope: ApprovalScope;
  targetPath: string;
  restrictedRoot: string;
  persistence: ApprovalPersistence;
  createdAt: string;
}

export interface RestrictedFolderMatch {
  /** Raw target path inspected from the tool call. */
  rawTarget: string;
  /** Canonical path matched inside the restricted folder. */
  canonicalTarget: string;
  /** Canonical restricted folder root that matched. */
  restrictedRoot: string;
  /** Original configured folder string from settings. */
  configuredFolder: string;
  /** Hint that the tool targets a directory (e.g. `bash` cwd, `ls`). */
  isDirectoryHint: boolean;
}

export interface RestrictedFolderPromptUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify?(message: string, level: "info" | "warning" | "error"): Promise<void> | void;
}

export interface EvaluateRestrictedFolderInput {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  sessionId?: string | null;
  ui?: RestrictedFolderPromptUi | null;
  /** Optional explicit list of restricted folders (defaults to union of global + project settings). */
  restrictedFolders?: readonly string[];
  /** Optional explicit SQLite DB path override (defaults to `getProjectStateDbPath(cwd)`). */
  dbPath?: string;
  homeDir?: string;
  log?: Logger;
}

export type RestrictedFolderDecision = { block: true; reason: string } | undefined;

// ── Choice Labels ──────────────────────────────────────────────────────────

export const CHOICE_DENY = "Deny";
export const CHOICE_APPROVE_ONCE = "Approve Once";
export const CHOICE_APPROVE_FILE_SESSION = "Approve File (this session)";
export const CHOICE_APPROVE_FILE_PERSISTENT = "Approve File (persistent)";
export const CHOICE_APPROVE_DIR_SESSION = "Approve Directory — direct children only (this session)";
export const CHOICE_APPROVE_DIR_PERSISTENT = "Approve Directory — direct children only (persistent)";

// ── Session Approval Store (survives /reload on globalThis) ────────────────

const SESSION_APPROVALS_SYMBOL = Symbol.for("pi-config.restrictedFolderSessionApprovals.v1");
const DEFAULT_SESSION_BUCKET = "__default__";

type SessionGrantMap = Map<string, RestrictedFolderApproval>;

function getSessionStore(): Map<string, SessionGrantMap> {
  const g = globalThis as Record<symbol, Map<string, SessionGrantMap> | undefined>;
  let store = g[SESSION_APPROVALS_SYMBOL];
  if (!store) {
    store = new Map();
    g[SESSION_APPROVALS_SYMBOL] = store;
  }
  return store;
}

function sessionBucketKey(sessionId?: string | null): string {
  return typeof sessionId === "string" && sessionId.trim() !== "" ? sessionId : DEFAULT_SESSION_BUCKET;
}

function grantKey(scope: ApprovalScope, targetPath: string): string {
  return `${scope}\0${targetPath}`;
}

export function addSessionApproval(
  sessionId: string | null | undefined,
  scope: ApprovalScope,
  targetPath: string,
  restrictedRoot: string,
): RestrictedFolderApproval {
  const store = getSessionStore();
  const bucketKey = sessionBucketKey(sessionId);
  let bucket = store.get(bucketKey);
  if (!bucket) {
    bucket = new Map();
    store.set(bucketKey, bucket);
  }
  const record: RestrictedFolderApproval = {
    scope,
    targetPath,
    restrictedRoot,
    persistence: "session",
    createdAt: new Date().toISOString(),
  };
  bucket.set(grantKey(scope, targetPath), record);
  return record;
}

export function listSessionApprovals(sessionId?: string | null): RestrictedFolderApproval[] {
  const bucket = getSessionStore().get(sessionBucketKey(sessionId));
  return bucket ? [...bucket.values()] : [];
}

export function clearSessionApprovals(sessionId?: string | null): number {
  const store = getSessionStore();
  if (sessionId === undefined) {
    let total = 0;
    for (const bucket of store.values()) total += bucket.size;
    store.clear();
    return total;
  }
  const bucketKey = sessionBucketKey(sessionId);
  const bucket = store.get(bucketKey);
  const count = bucket ? bucket.size : 0;
  store.delete(bucketKey);
  return count;
}

// ── Persistent SQLite Approval Store (.pi/data/state.db) ───────────────────

export function addPersistentApproval(
  cwd: string,
  scope: ApprovalScope,
  targetPath: string,
  restrictedRoot: string,
  dbPath?: string,
): RestrictedFolderApproval {
  const targetDb = dbPath ?? getProjectStateDbPath(cwd);
  const createdAt = new Date().toISOString();
  withTransaction(targetDb, (db) => {
    db.prepare(
      `INSERT INTO restricted_folder_approvals (scope, target_path, restricted_root, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, target_path) DO UPDATE SET
         restricted_root = excluded.restricted_root,
         created_at = excluded.created_at`,
    ).run(scope, targetPath, restrictedRoot, createdAt);
  });
  return {
    scope,
    targetPath,
    restrictedRoot,
    persistence: "persistent",
    createdAt,
  };
}

export function listPersistentApprovals(cwd: string, dbPath?: string): RestrictedFolderApproval[] {
  const targetDb = dbPath ?? getProjectStateDbPath(cwd);
  const db = openStateDb(targetDb);
  const rows = db
    .prepare(
      "SELECT scope, target_path, restricted_root, created_at FROM restricted_folder_approvals ORDER BY id ASC",
    )
    .all() as Array<{
    scope?: string;
    target_path?: string;
    restricted_root?: string;
    created_at?: string;
  }>;
  const out: RestrictedFolderApproval[] = [];
  for (const row of rows) {
    if (
      (row.scope === "file" || row.scope === "directory") &&
      typeof row.target_path === "string" &&
      typeof row.restricted_root === "string"
    ) {
      out.push({
        scope: row.scope,
        targetPath: row.target_path,
        restrictedRoot: row.restricted_root,
        persistence: "persistent",
        createdAt: typeof row.created_at === "string" ? row.created_at : "",
      });
    }
  }
  return out;
}

export function clearPersistentApprovals(cwd: string, dbPath?: string): number {
  const targetDb = dbPath ?? getProjectStateDbPath(cwd);
  return withTransaction(targetDb, (db) => {
    const info = db.prepare("DELETE FROM restricted_folder_approvals").run();
    return Number(info.changes ?? 0);
  });
}

/** Clear cached restricted-folder approvals across session memory and/or SQLite. */
export function forgetApprovals(
  cwd: string,
  sessionId?: string | null,
  mode: "all" | "session" | "persistent" = "all",
  dbPath?: string,
  log: Logger = defaultLog,
): { sessionCleared: number; persistentCleared: number } {
  const sessionCleared = mode === "persistent" ? 0 : clearSessionApprovals(sessionId);
  let persistentCleared = 0;
  if (mode !== "session") {
    try {
      persistentCleared = clearPersistentApprovals(cwd, dbPath);
    } catch (err) {
      log.warn("restricted_folder_clear_persistent_failed", { cwd }, err);
    }
  }
  log.info("restricted_folder_approvals_forgotten", { mode, sessionCleared, persistentCleared });
  return { sessionCleared, persistentCleared };
}

// ── Path Canonicalization & Boundary-Safe Matching ─────────────────────────

function stripTrailingSeparators(p: string): string {
  let out = p;
  while (out.length > 1 && out.endsWith(sep)) {
    out = out.slice(0, -1);
  }
  return out;
}

/** Expand leading `~` or `~/` to `homeDir`. */
export function expandHomePath(rawPath: string, homeDir = homedir()): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

const MAX_SYMLINK_HOPS = 40;

/**
 * Symlink-safe canonical path resolver that handles:
 * - existing paths (`realpathSync`)
 * - non-existent children under symlinked parent directories
 * - dangling symlinks whose target does not exist yet (prevents write-through escape)
 */
function resolveRealPathWithDangling(absPath: string): string {
  let current = absPath;
  const tail: string[] = [];
  let hops = 0;

  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      // Check if `current` itself is a dangling symlink before walking to its parent.
      try {
        const st = lstatSync(current);
        if (st.isSymbolicLink() && hops < MAX_SYMLINK_HOPS) {
          hops++;
          const linkTarget = readlinkSync(current);
          const resolvedLink = resolve(dirname(current), linkTarget);
          current = tail.length > 0 ? join(resolvedLink, ...tail.reverse()) : resolvedLink;
          tail.length = 0;
          continue;
        }
      } catch {
        // Not a symlink (ENOENT / EACCES) — walk upward to nearest existing ancestor.
      }
      const parent = dirname(current);
      if (parent === current) {
        return tail.length > 0 ? join(current, ...tail.reverse()) : current;
      }
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Resolve `~`, relative segments against `baseCwd`, and symlinked ancestors (including dangling symlinks). */
export function resolveCanonicalPath(rawPath: string, baseCwd: string, homeDir = homedir()): string {
  const expanded = expandHomePath(rawPath, homeDir);
  const absolute = resolve(baseCwd, expanded);
  return stripTrailingSeparators(resolveRealPathWithDangling(absolute));
}

/**
 * Strict path-boundary containment check.
 * `/a/foo` matches `/a/foo` and `/a/foo/bar`, NEVER `/a/foobar`.
 */
export function isPathInsideFolder(canonicalTarget: string, canonicalFolder: string): boolean {
  const target = stripTrailingSeparators(canonicalTarget);
  const folder = stripTrailingSeparators(canonicalFolder);
  if (target === folder) return true;
  if (folder === sep) return target.startsWith(sep);
  return target.startsWith(folder + sep);
}

/**
 * Union global and project `restricted_folders` so project settings can add
 * restrictions but never shadow or clear user-global restricted folders.
 */
export function loadRestrictedFolders(cwd: string): string[] {
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const list of [
    loadGlobalSettings().restricted_folders ?? [],
    loadProjectSettings(cwd).restricted_folders ?? [],
  ]) {
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      combined.push(trimmed);
    }
  }
  return combined;
}

/**
 * Check whether `rawTarget` falls inside any folder in `restrictedFolders`.
 * Resolves symlinks in BOTH directions:
 * - Symlink outside pointing into a restricted folder (including non-existent children)
 * - Symlink inside a restricted folder pointing outside
 */
export function matchRestrictedFolder(
  rawTarget: string,
  baseCwd: string,
  restrictedFolders: readonly string[],
  isDirectoryHint = false,
  homeDir = homedir(),
): RestrictedFolderMatch | null {
  if (restrictedFolders.length === 0) return null;

  const expandedTarget = expandHomePath(rawTarget, homeDir);
  const lexicalAbs = resolve(baseCwd, expandedTarget);
  const canonicalTarget = stripTrailingSeparators(resolveRealPathWithDangling(lexicalAbs));
  const canonicalLexicalParent = stripTrailingSeparators(resolveRealPathWithDangling(dirname(lexicalAbs)));

  for (const configured of restrictedFolders) {
    if (!configured || !configured.trim()) continue;
    const canonicalFolder = resolveCanonicalPath(configured, baseCwd, homeDir);

    if (isPathInsideFolder(canonicalTarget, canonicalFolder)) {
      return {
        rawTarget,
        canonicalTarget,
        restrictedRoot: canonicalFolder,
        configuredFolder: configured,
        isDirectoryHint,
      };
    }

    // Catch accessing a symlink located INSIDE a restricted folder even if it points outside.
    if (isPathInsideFolder(canonicalLexicalParent, canonicalFolder)) {
      const lexicalCanonicalTarget = stripTrailingSeparators(
        join(canonicalLexicalParent, basename(lexicalAbs)),
      );
      return {
        rawTarget,
        canonicalTarget: lexicalCanonicalTarget,
        restrictedRoot: canonicalFolder,
        configuredFolder: configured,
        isDirectoryHint,
      };
    }
  }

  return null;
}

// ── Tool Target Extraction ─────────────────────────────────────────────────

interface ExtractedTarget {
  path: string;
  isDirectoryHint: boolean;
}

const CD_TARGET_RE = /(?:^|[\s;&|({])(?:cd|pushd)(?:\s+(?:--|-L|-P))*\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|()]+))/;

function collectBashCandidateDirs(command: string, sessionCwd: string, homeDir: string): string[] {
  const dirs = new Set<string>();
  dirs.add(sessionCwd);
  dirs.add(resolveEffectiveCwd(command, sessionCwd));

  const running: string[] = [sessionCwd];
  for (const seg of unquotedSegments(command)) {
    if (running.length > seg.depth + 1) running.length = seg.depth + 1;
    while (running.length <= seg.depth) running.push(running[running.length - 1]!);

    const m = CD_TARGET_RE.exec(seg.text);
    if (!m) continue;
    const rawDest = m[1] ?? m[2] ?? m[3] ?? "";
    if (!rawDest || rawDest === "-") continue;
    // Skip dynamic shell expansions we cannot resolve statically
    if (/[$*?{]/.test(rawDest)) continue;

    const expanded = expandHomePath(rawDest, homeDir);
    const nextDir = resolve(running[seg.depth]!, expanded);
    dirs.add(nextDir);
    if (!seg.backgrounded) {
      running[seg.depth] = nextDir;
    }
  }

  return [...dirs];
}

export function extractToolTargetPaths(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  homeDir = homedir(),
): ExtractedTarget[] {
  switch (toolName) {
    case "read":
    case "write":
    case "edit": {
      const p = typeof input.path === "string" ? input.path.trim() : "";
      return p ? [{ path: p, isDirectoryHint: false }] : [];
    }
    case "grep":
    case "find":
    case "ls": {
      const p = typeof input.path === "string" && input.path.trim() !== "" ? input.path.trim() : cwd;
      return [{ path: p, isDirectoryHint: toolName === "ls" }];
    }
    case "bash": {
      const command = typeof input.command === "string" ? input.command : "";
      return collectBashCandidateDirs(command, cwd, homeDir).map((dir) => ({
        path: dir,
        isDirectoryHint: true,
      }));
    }
    default:
      return [];
  }
}

// ── Grant Matching & Evaluation ────────────────────────────────────────────

/**
 * Check whether an approval grant covers `canonicalTarget`.
 * - `"file"` scope matches ONLY exact canonical path equality.
 * - `"directory"` scope matches the directory itself OR direct children only
 *   (`dirname(canonicalTarget) === grant.targetPath`), NEVER grandchildren.
 */
export function grantCoversPath(
  grant: Pick<RestrictedFolderApproval, "scope" | "targetPath">,
  canonicalTarget: string,
): boolean {
  const target = stripTrailingSeparators(canonicalTarget);
  const granted = stripTrailingSeparators(grant.targetPath);
  if (grant.scope === "file") {
    return target === granted;
  }
  // Directory scope: directory itself or direct children only (no recursive grandchildren).
  return target === granted || stripTrailingSeparators(dirname(target)) === granted;
}

function findMatchingApproval(
  canonicalTarget: string,
  cwd: string,
  sessionId?: string | null,
  dbPath?: string,
  log: Logger = defaultLog,
): RestrictedFolderApproval | null {
  // 1. Check session-scoped approvals in memory.
  for (const grant of listSessionApprovals(sessionId)) {
    if (grantCoversPath(grant, canonicalTarget)) return grant;
  }

  // 2. Check persistent SQLite approvals.
  try {
    for (const grant of listPersistentApprovals(cwd, dbPath)) {
      if (grantCoversPath(grant, canonicalTarget)) return grant;
    }
  } catch (err) {
    // Fail closed on DB error — never implicitly approve.
    log.warn("restricted_folder_db_read_failed", { cwd }, err);
  }

  return null;
}

function isExistingDirectory(canonicalPath: string): boolean {
  try {
    return statSync(canonicalPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveGrantDirectory(match: RestrictedFolderMatch, targetIsDir: boolean): string {
  if (targetIsDir) return match.canonicalTarget;
  const parentDir = stripTrailingSeparators(dirname(match.canonicalTarget));
  // Never widen a directory grant outside the matched restricted folder root.
  return isPathInsideFolder(parentDir, match.restrictedRoot) ? parentDir : match.restrictedRoot;
}

/**
 * Evaluate a tool call against `restricted_folders` and cached grants, prompting
 * interactively via `ui` when needed and failing closed in headless contexts.
 */
export async function evaluateRestrictedFolderAccess(
  params: EvaluateRestrictedFolderInput,
): Promise<RestrictedFolderDecision> {
  const log = params.log ?? defaultLog;
  const home = params.homeDir ?? homedir();
  const folders = params.restrictedFolders ?? loadRestrictedFolders(params.cwd);
  if (folders.length === 0) return undefined;

  const targets = extractToolTargetPaths(params.toolName, params.input, params.cwd, home);
  if (targets.length === 0) return undefined;

  const seenCanonical = new Set<string>();
  for (const target of targets) {
    const match = matchRestrictedFolder(target.path, params.cwd, folders, target.isDirectoryHint, home);
    if (!match) continue;
    if (seenCanonical.has(match.canonicalTarget)) continue;
    seenCanonical.add(match.canonicalTarget);

    // Check existing session / persistent grants.
    const existing = findMatchingApproval(
      match.canonicalTarget,
      params.cwd,
      params.sessionId,
      params.dbPath,
      log,
    );
    if (existing) {
      log.debug("restricted_folder_access_granted_cached", {
        toolName: params.toolName,
        target: match.canonicalTarget,
        scope: existing.scope,
        persistence: existing.persistence,
      });
      continue;
    }

    // Fail closed in headless / non-TUI contexts where interactive approval cannot be prompted.
    if (!params.ui) {
      log.warn("restricted_folder_access_denied_headless", {
        toolName: params.toolName,
        target: match.canonicalTarget,
        restrictedRoot: match.restrictedRoot,
      });
      return {
        block: true,
        reason: `⛔ Access to restricted folder (${match.restrictedRoot}) blocked for ${params.toolName} (${match.canonicalTarget}): explicit interactive approval is required (denied in headless/non-TUI mode).`,
      };
    }

    const targetIsDir = match.isDirectoryHint || isExistingDirectory(match.canonicalTarget);
    const grantDir = resolveGrantDirectory(match, targetIsDir);

    const options = targetIsDir
      ? [
          CHOICE_DENY,
          CHOICE_APPROVE_ONCE,
          CHOICE_APPROVE_DIR_SESSION,
          CHOICE_APPROVE_DIR_PERSISTENT,
        ]
      : [
          CHOICE_DENY,
          CHOICE_APPROVE_ONCE,
          CHOICE_APPROVE_FILE_SESSION,
          CHOICE_APPROVE_FILE_PERSISTENT,
          CHOICE_APPROVE_DIR_SESSION,
          CHOICE_APPROVE_DIR_PERSISTENT,
        ];

    const title = [
      `🔒 Restricted folder access (${params.toolName})`,
      `Target: ${match.canonicalTarget}`,
      `Restricted folder: ${match.restrictedRoot}`,
      `Directory grant scope (if selected): ${grantDir} (direct children only)`,
    ].join("\n");

    let choice: string | undefined;
    try {
      choice = await params.ui.select(title, options);
    } catch (err) {
      log.warn("restricted_folder_prompt_failed", { toolName: params.toolName }, err);
      choice = undefined;
    }

    if (!choice || choice === CHOICE_DENY) {
      log.info("restricted_folder_access_denied", {
        toolName: params.toolName,
        target: match.canonicalTarget,
        restrictedRoot: match.restrictedRoot,
      });
      return {
        block: true,
        reason: `⛔ Access to restricted folder (${match.restrictedRoot}) denied by user for ${params.toolName} (${match.canonicalTarget}).`,
      };
    }

    switch (choice) {
      case CHOICE_APPROVE_ONCE:
        log.info("restricted_folder_approved_once", {
          toolName: params.toolName,
          target: match.canonicalTarget,
        });
        break;

      case CHOICE_APPROVE_FILE_SESSION:
        addSessionApproval(params.sessionId, "file", match.canonicalTarget, match.restrictedRoot);
        log.info("restricted_folder_approved_file_session", {
          target: match.canonicalTarget,
        });
        break;

      case CHOICE_APPROVE_FILE_PERSISTENT:
        try {
          addPersistentApproval(
            params.cwd,
            "file",
            match.canonicalTarget,
            match.restrictedRoot,
            params.dbPath,
          );
          log.info("restricted_folder_approved_file_persistent", {
            target: match.canonicalTarget,
          });
        } catch (err) {
          log.error("restricted_folder_persist_failed", { target: match.canonicalTarget }, err);
          await params.ui.notify?.(
            "⚠️ Persistent approval could not be saved to state.db — treated as Approve Once.",
            "warning",
          );
        }
        break;

      case CHOICE_APPROVE_DIR_SESSION:
        addSessionApproval(params.sessionId, "directory", grantDir, match.restrictedRoot);
        log.info("restricted_folder_approved_dir_session", {
          grantDir,
        });
        break;

      case CHOICE_APPROVE_DIR_PERSISTENT:
        try {
          addPersistentApproval(
            params.cwd,
            "directory",
            grantDir,
            match.restrictedRoot,
            params.dbPath,
          );
          log.info("restricted_folder_approved_dir_persistent", {
            grantDir,
          });
        } catch (err) {
          log.error("restricted_folder_persist_failed", { grantDir }, err);
          await params.ui.notify?.(
            "⚠️ Persistent approval could not be saved to state.db — treated as Approve Once.",
            "warning",
          );
        }
        break;

      default:
        // Unknown choice -> fail closed.
        log.warn("restricted_folder_unknown_choice", { choice });
        return {
          block: true,
          reason: `⛔ Access to restricted folder (${match.restrictedRoot}) denied for ${params.toolName} (${match.canonicalTarget}).`,
        };
    }
  }

  return undefined;
}
