/**
 * Enforcement rules engine — reads enforced memory entries and provides
 * trigger matching + action execution for the tool_result hook.
 *
 * This module does NOT register hooks — it provides pure functions
 * that enforcement.ts and rules.ts call from their existing hooks.
 */

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  getScoresRevision,
  loadScores,
  entryHash,
  isEntryActiveForSession,
  type ScoredEntry,
  type ScoresFile,
  type EnforcementTrigger,
  type EnforcementAction,
} from "./memory-scoring.js";
import { createLogger } from "../shared/logger.js";
import { readAllTopicEntries } from "./memory-tree.js";
import { getSetting } from "./project-settings.js";
import { getProjectMemoryDir } from "./utils.js";

const log = createLogger("enforcement");

// ── Types ──────────────────────────────────────────────────────────────────

export interface EnforcedEntry {
  hash: string;
  text: string;
  trigger: EnforcementTrigger;
  action: EnforcementAction;
  actionCommand?: string;
  verifier?: string;
  entry: ScoredEntry;
}

/** Verifier-only entry — has a verifier but trigger/action are optional */
export interface VerifierEntry {
  hash: string;
  text: string;
  trigger?: EnforcementTrigger;
  verifier: string;
  entry: ScoredEntry;
}

export interface TriggerMatch {
  rule: EnforcedEntry;
  matched: string; // what part of the input matched
}

export interface ActionResult {
  output: string;
  success: boolean;
}

// ── Caching ────────────────────────────────────────────────────────────────

const ENTRIES_CACHE_MAX = 32;
const REGEX_CACHE_MAX = 64;

interface CachedEntries<T> {
  scoresRef: ScoresFile;
  scoresRevision: number;
  topicsStamp: string;
  minExpiresAtMs: number;
  result: T[];
}

const enforcedEntriesCache = new Map<string, CachedEntries<EnforcedEntry>>();
const verifierEntriesCache = new Map<string, CachedEntries<VerifierEntry>>();
const bashRegexCache = new Map<string, RegExp | null>();

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) map.delete(key);
  else if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Clear cached enforced/verifier entries and compiled regexes (tests). */
export function clearEnforcementRulesCache(): void {
  enforcedEntriesCache.clear();
  verifierEntriesCache.clear();
  bashRegexCache.clear();
}

function getTopicsStamp(cwd: string): string {
  const topicsDir = join(getProjectMemoryDir(cwd), "topics");
  try {
    const files = readdirSync(topicsDir).filter((f) => f.endsWith(".md")).sort();
    const parts: string[] = [];
    for (const file of files) {
      try {
        const st = statSync(join(topicsDir, file), { bigint: true });
        parts.push(`${file}:${st.mtimeNs}:${st.ctimeNs}:${st.size}`);
      } catch {
        parts.push(`${file}:missing`);
      }
    }
    return parts.join("|");
  } catch {
    return "";
  }
}

function minExpiryFromCandidates(candidates: ReadonlyArray<{ entry: ScoredEntry }>): number {
  let minExpiresAtMs = Infinity;
  for (const { entry } of candidates) {
    if (!entry.expiresAt) continue;
    const t = Date.parse(entry.expiresAt);
    if (!Number.isNaN(t) && t < minExpiresAtMs) minExpiresAtMs = t;
  }
  return minExpiresAtMs;
}

function buildHashToTextLookup(cwd: string, neededHashes: Set<string>): Map<string, string> {
  const hashToText = new Map<string, string>();
  if (neededHashes.size === 0) return hashToText;
  const topicEntries = readAllTopicEntries(cwd);
  for (const te of topicEntries) {
    const line = `- [${te.category}] ${te.text}`;
    const h = entryHash(line);
    if (neededHashes.has(h)) {
      hashToText.set(h, te.text);
      if (hashToText.size >= neededHashes.size) break;
    }
  }
  return hashToText;
}

