/**
 * Mechanical pre-compaction elision of old bulky tool results (issue #1421).
 *
 * Deterministic, zero-LLM-cost elision integrated into BOTH:
 * 1. `turn_end` boundary drafts (`context_edit` entries) — commits elisions into Pi's
 *    canonical session projection BEFORE Pi's automatic compaction checks
 *    (`_compactBeforeNextAssistantResponse` and `_checkCompaction`), so Pi recalculates
 *    projected context tokens from the reduced messages and avoids expensive LLM compaction.
 * 2. `context` hook — safety-net transform for pre-existing un-edited transcripts or
 *    non-boundary callers, remaining a zero-mutation no-op on ordinary turns below
 *    `pre_compaction_elision_threshold_pct` so prompt caches stay intact.
 *
 * Conservative invariants:
 * - Protects complete recent user turns (`pre_compaction_elision_keep_turns`), so
 *   multi-step assistant/tool exchanges inside the current user request are never elided.
 * - Only elides `toolResult` text blocks outside the protected window and at least
 *   `pre_compaction_elision_min_chars` characters long.
 * - Never touches user messages, assistant prose, thinking/reasoning blocks, images,
 *   small tool results, or message ordering / toolCall-toolResult pairing.
 * - Always backs every elided payload with a durable spill file (reusing a verified
 *   in-process spill record created by `session-spill.ts` for that session/block, never
 *   trusting forged paths embedded in tool output or details) — skips elision if spill
 *   persistence fails.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { createLogger, type Logger } from "../shared/logger.js";
import { getSetting } from "./project-settings.js";
import {
  countLines,
  lookupTrustedSpill,
  resolveSessionSpillDir,
  writeSessionSpill,
  type VerifiedSpillReference,
} from "./session-spill.js";

const defaultLog = createLogger("orchestrator");

const ELIDED_PREFIX = "[toolResult elided:";
const CHARS_PER_TOKEN = 4;
const ESTIMATED_TOKENS_PER_IMAGE = 1000;

export interface ElisionOptions {
  sessionKey?: string;
  keepTurns: number;
  minChars: number;
  spillDir: string;
  elidedBlocks: Map<string, string>;
  allowNewElisions: boolean;
  log?: Logger;
}

export interface ElisionResult {
  messages: AgentMessage[];
  changed: boolean;
  modifiedIndices: number[];
  newlyElided: number;
  replayedElided: number;
  charsReclaimed: number;
}

export interface RegisterPreCompactionElisionOptions {
  log?: Logger;
}

function isToolResultMessage(msg: AgentMessage | undefined): msg is ToolResultMessage {
  return Boolean(msg && typeof msg === "object" && (msg as any).role === "toolResult");
}

function isUserTurnStartMessage(msg: AgentMessage | undefined): boolean {
  if (!msg || typeof msg !== "object") return false;
  switch ((msg as any).role) {
    case "user":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return true;
    default:
      return false;
  }
}

function isAlreadyElidedText(text: string): boolean {
  return text.startsWith(ELIDED_PREFIX);
}

function makeBlockKey(msg: ToolResultMessage, msgIndex: number, blockIndex: number): string {
  const id = typeof msg.toolCallId === "string" && msg.toolCallId ? msg.toolCallId : `idx-${msgIndex}`;
  return `${id}:${blockIndex}`;
}

/**
 * Find the starting index of the protected recent-turn window by walking backwards
 * across user-turn boundaries (matching Pi's `isTurnStartMessage`). Everything at
 * index >= return value is protected, including every assistant/tool exchange inside
 * those recent user turns.
 */
export function findProtectedTurnStartIndex(messages: readonly AgentMessage[], keepTurns: number): number {
  if (keepTurns <= 0) return messages.length;
  let userTurns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserTurnStartMessage(messages[i])) {
      userTurns++;
      if (userTurns >= keepTurns) return i;
    }
  }
  return 0;
}

/**
 * Rough token estimator for fallback when `ctx.getContextUsage()` returns `tokens: null`.
 * Accounts for already-elided placeholders so fallback estimates reflect the elided transcript.
 */
