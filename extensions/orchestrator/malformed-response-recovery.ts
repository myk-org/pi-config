/**
 * Bounded auto-recovery when a provider terminates a turn with a malformed
 * response stop reason (issue #1333).
 *
 * Some providers (e.g. Gemini) intermittently abort an assistant turn with
 * `stopReason: "error"` and `rawStopReason`/`errorMessage` containing
 * `MALFORMED_RESPONSE`, `MALFORMED_FUNCTION_CALL`, or `UNEXPECTED_TOOL_CALL`.
 * This handler sends a hidden follow-up system note so the turn continues
 * cleanly without user intervention, capped at MAX_CONSECUTIVE_MALFORMED_RETRIES.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { sendSystemNote } from "../shared/system-note.js";

const log = createLogger("malformed-response-recovery");

export const MAX_CONSECUTIVE_MALFORMED_RETRIES = 2;

export const RECOVERABLE_MALFORMED_REASONS = new Set([
  "MALFORMED_RESPONSE",
  "MALFORMED_FUNCTION_CALL",
  "UNEXPECTED_TOOL_CALL",
]);

const MALFORMED_REASON_RE = /\b(MALFORMED_RESPONSE|MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL)\b/i;

function findLastTurnAssistantMessage(messages: readonly any[] | undefined): any | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "user") return null;
    if (msg.role === "assistant") return msg;
  }
  return null;
}

export function detectMalformedStopReason(messages: readonly any[] | undefined): string | null {
  const msg = findLastTurnAssistantMessage(messages);
  if (!msg || msg.stopReason !== "error") return null;

  if (typeof msg.rawStopReason === "string") {
    const normalized = msg.rawStopReason.trim().toUpperCase();
    if (RECOVERABLE_MALFORMED_REASONS.has(normalized)) return normalized;
  }

  if (typeof msg.errorMessage === "string") {
    const match = msg.errorMessage.match(MALFORMED_REASON_RE);
    if (match) return match[1].toUpperCase();
  }

  return null;
}

export function registerMalformedResponseRecovery(
  pi: ExtensionAPI,
  opts?: { maxRetries?: number },
): void {
  const maxRetries = opts?.maxRetries ?? MAX_CONSECUTIVE_MALFORMED_RETRIES;
  let consecutiveRetries = 0;
  let shuttingDown = false;
  const handledMessages = new WeakSet<object>();

  pi.on("session_start", () => {
    consecutiveRetries = 0;
    shuttingDown = false;
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
  });

  pi.on("input", (event) => {
    if ((event as any)?.source !== "extension") {
      consecutiveRetries = 0;
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (shuttingDown) return;

    const messages = (event as any)?.messages;
    const lastAssistant = findLastTurnAssistantMessage(messages);
    if (lastAssistant && handledMessages.has(lastAssistant)) return;

    const reason = detectMalformedStopReason(messages);
    if (!reason) {
      consecutiveRetries = 0;
      return;
    }

    handledMessages.add(lastAssistant);

    if (consecutiveRetries >= maxRetries) {
      log.warn("malformed_response_retry_exhausted", {
        reason,
        attempts: consecutiveRetries,
        maxRetries,
      });
      if (isLiveExtensionCtx(ctx) && ctx?.hasUI) {
        try {
          ctx.ui.notify(
            `Provider returned ${reason} ${maxRetries + 1} times — stopping auto-retry.`,
            "warning",
          );
        } catch {}
      }
      return;
    }

    consecutiveRetries += 1;
    log.warn("malformed_response_auto_retry", {
      reason,
      attempt: consecutiveRetries,
      maxRetries,
    });

    if (isLiveExtensionCtx(ctx) && ctx?.hasUI) {
      try {
        ctx.ui.notify(
          `Provider returned ${reason} — auto-continuing (${consecutiveRetries}/${maxRetries})…`,
          "warning",
        );
      } catch {}
    }

    try {
      await sendSystemNote(
        pi,
        `The previous model response terminated with provider error (${reason}) and was discarded. Continue cleanly from the last completed step without repeating earlier output or fabricating turns.`,
        {
          customType: "malformed-response-recovery",
          triggerTurn: true,
          deliverAs: "followUp",
          display: false,
        },
      );
    } catch (err) {
      log.error("malformed_response_retry_send_failed", {
        reason,
        attempt: consecutiveRetries,
        error: String(err),
      });
    }
  });
}
