/**
 * Rule & memory injection — loads rules/*.md for the orchestrator
 * and recent project memories for all agents.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerRules(pi: ExtensionAPI): void {
  const isSubagent = process.env.PI_SUBAGENT_CHILD === "1";

  pi.on("before_agent_start", async (event, ctx) => {
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

    // Project memories — injected for ALL agents (orchestrator + specialists)
    const memories = loadRecentMemories(ctx.cwd);
    if (memories) {
      extra += memories;
      if (isSubagent) {
        extra +=
          "\n\nYou can search for more project memories with:" +
          " `uv run myk-pi-tools memory search \"<query>\"`" +
          " — use this before implementing if the task relates to a past lesson or mistake." +
          " **Do NOT write to memory** — only the orchestrator writes memories.\n";
      }
    }

    if (!extra) return;
    return { systemPrompt: event.systemPrompt + extra };
  });
}

interface Memory {
  category: string;
  summary: string;
  tags?: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// Loads recent memories from the per-repo SQLite DB (best-effort, non-critical)
function loadRecentMemories(cwd: string): string {
  try {
    const result = execFileSync(
      "uv",
      ["run", "myk-pi-tools", "memory", "list", "--last", "30", "-n", "10", "--json"],
      { cwd, encoding: "utf-8", timeout: 5000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    const memories: unknown[] = JSON.parse(result);
    if (!Array.isArray(memories) || memories.length === 0) return "";

    const SKIP_CATEGORIES = new Set(["done", "pattern"]);
    const lines = memories
      .filter((m): m is Memory => !!m && typeof m === "object" && "category" in m && "summary" in m)
      .filter((m) => !SKIP_CATEGORIES.has(m.category))
      .map(
        (m) => `- [${m.category}] ${truncate(m.summary, 120)}${m.tags ? ` (${m.tags})` : ""}`,
      );
    if (lines.length === 0) return "";

    return "\n\n# Project Memories\n\n" + lines.join("\n") + "\n";
  } catch {
    // Memory loading is best-effort — silently skip if CLI unavailable or DB empty
    return "";
  }
}
