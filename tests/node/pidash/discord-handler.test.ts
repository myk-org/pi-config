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
  guilds = { cache: new Map() };
  /** Only the DM and the plain guild channel exist; anything else is a channel the bot cannot see. */
  channels = {
    fetch: async (id: string) => {
      if (id === DM) return { id, guildId: null };
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

interface Sent { sessionId: string; type: string; command?: string; id?: string; cancelled?: boolean }

interface Bot {
  handler: (m: any) => Promise<void>;
  interaction: (i: any) => Promise<void>;
  sends: Sent[];
  /** pi -> bot events, as the daemon feeds them. */
  hooks: Array<(sessionId: string, event: any) => void>;
}

/** A bot whose user watches `watchedSessionId` and owns thread chan-3 for s3; `live` decides what is connected. */
function startBot(opts: {
  live: string[];
  watchedSessionId?: string | null;
  threads?: Record<string, string>;
  responseChannelId?: string;
  dmChannelId?: string | null;
  /** More users in the same guild channel — a shared fallback channel is a real case. */
  extraUsers?: string[];
}): Bot {
  const users: Record<string, unknown> = {
    [USER]: {
      watchedSessionId: opts.watchedSessionId === undefined ? "s2" : opts.watchedSessionId,
      responseChannelId: opts.responseChannelId ?? DM,
      dmChannelId: opts.dmChannelId === undefined ? DM : opts.dmChannelId,
      threads: opts.threads ?? { s3: THREAD },
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
  fs.writeFileSync(stateFile, JSON.stringify({ users }));
  const sends: Sent[] = [];
  const piClients = new Map<string, any>();
  for (const sessionId of opts.live) {
    piClients.set(sessionId, {
      session: { sessionId, active: true, cwd: "/work", supportsImages: true },
      ws: { send: (raw: string) => sends.push({ sessionId, ...JSON.parse(raw) }) },
      replaying: false,
    });
  }
  const hooks: Array<(sessionId: string, event: any) => void> = [];
  const before = built.length;
  setupDiscordBot({
    piClients,
    piEventHooks: hooks,
    getActiveSessions: () => [...piClients.values()].map((client) => client.session),
    log: () => {},
  });
  assert.equal(built.length, before + 1, "setupDiscordBot built no client");
  return {
    handler: built[built.length - 1]!.listeners("messageCreate")[0] as (m: any) => Promise<void>,
    interaction: built[built.length - 1]!.listeners("interactionCreate")[0] as (i: any) => Promise<void>,
    sends,
    hooks,
  };
}

function message(id: string, content: string, replies: string[], opts: { dm?: boolean; channelId?: string; author?: string } = {}): any {
  return {
    id,
    guildId: opts.dm ? null : "g1",
    channelId: opts.dm ? DM : opts.channelId ?? THREAD,
    content,
    author: { id: opts.author ?? USER, bot: false },
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
    user: { id: USER, username: "tester" },
    channelId: opts.channelId ?? PLAIN,
    guildId: "g1",
    isMessageContextMenuCommand: () => true,
    targetMessage: { content: "look at this", attachments: new Map() },
    reply: async (payload: any) => { replies.push(String(payload?.content ?? "")); },
  };
}

describe("discord messageCreate routing", () => {
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

  it("logs a message dropped in a channel the user does not own, once per channel", async () => {
    // The refusal the owner reproduced had no log line at all; a silent drop is undiagnosable. It is
    // routine traffic though, so it logs at INFO and is throttled: every message in every channel the
    // bot can see reaches this handler.
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
      // One line for the pair: the same channel, reason and author inside the window is suppressed.
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

  it("logs the /stop and /cancel refusals", async () => {
    (globalThis as any).__piConfigSessionId = "inbound-route-refusal-log-test";
    pinLevel("info");
    try {
      const bot = startBot({ live: [], watchedSessionId: null, threads: {}, dmChannelId: DM });
      const replies: string[] = [];
      await bot.handler(message("m14", "/stop", replies, { dm: true }));
      await bot.handler(message("m15", "/cancel", replies, { dm: true }));
      assert.deepEqual(replies, ["Not watching any session. Use `/sessions` and pick one.", "Nothing pending."]);

      const body = readLogs();
      assert.match(body, /\{"reason":"stop-no-target"/);
      assert.match(body, /\{"reason":"cancel-nothing-pending"/);
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

  it("a context menu still refuses a channel nothing is watching or delivering into", async () => {
    const bot = startBot({ live: ["s9"], watchedSessionId: null, threads: {} });
    const replies: string[] = [];
    await bot.interaction(contextMenu(replies, { channelId: PLAIN }));
    assert.deepEqual(bot.sends, []);
    assert.deepEqual(replies, ["Not watching any session. Use `/sessions` first."]);
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
});
