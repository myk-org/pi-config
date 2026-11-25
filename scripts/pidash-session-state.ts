import type {
  ChatMessage,
  MessageRole,
  PendingUiRequestPayload,
  SessionCommandInfo,
  SessionInfo,
  SessionSnapshotPayload,
  TokenUsage,
} from "../extensions/shared/types.ts";
import { initialActivityState } from "../extensions/pidash/activity-state.ts";
import { createLogger } from "../extensions/shared/logger.ts";

const log = createLogger("pidash");

export const EVENT_BUFFER_MAX = 10000;
export const EVENT_BUFFER_TRIM_AT = 12000;
export const PENDING_UI_REQUESTS_MAX = 50;
export const VIEW_STATE_MESSAGES_MAX = 1000;

/**
 * Append a serialized event to a bounded buffer using amortized trimming
 * (O(1) amortized instead of O(N) Array.shift() on every delta once full).
 */
export function appendEventBuffer(
  buffer: string[],
  raw: string,
  max = EVENT_BUFFER_MAX,
  trimAt = EVENT_BUFFER_TRIM_AT,
): void {
  buffer.push(raw);
  if (buffer.length >= trimAt) {
    buffer.splice(0, buffer.length - max);
  }
}

export interface PendingUiRequestStore {
  pendingUiRequests: Map<string, string>;
  replaying?: boolean;
}

export interface SessionViewState {
  messages: ChatMessage[];
  indexById: Map<string, number>;
  nextSeq: number;
  think: { id: string; text: string; startTs: number };
  assist: { id: string; text: string };
  tool: { id: string; name: string; startTs: number; callId: string };
  asyncMsgs: Map<string, { msgId: string; text: string }>;
  lastUserText: string;
  model: string;
  tokens: TokenUsage | null;
  streaming: boolean;
  queuedCount: number;
  streamingBehavior: string | null;
  availableCommands: SessionCommandInfo[];
}

export interface PiClient extends PendingUiRequestStore {
  ws: any;
  session: SessionInfo;
  viewState: SessionViewState;
  replaying: boolean;
  connectionGeneration: number;
}

export function createSessionViewState(session?: Partial<SessionInfo>): SessionViewState {
  return {
    messages: [],
    indexById: new Map(),
    nextSeq: 0,
    think: { id: "", text: "", startTs: 0 },
    assist: { id: "", text: "" },
    tool: { id: "", name: "", startTs: 0, callId: "" },
    asyncMsgs: new Map(),
    lastUserText: "",
    model: session?.model || "",
    tokens: null,
    streaming: session?.streaming === true,
    queuedCount: 0,
    streamingBehavior: null,
    availableCommands: [],
  };
}

export function resetSessionViewState(client: PiClient): void {
  client.viewState = createSessionViewState(client.session);
  log.debug("viewState reset", { sessionId: client.session.sessionId });
}

function nextViewMessageId(state: SessionViewState): string {
  return `s-${++state.nextSeq}`;
}

function textFromMessage(msg: any): string {
  if (typeof msg?.content === "string") return msg.content;
  if (!Array.isArray(msg?.content)) return "";
  return msg.content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

function patchViewMessage(
  state: SessionViewState,
  id: string,
  fn: (msg: ChatMessage) => ChatMessage,
): void {
  const idx = state.indexById.get(id);
  if (idx !== undefined) {
    state.messages[idx] = fn(state.messages[idx]);
  }
}

function findLastViewMessage(
  state: SessionViewState,
  pred: (msg: ChatMessage) => boolean,
): ChatMessage | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (pred(state.messages[i])) return state.messages[i];
  }
  return undefined;
}

function dismissViewAsk(state: SessionViewState, askId: string): void {
  const prefix = `ask|${askId}|`;
  for (let i = 0; i < state.messages.length; i++) {
    if (state.messages[i].className?.startsWith(prefix)) {
      state.messages[i] = { ...state.messages[i], className: `ask-answered|${askId}` };
    }
  }
}

export function dismissAllViewAsks(state: SessionViewState): void {
  for (let i = 0; i < state.messages.length; i++) {
    const cls = state.messages[i].className;
    if (cls?.startsWith("ask|")) {
      const parts = cls.split("|");
      if (parts[1]) {
        state.messages[i] = { ...state.messages[i], className: `ask-answered|${parts[1]}` };
      }
    }
  }
}

