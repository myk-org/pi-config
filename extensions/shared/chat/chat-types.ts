/**
 * Chat-client contract.
 *
 * The pidash surfaces are one bridge with several transports (Discord today;
 * Signal, Telegram, Slack, email tomorrow). Everything platform-neutral —
 * prompt lifecycle, answer mapping, chunking, event rendering, session
 * identity — lives in `extensions/shared/chat/`, and a client supplies only the
 * capabilities and the transport primitives below.
 *
 * To add a client:
 *   1. implement `ChatAdapter` for the platform
 *   2. call `createChatBridge({ adapter, ...host })`
 *   3. add whatever native UI it has (Discord buttons, Telegram inline
 *      keyboards, Signal reply buttons) — the answers they produce go through
 *      the same `mapAnswer`/`toBridgeResponse` pair, so ui-bridge sees one shape
 */

import type { Logger } from "../logger.ts";

/** What a platform can render. Everything else is derived from these. */
export interface ChatCapabilities {
  /** Hard limit for one message body. */
  maxMessageLength: number;
  /** Buttons in one action row; 0 when the platform has no buttons. */
  maxButtonsPerRow: number;
  /** Action rows per message; 0 when the platform has no rows. */
  maxActionRows: number;
  /** Can an existing message be edited (streaming)? */
  supportsEdit: boolean;
  /** Does the platform show a typing indicator? */
  supportsTyping: boolean;
  /** Can it open a per-session thread/subchannel? */
  supportsThreads: boolean;
  /** Are attachments inbound/outbound available? */
  supportsAttachments: boolean;
}

export const DEFAULT_CAPABILITIES: ChatCapabilities = {
  maxMessageLength: 2000,
  maxButtonsPerRow: 5,
  maxActionRows: 5,
  supportsEdit: true,
  supportsTyping: true,
  supportsThreads: false,
  supportsAttachments: true,
};

/** A place messages go: a DM, a thread, a channel. */
export interface ChatTarget {
  /** Platform channel/conversation id. */
  channelId: string;
  /** Set when the target is a per-session thread. */
  threadId?: string | null;
}

/** Transport primitives a client must provide. */
export interface ChatAdapter {
  readonly platform: string;
  readonly capabilities: ChatCapabilities;
  readonly log: Logger;
  /** Send text, chunked by the caller. Returns a message id when the platform has one. */
  sendText(target: ChatTarget, text: string): Promise<string | null>;
  /** Replace the body of a message we sent (streaming). */
  editText(target: ChatTarget, messageId: string, text: string): Promise<boolean>;
  /** Show/finish a typing indicator. */
  setTyping?(target: ChatTarget, active: boolean): Promise<void>;
  /** Create or reuse a per-session thread. */
  ensureThread?(target: ChatTarget, sessionId: string, label: string): Promise<string | null>;
}

/** One normalized inbound message, whatever the platform called it. */
export interface ChatInboundMessage {
  userId: string;
  channelId: string;
  threadId?: string | null;
  messageId: string;
  text: string;
  attachments?: Array<{
    url: string;
    filename?: string;
    contentType?: string;
    size?: number;
  }>;
  /** Platform-native reply hook for short acknowledgements. */
  reply(text: string): Promise<void>;
}
