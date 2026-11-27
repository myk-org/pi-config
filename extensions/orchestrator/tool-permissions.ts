/**
 * Declarative tool permission rules & domain-scoped `fetch_content` approvals (issue #1450).
 *
 * Evaluates user/project `tool_permissions` rules with last-match-wins glob matching:
 * - Empty/unset `tool_permissions: {}` is a fast no-op (zero behavior change).
 * - Runs AFTER built-in hard security blocks (`restricted_folders`, `bash-policy`,
 *   `.pi/pi-config-settings.json` edit protection, `.approval-hmac-key` / `state.db` guards)
 *   so user rules can never weaken built-in security invariants.
 * - Supports top-level tool globs (`*`, `?`), Pi 1.6 tool `annotations` selectors
 *   (`annotation:destructive`, `annotation:openWorld`, `annotation:readOnly`,
 *   `annotation:idempotent`, plus short aliases `destructive` / `openWorld`), and nested
 *   per-host rule maps (e.g. `fetch_content: { "*": "ask", "github.com": "allow", "*.redhat.com": "allow" }`).
 * - Validates EVERY URL in `input.url` and `input.urls[]`, failing closed on malformed/unparseable
 *   URLs or non-HTTP(S) schemes when a non-allow rule applies.
 * - Interactive `ask` prompts for host-scoped tools offer `Allow Once`, `Always Allow <hostname>`
 *   (strictly scoped to that exact normalized hostname — never wildcard `*`, HMAC-SHA256
 *   authenticated in `.pi/data/state.db`, and cleared by `/forget-approvals`), and `Deny`.
 * - Fails closed in headless / non-UI sessions (`!ui`) on any ungranted `ask` rule.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import { createLogger, type Logger } from "../shared/logger.js";
import { projectSettingsTrust } from "./bash-policy.js";
import {
  getCachedSettingsLayers,
  type ToolPermissionAction,
  type ToolPermissionRuleValue,
  type ToolPermissions,
} from "./project-settings.js";
import {
  getApprovalHmacKeyPath,
  loadOrCreateApprovalHmacKey,
  readApprovalHmacKey,
  resolveCanonicalPath,
} from "./restricted-folders.js";
import { getProjectStateDbPath, openStateDb, withTransaction } from "./state-db.js";

const defaultLog = createLogger("tool-permissions");

export type { ToolPermissionAction, ToolPermissionRuleValue, ToolPermissions };

export interface ToolPermissionPromptUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify?(message: string, level: "info" | "warning" | "error"): Promise<void> | void;
}

export interface PersistentHostApproval {
  toolName: string;
  hostname: string;
  createdAt: string;
}

export interface EvaluateToolPermissionsInput {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  annotations?: ToolAnnotations;
  ui?: ToolPermissionPromptUi | null;
  /** Optional explicit rules override (for tests; defaults to global + project settings). */
  rules?: ToolPermissions;
  /** Optional explicit SQLite DB path override (defaults to `getProjectStateDbPath(cwd)`). */
  dbPath?: string;
  /** Optional explicit HMAC key path override (defaults to `getApprovalHmacKeyPath(homeDir)`). */
  hmacKeyPath?: string;
  homeDir?: string;
  log?: Logger;
}

export type ToolPermissionDecision = { block: true; reason: string } | undefined;

// ── Choice Labels ──────────────────────────────────────────────────────────

export const CHOICE_ALLOW_ONCE = "Allow Once";
export const CHOICE_DENY = "Deny";

export function alwaysAllowHostChoice(hostname: string): string {
  return `Always Allow ${hostname}`;
}

// ── Glob & Selector Matching ───────────────────────────────────────────────

/**
 * Convert a glob pattern (`*` = 0+ chars, `?` = 1 char, backslash-escaped literals)
 * into an anchored RegExp.
 */
export function globToRegExp(pattern: string, caseInsensitive = false): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      i++;
      out += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out, caseInsensitive ? "i" : "");
}

export function matchGlob(pattern: string, value: string, caseInsensitive = false): boolean {
  return globToRegExp(pattern, caseInsensitive).test(value);
}

type AnnotationKind = "destructive" | "openWorld" | "readOnly" | "idempotent";

