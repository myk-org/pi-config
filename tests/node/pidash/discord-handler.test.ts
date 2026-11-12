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
import { after, describe, it } from "node:test";

import { setupDiscordBot } from "../../../extensions/pidash/discord-bot.ts";

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
      session: { sessionId, active: true },
      ws: { send: (raw: string) => sends.push(JSON.parse(raw)) },
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
  return { handler: built[built.length - 1]!.listeners("messageCreate")[0] as (m: any) => Promise<void>, sends, hooks };
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

  it("refuses to answer in a channel two sessions deliver into", async () => {
    // No session can be named for this channel, so answering "the newest question" would approve one
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
});
