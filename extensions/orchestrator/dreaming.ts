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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSetting } from "./project-settings.js";
import { discoverAgents } from "./agents.js";
import { ICON_DREAM } from "./icons.js";
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
  let lastCtx: any = null;

  let dreamInFlight = false;
  let activePollInterval: ReturnType<typeof setInterval> | null = null;

  function updateDreamStatus() {
    try {
      if (!lastCtx?.ui) return;
      if (dreamInFlight) {
        lastCtx.ui.setStatus("3b-dream", lastCtx.ui.theme.fg("warning", ICON_DREAM));
      } else {
        lastCtx.ui.setStatus("3b-dream", lastCtx.ui.theme.fg("muted", ICON_DREAM));
      }
    } catch { /* stale UI context — ignore */ }
  }

  function runDreamAsync(cwd: string, lastSessionFile?: string) {
    if (dreamInFlight) return; // Prevent concurrent dreams
    dreamInFlight = true;
    updateDreamStatus();
    const { agents } = discoverAgents(cwd, "user");
    const topicsDir = path.join(cwd, ".pi", "memory", "topics");
    const { id } = spawnAsyncAgent(
      "worker",
      `Memory dreaming — analyze session and maintain topic files.\n` +
      `Session file: ${lastSessionFile || "none"}\n` +
      `Topics directory: ${topicsDir}\n\n` +
      `Topic files are the source of truth for project memory. Each file holds entries for one category.\n\n` +
      `Steps:\n` +
      `1. Read all existing topic files in ${topicsDir}/ (lessons.md, preferences.md, patterns.md, decisions.md, completions.md, mistakes.md).\n` +
      `   If the directory doesn't exist, create it.\n` +
      `2. QUALITY GATE: Before extracting from any session, assess its quality:\n` +
      `   - Score depth (substantive exchanges > 100 chars? decisions made? corrections?)\n` +
      `   - Skip sessions that are only greetings, trivial Q&A, or < 3 exchanges\n` +
      `   - Only extract from sessions with real decisions, corrections, or completed work\n` +
      `3. If a session file is provided, read it and extract things worth remembering:\n` +
      `   - User corrections → [lesson] → lessons.md\n` +
      `   - User preferences → [preference] → preferences.md\n` +
      `   - Mistakes or repeated fix attempts → [mistake] → mistakes.md\n` +
      `   - Completed features/PRs merged → [done] → completions.md\n` +
      `   - Patterns or conventions → [pattern] → patterns.md\n` +
      `   - Architectural/design decisions → [decision] → decisions.md\n` +
      `   Do NOT add duplicates of existing entries.\n` +
      `4. Scan past session files for unprocessed knowledge. Check if ${topicsDir}/../.dream-watermark exists.\n` +
      `   If it does, read the timestamp — only process sessions newer than that.\n` +
      `   Session directory: find .jsonl files under the pi sessions directory.\n` +
      `   For each unprocessed session, extract durable knowledge (same categories as step 3).\n` +
      `   Limit: process at most 5 sessions per dream cycle to avoid overload.\n` +
      `5. Reorganize each topic file:\n` +
      `   - Remove duplicate or near-duplicate entries\n` +
      `   - Remove stale/useless entries\n` +
      `   - Keep each file at a reasonable size (aim for under 20 entries per topic)\n` +
      `   - NEVER remove or modify entries marked with *(pinned)*\n` +
      `6. Write each updated topic file with this format:\n` +
      `   # TopicName\n` +
      `   \n` +
      `   - [category] summary *(pinned)*    (if pinned)\n` +
      `   - [category] summary               (if not pinned)\n` +
      `7. Auto-generate skills: if you notice a multi-step workflow pattern across entries,\n` +
      `   create a skill file at .pi/skills/<name>/SKILL.md (project-level, NOT global ~/.agents/).\n` +
      `   The SKILL.md MUST start with YAML frontmatter:\n` +
      `   ---\n` +
      `   name: <name>\n` +
      `   description: "What this skill does and when to use it"\n` +
      `   ---\n` +
      `   Only create skills for workflows with 3+ steps that are likely to recur.\n` +
      `8. Write the current timestamp to ${topicsDir}/../.dream-watermark to track progress.\n` +
      `9. Memory rules: one line per entry, max ~100 chars, specific and actionable, no fluff.`,
      cwd,
      agents,
      { fireAndForget: true, name: "Dream" },
    );
    // Poll the async agent status file until dream completes
    if (id) {
      const statusPath = path.join(os.tmpdir(), "pi-async-agents", id, "status.json");
      const pollStart = Date.now();
      const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max
      if (activePollInterval) clearInterval(activePollInterval);
      const pollInterval = setInterval(() => {
        try {
          // Timeout guard — don't poll forever
          if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
            clearInterval(pollInterval);
            activePollInterval = null;
            dreamInFlight = false;
            updateDreamStatus();
            console.debug("[dreaming] poll timed out after 30 min");
            return;
          }
          if (!fs.existsSync(statusPath)) return;
          const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
          if (status.state === "complete" || status.state === "failed") {
            clearInterval(pollInterval);
            activePollInterval = null;
            dreamInFlight = false;
            updateDreamStatus();
            try { rebuildAndOrganize(cwd); } catch (e: any) { console.debug("[dreaming] rebuildAndOrganize failed:", e?.message || e); }
          }
        } catch { /* poll is best-effort */ }
      }, 15_000); // Check every 15 seconds
      if (pollInterval.unref) pollInterval.unref();
      activePollInterval = pollInterval;
    } else {
      dreamInFlight = false;
      updateDreamStatus();
    }
  }

  let rebuildTimer: ReturnType<typeof setInterval> | null = null;

  function startTimer(cwd: string) {
    lastCwd = cwd;
    if (dreamTimer) return;

    // Override dream interval from project settings if available
    const projectHours = getSetting(cwd, "dream_interval_hours");
    const effectiveMs = (Number.isFinite(projectHours) && projectHours >= 0.5 && projectHours <= 24
      ? projectHours : DREAM_INTERVAL_HOURS) * 60 * 60 * 1000;

    // LLM dreaming — every 3h (expensive, spawns worker agent)
    dreamTimer = setInterval(() => {
      if (enabled && lastCwd) runDreamAsync(lastCwd);
    }, effectiveMs);
    if (dreamTimer.unref) dreamTimer.unref();

    // Scoring rebuild — every 30 min (cheap, no LLM, just rescores + reorganizes topics)
    if (!rebuildTimer) {
      rebuildTimer = setInterval(() => {
        if (enabled && lastCwd) {
          try { rebuildAndOrganize(lastCwd); } catch (e: any) { console.debug("[dreaming] rebuildAndOrganize failed:", e?.message || e); }
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
        lastCtx = ctx;
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

  // /dream command — manual trigger for memory consolidation
  pi.registerCommand("dream", {
    description: "Run memory consolidation now (background, non-blocking)",
    handler: async (_args, ctx) => {
      if (dreamInFlight) {
        ctx.ui.notify("Dream already running — wait for it to finish", "warning");
        return;
      }
      lastCwd = ctx.cwd;
      lastCtx = ctx;
      runDreamAsync(ctx.cwd);
    },
  });

  // Set initial dream status on first agent start (fires on /reload too, unlike session_start)
  let initialized = false;
  pi.on("before_agent_start", (_event, ctx) => {
    if (!initialized) {
      initialized = true;
      lastCtx = ctx;
      updateDreamStatus();
    }
  });

  // Update cwd on session start
  pi.on("session_start", (_event, ctx) => {
    lastCwd = ctx.cwd;
    lastCtx = ctx;
    if (activePollInterval) { clearInterval(activePollInterval); activePollInterval = null; }
    dreamInFlight = false; // Reset — previous session's dream state doesn't carry over
    updateDreamStatus();
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
    } catch (e: any) { console.debug("[dreaming] shutdown dream failed:", e?.message || e); }
  });
}