function parseAnnotationSelector(selector: string): { kind: AnnotationKind; explicit: boolean } | null {
  const lower = selector.trim().toLowerCase();
  const explicit = lower.startsWith("annotation:");
  const raw = explicit ? lower.slice("annotation:".length).trim() : lower;
  switch (raw) {
    case "destructive":
    case "destructivehint":
      return { kind: "destructive", explicit };
    case "openworld":
    case "openworldhint":
    case "open_world":
      return { kind: "openWorld", explicit };
    case "readonly":
    case "readonlyhint":
    case "read_only":
      return { kind: "readOnly", explicit };
    case "idempotent":
    case "idempotenthint":
      return { kind: "idempotent", explicit };
    default:
      return null;
  }
}

export function matchesAnnotation(kind: AnnotationKind, annotations?: ToolAnnotations): boolean {
  if (!annotations) return false;
  switch (kind) {
    case "destructive":
      // Per MCP ToolAnnotations spec, destructiveHint is meaningful when not read-only.
      return annotations.destructiveHint === true && annotations.readOnlyHint !== true;
    case "openWorld":
      return annotations.openWorldHint === true;
    case "readOnly":
      return annotations.readOnlyHint === true;
    case "idempotent":
      return annotations.idempotentHint === true;
  }
}

export function matchesToolSelector(
  selector: string,
  toolName: string,
  annotations?: ToolAnnotations,
): boolean {
  const ann = parseAnnotationSelector(selector);
  if (ann) {
    if (matchesAnnotation(ann.kind, annotations)) return true;
    if (ann.explicit) return false;
  }
  return matchGlob(selector, toolName, false);
}

// ── URL / Hostname Extraction & Validation ─────────────────────────────────

export function isValidExactHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  if (/[*?\s/\\]/.test(hostname)) return false;
  return true;
}