function compileBashRegex(pattern: string): RegExp | null {
  if (pattern.length > 200) return null;
  if (bashRegexCache.has(pattern)) return bashRegexCache.get(pattern)!;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern);
  } catch {
    compiled = null;
  }
  setBounded(bashRegexCache, pattern, compiled, REGEX_CACHE_MAX);
  return compiled;
}

// ── Loading ────────────────────────────────────────────────────────────────

function loadEligibleScoreEntries<T>(
  cwd: string,
  sessionId: string | undefined,
  cache: Map<string, CachedEntries<T>>,
  label: string,
  include: (hash: string, entry: ScoredEntry) => boolean,
  mapEntry: (hash: string, text: string, entry: ScoredEntry) => T,
): T[] {
  // Load ALL matching entries, not just active/provisional.
  // Enforced rules are code-checked — lifecycle decay should not disable them.
  const scores = loadScores(cwd);
  const scoresRevision = getScoresRevision(cwd);
  const rawEntries = Object.entries(scores.entries);
  if (rawEntries.length === 0) return [];

  const cacheKey = `${resolve(cwd)}\0${sessionId ?? ""}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (
    cached &&
    cached.scoresRef === scores &&
    cached.scoresRevision === scoresRevision &&
    now < cached.minExpiresAtMs
  ) {
    if (cached.result.length === 0 || cached.topicsStamp === getTopicsStamp(cwd)) {
      log.debug(`${label}_cache_hit`, { count: cached.result.length });
      return cached.result;
    }
  }

  // Filter FIRST before touching topic files or computing SHA-256 hashes.
  const candidates: Array<{ hash: string; entry: ScoredEntry }> = [];
  for (const [hash, entry] of rawEntries) {
    if (entry.lifecycle === "dropped" || entry.userState === "forgotten") continue;
    if (!isEntryActiveForSession(entry, sessionId)) continue;
    if (!include(hash, entry)) continue;
    candidates.push({ hash, entry });
  }

  if (candidates.length === 0) {
    setBounded(
      cache,
      cacheKey,
      { scoresRef: scores, scoresRevision, topicsStamp: "", minExpiresAtMs: Infinity, result: [] },
      ENTRIES_CACHE_MAX,
    );
    log.debug(`${label}_loaded`, { count: 0 });
    return [];
  }

  const topicsStamp = getTopicsStamp(cwd);
  const neededHashes = new Set(candidates.map((c) => c.hash));
  const hashToText = buildHashToTextLookup(cwd, neededHashes);

  const result: T[] = [];
  for (const { hash, entry } of candidates) {
    result.push(mapEntry(hash, hashToText.get(hash) || hash, entry));
  }

  setBounded(
    cache,
    cacheKey,
    {
      scoresRef: scores,
      scoresRevision,
      topicsStamp,
      minExpiresAtMs: minExpiryFromCandidates(candidates),
      result,
    },
    ENTRIES_CACHE_MAX,
  );
  log.debug(`${label}_loaded`, { count: result.length });
  return result;
}

/**
 * Load all active memory entries that have enforcement fields.
 * Reads from the existing memory-scores.jsonl — no separate storage.
 * Session-scoped entries only enforce in their own session, and expired
 * entries never enforce (Qodo #8, PR #916) — a session rule must not block
 * a later session. When `sessionId` is unknown, session-scoped rules are
 * excluded entirely (fail closed — they are transient by design).
 */
export function loadEnforcedEntries(cwd: string, sessionId?: string): EnforcedEntry[] {
  return loadEligibleScoreEntries(
    cwd,
    sessionId,
    enforcedEntriesCache,
    "enforced_entries",
    (hash, entry) => {
      if (!entry.trigger || !entry.action) return false;
      // A `tool_name bash` rule fires on every command: block stops the session dead, warn
      // buries every result under a banner. Both happened with entries already in the store,
      // so the guard lives at load time as well as write time.
      if (
        entry.trigger.trim().toLowerCase() === "tool_name bash" &&
        ["block", "warn"].includes(entry.action.trim().split(/\s+/)[0])
      ) {
        log.warn("enforcement_rule_unscoped_bash_ignored", { hash, action: entry.action });
        return false;
      }
      return true;
    },
    (hash, text, entry) => ({
      hash,
      text,
      trigger: entry.trigger!,
      action: entry.action!,
      actionCommand: entry.actionCommand,
      verifier: entry.verifier,
      entry,
    }),
  );
}

/**
 * Load entries that have semantic verifiers (for turn_end checking).
 * Reads active entries with a `verifier` field directly, without requiring
 * `trigger` and `action` (which loadEnforcedEntries demands). Same
 * session/expiry eligibility as loadEnforcedEntries (Qodo #8, PR #916).
 */
export function loadVerifierEntries(cwd: string, sessionId?: string): VerifierEntry[] {
  return loadEligibleScoreEntries(
    cwd,
    sessionId,
    verifierEntriesCache,
    "verifier_entries",
    (_hash, entry) => Boolean(entry.verifier),
    (hash, text, entry) => ({
      hash,
      text,
      trigger: entry.trigger,
      verifier: entry.verifier!,
      entry,
    }),
  );
}

// ── Trigger Matching ───────────────────────────────────────────────────────

/**
 * Check if a bash command matches a trigger.
 */
function matchBashTrigger(
  trigger: EnforcementTrigger,
  command: string,
): string | null {
  if (trigger.startsWith("bash_contains ")) {
    const needle = trigger.slice("bash_contains ".length);
    if (command.includes(needle)) return needle;
  }
  if (trigger.startsWith("bash_regex ")) {
    const pattern = trigger.slice("bash_regex ".length);
    const re = compileBashRegex(pattern);
    if (re) {
      // Use a bounded match — limit input to first 4000 chars
      const m = command.slice(0, 4000).match(re);
      if (m) return m[0];
    }
  }
  return null;
}

/**
 * Check if a tool name matches a trigger.
 */
function matchToolTrigger(
  trigger: EnforcementTrigger,
  toolName: string,
): string | null {
  if (trigger.startsWith("tool_name ")) {
    const expected = trigger.slice("tool_name ".length);
    if (toolName === expected) return toolName;
  }
  return null;
}

/**
 * Check if a file path matches a trigger.
 */
function matchFileTrigger(
  trigger: EnforcementTrigger,
  filePath: string,
): string | null {
  if (trigger.startsWith("file_modified ")) {
    const glob = trigger.slice("file_modified ".length);
    // Simple glob: *.py matches .py extension, exact match otherwise
    if (glob.startsWith("*.")) {
      const ext = glob.slice(1); // ".py"
      if (filePath.endsWith(ext)) return filePath;
    } else if (filePath.includes(glob)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Find all enforced entries whose triggers match a bash command.
 */
export function matchBashCommand(
  entries: EnforcedEntry[],
  command: string,
): TriggerMatch[] {
  const matches: TriggerMatch[] = [];
  for (const rule of entries) {
    const hit = matchBashTrigger(rule.trigger, command);
    if (hit) matches.push({ rule, matched: hit });
  }
  return matches;
}

/**
 * Find all enforced entries whose triggers match a tool call.
 *
 * `isError` marks a FAILED tool call: `file_modified` triggers must not
 * match then (nothing was modified — e.g. an edit whose oldText was not
 * found), while `tool_name` and bash matching stay live (a failed bash
 * command still executed; tool_name matches the invocation itself).
 */
export function matchToolCall(
  entries: EnforcedEntry[],
  toolName: string,
  input: Record<string, any>,
  isError = false,
): TriggerMatch[] {
  const matches: TriggerMatch[] = [];
  for (const rule of entries) {
    // Check tool_name triggers
    const toolHit = matchToolTrigger(rule.trigger, toolName);
    if (toolHit) {
      matches.push({ rule, matched: toolHit });
      continue;
    }

    // Check bash_contains/bash_regex for bash tool
    if (toolName === "bash" && input?.command) {
      const bashHit = matchBashTrigger(rule.trigger, input.command);
      if (bashHit) {
        matches.push({ rule, matched: bashHit });
        continue;
      }
    }

    // Check file_modified for write/edit tools — only when the call
    // actually (modified) the file, not when it failed before writing.
    if (!isError && (toolName === "write" || toolName === "edit") && input?.path) {
      const fileHit = matchFileTrigger(rule.trigger, input.path);
      if (fileHit) {
        matches.push({ rule, matched: fileHit });
        continue;
      }
    }

    // Subagent matching is handled in the tool_result hook via structured
    // tool call extraction from subagent messages (not task text matching).
  }
  return matches;
}

/**
 * Check verifier rules against a turn's tool results.
 * Returns list of violated verifier strings.
 */
export function checkVerifiers(
  verifierEntries: VerifierEntry[],
  toolResults: Array<{ toolName: string; input: Record<string, any> }>,
): string[] {
  const violations: string[] = [];

  for (const rule of verifierEntries) {
    const m = rule.verifier.match(/^tool_called (\S+) before (.+)$/);
    if (!m) continue;

    const requiredTool = m[1];
    const beforeCommand = m[2];

    let requiredIdx = -1;
    let triggerIdx = -1;
    for (let i = 0; i < toolResults.length; i++) {
      const trName = toolResults[i].toolName;
      const trInput = toolResults[i].input || {};
      if (trName === requiredTool && requiredIdx === -1) requiredIdx = i;
      // Match beforeCommand in bash commands — this is the triggering event
      // that the verifier checks (e.g., "gh pr merge" in a bash call)
      if (triggerIdx === -1 && trName === "bash" && trInput?.command?.includes(beforeCommand)) {
        triggerIdx = i;
      }
    }

    if (triggerIdx >= 0 && (requiredIdx < 0 || requiredIdx >= triggerIdx)) {
      violations.push(rule.verifier);
    }
  }

  return violations;
}

/**
 * Execute a run_after action command.
 */
export function executeAction(
  command: string,
  cwd: string,
): ActionResult {
  // Optional allowlist — if enforcement_allowed_commands setting is set,
  // only permit exact-match commands (colon-separated)
  const allowedEnv = getSetting(cwd, "enforcement_allowed_commands") as string;
  if (allowedEnv) {
    const allowlist = allowedEnv.split(":").map(s => s.trim()).filter(Boolean);
    // Exact match only — no prefix matching to prevent shell chaining bypass
    // Both sides trimmed to avoid whitespace mismatches from storage
    const commandTrimmed = command.trim();
    const permitted = allowlist.some(allowed => commandTrimmed === allowed);
    if (!permitted) {
      return { output: `Blocked: command not in enforcement_allowed_commands allowlist`, success: false };
    }
  }

  // Safety: reject commands that match dangerous patterns
  const BLOCKED_PATTERNS = [
    /\bcurl\b.*\|\s*(?:bash|sh|zsh)\b/i,    // curl | bash
    /\bwget\b.*\|\s*(?:bash|sh|zsh)\b/i,    // wget | bash
    /\brm\s+(-[rf]+\s+)*\//,                 // rm -rf /
    /\bsudo\b/,                               // sudo
    /\bchmod\s+[0-7]*7[0-7]*\b/,             // world-writable chmod
  ];
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { output: `Blocked: enforcement command matches dangerous pattern: ${pattern}`, success: false };
    }
  }
  try {
    const output = execSync(command, {
      cwd,
      timeout: 60_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { output: output.trim(), success: true };
  } catch (e: any) {
    const stderr = e.stderr || e.message || "Unknown error";
    return { output: stderr.trim(), success: false };
  }
}
