/**
 * Memory dreaming — background memory consolidation on a timer.
 *
 * Inspired by OpenClaw's dreaming system (v2026.4.5).
 * See: https://docs.openclaw.ai/concepts/dreaming
 *
 * When enabled, spawns a worker agent every 3 hours (and on session quit)
 * that reads the session file, extracts memories, and writes topic files directly.
 * No CLI calls — the worker reads/writes files using read/write tools.
 * Configured via `dream_auto_enable` / `dream_interval_hours` in `/pi-config-settings`
 * and controlled programmatically via the `memory_dream` tool.
 */

import { createLogger } from "../shared/logger.js";
import { TOOL_NAMESPACES } from "../shared/tool-namespaces.js";

const log = createLogger("dreaming");
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getInternalOpsProvider } from "./async-capability.js";
import { getSetting } from "./project-settings.js";
import { discoverAgents } from "./agents.js";
import { ICON_DREAM } from "./icons.js";
import { setSlot } from "./status-bar.js";
import { distilledLessonTextList } from "./review-learning.js";
import { canonicalizeTopicLine } from "./memory-line.js";
import { entryHash } from "./memory-scoring.js";
import {
  type TopicRestoreReport,
  isProtectedTopicLine,
  removalsSince,
  restoreProtectedTopicLines,
  snapshotTopicLines,
} from "./memory-store.js";
import { rebuildAndOrganize } from "./situation-report.js";
import { runPromotionPass } from "./memory-promotion.js";
import { mergeProvenancePending } from "./memory-provenance.js";
import { getProjectMemoryDir, getProjectDataDir, shouldSkipOneshotShutdownDream } from "./utils.js";
import { fileLog } from "../shared/file-logger.js";

export {
  type TopicRestoreReport,
  isProtectedTopicLine,
  restoreProtectedTopicLines,
  snapshotTopicLines,
};

// Scoring rebuild runs every 30 minutes (cheap, no LLM — just rescores and reorganizes)
const REBUILD_INTERVAL_MS = 30 * 60 * 1000;