/**
 * Trim oldest committed messages at message boundaries so bounded snapshots
 * never contain orphaned deltas and never evict active in-flight messages.
 */
export function trimViewStateMessages(
  state: SessionViewState,
  maxMessages = VIEW_STATE_MESSAGES_MAX,
  extraProtectedId?: string,
): number {
  if (maxMessages < 1 || state.messages.length <= maxMessages) return 0;

  const protectedIds = new Set<string>();
  if (extraProtectedId) protectedIds.add(extraProtectedId);
  if (state.think.id) protectedIds.add(state.think.id);
  if (state.assist.id) protectedIds.add(state.assist.id);
  if (state.tool.id) protectedIds.add(state.tool.id);
  for (const entry of state.asyncMsgs.values()) {
    if (entry.msgId) protectedIds.add(entry.msgId);
  }

  let toDrop = state.messages.length - maxMessages;
  const droppedIndices = new Set<number>();
  const droppedCallIds = new Set<string>();

  for (let i = 0; i < state.messages.length && toDrop > 0; i++) {
    const msg = state.messages[i];
    if (protectedIds.has(msg.id)) continue;
    droppedIndices.add(i);
    if (msg.className === "tool-call" && msg.meta?.callId) {
      droppedCallIds.add(msg.meta.callId);
    }
    toDrop--;
  }

  // Drop orphaned tool-result paired with a just-dropped tool-call so the
  // boundary does not leave a half-trimmed tool pair.
  if (droppedCallIds.size > 0) {
    for (let i = 0; i < state.messages.length; i++) {
      if (droppedIndices.has(i)) continue;
      const msg = state.messages[i];
      if (
        msg.className === "tool-result" &&
        msg.meta?.callId &&
        droppedCallIds.has(msg.meta.callId) &&
        !protectedIds.has(msg.id)
      ) {
        droppedIndices.add(i);
      }
    }
  }

  if (droppedIndices.size === 0) return 0;

  const kept: ChatMessage[] = [];
  const nextIndex = new Map<string, number>();
  for (let i = 0; i < state.messages.length; i++) {
    if (droppedIndices.has(i)) continue;
    const msg = state.messages[i];
    nextIndex.set(msg.id, kept.length);
    kept.push(msg);
  }
  state.messages = kept;
  state.indexById = nextIndex;
  log.debug("viewState messages trimmed", {
    dropped: droppedIndices.size,
    remaining: kept.length,
    maxMessages,
  });
  return droppedIndices.size;
}

function addViewMessage(
  state: SessionViewState,
  role: MessageRole,
  text: string,
  className?: string,
  meta?: ChatMessage["meta"],
  timestamp?: number,
  maxMessages = VIEW_STATE_MESSAGES_MAX,
): string {
  const id = nextViewMessageId(state);
  const msg: ChatMessage = {
    id,
    role,
    text,
    ...(className !== undefined ? { className } : {}),
    ...(meta !== undefined ? { meta } : {}),
    timestamp: timestamp ?? Date.now(),
  };
  state.indexById.set(id, state.messages.length);
  state.messages.push(msg);
  trimViewStateMessages(state, maxMessages, id);
  return id;
}

function shouldApplyStreamingTransition(client: PiClient, parsed: any): boolean {
  if (parsed?.activitySequence === undefined) return true;
  const seq = Number(parsed.activitySequence);
  const current = client.session.activitySequence ?? 0;
  return Number.isSafeInteger(seq) && seq >= 1 && seq >= current;
}

