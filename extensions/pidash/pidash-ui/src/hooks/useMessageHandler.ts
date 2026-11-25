import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage, NotificationPreferences, PiEvent, SessionInfo, TokenUsage } from "@/types";
import {
  applyTranscriptEvent,
  type TranscriptRefs,
  type TranscriptSink,
} from "../../../../shared/pidash-transcript-reducer.ts";
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

interface MessageSink extends TranscriptSink {
  clear(): void;
}

function emptyTranscriptRefs(): TranscriptRefs {
  return {
    think: { id: "", text: "", startTs: 0 },
    assist: { id: "", text: "" },
    tool: { id: "", name: "", startTs: 0, callId: "" },
    asyncMsgs: new Map(),
    lastUserText: "",
  };
}

const scheduleFrame = typeof requestAnimationFrame === "function"
  ? requestAnimationFrame
  : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number;

const cancelFrame = typeof cancelAnimationFrame === "function"
  ? cancelAnimationFrame
  : (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

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

  const refsRef = useRef<TranscriptRefs>(emptyTranscriptRefs());
  const messagesRef = useRef(messages);
  const sessionRef = useRef(session);
  const watchedSessionIdRef = useRef<string | null>(session?.sessionId ?? null);
  const notificationsRef = useRef(notifications);
  const dirtyDeltaRef = useRef({ think: false, assist: false });
  const deltaRafRef = useRef<number | null>(null);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => {
    sessionRef.current = session;
    watchedSessionIdRef.current = session?.sessionId ?? null;
  }, [session]);
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
      const thinkId = think ? refsRef.current.think.id : "";
      const thinkText = think ? refsRef.current.think.text : "";
      const assistId = assist ? refsRef.current.assist.id : "";
      const assistText = assist ? refsRef.current.assist.text : "";
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
      add(role, text, className, meta, options) {
        const id = options?.explicitId ?? nextId();
        const msg: ChatMessage = { id, role, text, className, meta, timestamp: options?.timestamp ?? Date.now() };
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
      nextId,
      clear() {
        messagesRef.current = [];
        setMessages([]);
      },
    };

    // Replay buffering (Pi reconnect): wrap historical replay frames into a
    // plain local array and commit the whole transcript in a single O(N) pass.
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

      if (applyTranscriptEvent(ev, refsRef.current, sink, {
        onStreamingChange: (nextStreaming) => setStreaming(nextStreaming),
        onQueuedIncrement: () => setQueuedCount((c) => c + 1),
        onQueuedReset: () => setQueuedCount(0),
        onStreamingBehavior: (behavior) => setStreamingBehavior(behavior),
        onModel: (nextModel) => setModel(nextModel),
        onTokens: (nextTokens) => setTokens(nextTokens),
        onCommandsList: (commands) => setAvailableCommands(commands),
        onFlushLiveDeltas: isReplay ? undefined : flushLiveDeltas,
        onScheduleDelta: isReplay ? undefined : (kind) => {
          dirtyDeltaRef.current[kind] = true;
          scheduleDeltaFlush();
          return true;
        },
        shouldSkipUiRequest: (req) => Boolean(isReplay && req.timestamp && Date.now() - req.timestamp > 10000),
        sessionId: () => watchedSessionIdRef.current ?? sessionRef.current?.sessionId,
      })) {
        return;
      }

      switch (ev.type) {
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

        case "session_info_changed":
          if ((ev as any).name !== undefined) {
            setSession((prev) => prev ? { ...prev, name: (ev as any).name } : prev);
          }
          break;

        case "replay_start":
          sink.clear();
          break;
        case "replay_end":
          break;
      }
    };

    const foldReplay = (buffered: PiEvent[]) => {
      const draft: ChatMessage[] = [];
      const indexById = new Map<string, number>();
      const draftSink: MessageSink = {
        add(role, text, className, meta, options) {
          const id = options?.explicitId ?? nextId();
          indexById.set(id, draft.length);
          draft.push({ id, role, text, className, meta, timestamp: options?.timestamp ?? Date.now() });
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
        nextId,
        clear() {
          draft.length = 0;
          indexById.clear();
        },
      };
      for (const bufferedEv of buffered) processEvent(bufferedEv, draftSink, true);
      messagesRef.current = draft;
      setMessages(draft);
    };

    // Coalesce the events of one task into a single processing pass.
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
        const expectedSessionId = watchedSessionIdRef.current;
        if (ev.sessionId && expectedSessionId && ev.sessionId !== expectedSessionId) {
          log.debug("stale session_snapshot ignored", {
            snapshotSessionId: ev.sessionId,
            watchedSessionId: expectedSessionId,
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

        refsRef.current = {
          think: ev.live?.think ? { ...ev.live.think } : { id: "", text: "", startTs: 0 },
          assist: ev.live?.assist ? { ...ev.live.assist } : { id: "", text: "" },
          tool: ev.live?.tool ? { ...ev.live.tool } : { id: "", name: "", startTs: 0, callId: "" },
          lastUserText: ev.live?.lastUserText || "",
          asyncMsgs: new Map(
            Object.entries(ev.live?.asyncMsgs ?? {})
              .filter(([, entry]) => Boolean(entry && typeof entry.msgId === "string"))
              .map(([id, entry]) => [id, { ...entry }]),
          ),
        };

        const fallbackModel = !ev.sessionId || sessionRef.current?.sessionId === ev.sessionId
          ? (sessionRef.current?.model || "")
          : "";
        setModel(ev.model || fallbackModel);
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

  const resetHandlerState = useCallback((nextSessionId?: string | null) => {
    if (nextSessionId !== undefined) {
      watchedSessionIdRef.current = nextSessionId;
    }
    if (deltaRafRef.current !== null) {
      cancelFrame(deltaRafRef.current);
      deltaRafRef.current = null;
    }
    dirtyDeltaRef.current = { think: false, assist: false };
    refsRef.current = emptyTranscriptRefs();
  }, []);

  const setLastUserText = useCallback((text: string) => {
    refsRef.current.lastUserText = text;
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
