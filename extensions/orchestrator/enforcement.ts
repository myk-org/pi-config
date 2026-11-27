/**
 * Enforcement hook adapter — thin Pi extension wiring over `bash-policy.ts`,
 * `enforcement-rules.ts`, and `pi-config-review-state.ts`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path, { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.js";
import { READ_ONLY_LOCAL_ANNOTATIONS, TOOL_NAMESPACES } from "../shared/tool-namespaces.js";
import { createBridgedUi } from "../shared/ui-bridge.js";
import {
  clearDangerousSessionApprovals,
  evaluateBashPolicy,
  evaluateFileWritePolicy,
  failedFileEditSkipMessage,
  getCachedBranch,
  isBumpVersionBranch,
  isTestRunnerCommand,
  resolveCommentSignatureModelId,
  resolveCommitTrailerModelId,
  resolveEffectiveCwd,
  type BashPolicyUi,
} from "./bash-policy.js";
import { executeAction, loadEnforcedEntries, matchBashCommand, matchToolCall } from "./enforcement-rules.js";
import {
  isCommitAllowed,
  markNeedsReview,
  markTestsFailed,
  markTestsPassed,
  readReviewState,
  statePath,
  subjectLabel,
} from "./pi-config-review-state.js";
import { getSetting, nearestRealPath } from "./project-settings.js";
import {
  clearSessionApprovals as clearRestrictedFolderSessionApprovals,
  evaluateRestrictedFolderAccess,
  forgetApprovals,
  isProtectedApprovalKeyPath,
  loadRestrictedFolders,
  normalizeToolPath,
} from "./restricted-folders.js";
import { getProjectStateDbPath } from "./state-db.js";
import { getProjectTmpDir, resolveWorktreeRoot } from "./utils.js";

const log = createLogger("enforcement");

export { isBumpVersionBranch, getCachedBranch };

// Repeat detection via temp file — immune to module reload / closure issues.
let REPEAT_FILE = "";

/** Cached trailer selection for comma-separated commit_trailer values (reset on session_start). */
let cachedTrailerSelection: string | null = null;

function ensureRepeatFile(cwd: string): void {
  if (!REPEAT_FILE) {
    REPEAT_FILE = join(getProjectTmpDir(cwd), `.repeat-${process.pid}.json`);
  }
}

function readRepeatState(): { lastCmd: string; count: number } {
  if (!REPEAT_FILE) return { lastCmd: "", count: 0 };
  try {
    return JSON.parse(readFileSync(REPEAT_FILE, "utf-8"));
  } catch {
    return { lastCmd: "", count: 0 };
  }
}

function writeRepeatState(state: { lastCmd: string; count: number }): void {
  if (!REPEAT_FILE) return;
  try {
    writeFileSync(REPEAT_FILE, JSON.stringify(state));
  } catch (e: any) {
    log.debug("enforcement: write repeat state failed:", e?.message || e);
  }
}

/** Resolve the model id used in commit/PR trailers (env first, then ctx). */
export function commitTrailerModelId(ctx: any): string {
  return resolveCommitTrailerModelId((ctx as any)?.model?.id);
}

/** Session id for session-scoped approvals, or null when this context has none. */
function sessionIdOf(ctx: any): string | null {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.trim() !== "" ? id : null;
  } catch {
    return null;
  }
}

