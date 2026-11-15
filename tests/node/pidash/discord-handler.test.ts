/**
 * The Discord message handler itself — not just the pure resolvers it calls.
 *
 * `setupDiscordBot` is wiring, so its routing had no test and a regression (say `/stop` going back to
 * `state.watchedSessionId`, or a dead thread spilling into the watched session) passed the suite.
 * This drives the real `messageCreate` handler with a stubbed discord.js and a temp state file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { after, describe, it, mock } from "node:test";

import { setupDiscordBot } from "../../../extensions/pidash/discord-bot.ts";
import { getLastFileLogError, getPiLogPath, setLogLevelPin } from "../../../extensions/shared/file-logger.ts";

/** Anything the bot builds (buttons, menus, containers) is only touched by paths this test avoids. */
function anyBuilder(): any {
  return new Proxy({}, { get: (_t, key) => (key === "toJSON" ? () => ({}) : () => anyBuilder()) });
}

const DM = "dm-1";
/** A guild channel that can hold a thread, but thread creation fails here — the fallback target route. */
const PLAIN = "chan-plain";
const built: FakeClient[] = [];

class FakeClient extends EventEmitter {
  user = { id: "bot-user" };
  deliveries: any[] = [];
  guilds = { cache: new Map() };
  /** Only the DM and the plain guild channel exist; anything else is a channel the bot cannot see. */
  channels = {
    fetch: async (id: string) => {
      if (id === DM) return { id, guildId: null, isTextBased: () => true, send: async (payload: any) => { this.deliveries.push(payload); return { id: "reply" }; } };
      if (id === PLAIN) {
        return {
          id,
          guildId: "g1",
          threads: { create: async () => { throw new Error("Missing Permissions"); } },
        };
      }
      return null;
    },
  };
  constructor(_opts?: unknown) {
    super();
    built.push(this);
  }
  login = async () => {};
  destroy = () => {};
}

// discord-bot.ts resolves discord.js at call time through createRequire, and the require cache is
// per-process — seeding it stubs the module without a real gateway connection.
const require_ = createRequire(import.meta.url);
const discordJsPath = require_.resolve("discord.js");
(require_.cache as any)[discordJsPath] = {
  id: discordJsPath,
  filename: discordJsPath,
  loaded: true,
  exports: new Proxy({}, {
    get: (_t, name) => {
      if (name === "Client") return FakeClient;
      if (name === "GatewayIntentBits" || name === "Partials") {
        return new Proxy({}, { get: (_e, key) => String(key) });
      }
      return class { constructor() { return anyBuilder(); } };
    },
  }),
};

const USER = "u1";
const USER2 = "u2";
const THREAD = "chan-3";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pidash-handler-"));
const stateFile = path.join(tmp, "discord-state.json");
const envFile = path.join(tmp, "discord.env");
fs.writeFileSync(envFile, "");

const savedEnv = { ...process.env };
process.env.HOME = tmp;
process.env.PIDASH_DISCORD_STATE_FILE = stateFile;
process.env.PIDASH_DISCORD_ENV_FILE = envFile;
process.env.DISCORD_BOT_TOKEN = "test-token";
process.env.DISCORD_ALLOWED_USERS = USER;
process.env.DISCORD_ALLOW_ALL = "false";

interface Sent { sessionId: string; type: string; command?: string; id?: string; cancelled?: boolean; confirmed?: boolean }

interface Bot {
  handler: (m: any) => Promise<void>;
  interaction: (i: any) => Promise<void>;
  sends: Sent[];
  clients: Map<string, any>;
  /** pi -> bot events, as the daemon feeds them. */
  hooks: Array<(sessionId: string, event: any) => void>;
}

/** A bot whose user watches `watchedSessionId` and owns thread chan-3 for s3; `live` decides what is connected. */
function startBot(opts: {
  live: string[];
  watchedSessionId?: string | null;
  threads?: Record<string, string>;
  threadId?: string | null;
  responseChannelId?: string | null;
  cwd?: string;
  dmChannelId?: string | null;
  /** Per-session `lastActivity`, which decides the newest session when several are connected. */
  lastActivity?: Record<string, number>;
  /** More users in the same guild channel — a shared fallback channel is a real case. */
  extraUsers?: string[];
  restore?: boolean;
}): Bot {
  const users: Record<string, unknown> = {
    [USER]: {
      watchedSessionId: opts.watchedSessionId === undefined ? "s2" : opts.watchedSessionId,
      responseChannelId: opts.responseChannelId === undefined ? DM : opts.responseChannelId,
      dmChannelId: opts.dmChannelId === undefined ? DM : opts.dmChannelId,
      threads: opts.threads ?? { s3: THREAD },
      threadId: opts.threadId ?? null,
      updatedAt: Date.now(),
    },
  };
  for (const extra of opts.extraUsers ?? []) {
    users[extra] = {
      watchedSessionId: null,
      responseChannelId: opts.responseChannelId ?? DM,
      dmChannelId: opts.dmChannelId === undefined ? DM : opts.dmChannelId,
      threads: {},
      updatedAt: Date.now(),
    };
  }
  if (!opts.restore) fs.writeFileSync(stateFile, JSON.stringify({ users }));
  const sends: Sent[] = [];
  const piClients = new Map<string, any>();
  for (const sessionId of opts.live) {
    piClients.set(sessionId, {
      session: { sessionId, active: true, cwd: opts.cwd ?? "/work", supportsImages: true, lastActivity: opts.lastActivity?.[sessionId] ?? Date.now() },
      ws: { send: (raw: string) => sends.push({ sessionId, ...JSON.parse(raw) }) },
      replaying: false,
    });
  }
  const hooks: Array<(sessionId: string, event: any) => void> = [];
  const before = built.length;
  const signals = ["beforeExit", "SIGTERM", "SIGINT"] as const;
  const previousListeners = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
  setupDiscordBot({
    piClients,
    piEventHooks: hooks,
    getActiveSessions: () => [...piClients.values()].map((client) => client.session),
    log: () => {},
  });
  // Each stub bot must not retain process hooks or recreate its fixture after teardown.
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!previousListeners.get(signal)!.has(listener)) process.removeListener(signal, listener);
    }
  }
  assert.equal(built.length, before + 1, "setupDiscordBot built no client");
  return {
    handler: built[built.length - 1]!.listeners("messageCreate")[0] as (m: any) => Promise<void>,
    interaction: built[built.length - 1]!.listeners("interactionCreate")[0] as (i: any) => Promise<void>,
    sends,
    clients: piClients,
    hooks,
  };
}

