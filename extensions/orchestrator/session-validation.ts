/**
 * Session start validation — checks for required/optional CLI tools.
 */

import { execSync, execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerSessionValidation(pi: ExtensionAPI): void {
  // ── /repair command ─────────────────────────────────────────────────
  pi.registerCommand("repair", {
    description: "Repair session — fix orphaned tool calls that break API requests",
    handler: async (_args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile || !fs.existsSync(sessionFile)) {
        ctx.ui.notify("No session file found", "warning");
        return;
      }

      const raw = fs.readFileSync(sessionFile, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());

      // Collect all tool call IDs and their metadata
      const toolCalls = new Map<string, { parentId: string; toolName: string }>();
      const toolResults = new Set<string>();

      for (const line of lines) {
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const msg = entry?.message;
        if (!msg) continue;

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === "toolCall" && item.id) {
              toolCalls.set(item.id, {
                parentId: entry.id,
                toolName: item.toolName || item.name || "unknown",
              });
            }
          }
        } else if (msg.role === "toolResult" && msg.toolCallId) {
          toolResults.add(msg.toolCallId);
        }
      }

      // Find orphans — tool calls with no matching result
      const orphans = new Map<string, { callId: string; parentId: string; toolName: string }[]>();
      for (const [callId, meta] of toolCalls) {
        if (!toolResults.has(callId)) {
          if (!orphans.has(meta.parentId)) orphans.set(meta.parentId, []);
          orphans.get(meta.parentId)!.push({ callId, parentId: meta.parentId, toolName: meta.toolName });
        }
      }

      if (orphans.size === 0) {
        ctx.ui.notify("Session is clean — no orphaned tool calls found", "info");
        return;
      }

      // Rewrite session — insert synthetic toolResult right after the parent message.
      // The API requires tool_result in the NEXT message after tool_use.
      const repairedLines: string[] = [];
      let totalFixed = 0;
      const fixedDetails: string[] = [];

      for (const line of lines) {
        repairedLines.push(line);
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        const entryId = entry?.id;
        if (entryId && orphans.has(entryId)) {
          for (const orphan of orphans.get(entryId)!) {
            const synthetic = {
              type: "message",
              id: crypto.randomBytes(4).toString("hex"),
              parentId: orphan.parentId,
              timestamp: new Date().toISOString(),
              message: {
                role: "toolResult",
                toolCallId: orphan.callId,
                toolName: orphan.toolName,
                content: [{ type: "text", text: "Error: session interrupted — tool call did not complete" }],
                isError: true,
                timestamp: Date.now(),
              },
            };
            repairedLines.push(JSON.stringify(synthetic));
            totalFixed++;
            fixedDetails.push(`  • ${orphan.toolName} (${orphan.callId})`);
          }
        }
      }

      fs.writeFileSync(sessionFile, repairedLines.join("\n") + "\n");

      ctx.ui.notify(
        `🔧 Repaired ${totalFixed} orphaned tool call${totalFixed > 1 ? "s" : ""}:\n${fixedDetails.join("\n")}`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const missing: string[] = [];
    const optional: string[] = [];

    const hasCmd = (cmd: string): boolean => {
      try {
        execSync(`command -v ${cmd}`, {
          timeout: 3000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return true;
      } catch {
        return false;
      }
    };

    // Critical
    if (!hasCmd("uv"))
      missing.push(
        "uv — Required for Python. Install: https://docs.astral.sh/uv/",
      );

    // Optional
    if (!hasCmd("gh"))
      optional.push("gh — GitHub CLI. Install: https://cli.github.com/");
    if (!hasCmd("mcpl"))
      optional.push(
        "mcpl — MCP Launchpad. Install: https://github.com/kenneth-liao/mcp-launchpad",
      );
    if (!hasCmd("myk-pi-tools"))
      optional.push(
        "myk-pi-tools — PR/release/review CLI. Install: uv tool install git+https://github.com/myk-org/pi-config",
      );

    // Check agent-browser skill
    const agentBrowserPaths = [
      path.join(process.env.HOME || "", ".agents", "skills", "agent-browser", "SKILL.md"),
      path.join(process.env.HOME || "", ".pi", "agent", "skills", "agent-browser", "SKILL.md"),
    ];
    if (!agentBrowserPaths.some((p) => fs.existsSync(p))) {
      optional.push(
        "agent-browser skill — browser automation. Install: npx skills add vercel-labs/agent-browser@agent-browser -g -y",
      );
    }

    // Check prek only if .pre-commit-config.yaml exists
    try {
      if (
        fs.existsSync(path.join(ctx.cwd, ".pre-commit-config.yaml")) &&
        !hasCmd("prek")
      ) {
        optional.push(
          "prek — pre-commit wrapper (.pre-commit-config.yaml detected). Install: https://github.com/j178/prek",
        );
      }
    } catch {}

    if (missing.length > 0 || optional.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0)
        parts.push(
          `⚠️ CRITICAL missing:\n${missing.map((m) => `  • ${m}`).join("\n")}`,
        );
      if (optional.length > 0)
        parts.push(
          `Optional missing:\n${optional.map((m) => `  • ${m}`).join("\n")}`,
        );
      ctx.ui.notify(
        parts.join("\n\n"),
        missing.length > 0 ? "warning" : "info",
      );
    }

    // ── Upgrade changelog ──────────────────────────────────────────────
    // Find pi-config package.json by walking up from this file's directory
    try {
      let searchDir = __dirname ?? path.dirname(new URL(import.meta.url).pathname);
      let currentVersion: string | null = null;
      for (let i = 0; i < 5; i++) {
        const candidate = path.join(searchDir, "package.json");
        if (fs.existsSync(candidate)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
            if (pkg.name === "pi-orchestrator-config" && pkg.version) {
              currentVersion = pkg.version;
              break;
            }
          } catch {}
        }
        searchDir = path.dirname(searchDir);
      }
      if (currentVersion) {
          const versionFile = path.join(
            process.env.HOME || "",
            ".pi",
            "pi-config-last-version",
          );
          let lastVersion: string | null = null;
          try {
            lastVersion = fs.readFileSync(versionFile, "utf-8").trim();
          } catch {}

          if (!lastVersion) {
            // First run — just record the version, no notification
            try {
              fs.mkdirSync(path.dirname(versionFile), { recursive: true });
              fs.writeFileSync(versionFile, currentVersion, "utf-8");
            } catch {}
          } else if (lastVersion !== currentVersion && hasCmd("gh")) {
            // Version changed — fetch release notes (5s timeout, no shell)
            const tag = `v${currentVersion}`;
            const releaseUrl = `https://github.com/myk-org/pi-config/releases/tag/${tag}`;
            let notified = false;
            try {
              const body = execFileSync(
                "gh",
                ["release", "view", "--repo", "myk-org/pi-config", tag, "--json", "body", "--jq", ".body"],
                { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
              ).toString().trim();
              if (body) {
                const maxLen = 1500;
                const truncated = body.length > maxLen
                  ? body.slice(0, maxLen) + `\n\n... [See full notes](${releaseUrl})`
                  : body;
                ctx.ui.notify(
                  `🚀 pi-config updated: ${lastVersion} → ${currentVersion}\n\n${truncated}`,
                  "info",
                );
                notified = true;
              }
            } catch {}
            // Only update version file after successful notification
            // so failed attempts retry on next session
            if (notified) {
              try {
                fs.mkdirSync(path.dirname(versionFile), { recursive: true });
                fs.writeFileSync(versionFile, currentVersion, "utf-8");
              } catch {}
            }
          }
      }
    } catch {}
  });
}