export function buildDreamPrompt(
  lastSessionFile: string | undefined,
  topicsDir: string,
): string {
  return (
    `Memory dreaming — analyze session and maintain topic files.\n` +
    `Session file: ${lastSessionFile || "none"}\n` +
    `Topics directory: ${topicsDir}\n\n` +
    `Topic files are the source of truth (one category per file).\n\n` +
    `Rules (apply to all steps):\n` +
    `- Format: one line/entry, ≤100 chars, specific, actionable, no fluff or duplicates.\n` +
    `- Standing test (never extract; prune if found): discard one-off grants ("you can merge this PR",\n` +
    `  "skip tests just this once"), task-scoped asks ("when done, I want an html report"),\n` +
    `  version-pinned migrations ("when bumping to 1.4.0, drop the vendor dir"), config-change notes\n` +
    `  ("every 30min (changed from 1h)"), raw chat/cutoffs, and session/expired entries. Would this\n` +
    `  apply to a future unrelated task? No → discard.\n` +
    `- No derivable history: NEVER store a PR/issue number list, merge/release history, version\n` +
    `  changelogs, or closed-ticket roundups (git/gh/tracker hold them; "Open: #772" goes stale).\n` +
    `  [done] holds ONLY non-derivable outcome knowledge (conclusions, measurements, root causes,\n` +
    `  "X was fixed by Y because Z").\n` +
    `- Immutability: NEVER remove or modify entries marked with *(pinned)*.\n` +
    `  NEVER remove or modify entries marked with *(enforced)* — code-enforced triggers/actions are\n` +
    `  hash-keyed, so any text change breaks enforcement.\n\n` +
    `Steps:\n` +
    `1. Read all existing topic files in ${topicsDir}/ (lessons, preferences, patterns, decisions, completions, mistakes .md). Create dir if missing.\n` +
    `2. Quality gate: skip greetings, trivial Q&A, or <3 exchanges; extract only from sessions with substantive exchanges (>100 chars) and real decisions, corrections, or outcomes.\n` +
    `3. If a session file is provided, extract durable entries:\n` +
    `   - Corrections → [lesson] → lessons.md | Preferences → [preference] → preferences.md\n` +
    `   - Mistakes/repeated fixes → [mistake] → mistakes.md | Outcome knowledge → [done] → completions.md\n` +
    `   - Patterns/conventions → [pattern] → patterns.md | Design decisions → [decision] → decisions.md\n` +
    `3b. Preference queue (${topicsDir}/../preference-candidates.jsonl, if present): distill durable\n` +
    `   standing preferences from verbatim user sentences (#961) into preferences.md; discard the rest.\n` +
    `   Then RE-READ the file and rewrite keeping ONLY entries appended after your first read (concurrent\n` +
    `   appends — never truncate); drop oldest if >200 lines.\n` +
    `4. Past sessions: read ${topicsDir}/../.dream-watermark (if present) and process only newer .jsonl\n` +
    `   files in the pi sessions dir per step 3 (max 5 sessions/cycle).\n` +
    `5. Reorganize each topic file (<20 entries/topic): remove duplicates, near-duplicates, stale\n` +
    `   entries, rule-violating artifacts, and Remove entries that restate git/GitHub/Jira history\n` +
    `   (if mixed with a non-derivable finding, keep only the finding).\n` +
    `6. Topic format:\n` +
    `   # TopicName\n` +
    `   \n` +
    `   - [category] summary *(pinned)* / *(enforced)* / *(pinned)* *(enforced)* / (neither)\n` +
    `7. Skills: for recurring 3+ step workflows, create .pi/skills/<name>/SKILL.md (project-level,\n` +
    `   NOT ~/.agents/) with YAML frontmatter:\n` +
    `   ---\n` +
    `   name: <name>\n` +
    `   description: "<what it does>. Use when <concrete user trigger phrases/keywords>"\n` +
    `   skill-maintenance: auto\n` +
    `   ---\n` +
    `   Pi only loads name+description at startup (body stays hidden until matched), so pack description\n` +
    `   with concrete trigger keywords/phrases users actually type (lead with MANDATORY if always-apply).\n` +
    `   Never put double quotes inside the double-quoted YAML description — use single quotes or drop quotes.\n` +
    `8. Write current ISO timestamp to ${topicsDir}/../.dream-watermark.\n` +
    `9. Promotions: append candidates to ${topicsDir}/../promotions.md:\n` +
    `   ### <12-char-id>\n` +
    `   - destination: memory|skill|enforcement|project_rule|discard\n` +
    `   - status: proposed\n` +
    `   - category: <category>\n` +
    `   - text: <exact topic entry text>\n` +
    `   - reason: <why this should graduate>\n` +
    `   - created: <ISO timestamp>\n` +
    `   Optional: evidence_count, trigger, action, verifier, skill_name, skill_created.\n` +
    `   skill: create .pi/skills/ + set skill_created: true; enforcement: mechanical trigger/action (no run_after);\n` +
    `   project_rule: propose only — NEVER write rules/ or .pi/rules/; discard: stale noise; never reopen applied/rejected.\n` +
    `10. Provenance sidecar (optional): write newly extracted entries to ${topicsDir}/../provenance-pending.jsonl\n` +
    `   as one JSON line: {"entries":[{"category":"lesson","text":"<exact>","sourceSession":"<basename>","derivedFrom":"<opt>","informs":["opt"]}]}\n` +
    `   Do NOT edit state.db or memory-scores.jsonl — onComplete merges the sidecar.`
  );
}

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
  let enabledOverride: boolean | null = null;
  let lastCwd = "";
  let lastCtx: any = null;

  function isAutoDreamEnabled(cwd: string): boolean {
    if (enabledOverride !== null) return enabledOverride;
    return Boolean(getSetting(cwd, "dream_auto_enable"));
  }

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

  function getEffectiveIntervalHours(cwd: string): number {
    const projectHours = getSetting(cwd, "dream_interval_hours");
    return Math.max(0.5, Math.min(24, projectHours));
  }

  function runDreamAsync(cwd: string, lastSessionFile?: string): { started: boolean; id: string; error?: string } {
    if (dreamInFlight) return { started: false, id: "", error: "Dream already running" }; // Prevent concurrent dreams

    const internalOps = getInternalOpsProvider(cwd);
    const dreamProvider = internalOps?.provider;
    const dreamModelId = internalOps?.model;

    dreamInFlight = true;
    log.info("dream start", cwd);
    updateDreamStatus();
    currentDreamId = "";  // Reset until we get the ID from spawnAsyncAgent
    const { agents } = discoverAgents(cwd, "user");
    const topicsDir = path.join(getProjectMemoryDir(cwd), "topics");
    // Snapshot before the dream touches anything: whatever it removes that is learned
    // knowledge rather than re-derivable history is put back below (issue #1010).
    const topicsBeforeDream = snapshotTopicLines(topicsDir);
    const dreamStartedAt = Date.now();
    const { id, error } = spawnAsyncAgent(
      "worker",
      buildDreamPrompt(lastSessionFile, topicsDir),
      cwd,
      agents,
      {
        fireAndForget: true,
        name: "Dream",
        parentModelId: dreamModelId,
        parentProvider: dreamProvider,
        onComplete: () => {
          dreamInFlight = false;
          log.info("dream complete", cwd);
          updateDreamStatus();
          // Undo any deletion of learned knowledge before anything reads the topics.
          try {
            const reviewLessons = distilledLessonTextList(getProjectDataDir(cwd));
            const removed = removalsSince(cwd, dreamStartedAt);
            const report = restoreProtectedTopicLines(topicsDir, topicsBeforeDream, reviewLessons, (line) =>
              removed.has(entryHash(canonicalizeTopicLine(line))),
            );
            if (report.restored > 0) {
              log.warn("dream_restored_protected_entries", { restored: report.restored });
            }
            if (report.overCapTopics.length > 0) {
              log.warn("dream_restore_left_topic_over_cap", { topics: report.overCapTopics });
            }
            if (report.failed > 0) {
              log.error("dream_restore_write_failed", { failedTopics: report.failed });
            }
            if (report.restored > 0 || report.failed > 0 || report.overCapTopics.length > 0) {
              fileLog(
                "dreaming",
                report.failed > 0 ? "error" : "warn",
                "dreaming",
                `protected-memory reconcile: restored=${report.restored} over_cap=${report.overCapTopics.join(",") || "-"} failed=${report.failed}`,
              );
            }
          } catch (err) {
            log.error("dream_restore_failed", { reason: String((err as Error)?.message ?? err).slice(0, 200) });
            fileLog("dreaming", "error", "dreaming", "protected-memory restore failed", err);
          }
          // File log only — console.* leaks into the chat text box.
          try {
            rebuildAndOrganize(cwd);
          } catch (err) {
            fileLog("dreaming", "error", "dreaming", "rebuildAndOrganize failed", err);
          }
          try {
            const n = mergeProvenancePending(cwd);
            if (n > 0) fileLog("dreaming", "info", "dreaming", `merged provenance for ${n} entries`);
          } catch (err) {
            fileLog("dreaming", "error", "dreaming", "provenance merge failed", err);
          }
          try {
            runPromotionPass(cwd);
          } catch (err) {
            fileLog("dreaming", "error", "dreaming", "promotion pass failed", err);
          }
        },
      },
    );
    // Dream runs as fireAndForget async agent.
    // onComplete callback triggers rebuildAndOrganize when dream finishes.
    if (!id || error) {
      dreamInFlight = false;
      currentDreamId = "";
      updateDreamStatus();
      return { started: false, id: "", error: error || "Failed to start dream worker" };
    }
    currentDreamId = id;
    // Safety fallback: if onComplete never fires (runner crash/hang),
    // reset dreamInFlight after 30 min so future dreams aren't blocked.
    // Capture the current dream ID to avoid cross-run races.
    const dreamId = id;
    const fallbackTimer = setTimeout(() => {
      if (dreamInFlight && currentDreamId === dreamId) {
        dreamInFlight = false;
        updateDreamStatus();
        fileLog(
          "dreaming",
          "warn",
          "dreaming",
          "fallback: reset dreamInFlight after 30 min (onComplete never fired)",
        );
      }
    }, 30 * 60 * 1000);
    if (fallbackTimer.unref) fallbackTimer.unref();
    return { started: true, id };
  }

  let rebuildTimer: ReturnType<typeof setInterval> | null = null;

  let currentIntervalMs = 0;

  function startTimer(cwd: string) {
    lastCwd = cwd;

    // Resolve dream interval from project settings
    const clampedHours = getEffectiveIntervalHours(cwd);
    const effectiveMs = clampedHours * 60 * 60 * 1000;

    // Restart timer if interval changed (or first start)
    if (dreamTimer && currentIntervalMs === effectiveMs) return;
    if (dreamTimer) clearInterval(dreamTimer);
    currentIntervalMs = effectiveMs;

    // LLM dreaming
    dreamTimer = setInterval(() => {
      if (lastCwd && isAutoDreamEnabled(lastCwd)) runDreamAsync(lastCwd);
    }, effectiveMs);
    if (dreamTimer.unref) dreamTimer.unref();

    // Scoring rebuild — every 30 min (cheap, no LLM, just rescores + reorganizes topics)
    if (!rebuildTimer) {
      rebuildTimer = setInterval(() => {
        if (lastCwd && isAutoDreamEnabled(lastCwd)) {
          try {
            rebuildAndOrganize(lastCwd);
          } catch (err) {
            fileLog("dreaming", "error", "dreaming", "rebuildAndOrganize failed", err);
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

  function setAutoDream(on: boolean, cwd: string, ctx?: any): string {
    if (on) {
      enabledOverride = true;
      lastCwd = cwd;
      if (ctx) lastCtx = ctx;
      startTimer(cwd);
      const hrs = getEffectiveIntervalHours(cwd);
      return `Auto-dreaming enabled (every ${hrs}h + session end)`;
    }
    enabledOverride = false;
    stopTimer();
    return "Auto-dreaming disabled";
  }

  if (typeof pi.registerTool === "function") {
    pi.registerTool({
      name: "memory_dream",
      label: "Memory Dream",
      exposure: "deferred",
      namespace: TOOL_NAMESPACES.memory,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Inspect background memory dreaming status, trigger consolidation now, or toggle automatic dreaming for this session.",
      parameters: Type.Object({
        action: Type.Union(
          [Type.Literal("status"), Type.Literal("run"), Type.Literal("auto_on"), Type.Literal("auto_off")],
          {
            description:
              "'status' to inspect dreaming state, 'run' to trigger background consolidation now, 'auto_on' / 'auto_off' to enable or disable automatic dreaming.",
          },
        ),
      }),
      async execute(_callId, params, _signal, _onUpdate, ctx) {
        const cwd = ctx?.cwd || lastCwd || process.cwd();
        if (params.action === "status") {
          const autoEnabled = isAutoDreamEnabled(cwd);
          const intervalHours = getEffectiveIntervalHours(cwd);
          const text = [
            `Auto-dreaming: ${autoEnabled ? "enabled" : "disabled"} (interval: ${intervalHours}h + session end)`,
            `Dream in flight: ${dreamInFlight ? `yes (${currentDreamId || "starting"})` : "no"}`,
          ].join("\n");
          log.debug("memory_dream_tool_status", { enabled: autoEnabled, inFlight: dreamInFlight, intervalHours });
          return {
            content: [{ type: "text" as const, text }],
            details: { action: "status", enabled: autoEnabled, inFlight: dreamInFlight, currentDreamId: currentDreamId || null, intervalHours },
          };
        }
        if (params.action === "run") {
          if (dreamInFlight) {
            log.info("memory_dream_tool_already_running", { currentDreamId });
            return {
              content: [{ type: "text" as const, text: "Dream already running — wait for it to finish." }],
              details: { action: "run", ok: false, inFlight: true, id: currentDreamId || null },
            };
          }
          lastCwd = cwd;
          if (ctx) lastCtx = ctx;
          const res = runDreamAsync(cwd);
          if (res.started) {
            log.info("memory_dream_tool_started", { id: res.id });
            return {
              content: [{ type: "text" as const, text: `Started background memory consolidation (job ${res.id}).` }],
              details: { action: "run", ok: true, id: res.id },
            };
          }
          log.error("memory_dream_tool_start_failed", { error: res.error });
          return {
            content: [{ type: "text" as const, text: `Failed to start memory dreaming: ${res.error || "unknown error"}.` }],
            details: { action: "run", ok: false, error: res.error },
          };
        }
        if (params.action === "auto_on") {
          const msg = setAutoDream(true, cwd, ctx);
          log.info("memory_dream_tool_auto", { enabled: true });
          return {
            content: [{ type: "text" as const, text: msg }],
            details: { action: "auto_on", enabled: true },
          };
        }
        if (params.action === "auto_off") {
          const msg = setAutoDream(false, cwd, ctx);
          log.info("memory_dream_tool_auto", { enabled: false });
          return {
            content: [{ type: "text" as const, text: msg }],
            details: { action: "auto_off", enabled: false },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Unknown action "${String(params.action)}". Use "status", "run", "auto_on", or "auto_off".` }],
          details: { ok: false },
        };
      },
    });
  }

  function syncAutoDreamTimer(cwd: string) {
    if (!cwd || lastCtx?.mode === "print" || lastCtx?.mode === "json") return;
    lastCwd = cwd;
    if (isAutoDreamEnabled(cwd)) startTimer(cwd);
    else stopTimer();
  }

  pi.events?.on?.("orchestrator:settings-changed", (data: unknown) => {
    const payload = data as { key?: string; cwd?: string } | undefined;
    if (payload?.key !== "dream_auto_enable" && payload?.key !== "dream_interval_hours") return;
    if (payload.key === "dream_auto_enable") enabledOverride = null;
    const targetCwd = payload.cwd || lastCwd;
    if (targetCwd) {
      log.debug("dream_settings_changed", { key: payload.key, enabled: isAutoDreamEnabled(targetCwd) });
      syncAutoDreamTimer(targetCwd);
    }
  });

  // Set initial dream status on first agent start (fires on /reload too, unlike session_start)
  // and keep timers synchronized with project/global settings if edited mid-session.
  let initialized = false;
  pi.on("before_agent_start", (_event, ctx) => {
    lastCtx = ctx;
    if (ctx.cwd) lastCwd = ctx.cwd;
    if (!initialized) {
      initialized = true;
      updateDreamStatus();
    }
    syncAutoDreamTimer(ctx.cwd);
  });

  // Update cwd on session start
  pi.on("session_start", (_event, ctx) => {
    lastCwd = ctx.cwd;
    lastCtx = ctx;
    enabledOverride = null;
    dreamInFlight = false; // Reset — previous session's dream state doesn't carry over
    // Skip auto-dream timer in print/json; shutdown dream is skipped in
    // session_shutdown via shouldSkipOneshotShutdownDream.
    if (ctx.mode === "print" || ctx.mode === "json") {
      log.debug("skip dream timer: print/json mode");
      return;
    }
    updateDreamStatus();
    syncAutoDreamTimer(ctx.cwd);
  });

  // ── #1481: PiDash manual Dream trigger ─────────────────────────────
  let unsubPidashDream: (() => void) | undefined;
  try {
    const unsub = pi.events.on("pidash:memory-dream-request", (data: unknown) => {
      const payload = (typeof data === "object" && data !== null ? data : {}) as { cwd?: unknown; requestId?: unknown };
      const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
      const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : (lastCwd || process.cwd());
      if (dreamInFlight) {
        log.info("pidash_memory_dream_already_running", { currentDreamId });
        pi.events.emit("pidash:memory-dream-result", {
          requestId,
          ok: false,
          inFlight: true,
          id: currentDreamId || null,
          message: "Dream already running — wait for it to finish.",
        });
        return;
      }
      lastCwd = cwd;
      const res = runDreamAsync(cwd);
      if (res.started) {
        log.info("pidash_memory_dream_started", { id: res.id });
        pi.events.emit("pidash:memory-dream-result", {
          requestId,
          ok: true,
          id: res.id,
          message: `Started background memory consolidation (job ${res.id}).`,
        });
      } else {
        log.warn("pidash_memory_dream_failed", { error: res.error });
        pi.events.emit("pidash:memory-dream-result", {
          requestId,
          ok: false,
          error: res.error,
          message: `Failed to start memory dreaming: ${res.error || "unknown error"}.`,
        });
      }
    });
    if (typeof unsub === "function") unsubPidashDream = unsub;
  } catch (err) {
    log.warn("pidash_memory_dream_subscribe_failed", { error: err instanceof Error ? err.message : String(err) });
  }

  // Shutdown dream: runDreamAsync → spawnAsyncAgent (not detached/unref'd).
  // Skip oneshot print/json or the child keeps the parent event loop alive.
  pi.on("session_shutdown", (event) => {
    stopTimer();
    try { unsubPidashDream?.(); } catch { /* ignore */ }
    unsubPidashDream = undefined;
    if (shouldSkipOneshotShutdownDream(lastCtx?.mode)) {
      log.info("skip shutdown dream: oneshot print/json");
      return;
    }
    if (!lastCwd || !isAutoDreamEnabled(lastCwd) || dreamInFlight) return;

    // Only dream on quit — skip for fork/new/resume/reload since the
    // session continues or transitions, not ending meaningfully.
    if ((event as any).reason && (event as any).reason !== "quit") return;

    try {
      runDreamAsync(lastCwd);
    } catch (err) {
      fileLog("dreaming", "error", "dreaming", "shutdown dream failed", err);
    }
  });
}
