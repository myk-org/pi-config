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

import { createLogger } from "../shared/logger.js";

const log = createLogger("dreaming");
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getInternalOpsProvider } from "./async-capability.js";
import { getSetting } from "./project-settings.js";
import { discoverAgents } from "./agents.js";
import { ICON_DREAM } from "./icons.js";
import { setSlot } from "./status-bar.js";
import { distilledLessonTextList } from "./review-learning.js";
import { canonicalTopicLine, invalidateTopicFileCache, parseTopicLine, removalsSince, stripTopicMarkers, topicCharCap } from "./memory-tree.js";
import { entryHash } from "./memory-scoring.js";

/** Topic files memory maintenance rewrites. */
const MEMORY_TOPIC_FILES = ["lessons", "preferences", "patterns", "decisions", "completions", "mistakes"];

/** Line text without its `- [category] ` prefix, lock markers, or `{#id}` suffix. */
function topicLineText(line: string): string {
  const parsed = parseTopicLine(line);
  if (parsed) return parsed.text;
  return stripTopicMarkers(line.replace(/^- \[[a-z]+\] /, ""));
}

/**
 * Entries memory maintenance must never delete, whatever the prompt says:
 * pinned/enforced entries (user-locked, or keyed by text hash for enforcement) and
 * lessons distilled from reviews — their source is the reviews DB, but nothing
 * re-materializes the topic line once a dream removes it (issue #1010).
 */
export function isProtectedTopicLine(line: string, reviewLessons: readonly string[]): boolean {
  if (!line.startsWith("- [")) return false;
  if (line.includes("*(pinned)*") || line.includes("*(enforced)*")) return true;
  const text = topicLineText(line);
  return reviewLessons.some((lesson) => {
    const candidate = lesson.trim();
    return candidate.length > 0 && text === candidate;
  });
}

/** Snapshot every memory topic file's lines, so a dream's deletions can be audited. */
export function snapshotTopicLines(topicsDir: string): Record<string, string[]> {
  const before: Record<string, string[]> = {};
  for (const name of MEMORY_TOPIC_FILES) {
    try {
      before[`${name}.md`] = fs.readFileSync(path.join(topicsDir, `${name}.md`), "utf-8").split("\n");
    } catch {
      // Topic absent — nothing to protect.
    }
  }
  return before;
}

/**
 * Restore protected entries a dream removed, at their original index. Returns how
 * many lines were put back; zero means the dream stayed inside its mandate.
 * Any failure is the caller's to log — this never throws.
 */
/** Canonical `- [category] text` form used as the memory score key. */
export function topicLineCanonical(line: string): string {
  const parsed = parseTopicLine(line);
  if (parsed) return canonicalTopicLine(parsed);
  const category = /^- \[([a-z]+)\] /.exec(line)?.[1] ?? "";
  return `- [${category}] ${topicLineText(line)}`;
}

export type TopicRestoreReport = {
  restored: number;
  failed: number;
  /** Topics still over their cap after reconcile. Never trimmed here: see below. */
  overCapTopics: string[];
};

/**
 * Restore protected entries a dream removed, at their original index, then keep the
 * file inside its per-topic cap by dropping unprotected additions — never protected
 * ones. Recreates a topic the dream deleted outright. Returns what it did; logging is
 * the caller's, this never throws.
 */
export function restoreProtectedTopicLines(
  topicsDir: string,
  before: Record<string, string[]>,
  reviewLessons: readonly string[],
  removedByUser: (line: string) => boolean = () => false,
): TopicRestoreReport {
  const report: TopicRestoreReport = { restored: 0, failed: 0, overCapTopics: [] };
  for (const [file, beforeLines] of Object.entries(before)) {
    const filePath = path.join(topicsDir, file);
    let current: string[] | null = null;
    try {
      current = fs.readFileSync(filePath, "utf-8").split("\n");
    } catch {
      current = null; // Deleted outright — rebuilt below from the snapshot.
    }
    const base = current ?? beforeLines.filter((line) => !line.startsWith("- ["));
    // A dream that *rewrites* a protected entry keeps it: compare canonical text, not the
    // raw line, or the original returns beside the rewrite as a duplicate.
    const surviving = new Set((current ?? []).map(topicLineCanonical));
    const missing = beforeLines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => {
        if (!line.startsWith("- [") || !isProtectedTopicLine(line, reviewLessons)) return false;
        if (surviving.has(topicLineCanonical(line))) return false;
        // Only an explicit tombstone proves a removal. Score absence does not: the
        // scheduled rebuild prunes scores for lines a dream deleted, which would look
        // exactly like a user removal and strand the entry (issue #1010).
        return !removedByUser(line);
      });
    if (missing.length === 0 && current !== null) continue;

    const merged = [...base];
    for (const { line, index } of missing) {
      merged.splice(Math.min(index, merged.length), 0, line);
      report.restored += 1;
    }

    const cap = topicCharCap(file.replace(/\.md$/, ""));
    // Never trim here. Text cannot distinguish a dream's addition from its rewrite of an
    // existing memory, and deleting the wrong one loses knowledge that the score rebuild
    // cannot recover. The write paths still enforce the cap for normal additions; an
    // over-cap file is reported so the next prune can shrink it with judgment.
    if (merged.join("\n").length > cap) report.overCapTopics.push(file);

    try {
      fs.writeFileSync(filePath, merged.join("\n"), "utf-8");
      invalidateTopicFileCache(filePath);
    } catch {
      report.failed += 1;
      report.restored -= missing.length;
    }
  }
  return report;
}

import { rebuildAndOrganize } from "./situation-report.js";
import { runPromotionPass } from "./memory-promotion.js";
import { mergeProvenancePending } from "./memory-provenance.js";
import { getProjectMemoryDir, getProjectDataDir, shouldSkipOneshotShutdownDream } from "./utils.js";
import { fileLog } from "../shared/file-logger.js";

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
    `   description: "What this skill does and when to use it"\n` +
    `   skill-maintenance: auto\n` +
    `   ---\n` +
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
    `   Do NOT edit memory-scores.jsonl — onComplete merges the sidecar.`
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
    const { id } = spawnAsyncAgent(
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
              removed.has(entryHash(topicLineCanonical(line))),
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
          fileLog(
            "dreaming",
            "warn",
            "dreaming",
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
    // Skip auto-dream timer in print/json; shutdown dream is skipped in
    // session_shutdown via shouldSkipOneshotShutdownDream.
    if (ctx.mode === "print" || ctx.mode === "json") {
      log.debug("skip dream timer: print/json mode");
      return;
    }
    updateDreamStatus();
    if (enabled) startTimer(ctx.cwd);
  });

  // Shutdown dream: runDreamAsync → spawnAsyncAgent (not detached/unref'd).
  // Skip oneshot print/json or the child keeps the parent event loop alive.
  pi.on("session_shutdown", (event) => {
    stopTimer();
    if (shouldSkipOneshotShutdownDream(lastCtx?.mode)) {
      log.info("skip shutdown dream: oneshot print/json");
      return;
    }
    if (!enabled || !lastCwd || dreamInFlight) return;

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
