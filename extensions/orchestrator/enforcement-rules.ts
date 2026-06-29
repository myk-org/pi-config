/**
 * Enforcement rules engine — reads enforced memory entries and provides
 * trigger matching + action execution for the tool_result hook.
 *
 * This module does NOT register hooks — it provides pure functions
 * that enforcement.ts and rules.ts call from their existing hooks.
 */

import { execSync } from "node:child_process";
import {
  loadScores,
  getActiveEntries,
  entryHash,
  type ScoredEntry,
  type EnforcementTrigger,
  type EnforcementAction,
} from "./memory-scoring.js";
import { readAllTopicEntries } from "./memory-tree.js";

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

// ── Loading ────────────────────────────────────────────────────────────────

/**
 * Load all active memory entries that have enforcement fields.
 * Reads from the existing memory-scores.json — no separate storage.
 */
export function loadEnforcedEntries(cwd: string): EnforcedEntry[] {
  const active = getActiveEntries(cwd);
  // Build hash→text lookup from topic files
  const topicEntries = readAllTopicEntries(cwd);
  const hashToText = new Map<string, string>();
  for (const te of topicEntries) {
    const line = `- [${te.category}] ${te.text}`;
    hashToText.set(entryHash(line), te.text);
  }

  const result: EnforcedEntry[] = [];

  for (const { hash, entry } of active) {
    if (!entry.trigger || !entry.action) continue;

    result.push({
      hash,
      text: hashToText.get(hash) || hash,
      trigger: entry.trigger,
      action: entry.action,
      actionCommand: entry.actionCommand,
      verifier: entry.verifier,
      entry,
    });
  }

  return result;
}

/**
 * Load entries that have semantic verifiers (for turn_end checking).
 * Reads active entries with a `verifier` field directly, without requiring
 * `trigger` and `action` (which loadEnforcedEntries demands).
 */
export function loadVerifierEntries(cwd: string): VerifierEntry[] {
  const active = getActiveEntries(cwd);
  const topicEntries = readAllTopicEntries(cwd);
  const hashToText = new Map<string, string>();
  for (const te of topicEntries) {
    const line = `- [${te.category}] ${te.text}`;
    hashToText.set(entryHash(line), te.text);
  }

  const result: VerifierEntry[] = [];

  for (const { hash, entry } of active) {
    if (!entry.verifier) continue;

    result.push({
      hash,
      text: hashToText.get(hash) || hash,
      trigger: entry.trigger,
      verifier: entry.verifier,
      entry,
    });
  }

  return result;
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
    // Guard against ReDoS: limit pattern length
    if (pattern.length > 200) return null;
    try {
      const re = new RegExp(pattern);
      // Use a bounded match — limit input to first 4000 chars
      const m = command.slice(0, 4000).match(re);
      if (m) return m[0];
    } catch {
      // Invalid regex — skip
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
 */
export function matchToolCall(
  entries: EnforcedEntry[],
  toolName: string,
  input: Record<string, any>,
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

    // Check file_modified for write/edit tools
    if ((toolName === "write" || toolName === "edit") && input?.path) {
      const fileHit = matchFileTrigger(rule.trigger, input.path);
      if (fileHit) {
        matches.push({ rule, matched: fileHit });
        continue;
      }
    }

    // Check bash_contains/bash_regex in subagent task text
    // Subagents run git commit/push — the orchestrator sees the subagent
    // tool_result but not the bash commands inside. Match against the
    // task description to catch delegated commands.
    if (toolName === "subagent" && input?.task) {
      const bashHit = matchBashTrigger(rule.trigger, input.task);
      if (bashHit) {
        matches.push({ rule, matched: bashHit });
      }
    }
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
  // Optional allowlist — if PI_ENFORCEMENT_ALLOWED_COMMANDS is set,
  // only permit exact-match commands (colon-separated)
  const allowedEnv = process.env.PI_ENFORCEMENT_ALLOWED_COMMANDS;
  if (allowedEnv) {
    const allowlist = allowedEnv.split(":").map(s => s.trim()).filter(Boolean);
    // Exact match only — no prefix matching to prevent shell chaining bypass
    // Both sides trimmed to avoid whitespace mismatches from storage
    const commandTrimmed = command.trim();
    const permitted = allowlist.some(allowed => commandTrimmed === allowed);
    if (!permitted) {
      return { output: `Blocked: command not in PI_ENFORCEMENT_ALLOWED_COMMANDS allowlist`, success: false };
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