export function applyEventToViewState(
  client: PiClient,
  parsed: any,
  maxMessages = VIEW_STATE_MESSAGES_MAX,
): void {
  if (!parsed || typeof parsed.type !== "string") return;
  const state = client.viewState;

  switch (parsed.type) {
    case "replay_start": {
      state.messages = [];
      state.indexById.clear();
      state.think = { id: "", text: "", startTs: 0 };
      state.assist = { id: "", text: "" };
      state.tool = { id: "", name: "", startTs: 0, callId: "" };
      state.asyncMsgs.clear();
      state.lastUserText = "";
      state.tokens = null;
      state.queuedCount = 0;
      state.streamingBehavior = null;
      state.model = client.session.model || "";
      state.streaming = client.session.streaming === true;
      break;
    }
    case "replay_end":
      break;

    case "prompt-queued":
      state.queuedCount += 1;
      break;

    case "streaming-behavior":
      state.streamingBehavior = typeof parsed.behavior === "string" && parsed.behavior ? parsed.behavior : null;
      break;

    case "agent_start":
      if (shouldApplyStreamingTransition(client, parsed)) {
        state.streaming = true;
      }
      state.queuedCount = 0;
      break;

    case "agent_end": {
      if (state.think.id) {
        const endMeta = state.think.startTs
          ? { startTs: state.think.startTs, endTs: parsed.timestamp || Date.now() }
          : undefined;
        patchViewMessage(state, state.think.id, (m) => ({
          ...m,
          className: undefined,
          ...(endMeta ? { meta: { ...m.meta, ...endMeta } } : {}),
        }));
      }
      if (state.assist.id) {
        patchViewMessage(state, state.assist.id, (m) => ({ ...m, className: undefined }));
      }
      state.queuedCount = 0;
      state.streamingBehavior = null;
      state.think = { id: "", text: "", startTs: 0 };
      state.assist = { id: "", text: "" };
      state.lastUserText = "";
      break;
    }

    case "agent_settled":
      if (shouldApplyStreamingTransition(client, parsed)) {
        state.streaming = false;
      }
      break;

    case "message_start": {
      const msg = parsed.message;
      if (!msg) break;
      const ts = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
      if (msg.role === "user") {
        const t = textFromMessage(msg);
        if (t && t !== state.lastUserText) {
          state.lastUserText = t;
          addViewMessage(state, "user", t, undefined, undefined, ts, maxMessages);
        }
      } else if (msg.role === "assistant") {
        state.think = { id: "", text: "", startTs: 0 };
        state.assist = { id: "", text: "" };
      } else if (msg.role === "custom" && msg.display) {
        const content = msg.content || "";
        addViewMessage(
          state,
          "system",
          typeof content === "string" ? content : JSON.stringify(content),
          undefined,
          undefined,
          ts,
          maxMessages,
        );
      }
      break;
    }

    case "message_update": {
      const ae = parsed.assistantMessageEvent;
      if (!ae) break;
      const ts = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
      if (ae.type === "thinking_delta" && ae.delta) {
        state.think.text += ae.delta;
        if (!state.think.id) {
          state.think.startTs = ts;
          state.think.id = addViewMessage(state, "thinking", state.think.text, undefined, undefined, ts, maxMessages);
        } else {
          const text = state.think.text;
          patchViewMessage(state, state.think.id, (m) => ({ ...m, text }));
        }
      }
      if ((ae.type === "text_start" || ae.type === "text_delta") && state.think.id && !state.assist.id) {
        const endMeta = state.think.startTs ? { startTs: state.think.startTs, endTs: ts } : undefined;
        patchViewMessage(state, state.think.id, (m) => ({
          ...m,
          className: undefined,
          ...(endMeta ? { meta: { ...m.meta, ...endMeta } } : {}),
        }));
      }
      if (ae.type === "text_delta" && ae.delta) {
        state.assist.text += ae.delta;
        if (!state.assist.id) {
          state.assist.id = addViewMessage(state, "assistant", state.assist.text, "streaming", undefined, ts, maxMessages);
        } else {
          const text = state.assist.text;
          patchViewMessage(state, state.assist.id, (m) => ({ ...m, text }));
        }
      }
      if (ae.type === "text_end" && state.assist.id) {
        patchViewMessage(state, state.assist.id, (m) => ({ ...m, className: undefined }));
      }
      break;
    }

    case "message_end": {
      const ts = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
      if (state.think.id) {
        const endMeta = state.think.startTs ? { startTs: state.think.startTs, endTs: ts } : undefined;
        patchViewMessage(state, state.think.id, (m) => ({
          ...m,
          className: undefined,
          ...(endMeta ? { meta: { ...m.meta, ...endMeta } } : {}),
        }));
      }
      if (state.assist.id) {
        patchViewMessage(state, state.assist.id, (m) => ({ ...m, className: undefined }));
      }
      state.think = { id: "", text: "", startTs: 0 };
      state.assist = { id: "", text: "" };
      if (parsed.message?.model) state.model = parsed.message.model;
      if (parsed.message?.usage) state.tokens = { ...parsed.message.usage };
      break;
    }

    case "turn_end":
      if (parsed.message?.model) state.model = parsed.message.model;
      if (parsed.message?.usage) state.tokens = { ...parsed.message.usage };
      break;

    case "tool_execution_start": {
      let name = parsed.toolName || "tool";
      let detail = typeof parsed.args?.command === "string" ? parsed.args.command : "";
      if (name === "subagent" && parsed.args) {
        const label = parsed.args.name || parsed.args.agent;
        if (label) name = `subagent (${label})`;
        if (parsed.args.asyncKill) detail = `kill: ${parsed.args.asyncKill}`;
        else if (parsed.args.task) detail = String(parsed.args.task).slice(0, 150);
        else if (Array.isArray(parsed.args.tasks)) detail = `${parsed.args.tasks.length} parallel tasks`;
        else if (Array.isArray(parsed.args.chain)) detail = `${parsed.args.chain.length} chain steps`;
      }
      const cid = parsed.toolCallId || nextViewMessageId(state);
      const ts = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
      const id = addViewMessage(state, name as MessageRole, detail, "tool-call", { callId: cid }, ts, maxMessages);
      state.tool = { id, name, startTs: ts, callId: cid };
      break;
    }

    case "tool_execution_update":
      if (state.tool.id && parsed.partialResult?.content?.[0]?.text) {
        const text = `${state.tool.name}: ${parsed.partialResult.content[0].text}`;
        patchViewMessage(state, state.tool.id, (m) => ({ ...m, text }));
      }
      break;

    case "tool_execution_end": {
      const toolName = state.tool.name || parsed.toolName || "tool";
      const startTs = state.tool.startTs;
      const callId = state.tool.callId || parsed.toolCallId || "";
      state.tool = { id: "", name: "", startTs: 0, callId: "" };
      if (parsed.result?.content?.[0]?.text) {
        const t = parsed.result.content[0].text;
        const endTs = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
        let meta: ChatMessage["meta"] = startTs ? { startTs, endTs, callId } : { callId };
        const results = parsed.result?.details?.results;
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
        addViewMessage(
          state,
          toolName as MessageRole,
          `${parsed.isError ? "✗ " : "✓ "}${t}`,
          "tool-result",
          meta,
          endTs,
          maxMessages,
        );
      }
      break;
    }

    case "async_agent_start": {
      const asyncId = parsed.id as string;
      if (!asyncId) break;
      if (parsed.sessionId && parsed.sessionId !== client.session.sessionId) break;
      const match = findLastViewMessage(state, (m) => m.className === "tool-result" && m.text.includes(asyncId));
      let targetMsgId = match?.id ?? "";
      if (!targetMsgId) {
        const agent = parsed.agent || "agent";
        const repo = String(parsed.cwd || "").split("/").pop() || "";
        targetMsgId = addViewMessage(
          state,
          "system",
          `⏳ ${agent} — ${repo}`,
          "async-agent-running",
          undefined,
          undefined,
          maxMessages,
        );
      }
      state.asyncMsgs.set(asyncId, { msgId: targetMsgId, text: "" });
      break;
    }

    case "async_agent_event": {
      const asyncId = parsed.id as string;
      const inner = parsed.event;
      if (!asyncId || !inner) break;
      if (parsed.sessionId && parsed.sessionId !== client.session.sessionId) break;
      const tracked = state.asyncMsgs.get(asyncId);
      if (!tracked) break;

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
        const detail = inner.args?.command ? ` ${String(inner.args.command).slice(0, 100)}` : "";
        tracked.text += `\n🔧 ${name}${detail}`;
        changed = true;
      }
      if (inner.type === "tool_execution_end" && inner.result?.content?.[0]?.text) {
        const result = String(inner.result.content[0].text).slice(0, 200);
        tracked.text += `\n${inner.isError ? "✗" : "✓"} ${result}`;
        changed = true;
      }
      if (changed) {
        const body = tracked.text.trim();
        patchViewMessage(state, tracked.msgId, (m) => {
          const header = m.text.split("\n")[0];
          return { ...m, text: `${header}\n${body}` };
        });
      }
      break;
    }

    case "async_agent_complete": {
      const asyncId = parsed.id as string;
      if (!asyncId) break;
      if (parsed.sessionId && parsed.sessionId !== client.session.sessionId) break;
      const tracked = state.asyncMsgs.get(asyncId);
      if (!tracked) break;
      const body = tracked.text.trim();
      const success = parsed.success;
      patchViewMessage(state, tracked.msgId, (m) => {
        if (m.className === "async-agent-running") {
          const header = m.text.split("\n")[0].replace("⏳", success === false ? "❌" : "✅");
          return { ...m, text: `${header}\n${body}`, className: "async-agent-done" };
        }
        const status = success === false ? "\n❌ Agent failed" : "\n✅ Agent complete";
        const header = m.text.split("\n")[0];
        return { ...m, text: `${header}\n${body}${status}` };
      });
      state.asyncMsgs.delete(asyncId);
      break;
    }

    case "extension_ui_request": {
      if (client.replaying || !isInteractiveUiRequest(parsed)) break;
      const askId = parsed.id as string;
      const prefix = `ask|${askId}|`;
      if (findLastViewMessage(state, (m) => Boolean(m.className?.startsWith(prefix)))) break;
      const title = parsed.title || "Input needed";
      const opts = parsed.method === "confirm" ? ["Yes", "No"] : parsed.options || [];
      const ts = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
      addViewMessage(
        state,
        "ask_user" as MessageRole,
        `${title}${parsed.message ? "\n" + parsed.message : ""}`,
        `${prefix}${parsed.method}|${opts.join("|||")}`,
        undefined,
        ts,
        maxMessages,
      );
      break;
    }

    case "ui-dismiss":
      if (typeof parsed.id === "string" && parsed.id.length > 0) {
        dismissViewAsk(state, parsed.id);
      }
      break;

    case "coms_peer_event": {
      const content = parsed.content || "";
      addViewMessage(
        state,
        "system",
        typeof content === "string" ? content : JSON.stringify(content),
        undefined,
        undefined,
        typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
        maxMessages,
      );
      break;
    }

    case "notification":
      addViewMessage(
        state,
        "system",
        `⚠️ ${parsed.message || "notification"}`,
        undefined,
        undefined,
        typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
        maxMessages,
      );
      break;

    case "commands-list":
      if (Array.isArray(parsed.commands)) {
        state.availableCommands = parsed.commands
          .filter((cmd: any) => cmd && typeof cmd.name === "string")
          .map((cmd: any) => ({ name: cmd.name, description: typeof cmd.description === "string" ? cmd.description : "" }));
      }
      break;
  }
}

