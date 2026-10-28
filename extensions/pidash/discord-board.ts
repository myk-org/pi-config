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
  /** Picker options for every session (capped to Discord's 25). */
  options: Array<{ label: string; value: string }>;
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
  const options = unique.slice(0, limit).map((session) => ({
    label: boardLabel(session.label),
    // Discord caps option values at 100 chars; session ids are short enough, and
    // the picker resolves them against live sessions anyway.
    value: session.sessionId.slice(0, 100),
  }));
  log.debug("board planned", {
    sessions: unique.length,
    existing: Object.keys(existingBySession).length,
    toCreate: toCreate.length,
    options: options.length,
  });
  return { toCreate, options, total: unique.length, existing: Object.keys(existingBySession).length };
}
