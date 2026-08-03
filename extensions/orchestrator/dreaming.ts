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
import { decideAsyncLlmDispatch } from "./async-capability.js";
import { getSetting } from "./project-settings.js";
import { discoverAgents } from "./agents.js";
import { ICON_DREAM } from "./icons.js";
import { setSlot } from "./status-bar.js";
import { rebuildAndOrganize } from "./situation-report.js";
import { runPromotionPass } from "./memory-promotion.js";
import { mergeProvenancePending } from "./memory-provenance.js";
import { getProjectTmpDir } from "./utils.js";
import { dreamingLog } from "../shared/file-logger.js";

// Default: 3 hours. Override with PI_DREAM_INTERVAL_HOURS env var (0.5–24).
const _rawHours = parseFloat(process.env.PI_DREAM_INTERVAL_HOURS || "3");
const DREAM_INTERVAL_HOURS = Number.isFinite(_rawHours) && _rawHours >= 0.5 && _rawHours <= 24 ? _rawHours : 3;
const DREAM_INTERVAL_MS = DREAM_INTERVAL_HOURS * 60 * 60 * 1000;

// Scoring rebuild runs every 30 minutes (cheap, no LLM — just rescores and reorganizes)
const REBUILD_INTERVAL_MS = 30 * 60 * 1000;

