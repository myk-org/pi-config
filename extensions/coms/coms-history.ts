/**
 * Cross-peer message history (#924 §5): a local JSONL audit trail of coms
 * traffic — outbound prompts, inbound prompts (incl. steers), and responses
 * in both directions — queryable via the coms_history tool.
 *
 * Append-only and fail-soft: a history failure is logged and swallowed and
 * must never break message delivery. Previews are flattened and capped, so
 * the trail stays small; full prompts remain in the session transcript.
 *
 * The file is machine-wide (all coms sessions on the host share it); each
 * record carries the appending session's id in `owner` so queries can scope
 * to one session's traffic by default (all_sessions opts into the full trail).
 * Size-rotation keeps the file bounded: past HISTORY_MAX_FILE_BYTES the
 * oldest lines are dropped to the last HISTORY_KEEP_BYTES of complete lines.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
	/** Appending session's coms session id — scopes queries on the shared file. */
	owner?: string;
	session?: string;
	preview: string;
	status?: string;
	error?: string | null;
}

export interface HistoryFilter {
	peer?: string;
	direction?: HistoryDirection;
	msg_id?: string;
	/** Inclusive lower bound (ISO timestamp): drop records older than this. */
	since?: string;
	/** Case-insensitive substring match on status. */
	status?: string;
	/** Exact owner-session match; omit to include every session's records. */
	owner?: string;
	limit?: number;
}

/** Preview cap — flattened whitespace, hard-truncated with an ellipsis. */
export const HISTORY_PREVIEW_MAX = 120;
/** Query result cap — newest-last window over the matching records. */
export const HISTORY_LIMIT_MAX = 500;
/** Rotation threshold — past this size the file is trimmed on the next append. */
export const HISTORY_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Post-rotation size — the newest complete lines up to roughly this size survive. */
export const HISTORY_KEEP_BYTES = 2 * 1024 * 1024;

export function truncatePreview(text: string, max: number = HISTORY_PREVIEW_MAX): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Shape check for parsed lines: JSON `null`/primitives/arrays are not records. */
function isHistoryRecord(value: unknown): value is HistoryRecord {
	return (
		typeof value === "object" && value !== null && !Array.isArray(value) &&
		typeof (value as HistoryRecord).msg_id === "string" &&
		typeof (value as HistoryRecord).ts === "string"
	);
}

/** Trim an over-large trail in place: keep the newest complete lines that fit
 *  HISTORY_KEEP_BYTES. Fail-soft — rotation failure never blocks the append. */
function rotateIfNeeded(filePath: string): void {
	try {
		if (!existsSync(filePath)) return;
		const size = statSync(filePath).size;
		if (size <= HISTORY_MAX_FILE_BYTES) return;
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n").filter(Boolean);
		const kept: string[] = [];
		let keptBytes = 0;
		for (let i = lines.length - 1; i >= 0; i--) {
			const lineBytes = Buffer.byteLength(lines[i]) + 1;
			if (keptBytes + lineBytes > HISTORY_KEEP_BYTES && kept.length > 0) break;
			kept.unshift(lines[i]);
			keptBytes += lineBytes;
		}
		writeFileSync(filePath, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
		log.info(`history rotated: ${size} bytes → ${keptBytes} bytes, ${lines.length - kept.length} old record(s) dropped`);
	} catch (error) {
		log.warn(`history rotation failed (swallowed): ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Synchronous sleep (Atomics.wait on a fresh SharedArrayBuffer). */
function syncSleepMs(ms: number): void {
	try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best-effort */ }
}

const HISTORY_LOCK_STALE_MS = 10_000;

/**
 * Cross-process mutual exclusion for history writes (#924 §5, Qodo ade011fc):
 * the file is shared by every coms session on the machine, and rotation is a
 * read-modify-write — an append landing between another process's read and
 * rewrite would be erased. mkdir is atomic, so a lock directory next to the
 * file serializes rotate+append across processes. Best-effort by contract:
 * bounded wait, stale locks (crashed holder) are stolen, and failure to
 * acquire falls back to a plain append — the worst case is a deferred
 * rotation, never a lost delivery.
 */
function withHistoryLock<T>(filePath: string, fn: (locked: boolean) => T): T {
	const lockDir = `${filePath}.lock`;
	const deadline = Date.now() + 200;
	for (;;) {
		try {
			mkdirSync(lockDir);
			try {
				return fn(true);
			} finally {
				try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
			}
		} catch (error: any) {
			if (error?.code !== "EEXIST") break;
			// Steal a stale lock left behind by a crashed holder.
			try {
				const lockAge = Date.now() - statSync(lockDir).mtimeMs;
				if (lockAge > HISTORY_LOCK_STALE_MS) {
					rmSync(lockDir, { recursive: true, force: true });
					log.warn("history lock stale — stolen");
					continue;
				}
			} catch { /* lock vanished — retry immediately */ }
			if (Date.now() >= deadline) break;
			syncSleepMs(10);
		}
	}
	// Lock unavailable — run unlocked. Rotation is skipped (the caller checks
	// the locked flag) so the read-modify-write race cannot recur; only the
	// rotation is deferred, never the append.
	return fn(false);
}

/** Append one record. Fail-soft by contract — delivery never waits on history. */
export function appendHistoryRecord(filePath: string, record: HistoryRecord): boolean {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		withHistoryLock(filePath, (locked) => {
			if (locked) rotateIfNeeded(filePath);
			appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
		});
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
			const parsed: unknown = JSON.parse(line);
			if (isHistoryRecord(parsed)) records.push(parsed);
		} catch {
			// skip malformed line — history is best-effort
		}
	}
	const filtered = records.filter(
		(r) =>
			(!filter.peer || r.peer === filter.peer) &&
			(!filter.direction || r.direction === filter.direction) &&
			(!filter.msg_id || r.msg_id === filter.msg_id) &&
			(!filter.since || r.ts >= filter.since) &&
			(!filter.status || (r.status ?? "").toLowerCase().includes(filter.status.toLowerCase())) &&
			(!filter.owner || r.owner === filter.owner),
	);
	return filtered.slice(-limit);
}
