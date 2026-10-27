/**
 * The chat bridge engine — platform-neutral.
 *
 * Everything a client has to get right and nothing about the platform itself:
 * turn streaming (one edited message, then the remainder in chunks), typing,
 * echo suppression, tool lines, and prompt forwarding. A Discord, Telegram or
 * Signal bot is then "implement `ChatAdapter` and call this".
 *
 * The engine is deliberately synchronous-callback shaped: the host calls
 * `onPiEvent` from its event hook and the engine drives the adapter.
 */

import { createLogger } from "../logger.ts";
import type { ChatAdapter, ChatCapabilities, ChatTarget } from "./chat-types.ts";
import { chunkText } from "./chat-format.ts";
import { initialRenderState, renderEvent, shouldSuppressEcho, streamingView, type RenderState } from "./chat-events.ts";
import { isAnswerLike, isPromptExpired, mapAnswer, renderPrompt, toBridgeResponse, type PendingPrompt, type PromptMethod } from "./chat-prompts.ts";

const log = createLogger("chat-bridge");

/** Per-user, per-session runtime the host owns and passes in. */
export interface ChatRuntimeState {
  /** Default session for messages that arrive outside any thread. */
  watchedSessionId: string | null;
  /**
   * sessionId -> where that session's output goes. A user may hold a thread per
   * session, so output must follow the thread, not the "current" watch — the old
   * single-target model sent prompts from an old thread but posted its replies
   * nowhere (Qodo 721fc807).
   */
  targets?: Record<string, ChatTarget>;
  /** Pending prompts per session: two sessions can each be waiting on an answer. */
  pendingPrompts?: Record<string, PendingPrompt>;
  /**
   * Bumped whenever a turn's final text is published; an edit queued before that
   * point is discarded, so streaming cannot replace a finished reply (Qodo
   * 172504b4).
   */
  renderGeneration?: number;
  target: ChatTarget | null;
  pendingPrompt: PendingPrompt | null;
  render: RenderState;
  lastStreamEdit: number;
  streamSend: Promise<string | null> | null;
}

export function initialChatRuntime(watchedSessionId: string | null = null, target: ChatTarget | null = null): ChatRuntimeState {
  return {
    watchedSessionId,
    targets: watchedSessionId && target ? { [watchedSessionId]: target } : {},
    pendingPrompts: {},
    target,
    pendingPrompt: null,
    render: initialRenderState(),
    lastStreamEdit: 0,
    streamSend: null,
    renderGeneration: 0,
  };
}

export interface ChatBridgeHost {
  adapter: ChatAdapter;
  /** Send a prompt (or an answer payload) to the pi session. */
  sendToSession(sessionId: string, payload: Record<string, unknown>): boolean;
  /** All users currently tracked; the bridge only touches their state. */
  users(): Iterable<[string, ChatRuntimeState]>;
  /** Throttle for streaming edits; adapters with strict edit budgets lower it. */
  streamEditIntervalMs?: number;
  /** Pending-prompt TTL. */
  promptTtlMs?: number;
}

export interface ChatBridge {
  /** pi event → adapter output for every user watching that session. */
  onPiEvent(sessionId: string, event: unknown): void;
  /** `extension_ui_request` / `ui-dismiss` → pending prompt bookkeeping + output. */
  onUiEvent(sessionId: string, event: any): void;
  /** Inbound text from a platform: answer a pending prompt or report it is a prompt. */
  handleInbound(
    state: ChatRuntimeState,
    text: string,
    reply: (text: string) => void,
    sessionId?: string,
  ): "answered" | "cancelled" | "not-an-answer" | "expired" | "no-prompt";
  /** Answer a pending prompt from a native control (button/menu). */
  answer(state: ChatRuntimeState, raw: string, reply: (text: string) => void, sessionId?: string): boolean;
  /** Send the agent's question to a user and remember it as pending. */
  askUser(sessionId: string, event: any, state: ChatRuntimeState): PendingPrompt | null;
}