export function registerEnforcement(pi: ExtensionAPI, inContainer?: boolean): void {
  // #968 part B: enforcement prompts (dangerous-command approvals, trailer
  // selection) are bridged — answerable from TUI or pidash browser, first
  // answer wins, same enforcement semantics either way.
  const bridgedUi = createBridgedUi(pi);

  pi.on("session_start", (_event, ctx) => {
    cachedTrailerSelection = null;
    // Prime the monotonic restricted_folders floor at session start before any tool runs.
    loadRestrictedFolders(ctx.cwd);
    if (getSetting(ctx.cwd, "comment_signature")) {
      const modelId = resolveCommentSignatureModelId((ctx as any).model?.id);
      process.env.PI_COMMENT_SIGNATURE = `Assisted-by: PI (${modelId})`;
    } else {
      delete process.env.PI_COMMENT_SIGNATURE;
    }
  });

  // Session-scoped dangerous-command approvals die with the session (issue
  // #1073). "reload" is the one reason that must NOT clear them: it rebinds
  // the extension while the same session keeps running, and the store lives
  // on globalThis precisely so the grants survive that.
  pi.on("session_shutdown", (event: any, ctx: any) => {
    if (event?.reason === "reload") return;
    const sessionId = sessionIdOf(ctx);
    clearDangerousSessionApprovals(sessionId);
    const clearedRestricted = clearRestrictedFolderSessionApprovals(sessionId);
    log.debug("dangerous_session_approvals_cleared", { reason: event?.reason, hasSessionId: sessionId !== null });
    if (clearedRestricted > 0) {
      log.debug("restricted_folder_session_approvals_cleared", {
        reason: event?.reason,
        cleared: clearedRestricted,
      });
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    // Memory-based enforcement — block rules checked before execution (all tool types).
    try {
      const entries = loadEnforcedEntries(ctx.cwd, (ctx as any).sessionManager?.getSessionId?.());
      const blockEntries = entries.filter((e) => e.action === "block");
      if (blockEntries.length > 0) {
        const toolName = isToolCallEventType("bash", event)
          ? "bash"
          : isToolCallEventType("write", event)
            ? "write"
            : isToolCallEventType("edit", event)
              ? "edit"
              : isToolCallEventType("read", event)
                ? "read"
                : (event as any).toolName || "";
        const input = (event as any).input || {};
        const matches = matchToolCall(blockEntries, toolName, input);
        if (matches.length > 0) {
          const rule = matches[0].rule;
          log.info("enforcement_block", toolName, rule.text);
          return { block: true, reason: `⛔ ENFORCEMENT [${rule.entry.class}]: ${rule.text}` };
        }
      }
    } catch {
      /* enforcement should never break normal flow */
    }

    const ui: BashPolicyUi | null = ctx.hasUI
      ? {
          select: (title, options) => bridgedUi.select(ctx, title, options, { blockedKind: "permission" }),
          notify: (message, level) => ctx.ui.notify(message, level),
        }
      : null;

    // Direct edit/write guards.
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const toolUsed = isToolCallEventType("edit", event) ? "edit" : "write";
      if (process.env.PI_SUBAGENT_CHILD !== "1" && getSetting(ctx.cwd, "orchestrator_edit_write_block")) {
        return {
          block: true,
          reason: `⛔ Orchestrator cannot use ${toolUsed} directly. Delegate to the appropriate specialist subagent via the subagent tool.`,
        };
      }

      const filePath: string | undefined = (event as any).input?.path;
      if (filePath) {
        const cleanFilePath = normalizeToolPath(filePath);
        if (isProtectedApprovalKeyPath(cleanFilePath, ctx.cwd)) {
          return {
            block: true,
            reason: "⛔ Direct access to .approval-hmac-key is blocked. Approval integrity keys are managed exclusively by the enforcement system.",
          };
        }
        const resolvedPath = resolve(ctx.cwd, cleanFilePath);
        const realResolvedPath = nearestRealPath(resolvedPath);
        const reviewDbPath = statePath(ctx.cwd);
        const reviewDataDir = dirname(reviewDbPath);
        const projectDbPath = getProjectStateDbPath(ctx.cwd);
        const protectedStatePaths = new Set([
          reviewDbPath,
          `${reviewDbPath}-wal`,
          `${reviewDbPath}-shm`,
          projectDbPath,
          `${projectDbPath}-wal`,
          `${projectDbPath}-shm`,
          nearestRealPath(reviewDbPath),
          nearestRealPath(projectDbPath),
          join(reviewDataDir, "pi-config-review-state.jsonl"),
          join(reviewDataDir, "pi-config-review-state.json"),
          join(resolveWorktreeRoot(ctx.cwd), ".pi", "run", "review-tracked"),
        ]);
        if (protectedStatePaths.has(resolvedPath) || protectedStatePaths.has(realResolvedPath)) {
          return {
            block: true,
            reason: "⛔ Direct modification of enforcement/review state storage (state.db / pi-config-review-state) blocked. State storage is managed by the enforcement system.",
          };
        }
        const writeDecision = evaluateFileWritePolicy(cleanFilePath, ctx.cwd);
        if (writeDecision) return writeDecision;
      }

      const restrictedWrite = await evaluateRestrictedFolderAccess({
        toolName: toolUsed,
        input: (event as any).input || {},
        cwd: ctx.cwd,
        sessionId: sessionIdOf(ctx),
        ui,
      });
      if (restrictedWrite) return restrictedWrite;
      return undefined;
    }

    // Restricted folder & HMAC key checks for read and search tools (read/grep/find/ls).
    if (
      isToolCallEventType("read", event) ||
      isToolCallEventType("grep", event) ||
      isToolCallEventType("find", event) ||
      isToolCallEventType("ls", event)
    ) {
      const targetPath: string | undefined = (event as any).input?.path;
      if (targetPath && isProtectedApprovalKeyPath(targetPath, ctx.cwd)) {
        return {
          block: true,
          reason: "⛔ Direct access to .approval-hmac-key is blocked. Approval integrity keys are managed exclusively by the enforcement system.",
        };
      }
      const restrictedRead = await evaluateRestrictedFolderAccess({
        toolName: event.toolName,
        input: (event as any).input || {},
        cwd: ctx.cwd,
        sessionId: sessionIdOf(ctx),
        ui,
      });
      if (restrictedRead) return restrictedRead;
      return undefined;
    }

    if (!isToolCallEventType("bash", event)) return undefined;

    const decision = await evaluateBashPolicy({
      command: event.input.command,
      cwd: ctx.cwd,
      hasTimeout: Boolean(event.input.timeout),
      inContainer,
      isSubagentChild: process.env.PI_SUBAGENT_CHILD === "1",
      agentName: process.env.PI_AGENT_NAME,
      ctxModelId: (ctx as any).model?.id,
      sessionId: sessionIdOf(ctx),
      ui,
      trailerSelection: {
        get: () => cachedTrailerSelection,
        set: (value: string) => {
          cachedTrailerSelection = value;
        },
      },
      trackRepeat: (normalized) => {
        ensureRepeatFile(ctx.cwd);
        const rs = readRepeatState();
        if (normalized === rs.lastCmd) {
          rs.count++;
          writeRepeatState(rs);
          return rs.count;
        }
        writeRepeatState({ lastCmd: normalized, count: 1 });
        return 1;
      },
      checkReviewLoopCommit: (gitCwd, branch) => {
        if (!isBumpVersionBranch(branch) && getSetting(gitCwd, "review_loop_enforcement") && !isCommitAllowed(gitCwd)) {
          const state = readReviewState(gitCwd);
          const testInfo =
            state.status === "clean" && !state.tests_passed
              ? " Tests have not passed yet — run tests before committing."
              : "";
          const reviewAdvice =
            state.status !== "clean" ? " Fix findings and re-run all reviewers until 0 comments." : "";
          return {
            block: true,
            reason: `⛔ Review loop incomplete (status: ${state.status}, cycle ${state.cycle}, ${state.findings_count} findings, ${state.reviewers_pending.length} reviewers pending, tests_passed: ${state.tests_passed}).${testInfo}${reviewAdvice}`,
          };
        }
        return undefined;
      },
    });

    if (decision.action === "block") {
      return { block: true, reason: decision.reason };
    }
    const effectiveCommand = decision.modifiedCommand ?? event.input.command;
    const restrictedBash = await evaluateRestrictedFolderAccess({
      toolName: "bash",
      input: { ...event.input, command: effectiveCommand },
      cwd: ctx.cwd,
      sessionId: sessionIdOf(ctx),
      ui,
    });
    if (restrictedBash) return restrictedBash;
    if (decision.stripTimeout) {
      delete event.input.timeout;
    }
    if (decision.modifiedCommand !== undefined) {
      event.input.command = decision.modifiedCommand;
    }
    return undefined;
  });

  // ── Memory-based enforcement (tool_result hook) ───────────────────
  pi.on("tool_result", async (event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD === "1") return;

    const toolName = (event as any).toolName as string;
    const input = (event as any).input || {};

    let entries: ReturnType<typeof loadEnforcedEntries>;
    try {
      entries = loadEnforcedEntries(ctx.cwd, (ctx as any).sessionManager?.getSessionId?.());
    } catch (e: any) {
      log.debug("enforcement: loadEnforcedEntries failed:", e?.message?.slice(0, 100));
      return;
    }
    log.info("enforcement_loaded", entries.length);
    if (entries.length === 0) return;

    const isToolCallError = (event as any).isError === true;
    if (isToolCallError && (toolName === "edit" || toolName === "write") && input?.path) {
      failedFileEditSkipMessage(toolName, input.path);
    }
    const matches = matchToolCall(entries, toolName, input, isToolCallError);

    if (toolName === "subagent") {
      const details = (event as any).details;
      const results = Array.isArray(details?.results) ? details.results : [];
      if (!Array.isArray(details?.results) && details?.results) {
        log.debug(`enforcement: subagent details.results is ${typeof details.results} (expected array), skipping bash extraction`);
      }
      const nonBlockEntries = entries.filter((e) => e.action !== "block");
      const seen = new Set<string>();
      const bashCommands: string[] = [];
      for (const r of results) {
        const msgs = Array.isArray(r?.messages) ? r.messages : [];
        const erroredCalls = new Set<string>();
        const resolvedCalls = new Set<string>();
        for (const msg of msgs) {
          if (msg?.role !== "toolResult") continue;
          if (typeof (msg as any).toolCallId === "string") {
            resolvedCalls.add((msg as any).toolCallId);
          }
          if ((msg as any).isError === true && typeof (msg as any).toolCallId === "string") {
            erroredCalls.add((msg as any).toolCallId);
          }
        }
        for (const msg of msgs) {
          if (msg?.role !== "assistant") continue;
          const parts = Array.isArray(msg?.content) ? msg.content : [];
          for (const part of parts) {
            if (part?.type !== "toolCall") continue;
            const partToolName = part?.name || part?.toolName;
            const partToolArgs = part?.arguments || part?.args;
            const partCallId = part?.id ?? part?.toolCallId;
            const partIsError = partCallId !== undefined && erroredCalls.has(partCallId);
            const partUnresolved = partCallId !== undefined && !resolvedCalls.has(partCallId);
            if (partToolName === "bash" && partToolArgs?.command) {
              bashCommands.push(partToolArgs.command);
            }
            if (partToolName && partToolName !== "bash") {
              if (
                partIsError &&
                (partToolName === "edit" || partToolName === "write") &&
                partToolArgs?.path
              ) {
                failedFileEditSkipMessage(partToolName, partToolArgs.path);
              }
              const toolMatches = matchToolCall(
                nonBlockEntries,
                partToolName,
                partToolArgs || {},
                partIsError || partUnresolved,
              );
              for (const m of toolMatches) {
                if (!seen.has(m.rule.hash)) {
                  seen.add(m.rule.hash);
                  matches.push(m);
                }
              }
            }
          }
        }
      }
      if (bashCommands.length > 0) {
        for (const cmd of bashCommands) {
          const cmdMatches = matchBashCommand(nonBlockEntries, cmd);
          for (const m of cmdMatches) {
            if (!seen.has(m.rule.hash)) {
              seen.add(m.rule.hash);
              matches.push(m);
            }
          }
        }
      }
    }

    if (matches.length === 0) return;

    const currentContent = (event as any).content || [];
    const appendMessages: Array<{ type: string; text: string }> = [];

    for (const { rule } of matches) {
      if (rule.action === "block") continue;

      if (rule.action === "run_after" && rule.actionCommand && !(event as any).isError) {
        const result = executeAction(rule.actionCommand, ctx.cwd);
        if (result.success) {
          appendMessages.push({
            type: "text",
            text: `\n✅ Auto-enforced: ${rule.actionCommand}\n${result.output}`,
          });
        } else {
          appendMessages.push({
            type: "text",
            text: `\n❌ Enforcement failed: ${rule.actionCommand}\n${result.output}`,
          });
        }
      }

      if (rule.action === "warn") {
        log.warn("enforcement_warn", toolName, rule.text);
        appendMessages.push({
          type: "text",
          text: `\n⚠️ ENFORCEMENT WARNING: ${rule.text}`,
        });
      }
    }

    if (appendMessages.length > 0) {
      return {
        content: [...currentContent, ...appendMessages],
      };
    }
  });

  // ── Review state tracking (edit/write detection) ────────────────────
  pi.on("tool_result", async (event, ctx) => {
    if (!getSetting(ctx.cwd, "review_loop_enforcement")) return;

    const toolName = (event as any).toolName as string;
    if (toolName !== "edit" && toolName !== "write") return;

    const input = (event as any).input || {};
    const filePath: string | undefined = input.path;
    if (!filePath) return;

    if ((event as any).isError === true) return;

    const absPath = resolve(ctx.cwd, filePath);
    const fileDir = dirname(absPath);
    let effectiveCwd: string;
    try {
      effectiveCwd = resolveWorktreeRoot(fileDir);
    } catch {
      effectiveCwd = ctx.cwd;
    }
    if (isBumpVersionBranch(getCachedBranch(effectiveCwd))) return;
    const relativePath = path.relative(effectiveCwd, absPath);

    try {
      const result = spawnSync("git", ["check-ignore", "-q", relativePath], {
        cwd: effectiveCwd,
        timeout: 3000,
        stdio: "ignore",
      });
      if (result.status === 0) return;
    } catch {
      // git not available or error — proceed with marking (safe default)
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        markNeedsReview(effectiveCwd);
        break;
      } catch (e: any) {
        if (attempt === 2) {
          log.error("markNeedsReview failed after 3 attempts — review state may be stale", e?.message || e);
        }
      }
    }
  });

  // ── Test command detection (auto-mark tests_passed in review state) ──
  pi.on("tool_result", async (event, ctx) => {
    const toolName = (event as any).toolName as string;
    if (toolName !== "bash") return;

    const agentName = process.env.PI_AGENT_NAME || "";
    if (agentName.startsWith("code-reviewer-")) return;

    const command: string = (event as any).input?.command || "";
    if (!command) return;

    if (!isTestRunnerCommand(command)) return;

    const effectiveCwd = resolveEffectiveCwd(command, ctx.cwd);
    if (!getSetting(effectiveCwd, "review_loop_enforcement")) return;

    const isError = (event as any).isError === true;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (isError) {
          markTestsFailed(effectiveCwd);
        } else {
          markTestsPassed(effectiveCwd);
        }
        break;
      } catch (e: any) {
        if (attempt === 2) {
          log.error("markTests(Passed|Failed) failed after 3 attempts", e?.message || e);
        }
      }
    }
  });

  // ── /forget-approvals command (issue #1416) ─────────────────────────
  pi.registerCommand("forget-approvals", {
    description:
      "Clear cached restricted-folder approvals (session and persistent SQLite grants). Optional arg: session | persistent",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim().toLowerCase();
      const mode: "all" | "session" | "persistent" =
        raw === "session" || raw === "persistent" ? raw : "all";
      const { sessionCleared, persistentCleared } = forgetApprovals(
        ctx.cwd,
        sessionIdOf(ctx),
        mode,
      );
      const summary = `Cleared ${sessionCleared} session approval(s) and ${persistentCleared} persistent approval(s).`;
      if (ctx.hasUI) {
        ctx.ui.notify(summary, "info");
      } else {
        log.info("forget_approvals_completed", { mode, sessionCleared, persistentCleared });
      }
    },
  });

  // ── /review-status command ──────────────────────────────────────────
  pi.registerCommand("review-status", {
    description: "Show current review loop enforcement state. Pass optional worktree path to check its state.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const worktreePath = args?.trim() || "";
      const targetCwd = worktreePath ? resolve(ctx.cwd, worktreePath) : ctx.cwd;
      const state = readReviewState(targetCwd);
      const enabled = getSetting(ctx.cwd, "review_loop_enforcement");
      ctx.ui.notify(formatReviewStateSummary(state, enabled, { mode: "ui", worktreePath }), "info");
    },
  });

  // ── review_status tool — LLM-callable read-only access to review state ──
  pi.registerTool({
    name: "review_status",
    label: "Review Status",
    exposure: "deferred",
    namespace: TOOL_NAMESPACES.runtime,
    annotations: READ_ONLY_LOCAL_ANNOTATIONS,
    description:
      "Get current review loop enforcement state. Use to check if review is needed, in progress, clean, or has findings before committing. Pass worktree_path to check a specific worktree's state.",
    parameters: Type.Object({
      worktree_path: Type.Optional(
        Type.String({
          description: "Path to a worktree directory to check its review state instead of the main repo",
        }),
      ),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      const targetCwd = params.worktree_path ? resolve(ctx.cwd, params.worktree_path) : ctx.cwd;
      const state = readReviewState(targetCwd);
      const enabled = getSetting(ctx.cwd, "review_loop_enforcement");
      const summary = formatReviewStateSummary(state, enabled, { mode: "tool", worktreePath: params.worktree_path });
      return {
        content: [{ type: "text" as const, text: summary }],
        details: { state, enabled, worktree_path: params.worktree_path || null },
      };
    },
  });
}

