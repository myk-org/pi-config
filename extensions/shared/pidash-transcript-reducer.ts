/**
 * Pure, browser-safe transcript reducer shared between the pidash daemon
 * (`scripts/pidash-session-state.ts`) and browser UI (`useMessageHandler.ts`).
 *
 * Single source of truth for folding Pi session events into `ChatMessage` entries
 * and live streaming refs so live streams and `session_snapshot` reconnects
 * never drift.
 */

import type { ChatMessage, MessageRole, SessionCommandInfo, TokenUsage } from "./types.ts";

export const ASYNC_AGENT_TEXT_MAX = 32_768;
const TRUNCATED_PREFIX = "...(truncated)\n";

export interface TranscriptRefs {
  think: { id: string; text: string; startTs: number };
  assist: { id: string; text: string };
  tool: { id: string; name: string; startTs: number; callId: string };
  asyncMsgs: Map<string, { msgId: string; text: string }>;
  lastUserText: string;
  /** Local prompts already rendered by the browser awaiting Pi's echoed user message_start. */
  pendingLocalUserTexts?: string[];
}

export interface TranscriptAddOptions {
  timestamp?: number;
  /** Keep active in-flight messages protected from bounded history trimming. */
  protect?: boolean;
  explicitId?: string;
}

export interface TranscriptSink {
  add(
    role: ChatMessage["role"],
    text: string,
    className?: string,
    meta?: ChatMessage["meta"],
    options?: TranscriptAddOptions,
  ): string;
  patch(id: string, fn: (msg: ChatMessage) => ChatMessage): void;
  findLast(pred: (msg: ChatMessage) => boolean): ChatMessage | undefined;
  dismissAsk(askId: string): void;
  nextId(): string;
}

export interface TranscriptHooks {
  onStreamingChange?: (streaming: boolean, ev: any) => void;
  onQueuedIncrement?: () => void;
  onQueuedReset?: () => void;
  onStreamingBehavior?: (behavior: string | null) => void;
  onModel?: (model: string) => void;
  onTokens?: (tokens: TokenUsage) => void;
  onCommandsList?: (commands: SessionCommandInfo[]) => void;
  onFlushLiveDeltas?: () => void;
  /** Return true when delta patching is deferred (e.g. browser rAF coalescing). */
  onScheduleDelta?: (kind: "think" | "assist") => boolean;
  shouldSkipUiRequest?: (ev: any) => boolean;
  sessionId?: () => string | undefined;
}

/**
 * Trim trailing whitespace and blank lines from user/assistant display text
 * while preserving leading indentation and all internal newlines.
 */
export function trimMessageDisplayText(text: string): string {
  return text.trimEnd();
}

export function textFromMessage(msg: any): string {
  if (typeof msg?.content === "string") return trimMessageDisplayText(msg.content);
  if (!Array.isArray(msg?.content)) return "";
  return trimMessageDisplayText(
    msg.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text ?? "")
      .join("\n"),
  );
}

/**
 * Extract full displayable text from a tool result or partialResult `content` field.
 * Joins ALL `text` blocks across `content[0..N]` and emits `[image: <mimeType>]`
 * markers for image blocks so multi-part outputs (e.g. codemode) never lose data.
 */
export function extractToolContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown; mimeType?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      if (b.text.length > 0) parts.push(b.text);
    } else if (b.type === "image") {
      const mime = typeof b.mimeType === "string" && b.mimeType.trim() ? b.mimeType.trim() : "unknown";
      parts.push(`[image: ${mime}]`);
    }
  }
  return parts.join("\n");
}

function safeFormatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function omitNonNullish(
  obj: Record<string, unknown>,
  exclude: readonly string[],
): Record<string, unknown> | null {
  const skip = new Set(exclude);
  const rest: Record<string, unknown> = {};
  let hasKeys = false;
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k) || v === undefined || v === null) continue;
    rest[k] = v;
    hasKeys = true;
  }
  return hasKeys ? rest : null;
}

function formatSubagentSteps(items: unknown[]): string[] {
  return items.map((item, idx) => {
    if (!item || typeof item !== "object") return `[${idx + 1}] ${String(item)}`;
    const step = item as Record<string, unknown>;
    const agent = typeof step.agent === "string" && step.agent ? step.agent : "agent";
    const who = typeof step.name === "string" && step.name ? `${agent} (${step.name})` : agent;
    const meta = omitNonNullish(step, ["agent", "name", "task"]);
    const lines = [`[${idx + 1}] ${who}`];
    if (typeof step.task === "string" && step.task) lines.push(step.task);
    if (meta) lines.push(safeFormatJson(meta));
    return lines.join("\n");
  });
}

