/**
 * Rule & memory injection — loads rules/*.md for the orchestrator
 * and project memories from topic files for all agents.
 *
 * Includes: social closer gate, session history auto-injection,
 * retrieval telemetry, and vector-based contextual memory injection.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./async-agents.js";
import { buildSituationReport, estimateMemoryBudget, rebuildAndOrganize } from "./situation-report.js";

/** Social closer gate — skip expensive vector search for trivial messages */
const SOCIAL_CLOSERS = new Set([
  "ok", "yes", "no", "thanks", "thank you", "got it", "sure",
  "right", "correct", "agreed", "nice", "cool", "great", "perfect",
  "👍", "👌", "✅", "🙏", "😊", "🎉", "💯",
]);

function isSocialCloser(text: string): boolean {
  const stripped = text.trim().toLowerCase();
  if (SOCIAL_CLOSERS.has(stripped)) return true;
  // Emoji-only messages (no alphanumeric, no non-Latin scripts like CJK/Cyrillic)
  if (stripped.length > 0 && stripped.length <= 8 && !/[a-z0-9\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(stripped)) return true;
  return false;
}

/** Track last injected memories for usage detection in turn_end */
let lastInjectedMemories: { text: string; category: string; similarity: number }[] = [];

/** Log what memories were auto-injected for retrieval telemetry */
function logMemoryInjection(cwd: string, prompt: string, injected: { text: string; category: string; similarity: number }[]): void {
  try {
    const telemetryPath = path.join(cwd, ".pi", "data", "memory-telemetry.jsonl");
    const dir = path.dirname(telemetryPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      prompt: prompt.slice(0, 200),
      injected: injected.map(m => ({ text: m.text.slice(0, 100), category: m.category, similarity: m.similarity })),
    });
    fs.appendFileSync(telemetryPath, entry + "\n", "utf-8");
    // Cap file at 500KB
    const stat = fs.statSync(telemetryPath);
    if (stat.size > 512000) {
      const lines = fs.readFileSync(telemetryPath, "utf-8").split("\n").filter(Boolean);
      fs.writeFileSync(telemetryPath, lines.slice(-200).join("\n") + "\n", "utf-8");
    }
  } catch (e: any) { console.debug("[rules] telemetry write failed:", e?.message?.slice(0, 100)); }
}

