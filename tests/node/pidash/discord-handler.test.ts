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

const built: FakeClient[] = [];

class FakeClient extends EventEmitter {
  user = { id: "bot-user" };
  guilds = { cache: new Map() };
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

interface Sent { sessionId: string; type: string; command?: string }

/** A bot whose user watches s2 and owns thread chan-3 for s3; `live` decides which sessions are connected. */
function startBot(live: string[]): { handler: (m: any) => Promise<void>; sends: Sent[] } {
  fs.writeFileSync(stateFile, JSON.stringify({
    users: {
      [USER]: {
        watchedSessionId: "s2",
        responseChannelId: "dm-1",
        threads: { s3: THREAD },
        updatedAt: Date.now(),
      },
    },
  }));
  const sends: Sent[] = [];
  const piClients = new Map<string, any>();
  for (const sessionId of live) {
    piClients.set(sessionId, {
      session: { sessionId, active: true },
      ws: { send: (raw: string) => sends.push(JSON.parse(raw)) },
      replaying: false,
    });
  }
  const before = built.length;
  setupDiscordBot({
    piClients,
    piEventHooks: [],
    getActiveSessions: () => [...piClients.values()].map((client) => client.session),
    log: () => {},
  });
  const client = built[built.length - 1];
  assert.equal(built.length, before + 1, "setupDiscordBot built no client");
  return { handler: client!.listeners("messageCreate")[0] as (m: any) => Promise<void>, sends };
}

function message(id: string, content: string, replies: string[]): any {
  return {
    id,
    guildId: "g1",
    channelId: THREAD,
    content,
    author: { id: USER, bot: false },
    reply: async (text: string) => { replies.push(text); },
  };
}

describe("discord messageCreate routing", () => {
  after(() => {
    process.env = savedEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("/stop reaches the thread's session, not the watched one", async () => {
    const bot = startBot(["s2", "s3"]);
    const replies: string[] = [];
    await bot.handler(message("m1", "/stop", replies));
    assert.deepEqual(bot.sends.map((s) => [s.sessionId, s.command]), [["s3", "abort"]]);
    assert.deepEqual(replies, ["⏹️ Stop sent."]);
  });

  it("refuses a dead thread instead of spilling into the watched session", async () => {
    const bot = startBot(["s2"]);
    const replies: string[] = [];
    await bot.handler(message("m2", "hello", replies));
    assert.deepEqual(bot.sends, []);
    assert.deepEqual(replies, ["That thread's session is not connected."]);
  });
});
