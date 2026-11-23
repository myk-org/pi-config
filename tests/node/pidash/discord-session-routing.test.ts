/**
 * Direct port-and-adapter tests for the deep Discord session-routing module.
 *
 * Exercises `createDiscordSessionRouter` and `requestSessionEvent` against an
 * in-memory `DiscordRoutingPort` with zero discord.js or filesystem dependency:
 * hydration/allowlist pruning, inbound message/interaction routing, prompt-target
 * lifecycle, watch switching/disconnect, reaction shortcuts, and unified RPC.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDiscordSessionRouter,
  requestSessionEvent,
  type DiscordRoutingPort,
  type DiscordRuntimeUserState,
  type RoutingLogger,
  type RoutingSessionRecord,
} from "../../../extensions/pidash/discord-session-routing.ts";
import { emptyState, type PersistedDiscordState } from "../../../extensions/shared/chat/chat-state.ts";

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

interface InMemoryHarness {
  port: DiscordRoutingPort;
  persistedWrites: PersistedDiscordState[];
  sentTexts: Array<{ channelId: string; text: string }>;
  commands: Array<{ sessionId: string; payload: Record<string, unknown> }>;
  prompts: Array<{ sessionId: string; payload: { text: string; images?: unknown[] } }>;
  hooks: Array<(sessionId: string, event: any) => void>;
  clearedTyping: DiscordRuntimeUserState[];
  logs: LogEntry[];
  channels: Map<string, any>;
  liveSessions: Map<string, RoutingSessionRecord>;
  setNow(value: number): void;
}

function createInMemoryPort(opts: {
  initialState?: PersistedDiscordState;
  allowedUsers?: string[];
  allowAll?: boolean;
  liveSessions?: RoutingSessionRecord[];
  channels?: Record<string, any>;
  maxThreads?: number;
  createThread?: (parentChannelId: string, name: string, reason: string) => Promise<string>;
  openDm?: (userId: string) => Promise<string | null>;
  hasSendPermissions?: (channel: any) => boolean;
  sendCommand?: (sessionId: string, payload: Record<string, unknown>) => boolean;
  now?: number;
} = {}): InMemoryHarness {
  let clock = opts.now ?? 1_000_000;
  let threadCounter = 0;
  const persistedWrites: PersistedDiscordState[] = [];
  const sentTexts: Array<{ channelId: string; text: string }> = [];
  const commands: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
  const prompts: Array<{ sessionId: string; payload: { text: string; images?: unknown[] } }> = [];
  const hooks: Array<(sessionId: string, event: any) => void> = [];
  const clearedTyping: DiscordRuntimeUserState[] = [];
  const logs: LogEntry[] = [];
  const channels = new Map<string, any>(Object.entries(opts.channels ?? {}));
  const liveSessions = new Map<string, RoutingSessionRecord>(
    (opts.liveSessions ?? []).map((s) => [s.sessionId, s]),
  );
  const allowed = new Set(opts.allowedUsers ?? ["u1"]);

  const log: RoutingLogger = {
    debug: (message, data) => logs.push({ level: "debug", message, data }),
    info: (message, data) => logs.push({ level: "info", message, data }),
    warn: (message, data) => logs.push({ level: "warn", message, data }),
    error: (message, data) => logs.push({ level: "error", message, data }),
  };

  const port: DiscordRoutingPort = {
    fetchChannel: async (channelId) => {
      if (!channels.has(channelId)) throw new Error(`unknown channel ${channelId}`);
      return channels.get(channelId);
    },
    hasSendPermissions: opts.hasSendPermissions,
    createThread: opts.createThread ?? (async (_parent, _name, _reason) => {
      threadCounter += 1;
      const id = `thread-${threadCounter}`;
      channels.set(id, { id, guildId: "g1", isTextBased: () => true, send: async () => ({ id: "m1" }) });
      return id;
    }),
    openDm: opts.openDm ?? (async (userId) => `dm-${userId}`),
    sendText: async (channelId, text) => {
      sentTexts.push({ channelId, text });
      return `msg-${sentTexts.length}`;
    },
    clearTyping: (state) => {
      clearedTyping.push(state);
    },
    listLiveSessions: () => [...liveSessions.values()].map((s) => ({
      sessionId: s.sessionId,
      lastActivity: s.lastActivity ?? 0,
    })),
    isSessionLive: (sessionId) => liveSessions.has(sessionId),
    getSession: (sessionId) => liveSessions.get(sessionId) ?? null,
    getActiveSessions: () => [...liveSessions.values()],
    sendCommand: opts.sendCommand ?? ((sessionId, payload) => {
      if (!liveSessions.has(sessionId)) return false;
      commands.push({ sessionId, payload });
      return true;
    }),
    sendPrompt: (sessionId, payload) => {
      if (!liveSessions.has(sessionId)) return false;
      prompts.push({ sessionId, payload });
      return true;
    },
    subscribeEvents: (hook) => {
      hooks.push(hook);
      return () => {
        const idx = hooks.indexOf(hook);
        if (idx >= 0) hooks.splice(idx, 1);
      };
    },
    readPersistedState: () => opts.initialState
      ? JSON.parse(JSON.stringify(opts.initialState)) as PersistedDiscordState
      : emptyState(),
    writePersistedState: (state) => {
      persistedWrites.push(JSON.parse(JSON.stringify(state)) as PersistedDiscordState);
    },
    isUserAllowed: (userId) => Boolean(opts.allowAll) || allowed.has(userId),
    maxThreads: opts.maxThreads,
    log,
    now: () => clock,
  };

  return {
    port,
    persistedWrites,
    sentTexts,
    commands,
    prompts,
    hooks,
    clearedTyping,
    logs,
    channels,
    liveSessions,
    setNow: (value: number) => { clock = value; },
  };
}

describe("discord session router: startup hydration", () => {
  it("drops persisted users removed from the allowlist", () => {
    const initial = emptyState();
    initial.users.u1 = { watchedSessionId: "s1", responseChannelId: "dm-u1", updatedAt: 100 };
    initial.users.removed = { watchedSessionId: "s2", responseChannelId: "dm-removed", updatedAt: 100 };
    const harness = createInMemoryPort({ initialState: initial, allowedUsers: ["u1"] });
    const router = createDiscordSessionRouter(harness.port);

    assert.equal(router.runtime.has("u1"), true);
    assert.equal(router.runtime.has("removed"), false);
    assert.equal(harness.persistedWrites.length, 1);
    assert.equal(harness.persistedWrites[0]!.users.removed, undefined);
  });

  it("excludes prompt-only threads from hydrated output targets", () => {
    const initial = emptyState();
    initial.users.u1 = {
      watchedSessionId: "s1",
      responseChannelId: "dm-u1",
      threads: { s1: "t1", s2: "t2" },
      promptOnlyTargets: { s2: true },
      updatedAt: 100,
    };
    const harness = createInMemoryPort({ initialState: initial });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");

    assert.deepEqual(state.targets?.s1, { channelId: "t1", threadId: "t1" });
    assert.equal(state.targets?.s2, undefined);
  });

  it("restores persisted dmTargets when delivery is not muted", () => {
    const initial = emptyState();
    initial.users.u1 = {
      watchedSessionId: null,
      responseChannelId: "dm-u1",
      dmChannelId: "dm-u1",
      dmTargets: { s3: "dm-u1" },
      updatedAt: 100,
    };
    const harness = createInMemoryPort({ initialState: initial });
    const router = createDiscordSessionRouter(harness.port);

    assert.deepEqual(router.userState("u1").targets?.s3, { channelId: "dm-u1", threadId: null });
  });
});

describe("discord session router: watch switching and disconnect", () => {
  it("creates a guild thread when switching watch in a thread-capable channel", async () => {
    const harness = createInMemoryPort({
      liveSessions: [{ sessionId: "1:/repo", cwd: "/work/repo", model: "claude" }],
    });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");

    const res = await router.switchWatch(state, {
      userId: "u1",
      guildId: "g1",
      channelId: "guild-chan",
      canCreateThread: true,
    }, "1:/repo");

    assert.equal(res.ok, true);
    assert.equal(res.threadId, "thread-1");
    assert.equal(state.watchedSessionId, "1:/repo");
    assert.equal(state.threads?.["1:/repo"], "thread-1");
    assert.deepEqual(state.targets?.["1:/repo"], { channelId: "thread-1", threadId: "thread-1" });
    assert.equal(harness.sentTexts.length, 1);
    assert.equal(harness.sentTexts[0]!.channelId, "thread-1");
  });

  it("falls back to DM when thread creation fails", async () => {
    const harness = createInMemoryPort({
      liveSessions: [{ sessionId: "1:/repo", cwd: "/work/repo", model: "claude" }],
      createThread: async () => { throw new Error("Missing Permissions"); },
    });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");

    const res = await router.switchWatch(state, {
      userId: "u1",
      guildId: "g1",
      channelId: "guild-chan",
      canCreateThread: true,
    }, "1:/repo");

    assert.equal(res.ok, true);
    assert.equal(res.threadId, null);
    assert.equal(state.dmChannelId, "dm-u1");
    assert.deepEqual(state.target, { channelId: "dm-u1", threadId: null });
    assert.deepEqual(state.targets?.["1:/repo"], { channelId: "dm-u1", threadId: null });
    assert.match(res.ackText, /Send prompts in DM/);
  });

  it("falls back to command channel when both thread and DM fail", async () => {
    const harness = createInMemoryPort({
      liveSessions: [{ sessionId: "1:/repo", cwd: "/work/repo", model: "claude" }],
      createThread: async () => { throw new Error("no perms"); },
      openDm: async () => { throw new Error("DMs disabled"); },
    });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");

    const res = await router.switchWatch(state, {
      userId: "u1",
      guildId: "g1",
      channelId: "guild-chan",
      canCreateThread: true,
    }, "1:/repo");

    assert.equal(res.ok, true);
    assert.equal(state.responseChannelId, "guild-chan");
    assert.deepEqual(state.targets?.["1:/repo"], { channelId: "guild-chan", threadId: null });
  });

  it("refuses switching watch to a missing session", async () => {
    const harness = createInMemoryPort({ liveSessions: [] });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");

    const res = await router.switchWatch(state, { userId: "u1" }, "missing");
    assert.equal(res.ok, false);
    assert.equal(res.ackText, "Session no longer available.");
  });

  it("evicts stale threads beyond maxThreads while protecting pending prompts", async () => {
    const harness = createInMemoryPort({
      liveSessions: [{ sessionId: "s3", cwd: "/work/s3" }],
      maxThreads: 2,
    });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");
    state.threads = { s1: "t-a", s2: "t-b" };
    state.targets = {
      s1: { channelId: "t-a", threadId: "t-a" },
      s2: { channelId: "t-b", threadId: "t-b" },
    };
    state.pendingPrompts = {
      s1: { id: "p1", sessionId: "s1", method: "confirm", options: [], freeText: false, createdAt: 1 },
    };

    await router.switchWatch(state, {
      userId: "u1",
      guildId: "g1",
      channelId: "guild-chan",
      canCreateThread: true,
    }, "s3");

    assert.equal(state.threads.s1, "t-a");
    assert.equal(state.threads.s2, undefined);
    assert.equal(state.targets.s2, undefined);
    assert.equal(state.threads.s3, "thread-1");
  });

  it("resets watch state on disconnect", () => {
    const harness = createInMemoryPort();
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");
    state.watchedSessionId = "s1";
    state.threads = { s1: "t1" };
    state.targets = { s1: { channelId: "t1", threadId: "t1" } };
    state.lastPrompts = { s1: { text: "hi", hadImages: false, truncated: false } };
    state.deliveryMuted = false;

    router.disconnectUser(state);

    assert.equal(state.watchedSessionId, null);
    assert.deepEqual(state.threads, {});
    assert.deepEqual(state.targets, {});
    assert.deepEqual(state.lastPrompts, {});
    assert.equal(state.deliveryMuted, true);
    assert.equal(harness.clearedTyping.length, 1);
  });
});

describe("discord session router: inbound, interaction, and reply-target routing", () => {
  it("blocks messages in another user's guild thread", () => {
    const initial = emptyState();
    initial.users.u1 = { watchedSessionId: "s1", responseChannelId: "dm-u1", threads: { s1: "t1" }, updatedAt: 100 };
    const harness = createInMemoryPort({ initialState: initial, allowedUsers: ["u1", "u2"] });
    const router = createDiscordSessionRouter(harness.port);

    const gate = router.resolveMessageGate({ userId: "u2", channelId: "t1", guildId: "g1" });
    assert.deepEqual(gate, { allowed: false, reason: "thread-owned-by-other" });
  });

  it("blocks messages in unowned guild channels", () => {
    const harness = createInMemoryPort({ allowedUsers: ["u1"] });
    const router = createDiscordSessionRouter(harness.port);

    const gate = router.resolveMessageGate({ userId: "u1", channelId: "random-chan", guildId: "g1" });
    assert.deepEqual(gate, { allowed: false, reason: "channel-not-owned" });
  });

  it("falls back to the newest unclaimed live session for an unwatched interaction", () => {
    const harness = createInMemoryPort({
      liveSessions: [
        { sessionId: "s1", cwd: "/a", lastActivity: 100 },
        { sessionId: "s2", cwd: "/b", lastActivity: 500 },
      ],
    });
    const router = createDiscordSessionRouter(harness.port);

    const route = router.resolveInteractionRoute({
      kind: "chat-input-command",
      handler: "slash-command",
      fallbackHandler: "slash-command:status",
      commandName: "status",
      channelId: "dm-u1",
      guildId: null,
      userId: "u1",
      disconnectedReply: "The selected session is disconnected.",
    });

    assert.equal(route.ok, true);
    if (route.ok) {
      assert.equal(route.sessionId, "s2");
      assert.equal(route.inbound.source, "active");
    }
  });

  it("refuses interaction when channel carries ambiguous live targets", () => {
    const harness = createInMemoryPort({
      liveSessions: [
        { sessionId: "s1", cwd: "/a" },
        { sessionId: "s2", cwd: "/b" },
      ],
    });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");
    state.targets = {
      s1: { channelId: "shared", threadId: null },
      s2: { channelId: "shared", threadId: null },
    };

    const route = router.resolveInteractionRoute({
      kind: "message-context-menu",
      handler: "message-context-menu",
      fallbackHandler: "context-menu",
      channelId: "shared",
      guildId: "g1",
      userId: "u1",
      disconnectedReply: "The watched session is disconnected.",
    });

    assert.equal(route.ok, false);
    if (!route.ok) {
      assert.equal(route.reason, "interaction-ambiguous");
      assert.match(route.reply, /more than one session/);
    }
  });

  it("replaces an archived existing target with a private DM in establishReplyTarget", async () => {
    const harness = createInMemoryPort({
      channels: {
        "old-thread": { id: "old-thread", archived: true, isTextBased: () => true, send: async () => ({ id: "m" }) },
      },
    });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");
    state.targets = { s1: { channelId: "old-thread", threadId: "old-thread" } };
    state.promptOnlyTargets = { s1: true };

    const ok = await router.establishReplyTarget(state, "s1", "u1");

    assert.equal(ok, true);
    assert.deepEqual(state.targets.s1, { channelId: "dm-u1", threadId: null });
    assert.equal(state.promptOnlyTargets?.s1, undefined);
    assert.equal(state.deliveryMuted, false);
  });

  it("returns false from establishReplyTarget when DM cannot be opened", async () => {
    const harness = createInMemoryPort({
      openDm: async () => { throw new Error("DMs blocked"); },
    });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");

    const ok = await router.establishReplyTarget(state, "s1", "u1");
    assert.equal(ok, false);
  });
});

describe("discord session router: UI prompts and nudging", () => {
  it("cancels in-flight prompt delivery when ui-dismiss arrives before target creation resolves", async () => {
    let releaseThread!: (id: string) => void;
    const threadPromise = new Promise<string>((resolve) => { releaseThread = resolve; });
    const harness = createInMemoryPort({
      liveSessions: [{ sessionId: "s2", cwd: "/work/bg" }],
      channels: {
        "guild-chan": { id: "guild-chan", guildId: "g1", threads: { create: async () => ({ id: "x" }) } },
      },
      createThread: () => threadPromise,
    });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");
    state.responseChannelId = "guild-chan";

    let asked = 0;
    let dismissed = 0;
    const fakeBridge = {
      onUiEvent: () => { dismissed += 1; },
      askUser: () => { asked += 1; return null; },
    };

    router.handleUiRequest("s2", { type: "extension_ui_request", id: "q1", method: "confirm", title: "Ship?" }, fakeBridge);
    router.handleUiRequest("s2", { type: "ui-dismiss", id: "q1" }, fakeBridge);
    releaseThread("thread-late");
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(dismissed, 1);
    assert.equal(asked, 0);
  });

  it("throttles background session nudges within the 60-second window", async () => {
    const harness = createInMemoryPort({ now: 10_000 });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");
    state.watchedSessionId = "s1";
    state.target = { channelId: "chan-watch", threadId: "chan-watch" };

    await router.nudgeWatchedChannel("u1", state, "s2", "bg", { channelId: "chan-bg", threadId: "chan-bg" });
    harness.setNow(30_000);
    await router.nudgeWatchedChannel("u1", state, "s2", "bg", { channelId: "chan-bg", threadId: "chan-bg" });
    harness.setNow(75_000);
    await router.nudgeWatchedChannel("u1", state, "s2", "bg", { channelId: "chan-bg", threadId: "chan-bg" });

    assert.equal(harness.sentTexts.length, 2);
    assert.equal(harness.sentTexts[0]!.channelId, "chan-watch");
  });
});

describe("discord session router: reaction shortcuts", () => {
  it("aborts an owned session on stop reaction", async () => {
    const harness = createInMemoryPort({ liveSessions: [{ sessionId: "s1", cwd: "/a" }] });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");
    state.watchedSessionId = "s1";
    state.target = { channelId: "dm-u1", threadId: null };

    const res = await router.handleReaction({
      userId: "u1",
      channelId: "dm-u1",
      emoji: "⏹",
      deleteMessage: async () => {},
      expectEcho: () => {},
    });

    assert.deepEqual(res, { action: "stop", status: "executed" });
    assert.deepEqual(harness.commands, [{ sessionId: "s1", payload: { command: "abort" } }]);
  });

  it("refuses retry reaction when the remembered prompt was truncated", async () => {
    const harness = createInMemoryPort({ liveSessions: [{ sessionId: "s1", cwd: "/a" }] });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");
    state.watchedSessionId = "s1";
    state.target = { channelId: "dm-u1", threadId: null };
    state.lastPrompts = { s1: { text: "partial", hadImages: false, truncated: true } };

    const res = await router.handleReaction({
      userId: "u1",
      channelId: "dm-u1",
      emoji: "🔁",
      deleteMessage: async () => {},
      expectEcho: () => {},
    });

    assert.deepEqual(res, { action: "retry", status: "refused" });
    assert.equal(harness.prompts.length, 0);
    assert.match(harness.sentTexts[0]!.text, /too long to keep in full/);
  });

  it("replays remembered prompt with image omission note on retry reaction", async () => {
    const harness = createInMemoryPort({ liveSessions: [{ sessionId: "s1", cwd: "/a" }] });
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");
    state.watchedSessionId = "s1";
    state.target = { channelId: "dm-u1", threadId: null };
    state.lastPrompts = { s1: { text: "fix screenshot", hadImages: true, truncated: false } };

    const echoes: string[] = [];
    const res = await router.handleReaction({
      userId: "u1",
      channelId: "dm-u1",
      emoji: "🔁",
      deleteMessage: async () => {},
      expectEcho: (_s, _sid, text) => echoes.push(text),
    });

    assert.deepEqual(res, { action: "retry", status: "executed" });
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0]!.payload.text, /images from the original message are not re-sent/);
    assert.equal(echoes.length, 1);
  });

  it("refuses delete reaction in a channel the user does not own", async () => {
    const harness = createInMemoryPort();
    const router = createDiscordSessionRouter(harness.port);
    const state = router.userState("u1");
    state.target = { channelId: "dm-u1", threadId: null };

    let deleted = false;
    const res = await router.handleReaction({
      userId: "u1",
      channelId: "other-channel",
      emoji: "🗑️",
      deleteMessage: async () => { deleted = true; },
      expectEcho: () => {},
    });

    assert.deepEqual(res, { action: "delete", status: "refused" });
    assert.equal(deleted, false);
  });
});

describe("unified session RPC (requestSessionEvent)", () => {
  it("resolves matching event while ignoring mismatched session or request frames", async () => {
    const harness = createInMemoryPort({ liveSessions: [{ sessionId: "s1", cwd: "/a" }] });
    const router = createDiscordSessionRouter(harness.port);

    const pending = router.requestSessionEvent({
      sessionId: "s1",
      command: "async-list",
      eventType: "async-list",
      timeoutMs: 200,
    });
    assert.equal(harness.hooks.length, 1);
    const reqId = String(harness.commands[0]!.payload.requestId);

    // Wrong session, wrong type, wrong requestId must be ignored.
    harness.hooks[0]!("other", { type: "async-list", requestId: reqId, jobs: [] });
    harness.hooks[0]!("s1", { type: "other-event", requestId: reqId });
    harness.hooks[0]!("s1", { type: "async-list", requestId: "stale-req" });
    harness.hooks[0]!("s1", { type: "async-list", requestId: reqId, jobs: ["a"] });

    const res = await pending;
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value.jobs, ["a"]);
    assert.equal(harness.hooks.length, 0);
  });

  it("returns disconnected immediately when sendCommand returns false", async () => {
    const harness = createInMemoryPort({ liveSessions: [] });
    const router = createDiscordSessionRouter(harness.port);

    const res = await router.requestSessionEvent({
      sessionId: "gone",
      command: "tasks-list",
      eventType: "tasks-list",
      timeoutMs: 5000,
    });

    assert.deepEqual(res, { ok: false, reason: "disconnected" });
    assert.equal(harness.hooks.length, 0);
  });

  it("returns timeout when no matching event arrives before deadline", async () => {
    const harness = createInMemoryPort({ liveSessions: [{ sessionId: "s1", cwd: "/a" }] });
    const router = createDiscordSessionRouter(harness.port);

    const res = await router.requestSessionEvent({
      sessionId: "s1",
      command: "tasks-list",
      eventType: "tasks-list",
      timeoutMs: 15,
    });

    assert.deepEqual(res, { ok: false, reason: "timeout" });
    assert.equal(harness.hooks.length, 0);
  });

  it("filters malformed models payloads via match predicate in requestModels", async () => {
    const harness = createInMemoryPort({ liveSessions: [{ sessionId: "s1", cwd: "/a" }] });
    const router = createDiscordSessionRouter(harness.port);

    const pending = router.requestModels("s1", 200);
    const reqId = String(harness.commands[0]!.payload.requestId);
    // Non-array models payload should be ignored, valid array should resolve.
    harness.hooks[0]!("s1", { type: "models-list", requestId: reqId, models: "invalid" });
    harness.hooks[0]!("s1", { type: "models-list", requestId: reqId, models: [{ id: "m1" }] });

    const models = await pending;
    assert.deepEqual(models, [{ id: "m1" }]);
    assert.equal(harness.hooks.length, 0);
  });

  it("formats disconnected response in requestPassthrough", async () => {
    const harness = createInMemoryPort({ liveSessions: [] });
    const router = createDiscordSessionRouter(harness.port);

    const disconnected = await router.requestPassthrough("missing", { command: "tasks-list", eventType: "tasks-list", label: "Tasks" }, 20);
    assert.equal(disconnected, "Session is not connected.");
  });

  it("formats timeout response in requestPassthrough", async () => {
    const harness = createInMemoryPort({ liveSessions: [{ sessionId: "s1", cwd: "/a" }] });
    const router = createDiscordSessionRouter(harness.port);

    const timedOut = await router.requestPassthrough("s1", { command: "tasks-list", eventType: "tasks-list", label: "Tasks" }, 15);
    assert.equal(timedOut, "Timed out waiting for the session.");
  });

  it("formats JSON response body in requestPassthrough", async () => {
    const harness = createInMemoryPort({ liveSessions: [{ sessionId: "s1", cwd: "/a" }] });
    const router = createDiscordSessionRouter(harness.port);

    const pending = router.requestPassthrough("s1", { command: "tasks-list", eventType: "tasks-list", label: "Tasks" }, 200);
    const reqId = String(harness.commands.at(-1)!.payload.requestId);
    harness.hooks[0]!("s1", { type: "tasks-list", requestId: reqId, items: [1] });
    const formatted = await pending;
    assert.match(formatted, /^\*\*Tasks\*\*\n```json\n/);
    assert.match(formatted, /"items":\[1\]/);
  });

  it("returns disconnected when sendCommand throws", async () => {
    const hooks: Array<(sessionId: string, event: any) => void> = [];
    const res = await requestSessionEvent(
      {
        subscribeEvents: (hook) => {
          hooks.push(hook);
          return () => {
            const idx = hooks.indexOf(hook);
            if (idx >= 0) hooks.splice(idx, 1);
          };
        },
        sendCommand: () => { throw new Error("socket closed"); },
      },
      { sessionId: "s1", command: "mcp-list", eventType: "mcp-list", timeoutMs: 200 },
    );

    assert.deepEqual(res, { ok: false, reason: "disconnected" });
    assert.equal(hooks.length, 0);
  });
});
