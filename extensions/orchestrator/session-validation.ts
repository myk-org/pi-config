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

      // Parse all entries and build index
      const entries: any[] = [];
      const byId = new Map<string, any>();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.id) {
            entries.push(entry);
            byId.set(entry.id, entry);
          }
        } catch { /* skip malformed lines */ }
      }

      // Walk active branch (leaf to root) to find orphans on the ACTUAL path
      // The flat file may have toolResults on dead branches that don't help.
      const leaf = entries[entries.length - 1];
      if (!leaf) {
        ctx.ui.notify("Session file is empty", "warning");
        return;
      }

      const branch: any[] = [];
      let cur = leaf;
      while (cur) {
        branch.push(cur);
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
      branch.reverse();

      // Collect toolCall IDs and toolResult IDs on the active branch
      const toolCalls = new Map<string, { parentId: string; toolName: string }>();
      const toolResults = new Set<string>();

      for (const entry of branch) {
        const msg = entry.message;
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

      // Find orphans on the active branch, and the next branch entry after each orphan parent
      // so we can re-parent it through the synthetic toolResult.
      const orphanGroups = new Map<string, {
        calls: { callId: string; toolName: string }[];
        nextBranchEntryId: string | null;
      }>();
      for (const [callId, meta] of toolCalls) {
        if (!toolResults.has(callId)) {
          if (!orphanGroups.has(meta.parentId)) {
            // Find the next entry on the branch after this parent
            const idx = branch.findIndex((e) => e.id === meta.parentId);
            const nextEntry = idx >= 0 && idx + 1 < branch.length ? branch[idx + 1] : null;
            orphanGroups.set(meta.parentId, {
              calls: [],
              nextBranchEntryId: nextEntry?.id ?? null,
            });
          }
          orphanGroups.get(meta.parentId)!.calls.push({ callId, toolName: meta.toolName });
        }
      }

      if (orphanGroups.size === 0) {
        ctx.ui.notify("Session is clean \u2014 no orphaned tool calls found", "info");
        return;
      }

      // Build synthetic IDs and re-parent map.
      // Chain: assistant(parent) -> synthetic_toolResult(s) -> next_entry
      // The LAST synthetic toolResult becomes the new parent for the next branch entry.
      const reparentMap = new Map<string, string>(); // entryId -> newParentId
      const syntheticsByParent = new Map<string, any[]>();
      let totalFixed = 0;
      const fixedDetails: string[] = [];

      for (const [parentId, group] of orphanGroups) {
        const synthetics: any[] = [];
        let prevId = parentId;
        for (const call of group.calls) {
          const synId = crypto.randomBytes(4).toString("hex");
          synthetics.push({
            type: "message",
            id: synId,
            parentId: prevId,
            timestamp: new Date().toISOString(),
            message: {
              role: "toolResult",
              toolCallId: call.callId,
              toolName: call.toolName,
              content: [{ type: "text", text: "Error: session interrupted \u2014 tool call did not complete" }],
              isError: true,
              timestamp: Date.now(),
            },
          });
          prevId = synId;
          totalFixed++;
          fixedDetails.push(`  \u2022 ${call.toolName} (${call.callId})`);
        }
        syntheticsByParent.set(parentId, synthetics);
        // Re-parent the next branch entry to point to the last synthetic
        if (group.nextBranchEntryId) {
          reparentMap.set(group.nextBranchEntryId, prevId);
        }
      }

      // Rewrite the session file:
      // 1. Insert synthetics after their parent
      // 2. Re-parent entries that need it
      const repairedLines: string[] = [];
      for (const line of lines) {
        let entry: any;
        try { entry = JSON.parse(line); } catch {
          repairedLines.push(line);
          continue;
        }
        // Re-parent if needed
        if (entry.id && reparentMap.has(entry.id)) {
          entry.parentId = reparentMap.get(entry.id);
          repairedLines.push(JSON.stringify(entry));
        } else {
          repairedLines.push(line);
        }
        // Insert synthetics after parent
        if (entry.id && syntheticsByParent.has(entry.id)) {
          for (const syn of syntheticsByParent.get(entry.id)!) {
            repairedLines.push(JSON.stringify(syn));
          }
        }
      }

      fs.writeFileSync(sessionFile, repairedLines.join("\n") + "\n");

      ctx.ui.notify(
        `\ud83d\udd27 Repaired ${totalFixed} orphaned tool call${totalFixed > 1 ? "s" : ""}:\n${fixedDetails.join("\n")}\nReloading session...`,
        "info",
      );

      // Force session re-read — switchSession to the same file rebuilds the tree
      await ctx.switchSession(sessionFile);
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