export function buildSessionSnapshot(client: PiClient): SessionSnapshotPayload {
  const state = client.viewState;
  const asyncMsgs: Record<string, { msgId: string; text: string }> = {};
  for (const [id, entry] of state.asyncMsgs.entries()) {
    asyncMsgs[id] = { ...entry };
  }

  const pendingUiRequests: PendingUiRequestPayload[] = [];
  for (const raw of snapshotPendingUiRequests(client)) {
    try {
      const parsed = JSON.parse(raw);
      if (isInteractiveUiRequest(parsed)) {
        pendingUiRequests.push(parsed as PendingUiRequestPayload);
      }
    } catch (err) {
      log.warn("skipping malformed pending UI request in snapshot", err);
    }
  }

  return {
    type: "session_snapshot",
    sessionId: client.session.sessionId,
    messages: state.messages.map((m) => (m.meta ? { ...m, meta: { ...m.meta } } : { ...m })),
    live: {
      think: { ...state.think },
      assist: { ...state.assist },
      tool: { ...state.tool },
      asyncMsgs,
      lastUserText: state.lastUserText,
    },
    model: state.model || client.session.model || "",
    tokens: state.tokens ? { ...state.tokens } : null,
    streaming: state.streaming,
    queuedCount: state.queuedCount,
    streamingBehavior: state.streamingBehavior,
    availableCommands: state.availableCommands.map((c) => ({ ...c })),
    pendingUiRequests,
  };
}

