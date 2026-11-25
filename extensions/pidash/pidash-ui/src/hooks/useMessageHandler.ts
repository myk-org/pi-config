import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage, NotificationPreferences, PiEvent, SessionInfo, TokenUsage } from "@/types";
import { createLogger } from "../lib/create-logger";

const log = createLogger("MessageHandler");

let counter = 0;
export const nextId = () => `m-${++counter}`;

export function patchMessageById(
  prev: ChatMessage[],
  id: string,
  patch: (msg: ChatMessage) => ChatMessage,
): ChatMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].id === id) {
      const next = prev.slice();
      next[i] = patch(prev[i]);
      return next;
    }
  }
  return prev;
}

interface MessageSink {
  add(role: ChatMessage["role"], text: string, className?: string, meta?: ChatMessage["meta"], explicitId?: string): string;
  patch(id: string, fn: (msg: ChatMessage) => ChatMessage): void;
  findLast(pred: (msg: ChatMessage) => boolean): ChatMessage | undefined;
  dismissAsk(askId: string): void;
  clear(): void;
}

const scheduleFrame = typeof requestAnimationFrame === "function"
  ? requestAnimationFrame
  : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number;

const cancelFrame = typeof cancelAnimationFrame === "function"
  ? cancelAnimationFrame
  : (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

const textFrom = (msg: any): string =>
  (msg?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

interface Notifications {
  preferences: NotificationPreferences;
  notify: (title: string, options?: NotificationOptions) => void;
}

export function useMessageHandler(
  onMessage: (handler: (ev: PiEvent) => void) => () => void,
  session: SessionInfo | null,
  notifications: Notifications,
  setSession: Dispatch<SetStateAction<SessionInfo | null>>,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [model, setModel] = useState("");
  const [tokens, setTokens] = useState<TokenUsage | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [streamingBehavior, setStreamingBehavior] = useState<string | null>(null);
  const [availableCommands, setAvailableCommands] = useState<Array<{ name: string; description: string }>>([]);

  const thinkRef = useRef({ id: "", text: "", startTs: 0 });
  const assistRef = useRef({ id: "", text: "" });
  const lastUserRef = useRef("");
  const toolRef = useRef({ id: "", name: "", startTs: 0, callId: "" });
  const asyncMsgRef = useRef<Map<string, { msgId: string; text: string }>>(new Map());
  const messagesRef = useRef(messages);
  const sessionRef = useRef(session);
  const notificationsRef = useRef(notifications);
  const dirtyDeltaRef = useRef({ think: false, assist: false });
  const deltaRafRef = useRef<number | null>(null);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { notificationsRef.current = notifications; }, [notifications]);

  const addMsg = useCallback((role: ChatMessage["role"], text: string, className?: string, meta?: ChatMessage["meta"]): string => {
    const id = nextId();
    setMessages((p) => [...p, { id, role, text, className, meta, timestamp: Date.now() }]);
    return id;
  }, []);

  useEffect(() => {
    const flushLiveDeltas = () => {
      if (deltaRafRef.current !== null) {
        cancelFrame(deltaRafRef.current);
        deltaRafRef.current = null;
      }
      const { think, assist } = dirtyDeltaRef.current;
      if (!think && !assist) return;
      dirtyDeltaRef.current.think = false;
      dirtyDeltaRef.current.assist = false;
      const thinkId = think ? thinkRef.current.id : "";
      const thinkText = think ? thinkRef.current.text : "";
      const assistId = assist ? assistRef.current.id : "";
      const assistText = assist ? assistRef.current.text : "";
      if (!thinkId && !assistId) return;
      setMessages((prev) => {
        let next = prev;
        if (thinkId) {
          next = patchMessageById(next, thinkId, (m) => ({ ...m, text: thinkText }));
        }
        if (assistId) {
          next = patchMessageById(next, assistId, (m) => ({ ...m, text: assistText }));
        }
        return next;
      });
    };

    const scheduleDeltaFlush = () => {
      if (deltaRafRef.current !== null) return;
      deltaRafRef.current = scheduleFrame(() => {
        deltaRafRef.current = null;
        flushLiveDeltas();
      });
    };

    const liveSink: MessageSink = {
      add(role, text, className, meta, explicitId) {
        const id = explicitId ?? nextId();
        const msg: ChatMessage = { id, role, text, className, meta, timestamp: Date.now() };
        messagesRef.current = [...messagesRef.current, msg];
        setMessages((p) => [...p, msg]);
        return id;
      },
      patch(id, fn) {
        setMessages((p) => patchMessageById(p, id, fn));
      },
      findLast(pred) {
        const current = messagesRef.current;
        for (let i = current.length - 1; i >= 0; i--) {
          if (pred(current[i])) return current[i];
        }
        return undefined;
      },
      dismissAsk(askId) {
        const update = (prev: ChatMessage[]) => prev.map((m) => (
          m.className?.startsWith(`ask|${askId}|`) ? { ...m, className: `ask-answered|${askId}` } : m
        ));
        messagesRef.current = update(messagesRef.current);
        setMessages(update);
      },
      clear() {
        messagesRef.current = [];
        setMessages([]);
      },
    };

    // Replay buffering (session-switch UX): during a session replay the server
    // sends one websocket message per historical delta — folding them into a
    // plain local array commits the whole transcript in a single O(N) pass.
    const replayBuffer: PiEvent[] = [];
    let replaying = false;
    const processEvent = (ev: PiEvent, sink: MessageSink, isReplay: boolean) => {
      if (ev.type === "session_added" || ev.type === "session_removed") return;
          if (ev.type === "session_updated" && ev.session) {
            const update = ev.session;
            // Side effects stay OUT of the state updater: an updater may be
            // deferred or replayed, and this one used to carry the streaming
            // sync (Qodo 6284bef1 found it untested for exactly that reason).
            // sessionRef, never the closed-over `session`: this effect's deps omit
            // it, so a session selected after mount would never match and the
            // model label / Stop button would stop following the daemon (Qodo).
            if (sessionRef.current?.sessionId === update.sessionId) {
              if (update.model !== undefined) {
                log.debug("model synced from session_updated", { sessionId: update.sessionId, model: update.model });
                setModel(update.model);
              }
              // Keep the Stop button in step with the daemon: turns started or
              // settled outside this browser (TUI, another tab) change the
              // streaming flag with no agent_start/agent_settled here.
              if (update.streaming !== undefined) {
                log.debug("streaming synced from session_updated", {
                  sessionId: update.sessionId, streaming: update.streaming,
                });
                setStreaming(update.streaming);
              }
            }
            setSession((prev) => (prev && prev.sessionId === update.sessionId ? { ...prev, ...update } : prev));
            return;
          }

      switch (ev.type) {
        case "prompt-queued":
          setQueuedCount(c => c + 1);
          break;
        case "streaming-behavior":
          setStreamingBehavior(ev.behavior || null);
          break;
        case "agent_start":
          setStreaming(true);
          setQueuedCount(0);
          break;
        case "ui_prompt_start":
          // Pi is awaiting an interactive prompt. Streaming and queued browser prompts remain independent.
          break;
        case "ui_prompt_end":
          break;
        case "agent_end":
          if (!isReplay) flushLiveDeltas();
          setQueuedCount(0);
          setStreamingBehavior(null);
          thinkRef.current = { id: "", text: "", startTs: 0 };
          assistRef.current = { id: "", text: "" };
          lastUserRef.current = "";
          break;
        case "agent_settled":
          setStreaming(false);
          break;

        case "message_start": {
          if (!isReplay) flushLiveDeltas();
          const msg = ev.message;
          if (!msg) break;
          if (msg.role === "user") {
            const t = textFrom(msg);
            if (t && t !== lastUserRef.current) { lastUserRef.current = t; sink.add("user", t); }
          }
          if (msg.role === "assistant") {
            thinkRef.current = { id: "", text: "", startTs: 0 };
            assistRef.current = { id: "", text: "" };
          }
          if (msg.role === "custom" && msg.display) {
            const content = msg.content || "";
            sink.add("system", typeof content === "string" ? content : JSON.stringify(content));
          }
          break;
        }

        case "message_update": {
          const ae = ev.assistantMessageEvent;
          if (!ae) break;
          if (ae.type === "thinking_delta" && ae.delta) {
            thinkRef.current.text += ae.delta;
            if (!thinkRef.current.id) {
              thinkRef.current.startTs = Date.now();
              thinkRef.current.id = sink.add("thinking", thinkRef.current.text);
            } else if (isReplay) {
              const text = thinkRef.current.text;
              sink.patch(thinkRef.current.id, (m) => ({ ...m, text }));
            } else {
              dirtyDeltaRef.current.think = true;
              scheduleDeltaFlush();
            }
          }
          if ((ae.type === "text_start" || ae.type === "text_delta") && thinkRef.current.id && !assistRef.current.id) {
            if (!isReplay) flushLiveDeltas();
            const endMeta = thinkRef.current.startTs
              ? { startTs: thinkRef.current.startTs, endTs: Date.now() }
              : undefined;
            sink.patch(thinkRef.current.id, (m) => ({
              ...m,
              className: undefined,
              ...(endMeta ? { meta: { ...m.meta, ...endMeta } } : {}),
            }));
          }
          if (ae.type === "text_delta" && ae.delta) {
            assistRef.current.text += ae.delta;
            if (!assistRef.current.id) {
              assistRef.current.id = sink.add("assistant", assistRef.current.text, "streaming");
            } else if (isReplay) {
              const text = assistRef.current.text;
              sink.patch(assistRef.current.id, (m) => ({ ...m, text }));
            } else {
              dirtyDeltaRef.current.assist = true;
              scheduleDeltaFlush();
            }
          }
          if (ae.type === "text_end" && assistRef.current.id) {
            if (!isReplay) flushLiveDeltas();
            sink.patch(assistRef.current.id, (m) => ({ ...m, className: undefined }));
          }
          // model and usage are set from message_end / turn_end events
          break;
        }

        case "message_end":
          if (!isReplay) flushLiveDeltas();
          if (thinkRef.current.id) {
            const endMeta = thinkRef.current.startTs
              ? { startTs: thinkRef.current.startTs, endTs: Date.now() }
              : undefined;
            sink.patch(thinkRef.current.id, (m) => ({
              ...m,
              className: undefined,
              ...(endMeta ? { meta: { ...m.meta, ...endMeta } } : {}),
            }));
          }
          if (assistRef.current.id) sink.patch(assistRef.current.id, (m) => ({ ...m, className: undefined }));
          thinkRef.current = { id: "", text: "", startTs: 0 };
          assistRef.current = { id: "", text: "" };
          if (ev.message?.model) setModel(ev.message.model);
          if (ev.message?.usage) setTokens({ ...ev.message.usage });
          break;

        case "turn_end":
          if (ev.message?.model) setModel(ev.message.model);
          if (ev.message?.usage) setTokens({ ...ev.message.usage });
          break;

        case "tool_execution_start": {
          if (!isReplay) flushLiveDeltas();
          let name = ev.toolName || "tool";
          let detail = ev.args?.command ? ev.args.command : "";
          // Show agent name for subagent tool calls
          if (name === "subagent" && ev.args) {
            const label = ev.args.name || ev.args.agent;
            if (label) name = `subagent (${label})`;
            if (ev.args.asyncKill) detail = `kill: ${ev.args.asyncKill}`;
            else if (ev.args.task) detail = ev.args.task.slice(0, 150);
            else if (ev.args.tasks) detail = `${ev.args.tasks.length} parallel tasks`;
            else if (ev.args.chain) detail = `${ev.args.chain.length} chain steps`;
          }
          const cid = ev.toolCallId || nextId();
          const id = sink.add(name as any, detail, "tool-call", { callId: cid });
          toolRef.current = { id, name, startTs: ev.timestamp || Date.now(), callId: cid };
          break;
        }

        case "tool_execution_update":
          if (toolRef.current.id && ev.partialResult?.content?.[0]?.text) {
            const text = `${toolRef.current.name}: ${ev.partialResult.content[0].text}`;
            sink.patch(toolRef.current.id, (m) => ({ ...m, text }));
          }
          break;

        case "tool_execution_end": {
          const toolName = toolRef.current.name || ev.toolName || "tool";
          const startTs = toolRef.current.startTs;
          const callId = toolRef.current.callId;
          toolRef.current = { id: "", name: "", startTs: 0, callId: "" };
          if (ev.result?.content?.[0]?.text) {
            const t = ev.result.content[0].text;
            const endTs = ev.timestamp || Date.now();
            let meta: ChatMessage["meta"] = startTs ? { startTs, endTs, callId } : { callId };
            const results = ev.result?.details?.results;
            if (results?.length) {
              let totalInput = 0, totalOutput = 0, totalTurns = 0, totalCache = 0, totalCtx = 0, totalCost = 0;
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
            sink.add(toolName as any, `${ev.isError ? "✗ " : "✓ "}${t}`, "tool-result", meta);
          }
          break;
        }

        case "session_input_needed": {
          const n = notificationsRef.current;
          if (!n.preferences.inputNeeded) break;
          const isWatched = ev.sessionId === sessionRef.current?.sessionId;
          const tabFocused = document.hasFocus();
          if (tabFocused && isWatched) break;
          const repo = ev.cwd?.split("/").pop() || "session";
          n.notify(`Input needed — ${repo}`, { body: ev.title || "Waiting for your response" });
          break;
        }

        case "session_turn_complete": {
          const n = notificationsRef.current;
          if (!n.preferences.turnComplete) break;
          const isWatched = ev.sessionId === sessionRef.current?.sessionId;
          const tabFocused = document.hasFocus();
          if (tabFocused && isWatched) break;
          const repo = ev.cwd?.split("/").pop() || "session";
          n.notify(`AI done — ${repo}`, { body: "Ready for input" });
          break;
        }

        case "session_notification": {
          const n = notificationsRef.current;
          const isWatched = ev.sessionId === sessionRef.current?.sessionId;
          const tabFocused = document.hasFocus();

          // Tab not focused → notify for ALL sessions
          // Tab focused → notify only for non-watched sessions
          if (tabFocused && isWatched) break;

          const repo = ev.cwd?.split("/").pop() || "session";

          const txt = (ev.resultText || "").toLowerCase();
              const tl = (ev.toolName || "").toLowerCase();
              const isTestEvent = tl.includes("test") || txt.includes("pytest") || txt.includes("test_");

              if (ev.isError && n.preferences.sessionError) {
                n.notify(`Error — ${repo}`, { body: "Tool execution failed" });
              } else if (ev.isSubagent && n.preferences.agentComplete) {
                const agentLabel = ev.agentName || "agent";
                n.notify(`Agent finished — ${repo}`, { body: agentLabel });
              } else if (isTestEvent && n.preferences.testResults) {
                const passed = !ev.isError && !txt.includes("fail") && !txt.includes("error");
                n.notify(passed ? `Tests: ✓ Passed — ${repo}` : `Tests: ✗ Failed — ${repo}`);
              } else if (n.preferences.toolComplete && !ev.isError && !ev.isSubagent) {
                n.notify(`Tool: ${ev.toolName || "tool"} — ${repo}`);
              }
          break;
        }

        case "async_agent_start": {
          const asyncId = ev.id as string;
          if (!asyncId) break;
          // Only show async agents from the watched session
          if ((ev as any).sessionId && (ev as any).sessionId !== sessionRef.current?.sessionId) break;
          // Find the subagent tool-result message that spawned this async agent
          const match = sink.findLast((m) => m.className === "tool-result" && m.text.includes(asyncId));
          let targetMsgId = match?.id ?? "";
          if (!targetMsgId) {
            // Fallback: create inline message
            const agent = (ev as any).agent || "agent";
            const repo = ((ev as any).cwd || "").split("/").pop() || "";
            targetMsgId = sink.add("system" as any, `⏳ ${agent} — ${repo}`, "async-agent-running");
          }
          asyncMsgRef.current.set(asyncId, { msgId: targetMsgId, text: "" });
          break;
        }

        case "async_agent_event": {
          const asyncId = ev.id as string;
          const inner = (ev as any).event;
          if (!asyncId || !inner) break;
          if ((ev as any).sessionId && (ev as any).sessionId !== sessionRef.current?.sessionId) break;
          const tracked = asyncMsgRef.current.get(asyncId);
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
            const detail = inner.args?.command ? ` ${inner.args.command.slice(0, 100)}` : "";
            tracked.text += `\n🔧 ${name}${detail}`;
            changed = true;
          }

          if (inner.type === "tool_execution_end" && inner.result?.content?.[0]?.text) {
            const result = inner.result.content[0].text.slice(0, 200);
            tracked.text += `\n${inner.isError ? "✗" : "✓"} ${result}`;
            changed = true;
          }

          if (changed) {
            const body = tracked.text.trim();
            sink.patch(tracked.msgId, (m) => {
              const header = m.text.split("\n")[0];
              return { ...m, text: header + "\n" + body };
            });
          }
          break;
        }

        case "async_agent_complete": {
          const asyncId = ev.id as string;
          if (!asyncId) break;
          if ((ev as any).sessionId && (ev as any).sessionId !== sessionRef.current?.sessionId) break;
          const tracked = asyncMsgRef.current.get(asyncId);
          if (!tracked) break;
          const body = tracked.text.trim();
          const success = (ev as any).success;
          sink.patch(tracked.msgId, (m) => {
            if (m.className === "async-agent-running") {
              // Fallback system message — update icon
              const header = m.text.split("\n")[0].replace("⏳", success === false ? "❌" : "✅");
              return { ...m, text: header + "\n" + body, className: "async-agent-done" };
            }
            // Tool-result message — just mark as complete by appending status
            const status = success === false ? "\n❌ Agent failed" : "\n✅ Agent complete";
            const header = m.text.split("\n")[0];
            return { ...m, text: header + "\n" + body + status };
          });
          asyncMsgRef.current.delete(asyncId);
          break;
        }

        case "extension_ui_request":
          // Only skip stale UI requests during historical replay; live/post-replay active prompts remain interactive
          if (isReplay && ev.timestamp && Date.now() - ev.timestamp > 10000) break;
          if (ev.id && (ev.method === "select" || ev.method === "confirm" || ev.method === "input")) {
            const askId = ev.id;
            const prefix = `ask|${askId}|`;
            if (sink.findLast((m) => Boolean(m.className?.startsWith(prefix)))) break;
            // Add as inline message with options
            const title = ev.title || "Input needed";
            const opts = ev.method === "confirm" ? ["Yes", "No"] : ev.options || [];
            sink.add("ask_user" as any, `${title}${ev.message ? "\n" + ev.message : ""}`, `${prefix}${ev.method}|${opts.join("|||")}`);
          }
          break;

        case "session_info_changed":
          if ((ev as any).name !== undefined) {
            setSession((prev) => prev ? { ...prev, name: (ev as any).name } : prev);
          }
          break;

        case "coms_peer_event": {
          const content = (ev as any).content || "";
          sink.add("system", typeof content === "string" ? content : JSON.stringify(content));
          break;
        }

        case "replay_start":
          sink.clear();
          break;
        case "replay_end":
          break;

        case "notification":
          sink.add("system", `⚠️ ${(ev as any).message || "notification"}`);
          break;

        case "commands-list":
          if ((ev as any).commands) setAvailableCommands((ev as any).commands);
          break;

        case "ui-dismiss":
          // Mark the inline ask message as answered
          sink.dismissAsk(ev.id as string);
          break;
      }
    };

    const foldReplay = (buffered: PiEvent[]) => {
      const draft: ChatMessage[] = [];
      const indexById = new Map<string, number>();
      const draftSink: MessageSink = {
        add(role, text, className, meta, explicitId) {
          const id = explicitId ?? nextId();
          indexById.set(id, draft.length);
          draft.push({ id, role, text, className, meta, timestamp: Date.now() });
          return id;
        },
        patch(id, fn) {
          const idx = indexById.get(id);
          if (idx !== undefined) draft[idx] = fn(draft[idx]);
        },
        findLast(pred) {
          for (let i = draft.length - 1; i >= 0; i--) {
            if (pred(draft[i])) return draft[i];
          }
          return undefined;
        },
        dismissAsk(askId) {
          const prefix = `ask|${askId}|`;
          for (let i = 0; i < draft.length; i++) {
            if (draft[i].className?.startsWith(prefix)) {
              draft[i].className = `ask-answered|${askId}`;
            }
          }
        },
        clear() {
          draft.length = 0;
          indexById.clear();
        },
      };
      for (const buffered_ev of buffered) processEvent(buffered_ev, draftSink, true);
      messagesRef.current = draft;
      setMessages(draft);
    };

    // Coalesce the events of one task into a single processing pass. A history
    // replay arrives as thousands of individual frames; handling each one in
    // its own task gave one React render per event over a growing, unvirtualized
    // list, which the user sees as the transcript crawling to the bottom.
    let pending: PiEvent[] = [];
    let flushScheduled = false;
    const flush = () => {
      flushScheduled = false;
      const batch = pending;
      pending = [];
      for (const item of batch) handleEvent(item);
    };
    const handleEvent = (ev: PiEvent) => {
      if (ev.type === "session_snapshot") {
        if (ev.sessionId && sessionRef.current?.sessionId && ev.sessionId !== sessionRef.current.sessionId) {
          log.debug("stale session_snapshot ignored", {
            snapshotSessionId: ev.sessionId,
            watchedSessionId: sessionRef.current.sessionId,
          });
          return;
        }
        if (deltaRafRef.current !== null) {
          cancelFrame(deltaRafRef.current);
          deltaRafRef.current = null;
        }
        dirtyDeltaRef.current = { think: false, assist: false };
        replaying = false;
        replayBuffer.length = 0;

        const hydrated: ChatMessage[] = Array.isArray(ev.messages)
          ? ev.messages.map((m) => (m.meta ? { ...m, meta: { ...m.meta } } : { ...m }))
          : [];
        if (Array.isArray(ev.pendingUiRequests)) {
          for (const req of ev.pendingUiRequests) {
            if (!req?.id || (req.method !== "select" && req.method !== "confirm" && req.method !== "input")) {
              continue;
            }
            const prefix = `ask|${req.id}|`;
            if (hydrated.some((m) => Boolean(m.className?.startsWith(prefix)))) continue;
            const title = req.title || "Input needed";
            const opts = req.method === "confirm" ? ["Yes", "No"] : req.options || [];
            hydrated.push({
              id: nextId(),
              role: "ask_user" as any,
              text: `${title}${req.message ? "\n" + req.message : ""}`,
              className: `${prefix}${req.method}|${opts.join("|||")}`,
              timestamp: req.timestamp ?? Date.now(),
            });
          }
        }

        messagesRef.current = hydrated;
        setMessages(hydrated);

        thinkRef.current = ev.live?.think ? { ...ev.live.think } : { id: "", text: "", startTs: 0 };
        assistRef.current = ev.live?.assist ? { ...ev.live.assist } : { id: "", text: "" };
        toolRef.current = ev.live?.tool ? { ...ev.live.tool } : { id: "", name: "", startTs: 0, callId: "" };
        lastUserRef.current = ev.live?.lastUserText || "";
        asyncMsgRef.current = new Map(
          Object.entries(ev.live?.asyncMsgs ?? {}).map(([id, entry]) => [id, { ...entry }]),
        );

        setModel(ev.model || sessionRef.current?.model || "");
        setTokens(ev.tokens ? { ...ev.tokens } : null);
        setStreaming(Boolean(ev.streaming));
        setQueuedCount(typeof ev.queuedCount === "number" ? ev.queuedCount : 0);
        setStreamingBehavior(ev.streamingBehavior ?? null);
        if (Array.isArray(ev.availableCommands)) {
          setAvailableCommands(ev.availableCommands);
        }
        log.debug("session_snapshot applied", {
          sessionId: ev.sessionId,
          messages: hydrated.length,
          pendingUi: ev.pendingUiRequests?.length ?? 0,
          streaming: Boolean(ev.streaming),
        });
        return;
      }
      if (ev.type === "replay_start") {
        flushLiveDeltas();
        replaying = true;
        replayBuffer.length = 0;
        log.debug("replay buffering started");
        processEvent(ev, liveSink, false); // clears the message list
        return;
      }
      if (ev.type === "replay_end") {
        if (replaying) {
          replaying = false;
          const buffered = replayBuffer.splice(0);
          log.debug("replay buffering applied", { events: buffered.length });
          foldReplay(buffered);
        }
        processEvent(ev, liveSink, false);
        return;
      }
      if (replaying) {
        replayBuffer.push(ev);
        return;
      }
      processEvent(ev, liveSink, false);
    };
    const unsubscribe = onMessage((ev: PiEvent) => {
      pending.push(ev);
      if (flushScheduled) return;
      flushScheduled = true;
      // Microtask, not a frame: deltas that arrived together in one task are
      // applied together without adding latency to the live stream.
      queueMicrotask(flush);
    });
    return () => {
      unsubscribe();
      if (deltaRafRef.current !== null) {
        cancelFrame(deltaRafRef.current);
        deltaRafRef.current = null;
      }
      dirtyDeltaRef.current = { think: false, assist: false };
    };
  }, [onMessage, setSession]);

  const resetHandlerState = useCallback(() => {
    if (deltaRafRef.current !== null) {
      cancelFrame(deltaRafRef.current);
      deltaRafRef.current = null;
    }
    dirtyDeltaRef.current = { think: false, assist: false };
    thinkRef.current = { id: "", text: "", startTs: 0 };
    assistRef.current = { id: "", text: "" };
    lastUserRef.current = "";
    toolRef.current = { id: "", name: "", startTs: 0, callId: "" };
    asyncMsgRef.current.clear();
  }, []);

  const setLastUserText = useCallback((text: string) => {
    lastUserRef.current = text;
  }, []);

  return {
    messages, setMessages, addMsg,
    model, setModel,
    tokens, setTokens,
    streaming, setStreaming,
    queuedCount, setQueuedCount,
    streamingBehavior,
    availableCommands,
    resetHandlerState,
    setLastUserText,
  };
}
