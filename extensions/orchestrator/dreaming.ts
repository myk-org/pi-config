/**
 * Memory dreaming — background memory consolidation on a timer.
 *
 * Inspired by OpenClaw's dreaming system (v2026.4.5).
 * See: https://docs.openclaw.ai/concepts/dreaming
 *
 * When enabled, spawns a worker agent every 3 hours (and on session quit)
 * that reads the session file, extracts memories, and writes topic files directly.
 * No CLI calls — the worker reads/writes files using read/write tools.
 * Users toggle with /dream-auto on|off.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.js";
import { rebuildAndOrganize } from "./situation-report.js";

// Default: 3 hours. Override with PI_DREAM_INTERVAL_HOURS env var (0.5–24).
const _rawHours = parseFloat(process.env.PI_DREAM_INTERVAL_HOURS || "3");
const DREAM_INTERVAL_HOURS = Number.isFinite(_rawHours) && _rawHours >= 0.5 && _rawHours <= 24 ? _rawHours : 3;
const DREAM_INTERVAL_MS = DREAM_INTERVAL_HOURS * 60 * 60 * 1000;

// Scoring rebuild runs every 30 minutes (cheap, no LLM — just rescores and reorganizes)
const REBUILD_INTERVAL_MS = 30 * 60 * 1000;

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
    const topicsDir = path.join(cwd, ".pi", "memory", "topics");
    const sessionArg = lastSessionFile ? `\nSession file: ${lastSessionFile}` : "";
    const { id } = spawnAsyncAgent(
      "worker",
      `Memory dreaming — analyze session and maintain topic files.${sessionArg}\nTopics directory: ${topicsDir}\n\n` +
      `Topic files are the source of truth for project memory. Each file holds entries for one category.\n\n` +
      `Steps:\n` +
      `1. Read all existing topic files in ${topicsDir}/ (lessons.md, preferences.md, patterns.md, decisions.md, completions.md, mistakes.md).\n` +
      `   If the directory doesn't exist, create it.\n` +
      `2. If a session file is provided, read it and extract things worth remembering:\n` +
      `   - User corrections → [lesson] → lessons.md\n` +
      `   - User preferences → [preference] → preferences.md\n` +
      `   - Mistakes or repeated fix attempts → [mistake] → mistakes.md\n` +
      `   - Completed features/PRs merged → [done] → completions.md\n` +
      `   - Patterns or conventions → [pattern] → patterns.md\n` +
      `   - Architectural/design decisions → [decision] → decisions.md\n` +
      `   Do NOT add duplicates of existing entries.\n` +
      `3. Reorganize each topic file:\n` +
      `   - Remove duplicate or near-duplicate entries\n` +
      `   - Remove stale/useless entries\n` +
      `   - Keep each file at a reasonable size (aim for under 20 entries per topic)\n` +
      `   - NEVER remove or modify entries marked with *(pinned)*\n` +
      `4. Write each updated topic file with this format:\n` +
      `   # TopicName\n` +
      `   \n` +
      `   - [category] summary *(pinned)*    (if pinned)\n` +
      `   - [category] summary               (if not pinned)\n` +
      `5. Memory rules: one line per entry, max ~100 chars, specific and actionable, no fluff.`,
      cwd,
      agents,
      { fireAndForget: true, name: "Dream" },
    );
    // After dream completes, rebuild scores and reorganize topics
    if (id) setTimeout(() => {
      dreamInFlight = false;
      try { rebuildAndOrganize(cwd); } catch {}
    }, 5 * 60 * 1000);
    else dreamInFlight = false;
  }

  let rebuildTimer: ReturnType<typeof setInterval> | null = null;

  function startTimer(cwd: string) {
    lastCwd = cwd;
    if (dreamTimer) return;

    // LLM dreaming — every 3h (expensive, spawns worker agent)
    dreamTimer = setInterval(() => {
      if (enabled && lastCwd) runDreamAsync(lastCwd);
    }, DREAM_INTERVAL_MS);
    if (dreamTimer.unref) dreamTimer.unref();

    // Scoring rebuild — every 30 min (cheap, no LLM, just rescores + reorganizes topics)
    if (!rebuildTimer) {
      rebuildTimer = setInterval(() => {
        if (enabled && lastCwd) {
          try { rebuildAndOrganize(lastCwd); } catch {}
        }
      }, REBUILD_INTERVAL_MS);
      if (rebuildTimer.unref) rebuildTimer.unref();
    }
  }

  function stopTimer() {
    if (dreamTimer) {
      clearInterval(dreamTimer);
      dreamTimer = null;
    }
    if (rebuildTimer) {
      clearInterval(rebuildTimer);
      rebuildTimer = null;
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