export function estimateMessagesTokens(
  messages: readonly AgentMessage[],
  elidedBlocks?: ReadonlyMap<string, string>,
): number {
  let chars = 0;
  let imageCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as any;
    if (!msg || typeof msg !== "object") continue;

    if (typeof msg.content === "string") {
      chars += msg.content.length;
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const isTr = msg.role === "toolResult";
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        if (isTr && elidedBlocks) {
          const cached = elidedBlocks.get(makeBlockKey(msg, i, j));
          if (cached !== undefined) {
            chars += cached.length;
            continue;
          }
        }
        chars += block.text.length;
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        chars += block.thinking.length;
      } else if (block.type === "toolCall") {
        chars += (block.name?.length ?? 0) + (block.arguments ? JSON.stringify(block.arguments).length : 0);
      } else if (block.type === "image") {
        imageCount++;
      }
    }
  }

  return Math.ceil(chars / CHARS_PER_TOKEN) + imageCount * ESTIMATED_TOKENS_PER_IMAGE;
}

/**
 * Reuse an existing spill file ONLY when it is verified in our authoritative session
 * spill registry (matching session, toolCallId, blockIndex, preview SHA-256, and
 * non-symlink path containment inside `spillDir`). Forged markers in tool output or
 * tool-controlled details are never trusted.
 */
function findVerifiedReusableSpill(
  sessionKey: string,
  msg: ToolResultMessage,
  blockIndex: number,
  text: string,
  spillDir: string,
): VerifiedSpillReference | null {
  return lookupTrustedSpill(sessionKey, msg.toolCallId, blockIndex, text, spillDir);
}

function formatElidedPlaceholder(
  toolName: string,
  originalChars: number,
  originalLines: number,
  spillPath: string,
): string {
  return `[toolResult elided: tool=${toolName} (${originalChars} chars, ${originalLines} lines) — full output saved to: ${spillPath} — use read(path, offset, limit) if needed]`;
}

/**
 * Pure-ish mechanical elision pass over a message list.
 * Never mutates the input array or its elements in place; preserves all non-toolResult
 * messages, images, recent user turns, and toolCall/toolResult pairing invariants.
 */
export function elideStaleToolResults(
  messages: readonly AgentMessage[],
  opts: ElisionOptions,
): ElisionResult {
  const log = opts.log ?? defaultLog;
  const sessionKey = opts.sessionKey ?? "__default__";
  const protectedStartIndex = findProtectedTurnStartIndex(messages, opts.keepTurns);

  let changed = false;
  let newlyElided = 0;
  let replayedElided = 0;
  let charsReclaimed = 0;
  const modifiedIndices: number[] = [];

  const nextMessages: AgentMessage[] = new Array(messages.length);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isToolResultMessage(msg) || !Array.isArray(msg.content) || msg.content.length === 0) {
      nextMessages[i] = msg;
      continue;
    }

    let msgChanged = false;
    let nextContent: (TextContent | ImageContent)[] | null = null;

    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (!block || block.type !== "text" || typeof block.text !== "string") continue;

      const key = makeBlockKey(msg, i, j);
      const cachedPlaceholder = opts.elidedBlocks.get(key);
      if (cachedPlaceholder !== undefined) {
        if (block.text !== cachedPlaceholder) {
          if (!nextContent) nextContent = msg.content.slice();
          nextContent[j] = { type: "text", text: cachedPlaceholder };
          msgChanged = true;
          replayedElided++;
        }
        continue;
      }

      if (
        !opts.allowNewElisions ||
        i >= protectedStartIndex ||
        block.text.length < opts.minChars ||
        isAlreadyElidedText(block.text)
      ) {
        continue;
      }

      const verifiedSpill = findVerifiedReusableSpill(sessionKey, msg, j, block.text, opts.spillDir);
      let spillPath: string;
      let originalChars = block.text.length;
      let originalLines = countLines(block.text);

      if (verifiedSpill) {
        spillPath = verifiedSpill.path;
        originalChars = verifiedSpill.originalChars;
        originalLines = verifiedSpill.originalLines;
      } else {
        try {
          const written = writeSessionSpill(block.text, opts.spillDir);
          spillPath = written.path;
          originalChars = written.chars;
          originalLines = written.lines;
        } catch (err) {
          log.warn("pre_compaction_elision_spill_failed", {
            tool: msg.toolName,
            toolCallId: msg.toolCallId,
            error: err instanceof Error ? err.message : String(err),
          });
          // Never drop data when spill persistence fails.
          continue;
        }
      }

      const placeholder = formatElidedPlaceholder(
        msg.toolName || "unknown",
        originalChars,
        originalLines,
        spillPath,
      );
      if (placeholder.length >= block.text.length) continue;

      opts.elidedBlocks.set(key, placeholder);
      if (!nextContent) nextContent = msg.content.slice();
      nextContent[j] = { type: "text", text: placeholder };
      msgChanged = true;
      newlyElided++;
      charsReclaimed += block.text.length - placeholder.length;
    }

    if (msgChanged && nextContent) {
      nextMessages[i] = { ...msg, content: nextContent };
      modifiedIndices.push(i);
      changed = true;
    } else {
      nextMessages[i] = msg;
    }
  }

  return {
    messages: changed ? nextMessages : (messages as AgentMessage[]),
    changed,
    modifiedIndices,
    newlyElided,
    replayedElided,
    charsReclaimed,
  };
}