/** Log whether injected memories were referenced in the LLM response */
function logMemoryUsage(cwd: string, injected: { text: string; category: string; similarity: number }[], used: { text: string; category: string; similarity: number }[]): void {
  try {
    const telemetryPath = path.join(cwd, ".pi", "data", "memory-telemetry.jsonl");
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      event: "usage",
      injectedCount: injected.length,
      usedCount: used.length,
      usageRate: injected.length > 0 ? +(used.length / injected.length).toFixed(2) : 0,
      used: used.map(m => ({ text: m.text.slice(0, 100), category: m.category })),
    });
    fs.appendFileSync(telemetryPath, entry + "\n", "utf-8");
  } catch (e: any) { console.debug("[rules] telemetry usage write failed:", e?.message?.slice(0, 100)); }
}

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

    // Bootstrap vector embeddings — embed missing entries only (orchestrator only)
    // Skips model init entirely if all entries are already embedded
    if (!isSubagent) {
      try {
        const { readAllTopicEntries } = await import("./memory-tree.js");
        const entries = readAllTopicEntries(ctx.cwd);
        if (entries.length > 0) {
          const { embedMissing } = await import("./memory-embeddings.js");
          // embedMissing checks store first — only inits model if entries are actually missing
          await embedMissing(ctx.cwd, entries);
        }
      } catch (e: any) { console.debug("[rules] embedding bootstrap failed:", e?.message?.slice(0, 100)); }
    }
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
    // Load from: package rules/ → user ~/.pi/agent/rules/ → project .pi/rules/
    // Same-filename override: project > user > package
    if (!isSubagent) {
      const packageRulesDir = path.resolve(__dirname, "..", "..", "rules");
      const userRulesDir = path.join(os.homedir(), ".pi", "agent", "rules");
      const projectRulesDir = path.join(ctx.cwd, ".pi", "rules");

      // Collect rules from all layers — later layers override same-filename entries
      const ruleFiles = new Map<string, string>(); // filename → full path
      for (const dir of [packageRulesDir, userRulesDir, projectRulesDir]) {
        try {
          for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
            ruleFiles.set(f, path.join(dir, f));
          }
        } catch (e: any) {
          if (e?.code !== "ENOENT") console.debug("[rules] failed to read", dir, e?.message?.slice(0, 100));
        }
      }

      if (ruleFiles.size > 0) {
        const sorted = [...ruleFiles.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        try {
          extra +=
            "\n\n" +
            sorted
              .map(([, filePath]) => fs.readFileSync(filePath, "utf-8"))
              .join("\n\n");
        } catch (e: any) {
          console.debug("[rules] failed to read rule file:", e?.message?.slice(0, 100));
          extra +=
            "\n\n[ORCHESTRATOR RULES] You are a MANAGER. Delegate work to subagents.\n";
        }
      } else {
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
    // systemPrompt.length is chars; estimateMemoryBudget converts internally
    const budget = estimateMemoryBudget(event.systemPrompt?.length ?? 0);
    const memories = loadMemoriesWithScoring(ctx.cwd, isSubagent, budget);

    // Auto-inject contextually relevant memories via vector search (~2.5ms, in-process)
    const shouldSearch = !isSubagent && !!event.prompt && !isSocialCloser(event.prompt);
    let contextMemories = "";
    if (shouldSearch) {
      try {
        const { vectorSearch } = await import("./memory-embeddings.js");
        const { readAllTopicEntries } = await import("./memory-tree.js");
        const entries = readAllTopicEntries(ctx.cwd);
        if (entries.length > 0) {
          const results = await vectorSearch(ctx.cwd, event.prompt, entries, 5);
          const relevant = results.filter(r => r.similarity > 0.65);
          if (relevant.length > 0) {
            contextMemories = "\n# Contextually Relevant Memories\n\n" +
              "These memories were automatically retrieved based on your current message:\n\n" +
              relevant.map(r => `- [${r.category}] ${r.text} (similarity: ${r.similarity.toFixed(3)})`).join("\n") +
              "\n\n";
            // Retrieval telemetry — track what was injected
            logMemoryInjection(ctx.cwd, event.prompt, relevant);
            lastInjectedMemories = relevant;
          }
        }
      } catch (e: any) { console.debug("[rules] vector search auto-inject failed:", e?.message?.slice(0, 100)); }
    }

    // Auto-inject relevant session history (keyword search, zero LLM cost)
    let sessionContext = "";
    if (shouldSearch) {
      try {
        const { searchSessions } = await import("./session-search.js");
        const sessionResults = searchSessions(ctx.cwd, event.prompt, 3);
        if (sessionResults.length > 0) {
          sessionContext = "\n# Relevant Past Sessions\n\n" +
            "Automatically retrieved from past conversation summaries:\n\n" +
            sessionResults.map(r =>
              `- **${r.timestamp.split("T")[0]}** (${r.sessionId.slice(0, 8)}): ${r.snippet.replace(/[`$]/g, "")}`
            ).join("\n") +
            "\n\n";
          // Telemetry — log session injections (same safeguards as logMemoryInjection)
          try {
            const telemetryPath = path.join(ctx.cwd, ".pi", "data", "memory-telemetry.jsonl");
            const dir = path.dirname(telemetryPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const entry = JSON.stringify({
              ts: new Date().toISOString(),
              event: "session-inject",
              prompt: event.prompt.slice(0, 200),
              sessionCount: sessionResults.length,
            });
            fs.appendFileSync(telemetryPath, entry + "\n", "utf-8");
            const stat = fs.statSync(telemetryPath);
            if (stat.size > 512000) {
              const lines = fs.readFileSync(telemetryPath, "utf-8").split("\n").filter(Boolean);
              fs.writeFileSync(telemetryPath, lines.slice(-200).join("\n") + "\n", "utf-8");
            }
          } catch (e: any) { console.debug("[rules] session telemetry write failed:", e?.message?.slice(0, 100)); }
        }
      } catch (e: any) { console.debug("[rules] session history auto-inject failed:", e?.message?.slice(0, 100)); }
    }

    if (!extra && !memories && !contextMemories && !sessionContext) return;
    return { systemPrompt: memories + contextMemories + sessionContext + event.systemPrompt + extra };
  });

  // Post-turn memory reminder: after a turn completes, check if any tool
  // results suggest relevant memories the AI should know about.
  // This catches cases where the user's prompt doesn't mention deployment
  // but the AI just modified files that have deployment-related memories.
  pi.on("turn_end", async (_event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    // Retrieval telemetry — detect if injected memories were used in the response
    try {
      const response = (_event as any).response || (_event as any).assistantMessage || "";
      if (response && lastInjectedMemories.length > 0) {
        const responseLower = typeof response === "string" ? response.toLowerCase() : "";
        if (responseLower.length > 50) {
          const used = lastInjectedMemories.filter(m =>
            responseLower.includes(m.text.toLowerCase().slice(0, 40))
          );
          if (used.length > 0 || lastInjectedMemories.length > 0) {
            logMemoryUsage(ctx.cwd, lastInjectedMemories, used);
          }
        }
        lastInjectedMemories = [];
      }
    } catch (e: any) { console.debug("[rules] telemetry usage detection failed:", e?.message?.slice(0, 100)); }

    // Check what files were modified in this turn by looking at tool results
    const toolResults = (_event as any).toolResults;
    if (!toolResults || !Array.isArray(toolResults) || toolResults.length === 0) return;

    // Extract file paths from edit/write tool results
    const modifiedPaths: string[] = [];
    for (const tr of toolResults) {
      const name = (tr as any)?.toolName;
      if (name === "edit" || name === "write") {
        const path = (tr as any)?.input?.path;
        if (typeof path === "string") modifiedPaths.push(path);
      }
    }
    if (modifiedPaths.length === 0) return;

    // Deduplicate and cap paths
    const uniquePaths = [...new Set(modifiedPaths)].slice(0, 10);

    // Search for memories related to the modified files
    try {
      const { vectorSearch } = await import("./memory-embeddings.js");
      const { readAllTopicEntries } = await import("./memory-tree.js");
      const entries = readAllTopicEntries(ctx.cwd);
      if (entries.length === 0) return;

      // Build a search query from modified file paths
      const searchQuery = `files modified: ${uniquePaths.join(", ")}`;
      const results = await vectorSearch(ctx.cwd, searchQuery, entries, 3);
      const relevant = results.filter(r => r.similarity > 0.70);

      if (relevant.length > 0) {
        const reminder = relevant
          .map(r => `- [${r.category}] ${r.text}`)
          .join("\n");
        pi.sendMessage({
          customType: "memory-reminder",
          content: `📝 **Memory reminder** (based on files you just modified):\n\n${reminder}`,
          display: true,
        }, { triggerTurn: false, deliverAs: "followUp" });
      }
    } catch (e: any) {
      console.debug("[rules] turn_end memory reminder failed:", e?.message?.slice(0, 100));
    }
  });
}

// Loads memories using situation report (scored, token-budgeted) from topic files
function loadMemoriesWithScoring(cwd: string, isSubagent: boolean, tokenBudget?: number): string {
  try {
    const report = buildSituationReport(cwd, tokenBudget);
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
