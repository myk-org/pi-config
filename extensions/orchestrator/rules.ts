/**
 * Rule & memory injection — loads rules/*.md for the orchestrator
 * and project memories from topic files for all agents.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./async-agents.js";
import { buildSituationReport, rebuildAndOrganize } from "./situation-report.js";

export function registerRules(
  pi: ExtensionAPI,
  getAsyncJobs?: () => Array<{ id: string; agent: string; name?: string; task: string; status: string; startedAt: number }>,
): void {
  const isSubagent = process.env.PI_SUBAGENT_CHILD === "1";
  let rebuildDone = false;

  // Run full rebuild on session start (once per session, not every turn)
  pi.on("session_start", async (_event, ctx) => {
    rebuildDone = false;
    try {
      rebuildAndOrganize(ctx.cwd);
      rebuildDone = true;
    } catch (e: any) { console.debug("[rules] rebuildAndOrganize on session_start failed:", e?.message || e); }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Run rebuild on first agent start if session_start didn't fire yet
    if (!rebuildDone) {
      try {
        rebuildAndOrganize(ctx.cwd);
        rebuildDone = true;
      } catch (e: any) { console.debug("[rules] rebuildAndOrganize on agent_start failed:", e?.message || e); }
    }
    let extra = "";

    // Orchestrator rules — skip for specialist agents
    if (!isSubagent) {
      const rulesDir = path.resolve(__dirname, "..", "..", "rules");
      try {
        const files = fs
          .readdirSync(rulesDir)
          .filter((f) => f.endsWith(".md"))
          .sort();
        extra +=
          "\n\n" +
          files
            .map((f) => fs.readFileSync(path.join(rulesDir, f), "utf-8"))
            .join("\n\n");
      } catch {
        extra +=
          "\n\n[ORCHESTRATOR RULES] You are a MANAGER. Delegate work to subagents.\n";
      }
    }

    // Async agent status — always show so the AI knows what's running
    if (!isSubagent && getAsyncJobs) {
      const jobs = getAsyncJobs();
      if (jobs.length === 0) {
        extra += "\n\n# Async Agents Status\n\nNo async agents running.\n";
      } else {
        let status = `\n\n# Async Agents Status\n\n${jobs.length} async agent(s) running — kill any that are no longer needed:\n`;
        for (const j of jobs) {
          const elapsed = formatDuration(Date.now() - j.startedAt);
          status += `- ${j.name || j.agent} (${j.agent}) — ${elapsed}\n`;
        }
        extra += status;
      }
    }

    // Project memories — situation report (scored, token-budgeted) injected BEFORE rules
    const memories = loadMemoriesWithScoring(ctx.cwd, isSubagent);

    // Auto-inject relevant memories based on user's prompt via vector search
    let contextMemories = "";
    if (!isSubagent && event.prompt) {
      try {
        const { vectorSearch } = await import("./memory-embeddings.js");
        const { readAllTopicEntries } = await import("./memory-tree.js");
        const entries = readAllTopicEntries(ctx.cwd);
        if (entries.length > 0) {
          const results = vectorSearch(ctx.cwd, event.prompt, entries, 5);
          // Only include high-confidence matches (similarity > 0.65)
          const relevant = results.filter(r => r.similarity > 0.65);
          if (relevant.length > 0) {
            contextMemories = "\n# Contextually Relevant Memories\n\n" +
              "These memories were automatically retrieved based on your current message:\n\n" +
              relevant.map(r => `- [${r.category}] ${r.text} (similarity: ${r.similarity.toFixed(3)})`).join("\n") +
              "\n\n";
          }
        }
      } catch { /* vector search unavailable — non-fatal */ }
    }

    if (!extra && !memories && !contextMemories) return;
    return { systemPrompt: memories + contextMemories + event.systemPrompt + extra };
  });
}

// Loads memories using situation report (scored, token-budgeted) from topic files
function loadMemoriesWithScoring(cwd: string, isSubagent: boolean): string {
  try {
    const report = buildSituationReport(cwd);
    if (report) {
      let result = "\n" + report + "\n";
      if (isSubagent) {
        result += "\n**Do NOT write to memory** \u2014 only the orchestrator writes memories.\n";
      }
      return result + "\n";
    }
  } catch (e: any) { console.debug("[rules] situation report failed:", e?.message || e); }
  return "";
}