function resolveContextUsagePercent(
  messages: readonly AgentMessage[],
  ctx: any,
  elidedBlocks: ReadonlyMap<string, string>,
): number | null {
  const usage = ctx?.getContextUsage?.();
  const contextWindow =
    typeof usage?.contextWindow === "number" && usage.contextWindow > 0
      ? usage.contextWindow
      : typeof ctx?.model?.contextWindow === "number" && ctx.model.contextWindow > 0
        ? ctx.model.contextWindow
        : 0;

  if (typeof usage?.percent === "number" && Number.isFinite(usage.percent)) {
    return usage.percent;
  }
  if (typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && contextWindow > 0) {
    return (usage.tokens / contextWindow) * 100;
  }
  if (contextWindow > 0) {
    const estimatedTokens = estimateMessagesTokens(messages, elidedBlocks);
    return (estimatedTokens / contextWindow) * 100;
  }
  return null;
}

/** Register mechanical pre-compaction elision (`turn_end` `context_edit` + `context` fallback). */
export function registerPreCompactionElision(
  pi: ExtensionAPI,
  options: RegisterPreCompactionElisionOptions = {},
): void {
  const log = options.log ?? defaultLog;
  const elidedBySession = new Map<string, Map<string, string>>();

  const sessionKey = (ctx: any): string =>
    ctx?.sessionManager?.getSessionId?.() || "__default__";

  const getElidedBlocks = (key: string): Map<string, string> => {
    let map = elidedBySession.get(key);
    if (!map) {
      map = new Map<string, string>();
      elidedBySession.set(key, map);
    }
    return map;
  };

  pi.on("session_start", (_event, ctx) => {
    const key = sessionKey(ctx);
    elidedBySession.set(key, new Map<string, string>());
    log.debug("pre_compaction_elision_session_reset", { sessionKey: key });
  });

  pi.on("session_compact", (_event, ctx) => {
    const key = sessionKey(ctx);
    elidedBySession.set(key, new Map<string, string>());
    log.debug("pre_compaction_elision_cleared_after_compact", { sessionKey: key });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    elidedBySession.delete(sessionKey(ctx));
  });

  // Primary pre-compaction integration: runs at turn_end BEFORE Pi's automatic
  // compaction checks (_compactBeforeNextAssistantResponse and _checkCompaction).
  // Emitting `context_edit` drafts updates the canonical session projection so Pi
  // recalculates projected tokens from the elided messages and avoids LLM compaction.
  pi.on("turn_end", (event, ctx) => {
    const cwd = ctx?.cwd || process.cwd();
    if (!getSetting(cwd, "pre_compaction_elision")) return undefined;

    const projectedEntries = event?.context?.contextEntries;
    if (!Array.isArray(projectedEntries) || projectedEntries.length === 0) return undefined;

    const messages: AgentMessage[] = [];
    const entryIds: (string | null)[] = [];
    for (const proj of projectedEntries) {
      if (!proj || !Array.isArray(proj.messages)) continue;
      const src = proj.sourceEntry;
      const editableId =
        src && src.type === "message" && typeof src.id === "string" && src.id ? src.id : null;
      for (const msg of proj.messages) {
        if (!msg || (msg as any).role === "system") continue;
        messages.push(msg);
        entryIds.push(editableId);
      }
    }
    if (messages.length === 0) return undefined;

    const key = sessionKey(ctx);
    const elidedBlocks = getElidedBlocks(key);
    const thresholdPct = getSetting(cwd, "pre_compaction_elision_threshold_pct");
    const usagePct = resolveContextUsagePercent(messages, ctx, elidedBlocks);
    if (usagePct === null || usagePct < thresholdPct) return undefined;

    const keepTurns = getSetting(cwd, "pre_compaction_elision_keep_turns");
    const minChars = getSetting(cwd, "pre_compaction_elision_min_chars");
    const spillLoc = resolveSessionSpillDir({
      sessionFile: ctx?.sessionManager?.getSessionFile?.(),
      sessionId: ctx?.sessionManager?.getSessionId?.(),
      cwd,
    });

    const result = elideStaleToolResults(messages, {
      sessionKey: key,
      keepTurns,
      minChars,
      spillDir: spillLoc.dir,
      elidedBlocks,
      allowNewElisions: true,
      log,
    });

    if (!result.changed || result.modifiedIndices.length === 0) return undefined;

    const existingEntries: SessionBoundaryDraft[] = Array.isArray(event.entries) ? event.entries : [];
    const drafts: SessionBoundaryDraft[] = [];
    for (const idx of result.modifiedIndices) {
      const targetId = entryIds[idx];
      const updated = result.messages[idx];
      if (!targetId || !updated || !isToolResultMessage(updated)) continue;
      drafts.push({
        type: "context_edit",
        targetId,
        replacement: { content: updated.content },
      });
    }
    if (drafts.length === 0) return undefined;

    log.info("pre_compaction_elision_turn_end_committed", {
      usagePct: Math.round(usagePct * 10) / 10,
      thresholdPct,
      edits: drafts.length,
      newlyElided: result.newlyElided,
      charsReclaimed: result.charsReclaimed,
    });

    return { entries: [...existingEntries, ...drafts] };
  });

  // Complementary request-time guard for pre-existing un-edited transcripts or
  // non-boundary hosts. Never mutates history on ordinary turns below threshold.
  pi.on("context", (event, ctx) => {
    const cwd = ctx?.cwd || process.cwd();
    if (!getSetting(cwd, "pre_compaction_elision")) return undefined;

    const messages = event?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;

    const key = sessionKey(ctx);
    const elidedBlocks = getElidedBlocks(key);
    const thresholdPct = getSetting(cwd, "pre_compaction_elision_threshold_pct");
    const usagePct = resolveContextUsagePercent(messages, ctx, elidedBlocks);
    const crossedThreshold = usagePct !== null && usagePct >= thresholdPct;

    // Zero mutation on ordinary turns below the high-water threshold (keeps prompt cache intact).
    if (!crossedThreshold && elidedBlocks.size === 0) return undefined;

    const keepTurns = getSetting(cwd, "pre_compaction_elision_keep_turns");
    const minChars = getSetting(cwd, "pre_compaction_elision_min_chars");
    const spillLoc = resolveSessionSpillDir({
      sessionFile: ctx?.sessionManager?.getSessionFile?.(),
      sessionId: ctx?.sessionManager?.getSessionId?.(),
      cwd,
    });

    const result = elideStaleToolResults(messages, {
      sessionKey: key,
      keepTurns,
      minChars,
      spillDir: spillLoc.dir,
      elidedBlocks,
      allowNewElisions: crossedThreshold,
      log,
    });

    if (!result.changed) return undefined;

    if (result.newlyElided > 0) {
      log.info("pre_compaction_elision_applied", {
        usagePct: usagePct !== null ? Math.round(usagePct * 10) / 10 : null,
        thresholdPct,
        newlyElided: result.newlyElided,
        replayedElided: result.replayedElided,
        charsReclaimed: result.charsReclaimed,
      });
    } else if (result.replayedElided > 0) {
      log.debug("pre_compaction_elision_replayed", {
        replayedElided: result.replayedElided,
      });
    }

    return { messages: result.messages };
  });
}
