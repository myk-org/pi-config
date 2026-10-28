/**
 * Discord bot configuration resolution — pure, so startup is testable.
 *
 * `setupDiscordBot` used to read env, decide authorization and build the client
 * inline, which left the whole startup path uncovered (Qodo 5e9bc957). The
 * decisions live here; the wiring stays in discord-bot.ts.
 */

import { createLogger } from "../shared/logger.ts";

const log = createLogger("pidash-discord-config");

export interface DiscordConfig {
  token: string;
  allowedUsers: Set<string>;
  allowAll: boolean;
  promptTtlMs: number;
  /** Forum channel used as the session board; null disables `/board`. */
  forumChannelId: string | null;
  stateFile: string;
  envFile: string;
}

export type ConfigResult =
  | { ok: true; config: DiscordConfig }
  | { ok: false; reason: string };

function expandHome(value: string, home: string | undefined): string {
  if (!value.startsWith("~")) return value;
  if (!home) return value;
  return `${home}${value.slice(1)}`;
}

/**
 * Resolve configuration from the environment.
 *
 * Fails closed: a token without an allowlist is a refusal, not open access —
 * a token alone used to mean "anyone who can DM the bot drives your agent".
 */
export function resolveDiscordConfig(
  env: Record<string, string | undefined>,
  home: string | undefined = env.HOME,
): ConfigResult {
  const token = (env.DISCORD_BOT_TOKEN || "").trim();
  if (!token) return { ok: false, reason: "no DISCORD_BOT_TOKEN" };
  if (!home) return { ok: false, reason: "HOME not set" };

  const allowedUsers = new Set(
    (env.DISCORD_ALLOWED_USERS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const allowAll = env.DISCORD_ALLOW_ALL === "true";
  if (allowedUsers.size === 0 && !allowAll) {
    return {
      ok: false,
      reason: "DISCORD_ALLOWED_USERS is empty — refusing to start (set DISCORD_ALLOW_ALL=true to allow every user)",
    };
  }

  const ttl = Number(env.DISCORD_PROMPT_TTL_MS);
  const promptTtlMs = Number.isFinite(ttl) && ttl > 0
    ? Math.max(30_000, Math.min(ttl, 24 * 60 * 60 * 1000))
    : 10 * 60 * 1000;

  const config: DiscordConfig = {
    token,
    allowedUsers,
    allowAll,
    // Forum channel used as the session board (one thread per session).
    forumChannelId: (env.DISCORD_FORUM_CHANNEL_ID || "").trim() || null,
    promptTtlMs,
    stateFile: expandHome(env.PIDASH_DISCORD_STATE_FILE || "~/.pi/discord-state.json", home),
    envFile: expandHome(env.PIDASH_DISCORD_ENV_FILE || "~/.pi/discord.env", home),
  };
  log.debug("discord config resolved", {
    allowAll, allowed: allowedUsers.size, promptTtlMs, stateFile: config.stateFile,
  });
  return { ok: true, config };
}

/** Parse a key=value credentials file body. */
export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}