export function normalizeUrlHostname(
  rawUrl: string,
): { ok: true; hostname: string } | { ok: false; reason: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: false, reason: "empty URL" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `malformed URL "${trimmed.slice(0, 80)}"` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported URL scheme "${parsed.protocol}"` };
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!isValidExactHostname(hostname)) {
    return { ok: false, reason: `invalid hostname in URL "${trimmed.slice(0, 80)}"` };
  }
  return { ok: true, hostname };
}

/**
 * Extract and validate ALL target hostnames from `input.url` and `input.urls[]`.
 * Fails closed if any provided URL is malformed, empty, non-HTTP(S), or if no URL is present.
 */
export function extractTargetHosts(
  input: Record<string, unknown>,
): { ok: true; hosts: string[] } | { ok: false; reason: string } {
  const rawUrls: string[] = [];

  if (input.url !== undefined) {
    if (typeof input.url !== "string" || input.url.trim() === "") {
      return { ok: false, reason: "input.url must be a non-empty URL string" };
    }
    rawUrls.push(input.url);
  }

  if (input.urls !== undefined) {
    if (!Array.isArray(input.urls)) {
      return { ok: false, reason: "input.urls must be an array of URL strings" };
    }
    for (let i = 0; i < input.urls.length; i++) {
      const item = input.urls[i];
      if (typeof item !== "string" || item.trim() === "") {
        return { ok: false, reason: `input.urls[${i}] must be a non-empty URL string` };
      }
      rawUrls.push(item);
    }
  }

  if (rawUrls.length === 0) {
    return { ok: false, reason: "no target URL provided" };
  }

  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const rawUrl of rawUrls) {
    const parsed = normalizeUrlHostname(rawUrl);
    if (!parsed.ok) return parsed;
    if (!seen.has(parsed.hostname)) {
      seen.add(parsed.hostname);
      hosts.push(parsed.hostname);
    }
  }
  return { ok: true, hosts };
}

// ── HMAC-Authenticated SQLite Host Approval Store ──────────────────────────

const HOST_APPROVAL_SIG_VERSION = "tool-host-v1";

function resolveProjectDbIdentity(targetDb: string, cwd: string, homeDir = homedir()): string {
  return resolveCanonicalPath(targetDb, cwd, homeDir);
}

function computeHostApprovalSignature(
  key: Buffer,
  projectDbId: string,
  toolName: string,
  hostname: string,
): string {
  return createHmac("sha256", key)
    .update(`${HOST_APPROVAL_SIG_VERSION}\0${projectDbId}\0${toolName}\0${hostname}`)
    .digest("hex");
}

function verifyHostApprovalSignature(
  key: Buffer,
  projectDbId: string,
  toolName: string,
  hostname: string,
  signature: string,
): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = computeHostApprovalSignature(key, projectDbId, toolName, hostname);
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Persist an HMAC-SHA256 authenticated host approval scoped strictly to one exact
 * normalized hostname (never wildcard `*` or glob patterns).
 */
export function addPersistentHostApproval(
  cwd: string,
  toolName: string,
  hostname: string,
  dbPath?: string,
  hmacKeyPath?: string,
  homeDir = homedir(),
  log: Logger = defaultLog,
): PersistentHostApproval {
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!isValidExactHostname(normalizedHost)) {
    throw new Error(`Refusing to persist non-exact or wildcard hostname: "${hostname}"`);
  }
  const targetDb = dbPath ?? getProjectStateDbPath(cwd);
  const projectDbId = resolveProjectDbIdentity(targetDb, cwd, homeDir);
  const keyPath = hmacKeyPath ?? getApprovalHmacKeyPath(homeDir);
  const key = loadOrCreateApprovalHmacKey(keyPath);
  const signature = computeHostApprovalSignature(key, projectDbId, toolName, normalizedHost);
  const createdAt = new Date().toISOString();

  withTransaction(targetDb, (db) => {
    db.prepare(
      `INSERT INTO tool_host_approvals (tool_name, hostname, signature, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tool_name, hostname) DO UPDATE SET
         signature = excluded.signature,
         created_at = excluded.created_at`,
    ).run(toolName, normalizedHost, signature, createdAt);
  });

  log.info("tool_host_approval_persisted", { toolName, hostname: normalizedHost });
  return { toolName, hostname: normalizedHost, createdAt };
}

/** List all HMAC-verified persistent host approvals for this project DB. */
export function listPersistentHostApprovals(
  cwd: string,
  dbPath?: string,
  hmacKeyPath?: string,
  homeDir = homedir(),
  log: Logger = defaultLog,
): PersistentHostApproval[] {
  const keyPath = hmacKeyPath ?? getApprovalHmacKeyPath(homeDir);
  const key = readApprovalHmacKey(keyPath);
  const targetDb = dbPath ?? getProjectStateDbPath(cwd);
  const projectDbId = resolveProjectDbIdentity(targetDb, cwd, homeDir);
  const db = openStateDb(targetDb);
  const rows = db
    .prepare(
      "SELECT tool_name, hostname, signature, created_at FROM tool_host_approvals ORDER BY id ASC",
    )
    .all() as Array<{
    tool_name?: string;
    hostname?: string;
    signature?: string;
    created_at?: string;
  }>;

  if (rows.length === 0) return [];
  if (!key) {
    log.warn("tool_host_approvals_missing_hmac_key", { rowCount: rows.length });
    return [];
  }

  const out: PersistentHostApproval[] = [];
  for (const row of rows) {
    if (typeof row.tool_name !== "string" || typeof row.hostname !== "string") continue;
    if (!isValidExactHostname(row.hostname)) {
      log.warn("tool_host_approval_invalid_hostname_rejected", {
        toolName: row.tool_name,
        hostname: row.hostname,
      });
      continue;
    }
    const sig = typeof row.signature === "string" ? row.signature : "";
    if (!verifyHostApprovalSignature(key, projectDbId, row.tool_name, row.hostname, sig)) {
      log.warn("tool_host_approval_invalid_signature", {
        toolName: row.tool_name,
        hostname: row.hostname,
      });
      continue;
    }
    out.push({
      toolName: row.tool_name,
      hostname: row.hostname,
      createdAt: typeof row.created_at === "string" ? row.created_at : "",
    });
  }
  return out;
}

export function hasPersistentHostApproval(
  cwd: string,
  toolName: string,
  hostname: string,
  dbPath?: string,
  hmacKeyPath?: string,
  homeDir = homedir(),
  log: Logger = defaultLog,
): boolean {
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!isValidExactHostname(normalizedHost)) return false;
  const grants = listPersistentHostApprovals(cwd, dbPath, hmacKeyPath, homeDir, log);
  return grants.some((g) => g.toolName === toolName && g.hostname === normalizedHost);
}

export function clearPersistentHostApprovals(cwd: string, dbPath?: string): number {
  const targetDb = dbPath ?? getProjectStateDbPath(cwd);
  return withTransaction(targetDb, (db) => {
    const info = db.prepare("DELETE FROM tool_host_approvals").run();
    return Number(info.changes ?? 0);
  });
}

export interface ForgetToolHostApprovalsResult {
  persistentCleared: number;
  failed: boolean;
  error?: string;
}

/** Clear persistent host approvals (invoked by `/forget-approvals`). */
export function forgetToolHostApprovals(
  cwd: string,
  mode: "all" | "session" | "persistent" = "all",
  dbPath?: string,
  log: Logger = defaultLog,
): ForgetToolHostApprovalsResult {
  if (mode === "session") return { persistentCleared: 0, failed: false };
  try {
    const persistentCleared = clearPersistentHostApprovals(cwd, dbPath);
    if (persistentCleared > 0) {
      log.info("tool_host_approvals_forgotten", { mode, persistentCleared });
    }
    return { persistentCleared, failed: false };
  } catch (err) {
    log.error("tool_host_approvals_clear_failed", { cwd }, err);
    return {
      persistentCleared: 0,
      failed: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Rule Layer Loading & Last-Match-Wins Evaluation ────────────────────────

export interface ToolPermissionLayer {
  rules: ToolPermissions;
  /** False for git-tracked or symlinked project settings: may tighten (`deny` > `ask`), never weaken. */
  trusted: boolean;
}

const ACTION_STRICTNESS: Record<ToolPermissionAction, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function stripAllowFromUntrustedRules(rules: ToolPermissions): { filtered: ToolPermissions; strippedCount: number } {
  const filtered: ToolPermissions = {};
  let strippedCount = 0;
  for (const [selector, val] of Object.entries(rules)) {
    if (typeof val === "string") {
      if (val === "allow") {
        strippedCount++;
      } else {
        filtered[selector] = val;
      }
    } else {
      const nested: Record<string, ToolPermissionAction> = {};
      for (const [pattern, action] of Object.entries(val)) {
        if (action === "allow") {
          strippedCount++;
        } else {
          nested[pattern] = action;
        }
      }
      if (Object.keys(nested).length > 0) {
        filtered[selector] = nested;
      }
    }
  }
  return { filtered, strippedCount };
}

/**
 * Load ordered `tool_permissions` rule layers (global first, then project) through the
 * coordinated settings cache (zero redundant disk I/O on hot tool calls).
 * If the project settings file is git-tracked or symlinked (untrusted), `"allow"` entries
 * are stripped and the layer is marked `trusted: false` so it can never weaken a global
 * `deny` (e.g. downgrading `deny` to `ask`) or grant `allow`.
 */
export function loadToolPermissionLayers(cwd: string, log: Logger = defaultLog): ToolPermissionLayer[] {
  const { global: globalSettings, project: projectSettings } = getCachedSettingsLayers(cwd, {
    verifyFresh: true,
  });
  const layers: ToolPermissionLayer[] = [];
  const globalRules = globalSettings.tool_permissions;
  if (globalRules && Object.keys(globalRules).length > 0) {
    layers.push({ rules: globalRules, trusted: true });
  }

  const projectRules = projectSettings.tool_permissions;
  if (projectRules && Object.keys(projectRules).length > 0) {
    const trust = projectSettingsTrust(cwd);
    if (trust === "untracked") {
      layers.push({ rules: projectRules, trusted: true });
    } else {
      const { filtered, strippedCount } = stripAllowFromUntrustedRules(projectRules);
      if (strippedCount > 0) {
        log.warn("tool_permissions_untrusted_project_allow_ignored", {
          trust,
          strippedCount,
        });
      }
      if (Object.keys(filtered).length > 0) {
        layers.push({ rules: filtered, trusted: false });
      }
    }
  }
  return layers;
}

export interface ResolvedPermissionAction {
  action: ToolPermissionAction;
  matchedRule: string;
}

function normalizeLayer(layer: ToolPermissions | ToolPermissionLayer): ToolPermissionLayer {
  if ("rules" in layer && typeof (layer as ToolPermissionLayer).trusted === "boolean") {
    return layer as ToolPermissionLayer;
  }
  return { rules: layer as ToolPermissions, trusted: true };
}

/**
 * Evaluate ordered rule layers using strict **last-match-wins** semantics.
 * Untrusted layers (`trusted: false`) may only tighten (never weaken) an earlier
 * decision (`deny` > `ask` > `allow`) and can never yield `"allow"`.
 * Pass `hostname` when evaluating a URL-scoped host target.
 */
export function resolvePermissionAction(
  layers: readonly (ToolPermissions | ToolPermissionLayer)[],
  toolName: string,
  annotations?: ToolAnnotations,
  hostname?: string,
): ResolvedPermissionAction | null {
  let resolved: ResolvedPermissionAction | null = null;
  const applyCandidate = (
    candidate: ToolPermissionAction,
    matchedRule: string,
    trusted: boolean,
  ): void => {
    if (!trusted) {
      if (candidate === "allow") return;
      if (resolved && ACTION_STRICTNESS[candidate] < ACTION_STRICTNESS[resolved.action]) {
        return;
      }
    }
    resolved = { action: candidate, matchedRule };
  };

  for (const rawLayer of layers) {
    const { rules, trusted } = normalizeLayer(rawLayer);
    for (const [selector, ruleValue] of Object.entries(rules)) {
      if (!matchesToolSelector(selector, toolName, annotations)) continue;
      if (typeof ruleValue === "string") {
        applyCandidate(ruleValue, selector, trusted);
      } else if (hostname !== undefined) {
        for (const [hostPattern, hostAction] of Object.entries(ruleValue)) {
          if (matchGlob(hostPattern, hostname, true)) {
            applyCandidate(hostAction, `${selector}[${hostPattern}]`, trusted);
          }
        }
      }
    }
  }
  return resolved;
}

function inspectMatchingRules(
  layers: readonly ToolPermissionLayer[],
  toolName: string,
  annotations?: ToolAnnotations,
): { matchedAny: boolean; hasHostMap: boolean; hasNonAllow: boolean } {
  let matchedAny = false;
  let hasHostMap = false;
  let hasNonAllow = false;

  for (const { rules } of layers) {
    for (const [selector, ruleValue] of Object.entries(rules)) {
      if (!matchesToolSelector(selector, toolName, annotations)) continue;
      matchedAny = true;
      if (typeof ruleValue === "string") {
        if (ruleValue !== "allow") hasNonAllow = true;
      } else {
        hasHostMap = true;
        for (const action of Object.values(ruleValue)) {
          if (action !== "allow") hasNonAllow = true;
        }
      }
    }
  }
  return { matchedAny, hasHostMap, hasNonAllow };
}

// ── Main Gate Evaluator ────────────────────────────────────────────────────

export async function evaluateToolPermissions(
  params: EvaluateToolPermissionsInput,
): Promise<ToolPermissionDecision> {
  const log = params.log ?? defaultLog;
  const layers: ToolPermissionLayer[] =
    params.rules !== undefined
      ? (Object.keys(params.rules).length > 0 ? [{ rules: params.rules, trusted: true }] : [])
      : loadToolPermissionLayers(params.cwd, log);

  // Fast path: empty/unset `tool_permissions` preserves 100% existing behavior.
  if (layers.length === 0) return undefined;

  const { matchedAny, hasHostMap, hasNonAllow } = inspectMatchingRules(
    layers,
    params.toolName,
    params.annotations,
  );
  if (!matchedAny) return undefined;

  const isUrlScoped = hasHostMap || (params.toolName === "fetch_content" && hasNonAllow);

  if (!isUrlScoped) {
    const resolved = resolvePermissionAction(layers, params.toolName, params.annotations);
    if (!resolved || resolved.action === "allow") return undefined;

    if (resolved.action === "deny") {
      log.info("tool_permission_denied", {
        toolName: params.toolName,
        matchedRule: resolved.matchedRule,
      });
      return {
        block: true,
        reason: `⛔ Tool "${params.toolName}" is denied by tool_permissions rule "${resolved.matchedRule}".`,
      };
    }

    // action === "ask"
    if (!params.ui) {
      log.info("tool_permission_headless_denied", {
        toolName: params.toolName,
        matchedRule: resolved.matchedRule,
      });
      return {
        block: true,
        reason: `⛔ Tool "${params.toolName}" requires interactive approval (matched "${resolved.matchedRule}"), denied in headless/non-UI session.`,
      };
    }

    const choice = await params.ui.select(
      `🔒 Allow tool "${params.toolName}"? (matched "${resolved.matchedRule}")`,
      [CHOICE_ALLOW_ONCE, CHOICE_DENY],
    );
    if (choice === CHOICE_ALLOW_ONCE) {
      log.info("tool_permission_allowed_once", {
        toolName: params.toolName,
        matchedRule: resolved.matchedRule,
      });
      return undefined;
    }

    log.info("tool_permission_user_denied", {
      toolName: params.toolName,
      matchedRule: resolved.matchedRule,
    });
    return {
      block: true,
      reason: `⛔ Tool "${params.toolName}" was denied by user (rule "${resolved.matchedRule}").`,
    };
  }

  // Host-scoped URL evaluation (e.g. `fetch_content` or any tool with nested host rules).
  if (!hasNonAllow) return undefined;

  const extracted = extractTargetHosts(params.input);
  if (!extracted.ok) {
    log.warn("tool_permission_invalid_url_blocked", {
      toolName: params.toolName,
      reason: extracted.reason,
    });
    return {
      block: true,
      reason: `⛔ Tool "${params.toolName}" blocked by tool_permissions (fail-closed): ${extracted.reason}.`,
    };
  }

  const hostsNeedingApproval: Array<{ host: string; matchedRule: string }> = [];
  for (const host of extracted.hosts) {
    const resolved = resolvePermissionAction(layers, params.toolName, params.annotations, host);
    log.debug("tool_permission_host_evaluated", {
      toolName: params.toolName,
      host,
      action: resolved?.action ?? "default-allow",
      matchedRule: resolved?.matchedRule ?? null,
    });

    if (!resolved || resolved.action === "allow") continue;

    if (resolved.action === "deny") {
      log.info("tool_permission_host_denied", {
        toolName: params.toolName,
        host,
        matchedRule: resolved.matchedRule,
      });
      return {
        block: true,
        reason: `⛔ Tool "${params.toolName}" access to host "${host}" is denied by tool_permissions rule "${resolved.matchedRule}".`,
      };
    }

    // resolved.action === "ask"
    if (
      hasPersistentHostApproval(
        params.cwd,
        params.toolName,
        host,
        params.dbPath,
        params.hmacKeyPath,
        params.homeDir,
        log,
      )
    ) {
      log.debug("tool_permission_host_grant_hit", { toolName: params.toolName, host });
      continue;
    }
    hostsNeedingApproval.push({ host, matchedRule: resolved.matchedRule });
  }

  if (hostsNeedingApproval.length === 0) return undefined;

  if (!params.ui) {
    const pendingHosts = hostsNeedingApproval.map((h) => h.host).join(", ");
    log.info("tool_permission_host_headless_denied", {
      toolName: params.toolName,
      hosts: pendingHosts,
    });
    return {
      block: true,
      reason: `⛔ Tool "${params.toolName}" access to host(s) [${pendingHosts}] requires interactive approval, denied in headless/non-UI session.`,
    };
  }

  for (const { host, matchedRule } of hostsNeedingApproval) {
    const alwaysChoice = alwaysAllowHostChoice(host);
    const choice = await params.ui.select(
      `🔒 Allow "${params.toolName}" to access host "${host}"? (rule "${matchedRule}")`,
      [CHOICE_ALLOW_ONCE, alwaysChoice, CHOICE_DENY],
    );

    if (choice === CHOICE_ALLOW_ONCE) {
      log.info("tool_permission_host_allowed_once", { toolName: params.toolName, host });
      continue;
    }

    if (choice === alwaysChoice) {
      try {
        addPersistentHostApproval(
          params.cwd,
          params.toolName,
          host,
          params.dbPath,
          params.hmacKeyPath,
          params.homeDir,
          log,
        );
      } catch (err) {
        log.warn("tool_permission_host_persist_failed", { toolName: params.toolName, host }, err);
        await params.ui.notify?.(
          `⚠️ Could not persist approval for host "${host}" — treating as Allow Once.`,
          "warning",
        );
      }
      continue;
    }

    log.info("tool_permission_host_user_denied", { toolName: params.toolName, host, matchedRule });
    return {
      block: true,
      reason: `⛔ Tool "${params.toolName}" access to host "${host}" was denied by user.`,
    };
  }

  return undefined;
}
