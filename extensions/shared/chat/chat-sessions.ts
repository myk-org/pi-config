/**
 * `/sessions` layout math.
 *
 * The action-row model is Discord's (five rows of five buttons). A platform
 * without rows uses `sessionLabel`/`filterSessionChoices` and ignores the rest.
 *
 * Discord allows at most FIVE action rows per message. The old code built up to
 * five rows of session buttons and then appended a "Disconnect" row, producing
 * six the moment there were more than 20 sessions — every async subagent counts
 * as one — and Discord rejected the whole message.
 *
 * Keeping the layout arithmetic here makes the limit a tested invariant instead
 * of a comment.
 */

import { createLogger } from "../logger.ts";
import { truncateLine } from "./chat-format.ts";

const log = createLogger("chat-sessions");

export const MAX_ACTION_ROWS = 5;
export const BUTTONS_PER_ROW = 5;
/** Four rows of sessions, one row left for navigation. */
export const SESSIONS_PER_PAGE = BUTTONS_PER_ROW * (MAX_ACTION_ROWS - 1);
/** The slash command option /watch uses, defined once for command and handler. */
export const WATCH_OPTION_NAME = "session";
/** Message content budget, minus room for the "…and N more" line. */
export const MAX_LIST_CHARS = 1900;

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  model?: string;
  branch?: string;
  active?: boolean;
  working?: boolean;
  name?: string;
  /** Set for async subagent sessions so they can be labelled. */
  agentType?: string;
}

export interface SessionPage {
  items: SessionSummary[];
  page: number;
  pages: number;
  total: number;
  /** Action rows this page will occupy, including the navigation row. */
  rows: number;
  /** Global index of the first item on this page (0-based), for numbering. */
  offset: number;
}

export function pageCount(total: number, pageSize = SESSIONS_PER_PAGE): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/** Clamp any incoming page number into range (1-based). */
export function clampPage(page: number, total: number, pageSize = SESSIONS_PER_PAGE): number {
  const pages = pageCount(total, pageSize);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.trunc(page)), pages);
}

export function buildSessionPage(
  sessions: SessionSummary[],
  page: number,
  pageSize = SESSIONS_PER_PAGE,
): SessionPage {
  const pages = pageCount(sessions.length, pageSize);
  const current = clampPage(page, sessions.length, pageSize);
  const start = (current - 1) * pageSize;
  const items = sessions.slice(start, start + pageSize);
  const sessionRows = Math.ceil(items.length / BUTTONS_PER_ROW);
  const needsNav = pages > 1;
  // Never exceed the platform limit, even with a nav row present.
  const rows = Math.min(MAX_ACTION_ROWS, sessionRows + (needsNav ? 1 : 0));
  return { items, page: current, pages, total: sessions.length, rows, offset: start };
}

/** The checkout a session runs in — the thing that identifies it on screen. */
export function checkoutName(session: SessionSummary): string {
  return session.cwd.split("/").pop() || session.cwd;
}

/**
 * Label for buttons and autocomplete: the CHECKOUT leads, because a session's
 * name is its first user message ("local run is running, watch it…") and tells
 * you nothing about which project it belongs to. The name follows as context.
 */
export function sessionLabel(session: SessionSummary): string {
  const checkout = checkoutName(session);
  const agent = session.agentType ? ` (${session.agentType})` : "";
  const name = session.name ? ` — ${session.name}` : "";
  return truncateLine(`${checkout}${agent}${name}`, 80);
}

export function sessionLine(session: SessionSummary, index: number, watched: boolean): string {
  const state = session.active ? (session.working ? "[active] " : "[idle] ") : "[idle] ";
  const checkout = checkoutName(session);
  const agent = session.agentType ? ` (${session.agentType})` : "";
  // The name is the session's first user message: useful, but second.
  const name = session.name ? ` — ${truncateLine(session.name, 44)}` : "";
  const model = session.model ? ` — ${session.model}` : "";
  const branch = session.branch ? ` (${session.branch})` : "";
  const marker = watched ? " **← watching**" : "";
  return `${state} **${index}.** 📁 **${checkout}**${agent}${name}${model}${branch}${marker}`;
}

/**
 * Bound a rendered list to Discord's message limit.
 *
 * A page of 20 sessions with long names, models and branches can pass 2000
 * characters even though it fits the row budget, and Discord rejects the entire
 * response when it does (Qodo 56dd47a3).
 */
export function boundListText(text: string, limit = MAX_LIST_CHARS): string {
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > limit - 40) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  log.debug("bounded session list", { dropped, limit });
  return `${kept.join("\n")}\n…and ${dropped} more — use /watch to jump by name.`;
}

/** The list body for one page; the numbering is global, not per page. */
export function renderSessionsPage(
  page: SessionPage,
  watchedSessionId: string | null,
): string {
  const lines = page.items.map((session, i) =>
    sessionLine(session, page.offset + i + 1, session.sessionId === watchedSessionId),
  );
  const header = page.pages > 1
    ? `**Sessions (${page.total}) — page ${page.page}/${page.pages}:**`
    : `**Sessions (${page.total}):**`;
  return boundListText([header, ...lines].join("\n"));
}

/**
 * Autocomplete choices for `/watch`.
 *
 * Discord delivers at most 25 choices and expects them already filtered by what
 * the user typed, so the matching rule is a pure function (and tested): a label
 * match beats a path match so `/watch pi` surfaces the pi-config sessions first.
 */
export interface AutocompleteChoice {
  name: string;
  value: string;
}

export function filterSessionChoices(
  sessions: SessionSummary[],
  query: string,
  limit = 25,
): AutocompleteChoice[] {
  const needle = query.trim().toLowerCase();
  const scored = sessions.map((session) => {
    const label = sessionLabel(session).toLowerCase();
    const path = session.cwd.toLowerCase();
    const score = !needle
      ? 2
      : label.startsWith(needle)
        ? 0
        : label.includes(needle)
          ? 1
          : path.includes(needle)
            ? 2
            : -1;
    return { session, score };
  });
  return scored
    .filter((entry) => entry.score >= 0)
    // Deterministic tie-break so the same query always yields the same order.
    .sort((a, b) => a.score - b.score || sessionLabel(a.session).localeCompare(sessionLabel(b.session)))
    .slice(0, limit)
    .map((entry) => ({
      name: truncateLine(sessionLabel(entry.session), 100),
      value: entry.session.sessionId,
    }));
}