function message(id: string, content: string, replies: string[], opts: { dm?: boolean; channelId?: string; author?: string } = {}): any {
  return {
    id,
    guildId: opts.dm ? null : "g1",
    channelId: opts.dm ? DM : opts.channelId ?? THREAD,
    content,
    author: { id: opts.author ?? USER, bot: false, createDM: async () => ({ id: DM }) },
    reply: async (text: string) => { replies.push(text); },
  };
}

/** onUiRequest delivers questions inside a floating promise; give it turns to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Everything the bot logged for the current session — the file the logger itself resolved.
 *  Reading a guessed path made these tests depend on the machine's HOME, session nesting and
 *  write-failure fallback; `getPiLogPath` is the same source the writer uses. */
const LOG_NAME = "pidash-discord";

function readLogs(): string {
  const logPath = getPiLogPath(LOG_NAME);
  assert.ok(logPath, "no session id set: fileLog buffers, so nothing was written");
  // Hermeticity: the HOME override must hold, or this reads another machine's log tree.
  assert.ok(logPath.startsWith(tmp + path.sep), `log path escaped the test HOME: ${logPath}`);
  if (!fs.existsSync(logPath)) {
    assert.fail(`nothing was logged at ${logPath} (last write error: ${getLastFileLogError()})`);
  }
  return fs.readFileSync(logPath, "utf8");
}

/** Pin the bot's level explicitly: the routing trace is debug, the refusals are info, and neither
 *  may depend on `PI_LOG_PIDASH_DISCORD` or a project/global log setting being what the test wants. */
function pinLevel(level: "debug" | "info"): void {
  setLogLevelPin(LOG_NAME, level);
}

/** A right-click "Ask pi about this message" interaction on a message in `channelId`. */
function contextMenu(replies: string[], opts: { channelId?: string } = {}): any {
  return {
    user: { id: USER, username: "tester", createDM: async () => ({ id: DM }) },
    channelId: opts.channelId ?? PLAIN,
    guildId: "g1",
    isMessageContextMenuCommand: () => true,
    targetMessage: { content: "look at this", attachments: new Map() },
    reply: async (payload: any) => { replies.push(String(payload?.content ?? "")); },
  };
}

/** A slash command interaction; `replies` records the text of each reply. */
function slash(name: string, replies: string[]): any {
  return {
    user: { id: USER, username: "tester" },
    channelId: DM,
    guildId: null,
    commandName: name,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    options: { getString: () => null },
    reply: async (payload: any) => { replies.push(String(payload?.content ?? "")); },
  };
}