export function sendSessionSnapshot(
  ws: { send: (data: string) => void },
  client: PiClient,
): { messageCount: number; pendingCount: number } {
  const snapshot = buildSessionSnapshot(client);
  try {
    ws.send(JSON.stringify(snapshot));
    log.debug("session_snapshot sent", {
      sessionId: client.session.sessionId,
      messageCount: snapshot.messages.length,
      pendingCount: snapshot.pendingUiRequests.length,
    });
  } catch (err) {
    log.warn("failed to send session_snapshot", err);
  }
  return {
    messageCount: snapshot.messages.length,
    pendingCount: snapshot.pendingUiRequests.length,
  };
}

export function isInteractiveUiRequest(parsed: any): boolean {
  return (
    parsed?.type === "extension_ui_request" &&
    typeof parsed.id === "string" &&
    parsed.id.length > 0 &&
    (parsed.method === "select" || parsed.method === "confirm" || parsed.method === "input")
  );
}

export function recordPendingUiRequest(
  store: PendingUiRequestStore,
  parsed: any,
  raw: string,
  max = PENDING_UI_REQUESTS_MAX,
): boolean {
  if (store.replaying || !isInteractiveUiRequest(parsed)) return false;
  const id = parsed.id as string;
  if (store.pendingUiRequests.has(id)) {
    store.pendingUiRequests.delete(id);
  } else if (store.pendingUiRequests.size >= max) {
    const oldest = store.pendingUiRequests.keys().next().value;
    if (oldest !== undefined) store.pendingUiRequests.delete(oldest);
  }
  store.pendingUiRequests.set(id, raw);
  return true;
}

