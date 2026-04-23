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
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "./agents.js";

// Default: 3 hours. Override with PI_DREAM_INTERVAL_HOURS env var (0.5–24).
const _rawHours = parseFloat(process.env.PI_DREAM_INTERVAL_HOURS || "3");
const DREAM_INTERVAL_HOURS = Number.isFinite(_rawHours) && _rawHours >= 0.5 && _rawHours <= 24 ? _rawHours : 3;
const DREAM_INTERVAL_MS = DREAM_INTERVAL_HOURS * 60 * 60 * 1000;

export function registerDreaming(
  pi: ExtensionAPI,
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: any[], options?: { fireAndForget?: boolean; name?: string }) => { id: string; error?: string },
): void {
  // Only the orchestrator (top-level pi) runs dreaming — skip in subagent children
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  let dreamTimer: ReturnType<typeof setInterval> | null = null;
  let enabled = true;
  let lastCwd = "";

  let dreamInFlight = false;

  function runDreamAsync(cwd: string, lastSessionFile?: string) {
    if (dreamInFlight) return; // Prevent concurrent dreams
    dreamInFlight = true;
    const { agents } = discoverAgents(cwd, "user");
    const memPath = path.join(cwd, ".pi", "memory", "memory.md");
    const sessionArg = lastSessionFile ? `\nSession file: ${lastSessionFile}` : "";
    const { id } = spawnAsyncAgent(
      "worker",
      `Memory dreaming — analyze session and maintain memory.md.${sessionArg}\nMemory file: ${memPath}\n\n` +
      `Steps:\n` +
      `1. Read the memory file (${memPath}).\n` +
      `2. If a session file is provided, read it and extract things worth remembering:\n` +
      `   - User corrections → [lesson]\n` +
      `   - User preferences → [preference]\n` +
      `   - Mistakes or repeated fix attempts → [mistake]\n` +
      `   - Completed features/PRs merged → [done]\n` +
      `   - Patterns or conventions → [pattern]\n` +
      `   Add new entries to the Learned section. Do NOT add duplicates of existing entries.\n` +
      `3. Reorganize the memory file:\n` +
      `   - Remove duplicate or near-duplicate entries from Learned\n` +
      `   - Remove stale/useless entries from Learned\n` +
      `   - Keep file at a reasonable size (aim for under 50 entries)\n` +
      `   - NEVER remove or modify entries in the Pinned section\n` +
      `4. Write the updated file. Use the write tool to overwrite ${memPath}.\n` +
      `   Keep the exact format:\n` +
      `   # Memories\n` +
      `   ## Pinned (user requested — never auto-remove)\n` +
      `   - [category] summary\n` +
      `   ## Learned (auto-extracted — dream may reorganize/remove)\n` +
      `   - [category] summary\n` +
      `5. Memory rules: one line per entry, max ~100 chars, specific and actionable, no fluff.`,
      cwd,
      agents,
      { fireAndForget: true, name: "Dream" },
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
    if (enabled) startTimer(ctx.cwd);
  });

  // Fire-and-forget dream on session shutdown.
  // Uses detached spawn (not async agent) because the session is ending —
  // async agents need the pi process alive to deliver results.
  pi.on("session_shutdown", (event) => {
    stopTimer();
    if (!enabled || !lastCwd || dreamInFlight) return;

    // Only dream on quit — skip for fork/new/resume/reload since the
    // session continues or transitions, not ending meaningfully.
    if ((event as any).reason && (event as any).reason !== "quit") return;

    // On shutdown, run a lightweight dream via detached async runner
    // (can't use spawnAsyncAgent since the session is ending)
    try {
      runDreamAsync(lastCwd);
    } catch {}
  });
}
