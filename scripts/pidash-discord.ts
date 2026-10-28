/**
 * Discord bot for pidash.
 *
 * The implementation lives in `extensions/pidash/discord-bot.ts` (shipped by the
 * `extensions/pidash/*.ts` glob, next to the pure `discord-*.ts` modules and
 * their tests). This file stays as the daemon's entry point and the path the npm
 * package has always shipped, so existing installs and imports keep working.
 */

export { setupDiscordBot } from "../extensions/pidash/discord-bot.ts";
