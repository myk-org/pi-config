/**
 * extensions/coms/mixed-turn.ts — Pure helpers for coms mixed-turn detection.
 * Kept dependency-free so both the coms extension handlers and unit tests can
 * import the SAME production logic (no mirrored copies). The shared logger is
 * dependency-light (node builtins only via file-logger) so importing it here
 * does not pull in pi-tui and keeps the module test-importable — the same
 * pattern used by extensions/pitasks/reminders.ts.
 */

import { createLogger } from "../shared/logger.js";

const log = createLogger("coms-mixed-turn");

/** True when a real user message (role "user") arrives while a coms inbound turn is being processed (#741). */
export function isUserMessageDuringInbound(processingInbound: boolean, role: string | undefined): boolean {
	const result = processingInbound === true && role === "user";
	log.debug("isUserMessageDuringInbound", processingInbound, role, result);
	return result;
}

/** True when the turn must be handled as a mixed turn (re-inject the inbound instead of auto-capturing assistant text). */
export function computeMixedTurn(inboundSetDuringUserTurn: boolean, userMessageDuringInbound: boolean): boolean {
	const result = inboundSetDuringUserTurn || userMessageDuringInbound;
	log.debug("computeMixedTurn", inboundSetDuringUserTurn, userMessageDuringInbound, result);
	return result;
}
