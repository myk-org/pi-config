/**
 * Discord-facing entry for Attachment policy is platform-neutral; the caps below are Discord defaults a future client can override.
 *
 * Kept as a thin re-export so the bot, its tests and the npm `extensions/pidash/*.ts`
 * glob keep working while the implementation lives in the shared chat layer.
 */

export * from "../shared/chat/chat-attachments.ts";
