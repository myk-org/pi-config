/**
 * Review loop status — status bar indicator + transcript cards.
 *
 * Status bar: persistent "6-review" key (last in bar, after git).
 * Cards: durable entry renderers via pi.appendEntry (persist across reload,
 * no LLM context cost).
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { createLogger } from "../shared/logger.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { onStateTransition, readReviewState, markNeedsReview, resetReviewState, subjectLabel, type ReviewState } from "./pi-config-review-state.js";
import { ICON_REVIEW_CLEAN, ICON_REVIEW_NEEDED, ICON_REVIEW_PROGRESS, ICON_REVIEW_FINDINGS } from "./icons.js";
import { getSetting } from "./project-settings.js";
import { setSlot, clearSlot } from "./status-bar.js";
import { runGit, getCurrentBranch } from "./git-helpers.js";
import { isBumpVersionBranch, getCachedBranch } from "./enforcement.js";
import { normalizePorcelain } from "./review-porcelain.js";

const log = createLogger("review-ui");

export type AsyncGitStatusRunner = (
  cwd: string,
  cb: (result: { stdout: string; code: number }) => void,
) => void;

export interface ReviewUIOptions {
  /** Override async git status runner (tests). */
  gitStatusAsync?: AsyncGitStatusRunner;
  /** Override git dirty poll interval in ms (tests). */
  gitPollIntervalMs?: number;
}

const defaultGitStatusAsync: AsyncGitStatusRunner = (cwd, cb) => {
  execFile(
    "git",
    ["--no-optional-locks", "status", "--porcelain"],
    {
      cwd,
      timeout: 5000,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      },
    },
    (err, stdout) => {
      const out = typeof stdout === "string" ? stdout.trimEnd() : "";
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      cb({ stdout: out, code });
    },
  );
};

interface ReviewStatusData {
  status: ReviewState["status"];
  cycle: number;
  /** Defaulted for entries written before the subject was recorded. */
  subject?: ReviewState["subject"];
  findings_count: number;
  tests_passed: boolean;
  reviewers_pending: string[];
  reviewers_total: number;
  timestamp: number;
}

// Deduplication — skip append if status hasn't changed
let lastAppendedKey = "";

/** Dedup key shared by status bar and transcript cards. */
function stateKey(s: { status: string; cycle: number; findings_count: number; tests_passed: boolean; reviewers_pending: { length: number } }): string {
  // For needs_review, only status+cycle matter — tests_passed flips shouldn't re-trigger the card
  if (s.status === "needs_review") return `${s.status}:${s.cycle}`;
  return `${s.status}:${s.cycle}:${s.findings_count}:${s.tests_passed}:${s.reviewers_pending.length}`;
}

export { normalizePorcelain } from "./review-porcelain.js";

/** The single-line status summary. Pure so it can be asserted without a TUI: a dropped subject
 *  segment or a broken format would otherwise pass every test. */
export function reviewStatusLine(data: ReviewStatusData): string {
  const subject = subjectLabel(data.subject ?? null);
  switch (data.status) {
    case "in_progress": {
      const testsIcon = data.tests_passed ? "✅" : "⏳";
      const waiting = data.reviewers_pending.length > 0 ? ` — waiting: ${data.reviewers_pending.join(", ")}` : "";
      return `🔄 Review cycle ${data.cycle} — ${subject} — ${data.findings_count} findings — tests ${testsIcon}${waiting}`;
    }
    case "clean": {
      const testsLabel = data.tests_passed ? "tests passed" : "tests pending";
      return `✅ Review clean — cycle ${data.cycle} — ${subject} — ${testsLabel} — ${data.tests_passed ? "ready to commit" : "awaiting tests"}`;
    }
    case "needs_review":
      return `⚠️ Code changed — review needed`;
    case "has_findings":
      return `🔍 Review cycle ${data.cycle} — ${subject} — ${data.findings_count} finding${data.findings_count !== 1 ? "s" : ""} — needs fixes`;
    default:
      return `📋 Review: ${data.status}`;
  }
}

