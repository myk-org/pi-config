/**
 * Restricted folders enforcement & tiered approval grants (issue #1416).
 *
 * Enforces explicit user approval whenever a tool accesses a path inside any
 * configured `restricted_folders` entry:
 * - Covers `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash` (effective `cwd`,
 *   `cd`/`pushd` targets — including failing closed / prompting on unresolved shell
 *   expansions — and path-like file operands such as `cat ~/.ssh/id_rsa`).
 * - Normalizes paths identically to Pi's file tools (strips leading `@`, normalizes
 *   Unicode spaces, expands `~`, resolves relative segments against `cwd`).
 * - Resolves symlinks in BOTH directions (including symlinked parents of non-existent
 *   paths, dangling symlinks, and nested paths beneath a symlink inside a restricted
 *   folder such as `/restricted/link/child`) and enforces strict path-boundary prefix
 *   matching (`/a/foo` never matches `/a/foobar`).
 * - Accounts for recursive `grep`/`find` traversal: detects restricted folders beneath
 *   the search root (including omitted `path` defaulting to `cwd`) and never lets a
 *   direct-children-only directory grant authorize recursive searches.
 * - Unions global and project `restricted_folders` so project settings can never clear
 *   or weaken global folder restrictions.
 * - Isolates session approvals strictly per non-empty `sessionId` (ID-less contexts
 *   never share a bucket and cannot store session approvals).
 * - Authenticates persistent SQLite grants in `.pi/data/state.db` with HMAC-SHA256
 *   so raw forged database rows are rejected.
 * - Fails closed (denies) in headless / non-TUI contexts where interactive approval
 *   cannot be prompted.
 * - Exposes `/forget-approvals` to clear session and persistent grants.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { createLogger, type Logger } from "../shared/logger.js";
import { resolveEffectiveCwd, tokenize, unquotedSegments } from "./bash-policy.js";
import { loadGlobalSettings, loadProjectSettings, onSettingsWritten } from "./project-settings.js";
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
  /** True when the tool performs a recursive directory search (`grep` / `find`). */
  isRecursiveSearch?: boolean;
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
  /** Optional explicit HMAC key path override (defaults to `<homeDir>/.pi/agent/.approval-hmac-key`). */
  hmacKeyPath?: string;
  /** Optional environment map for resolving inherited shell variables in bash operands (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
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

// ── HMAC Authentication for Persistent SQLite Approvals ────────────────────

export const APPROVAL_HMAC_KEY_FILENAME = ".approval-hmac-key";

export function getApprovalHmacKeyPath(homeDir = homedir()): string {
  return join(homeDir, ".pi", "agent", APPROVAL_HMAC_KEY_FILENAME);
}

/** True when `rawPath` resolves to the approval HMAC key file (must never be read/written by agents). */
export function isProtectedApprovalKeyPath(
  rawPath: string,
  baseCwd: string,
  homeDir = homedir(),
): boolean {
  const keyPath = resolveCanonicalPath(getApprovalHmacKeyPath(homeDir), baseCwd, homeDir);
  const target = resolveCanonicalPath(rawPath, baseCwd, homeDir);
  if (target === keyPath) return true;
  // Also catch lexical path before symlink dereference.
  const expanded = expandHomePath(rawPath, homeDir);
  const lexical = stripTrailingSeparators(resolve(baseCwd, expanded));
  return lexical === stripTrailingSeparators(getApprovalHmacKeyPath(homeDir));
}

function readApprovalHmacKey(keyPath: string): Buffer | null {
  if (!existsSync(keyPath)) return null;
  try {
    const raw = readFileSync(keyPath, "utf-8").trim();
    if (!raw) return null;
    return Buffer.from(raw, "hex");
  } catch {
    return null;
  }
}

function loadOrCreateApprovalHmacKey(keyPath: string): Buffer {
  const existing = readApprovalHmacKey(keyPath);
  if (existing && existing.length >= 16) return existing;
  const key = randomBytes(32);
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  return key;
}

const APPROVAL_SIG_VERSION = "v2";

function resolveProjectDbIdentity(targetDb: string, cwd: string, homeDir = homedir()): string {
  return resolveCanonicalPath(targetDb, cwd, homeDir);
}

function computeApprovalSignature(
  key: Buffer,
  projectDbId: string,
  scope: ApprovalScope,
  targetPath: string,
  restrictedRoot: string,
): string {
  return createHmac("sha256", key)
    .update(`${APPROVAL_SIG_VERSION}\0${projectDbId}\0${scope}\0${targetPath}\0${restrictedRoot}`)
    .digest("hex");
}

function verifyApprovalSignature(
  key: Buffer,
  projectDbId: string,
  scope: ApprovalScope,
  targetPath: string,
  restrictedRoot: string,
  signature: string,
): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = computeApprovalSignature(key, projectDbId, scope, targetPath, restrictedRoot);
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Session Approval Store (strictly per non-empty sessionId, survives /reload) ──

