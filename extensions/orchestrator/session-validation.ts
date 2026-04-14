/**
 * Session start validation — checks for required/optional CLI tools.
 */

import { execSync } from "node:child_process";
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
  });
}
