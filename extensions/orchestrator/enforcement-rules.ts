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
  type ScoredEntry,
  type EnforcementTrigger,
  type EnforcementAction,
} from "./memory-scoring.js";

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
  const result: EnforcedEntry[] = [];

  for (const { hash, entry } of active) {
    if (!entry.trigger || !entry.action) continue;

    // Reconstruct the text from topic files for display
    // (hash is derived from the canonical line "- [category] text")
    result.push({
      hash,
      text: hash, // Will be resolved from topic files if needed
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
 */
export function loadVerifierEntries(cwd: string): EnforcedEntry[] {
  return loadEnforcedEntries(cwd).filter((e) => !!e.verifier);
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
    try {
      const re = new RegExp(pattern);
      const m = command.match(re);
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
      }
    }
  }
  return matches;
}

/**
 * Execute a run_after action command.
 */
export function executeAction(
  command: string,
  cwd: string,
): ActionResult {
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