const SESSION_APPROVALS_SYMBOL = Symbol.for("pi-config.restrictedFolderSessionApprovals.v1");

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

function normalizeSessionId(sessionId?: string | null): string | null {
  return typeof sessionId === "string" && sessionId.trim() !== "" ? sessionId.trim() : null;
}

function grantKey(scope: ApprovalScope, targetPath: string): string {
  return `${scope}\0${targetPath}`;
}

/**
 * Store a session-scoped approval. Returns `null` without storing when `sessionId`
 * is null/blank so ID-less contexts can never leak approvals across sessions.
 */
export function addSessionApproval(
  sessionId: string | null | undefined,
  scope: ApprovalScope,
  targetPath: string,
  restrictedRoot: string,
): RestrictedFolderApproval | null {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return null;
  const store = getSessionStore();
  let bucket = store.get(sid);
  if (!bucket) {
    bucket = new Map();
    store.set(sid, bucket);
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

/** List session approvals for `sessionId`. Always returns `[]` when `sessionId` is null/blank. */
export function listSessionApprovals(sessionId?: string | null): RestrictedFolderApproval[] {
  const sid = normalizeSessionId(sessionId);
  if (!sid) return [];
  const bucket = getSessionStore().get(sid);
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
  const sid = normalizeSessionId(sessionId);
  if (!sid) return 0;
  const bucket = store.get(sid);
  const count = bucket ? bucket.size : 0;
  store.delete(sid);
  return count;
}

// ── Persistent SQLite Approval Store (.pi/data/state.db, HMAC-authenticated) ──

export function addPersistentApproval(
  cwd: string,
  scope: ApprovalScope,
  targetPath: string,
  restrictedRoot: string,
  dbPath?: string,
  hmacKeyPath?: string,
  homeDir = homedir(),
): RestrictedFolderApproval {
  const targetDb = dbPath ?? getProjectStateDbPath(cwd);
  const projectDbId = resolveProjectDbIdentity(targetDb, cwd, homeDir);
  const keyPath = hmacKeyPath ?? getApprovalHmacKeyPath(homeDir);
  const key = loadOrCreateApprovalHmacKey(keyPath);
  const signature = computeApprovalSignature(key, projectDbId, scope, targetPath, restrictedRoot);
  const createdAt = new Date().toISOString();
  withTransaction(targetDb, (db) => {
    db.prepare(
      `INSERT INTO restricted_folder_approvals (scope, target_path, restricted_root, signature, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, target_path) DO UPDATE SET
         restricted_root = excluded.restricted_root,
         signature = excluded.signature,
         created_at = excluded.created_at`,
    ).run(scope, targetPath, restrictedRoot, signature, createdAt);
  });
  return {
    scope,
    targetPath,
    restrictedRoot,
    persistence: "persistent",
    createdAt,
  };
}

export function listPersistentApprovals(
  cwd: string,
  dbPath?: string,
  hmacKeyPath?: string,
  homeDir = homedir(),
  log: Logger = defaultLog,
): RestrictedFolderApproval[] {
  const keyPath = hmacKeyPath ?? getApprovalHmacKeyPath(homeDir);
  const key = readApprovalHmacKey(keyPath);
  const targetDb = dbPath ?? getProjectStateDbPath(cwd);
  const projectDbId = resolveProjectDbIdentity(targetDb, cwd, homeDir);
  const db = openStateDb(targetDb);
  const rows = db
    .prepare(
      "SELECT scope, target_path, restricted_root, signature, created_at FROM restricted_folder_approvals ORDER BY id ASC",
    )
    .all() as Array<{
    scope?: string;
    target_path?: string;
    restricted_root?: string;
    signature?: string;
    created_at?: string;
  }>;
  if (rows.length === 0) return [];
  if (!key) {
    log.warn("restricted_folder_approvals_missing_hmac_key", {
      rowCount: rows.length,
    });
    return [];
  }
  const out: RestrictedFolderApproval[] = [];
  for (const row of rows) {
    if (
      (row.scope === "file" || row.scope === "directory") &&
      typeof row.target_path === "string" &&
      typeof row.restricted_root === "string"
    ) {
      const sig = typeof row.signature === "string" ? row.signature : "";
      if (!verifyApprovalSignature(key, projectDbId, row.scope, row.target_path, row.restricted_root, sig)) {
        log.warn("restricted_folder_invalid_approval_signature", {
          scope: row.scope,
          targetPath: row.target_path,
        });
        continue;
      }
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

const UNICODE_SPACES_RE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function stripTrailingSeparators(p: string): string {
  let out = p;
  while (out.length > 1 && out.endsWith(sep)) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Normalize a tool path identically to Pi's `resolveToCwd`/`expandPath`:
 * replace Unicode space characters with ASCII spaces and strip a single leading `@`.
 */
export function normalizeToolPath(rawPath: string): string {
  let out = rawPath.trim().replace(UNICODE_SPACES_RE, " ");
  if (out.startsWith("@")) {
    out = out.slice(1);
  }
  return out;
}

/** Normalize tool syntax (`@`, unicode spaces) and expand leading `~` or `~/` to `homeDir`. */
export function expandHomePath(rawPath: string, homeDir = homedir()): string {
  const normalized = normalizeToolPath(rawPath);
  if (normalized === "~") return homeDir;
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return join(homeDir, normalized.slice(2));
  }
  return normalized;
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

/** Resolve `@`/unicode spaces/`~`, relative segments against `baseCwd`, and symlinked ancestors (including dangling symlinks). */
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

// ── Monotonic Restricted-Folders Floor (fail-closed against external shell tampering) ──

const RESTRICTED_FLOOR_SYMBOL = Symbol.for("pi-config.restrictedFoldersFloor.v1");

function getRestrictedFoldersFloor(): Map<string, Set<string>> {
  const g = globalThis as Record<symbol, Map<string, Set<string>> | undefined>;
  let map = g[RESTRICTED_FLOOR_SYMBOL];
  if (!map) {
    map = new Map();
    g[RESTRICTED_FLOOR_SYMBOL] = map;
  }
  return map;
}

/** Clear the monotonic restricted-folders floor (called on authorized human settings saves and test teardown). */
export function clearRestrictedFoldersFloor(cwd?: string): void {
  const floor = getRestrictedFoldersFloor();
  if (cwd === undefined) {
    floor.clear();
    return;
  }
  floor.delete(resolveCanonicalPath(cwd, cwd));
}

onSettingsWritten((event) => {
  // Only reset a floor when `restricted_folders` itself was updated via an authorized save.
  // Unrelated setting saves (e.g. `dco`, `image_model`) must never unpin restricted folders.
  if (event.changedKey !== "restricted_folders") return;
  if (event.scope === "global") {
    clearRestrictedFoldersFloor();
    return;
  }
  const projectCwd = event.cwd ?? dirname(dirname(event.filePath));
  clearRestrictedFoldersFloor(projectCwd);
});

/**
 * Union global and project `restricted_folders` AND enforce a monotonic per-project
 * floor captured across loads (only reset when settings are saved via the authorized
 * in-process settings API `writeSettingsFile`). Even if an external shell script
 * overwrites `.pi/pi-config-settings.json` to clear `restricted_folders`, previously
 * enforced folders remain active (fail closed).
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

  const floorKey = resolveCanonicalPath(cwd, cwd);
  const floorMap = getRestrictedFoldersFloor();
  let pinned = floorMap.get(floorKey);
  if (!pinned) {
    pinned = new Set<string>();
    floorMap.set(floorKey, pinned);
  }

  // Detect any external removal of a previously configured restricted folder.
  let restoredFromFloor = 0;
  for (const prev of pinned) {
    if (!seen.has(prev)) {
      seen.add(prev);
      combined.push(prev);
      restoredFromFloor++;
    }
  }
  if (restoredFromFloor > 0) {
    defaultLog.warn("restricted_folders_external_shrink_ignored", {
      cwd: floorKey,
      restoredCount: restoredFromFloor,
    });
  }
  for (const entry of combined) {
    pinned.add(entry);
  }

  return combined;
}

/** Split an absolute path into its root and individual path segments. */
function splitAbsPath(absPath: string): { root: string; segments: string[] } {
  const parsed = parse(absPath);
  const rest = absPath.slice(parsed.root.length);
  const segments = rest ? rest.split(sep).filter(Boolean) : [];
  return { root: parsed.root, segments };
}

/**
 * Check whether `rawTarget` enters or traverses any folder in `restrictedFolders`.
 * Resolves symlinks in BOTH directions and across EVERY traversed lexical prefix:
 * - Symlink outside pointing into a restricted folder (existing, non-existent child, or dangling)
 * - Symlink inside a restricted folder pointing outside, even when the requested path extends
 *   beneath that symlink (e.g. `/restricted/link/child` where `link -> /outside`)
 * - For recursive search tools (`isRecursiveSearch = true`), also matches when any restricted
 *   folder is a descendant beneath `rawTarget`.
 */
export function matchRestrictedFolder(
  rawTarget: string,
  baseCwd: string,
  restrictedFolders: readonly string[],
  isDirectoryHint = false,
  homeDir = homedir(),
  isRecursiveSearch = false,
): RestrictedFolderMatch | null {
  if (restrictedFolders.length === 0) return null;

  const expandedTarget = expandHomePath(rawTarget, homeDir);
  const lexicalAbs = resolve(baseCwd, expandedTarget);
  const canonicalTarget = stripTrailingSeparators(resolveRealPathWithDangling(lexicalAbs));
  const { root, segments } = splitAbsPath(lexicalAbs);

  // Precompute canonicalized restricted folders once.
  const canonicalFolders = restrictedFolders
    .filter((f) => typeof f === "string" && f.trim() !== "")
    .map((configured) => ({
      configured,
      canonical: resolveCanonicalPath(configured, baseCwd, homeDir),
    }));

  // 1. Canonical target inside a restricted folder (handles direct access + symlinks pointing IN).
  for (const { configured, canonical } of canonicalFolders) {
    if (isPathInsideFolder(canonicalTarget, canonical)) {
      return {
        rawTarget,
        canonicalTarget,
        restrictedRoot: canonical,
        configuredFolder: configured,
        isDirectoryHint,
        isRecursiveSearch,
      };
    }
  }

  // 2. Walk every lexical prefix component to catch paths traversing a symlink located INSIDE
  //    a restricted folder that points outside (e.g. `/restricted/link/child` -> `/outside/child`).
  let cursor = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const parentCanonical = stripTrailingSeparators(resolveRealPathWithDangling(cursor));
    const entryLexicalCanonical = stripTrailingSeparators(join(parentCanonical, seg));
    cursor = join(cursor, seg);
    const tail = segments.slice(i + 1);

    for (const { configured, canonical } of canonicalFolders) {
      if (isPathInsideFolder(entryLexicalCanonical, canonical)) {
        const preservedTarget =
          tail.length > 0
            ? stripTrailingSeparators(join(entryLexicalCanonical, ...tail))
            : entryLexicalCanonical;
        return {
          rawTarget,
          canonicalTarget: preservedTarget,
          restrictedRoot: canonical,
          configuredFolder: configured,
          isDirectoryHint,
          isRecursiveSearch,
        };
      }
    }
  }

  // 3. For recursive search tools (`grep`/`find`), also match if any restricted folder lies
  //    BENEATH the search root (including when omitted `path` defaults to `cwd`).
  if (isRecursiveSearch) {
    for (const { configured, canonical } of canonicalFolders) {
      if (isPathInsideFolder(canonical, canonicalTarget)) {
        return {
          rawTarget,
          canonicalTarget,
          restrictedRoot: canonical,
          configuredFolder: configured,
          isDirectoryHint: true,
          isRecursiveSearch: true,
        };
      }
    }
  }

  return null;
}

// ── Tool Target Extraction ─────────────────────────────────────────────────

export interface ExtractedTarget {
  path: string;
  isDirectoryHint: boolean;
  isRecursiveSearch?: boolean;
}

export interface UnresolvedBashTarget {
  kind: "cd" | "operand";
  raw: string;
  reason: string;
}

export interface ExtractedToolTargets {
  targets: ExtractedTarget[];
  unresolved: UnresolvedBashTarget[];
}

const CD_TARGET_RE = /(?:^|[\s;&|({])(?:cd|pushd)(?:\s+(?:--|-L|-P))*\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|()]+))/;
const DYNAMIC_EXPANSION_RE = /[$*?{`]/;
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const SHELL_OPERATORS = new Set(["|", "||", "&&", ";", "&", "(", ")", "{", "}", "!", "then", "do", "done", "fi", "else", "elif"]);

function stripOuterQuotes(s: string): string {
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function expandKnownVars(text: string, vars: Map<string, string>): string {
  if (vars.size === 0 || !text.includes("$")) return text;
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)\b/g, (m, a, b) => {
    const name = (a ?? b) as string;
    return vars.has(name) ? vars.get(name)! : m;
  });
}

function looksLikePathToken(token: string): boolean {
  if (!token || URL_SCHEME_RE.test(token)) return false;
  return (
    token.includes("/") ||
    token === "~" ||
    token.startsWith("~/") ||
    token.startsWith("@~") ||
    token === "." ||
    token === ".." ||
    token.startsWith("./") ||
    token.startsWith("../")
  );
}

const NESTED_SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const MAX_BASH_SCAN_DEPTH = 4;

/** Extract inner commands from `$(...)` and backtick substitutions outside single quotes. */
function extractCommandSubstitutions(script: string): string[] {
  const subs: string[] = [];
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (ch === "\\" && !inSingle && i + 1 < script.length) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) continue;

    // `$(...)` command substitution (excluding arithmetic `$((...))`)
    if (ch === "$" && script[i + 1] === "(" && script[i + 2] !== "(") {
      let depth = 1;
      let j = i + 2;
      let innerSingle = false;
      let innerDouble = false;
      while (j < script.length && depth > 0) {
        const c = script[j]!;
        if (c === "\\" && !innerSingle && j + 1 < script.length) {
          j += 2;
          continue;
        }
        if (c === "'" && !innerDouble) innerSingle = !innerSingle;
        else if (c === "\"" && !innerSingle) innerDouble = !innerDouble;
        else if (!innerSingle && !innerDouble) {
          if (c === "(") depth++;
          else if (c === ")") depth--;
        }
        j++;
      }
      if (depth === 0) {
        const body = script.slice(i + 2, j - 1).trim();
        if (body) subs.push(body);
        i = j - 1;
      }
      continue;
    }

    // Backtick substitution `` `...` ``
    if (ch === "`") {
      let j = i + 1;
      while (j < script.length) {
        if (script[j] === "\\" && j + 1 < script.length) {
          j += 2;
          continue;
        }
        if (script[j] === "`") break;
        j++;
      }
      if (j < script.length) {
        const body = script.slice(i + 1, j).trim();
        if (body) subs.push(body);
        i = j;
      }
    }
  }
  return subs;
}

/** Extract inline script bodies passed to `eval` or `sh`/`bash`/`zsh` `-c <script>`. */
function extractNestedShellBodies(tokens: string[]): string[] {
  const bodies: string[] = [];
  let cmdIdx = 0;
  while (cmdIdx < tokens.length) {
    const t = tokens[cmdIdx]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t === "env" || t === "command" || t === "exec" || t === "sudo") {
      cmdIdx++;
      continue;
    }
    break;
  }
  if (cmdIdx >= tokens.length) return bodies;
  const cmdWord = basename(stripOuterQuotes(tokens[cmdIdx]!)).toLowerCase();

  if (cmdWord === "eval") {
    const args: string[] = [];
    for (let i = cmdIdx + 1; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (args.length === 0 && tok === "--") continue;
      args.push(stripOuterQuotes(tok));
    }
    if (args.length > 0) bodies.push(args.join(" "));
    return bodies;
  }

  if (NESTED_SHELL_NAMES.has(cmdWord)) {
    for (let i = cmdIdx + 1; i < tokens.length - 1; i++) {
      if (/^-[a-zA-Z]*c$/.test(tokens[i]!)) {
        const body = stripOuterQuotes(tokens[i + 1]!);
        if (body) bodies.push(body);
      }
    }
  }
  return bodies;
}

function seedBashVars(
  sessionCwd: string,
  homeDir: string,
  env?: NodeJS.ProcessEnv,
): Map<string, string> {
  const vars = new Map<string, string>();
  const sourceEnv = env ?? process.env;
  for (const [k, v] of Object.entries(sourceEnv)) {
    if (typeof v === "string" && v.length > 0 && !DYNAMIC_EXPANSION_RE.test(v)) {
      vars.set(k, v);
    }
  }
  vars.set("HOME", homeDir);
  vars.set("PWD", sessionCwd);
  return vars;
}

function collectBashTargets(
  command: string,
  sessionCwd: string,
  homeDir: string,
  restrictedFolders: readonly string[],
  env?: NodeJS.ProcessEnv,
  parentVars?: Map<string, string>,
  depth = 0,
): ExtractedToolTargets {
  const dirSet = new Set<string>();
  const fileSet = new Set<string>();
  const unresolved: UnresolvedBashTarget[] = [];

  if (depth > MAX_BASH_SCAN_DEPTH) {
    unresolved.push({
      kind: "operand",
      raw: command.slice(0, 80),
      reason: "nested shell nesting depth exceeded static inspection limit",
    });
    return { targets: [], unresolved };
  }

  dirSet.add(sessionCwd);
  dirSet.add(resolveEffectiveCwd(command, sessionCwd));

  const running: string[] = [sessionCwd];
  const vars = parentVars ? new Map(parentVars) : seedBashVars(sessionCwd, homeDir, env);
  const dynamicVars = new Set<string>();

  const canonicalFolders = restrictedFolders
    .filter((f) => typeof f === "string" && f.trim() !== "")
    .map((f) => resolveCanonicalPath(f, sessionCwd, homeDir));

  for (const seg of unquotedSegments(command)) {
    if (running.length > seg.depth + 1) running.length = seg.depth + 1;
    while (running.length <= seg.depth) running.push(running[running.length - 1]!);

    const curCwd = running[seg.depth]!;
    const tokens = tokenize(seg.text);

    // Record leading variable assignments (e.g. `target=/secret` or `dir="$HOME/.ssh"`).
    for (const tok of tokens) {
      if (tok === "export" || tok === "local" || tok === "readonly" || tok === "declare") continue;
      const am = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok);
      if (!am) break;
      const varName = am[1]!;
      const rawVal = stripOuterQuotes(am[2]!);
      const val = expandKnownVars(rawVal, vars);
      if (!DYNAMIC_EXPANSION_RE.test(val)) {
        vars.set(varName, val);
        dynamicVars.delete(varName);
      } else {
        // Variable holds a dynamic value (e.g. command substitution) — forget any prior static value.
        vars.delete(varName);
        dynamicVars.add(varName);
      }
    }

    // 1. Track cd / pushd directory changes (flagging unresolved dynamic targets!).
    const cdMatch = CD_TARGET_RE.exec(seg.text);
    if (cdMatch) {
      const rawDest = cdMatch[1] ?? cdMatch[2] ?? cdMatch[3] ?? "";
      const expandedDest = expandKnownVars(rawDest, vars);
      if (expandedDest === "-") {
        unresolved.push({
          kind: "cd",
          raw: rawDest,
          reason: "cd - destination (OLDPWD) cannot be statically verified against restricted_folders",
        });
      } else if (DYNAMIC_EXPANSION_RE.test(expandedDest)) {
        unresolved.push({
          kind: "cd",
          raw: rawDest,
          reason: `dynamic cd/pushd target (${rawDest}) contains shell expansion and could enter a restricted folder`,
        });
      } else if (expandedDest) {
        const homeExpanded = expandHomePath(expandedDest, homeDir);
        const nextDir = resolve(curCwd, homeExpanded);
        dirSet.add(nextDir);
        if (!seg.backgrounded) {
          running[seg.depth] = nextDir;
        }
      }
    }

    const activeCwd = running[seg.depth]!;

    // 2. Recursively inspect command substitutions (`$(...)`, `` `...` ``) and nested shells (`bash -c`, `eval`).
    const innerScripts = [
      ...extractCommandSubstitutions(seg.text),
      ...extractNestedShellBodies(tokens),
    ];
    for (const inner of innerScripts) {
      const nestedRes = collectBashTargets(
        inner,
        activeCwd,
        homeDir,
        restrictedFolders,
        env,
        vars,
        depth + 1,
      );
      for (const t of nestedRes.targets) {
        if (t.isDirectoryHint) dirSet.add(t.path);
        else fileSet.add(t.path);
      }
      unresolved.push(...nestedRes.unresolved);
    }

    // 3. Scan path-like file operands & redirection targets in the segment.
    for (const rawTok of tokens) {
      if (!rawTok || SHELL_OPERATORS.has(rawTok)) continue;

      // Strip leading redirection operators (`>`, `>>`, `<`, `2>`, `>|`).
      const cleanedTok = rawTok.replace(/^[0-9]*[<>]+\|?/, "");
      if (!cleanedTok) continue;

      // Extract value part of `--flag=path` or `VAR=path` assignments.
      let candidate = cleanedTok;
      if (candidate.startsWith("-")) {
        const eq = candidate.indexOf("=");
        if (eq === -1) continue;
        candidate = candidate.slice(eq + 1);
      } else {
        const assign = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(candidate);
        if (assign) {
          candidate = assign[1]!;
        }
      }

      const unquoted = stripOuterQuotes(candidate);
      const varExpanded = expandKnownVars(unquoted, vars);
      if (!looksLikePathToken(varExpanded)) continue;

      if (DYNAMIC_EXPANSION_RE.test(varExpanded)) {
        // Check whether the static prefix before the first expansion character could reach a restricted folder.
        // If expansion begins at character 0 (e.g. `$UNKNOWN_DIR/file`), we cannot verify the root statically,
        // so fail closed by recording it as unresolved instead of silently skipping!
        const firstDyn = varExpanded.search(DYNAMIC_EXPANSION_RE);
        if (firstDyn === 0) {
          unresolved.push({
            kind: "operand",
            raw: unquoted,
            reason: `dynamic path operand (${unquoted}) starts with an unresolved shell expansion and could reach a restricted folder`,
          });
          continue;
        }
        const staticPrefix = varExpanded.slice(0, firstDyn);
        const prefixExpanded = expandHomePath(staticPrefix, homeDir);
        const prefixAbs = resolve(activeCwd, prefixExpanded);
        const prefixCanon = stripTrailingSeparators(resolveRealPathWithDangling(prefixAbs));
        const couldTouchRestricted = canonicalFolders.some(
          (rf) => isPathInsideFolder(prefixCanon, rf) || isPathInsideFolder(rf, prefixCanon),
        );
        if (couldTouchRestricted) {
          unresolved.push({
            kind: "operand",
            raw: unquoted,
            reason: `dynamic path operand (${unquoted}) could expand inside a restricted folder`,
          });
        }
        continue;
      }

      const resolvedOperand = resolve(activeCwd, expandHomePath(varExpanded, homeDir));
      fileSet.add(resolvedOperand);
    }
  }

  const targets: ExtractedTarget[] = [];
  for (const dir of dirSet) {
    targets.push({ path: dir, isDirectoryHint: true });
  }
  for (const file of fileSet) {
    if (!dirSet.has(file)) {
      targets.push({ path: file, isDirectoryHint: false });
    }
  }
  return { targets, unresolved };
}

function isExistingRegularFile(rawPath: string, cwd: string, homeDir: string): boolean {
  try {
    const canon = resolveCanonicalPath(rawPath, cwd, homeDir);
    return statSync(canon).isFile();
  } catch {
    return false;
  }
}

export function extractToolTargetPaths(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  homeDir = homedir(),
  restrictedFolders: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
): ExtractedTarget[] {
  return extractToolTargets(toolName, input, cwd, homeDir, restrictedFolders, env).targets;
}

export function extractToolTargets(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  homeDir = homedir(),
  restrictedFolders: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
): ExtractedToolTargets {
  switch (toolName) {
    case "read":
    case "write":
    case "edit": {
      const p = typeof input.path === "string" ? normalizeToolPath(input.path) : "";
      return {
        targets: p ? [{ path: p, isDirectoryHint: false }] : [],
        unresolved: [],
      };
    }
    case "ls": {
      const raw = typeof input.path === "string" ? normalizeToolPath(input.path) : "";
      const p = raw !== "" ? raw : cwd;
      return {
        targets: [{ path: p, isDirectoryHint: true }],
        unresolved: [],
      };
    }
    case "grep":
    case "find": {
      const raw = typeof input.path === "string" ? normalizeToolPath(input.path) : "";
      const p = raw !== "" ? raw : cwd;
      // grep on a single existing file is NOT a recursive directory search.
      const singleFile = toolName === "grep" && isExistingRegularFile(p, cwd, homeDir);
      return {
        targets: [
          {
            path: p,
            isDirectoryHint: !singleFile,
            isRecursiveSearch: !singleFile,
          },
        ],
        unresolved: [],
      };
    }
    case "bash": {
      const command = typeof input.command === "string" ? input.command : "";
      return collectBashTargets(command, cwd, homeDir, restrictedFolders, env);
    }
    default:
      return { targets: [], unresolved: [] };
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
  hmacKeyPath?: string,
  homeDir = homedir(),
  log: Logger = defaultLog,
): RestrictedFolderApproval | null {
  // 1. Check session-scoped approvals in memory (only for valid non-empty sessionId).
  for (const grant of listSessionApprovals(sessionId)) {
    if (grantCoversPath(grant, canonicalTarget)) return grant;
  }

  // 2. Check HMAC-authenticated persistent SQLite approvals.
  try {
    for (const grant of listPersistentApprovals(cwd, dbPath, hmacKeyPath, homeDir, log)) {
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

  const { targets, unresolved } = extractToolTargets(
    params.toolName,
    params.input,
    params.cwd,
    home,
    folders,
    params.env,
  );

  // Always protect the approval signing key even when no restricted_folders are configured.
  for (const t of targets) {
    if (isProtectedApprovalKeyPath(t.path, params.cwd, home)) {
      log.warn("approval_hmac_key_access_blocked", { toolName: params.toolName });
      return {
        block: true,
        reason:
          "⛔ Direct access to .approval-hmac-key is blocked. Approval integrity keys are managed exclusively by the enforcement system.",
      };
    }
  }

  if (folders.length === 0) return undefined;

  // 1. Handle unresolved dynamic bash cd/pushd or restricted-prefix path expansions first.
  //    These can NEVER be satisfied by a cached grant — fail closed when headless or prompt Approve Once / Deny.
  if (unresolved.length > 0) {
    const first = unresolved[0]!;
    if (!params.ui) {
      log.warn("restricted_folder_unresolved_bash_denied_headless", {
        toolName: params.toolName,
        raw: first.raw,
        kind: first.kind,
      });
      return {
        block: true,
        reason: `⛔ Unresolved bash path (${first.raw}) blocked while restricted_folders are configured: ${first.reason}. Explicit interactive approval is required (denied in headless/non-TUI mode).`,
      };
    }

    const title = [
      `🔒 Unresolved bash target with restricted_folders active (${params.toolName})`,
      `Target: ${first.raw}`,
      `Reason: ${first.reason}`,
    ].join("\n");

    let choice: string | undefined;
    try {
      choice = await params.ui.select(title, [CHOICE_DENY, CHOICE_APPROVE_ONCE]);
    } catch (err) {
      log.warn("restricted_folder_unresolved_prompt_failed", { toolName: params.toolName }, err);
      choice = undefined;
    }

    if (choice !== CHOICE_APPROVE_ONCE) {
      return {
        block: true,
        reason: `⛔ Unresolved bash target (${first.raw}) denied by user while restricted_folders are configured.`,
      };
    }
  }

  if (targets.length === 0) return undefined;

  const sessionAvailable = normalizeSessionId(params.sessionId) !== null;
  const seenKey = new Set<string>();

  for (const target of targets) {
    const match = matchRestrictedFolder(
      target.path,
      params.cwd,
      folders,
      target.isDirectoryHint,
      home,
      target.isRecursiveSearch === true,
    );
    if (!match) continue;
    const dedupKey = `${match.canonicalTarget}\0${match.restrictedRoot}\0${match.isRecursiveSearch ? "R" : "D"}`;
    if (seenKey.has(dedupKey)) continue;
    seenKey.add(dedupKey);

    // Recursive `grep`/`find` over a directory can traverse grandchildren and restricted
    // descendants — NEVER authorize it with a cached direct-children-only directory grant!
    if (!match.isRecursiveSearch) {
      const existing = findMatchingApproval(
        match.canonicalTarget,
        params.cwd,
        params.sessionId,
        params.dbPath,
        params.hmacKeyPath,
        home,
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
    }

    // Fail closed in headless / non-TUI contexts where interactive approval cannot be prompted.
    if (!params.ui) {
      log.warn("restricted_folder_access_denied_headless", {
        toolName: params.toolName,
        target: match.canonicalTarget,
        restrictedRoot: match.restrictedRoot,
        recursive: match.isRecursiveSearch === true,
      });
      return {
        block: true,
        reason: match.isRecursiveSearch
          ? `⛔ Recursive ${params.toolName} search (${match.canonicalTarget}) reaches restricted folder (${match.restrictedRoot}): explicit interactive approval is required (denied in headless/non-TUI mode).`
          : `⛔ Access to restricted folder (${match.restrictedRoot}) blocked for ${params.toolName} (${match.canonicalTarget}): explicit interactive approval is required (denied in headless/non-TUI mode).`,
      };
    }

    const targetIsDir = match.isDirectoryHint || isExistingDirectory(match.canonicalTarget);
    const grantDir = resolveGrantDirectory(match, targetIsDir);

    let options: string[];
    let title: string;

    if (match.isRecursiveSearch) {
      // Recursive search requires explicit one-time approval — one-level directory grants do not cover it.
      options = [CHOICE_DENY, CHOICE_APPROVE_ONCE];
      title = [
        `🔒 Restricted folder recursive search (${params.toolName}) — searches all subdirectories`,
        `Search root: ${match.canonicalTarget}`,
        `Restricted folder affected: ${match.restrictedRoot}`,
      ].join("\n");
    } else if (targetIsDir) {
      options = [
        CHOICE_DENY,
        CHOICE_APPROVE_ONCE,
        ...(sessionAvailable ? [CHOICE_APPROVE_DIR_SESSION] : []),
        CHOICE_APPROVE_DIR_PERSISTENT,
      ];
      title = [
        `🔒 Restricted folder access (${params.toolName})`,
        `Target: ${match.canonicalTarget}`,
        `Restricted folder: ${match.restrictedRoot}`,
        `Directory grant scope (if selected): ${grantDir} (direct children only)`,
      ].join("\n");
    } else {
      options = [
        CHOICE_DENY,
        CHOICE_APPROVE_ONCE,
        ...(sessionAvailable ? [CHOICE_APPROVE_FILE_SESSION] : []),
        CHOICE_APPROVE_FILE_PERSISTENT,
        ...(sessionAvailable ? [CHOICE_APPROVE_DIR_SESSION] : []),
        CHOICE_APPROVE_DIR_PERSISTENT,
      ];
      title = [
        `🔒 Restricted folder access (${params.toolName})`,
        `Target: ${match.canonicalTarget}`,
        `Restricted folder: ${match.restrictedRoot}`,
        `Directory grant scope (if selected): ${grantDir} (direct children only)`,
      ].join("\n");
    }

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
        if (!sessionAvailable) {
          log.warn("restricted_folder_session_approval_refused_no_session_id", {
            target: match.canonicalTarget,
          });
        } else {
          addSessionApproval(params.sessionId, "file", match.canonicalTarget, match.restrictedRoot);
          log.info("restricted_folder_approved_file_session", {
            target: match.canonicalTarget,
          });
        }
        break;

      case CHOICE_APPROVE_FILE_PERSISTENT:
        try {
          addPersistentApproval(
            params.cwd,
            "file",
            match.canonicalTarget,
            match.restrictedRoot,
            params.dbPath,
            params.hmacKeyPath,
            home,
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
        if (!sessionAvailable) {
          log.warn("restricted_folder_session_approval_refused_no_session_id", {
            grantDir,
          });
        } else {
          addSessionApproval(params.sessionId, "directory", grantDir, match.restrictedRoot);
          log.info("restricted_folder_approved_dir_session", {
            grantDir,
          });
        }
        break;

      case CHOICE_APPROVE_DIR_PERSISTENT:
        try {
          addPersistentApproval(
            params.cwd,
            "directory",
            grantDir,
            match.restrictedRoot,
            params.dbPath,
            params.hmacKeyPath,
            home,
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