export function registerReviewUI(pi: ExtensionAPI, options: ReviewUIOptions = {}): void {
  const gitStatusAsync = options.gitStatusAsync ?? defaultGitStatusAsync;
  const gitPollIntervalMs = options.gitPollIntervalMs ?? 3000;
  // Register the entry renderer for "review-status" custom type
  pi.registerEntryRenderer<ReviewStatusData>("review-status", (entry, { expanded }, theme) => {
    const data = entry.data ?? {
      status: "none" as const,
      cycle: 0,
      subject: null,
      findings_count: 0,
      tests_passed: false,
      reviewers_pending: [],
      reviewers_total: 0,
      timestamp: Date.now(),
    };

    if (data.status === "none") {
      return new Box(0, 0, (text) => text);
    }

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));

    const line = reviewStatusLine(data);

    const colorMap: Record<string, ThemeColor> = {
      in_progress: "accent",
      clean: "success",
      needs_review: "warning",
      has_findings: "error",
    };
    const color = colorMap[data.status] || "dim";
    box.addChild(new Text(theme.fg(color, line), 0, 0));

    if (expanded && data.timestamp) {
      box.addChild(new Text(theme.fg("dim", new Date(data.timestamp).toLocaleString()), 0, 1));
    }

    return box;
  });

  // ── Status bar indicator ─────────────────────────────────────────────

  let lastCtx: ExtensionContext | null = null;
  let lastBarKey = "";
  let lastGitSnapshot = "";

  function updateStatusBar(state: ReviewState): void {
    if (!lastCtx?.hasUI) return;
    try {
      const ctx = lastCtx;

      let label: string;
      let color: ThemeColor;
      switch (state.status) {
        case "none":
          clearSlot("review", ctx);
          lastBarKey = "";
          return;
        case "needs_review":
          label = `${ICON_REVIEW_NEEDED} review needed`;
          color = "warning";
          break;
        case "in_progress": {
          const pending = state.reviewers_pending.length;
          const total = state.reviewers_total;
          label = `${ICON_REVIEW_PROGRESS} review ${total - pending}/${total}`;
          color = "accent";
          break;
        }
        case "has_findings":
          label = `${ICON_REVIEW_FINDINGS} ${state.findings_count} finding${state.findings_count !== 1 ? "s" : ""}`;
          color = "error";
          break;
        case "clean":
          label = state.tests_passed ? `${ICON_REVIEW_CLEAN} ready` : `${ICON_REVIEW_CLEAN} review clean`;
          color = "success";
          break;
        default:
          label = `${ICON_REVIEW_PROGRESS} ${state.status}`;
          color = "dim";
      }

      const barKey = stateKey(state);
      if (barKey === lastBarKey) return;
      lastBarKey = barKey;
      setSlot("review", ctx.ui.theme.fg(color, label), ctx);
    } catch { /* stale ctx after session replacement */ }
  }

  // Capture ctx and show current state on load
  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    // Initialize git snapshot for dirty detection
    lastGitSnapshot = normalizePorcelain(runGit(["status", "--porcelain"], ctx.cwd).stdout);
    // If tree is already dirty on session start, ensure review state reflects it
    if (lastGitSnapshot && getSetting(ctx.cwd, "review_loop_enforcement") && !isBumpVersionBranch(getCurrentBranch(ctx.cwd))) {
      const state = readReviewState(ctx.cwd);
      if (state.status === "none" || state.status === "clean") {
        try { markNeedsReview(ctx.cwd); } catch (e: any) { log.warn("markNeedsReview failed", { error: e?.message }); }
      }
    }
    if (getSetting(ctx.cwd, "review_loop_enforcement")) {
      updateStatusBar(readReviewState(ctx.cwd));
    } else if (ctx.hasUI) {
      clearSlot("review", ctx);
      lastBarKey = "";
    }
  });
  pi.on("agent_end", (_event, ctx) => { lastCtx = ctx; });

  // Poll pi-config-review-state.jsonl for cross-process updates (subagents write state too)
  const reviewPoller = setInterval(() => {
    if (!lastCtx) return;
    if (!isLiveExtensionCtx(lastCtx)) { lastCtx = null; return; }
    try {
      if (!getSetting(lastCtx.cwd, "review_loop_enforcement")) {
        if (lastCtx.hasUI) clearSlot("review", lastCtx);
        lastBarKey = "";
        return;
      }
      updateStatusBar(readReviewState(lastCtx.cwd));
    } catch (e: any) {
      log.warn("poller error", { error: e?.message });
    }
  }, 5000);
  if (reviewPoller.unref) reviewPoller.unref();

  // Poll git status asynchronously to detect file changes from external tools/processes without blocking TUI.
  // Track the persisted monotonic `edit_seq` revision across both async git status checks so an
  // intervening edit (in-process or cross-process, even in the same millisecond) is never cleared.
  let gitPollInFlight = false;

  const gitDirtyPoller = setInterval(() => {
    if (!lastCtx || gitPollInFlight) return;
    if (!isLiveExtensionCtx(lastCtx)) { lastCtx = null; return; }
    const ctx = lastCtx;
    const cwd = ctx.cwd;
    let startEditSeq: number;
    try {
      if (!getSetting(cwd, "review_loop_enforcement")) return;
      // Skip on version bump branches (release workflow only)
      if (isBumpVersionBranch(getCachedBranch(cwd))) return;
      startEditSeq = readReviewState(cwd).edit_seq ?? 0;
    } catch (e: any) {
      log.warn("gitDirtyPoller precheck error", { error: e?.message });
      return;
    }

    gitPollInFlight = true;
    gitStatusAsync(cwd, (result) => {
      if (!lastCtx || lastCtx !== ctx || !isLiveExtensionCtx(lastCtx)) {
        gitPollInFlight = false;
        return;
      }
      try {
        if (!getSetting(cwd, "review_loop_enforcement") || isBumpVersionBranch(getCachedBranch(cwd))) {
          gitPollInFlight = false;
          return;
        }
        const snapshot = normalizePorcelain(result.stdout);
        if (snapshot === lastGitSnapshot) {
          gitPollInFlight = false;
          return;
        }
        if (snapshot) {
          lastGitSnapshot = snapshot;
          gitPollInFlight = false;
          // Dirty tree — markNeedsReview handles all states:
          // none/clean/has_findings → sets needs_review
          // in_progress → sets edited_during_cycle + clears tests_passed
          // needs_review → bumps edit_seq without duplicate transition notifications
          try { markNeedsReview(cwd); } catch (e: any) { log.warn("markNeedsReview failed", { error: e?.message }); }
          return;
        }
        if (result.code !== 0) {
          gitPollInFlight = false;
          return;
        }
        // Tree appeared clean — reject stale snapshots if any edit landed after the poll started.
        const state = readReviewState(cwd);
        const currentEditSeq = state.edit_seq ?? 0;
        if (currentEditSeq !== startEditSeq) {
          gitPollInFlight = false;
          return;
        }
        // Always revalidate cleanliness (including during in_progress/none) before clearing
        // lastGitSnapshot or resetting review state, so an edit landing between checks is never hidden.
        const preRevalidateEditSeq = currentEditSeq;
        gitStatusAsync(cwd, (confirm) => {
          gitPollInFlight = false;
          if (!lastCtx || lastCtx !== ctx || !isLiveExtensionCtx(lastCtx)) return;
          try {
            if (!getSetting(cwd, "review_loop_enforcement") || isBumpVersionBranch(getCachedBranch(cwd))) return;
            const confirmSnapshot = normalizePorcelain(confirm.stdout);
            if (confirmSnapshot) {
              lastGitSnapshot = confirmSnapshot;
              try { markNeedsReview(cwd); } catch (e: any) { log.warn("markNeedsReview failed", { error: e?.message }); }
              return;
            }
            if (confirm.code !== 0) return;
            const freshState = readReviewState(cwd);
            const freshEditSeq = freshState.edit_seq ?? 0;
            if (freshEditSeq !== startEditSeq || freshEditSeq !== preRevalidateEditSeq) {
              return;
            }
            lastGitSnapshot = "";
            if (freshState.status === "clean" || freshState.status === "needs_review" || freshState.status === "has_findings") {
              try { resetReviewState(cwd); } catch (e: any) { log.warn("resetReviewState failed", { error: e?.message }); }
            }
          } catch (e: any) {
            log.warn("gitDirtyPoller confirm error", { error: e?.message });
          }
        });
      } catch (e: any) {
        gitPollInFlight = false;
        log.warn("gitDirtyPoller error", { error: e?.message });
      }
    });
  }, gitPollIntervalMs);
  if (gitDirtyPoller.unref) gitDirtyPoller.unref();

  pi.on("session_shutdown", () => {
    lastCtx = null;
    clearInterval(reviewPoller);
    clearInterval(gitDirtyPoller);
  });

  // ── Hook into review state transitions ───────────────────────────────

  onStateTransition((state: ReviewState) => {
    // Always update status bar
    if (lastCtx && getSetting(lastCtx.cwd, "review_loop_enforcement")) {
      updateStatusBar(state);
    }

    if (state.status === "none") {
      lastAppendedKey = "";
      return;
    }

    // Card only shows on status change — not on tests_passed/findings/pending changes
    if (state.status === lastAppendedKey) return;
    lastAppendedKey = state.status;

    pi.appendEntry<ReviewStatusData>("review-status", {
      status: state.status,
      cycle: state.cycle,
      subject: state.subject,
      findings_count: state.findings_count,
      tests_passed: state.tests_passed,
      reviewers_pending: [...state.reviewers_pending],
      reviewers_total: state.reviewers_total,
      timestamp: Date.now(),
    });
  });
}
