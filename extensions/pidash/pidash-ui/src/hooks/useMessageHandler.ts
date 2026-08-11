import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage, NotificationPreferences, PiEvent, SessionInfo, TokenUsage } from "@/types";

let counter = 0;
export const nextId = () => `m-${++counter}`;

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

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { notificationsRef.current = notifications; }, [notifications]);

  const addMsg = useCallback((role: ChatMessage["role"], text: string, className?: string, meta?: ChatMessage["meta"]): string => {
    const id = nextId();
    setMessages((p) => [...p, { id, role, text, className, meta, timestamp: Date.now() }]);
    return id;
  }, []);

  const updMsg = useCallback((id: string, text: string) => {
    setMessages((p) => p.map((m) => m.id === id ? { ...m, text } : m));
  }, []);

  const updCls = useCallback((id: string, className?: string) => {
    setMessages((p) => p.map((m) => m.id === id ? { ...m, className } : m));
  }, []);

  const updMeta = useCallback((id: string, meta: ChatMessage["meta"]) => {
    setMessages((p) => p.map((m) => m.id === id ? { ...m, meta: { ...m.meta, ...meta } } : m));
  }, []);

  useEffect(() => {
    return onMessage((ev: PiEvent) => {
      if (ev.type === "session_added" || ev.type === "session_removed") return;
          if (ev.type === "session_updated" && ev.session) {
            // Update active session if it's the one we're watching
            setSession((prev) => {
              if (prev?.sessionId === ev.session!.sessionId) {
                if (ev.session!.model !== undefined) setModel(ev.session!.model);
                return { ...prev, ...ev.session };
              }
              return prev;
            });
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
        case "agent_end":
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
          const msg = ev.message;
          if (!msg) break;
          if (msg.role === "user") {
            const t = textFrom(msg);
            if (t && t !== lastUserRef.current) { lastUserRef.current = t; addMsg("user", t); }
          }
          if (msg.role === "assistant") {
            thinkRef.current = { id: "", text: "", startTs: 0 };
            assistRef.current = { id: "", text: "" };
          }
          if (msg.role === "custom" && msg.display) {
            const content = msg.content || "";
            addMsg("system", typeof content === "string" ? content : JSON.stringify(content));
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
              thinkRef.current.id = addMsg("thinking", thinkRef.current.text);
            }
            else updMsg(thinkRef.current.id, thinkRef.current.text);
          }
          if ((ae.type === "text_start" || ae.type === "text_delta") && thinkRef.current.id && !assistRef.current.id) {
            updCls(thinkRef.current.id, undefined);
            if (thinkRef.current.startTs) {
              updMeta(thinkRef.current.id, { startTs: thinkRef.current.startTs, endTs: Date.now() });
            }
          }
          if (ae.type === "text_delta" && ae.delta) {
            assistRef.current.text += ae.delta;
            if (!assistRef.current.id) assistRef.current.id = addMsg("assistant", assistRef.current.text, "streaming");
            else updMsg(assistRef.current.id, assistRef.current.text);
          }
          if (ae.type === "text_end" && assistRef.current.id) updCls(assistRef.current.id, undefined);
          // model and usage are set from message_end / turn_end events
          break;
        }

        case "message_end":
          if (thinkRef.current.id) updCls(thinkRef.current.id, undefined);
          if (thinkRef.current.id && thinkRef.current.startTs) {
            updMeta(thinkRef.current.id, { startTs: thinkRef.current.startTs, endTs: Date.now() });
          }
          if (assistRef.current.id) updCls(assistRef.current.id, undefined);
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
          const id = nextId();
          setMessages((p) => [...p, { id, role: name as any, text: detail, className: "tool-call", meta: { callId: cid }, timestamp: Date.now() }]);
          toolRef.current = { id, name, startTs: ev.timestamp || Date.now(), callId: cid };
          break;
        }

        case "tool_execution_update":
          if (toolRef.current.id && ev.partialResult?.content?.[0]?.text) {
            updMsg(toolRef.current.id, `${toolRef.current.name}: ${ev.partialResult.content[0].text}`);
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
            const id = nextId();
            setMessages((p) => [...p, { id, role: toolName as any, text: `${ev.isError ? "✗ " : "✓ "}${t}`, className: "tool-result", meta, timestamp: Date.now() }]);
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
          let targetMsgId = "";
          const currentMsgs = messagesRef.current;
          for (let i = currentMsgs.length - 1; i >= 0; i--) {
            if (currentMsgs[i].className === "tool-result" && currentMsgs[i].text.includes(asyncId)) {
              targetMsgId = currentMsgs[i].id;
              break;
            }
          }
          if (!targetMsgId) {
            // Fallback: create inline message
            const agent = (ev as any).agent || "agent";
            const repo = ((ev as any).cwd || "").split("/").pop() || "";
            targetMsgId = addMsg("system" as any, `⏳ ${agent} — ${repo}`, "async-agent-running");
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
            setMessages(prev => prev.map(m => {
              if (m.id !== tracked.msgId) return m;
              const header = m.text.split("\n")[0];
              return { ...m, text: header + "\n" + tracked.text.trim() };
            }));
          }
          break;
        }

        case "async_agent_complete": {
          const asyncId = ev.id as string;
          if (!asyncId) break;
          if ((ev as any).sessionId && (ev as any).sessionId !== sessionRef.current?.sessionId) break;
          const tracked = asyncMsgRef.current.get(asyncId);
          if (!tracked) break;
          setMessages(prev => prev.map(m => {
            if (m.id !== tracked.msgId) return m;
            if (m.className === "async-agent-running") {
              // Fallback system message — update icon
              const header = m.text.split("\n")[0].replace("⏳", (ev as any).success === false ? "❌" : "✅");
              return { ...m, text: header + "\n" + tracked.text.trim(), className: "async-agent-done" };
            }
            // Tool-result message — just mark as complete by appending status
            const status = (ev as any).success === false ? "\n❌ Agent failed" : "\n✅ Agent complete";
            const header = m.text.split("\n")[0];
            return { ...m, text: header + "\n" + tracked.text.trim() + status };
          }));
          asyncMsgRef.current.delete(asyncId);
          break;
        }

        case "extension_ui_request":
          // Skip stale UI requests from replay (older than 10 seconds)
          if (ev.timestamp && Date.now() - ev.timestamp > 10000) break;
          if (ev.id && (ev.method === "select" || ev.method === "confirm" || ev.method === "input")) {
            // Add as inline message with options
            const askId = ev.id;
            const title = ev.title || "Input needed";
            const opts = ev.method === "confirm" ? ["Yes", "No"] : ev.options || [];
            addMsg("ask_user" as any, `${title}${ev.message ? "\n" + ev.message : ""}`, `ask|${askId}|${ev.method}|${opts.join("|||")}`)
          }
          break;

        case "session_info_changed":
          if ((ev as any).name !== undefined) {
            setSession((prev) => prev ? { ...prev, name: (ev as any).name } : prev);
          }
          break;

        case "coms_peer_event": {
          const content = (ev as any).content || "";
          addMsg("system", typeof content === "string" ? content : JSON.stringify(content));
          break;
        }

        case "replay_start":
          setMessages([]);
          break;
        case "replay_end":
          break;

        case "notification":
          addMsg("system", `⚠️ ${(ev as any).message || "notification"}`);
          break;

        case "commands-list":
          if ((ev as any).commands) setAvailableCommands((ev as any).commands);
          break;

        case "ui-dismiss":
          // Mark the inline ask message as answered
          setMessages((prev) => prev.map((m) => {
            if (m.className?.startsWith(`ask|${ev.id}|`)) {
              return { ...m, className: `ask-answered|${ev.id}` };
            }
            return m;
          }));
          break;
      }
    });
  }, [onMessage, addMsg, updMsg, updCls, updMeta]);

  const resetHandlerState = useCallback(() => {
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