export function dismissPendingUiRequest(store: PendingUiRequestStore, id: unknown): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  return store.pendingUiRequests.delete(id);
}

export function clearPendingUiRequests(store: PendingUiRequestStore): number {
  const count = store.pendingUiRequests.size;
  store.pendingUiRequests.clear();
  return count;
}

export function snapshotPendingUiRequests(store: PendingUiRequestStore): string[] {
  return Array.from(store.pendingUiRequests.values());
}

export function processPiPendingUiEvent(
  client: PiClient,
  parsed: any,
  raw: string,
  sendToWatchers: (sessionId: string, eventOrRaw: object | string) => void,
): "recorded" | "dismissed" | null {
  let action: "recorded" | "dismissed" | null = null;
  if (recordPendingUiRequest(client, parsed, raw)) {
    action = "recorded";
  } else if (parsed?.type === "ui-dismiss" && dismissPendingUiRequest(client, parsed.id)) {
    action = "dismissed";
  }

  applyEventToViewState(client, parsed);

  sendToWatchers(client.session.sessionId, raw);
  return action;
}

export function forwardBrowserUiResponse(
  client: PiClient,
  parsed: any,
): Record<string, unknown> | null {
  if (parsed?.type !== "extension_ui_response" || !parsed.id || !client.ws) return null;
  const response: Record<string, unknown> = { type: "extension_ui_response", id: parsed.id };
  if (parsed.value !== undefined) response.value = parsed.value;
  if (parsed.confirmed !== undefined) response.confirmed = parsed.confirmed;
  if (parsed.cancelled) response.cancelled = true;
  client.ws.send(JSON.stringify(response));
  return response;
}

function registeredSession(parsed: any): SessionInfo {
  const activity = parsed.activity === "working" || parsed.activity === "waiting_for_input" ? parsed.activity : "idle";
  const streaming = typeof parsed.streaming === "boolean" ? parsed.streaming : false;
  return {
    sessionId: parsed.sessionId || `${parsed.pid}:${parsed.cwd}`,
    pid: parsed.pid,
    cwd: parsed.cwd || "",
    branch: parsed.branch || "",
    model: parsed.model || "",
    reasoning: typeof parsed.reasoning === "boolean" ? parsed.reasoning : undefined,
    // Explicit boolean: a model change to a text-only model must clear the flag,
    // not leave the previous model's capability behind (Qodo 3e547c6d).
    supportsImages: typeof parsed.supportsImages === "boolean" ? parsed.supportsImages : undefined,
    startedAt: parsed.startedAt || new Date().toISOString(),
    lastActivity: Date.now(),
    active: true,
    sessionFile: parsed.sessionFile || "",
    gitDirty: parsed.gitDirty || false,
    gitChanges: parsed.gitChanges || 0,
    container: parsed.container || false,
    contextWindow: parsed.contextWindow || 0,
    diffPort: parsed.diffPort || null,
    thinkingLevel: parsed.thinkingLevel || "medium",
    name: parsed.name || undefined,
    comsName: parsed.comsName || undefined,
    comsPurpose: parsed.comsPurpose || undefined,
    comsProject: parsed.comsProject || undefined,
    trailTokenSavings: Number.isSafeInteger(parsed.trailTokenSavings) && parsed.trailTokenSavings >= 0 ? parsed.trailTokenSavings : undefined,
    ...initialActivityState(),
    activity,
    activitySequence: Number.isSafeInteger(parsed.activitySequence) ? parsed.activitySequence : 0,
    activityBeforePrompt: parsed.activityBeforePrompt === "working" || parsed.activityBeforePrompt === "waiting_for_input" || parsed.activityBeforePrompt === "idle" ? parsed.activityBeforePrompt : undefined,
    streaming,
    working: activity === "working",
  };
}