/** Concise 1-line preview for collapsed tool/collapsible rows without dropping full expanded text. */
export function formatToolCallSummary(text: string, maxLen = 120): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed.replace(/\s+/g, " ").slice(0, maxLen);
  }
  const firstNonEmpty = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstNonEmpty.trim().slice(0, maxLen);
}

/**
 * Format full, lossless tool call arguments for every tool.
 * First line stays concise for collapsed row previews while expanded CALL boxes
 * preserve 100% of arguments without truncation.
 */
export function formatToolCallDetail(toolName: string, args: unknown): string {
  if (args === undefined || args === null) return "";
  let parsedArgs: unknown = args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedArgs = parsed;
      } else {
        return args;
      }
    } catch {
      return args;
    }
  }
  if (typeof parsedArgs !== "object") return String(parsedArgs);
  if (Array.isArray(parsedArgs)) return safeFormatJson(parsedArgs);

  const a = parsedArgs as Record<string, unknown>;
  if (Object.keys(a).length === 0) return "";

  const normalized = (toolName || "").trim().toLowerCase();

  if ((normalized === "bash" || normalized === "shell") && typeof a.command === "string") {
    const extra = omitNonNullish(a, ["command"]);
    return extra ? `${a.command}\n\n${safeFormatJson(extra)}` : a.command;
  }

  if (normalized === "codemode" && typeof a.code === "string") {
    const extra = omitNonNullish(a, ["code"]);
    return extra ? `${a.code}\n\n${safeFormatJson(extra)}` : a.code;
  }

  if (normalized === "read" && typeof a.path === "string") {
    const range: string[] = [];
    if (a.offset !== undefined && a.offset !== null) range.push(`offset: ${a.offset}`);
    if (a.limit !== undefined && a.limit !== null) range.push(`limit: ${a.limit}`);
    const header = range.length > 0 ? `${a.path} (${range.join(", ")})` : a.path;
    const extra = omitNonNullish(a, ["path", "offset", "limit"]);
    return extra ? `${header}\n\n${safeFormatJson(extra)}` : header;
  }

  if (normalized === "write" && typeof a.path === "string") {
    const sections = [a.path];
    if (typeof a.content === "string" && a.content.length > 0) sections.push(a.content);
    const extra = omitNonNullish(a, ["path", "content"]);
    if (extra) sections.push(safeFormatJson(extra));
    return sections.join("\n\n");
  }

  if (normalized === "edit" && typeof a.path === "string") {
    if (Array.isArray(a.edits)) {
      const header = `${a.path} (${a.edits.length} edit${a.edits.length === 1 ? "" : "s"})`;
      const formattedEdits = a.edits.map((ed, idx) => {
        if (ed && typeof ed === "object" && !Array.isArray(ed)) {
          const rec = ed as Record<string, unknown>;
          if (typeof rec.oldText === "string" && typeof rec.newText === "string") {
            const edExtra = omitNonNullish(rec, ["oldText", "newText"]);
            const block = `--- edit ${idx + 1} (old) ---\n${rec.oldText}\n+++ edit ${idx + 1} (new) +++\n${rec.newText}`;
            return edExtra ? `${block}\n${safeFormatJson(edExtra)}` : block;
          }
        }
        return `[edit ${idx + 1}]\n${safeFormatJson(ed)}`;
      });
      const extra = omitNonNullish(a, ["path", "edits"]);
      const sections = [header, ...formattedEdits];
      if (extra) sections.push(safeFormatJson(extra));
      return sections.join("\n\n");
    }
    if (typeof a.oldText === "string" || typeof a.newText === "string") {
      const sections = [
        a.path,
        `--- old ---\n${typeof a.oldText === "string" ? a.oldText : ""}\n+++ new +++\n${typeof a.newText === "string" ? a.newText : ""}`,
      ];
      const extra = omitNonNullish(a, ["path", "oldText", "newText"]);
      if (extra) sections.push(safeFormatJson(extra));
      return sections.join("\n\n");
    }
  }

  if (normalized === "subagent") {
    if (typeof a.asyncKill === "string" && a.asyncKill) {
      const extra = omitNonNullish(a, ["asyncKill"]);
      return extra ? `kill: ${a.asyncKill}\n\n${safeFormatJson(extra)}` : `kill: ${a.asyncKill}`;
    }
    if (typeof a.task === "string") {
      const extra = omitNonNullish(a, ["task"]);
      return extra ? `${a.task}\n\n${safeFormatJson(extra)}` : a.task;
    }
    if (Array.isArray(a.tasks)) {
      const header = `${a.tasks.length} parallel task${a.tasks.length === 1 ? "" : "s"}`;
      const extra = omitNonNullish(a, ["tasks"]);
      const sections = [header, ...formatSubagentSteps(a.tasks)];
      if (extra) sections.push(safeFormatJson(extra));
      return sections.join("\n\n");
    }
    if (Array.isArray(a.chain)) {
      const header = `${a.chain.length} chain step${a.chain.length === 1 ? "" : "s"}`;
      const extra = omitNonNullish(a, ["chain"]);
      const sections = [header, ...formatSubagentSteps(a.chain)];
      if (extra) sections.push(safeFormatJson(extra));
      return sections.join("\n\n");
    }
  }

  if (typeof a.command === "string") {
    const extra = omitNonNullish(a, ["command"]);
    return extra ? `${a.command}\n\n${safeFormatJson(extra)}` : a.command;
  }

  return safeFormatJson(a);
}

