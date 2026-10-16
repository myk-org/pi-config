/**
 * Cross-peer message history (#924 §5): a local JSONL audit trail of coms
 * traffic — outbound prompts, inbound prompts (incl. steers), and responses
 * in both directions — queryable via the coms_history tool.
 *
 * Append-only and fail-soft: a history failure is logged and swallowed and
 * must never break message delivery. Previews are flattened and capped, so
 * the trail stays small; full prompts remain in the session transcript.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../shared/logger.js";

const log = createLogger("coms-history");

export type HistoryDirection = "out" | "in" | "steer" | "response_out" | "response_in";

export interface HistoryRecord {
	ts: string;
	msg_id: string;
	/** out = prompt we sent; in = prompt we received; steer = mid-turn steer we received;
	 *  response_out = reply we sent; response_in = reply we received. */
	direction: HistoryDirection;
	peer: string;
	session?: string;
	preview: string;
	status?: string;
	error?: string | null;
}

export interface HistoryFilter {
	peer?: string;
	direction?: HistoryDirection;
	msg_id?: string;
	limit?: number;
}

/** Preview cap — flattened whitespace, hard-truncated with an ellipsis. */
export const HISTORY_PREVIEW_MAX = 120;
/** Query result cap — newest-last window over the matching records. */
export const HISTORY_LIMIT_MAX = 500;

export function truncatePreview(text: string, max: number = HISTORY_PREVIEW_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Append one record. Fail-soft by contract — delivery never waits on history. */
export function appendHistoryRecord(filePath: string, record: HistoryRecord): boolean {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
		return true;
	} catch (error) {
		log.warn(`history append failed (swallowed): ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

/** Query the trail. Malformed lines are skipped; missing file is empty. */
export function queryHistoryRecords(filePath: string, filter: HistoryFilter = {}): HistoryRecord[] {
	const limit = Math.max(1, Math.min(filter.limit ?? 50, HISTORY_LIMIT_MAX));
	let lines: string[];
	try {
		if (!existsSync(filePath)) return [];
		lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
	} catch (error) {
		log.warn(`history read failed (swallowed): ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	const records: HistoryRecord[] = [];
	for (const line of lines) {
		try {
			records.push(JSON.parse(line) as HistoryRecord);
		} catch {
			// skip malformed line — history is best-effort
		}
	}
	const filtered = records.filter(
		(r) =>
			(!filter.peer || r.peer === filter.peer) &&
			(!filter.direction || r.direction === filter.direction) &&
			(!filter.msg_id || r.msg_id === filter.msg_id),
	);
	return filtered.slice(-limit);
}