/**
 * Whether a model accepts image input.
 *
 * One helper for every payload that names a model (registration, update_info,
 * set-model, session switch) so the producer side is a single tested function
 * instead of four inline expressions (Qodo 24f50129).
 */
export function supportsImagesFor(model: { input?: unknown } | null | undefined): boolean {
  const supported = Array.isArray(model?.input) && model.input.includes("image");
  log.debug("model image support", { model: (model as { name?: string } | null)?.name ?? null, supported });
  return supported;
}

/**
 * The model fields every payload that names a model must carry.
 *
 * Extracted so the SESSION SWITCH producer — not just the consumer — is covered
 * by a test: a switch that omits the capability left the daemon holding the
 * previous model's value (Qodo 24f50129).
 */
export function modelInfoPayload(
  model: { name?: string; id?: string; input?: unknown; reasoning?: boolean; contextWindow?: number } | null | undefined,
): { model: string; supportsImages: boolean; reasoning: boolean; contextWindow: number } {
  return {
    model: model?.name || model?.id || "",
    supportsImages: supportsImagesFor(model),
    reasoning: model?.reasoning === true,
    contextWindow: model?.contextWindow || 0,
  };
}

export function registerPidashSession(
  sessions: Map<string, PiClient>,
  ws: any,
  parsed: any,
  broadcast: (event: object) => void,
): PiClient {
  const session = registeredSession(parsed);
  const existing = sessions.get(session.sessionId);
  let client: PiClient;
  if (existing) {
    if (!session.name && existing.session.name) session.name = existing.session.name;
    if (!session.comsName && existing.session.comsName) session.comsName = existing.session.comsName;
    if (!session.comsPurpose && existing.session.comsPurpose) session.comsPurpose = existing.session.comsPurpose;
    if (!session.comsProject && existing.session.comsProject) session.comsProject = existing.session.comsProject;
    existing.ws = ws;
    existing.session = session;
    existing.viewState = createSessionViewState(session);
    existing.pendingUiRequests.clear();
    existing.replaying = true;
    existing.connectionGeneration++;
    client = existing;
  } else {
    client = {
      ws,
      session,
      viewState: createSessionViewState(session),
      pendingUiRequests: new Map(),
      replaying: true,
      connectionGeneration: 1,
    };
  }
  sessions.set(session.sessionId, client);
  log.info(`session registered: session=${session.sessionId} streaming=${session.streaming}`);
  broadcast({ type: "session_added", session });
  return client;
}

export function updatePidashSession(session: SessionInfo, parsed: any): void {
  if (typeof parsed.reasoning === "boolean") session.reasoning = parsed.reasoning;
  if (typeof parsed.supportsImages === "boolean") session.supportsImages = parsed.supportsImages;
  if (parsed.trailTokenSavings !== undefined && Number.isSafeInteger(parsed.trailTokenSavings) && parsed.trailTokenSavings >= 0) {
    session.trailTokenSavings = parsed.trailTokenSavings;
  }
  session.lastActivity = Date.now();
}

export function disconnectPidashSession(
  client: PiClient,
  ws: any,
  source: "close" | "error",
  broadcast: (event: object) => void,
): void {
  if (client.ws !== ws) {
    log.debug(`stale connection ${source} ignored: session=${client.session.sessionId}`);
    return;
  }
  client.session.active = false;
  client.session.activity = "idle";
  client.session.activityBeforePrompt = undefined;
  client.session.streaming = false;
  client.session.working = false;
  client.viewState.streaming = false;
  dismissAllViewAsks(client.viewState);
  clearPendingUiRequests(client);
  client.ws = null;
  log.info(`session disconnected: session=${client.session.sessionId} source=${source}`);
  broadcast({ type: "session_updated", session: client.session });
}

export function createPidashSessionState(
  broadcast: (event: object) => void,
  sessions = new Map<string, PiClient>(),
) {
  log.debug(`session state created: sessions=${sessions.size}`);
  return {
    sessions,
    register: (ws: any, parsed: any) => registerPidashSession(sessions, ws, parsed, broadcast),
    disconnect: (client: PiClient, ws: any, source: "close" | "error") => disconnectPidashSession(client, ws, source, broadcast),
  };
}
