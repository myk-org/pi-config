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

    // Project memories — injected BEFORE rules so the LLM sees them first
    const memories = loadMemories(ctx.cwd, isSubagent);

    if (!extra && !memories) return;
    return { systemPrompt: memories + event.systemPrompt + extra };
  });
}

// Reads .pi/memory/memory.md, wraps with strong framing so the LLM prioritizes it
function loadMemories(cwd: string, isSubagent: boolean): string {
  try {
    const memPath = path.join(cwd, ".pi", "memory", "memory.md");
    if (!fs.existsSync(memPath)) return "";
    const raw = fs.readFileSync(memPath, "utf-8").trim();
    if (!raw || raw === "# Memories") return "";

    // Replace the plain header with a stronger framing
    const content = raw.replace(
      /^# Memories/,
      "# CRITICAL: Project Memory \u2014 Lessons From Previous Sessions\n\n" +
      "These memories were saved because they caused real problems. Apply them proactively.",
    );

    let result = "\n" + content + "\n";
    if (isSubagent) {
      result += "\n**Do NOT write to memory** \u2014 only the orchestrator writes memories.\n";
    }
    return result + "\n";
  } catch {
    return "";
  }
}