function appendFullOutputErrorNotice(text: string, details: any): string {
  const fullOutputError =
    typeof details?.fullOutputError === "string" ? details.fullOutputError.trim() : "";
  if (!fullOutputError) return text;
  return `${text}${text ? "\n" : ""}⚠️ Full output not saved: ${fullOutputError}`;
}

/**
 * Append one inner `async_agent_event` payload onto an accumulated text buffer.
 * Shared by both the transcript reducer and the daemon's `asyncAgents` registry
 * so progress arriving during a Pi reconnect is preserved verbatim.
 */
export function appendAsyncAgentEventText(
  tracked: { text: string },
  inner: any,
  maxChars = ASYNC_AGENT_TEXT_MAX,
): boolean {
  if (!inner || typeof inner !== "object") return false;
  let changed = false;

  if (inner.type === "message_update" && inner.assistantMessageEvent) {
    const ae = inner.assistantMessageEvent;
    if (ae.type === "text_delta" && ae.delta) {
      tracked.text += ae.delta;
      changed = true;
    }
  }

  if (inner.type === "tool_execution_start") {
    const name = inner.toolName || "tool";
    const preview = formatToolCallSummary(formatToolCallDetail(name, inner.args), 100);
    const detail = preview ? ` ${preview}` : "";
    tracked.text += `\n🔧 ${name}${detail}`;
    changed = true;
  }

  if (inner.type === "tool_execution_end") {
    const extracted = extractToolContentText(inner.result?.content);
    const rawResult = extracted ? extracted.slice(0, 200) : "";
    const result = appendFullOutputErrorNotice(rawResult, inner.result?.details);
    if (result) {
      tracked.text += `\n${inner.isError ? "✗" : "✓"} ${result}`;
      changed = true;
    }
  }

  if (changed && maxChars > 0 && tracked.text.length > maxChars) {
    const keep = Math.max(0, maxChars - TRUNCATED_PREFIX.length);
    tracked.text = keep > 0
      ? TRUNCATED_PREFIX + tracked.text.slice(-keep)
      : tracked.text.slice(-maxChars);
  }

  return changed;
}

/**
 * Apply one Pi / async / UI transcript event onto `refs` + `sink`.
 * Returns `true` if the event type was handled by the transcript reducer.
 */