export function registerDreaming(
  pi: ExtensionAPI,
  spawnAsyncAgent: (
    agentName: string,
    task: string,
    cwd: string,
    agents: any[],
    options?: {
      fireAndForget?: boolean;
      name?: string;
      parentModelId?: string;
      parentProvider?: string;
      onComplete?: () => void;
    },
  ) => { id: string; error?: string },
): void {
  // Only the orchestrator (top-level pi) runs dreaming — skip in subagent children
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  let dreamTimer: ReturnType<typeof setInterval> | null = null;
  let enabled = true;
  let lastCwd = "";
  let lastCtx: any = null;

  let dreamInFlight = false;
  let currentDreamId = "";

  function updateDreamStatus() {
    try {
      if (!lastCtx?.ui) return;
      if (dreamInFlight) {
        setSlot("dream", lastCtx.ui.theme.fg("warning", ICON_DREAM), lastCtx);
      } else {
        setSlot("dream", lastCtx.ui.theme.fg("muted", ICON_DREAM), lastCtx);
      }
    } catch { /* stale UI context — ignore */ }
  }

  function runDreamAsync(cwd: string, lastSessionFile?: string) {
    if (dreamInFlight) return; // Prevent concurrent dreams

    const parentProvider = lastCtx?.model?.provider as string | undefined;
    let dreamModelId: string | undefined;
    let dreamProvider: string | undefined;
    const dreamDispatch = decideAsyncLlmDispatch({
      parentProvider,
      cwd,
      mustAsync: true,
    });
    if (dreamDispatch.action === "skip") {
      dreamingLog("warn", dreamDispatch.note || "dream skipped (no async LLM path)");
      try {
        lastCtx?.ui?.notify?.(
          "Dream skipped: set internal_operations_provider and internal_operations_model for acpx sessions",
          "warning",
        );
      } catch { /* stale UI */ }
      return;
    }
    if (dreamDispatch.action === "sidecar-async") {
      dreamProvider = dreamDispatch.sidecar.provider;
      dreamModelId = dreamDispatch.sidecar.model;
    }

    dreamInFlight = true;
    updateDreamStatus();
    currentDreamId = "";  // Reset until we get the ID from spawnAsyncAgent
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
      `   - NEVER remove or modify entries marked with *(enforced)* — these have code-enforced triggers/actions that are keyed by text hash. ANY text change destroys the enforcement binding.\n` +
      `6. Write each updated topic file with this format:\n` +
      `   # TopicName\n` +
      `   \n` +
      `   - [category] summary *(pinned)*              (if pinned)\n` +
      `   - [category] summary *(enforced)*            (if enforced)\n` +
      `   - [category] summary *(pinned)* *(enforced)* (if both)\n` +
      `   - [category] summary                         (if neither)\n` +
      `7. Auto-generate skills: if you notice a multi-step workflow pattern across entries,\n` +
      `   create a skill file at .pi/skills/<name>/SKILL.md (project-level, NOT global ~/.agents/).\n` +
      `   The SKILL.md MUST start with YAML frontmatter:\n` +
      `   ---\n` +
      `   name: <name>\n` +
      `   description: "What this skill does and when to use it"\n` +
      `   ---\n` +
      `   Only create skills for workflows with 3+ steps that are likely to recur.\n` +
      `8. Write the current timestamp to ${topicsDir}/../.dream-watermark to track progress.\n` +
      `9. Memory rules: one line per entry, max ~100 chars, specific and actionable, no fluff.\n` +
      `10. Promotion destinations: append candidates to ${topicsDir}/../promotions.md using this block format:\n` +
      `   ### <12-char-id>\n` +
      `   - destination: memory|skill|enforcement|project_rule|discard\n` +
      `   - status: proposed\n` +
      `   - category: <category>\n` +
      `   - text: <exact topic entry text>\n` +
      `   - reason: <why this should graduate>\n` +
      `   - created: <ISO timestamp>\n` +
      `   Optional fields: evidence_count, trigger, action, verifier, skill_name, skill_created.\n` +
      `   Rules:\n` +
      `   - skill: create .pi/skills/ when confident; set skill_created: true\n` +
      `   - enforcement: propose trigger/action when mechanical (never/always + command); do NOT invent run_after\n` +
      `   - project_rule: propose only — NEVER write rules/ or .pi/rules/\n` +
      `   - discard: stale or superseded noise\n` +
      `   - Do not reopen entries already marked applied or rejected in promotions.md\n` +
      `11. Provenance sidecar (optional): for newly extracted entries, write\n` +
      `   ${topicsDir}/../provenance-pending.json as JSON:\n` +
      `   {"entries":[{"category":"lesson","text":"<exact topic text>","sourceSession":"<session basename>","derivedFrom":"<optional>","informs":["optional"]}]}\n` +
      `   Do NOT edit memory-scores.json yourself — onComplete merges the sidecar.`,
      cwd,
      agents,
      {
        fireAndForget: true,
        name: "Dream",
        parentModelId: dreamModelId,
        parentProvider: dreamProvider,
        onComplete: () => {
          dreamInFlight = false;
          updateDreamStatus();
          // File log only — console.* leaks into the chat text box.
          try {
            rebuildAndOrganize(cwd);
          } catch (err) {
            dreamingLog("error", "rebuildAndOrganize failed", err);
          }
          try {
            const n = mergeProvenancePending(cwd);
            if (n > 0) dreamingLog("info", `merged provenance for ${n} entries`);
          } catch (err) {
            dreamingLog("error", "provenance merge failed", err);
          }
          try {
            runPromotionPass(cwd);
          } catch (err) {
            dreamingLog("error", "promotion pass failed", err);
          }
        },
      },
    );
    // Dream runs as fireAndForget async agent.
    // onComplete callback triggers rebuildAndOrganize when dream finishes.
    currentDreamId = id;
    if (!id) {
      dreamInFlight = false;
      updateDreamStatus();
    } else {
      // Safety fallback: if onComplete never fires (runner crash/hang),
      // reset dreamInFlight after 30 min so future dreams aren't blocked.
      // Capture the current dream ID to avoid cross-run races.
      const dreamId = id;
      const fallbackTimer = setTimeout(() => {
        if (dreamInFlight && currentDreamId === dreamId) {
          dreamInFlight = false;
          updateDreamStatus();
          dreamingLog(
            "warn",
            "fallback: reset dreamInFlight after 30 min (onComplete never fired)",
          );
        }
      }, 30 * 60 * 1000);
      if (fallbackTimer.unref) fallbackTimer.unref();
    }
  }

  let rebuildTimer: ReturnType<typeof setInterval> | null = null;

  let currentIntervalMs = 0;

  function startTimer(cwd: string) {
    lastCwd = cwd;

    // Resolve dream interval from project settings
    const projectHours = getSetting(cwd, "dream_interval_hours");
    const clampedHours = Math.max(0.5, Math.min(24, projectHours));
    const effectiveMs = clampedHours * 60 * 60 * 1000;

    // Restart timer if interval changed (or first start)
    if (dreamTimer && currentIntervalMs === effectiveMs) return;
    if (dreamTimer) clearInterval(dreamTimer);
    currentIntervalMs = effectiveMs;

    // LLM dreaming
    dreamTimer = setInterval(() => {
      if (enabled && lastCwd) runDreamAsync(lastCwd);
    }, effectiveMs);
    if (dreamTimer.unref) dreamTimer.unref();

    // Scoring rebuild — every 30 min (cheap, no LLM, just rescores + reorganizes topics)
    if (!rebuildTimer) {
      rebuildTimer = setInterval(() => {
        if (enabled && lastCwd) {
          try {
            rebuildAndOrganize(lastCwd);
          } catch (err) {
            dreamingLog("error", "rebuildAndOrganize failed", err);
          }
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
    dreamInFlight = false; // Reset — previous session's dream state doesn't carry over
    // Skip dreaming in one-shot modes (print/json)
    if (ctx.mode === "print" || ctx.mode === "json") return;
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
    } catch (err) {
      dreamingLog("error", "shutdown dream failed", err);
    }
  });
}