export function formatReviewStateSummary(
  state: ReturnType<typeof readReviewState>,
  enabled: boolean,
  opts: { mode: "ui" | "tool"; worktreePath?: string },
): string {
  const pendingStr = `${state.reviewers_pending.length}/${state.reviewers_total}${state.reviewers_pending.length > 0 ? " (" + state.reviewers_pending.join(", ") + ")" : ""}`;
  const enabledStr = enabled ? "enabled" : "disabled";
  if (opts.mode === "ui") {
    const worktreeLabel = opts.worktreePath ? ` (worktree: ${opts.worktreePath})` : "";
    return [
      `Review Loop Enforcement: ${enabledStr}${worktreeLabel}`,
      `Status: ${state.status}`,
      `Subject: ${subjectLabel(state.subject)}`,
      `Cycle: ${state.cycle}`,
      `Findings: ${state.findings_count}`,
      `Reviewers pending: ${pendingStr}`,
      `Edited during cycle: ${state.edited_during_cycle}`,
      `Tests passed: ${state.tests_passed}`,
      `Last edit: ${state.last_edit_at || "none"}`,
      `Last clean: ${state.last_clean_at || "none"}`,
    ].join("\n");
  }
  const prefix = opts.worktreePath ? `worktree: ${opts.worktreePath}\n` : "";
  return [
    `${prefix}enforcement: ${enabledStr}`,
    `status: ${state.status}`,
    `cycle: ${state.cycle}`,
    `findings: ${state.findings_count}`,
    `pending: ${pendingStr}`,
    `edited_during_cycle: ${state.edited_during_cycle}`,
    `tests_passed: ${state.tests_passed}`,
    `last_edit: ${state.last_edit_at || "none"}`,
    `last_clean: ${state.last_clean_at || "none"}`,
  ].join("\n");
}
