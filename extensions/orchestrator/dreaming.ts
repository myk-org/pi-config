/**
 * Memory dreaming — background memory consolidation on a timer.
 *
 * Inspired by OpenClaw's dreaming system (v2026.4.5).
 * See: https://docs.openclaw.ai/concepts/dreaming
 *
 * When enabled, runs "uv run myk-pi-tools memory dream" every 3 hours
 * as an async background agent, plus on session shutdown as a detached process.
 * Users toggle with /dream-auto on|off.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "./agents.js";

// Default: 3 hours. Override with PI_DREAM_INTERVAL_HOURS env var (0.5–24).
const _rawHours = parseFloat(process.env.PI_DREAM_INTERVAL_HOURS || "3");
const DREAM_INTERVAL_HOURS = Number.isFinite(_rawHours) && _rawHours >= 0.5 && _rawHours <= 24 ? _rawHours : 3;
const DREAM_INTERVAL_MS = DREAM_INTERVAL_HOURS * 60 * 60 * 1000;

export function registerDreaming(
  pi: ExtensionAPI,
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: any[], options?: { fireAndForget?: boolean }) => { id: string; error?: string },
): void {
  // Only the orchestrator (top-level pi) runs dreaming — skip in subagent children
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  let dreamTimer: ReturnType<typeof setInterval> | null = null;
  let enabled = true;
  let lastCwd = "";

  let dreamInFlight = false;
  let lastSessionFile = "";

  function runDreamAsync(cwd: string) {
    if (dreamInFlight) return; // Prevent concurrent dreams
    dreamInFlight = true;
    const { agents } = discoverAgents(cwd, "user");
    const sessionArg = lastSessionFile ? `\n\nSession file to analyze: ${lastSessionFile}` : "";
    const { id } = spawnAsyncAgent(
      "worker",
      `Memory dreaming — analyze and consolidate.${sessionArg}\n\n` +
      `Steps:\n` +
      `1. If a session file is provided, read it and look for things worth remembering:\n` +
      `   - User corrections ("no, do it this way") → category: lesson, sentiment: negative\n` +
      `   - User preferences ("I prefer X", "always do Y") → category: preference, sentiment: neutral\n` +
      `   - Mistakes or repeated fix attempts → category: mistake, sentiment: negative\n` +
      `   - Completed features/PRs merged → category: done, sentiment: positive\n` +
      `   - Patterns or conventions discovered → category: pattern, sentiment: neutral\n` +
      `   For each memory found, check existing memories first to avoid duplicates:\n` +
      `   uv run myk-pi-tools memory search "<relevant keywords>"\n` +
      `   Only add if not already captured:\n` +
      `   uv run myk-pi-tools memory add -c <category> -s "<one-line summary>" -t "<tags>" --sentiment <sentiment>\n` +
      `   Memory rules: one line only, max ~100 chars, specific and actionable, no fluff.\n` +
      `2. Run maintenance: uv run myk-pi-tools memory dream\n` +
      `3. Done. Do not report output.`,
      cwd,
      agents,
      { fireAndForget: true },
    );
    // Reset flag after reasonable timeout (dream should complete in <5 min)
    if (id) setTimeout(() => { dreamInFlight = false; }, 5 * 60 * 1000);
    else dreamInFlight = false;
  }

  function startTimer(cwd: string) {
    lastCwd = cwd;
    if (dreamTimer) return;
    dreamTimer = setInterval(() => {
      if (enabled && lastCwd) runDreamAsync(lastCwd);
    }, DREAM_INTERVAL_MS);
    if (dreamTimer.unref) dreamTimer.unref();
  }

  function stopTimer() {
    if (dreamTimer) {
      clearInterval(dreamTimer);
      dreamTimer = null;
    }
  }

  // /dream-auto command — toggle auto-dreaming
  pi.registerCommand("dream-auto", {
    description: "Toggle automatic memory dreaming (every 3h + session end)",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();

      if (arg === "on") {
        enabled = true;
        lastCwd = ctx.cwd;
        startTimer(ctx.cwd);
        ctx.ui.notify("🌙 Auto-dreaming enabled (every 3h + session end)", "info");
      } else if (arg === "off") {
        enabled = false;
        stopTimer();
        ctx.ui.notify("Auto-dreaming disabled", "info");
      } else {
        const status = enabled ? "enabled" : "disabled";
        ctx.ui.notify(`Auto-dreaming is ${status}. Use: /dream-auto on|off`, "info");
      }
    },
  });

  // Update cwd on session start
  pi.on("session_start", (_event, ctx) => {
    lastCwd = ctx.cwd;
    lastSessionFile = ctx.sessionFile || "";
    if (enabled) startTimer(ctx.cwd);
  });

  // Fire-and-forget dream on session shutdown.
  // Uses detached spawn (not async agent) because the session is ending —
  // async agents need the pi process alive to deliver results.
  pi.on("session_shutdown", () => {
    stopTimer();
    if (!enabled || !lastCwd || dreamInFlight) return;

    try {
      const proc = spawn(
        "uv",
        ["run", "myk-pi-tools", "memory", "dream"],
        { cwd: lastCwd, detached: true, stdio: "ignore" },
      );
      proc.on("error", () => {}); // Swallow async spawn errors (best-effort)
      proc.unref();
    } catch {}
  });
}
