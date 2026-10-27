/**
 * Discord-facing entry for Per-user watch state and persistence; see extensions/shared/chat/chat-state.ts.
 *
 * Kept as a thin re-export so the bot, its tests and the npm `extensions/pidash/*.ts`
 * glob keep working while the implementation lives in the shared chat layer.
 */

export * from "../shared/chat/chat-state.ts";