export function applyTranscriptEvent(
  ev: any,
  refs: TranscriptRefs,
  sink: TranscriptSink,
  hooks: TranscriptHooks = {},
): boolean {
  if (!ev || typeof ev.type !== "string") return false;
  const ts = typeof ev.timestamp === "number" ? ev.timestamp : Date.now();

  switch (ev.type) {
    case "prompt-queued":
      hooks.onQueuedIncrement?.();
      return true;

    case "streaming-behavior":
      hooks.onStreamingBehavior?.(typeof ev.behavior === "string" && ev.behavior ? ev.behavior : null);
      return true;

    case "agent_start":
      hooks.onStreamingChange?.(true, ev);
      hooks.onQueuedReset?.();
      return true;

    case "ui_prompt_start":
    case "ui_prompt_end":
      return true;

    case "agent_end":
      hooks.onFlushLiveDeltas?.();
      if (refs.think.id) {
        const endMeta = refs.think.startTs ? { startTs: refs.think.startTs, endTs: ts } : undefined;
        sink.patch(refs.think.id, (m) => ({
          ...m,
          className: undefined,
          ...(endMeta ? { meta: { ...m.meta, ...endMeta } } : {}),
        }));
      }
      if (refs.assist.id) {
        sink.patch(refs.assist.id, (m) => ({ ...m, text: trimMessageDisplayText(m.text), className: undefined }));
      }
      hooks.onQueuedReset?.();
      hooks.onStreamingBehavior?.(null);
      refs.think = { id: "", text: "", startTs: 0 };
      refs.assist = { id: "", text: "" };
      refs.lastUserText = "";
      return true;

    case "agent_settled":
      hooks.onStreamingChange?.(false, ev);
      return true;

    case "message_start": {
      hooks.onFlushLiveDeltas?.();
      const msg = ev.message;
      if (!msg) return true;
      if (msg.role === "user") {
        const t = textFromMessage(msg);
        if (t) {
          const localIdx = refs.pendingLocalUserTexts?.indexOf(t) ?? -1;
          if (localIdx !== -1) {
            refs.pendingLocalUserTexts!.splice(localIdx, 1);
          } else if (t !== refs.lastUserText) {
            refs.lastUserText = t;
            sink.add("user", t, undefined, undefined, { timestamp: ts });
          }
        }
      } else if (msg.role === "assistant") {
        refs.think = { id: "", text: "", startTs: 0 };
        refs.assist = { id: "", text: "" };
        // An assistant turn separates identical user prompts so repeated prompts are kept.
        refs.lastUserText = "";
      } else if (msg.role === "custom" && msg.display) {
        const content = msg.content || "";
        const text = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (extractToolContentText(content) || safeFormatJson(content))
            : safeFormatJson(content);
        sink.add(
          "system",
          text,
          msg.customType === "lsp-startup-summary" ? "lsp-startup-summary" : undefined,
          undefined,
          { timestamp: ts },
        );
      }
      return true;
    }

    case "message_update": {
      const ae = ev.assistantMessageEvent;
      if (!ae) return true;
      if (ae.type === "thinking_delta" && ae.delta) {
        refs.lastUserText = "";
        refs.think.text += ae.delta;
        if (!refs.think.id) {
          refs.think.startTs = ts;
          refs.think.id = sink.add("thinking", refs.think.text, undefined, undefined, { timestamp: ts, protect: true });
        } else if (!hooks.onScheduleDelta?.("think")) {
          const text = refs.think.text;
          sink.patch(refs.think.id, (m) => ({ ...m, text }));
        }
      }
      if ((ae.type === "text_start" || ae.type === "text_delta") && refs.think.id && !refs.assist.id) {
        hooks.onFlushLiveDeltas?.();
        const endMeta = refs.think.startTs ? { startTs: refs.think.startTs, endTs: ts } : undefined;
        sink.patch(refs.think.id, (m) => ({
          ...m,
          className: undefined,
          ...(endMeta ? { meta: { ...m.meta, ...endMeta } } : {}),
        }));
      }
      if (ae.type === "text_delta" && ae.delta) {
        refs.lastUserText = "";
        refs.assist.text += ae.delta;
        if (!refs.assist.id) {
          refs.assist.id = sink.add("assistant", refs.assist.text, "streaming", undefined, { timestamp: ts, protect: true });
        } else if (!hooks.onScheduleDelta?.("assist")) {
          const text = refs.assist.text;
          sink.patch(refs.assist.id, (m) => ({ ...m, text }));
        }
      }
      if (ae.type === "text_end" && refs.assist.id) {
        hooks.onFlushLiveDeltas?.();
        sink.patch(refs.assist.id, (m) => ({ ...m, text: trimMessageDisplayText(m.text), className: undefined }));
      }
      return true;
    }

    case "message_end":
      hooks.onFlushLiveDeltas?.();
      if (refs.think.id) {
        const endMeta = refs.think.startTs ? { startTs: refs.think.startTs, endTs: ts } : undefined;
        sink.patch(refs.think.id, (m) => ({
          ...m,
          className: undefined,
          ...(endMeta ? { meta: { ...m.meta, ...endMeta } } : {}),
        }));
      }
      if (refs.assist.id) {
        sink.patch(refs.assist.id, (m) => ({ ...m, text: trimMessageDisplayText(m.text), className: undefined }));
      }
      refs.think = { id: "", text: "", startTs: 0 };
      refs.assist = { id: "", text: "" };
      if (ev.message?.role === "assistant") {
        // History replay emits assistant message_end without agent_end between turns.
        refs.lastUserText = "";
      }
      if (ev.message?.model) hooks.onModel?.(ev.message.model);
      if (ev.message?.usage && typeof ev.message.usage === "object") {
        hooks.onTokens?.({ ...ev.message.usage });
      }
      return true;

    case "turn_end":
      if (ev.message?.model) hooks.onModel?.(ev.message.model);
      if (ev.message?.usage && typeof ev.message.usage === "object") {
        hooks.onTokens?.({ ...ev.message.usage });
      }
      return true;

    case "tool_execution_start": {
      hooks.onFlushLiveDeltas?.();
      refs.lastUserText = "";
      const rawName = ev.toolName || "tool";
      let name = rawName;
      if (rawName === "subagent" && ev.args) {
        const label = ev.args.name || ev.args.agent;
        if (label) name = `subagent (${label})`;
      }
      const detail = formatToolCallDetail(rawName, ev.args);
      const cid = ev.toolCallId || sink.nextId();
      const id = sink.add(name as MessageRole, detail, "tool-call", { callId: cid }, { timestamp: ts, protect: true });
      refs.tool = { id, name, startTs: ts, callId: cid };
      return true;
    }

    case "tool_execution_update": {
      const targetId = (ev.toolCallId && ev.toolCallId !== refs.tool.callId)
        ? sink.findLast((m) => m.className === "tool-call" && m.meta?.callId === ev.toolCallId)?.id
        : refs.tool.id;
      if (targetId) {
        const partial = extractToolContentText(ev.partialResult?.content);
        if (partial) {
          sink.patch(targetId, (m) => ({
            ...m,
            meta: { ...m.meta, partialOutput: partial },
          }));
        }
      }
      return true;
    }

    case "tool_execution_end": {
      const idMismatch = Boolean(ev.toolCallId && ev.toolCallId !== refs.tool.callId);
      const matchedCall = idMismatch
        ? sink.findLast((m) => m.className === "tool-call" && m.meta?.callId === ev.toolCallId)
        : undefined;
      const callMsgId = idMismatch ? (matchedCall?.id ?? "") : refs.tool.id;
      const toolName = idMismatch
        ? (matchedCall?.role || ev.toolName || "tool")
        : (refs.tool.name || ev.toolName || "tool");
      const startTs = idMismatch ? (matchedCall?.timestamp ?? 0) : refs.tool.startTs;
      const callId = idMismatch
        ? (matchedCall?.meta?.callId || ev.toolCallId || "")
        : (refs.tool.callId || ev.toolCallId || "");
      if (!idMismatch) {
        refs.tool = { id: "", name: "", startTs: 0, callId: "" };
      }
      if (callMsgId) {
        sink.patch(callMsgId, (m) => {
          if (!m.meta || m.meta.partialOutput === undefined) return m;
          const { partialOutput: _drop, ...restMeta } = m.meta;
          return { ...m, meta: restMeta };
        });
      }
      const rawText = extractToolContentText(ev.result?.content);
      const t = appendFullOutputErrorNotice(rawText, ev.result?.details);
      if (t) {
        let meta: ChatMessage["meta"] = startTs ? { startTs, endTs: ts, callId } : { callId };
        const results = ev.result?.details?.results;
        if (Array.isArray(results) && results.length > 0) {
          let totalInput = 0;
          let totalOutput = 0;
          let totalTurns = 0;
          let totalCache = 0;
          let totalCtx = 0;
          let totalCost = 0;
          for (const res of results) {
            if (res.usage) {
              totalInput += res.usage.input || 0;
              totalOutput += res.usage.output || 0;
              totalTurns += res.usage.turns || 0;
              totalCache += res.usage.cacheRead || 0;
              totalCtx += res.usage.contextTokens || 0;
              totalCost += res.usage.cost || 0;
            }
          }
          meta = {
            ...meta,
            turns: totalTurns,
            input: totalInput,
            output: totalOutput,
            cacheRead: totalCache,
            contextTokens: totalCtx,
            cost: totalCost,
            model: results[0]?.model,
          };
        }
        sink.add(
          toolName as MessageRole,
          `${ev.isError ? "✗ " : "✓ "}${t}`,
          "tool-result",
          meta,
          { timestamp: ts },
        );
      }
      return true;
    }

    case "async_agent_start": {
      const asyncId = ev.id as string;
      if (!asyncId) return true;
      const currentSid = hooks.sessionId?.();
      if (ev.sessionId && currentSid && ev.sessionId !== currentSid) return true;
      const match = sink.findLast((m) => m.className === "tool-result" && m.text.includes(asyncId));
      let targetMsgId = match?.id ?? "";
      if (!targetMsgId) {
        const agent = ev.agent || "agent";
        const repo = String(ev.cwd || "").split("/").pop() || "";
        targetMsgId = sink.add("system", `⏳ ${agent} — ${repo}`, "async-agent-running", undefined, { timestamp: ts, protect: true });
      }
      refs.asyncMsgs.set(asyncId, { msgId: targetMsgId, text: "" });
      return true;
    }

    case "async_agent_event": {
      const asyncId = ev.id as string;
      const inner = ev.event;
      if (!asyncId || !inner) return true;
      const currentSid = hooks.sessionId?.();
      if (ev.sessionId && currentSid && ev.sessionId !== currentSid) return true;
      const tracked = refs.asyncMsgs.get(asyncId);
      if (!tracked) return true;

      if (appendAsyncAgentEventText(tracked, inner)) {
        const body = tracked.text.trim();
        sink.patch(tracked.msgId, (m) => {
          const header = m.text.split("\n")[0];
          return { ...m, text: `${header}\n${body}` };
        });
      }
      return true;
    }

    case "async_agent_complete": {
      const asyncId = ev.id as string;
      if (!asyncId) return true;
      const currentSid = hooks.sessionId?.();
      if (ev.sessionId && currentSid && ev.sessionId !== currentSid) return true;
      const tracked = refs.asyncMsgs.get(asyncId);
      if (!tracked) return true;
      const body = tracked.text.trim();
      const success = ev.success;
      sink.patch(tracked.msgId, (m) => {
        if (m.className === "async-agent-running") {
          const header = m.text.split("\n")[0].replace("⏳", success === false ? "❌" : "✅");
          return { ...m, text: body ? `${header}\n${body}` : header, className: "async-agent-done" };
        }
        const status = success === false ? "\n❌ Agent failed" : "\n✅ Agent complete";
        const header = m.text.split("\n")[0];
        return { ...m, text: `${header}\n${body}${status}` };
      });
      refs.asyncMsgs.delete(asyncId);
      return true;
    }

    case "extension_ui_request": {
      if (hooks.shouldSkipUiRequest?.(ev)) return true;
      if (ev.id && (ev.method === "select" || ev.method === "confirm" || ev.method === "input")) {
        const askId = ev.id as string;
        const prefix = `ask|${askId}|`;
        if (sink.findLast((m) => Boolean(m.className?.startsWith(prefix)))) return true;
        const title = ev.title || "Input needed";
        const opts = ev.method === "confirm" ? ["Yes", "No"] : ev.options || [];
        sink.add(
          "ask_user" as MessageRole,
          `${title}${ev.message ? "\n" + ev.message : ""}`,
          `${prefix}${ev.method}|${opts.join("|||")}`,
          undefined,
          { timestamp: ts },
        );
      }
      return true;
    }

    case "coms_peer_event": {
      const content = ev.content || "";
      sink.add(
        "system",
        typeof content === "string" ? content : JSON.stringify(content),
        undefined,
        undefined,
        { timestamp: ts },
      );
      return true;
    }

    case "notification":
      sink.add("system", `⚠️ ${ev.message || "notification"}`, undefined, undefined, { timestamp: ts });
      return true;

    case "commands-list":
      if (Array.isArray(ev.commands)) {
        const commands = ev.commands
          .filter((cmd: any) => cmd && typeof cmd.name === "string")
          .map((cmd: any) => ({
            name: cmd.name,
            description: typeof cmd.description === "string" ? cmd.description : "",
          }));
        hooks.onCommandsList?.(commands);
      }
      return true;

    case "ui-dismiss":
      if (typeof ev.id === "string" && ev.id.length > 0) {
        sink.dismissAsk(ev.id);
      }
      return true;

    default:
      return false;
  }
}
