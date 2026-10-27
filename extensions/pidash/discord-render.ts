/**
 * Discord-facing entry for pi events -> chat messages is platform-neutral; see extensions/shared/chat/chat-events.ts.
 *
 * Kept as a thin re-export so the bot, its tests and the npm `extensions/pidash/*.ts`
 * glob keep working while the implementation lives in the shared chat layer.
 */

export * from "../shared/chat/chat-events.ts";
