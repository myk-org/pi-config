/**
 * Shared system prompt builder for CLI and ACPX providers.
 * Injects enforced memory entries so external agents follow the same rules.
 */

import { getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import { loadEnforcedEntries } from "../orchestrator/enforcement-rules.js";
import { createLogger } from "./logger.js";

const log = createLogger("build-system-prompt");

export function createEmptyTranscriptContext(): TranscriptContext {
  log.debug("creating empty transcript context");
  return { messages: [] } as TranscriptContext;
}

/**
 * Build the system prompt for external LLM providers (CLI/ACPX).
 * Appends enforced memory rules so external agents follow project enforcement.
 */
export function buildExternalSystemPrompt(context: TranscriptContext, cwd?: string): string | undefined {
  const systemPrompt = getCurrentSystemPrompt(context.messages);
  log.debug("building external system prompt", { hasSystemPrompt: Boolean(systemPrompt), hasCwd: Boolean(cwd) });
  if (!systemPrompt) return undefined;
  const parts = [
    "You are being used as a backend LLM through pi coding agent.",
    "You have full permission to read, write, edit, and execute any files or commands.",
    "Follow these instructions:",
    "",
    systemPrompt,
  ];

  // Inject enforced memory entries so CLI/ACPX agents follow the same rules
  if (cwd) {
    try {
      const entries = loadEnforcedEntries(cwd);
      if (entries.length > 0) {
        const rules: string[] = [];
        for (const e of entries) {
          const trigger = e.trigger
            .replace(/^bash_contains\s+/, "")
            .replace(/^bash_regex\s+/, "")
            .replace(/^tool_name\s+/, "")
            .replace(/^file_modified\s+/, "");
          if (e.action === "block") {
            rules.push(`- NEVER: ${trigger} — ${e.text}`);
          } else if (e.action === "warn") {
            rules.push(`- WARNING when running \`${trigger}\`: ${e.text}`);
          } else if (e.action.startsWith("run_after")) {
            const cmd = e.actionCommand || e.action.slice("run_after ".length);
            if (cmd) {
              rules.push(`- After running \`${trigger}\`, ALWAYS run: \`${cmd}\``);
            }
          }
        }
        if (rules.length > 0) {
          parts.push("", "## Enforced Rules (MANDATORY)", "", ...rules);
        }
      }
    } catch { /* enforcement should never break the provider */ }
  }

  return parts.join("\n");
}
