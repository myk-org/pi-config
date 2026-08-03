/**
 * Review loop status — status bar indicator + transcript cards.
 *
 * Status bar: persistent "6-review" key (last in bar, after git).
 * Cards: durable entry renderers via pi.appendEntry (persist across reload,
 * no LLM context cost).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { onStateTransition, readReviewState, markNeedsReview, resetReviewState, type ReviewState } from "./pi-config-review-state.js";
import { ICON_REVIEW_CLEAN, ICON_REVIEW_NEEDED, ICON_REVIEW_PROGRESS, ICON_REVIEW_FINDINGS } from "./icons.js";
import { getSetting } from "./project-settings.js";
import { setSlot, clearSlot } from "./status-bar.js";
import { runGit } from "./git-helpers.js";

interface ReviewStatusData {
  status: ReviewState["status"];
  cycle: number;
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

export function registerReviewUI(pi: ExtensionAPI): void {
  // Register the entry renderer for "review-status" custom type
  pi.registerEntryRenderer<ReviewStatusData>("review-status", (entry, { expanded }, theme) => {
    const data = entry.data ?? {
      status: "none" as const,
      cycle: 0,
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

    let line: string;
    switch (data.status) {
      case "in_progress": {
        const testsIcon = data.tests_passed ? "✅" : "⏳";
        const waiting = data.reviewers_pending.length > 0
          ? ` — waiting: ${data.reviewers_pending.join(", ")}`
          : "";
        line = `🔄 Review cycle ${data.cycle} — ${data.findings_count} findings — tests ${testsIcon}${waiting}`;
        break;
      }
      case "clean": {
        const testsLabel = data.tests_passed ? "tests passed" : "tests pending";
        line = `✅ Review clean — cycle ${data.cycle} — ${testsLabel} — ${data.tests_passed ? "ready to commit" : "awaiting tests"}`;
        break;
      }
      case "needs_review":
        line = `⚠️ Code changed — review needed`;
        break;
      case "has_findings":
        line = `🔍 Review cycle ${data.cycle} — ${data.findings_count} finding${data.findings_count !== 1 ? "s" : ""} — needs fixes`;
        break;
      default:
        line = `📋 Review: ${data.status}`;
    }

    const colorMap: Record<string, string> = {
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
      let color: string;
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
    lastGitSnapshot = runGit(["status", "--porcelain"], ctx.cwd).stdout;
    // If tree is already dirty on session start, ensure review state reflects it
    if (lastGitSnapshot && getSetting(ctx.cwd, "review_loop_enforcement")) {
      const state = readReviewState(ctx.cwd);
      if (state.status === "none" || state.status === "clean") {
        try { markNeedsReview(ctx.cwd); } catch (e: any) { console.debug("[review-ui] markNeedsReview failed:", e?.message); }
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

  // Poll pi-config-review-state.json for cross-process updates (subagents write state too)
  const reviewPoller = setInterval(() => {
    if (!lastCtx) return;
    // Access a ctx property to detect stale/disposed context (throws if invalidated)
    try { void lastCtx.ui.theme; } catch { lastCtx = null; return; }
    try {
      if (!getSetting(lastCtx.cwd, "review_loop_enforcement")) {
        if (lastCtx.hasUI) clearSlot("review", lastCtx);
        lastBarKey = "";
        return;
      }
      updateStatusBar(readReviewState(lastCtx.cwd));
    } catch (e: any) {
      console.debug("[review-ui] poller error:", e?.message);
    }
  }, 5000);
  if (reviewPoller.unref) reviewPoller.unref();

  // Poll git status to detect file changes from CLI/ACPX agents
  const gitDirtyPoller = setInterval(() => {
    if (!lastCtx) return;
    try { void lastCtx.ui.theme; } catch { lastCtx = null; return; }
    try {
      if (!getSetting(lastCtx.cwd, "review_loop_enforcement")) return;
      const result = runGit(["status", "--porcelain"], lastCtx.cwd);
      const snapshot = result.stdout;
      if (snapshot === lastGitSnapshot) return;
      lastGitSnapshot = snapshot;
      if (snapshot) {
        // Dirty tree — markNeedsReview handles all states:
        // none/clean/has_findings → sets needs_review
        // in_progress → sets edited_during_cycle + clears tests_passed
        // needs_review → no-op (deduped internally)
        try { markNeedsReview(lastCtx.cwd); } catch (e: any) { console.debug("[review-ui] markNeedsReview failed:", e?.message); }
      } else if (result.code === 0) {
        // Tree clean AND git succeeded — only reset from terminal state (clean)
        // Never reset during in_progress/has_findings/needs_review — stash/checkout
        // could temporarily empty the tree while review is active
        const state = readReviewState(lastCtx.cwd);
        if (state.status === "clean") {
          try { resetReviewState(lastCtx.cwd); } catch (e: any) { console.debug("[review-ui] resetReviewState failed:", e?.message); }
        }
      }
    } catch { /* best-effort */ }
  }, 3000);
  if (gitDirtyPoller.unref) gitDirtyPoller.unref();

  pi.on("session_shutdown", () => {
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
      findings_count: state.findings_count,
      tests_passed: state.tests_passed,
      reviewers_pending: [...state.reviewers_pending],
      reviewers_total: state.reviewers_total,
      timestamp: Date.now(),
    });
  });
}