describe("discord messageCreate routing", () => {
  it("ordinary fallback refuses when private DM setup fails", async () => {
    const bot = startBot({ live: ["s1"], watchedSessionId: null, threads: {} });
    const replies: string[] = [];
    const inbound = message("ordinary-dm-unavailable", "continue", replies, { dm: true });
    inbound.author.createDM = async () => { throw new Error("DM unavailable"); };
    await bot.handler(inbound);
    assert.deepEqual(bot.sends, []);
    assert.match(replies.join("\n"), /private reply channel/);
  });

  it("file failure logs omit private filenames", async () => {
    (globalThis as any).__piConfigSessionId = "private-file-failure-log";
    pinLevel("info");
    try {
      const bot = startBot({ live: ["s1"], watchedSessionId: null, threads: {}, cwd: tmp });
      const interaction = slash("file", []);
      interaction.options.getString = () => "sensitive-name.txt";
      await bot.interaction(interaction);
      assert.match(readLogs(), /workspace file delivery failed/);
      assert.doesNotMatch(readLogs(), /sensitive-name/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("target routing records its session identity", async () => {
    (globalThis as any).__piConfigSessionId = "target-routing-log";
    pinLevel("debug");
    try {
      const bot = startBot({ live: ["s1"], watchedSessionId: null, threads: { s1: DM } });
      await bot.handler(message("target-log", "continue", [], { dm: true }));
      assert.match(readLogs(), /discord_prompt_via_target \{"sessionId":"s1","channelId":"dm-1"\}/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("menu refreshes cached targets before reuse", async () => {
    const bot = startBot({ live: ["s3"], watchedSessionId: null });
    const client = built.at(-1)!;
    const fetch = client.channels.fetch;
    client.channels.fetch = async (id: string, options?: any) => id === THREAD
      ? options?.force ? null : { id, isTextBased: () => true, send: async () => ({ id: "stale" }) } as any
      : fetch(id);
    await bot.interaction(contextMenu([], { channelId: THREAD }));
    bot.hooks[0]!("s3", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fresh target answer" } });
    bot.hooks[0]!("s3", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fresh target answer" }] } });
    await settle();
    assert.match(JSON.stringify(client.deliveries), /fresh target answer/);
  });

  it("menu refuses forwarding when a replacement private DM is unavailable", async () => {
    const bot = startBot({ live: ["s3"], watchedSessionId: null });
    const replies: string[] = [];
    const interaction = contextMenu(replies, { channelId: THREAD });
    interaction.user.createDM = async () => { throw new Error("unavailable"); };
    await bot.interaction(interaction);
    assert.deepEqual(bot.sends, []);
    assert.match(replies.join("\n"), /private reply channel/);
  });

  it("slash respects channel identity before newest recency", async () => {
    const bot = startBot({ live: ["s1", "s3"], watchedSessionId: null, lastActivity: { s1: 999, s3: 1 } });
    const interaction = slash("stop", []);
    interaction.channelId = THREAD;
    interaction.guildId = "g1";
    await bot.interaction(interaction);
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.command]), [["s3", "abort"]]);
  });

  it("slash preserves disconnected thread identity", async () => {
    const bot = startBot({ live: ["s1"], watchedSessionId: null });
    const replies: string[] = [];
    const interaction = slash("stop", replies);
    interaction.channelId = THREAD;
    interaction.guildId = "g1";
    await bot.interaction(interaction);
    assert.deepEqual(bot.sends, []);
    assert.match(replies.join("\n"), /disconnected|not connected/i);
  });

  it("guild cancel refuses multiple channel askers", async () => {
    const bot = startBot({ live: ["s1", "s3"], watchedSessionId: null, threads: {}, responseChannelId: PLAIN, dmChannelId: null });
    for (const id of ["s1", "s3"]) bot.hooks[0]!(id, { type: "extension_ui_request", id, method: "confirm", title: "Proceed?" });
    await settle();
    const replies: string[] = [];
    await bot.handler(message("cancel-conflict", "/cancel", replies, { channelId: PLAIN }));
    assert.deepEqual(bot.sends, []);
    assert.match(replies[0]!, /more than one session/);
  });

  it("guild cancel answers the channel asker rather than the watch", async () => {
    const bot = startBot({ live: ["s2", "s9"], watchedSessionId: "s2", threads: { s2: THREAD }, responseChannelId: PLAIN, dmChannelId: null });
    for (const id of ["s2", "s9"]) bot.hooks[0]!(id, { type: "extension_ui_request", id, method: "confirm", title: "Proceed?" });
    await settle();
    await bot.handler(message("cancel-channel-asker", "/cancel", [], { channelId: PLAIN }));
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.id, s.cancelled]), [["s9", "s9", true]]);
  });

  it("menu reports shared-channel ambiguity on every attempt", async () => {
    (globalThis as any).__piConfigSessionId = "menu-conflict-every-refusal";
    pinLevel("info");
    try {
      const bot = startBot({ live: ["s1", "s3"], watchedSessionId: null, threads: {}, responseChannelId: PLAIN, dmChannelId: null });
      for (const id of ["s1", "s3"]) bot.hooks[0]!(id, { type: "extension_ui_request", id, method: "confirm", title: "Proceed?" });
      await settle();
      const replies: string[] = [];
      await bot.interaction(contextMenu(replies));
      await bot.interaction(contextMenu(replies));
      assert.equal(replies.filter((r) => /more than one session/.test(r)).length, 2);
      assert.deepEqual(bot.sends, []);
      assert.equal(readLogs().split("\n").filter((line) => line.includes('"reason":"interaction-ambiguous"')).length, 2);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("transient disconnection preserves persistent watch", async () => {
    const bot = startBot({ live: ["s1"], watchedSessionId: "s2", threads: { s2: THREAD } });
    await bot.handler(message("keep-watch", "continue", [], { dm: true }));
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).users[USER].watchedSessionId, "s2");
  });

  it("unwatched menu reply subscription survives restart", async () => {
    const first = startBot({ live: ["s1"], watchedSessionId: null, responseChannelId: null, threads: {} });
    await first.interaction(contextMenu([]));
    const restored = startBot({ live: ["s1"], restore: true });
    restored.hooks[0]!("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "restored answer" } });
    restored.hooks[0]!("s1", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "restored answer" }] } });
    await settle();
    assert.match(JSON.stringify(built.at(-1)!.deliveries), /restored answer/);
  });

  it("menu replaces unavailable retained target with private DM", async () => {
    const bot = startBot({ live: ["s3"], watchedSessionId: null });
    await bot.interaction(contextMenu([], { channelId: THREAD }));
    bot.hooks[0]!("s3", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "private answer" } });
    bot.hooks[0]!("s3", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "private answer" }] } });
    await settle();
    assert.match(JSON.stringify(built.at(-1)!.deliveries), /private answer/);
  });

  it("ordinary active fallback subscribes to replies", async () => {
    const bot = startBot({ live: ["s1"], watchedSessionId: null, threads: {} });
    await bot.handler(message("fallback-replies", "continue", [], { dm: true }));
    bot.hooks[0]!("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ordinary answer" } });
    bot.hooks[0]!("s1", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ordinary answer" }] } });
    await settle();
    assert.match(JSON.stringify(built.at(-1)!.deliveries), /ordinary answer/);
  });

  it("context-menu fallback establishes a private session reply destination", async () => {
    const bot = startBot({ live: ["s1"], watchedSessionId: null, responseChannelId: null, threads: {} });
    await bot.interaction(contextMenu([]));
    bot.hooks[0]!("s1", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "menu answer" } });
    bot.hooks[0]!("s1", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "menu answer" }] } });
    await settle();
    assert.match(JSON.stringify(built.at(-1)!.deliveries), /menu answer/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).users[USER].watchedSessionId, null);
  });

  it("file fallback uploads through the private interaction without a stored watch", async () => {
    const workspace = fs.mkdtempSync(path.join(tmp, "workspace-"));
    try {
      fs.writeFileSync(path.join(workspace, "result.txt"), "private result");
      const bot = startBot({ live: ["s1"], watchedSessionId: null, responseChannelId: null, threads: {}, cwd: workspace });
      const interaction = slash("file", []);
      interaction.channelId = PLAIN;
      interaction.guildId = "g1";
      interaction.options.getString = () => "result.txt";
      const uploads: any[] = [];
      interaction.deferReply = async (payload: any) => { assert.equal(payload.ephemeral, true); interaction.deferred = true; };
      interaction.editReply = async (payload: any) => { uploads.push(payload); };
      await bot.interaction(interaction);
      assert.equal(uploads.find((p) => p.files)?.files[0].attachment.toString(), "private result");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("old DM does not pin a dead watch whose output targets a thread", async () => {
    const bot = startBot({ live: ["s1"], watchedSessionId: "s2", threads: { s2: THREAD } });
    const replies: string[] = [];
    await bot.handler(message("stale-dm", "continue", replies, { dm: true }));
    assert.deepEqual(bot.sends.map((s) => s.sessionId), ["s1"]);
    assert.deepEqual(replies, []);
  });

  it("shared live targets remain ambiguous despite a dead watch", async () => {
    const bot = startBot({ live: ["s1", "s3"], watchedSessionId: "s2", threadId: THREAD, threads: { s1: DM, s3: DM }, responseChannelId: DM });
    const replies: string[] = [];
    await bot.handler(message("conflict", "continue", replies, { dm: true }));
    assert.deepEqual(bot.sends, []);
    assert.match(replies[0]!, /more than one session/);
  });

  it("routine fallback diagnostics use DEBUG", async () => {
    (globalThis as any).__piConfigSessionId = "fallback-debug";
    pinLevel("debug");
    try {
      const bot = startBot({ live: ["s1"], watchedSessionId: null, threads: {} });
      await bot.handler(message("debug-route", "continue", [], { dm: true }));
      assert.match(readLogs(), /\[debug\] \[pidash-discord\] discord_inbound_fallback/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });
  after(() => {
    process.env = savedEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("/stop reaches the thread's session, not the watched one", async () => {
    const bot = startBot({ live: ["s2", "s3"] });
    const replies: string[] = [];
    await bot.handler(message("m1", "/stop", replies));
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.command]), [["s3", "abort"]]);
    assert.deepEqual(replies, ["⏹️ Stop sent."]);
  });

  it("refuses a dead thread instead of spilling into the watched session", async () => {
    const bot = startBot({ live: ["s2"] });
    const replies: string[] = [];
    await bot.handler(message("m2", "hello", replies));
    assert.deepEqual(bot.sends, []);
    assert.deepEqual(replies, ["That thread's session is not connected."]);
  });

  it("a DM /cancel dismisses the newest question, not the watched session's", async () => {
    // The DM carries s9's question while the user watches s2 — s9's target is this DM channel.
    const bot = startBot({ live: ["s2", "s9"], watchedSessionId: "s2", threads: {} });
    bot.hooks[0]!("s9", { type: "extension_ui_request", id: "q1", method: "confirm", title: "Proceed?" });
    await settle();

    const replies: string[] = [];
    await bot.handler(message("m3", "/cancel", replies, { dm: true }));
    // Pinning the cancel to the watch would leave s9's question pending and never reach it.
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.id, s.cancelled]), [["s9", "q1", true]]);
    assert.deepEqual(replies, ["Dismissed."]);
  });

  it("answers a question delivered to a plain channel when no thread could be created", async () => {
    // Thread creation fails, so s9's question lands in the plain guild channel. Only the registered
    // threads are routable by thread, so this channel has to be accepted as a delivery target.
    const bot = startBot({
      live: ["s9"],
      watchedSessionId: null,
      threads: {},
      responseChannelId: PLAIN,
      dmChannelId: null,
    });
    bot.hooks[0]!("s9", { type: "extension_ui_request", id: "q2", method: "confirm", title: "Proceed?" });
    await settle();

    const replies: string[] = [];
    await bot.handler(message("m4", "yes", replies, { channelId: PLAIN }));
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.id, s.confirmed]), [["s9", "q2", true]]);
  });

  it("answers in a plain channel shared by two users' fallback targets", async () => {    // Both users fall back to the same channel; matching the FIRST owner dropped the other's reply.
    const previousAllowAll = process.env.DISCORD_ALLOW_ALL;
    process.env.DISCORD_ALLOW_ALL = "true";
    try {
      const bot = startBot({
        live: ["s9"],
        watchedSessionId: null,
        threads: {},
        responseChannelId: PLAIN,
        dmChannelId: null,
        extraUsers: [USER2],
      });
      bot.hooks[0]!("s9", { type: "extension_ui_request", id: "q3", method: "confirm", title: "Proceed?" });
      await settle();

      const replies: string[] = [];
      // The second stored user: the first owner of the channel is somebody else.
      await bot.handler(message("m5", "yes", replies, { channelId: PLAIN, author: USER2 }));
      assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.id, s.confirmed]), [["s9", "q3", true]]);
    } finally {
      process.env.DISCORD_ALLOW_ALL = previousAllowAll;
    }
  });

  it("a reply in a channel answers only that channel's session", async () => {
    // s9's question lives in the plain channel, s5's in its own thread and it asked LAST. Answering
    // "the newest question" from s9's channel would approve s5.
    const bot = startBot({
      live: ["s9", "s5"],
      watchedSessionId: null,
      threads: { s5: THREAD },
      responseChannelId: PLAIN,
      dmChannelId: null,
    });
    bot.hooks[0]!("s9", { type: "extension_ui_request", id: "q9", method: "confirm", title: "Proceed?" });
    await settle();
    bot.hooks[0]!("s5", { type: "extension_ui_request", id: "q5", method: "confirm", title: "Proceed?" });
    await settle();

    const replies: string[] = [];
    await bot.handler(message("m6", "yes", replies, { channelId: PLAIN }));
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.id]), [["s9", "q9"]]);
  });

  it("answers the session whose question this channel carries, not the watched one", async () => {
    // s5's question fell back to the plain channel; s2 is watched and asked LAST, in its own thread.
    const bot = startBot({
      live: ["s2", "s5"],
      watchedSessionId: "s2",
      threads: { s2: THREAD },
      responseChannelId: PLAIN,
      dmChannelId: null,
    });
    bot.hooks[0]!("s5", { type: "extension_ui_request", id: "q5", method: "confirm", title: "Proceed?" });
    await settle();
    bot.hooks[0]!("s2", { type: "extension_ui_request", id: "q2", method: "confirm", title: "Proceed?" });
    await settle();

    const replies: string[] = [];
    await bot.handler(message("m7", "yes", replies, { channelId: PLAIN }));
    // Preferring the watch answered s2's question from a channel that never carried it.
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.id]), [["s5", "q5"]]);
  });

  it("refuses to answer in a channel two sessions deliver into", async () => {    // No session can be named for this channel, so answering "the newest question" would approve one
    // of them blind.
    const bot = startBot({
      live: ["s2", "s9"],
      watchedSessionId: "s2",
      threads: {},
      responseChannelId: PLAIN,
      dmChannelId: null,
    });
    bot.hooks[0]!("s9", { type: "extension_ui_request", id: "q9", method: "confirm", title: "Proceed?" });
    await settle();
    bot.hooks[0]!("s2", { type: "extension_ui_request", id: "q2", method: "confirm", title: "Proceed?" });
    await settle();

    const replies: string[] = [];
    await bot.handler(message("m8", "yes", replies, { channelId: PLAIN }));
    assert.deepEqual(bot.sends, []);
    assert.deepEqual(replies, ["This channel carries more than one session. Send in that session's thread or use `/sessions`."]);
  });

  it("answers nothing once the channel's question has expired", async () => {
    mock.timers.enable({ apis: ["Date"] });
    try {
      const bot = startBot({
        live: ["s2", "s5"],
        watchedSessionId: "s2",
        threads: { s2: THREAD },
        responseChannelId: PLAIN,
        dmChannelId: null,
      });
      bot.hooks[0]!("s5", { type: "extension_ui_request", id: "q5", method: "confirm", title: "Proceed?" });
      await settle();
      // Past the prompt TTL: the question that put s5's target in this channel is dead.
      mock.timers.tick(60 * 60 * 1000);

      const replies: string[] = [];
      await bot.handler(message("m9", "yes", replies, { channelId: PLAIN }));
      // The stale target must not keep naming the channel: the watch takes it, per the routing order.
      assert.deepEqual(bot.sends.map((s) => s.sessionId), ["s2"]);
      assert.match(replies[0] ?? "", /expired/);
    } finally {
      mock.timers.reset();
    }
  });

  it("forwards a message in the channel streaming the watch, with no target for that channel", async () => {
    // The owner's report: the bot streams s2's output into this DM, so it IS watching s2. Every
    // message there was refused because the target map no longer named the channel.
    const bot = startBot({ live: ["s2"], watchedSessionId: "s2", threads: { s2: THREAD }, dmChannelId: DM });
    const replies: string[] = [];
    await bot.handler(message("m30", "keep going", replies, { dm: true }));
    assert.deepEqual(replies, []);
    assert.equal(bot.sends.length, 1);
    assert.equal(bot.sends[0]!.sessionId, "s2");
  });

  it("says which session is not connected in the channel streaming it", async () => {
    // Same channel, but the watched client lost its connection: "not watching any session" would be
    // false there — the bot still streams this session into that channel.
    const bot = startBot({ live: [], watchedSessionId: "s2", threads: {}, dmChannelId: DM });
    const replies: string[] = [];
    await bot.handler(message("m31", "hello", replies, { dm: true }));
    assert.deepEqual(bot.sends, []);
    assert.equal(replies.length, 1);
    assert.match(replies[0]!, /^This channel streams .+, but that session is not connected to the daemon right now\.$/);
    assert.doesNotMatch(replies[0]!, /Not watching any session/);
  });

  it("still refuses a channel that carries nothing", async () => {
    // A guild channel that is neither the response channel nor any session's target: the fallback
    // must not reach it. (A new DM sets the response channel, so only a guild channel is left.)
    const bot = startBot({ live: ["s2"], watchedSessionId: "s2", threads: { s2: THREAD }, dmChannelId: DM });
    const replies: string[] = [];
    await bot.handler(message("m32", "hello", replies, { channelId: "chan-elsewhere" }));
    assert.deepEqual(bot.sends, []);
    assert.deepEqual(replies, []);
  });

  it("/stop works in the channel streaming the watch, without a target for it", async () => {
    const bot = startBot({ live: ["s2"], watchedSessionId: "s2", threads: { s2: THREAD }, dmChannelId: DM });
    const replies: string[] = [];
    await bot.handler(message("m33", "/stop", replies, { dm: true }));
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.command]), [["s2", "abort"]]);
    assert.deepEqual(replies, ["⏹️ Stop sent."]);
  });

  it("routes to the only active session instead of refusing", async () => {
    // The owner's rule: "Not watching any session" is false while a session is connected, so the
    // message goes there — and the log says which one and why.
    (globalThis as any).__piConfigSessionId = "inbound-fallback-single";
    pinLevel("debug");
    try {
      const bot = startBot({ live: ["s1"], watchedSessionId: null, threads: {} });
      const replies: string[] = [];
      await bot.handler(message("m40", "keep going", replies, { dm: true }));
      assert.deepEqual(replies, []);
      assert.deepEqual(bot.sends.map((s) => s.sessionId), ["s1"]);
      const body = readLogs();
      assert.match(body, /discord_inbound_fallback \{"reason":"fallback_single_active"/);
      assert.match(body, /"sessionId":"s1","candidates":1/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("records the newest-active routing decision", async () => {
    (globalThis as any).__piConfigSessionId = "inbound-fallback-newest";
    pinLevel("debug");
    try {
      const bot = startBot({
        live: ["s1", "s2"],
        watchedSessionId: null,
        threads: {},
        lastActivity: { s1: 1_000, s2: 2_000 },
      });
      const replies: string[] = [];
      await bot.handler(message("m41", "hello", replies, { dm: true }));
      assert.deepEqual(replies, []);
      assert.deepEqual(bot.sends.map((s) => s.sessionId), ["s2"]);
      const body = readLogs();
      assert.match(body, /discord_inbound_fallback \{"reason":"fallback_newest_active"/);
      assert.match(body, /"sessionId":"s2","candidates":2/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("refuses with the exact sentence when no session is active", async () => {
    const bot = startBot({ live: [], watchedSessionId: null, threads: {} });
    const replies: string[] = [];
    await bot.handler(message("reply-none", "hello", replies, { dm: true }));
    assert.deepEqual(replies, ["Not watching any session. Use `/sessions` and pick one."]);
    assert.deepEqual(bot.sends, []);
  });

  it("logs every no-session refusal", async () => {
    (globalThis as any).__piConfigSessionId = "inbound-refusal-none";
    pinLevel("info");
    try {
      const bot = startBot({ live: [], watchedSessionId: null, threads: {} });
      const replies: string[] = [];
      await bot.handler(message("m42", "hello", replies, { dm: true }));
      await bot.handler(message("m43", "hello again", replies, { dm: true }));
      assert.equal(replies.length, 2);
      const body = readLogs();
      // Two refusals, two lines: no throttling anywhere on this path.
      assert.equal(body.match(/discord_inbound_dropped \{"reason":"no-target"/g)?.length, 2);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("routes to an active session when the watched one has no connection", async () => {
    // The watch names s2, which is disconnected; s1 is running and this thread is not the channel that
    // streams the watch. That is not "no session at all", so the text goes to the live session.
    const bot = startBot({
      live: ["s1"],
      watchedSessionId: "s2",
      threads: {},
      threadId: PLAIN,
      responseChannelId: DM,
      dmChannelId: DM,
    });
    const replies: string[] = [];
    await bot.handler(message("m44", "hello", replies, { channelId: PLAIN }));
    assert.deepEqual(replies, []);
    assert.deepEqual(bot.sends.map((s) => s.sessionId), ["s1"]);
  });

  it("/stop aborts the fallback session when the watched one has no connection", async () => {
    const bot = startBot({
      live: ["s1"],
      watchedSessionId: "s2",
      threads: {},
      threadId: PLAIN,
      responseChannelId: DM,
      dmChannelId: DM,
    });
    const replies: string[] = [];
    await bot.handler(message("m45", "/stop", replies, { channelId: PLAIN }));
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.command]), [["s1", "abort"]]);
    assert.deepEqual(replies, ["⏹️ Stop sent."]);
  });

  it("logs a message dropped in a channel the user does not own, once per channel", async () => {
    // The refusal the owner reproduced had no log line at all; a silent drop is undiagnosable. It is
    // routine traffic, so it logs at INFO — but never throttled: a refusal that logs once and hides
    // the second occurrence is how this bug survived several deploys.
    (globalThis as any).__piConfigSessionId = "inbound-route-log-test";
    pinLevel("info");
    try {
      const bot = startBot({ live: ["s2"] });
      const replies: string[] = [];
      await bot.handler(message("m10", "hello there", replies, { channelId: "chan-not-owned" }));
      await bot.handler(message("m11", "hello again", replies, { channelId: "chan-not-owned" }));
      assert.deepEqual(replies, []);

      const body = readLogs();
      assert.match(body, /discord_inbound_dropped/);
      assert.match(body, /channel-not-owned/);
      assert.match(body, /chan-not-owned/);
      // A routine refusal is not a degradation: this record is INFO, not WARN.
      assert.match(body, /\[info\] \[pidash-discord\] discord_inbound_dropped \{"reason":"channel-not-owned"/);
      // Ambient guild-gate drops are throttled to one line per minute.
      assert.equal(body.match(/"reason":"channel-not-owned","channelId":"chan-not-owned"/g)?.length, 1);
      // Ids only: the message body must never reach the log.
      assert.doesNotMatch(body, /hello there/);
      assert.doesNotMatch(body, /hello again/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("logs a shared channel's drop for each user of it", async () => {
    // Throttling per channel alone would hide the second user's drop; the key includes the author.
    (globalThis as any).__piConfigSessionId = "inbound-route-shared-log-test";
    pinLevel("info");
    const previousAllowAll = process.env.DISCORD_ALLOW_ALL;
    process.env.DISCORD_ALLOW_ALL = "true";
    try {
      const bot = startBot({ live: ["s2"], threads: { s2: THREAD }, extraUsers: [USER2] });
      const replies: string[] = [];
      await bot.handler(message("m12", "hi", replies, { channelId: "chan-shared" }));
      await bot.handler(message("m13", "hi", replies, { channelId: "chan-shared", author: USER2 }));
      assert.deepEqual(replies, []);

      const body = readLogs();
      assert.equal(body.match(/"reason":"channel-not-owned","channelId":"chan-shared"/g)?.length, 2);
      assert.match(body, /"userId":"u1"/);
      assert.match(body, /"userId":"u2"/);
    } finally {
      process.env.DISCORD_ALLOW_ALL = previousAllowAll;
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  for (const [control, refusal, reason] of [
    ["/stop", "Not watching any session. Use `/sessions` and pick one.", "stop-no-target"],
    ["/cancel", "Nothing pending.", "cancel-nothing-pending"],
  ]) it(`logs the ${control} refusal`, async () => {
    (globalThis as any).__piConfigSessionId = `inbound-route-refusal-${reason}`;
    pinLevel("info");
    try {
      const bot = startBot({ live: [], watchedSessionId: null, threads: {}, dmChannelId: DM });
      const replies: string[] = [];
      await bot.handler(message("control-refusal", control!, replies, { dm: true }));
      assert.deepEqual(replies, [refusal]);
      assert.ok(readLogs().includes(`"reason":"${reason}"`));
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("logs the routing decision at debug, once per new decision", async () => {
    (globalThis as any).__piConfigSessionId = "inbound-routed-debug-test";
    pinLevel("debug");
    try {
      const bot = startBot({ live: ["s2", "s3"] });
      const replies: string[] = [];
      await bot.handler(message("m21", "one", replies));
      await bot.handler(message("m22", "two", replies));
      // A DM routes to the watch: a different decision for a different channel.
      await bot.handler(message("m23", "three", replies, { dm: true }));
      assert.deepEqual(replies, []);

      const body = readLogs();
      const routed = body.split("\n").filter((line) => line.includes("discord_inbound_routed"));
      // Two decisions, three messages: repeating the same one is not an event, and an append per
      // message on a busy channel is a stall (Qodo #1075).
      assert.equal(routed.length, 2);
      assert.match(routed[0]!, /\[debug\].*"inboundSessionId":"s3"/);
      assert.match(routed[1]!, /\[debug\].*"inboundSessionId":"s2"/);
      // A branch decision is control flow: INFO stays for lifecycle and for the refusals.
      assert.doesNotMatch(body, /\[info\] \[pidash-discord\] discord_inbound_routed/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("the routing trace names the session the answer actually went to", async () => {
    (globalThis as any).__piConfigSessionId = "inbound-routed-answer-test";
    pinLevel("debug");
    try {
      // s5's question fell back to the plain channel while the user watches s2: routing names s2,
      // the bridge sends to s5. A trace that showed only the routed session could not be
      // reconciled with what the bridge did (Qodo #1075).
      const bot = startBot({ live: ["s2", "s5"], watchedSessionId: "s2", threads: {}, responseChannelId: PLAIN, dmChannelId: null });
      bot.hooks[0]!("s5", { type: "extension_ui_request", id: "q5", method: "confirm", title: "Proceed?" });
      await settle();

      const replies: string[] = [];
      await bot.handler(message("m24", "yes", replies, { channelId: PLAIN }));
      assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.id]), [["s5", "q5"]]);

      const routed = readLogs().split("\n").filter((line) => line.includes("discord_inbound_routed"));
      assert.equal(routed.length, 1);
      assert.match(routed[0]!, /"inboundSessionId":"s2"/);
      assert.match(routed[0]!, /"answerSessionId":"s5"/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("a context menu in a channel carrying a live session works without a watch", async () => {
    // The owner's report: the bot streams s9's output into this channel, so the channel IS s9's
    // address. Reading `watchedSessionId` alone refused a channel the bot was writing into
    // (Qodo #1075).
    const bot = startBot({ live: ["s9"], watchedSessionId: null, threads: {}, responseChannelId: PLAIN, dmChannelId: null });
    bot.hooks[0]!("s9", { type: "extension_ui_request", id: "q4", method: "confirm", title: "Proceed?" });
    await settle();

    const replies: string[] = [];
    await bot.interaction(contextMenu(replies));
    assert.deepEqual(bot.sends.map((s) => s.sessionId), ["s9"]);
    assert.match(replies[0] ?? "", /^Sent to /);
  });

  it("a context menu falls back to the only active session instead of refusing", async () => {
    // The owner's rule reaches this site too: nothing watches this channel, but s9 is connected, so
    // the prompt has a target. Refusing here was the bug (#1075).
    (globalThis as any).__piConfigSessionId = "interaction-fallback-menu";
    pinLevel("debug");
    try {
      const bot = startBot({ live: ["s9"], watchedSessionId: null, threads: {} });
      const replies: string[] = [];
      await bot.interaction(contextMenu(replies, { channelId: PLAIN }));
      assert.deepEqual(bot.sends.map((s) => s.sessionId), ["s9"]);
      assert.doesNotMatch(replies.join("\n"), /Not watching any session/);
      assert.match(readLogs(), /discord_inbound_fallback \{"reason":"fallback_single_active","sessionId":"s9","candidates":1,"handler":"context-menu"/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("a slash command acts on the only active session instead of refusing", async () => {
    (globalThis as any).__piConfigSessionId = "interaction-fallback-slash";
    pinLevel("debug");
    try {
      const bot = startBot({ live: ["s1"], watchedSessionId: null, threads: {} });
      const statusReplies: string[] = [];
      await bot.interaction(slash("status", statusReplies));
      assert.equal(statusReplies.length, 1);
      assert.doesNotMatch(statusReplies.join("\n"), /Not watching any session/);
      // /stop goes all the way to the gateway, so the payload names the session the guard picked.
      await bot.interaction(slash("stop", []));
      assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.command]), [["s1", "abort"]]);
      const body = readLogs();
      assert.match(body, /discord_inbound_fallback \{"reason":"fallback_single_active","sessionId":"s1","candidates":1,"handler":"slash-command:status"/);
      assert.match(body, /"handler":"slash-command:stop"/);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  for (const kind of ["menu", "slash"]) it(`${kind} logs every no-active-session refusal`, async () => {
    (globalThis as any).__piConfigSessionId = `interaction-refusal-none-${kind}`;
    pinLevel("info");
    try {
      const bot = startBot({ live: [], watchedSessionId: null, threads: {} });
      const replies: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        await bot.interaction(kind === "menu" ? contextMenu(replies, { channelId: PLAIN }) : slash("status", replies));
      }
      const refusal = "Not watching any session. Use `/sessions` first.";
      assert.deepEqual(replies, [refusal, refusal]);
      const body = readLogs();
      // Nothing was picked; every refusal is still on the record.
      assert.doesNotMatch(body, /discord_inbound_fallback/);
      assert.equal(body.match(/discord_inbound_dropped \{[^\n]*"reason":"interaction-no-watch"/g)?.length, 2);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("a context menu says the session is gone when this channel's target died", async () => {
    // The two refusals stay distinguishable: "not watching" hid why a channel that used to carry a
    // session went quiet.
    const bot = startBot({ live: [], watchedSessionId: "s2", threads: {}, responseChannelId: PLAIN, dmChannelId: null });
    const replies: string[] = [];
    await bot.interaction(contextMenu(replies));
    assert.deepEqual(bot.sends, []);
    assert.deepEqual(replies, ["The session this channel belonged to is gone. Use `/sessions` and pick one."]);
  });

  it("failed guild dismissal keeps the fallback prompt target reachable after reconnect", async () => {
    const bot = startBot({
      live: ["s2", "s9"],
      watchedSessionId: "s2",
      threadId: THREAD,
      threads: { s2: THREAD },
      responseChannelId: PLAIN,
      dmChannelId: null,
    });
    bot.hooks[0]!("s9", { type: "extension_ui_request", id: "q9", method: "confirm", title: "Proceed?" });
    await settle();

    const client = bot.clients.get("s9")!;
    const savedWs = client.ws;
    client.ws = null;
    const cancelReplies: string[] = [];
    await bot.handler(message("cancel-offline", "/cancel", cancelReplies, { channelId: PLAIN }));
    assert.deepEqual(cancelReplies, ["The session is not connected."]);
    assert.deepEqual(bot.sends, []);

    client.ws = savedWs;
    const answerReplies: string[] = [];
    await bot.handler(message("answer-reconnected", "yes", answerReplies, { channelId: PLAIN }));
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.id, s.confirmed]), [["s9", "q9", true]]);
  });

  it("active fallback in a guild channel never approves another session's prompt", async () => {
    const bot = startBot({
      live: ["s1"],
      watchedSessionId: "s2",
      threads: { s1: THREAD },
      threadId: PLAIN,
      responseChannelId: DM,
      dmChannelId: DM,
    });
    bot.hooks[0]!("s1", { type: "extension_ui_request", id: "q1", method: "confirm", title: "Run dangerous cmd?" });
    await settle();

    const replies: string[] = [];
    await bot.handler(message("unrelated-guild-yes", "yes", replies, { channelId: PLAIN }));
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.type]), [["s1", "prompt"]]);

    await bot.handler(message("thread-no", "no", [], { channelId: THREAD }));
    assert.deepEqual(bot.sends.slice(1).map((s) => [s.sessionId, s.id, s.confirmed]), [["s1", "q1", false]]);
  });

  it("active fallback in a guild channel never dismisses another session's prompt", async () => {
    const bot = startBot({
      live: ["s1"],
      watchedSessionId: "s2",
      threads: { s1: THREAD },
      threadId: PLAIN,
      responseChannelId: DM,
      dmChannelId: DM,
    });
    bot.hooks[0]!("s1", { type: "extension_ui_request", id: "q1", method: "confirm", title: "Proceed?" });
    await settle();

    const replies: string[] = [];
    await bot.handler(message("unrelated-guild-cancel", "/cancel", replies, { channelId: PLAIN }));
    assert.deepEqual(replies, ["Nothing pending."]);
    assert.deepEqual(bot.sends, []);
  });

  it("guild channel with a dead target refuses ordinary messages instead of routing to another live session", async () => {
    const bot = startBot({ live: ["s1", "s9"], watchedSessionId: null, threads: {}, responseChannelId: PLAIN, dmChannelId: null });
    bot.hooks[0]!("s9", { type: "extension_ui_request", id: "q9", method: "confirm", title: "Proceed?" });
    await settle();
    bot.clients.delete("s9");
    bot.hooks[0]!("s9", { type: "ui-dismiss", id: "q9" });

    const replies: string[] = [];
    await bot.handler(message("dead-target-msg", "hello", replies, { channelId: PLAIN }));
    assert.deepEqual(bot.sends, []);
    assert.deepEqual(replies, ["The session this channel belonged to is gone. Use `/sessions` and pick one."]);
  });

  it("guild channel with a dead target refuses /stop instead of aborting another live session", async () => {
    const bot = startBot({ live: ["s1", "s9"], watchedSessionId: null, threads: {}, responseChannelId: PLAIN, dmChannelId: null });
    bot.hooks[0]!("s9", { type: "extension_ui_request", id: "q9", method: "confirm", title: "Proceed?" });
    await settle();
    bot.clients.delete("s9");
    bot.hooks[0]!("s9", { type: "ui-dismiss", id: "q9" });

    const replies: string[] = [];
    await bot.handler(message("dead-target-stop", "/stop", replies, { channelId: PLAIN }));
    assert.deepEqual(bot.sends, []);
    assert.deepEqual(replies, ["The session this channel belonged to is gone. Use `/sessions` and pick one."]);
  });

  it("slash command in a channel with a dead target refuses instead of acting on another live session", async () => {
    const bot = startBot({ live: ["s1", "s9"], watchedSessionId: null, threads: {}, responseChannelId: PLAIN, dmChannelId: null });
    bot.hooks[0]!("s9", { type: "extension_ui_request", id: "q9", method: "confirm", title: "Proceed?" });
    await settle();
    bot.clients.delete("s9");
    bot.hooks[0]!("s9", { type: "ui-dismiss", id: "q9" });

    const replies: string[] = [];
    const interaction = slash("stop", replies);
    interaction.channelId = PLAIN;
    interaction.guildId = "g1";
    await bot.interaction(interaction);
    assert.deepEqual(bot.sends, []);
    assert.deepEqual(replies, ["The session this channel belonged to is gone. Use `/sessions` and pick one."]);
  });

  it("throttles ambient unowned-channel drops across unwatched guild chatters within a minute", async () => {
    (globalThis as any).__piConfigSessionId = "ambient-guild-gate-throttle";
    pinLevel("info");
    const previousAllowAll = process.env.DISCORD_ALLOW_ALL;
    process.env.DISCORD_ALLOW_ALL = "true";
    mock.timers.enable({ apis: ["Date"] });
    try {
      const bot = startBot({ live: ["s2"], watchedSessionId: null, threads: {} });
      await bot.handler(message("busy-1", "hi", [], { channelId: "chan-busy", author: "guest-1" }));
      await bot.handler(message("busy-2", "yo", [], { channelId: "chan-busy", author: "guest-2" }));
      await bot.handler(message("busy-3", "hey", [], { channelId: "chan-busy", author: "guest-3" }));
      assert.equal(readLogs().match(/"reason":"channel-not-owned","channelId":"chan-busy"/g)?.length, 1);

      mock.timers.tick(60_001);
      await bot.handler(message("busy-4", "later", [], { channelId: "chan-busy", author: "guest-4" }));
      assert.equal(readLogs().match(/"reason":"channel-not-owned","channelId":"chan-busy"/g)?.length, 2);
    } finally {
      mock.timers.reset();
      process.env.DISCORD_ALLOW_ALL = previousAllowAll;
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("throttles repeated foreign-thread drops within a minute", async () => {
    (globalThis as any).__piConfigSessionId = "foreign-thread-throttle";
    pinLevel("info");
    const previousAllowAll = process.env.DISCORD_ALLOW_ALL;
    process.env.DISCORD_ALLOW_ALL = "true";
    try {
      const bot = startBot({ live: ["s3"], watchedSessionId: null, threads: { s3: THREAD } });
      await bot.handler(message("foreign-1", "hi", [], { channelId: THREAD, author: USER2 }));
      await bot.handler(message("foreign-2", "again", [], { channelId: THREAD, author: USER2 }));
      assert.equal(readLogs().match(/"reason":"thread-owned-by-other","channelId":"chan-3"/g)?.length, 1);
    } finally {
      process.env.DISCORD_ALLOW_ALL = previousAllowAll;
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("deduplicates repeated active-fallback debug logs for an unchanged route", async () => {
    (globalThis as any).__piConfigSessionId = "fallback-dedup-debug";
    pinLevel("debug");
    try {
      const bot = startBot({ live: ["s1"], watchedSessionId: null, threads: {} });
      await bot.interaction(slash("status", []));
      await bot.interaction(slash("status", []));
      const lines = readLogs().split("\n").filter((line) => line.includes("discord_inbound_fallback"));
      assert.equal(lines.length, 1);
    } finally {
      setLogLevelPin(LOG_NAME, null);
      delete (globalThis as any).__piConfigSessionId;
    }
  });

  it("active fallback excludes sessions claimed by another Discord user for direct messages", async () => {
    const previousAllowAll = process.env.DISCORD_ALLOW_ALL;
    process.env.DISCORD_ALLOW_ALL = "true";
    try {
      const bot = startBot({ live: ["s1"], watchedSessionId: "s1", threads: {}, extraUsers: [USER2] });
      const replies: string[] = [];
      await bot.handler(message("foreign-dm", "run whoami", replies, { dm: true, author: USER2 }));
      assert.deepEqual(bot.sends, []);
      assert.deepEqual(replies, ["Not watching any session. Use `/sessions` and pick one."]);
    } finally {
      process.env.DISCORD_ALLOW_ALL = previousAllowAll;
    }
  });

  it("active fallback excludes sessions claimed by another Discord user for slash commands", async () => {
    const previousAllowAll = process.env.DISCORD_ALLOW_ALL;
    process.env.DISCORD_ALLOW_ALL = "true";
    try {
      const bot = startBot({ live: ["s1"], watchedSessionId: null, threads: { s1: THREAD }, extraUsers: [USER2] });
      const replies: string[] = [];
      const interaction = slash("stop", replies);
      interaction.user = { id: USER2, username: "other" };
      await bot.interaction(interaction);
      assert.deepEqual(bot.sends, []);
      assert.deepEqual(replies, ["Not watching any session. Use `/sessions` first."]);
    } finally {
      process.env.DISCORD_ALLOW_ALL = previousAllowAll;
    }
  });

  it("active fallback excludes sessions claimed by another Discord user for context-menu prompts", async () => {
    const previousAllowAll = process.env.DISCORD_ALLOW_ALL;
    process.env.DISCORD_ALLOW_ALL = "true";
    try {
      const bot = startBot({ live: ["s1"], watchedSessionId: "s1", threads: {}, extraUsers: [USER2] });
      const replies: string[] = [];
      const interaction = contextMenu(replies);
      interaction.user = { id: USER2, username: "other", createDM: async () => ({ id: "dm-2" }) };
      await bot.interaction(interaction);
      assert.deepEqual(bot.sends, []);
      assert.deepEqual(replies, ["Not watching any session. Use `/sessions` first."]);
    } finally {
      process.env.DISCORD_ALLOW_ALL = previousAllowAll;
    }
  });

  it("active fallback selects an unclaimed session when another user claims the newest session", async () => {
    const previousAllowAll = process.env.DISCORD_ALLOW_ALL;
    process.env.DISCORD_ALLOW_ALL = "true";
    try {
      const bot = startBot({
        live: ["s1", "s2"],
        watchedSessionId: "s1",
        threads: {},
        lastActivity: { s1: 5_000, s2: 1_000 },
        extraUsers: [USER2],
      });
      const replies: string[] = [];
      await bot.handler(message("unclaimed-dm", "hello", replies, { dm: true, author: USER2 }));
      assert.deepEqual(replies, []);
      assert.deepEqual(bot.sends.map((s) => s.sessionId), ["s2"]);
    } finally {
      process.env.DISCORD_ALLOW_ALL = previousAllowAll;
    }
  });
});
