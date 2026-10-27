/**
 * Turning a chat reply into the answer a bridged prompt expects.
 *
 * Platform-neutral: Discord, Telegram, Signal or a console all produce the same
 * `ChatInboundMessage.text`.
 *
 * This is the bug the old bot shipped: it forwarded the raw text as `value`,
 * while `../ui-bridge.ts` accepts a confirm ONLY as the
 * `confirmed` boolean and a select ONLY as one of the offered option strings.
 * So a confirm — including every dangerous-command approval — was logged as
 * "bridged confirm answer malformed — ignored" and blocked the agent, and the
 * documented "reply with the number" flow was rejected the same way.
 *
 * The mapping lives here, pure and tested, so the accepted vocabulary is a
 * contract rather than a guess.
 */

import { createLogger } from "../logger.ts";

const log = createLogger("chat-prompts");

export type PromptMethod = "confirm" | "select" | "input";

export interface PendingPrompt {
  id: string;
  sessionId: string;
  method: PromptMethod;
  /** Offered options for select/confirm (confirm is always ["Yes", "No"]). */
  options: string[];
  createdAt: number;
}

/** A stale prompt must never swallow a later message. */
export const DEFAULT_PENDING_PROMPT_TTL_MS = 10 * 60 * 1000;

/** TTL from the environment, so operators can tune it without a rebuild. */
export function resolvePromptTtlMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.DISCORD_PROMPT_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PENDING_PROMPT_TTL_MS;
  return Math.max(30_000, Math.min(raw, 24 * 60 * 60 * 1000));
}

export function isPromptExpired(
  prompt: PendingPrompt,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_PENDING_PROMPT_TTL_MS,
): boolean {
  return now - prompt.createdAt > ttlMs;
}

export type AnswerResult =
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "value"; value: string }
  | { kind: "cancel" }
  | { kind: "reject"; reason: string };

const CANCEL_WORDS = new Set(["cancel", "/cancel", "abort", "nevermind", "never mind", "esc"]);
const YES_WORDS = new Set(["yes", "y", "true", "1", "approve", "approved", "ok", "okay", "allow", "confirm"]);
const NO_WORDS = new Set(["no", "n", "false", "2", "deny", "denied", "reject", "rejected", "block"]);

/**
 * Map a Discord reply onto the prompt it is answering.
 *
 * Returns `reject` when the reply cannot be an answer, so the caller can say so
 * instead of silently consuming the user's message.
 */
export function mapAnswer(prompt: PendingPrompt, raw: string): AnswerResult {
  const text = (raw || "").trim();
  if (!text) return { kind: "reject", reason: "empty" };

  const lower = text.toLowerCase();

  // Cancelling is always available, for every method: a prompt that cannot be
  // escaped from is a trap (the old code had no way out at all).
  if (CANCEL_WORDS.has(lower)) return { kind: "cancel" };

  if (prompt.method === "confirm") {
    if (YES_WORDS.has(lower)) return { kind: "confirm", confirmed: true };
    if (NO_WORDS.has(lower)) return { kind: "confirm", confirmed: false };
    return { kind: "reject", reason: "reply yes or no" };
  }

  if (prompt.method === "select") {
    const options = prompt.options || [];
    if (!options.length) return { kind: "value", value: text };

    // 1-based index, matching how the question is rendered.
    if (/^\d+$/.test(text)) {
      const idx = Number(text) - 1;
      if (idx >= 0 && idx < options.length) return { kind: "value", value: options[idx] };
      return { kind: "reject", reason: `pick 1-${options.length}` };
    }

    // Exact option, case-insensitive — what the old bot relied on by accident.
    const byLabel = options.find((option) => option.toLowerCase() === lower);
    if (byLabel !== undefined) return { kind: "value", value: byLabel };

    // Unique prefix ("app" for "Approve") is a kindness, not a guess: refuse
    // anything ambiguous rather than answering with a different option.
    const byPrefix = options.filter((option) => option.toLowerCase().startsWith(lower));
    if (byPrefix.length === 1) return { kind: "value", value: byPrefix[0] };
    if (byPrefix.length > 1) return { kind: "reject", reason: "ambiguous" };

    // ask_user's select prompts accept a custom answer (the TUI lets you type
    // one), so free text is a value rather than a mistake.
    return { kind: "value", value: text };
  }

  return { kind: "value", value: text };
}

/** The wire payload for `extension_ui_response`, shaped the way ui-bridge reads it. */
export function toBridgeResponse(
  prompt: PendingPrompt,
  answer: AnswerResult,
): Record<string, unknown> | null {
  if (answer.kind === "reject") return null;
  if (answer.kind === "cancel") {
    log.debug("prompt cancelled from discord", { id: prompt.id });
    return { type: "extension_ui_response", id: prompt.id, cancelled: true };
  }
  if (answer.kind === "confirm") {
    return { type: "extension_ui_response", id: prompt.id, confirmed: answer.confirmed };
  }
  return { type: "extension_ui_response", id: prompt.id, value: answer.value };
}

/** How the prompt is rendered, including the accepted vocabulary. */
export function renderPrompt(prompt: PendingPrompt, title: string): string {
  const lines = [`**${title}**`];
  if (prompt.method === "confirm") {
    lines.push("", "Reply **yes** or **no** (or use the platform buttons).", "_/cancel to dismiss_");
    return lines.join("\n");
  }
  if (prompt.method === "select") {
    const options = prompt.options || [];
    if (options.length) {
      lines.push("", ...options.map((option, i) => `**${i + 1}.** ${option}`));
      lines.push("", `Reply with a number 1-${options.length} or the option text.`, "_/cancel to dismiss_");
    } else {
      lines.push("", "Type your response.", "_/cancel to dismiss_");
    }
    return lines.join("\n");
  }
  lines.push("", "Type your response.", "_/cancel to dismiss_");
  return lines.join("\n");
}


/**
 * Whether this text plausibly answers the prompt.
 *
 * The caller uses it to decide between answering and forwarding the message as a
 * new prompt, so an unrelated message is never swallowed (Qodo 85cacb2c).
 */
export function isAnswerLike(prompt: PendingPrompt, raw: string): boolean {
  return mapAnswer(prompt, raw).kind !== "reject";
}
