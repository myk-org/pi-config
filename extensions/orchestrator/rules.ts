/**
 * Rule & memory injection — loads rules/*.md for the orchestrator
 * and project memories from memory.md for all agents.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerRules(pi: ExtensionAPI): void {
  const isSubagent = process.env.PI_SUBAGENT_CHILD === "1";
  let migrationChecked = false;

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

    // One-time migration: if memories.db exists, migrate to memory.md
    if (!migrationChecked) {
      migrationChecked = true;
      try {
        const memDir = path.join(ctx.cwd, ".pi", "memory");
        const dbPath = path.join(memDir, "memories.db");
        if (fs.existsSync(dbPath)) {
          execFileSync(
            "uv",
            ["run", "myk-pi-tools", "memory", "migrate"],
            { cwd: ctx.cwd, timeout: 10000, stdio: "ignore" },
          );
        }
      } catch {}
    }

    // Project memories — read memory.md directly (no subprocess needed)
    const memories = loadMemories(ctx.cwd);
    if (memories) {
      extra += memories;
      if (isSubagent) {
        extra +=
          "\n\n **Do NOT write to memory** — only the orchestrator writes memories.\n";
      }
    }

    if (!extra) return;
    return { systemPrompt: event.systemPrompt + extra };
  });
}

// Reads .pi/memory/memory.md directly — zero dependencies, instant
function loadMemories(cwd: string): string {
  try {
    const memPath = path.join(cwd, ".pi", "memory", "memory.md");
    if (!fs.existsSync(memPath)) return "";
    const content = fs.readFileSync(memPath, "utf-8").trim();
    if (!content || content === "# Memories") return "";
    return "\n\n" + content + "\n";
  } catch {
    return "";
  }
}
