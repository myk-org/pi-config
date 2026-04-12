/**
 * Rule injection — loads rules/*.md and appends them to the system prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerRules(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, _ctx) => {
    // Load rules from rules/ directory (sorted alphabetically)
    const rulesDir = path.resolve(__dirname, "..", "..", "rules");
    let rules = "";
    try {
      const files = fs
        .readdirSync(rulesDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      rules =
        "\n\n" +
        files
          .map((f) => fs.readFileSync(path.join(rulesDir, f), "utf-8"))
          .join("\n\n");
    } catch {
      // Fallback if rules dir not found
      rules =
        "\n\n[ORCHESTRATOR RULES] You are a MANAGER. Delegate work to subagents.\n";
    }
    return { systemPrompt: event.systemPrompt + rules };
  });
}
