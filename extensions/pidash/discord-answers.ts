/**
 * Discord-facing entry for Prompt lifecycle and answer mapping are platform-neutral; see extensions/shared/chat/chat-prompts.ts.
 *
 * Kept as a thin re-export so the bot, its tests and the npm `extensions/pidash/*.ts`
 * glob keep working while the implementation lives in the shared chat layer.
 */

export * from "../shared/chat/chat-prompts.ts";