export function createChatBridge(host: ChatBridgeHost): ChatBridge {
  const { adapter } = host;
  const caps: ChatCapabilities = adapter.capabilities;
  const interval = host.streamEditIntervalMs ?? 1500;
  /**
   * One in-flight operation per channel. Streaming edits and the final publish
   * used to fire without ordering, so a fast turn overlapped several sends and
   * edits and could trip the platform's rate limit (Qodo e8b2817c).
   */
  const channelQueues = new Map<string, Promise<unknown>>();
  function queued<T>(channelId: string, task: () => Promise<T>): Promise<T> {
    const previous = channelQueues.get(channelId) ?? Promise.resolve();
    const next = previous.then(task, task);
    channelQueues.set(channelId, next.catch(() => undefined));
    return next;
  }
  const ttlMs = host.promptTtlMs ?? 10 * 60 * 1000;

  function targetOf(state: ChatRuntimeState, sessionId: string): ChatTarget | null {
    return state.targets?.[sessionId] ?? (state.watchedSessionId === sessionId ? state.target : null);
  }

  function sessionsFor(state: ChatRuntimeState): string[] {
    const ids = new Set(Object.keys(state.targets ?? {}));
    if (state.watchedSessionId) ids.add(state.watchedSessionId);
    return [...ids];
  }

  function pendingFor(state: ChatRuntimeState, sessionId?: string): PendingPrompt | null {
    const prompts = state.pendingPrompts ?? {};
    if (sessionId && prompts[sessionId]) return prompts[sessionId];
    return Object.values(prompts)[0] ?? null;
  }

  function setPending(state: ChatRuntimeState, sessionId: string, prompt: PendingPrompt | null): void {
    state.pendingPrompts = state.pendingPrompts ?? {};
    if (prompt) state.pendingPrompts[sessionId] = prompt;
    else delete state.pendingPrompts[sessionId];
    state.pendingPrompt = prompt ?? Object.values(state.pendingPrompts)[0] ?? null;
  }

  async function publishFinal(text: string, state: ChatRuntimeState, target: ChatTarget): Promise<void> {
    const chunks = chunkText(text, caps.maxMessageLength);
    const liveMessageId = state.render.streamMessageId;
    state.render.streamMessageId = null;
    state.render.streamedText = "";
    if (!chunks.length) return;
    if (liveMessageId && caps.supportsEdit && (await adapter.editText(target, liveMessageId, chunks[0]))) {
      for (const chunk of chunks.slice(1)) await queued(target.channelId, () => adapter.sendText(target, chunk));
      return;
    }
    for (const chunk of chunks) await queued(target.channelId, () => adapter.sendText(target, chunk));
  }

  return {
    onPiEvent(sessionId: string, rawEvent: unknown): void {
      const event = rawEvent as any;
      if (event?.type === "extension_ui_request") {
        this.onUiEvent(sessionId, event);
        return;
      }
      if (event?.type === "ui-dismiss" || event?.type === "ui_prompt_end") {
        this.onUiEvent(sessionId, event);
        return;
      }

      const isUserEvent = event?.type === "message_start" && event?.message?.role === "user";
      const userText = isUserEvent
        ? (Array.isArray(event.message.content)
          ? event.message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
          : typeof event.message.content === "string" ? event.message.content : "")
        : "";

      for (const [, state] of host.users()) {
        if (!sessionsFor(state).includes(sessionId)) continue;
        const target = targetOf(state, sessionId);
        if (!target) continue;

        // Echo suppression is decided per state, so two watchers of one session
        // both suppress (the old code consumed a shared marker once).
        const expected = state.render.expectedEcho?.[sessionId];
        const suppressEcho = isUserEvent && shouldSuppressEcho(expected, userText);
        if (suppressEcho) delete state.render.expectedEcho?.[sessionId];

        const action = renderEvent(event, state.render);

        if (action.kind === "agent-start") {
          if (caps.supportsTyping) void adapter.setTyping?.(target, true);
          continue;
        }

        if (action.kind === "append-text") {
          if (!caps.supportsEdit) continue; // no edit budget: the flush publishes once
          const now = Date.now();
          if (now - state.lastStreamEdit < interval) continue;
          state.lastStreamEdit = now;
          const text = state.render.pendingText;
          if (!state.render.streamMessageId && !state.streamSend) {
            state.streamSend = queued(target.channelId, () => adapter.sendText(target, streamingView(text, caps.maxMessageLength))).then((id) => {
              state.render.streamMessageId = id;
              state.render.streamedText = text;
              state.streamSend = null;
              return id;
            });
          } else if (state.render.streamMessageId && text !== state.render.streamedText) {
            const generation = state.renderGeneration ?? 0;
            void queued(target.channelId, () => adapter.editText(target, state.render.streamMessageId!, text)).then(() => {
              if ((state.renderGeneration ?? 0) !== generation) return; // reply already final
              state.render.streamedText = text;
            });
          }
          continue;
        }

        if (action.kind === "flush-assistant") {
          const text = action.text;
          state.renderGeneration = (state.renderGeneration ?? 0) + 1;
          void (async () => {
            if (state.streamSend) await state.streamSend;
            await publishFinal(text, state, target);
          })();
          continue;
        }

        if (action.kind === "tool") {
          void queued(target.channelId, () => adapter.sendText(target, action.text));
          continue;
        }

        if (action.kind === "user") {
          if (suppressEcho) continue;
          void queued(target.channelId, () => adapter.sendText(target, `───\n▶ **USER:** ${userText}`));
          continue;
        }

        if (action.kind === "agent-end") {
          if (caps.supportsTyping) void adapter.setTyping?.(target, false);
          state.render.streamMessageId = null;
          state.render.streamedText = "";
        }
      }
      log.debug("pi event handled", { sessionId, type: event?.type });
    },

    onUiEvent(sessionId: string, event: any): void {
      if (event?.type === "ui-dismiss" || event?.type === "ui_prompt_end") {
        for (const [, state] of host.users()) {
          const prompts = state.pendingPrompts ?? {};
          if (event.type === "ui_prompt_end") {
            if (prompts[sessionId]) {
              // A prompt-end belongs to ONE session; clearing everyone's was a bug.
              setPending(state, sessionId, null);
              log.debug("pending prompt cleared", { reason: "ui_prompt_end", sessionId });
            }
            continue;
          }
          for (const [pendingSessionId, prompt] of Object.entries(prompts)) {
            if (prompt.id !== event.id) continue;
            setPending(state, pendingSessionId, null);
            log.debug("pending prompt dismissed elsewhere", { sessionId: pendingSessionId, promptId: prompt.id });
          }
        }
        return;
      }
      for (const [, state] of host.users()) {
        if (state.watchedSessionId !== sessionId) continue;
        this.askUser(sessionId, event, state);
      }
    },

    askUser(sessionId: string, event: any, state: ChatRuntimeState): PendingPrompt | null {
      const target = targetOf(state, sessionId);
      if (!target) return null;
      const method = (event?.method || "input") as PromptMethod;
      const prompt: PendingPrompt = {
        id: event.id,
        sessionId,
        method,
        options: method === "confirm" ? ["Yes", "No"] : Array.isArray(event.options) ? event.options : [],
        createdAt: Date.now(),
      };
      setPending(state, sessionId, prompt);
      const body = renderPrompt(prompt, String(event.title || "The agent is asking").slice(0, 500));
      void adapter.sendText(target, body);
      log.info("prompt forwarded to chat", { platform: adapter.platform, sessionId, method });
      return prompt;
    },

    handleInbound(state, text, reply, sessionId) {
      const prompt = pendingFor(state, sessionId);
      if (!prompt) return "no-prompt";
      if (isPromptExpired(prompt, Date.now(), ttlMs)) {
        setPending(state, prompt.sessionId, null);
        return "expired";
      }
      if (!isAnswerLike(prompt, text)) return "not-an-answer";
      const ok = this.answer(state, text, reply, sessionId);
      if (!ok) return "not-an-answer";
      return mapAnswer(prompt, text).kind === "cancel" ? "cancelled" : "answered";
    },

    answer(state, raw, reply, sessionId) {
      const prompt = pendingFor(state, sessionId);
      if (!prompt) return false;
      const answer = mapAnswer(prompt, raw);
      if (answer.kind === "reject") {
        reply(`Didn't understand that: ${answer.reason}.`);
        return false;
      }
      const payload = toBridgeResponse(prompt, answer);
      if (!payload || !host.sendToSession(prompt.sessionId, payload)) {
        reply("The session is not connected.");
        return false;
      }
      setPending(state, prompt.sessionId, null);
      reply(answer.kind === "cancel" ? "Dismissed." : "Answer sent.");
      return true;
    },
  };
}
