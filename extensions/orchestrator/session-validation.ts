/**
 * Session start validation — checks for required/optional CLI tools.
 */

import { execSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerSessionValidation(pi: ExtensionAPI): void {
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
