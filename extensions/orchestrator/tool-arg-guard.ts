/**
 * Turn a rejected tool call back into a forced retry.
 *
 * Pi validates arguments BEFORE the lifecycle hooks: a call with invalid
 * arguments skips `tool_call` and `tool_result` entirely (docs: "An unknown
 * tool or invalid arguments skip `tool_call`"). Only `tool_execution_end`
 * fires, with the error result and no `durationMs` — so nothing in the
 * extension surface told the model its call never ran, and a turn could simply
 * end with the intended action silently not performed (passing `path` to
 * `bash`, or a `write` call with no `content`).
 *
 * This guard watches for exactly that shape and raises a system note with
 * `triggerTurn`, so the agent must retry instead of stopping.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { sendSystemNote } from "../shared/system-note.js";

const log = createLogger("tool-arg-guard");

/** Pi's own argument-rejection wording — not our policy blocks. */
const VALIDATION_FAILURE = /validation failed for tool|unknown tool/i;

/** Flatten a tool result into text without assuming one shape. */
export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((part: any) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (result && typeof result === "object") {
    const text = (result as any).text;
    if (typeof text === "string") return text;
    // pi's rejected-call result: { content: [{ type: "text", text }], details }
    if (Array.isArray((result as any).content)) return resultText((result as any).content);
    try {
      return JSON.stringify(result);
    } catch {
      return "";
    }
  }
  return "";
}

/** True only for pi's argument/unknown-tool rejection, never for a policy block.
 *  The "never ran" signal (absent durationMs) proved unreliable — bash rejections can
 *  carry it — so the wording is the contract: pi emits this text only when it rejected
 *  the call before execution, while policy blocks use their own message. */
export function isArgumentRejection(isError: boolean, text: string): boolean {
  return isError && VALIDATION_FAILURE.test(text);
}

export function registerToolArgGuard(pi: ExtensionAPI): void {
  pi.on("tool_execution_end", async (event: any) => {
    // durationMs is absent when the tool never executed.
    const text = resultText(event?.result).trim();
    if (!isArgumentRejection(Boolean(event?.isError), text)) return;

    log.warn("tool_call_rejected_before_run", {
      tool: event?.toolName,
      toolCallId: event?.toolCallId,
      // Diagnostic only: recorded, not used to decide.
      durationMs: event?.durationMs,
      detail: text.slice(0, 300),
    });
    await sendSystemNote(
      pi,
      `🚨 Your ${event?.toolName} call was REJECTED before it ran — the tool did NOT execute, so the action you intended did not happen:\n\n${text}\n\nRetry now with corrected arguments. A frequent cause is a wrong parameter name (e.g. sending "path" to bash instead of "command", or "write" with no "content").`,
      { customType: "tool-arg-rejected", triggerTurn: true, deliverAs: "followUp" },
    );
  });
}
