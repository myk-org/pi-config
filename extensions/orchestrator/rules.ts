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
    } catch {}
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Run rebuild on first agent start if session_start didn't fire yet
    if (!rebuildDone) {
      try {
        rebuildAndOrganize(ctx.cwd);
        rebuildDone = true;
      } catch {}
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

    if (!extra && !memories) return;
    return { systemPrompt: memories + event.systemPrompt + extra };
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
  } catch {}
  return "";
}
