/**
 * Forum board planning.
 *
 * Pure: given the active sessions and the threads that already exist, decide
 * which posts to create and what the picker offers. The Discord calls around it
 * are plumbing; this is the part that can be wrong in a way tests can catch
 * (duplicated posts, a picker that points at nothing).
 */
import { createLogger } from "../shared/logger.ts";

const log = createLogger("pidash-discord-board");

export interface BoardSession {
  sessionId: string;
  label: string;
}

export interface BoardPlan {
  /** Sessions with no post yet, in input order. */
  toCreate: BoardSession[];
  /** Picker options (capped to Discord's 25); `value` indexes `sessionIds`. */
  options: Array<{ label: string; value: string }>;
  /** Full session ids, in option order — never truncated. */
  sessionIds: string[];
  total: number;
  existing: number;
}

export const BOARD_SELECT_LIMIT = 25;
const LABEL_LIMIT = 90;

export function boardLabel(label: string, limit = LABEL_LIMIT): string {
  const text = label.trim() || "session";
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * @param sessions active sessions
 * @param existingBySession sessionId -> thread id for posts already on the board
 */
export function planBoard(
  sessions: BoardSession[],
  existingBySession: Record<string, string>,
  limit = BOARD_SELECT_LIMIT,
): BoardPlan {
  const seen = new Set<string>();
  const unique: BoardSession[] = [];
  for (const session of sessions) {
    if (!session.sessionId || seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    unique.push(session);
  }
  const toCreate = unique.filter((session) => !existingBySession[session.sessionId]);
  const shown = unique.slice(0, limit);
  const options = shown.map((session, index) => ({
    label: boardLabel(session.label),
    // Discord caps option values at 100 chars and session ids embed a checkout
    // path, so the id cannot travel in the value: it is an index into
    // `sessionIds`, resolved server-side (Qodo 25d79e3b).
    value: String(index),
  }));
  log.debug("board planned", {
    sessions: unique.length,
    existing: Object.keys(existingBySession).length,
    toCreate: toCreate.length,
    options: options.length,
  });
  return {
    toCreate,
    options,
    sessionIds: shown.map((session) => session.sessionId),
    total: unique.length,
    existing: Object.keys(existingBySession).length,
  };
}
