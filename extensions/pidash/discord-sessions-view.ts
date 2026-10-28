/**
 * Discord-facing entry for Session identity, labelling and paging; the row math is Discord-shaped.
 *
 * Kept as a thin re-export so the bot, its tests and the npm `extensions/pidash/*.ts`
 * glob keep working while the implementation lives in the shared chat layer.
 */

export * from "../shared/chat/chat-sessions.ts";
