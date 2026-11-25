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

export function textFromMessage(msg: any): string {
  if (typeof msg?.content === "string") return msg.content;
  if (!Array.isArray(msg?.content)) return "";
  return msg.content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
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
    const detail = typeof inner.args?.command === "string" && inner.args.command
      ? ` ${inner.args.command.slice(0, 100)}`
      : "";
    tracked.text += `\n🔧 ${name}${detail}`;
    changed = true;
  }

  if (inner.type === "tool_execution_end" && inner.result?.content?.[0]?.text) {
    const result = String(inner.result.content[0].text).slice(0, 200);
    tracked.text += `\n${inner.isError ? "✗" : "✓"} ${result}`;
    changed = true;
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
        sink.patch(refs.assist.id, (m) => ({ ...m, className: undefined }));
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
        sink.add(
          "system",
          typeof content === "string" ? content : JSON.stringify(content),
          undefined,
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
        sink.patch(refs.assist.id, (m) => ({ ...m, className: undefined }));
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
        sink.patch(refs.assist.id, (m) => ({ ...m, className: undefined }));
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
      let name = ev.toolName || "tool";
      let detail = typeof ev.args?.command === "string" ? ev.args.command : "";
      if (name === "subagent" && ev.args) {
        const label = ev.args.name || ev.args.agent;
        if (label) name = `subagent (${label})`;
        if (ev.args.asyncKill) detail = `kill: ${ev.args.asyncKill}`;
        else if (ev.args.task) detail = String(ev.args.task).slice(0, 150);
        else if (Array.isArray(ev.args.tasks)) detail = `${ev.args.tasks.length} parallel tasks`;
        else if (Array.isArray(ev.args.chain)) detail = `${ev.args.chain.length} chain steps`;
      }
      const cid = ev.toolCallId || sink.nextId();
      const id = sink.add(name as MessageRole, detail, "tool-call", { callId: cid }, { timestamp: ts, protect: true });
      refs.tool = { id, name, startTs: ts, callId: cid };
      return true;
    }

    case "tool_execution_update":
      if (refs.tool.id && ev.partialResult?.content?.[0]?.text) {
        const text = `${refs.tool.name}: ${ev.partialResult.content[0].text}`;
        sink.patch(refs.tool.id, (m) => ({ ...m, text }));
      }
      return true;

    case "tool_execution_end": {
      const toolName = refs.tool.name || ev.toolName || "tool";
      const startTs = refs.tool.startTs;
      const callId = refs.tool.callId || ev.toolCallId || "";
      refs.tool = { id: "", name: "", startTs: 0, callId: "" };
      if (ev.result?.content?.[0]?.text) {
        const t = ev.result.content[0].text;
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
