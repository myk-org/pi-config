/**
 * Provenance-marked injections for content the user did NOT write.
 *
 * The transcript gives an extension no room to say "this is not the user's words":
 * `pi.sendMessage` renders as `role: "custom"` and `pi.sendUserMessage` renders as a
 * user turn, so machine text arrives looking exactly like something the user typed.
 * A model reading it will answer "as you said" and attribute its own guard rails to the
 * user (issue #1016 review, where a REJECTED call looked like a user message).
 *
 * Every message this module sends starts with MARKER, which is self-explanatory on
 * purpose: no rule has to teach the model what it means.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "./logger.js";

const log = createLogger("system-note");

/** Prefix that identifies machine-generated text in the transcript. */
export const SYSTEM_NOTE_MARKER = "[system message — not written by the user]";

export interface SystemNoteOptions {
  /** Stable kind for renderers/filters, e.g. "subagent-taskid-error". */
  customType: string;
  /** Start a turn from this message when the session is idle. */
  triggerTurn?: boolean;
  /** Delivery slot for a busy session. */
  deliverAs?: "steer" | "followUp" | "nextTurn";
  /** Render in the TUI transcript. */
  display?: boolean;
}

/** Send machine-generated text, marked so it cannot be mistaken for user input. */
export async function sendSystemNote(
  pi: ExtensionAPI,
  text: string,
  options: SystemNoteOptions,
): Promise<void> {
  const body = text.startsWith(SYSTEM_NOTE_MARKER) ? text : `${SYSTEM_NOTE_MARKER}\n${text}`;
  log.debug("send_system_note", { customType: options.customType, chars: body.length });
  await pi.sendMessage(
    { customType: options.customType, content: body, display: options.display ?? true },
    { triggerTurn: options.triggerTurn, deliverAs: options.deliverAs },
  );
}
