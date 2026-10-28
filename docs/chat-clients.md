# Chat Clients (Signal, Telegram, …)

The Discord bot is not a special case: it is one **adapter** over a
platform-neutral chat layer. Everything that used to be Discord-only logic —
prompt lifecycle, answer mapping, chunking, echo suppression, streaming, session
identity — lives in `extensions/shared/chat/`, and a new client supplies only
transport.

```text
pi session events ──▶ chat-bridge (neutral) ──▶ ChatAdapter ──▶ Signal / Telegram / Discord
user message     ──▶ chat-bridge (neutral) ──▶ prompt answer or new prompt
```

## What is already shared

| Module | Responsibility |
|---|---|
| `extensions/shared/chat/chat-types.ts` | `ChatAdapter`, `ChatCapabilities`, `ChatTarget`, `ChatInboundMessage` |
| `extensions/shared/chat/chat-bridge.ts` | the engine: streaming edits, typing, echo suppression, prompt lifecycle, answer mapping |
| `extensions/shared/chat/chat-prompts.ts` | pending-prompt TTL, accepted answer vocabulary, `extension_ui_response` shaping |
| `extensions/shared/chat/chat-format.ts` | limit-aware chunking (closes and re-opens code fences), truncation |
| `extensions/shared/chat/chat-events.ts` | pi event → message action (deltas, tool lines, echo decision) |
| `extensions/shared/chat/chat-sessions.ts` | session identity, labelling, filtering/autocomplete, paging math |
| `extensions/shared/chat/chat-attachments.ts` | attachment classification, size caps, bounded downloads |
| `extensions/shared/chat/chat-state.ts` | per-user watch state: versioned, atomic, `0600`, pruned |

The Discord modules (`extensions/pidash/discord-*.ts`) are thin re-exports plus
Discord defaults (2000-character limit, mention suppression, action rows), so
existing imports and the npm pack are unchanged.

## Adding a client

1. **Implement `ChatAdapter`** — four methods and the capabilities you support:

```ts
const adapter: ChatAdapter = {
  platform: "signal",
  log,
  capabilities: { ...DEFAULT_CAPABILITIES, supportsEdit: false, supportsThreads: false, maxMessageLength: 4000 },
  async sendText(target, text) { /* send, return an id when the platform has one */ },
  async editText(target, id, text) { return false; },  // no edit support: the engine publishes once
  async setTyping(target, active) { /* optional */ },
  async ensureThread(target, sessionId, label) { return null; }, // optional
};
```

2. **Create the bridge** and feed it pi events:

```ts
const bridge = createChatBridge({
  adapter,
  users: () => runtime.entries(),                    // your per-user state map
  sendToSession: (sessionId, payload) => sendToPi(sessionId, payload),
  promptTtlMs, streamEditIntervalMs,
});

piEventHooks.push((sessionId, event) => {
  if (event?.type === "extension_ui_request" || event?.type === "ui-dismiss") bridge.onUiEvent(sessionId, event);
  else bridge.onPiEvent(sessionId, event);
});
```

3. **Route inbound text** through the engine so prompts are answered identically:

```ts
const outcome = bridge.handleInbound(state, messageText, reply);
// "answered" | "cancelled" | "not-an-answer" | "expired" | "no-prompt"
if (outcome === "no-prompt") forwardAsPrompt(state, messageText);
```

4. **Set the echo marker** after forwarding a prompt (`state.render.expectedEcho = text`)
so the same message coming back as a `message_start` is not echoed to the user.

## What a client must decide for itself

- authentication and who is allowed (the Discord adapter fails closed without an
  allowlist)
- where a conversation lives (DM, thread, channel) and how state is persisted
- native controls: buttons, menus, reply keyboards — map them onto
  `bridge.answer(state, value, reply)` and the agent sees one answer shape
- platform quirks: mention suppression, message length, edit budget, attachment
  caps

## Capability-driven behaviour

The engine reads `capabilities`, so a client that cannot edit messages or show
typing does not need special cases: streaming degrades to a single post at the
end of the turn, chunked to that platform's limit. This is covered by
`tests/node/shared/chat-bridge.test.ts`, which drives the engine with an
in-memory adapter and with one that has editing and typing disabled.

## Related

- [Discord Bot](discord-bot.html) — the reference adapter and its slash commands
- [Using the Web Dashboard](using-the-web-dashboard.html) — the browser surface
- [Daemon & Websocket Networking](daemon-and-websockets.html)
