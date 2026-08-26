import { createLogger } from "./create-logger.ts";
import type { DiffMode } from "../types.ts";

const log = createLogger("pidiff-ui");

export type RequestDiffsMessage = {
  type: "request-diffs";
  mode: DiffMode;
  fromRef?: string;
  toRef?: string;
};

/** WS payload for in-place Refresh. Commits mode keeps the selected refs. */
export function buildRequestDiffsMessage(
  mode: DiffMode,
  commitFrom: string,
  commitTo: string,
): RequestDiffsMessage {
  if (mode === "commits" && commitFrom && commitTo) {
    const msg: RequestDiffsMessage = { type: "request-diffs", mode, fromRef: commitFrom, toRef: commitTo };
    log.debug("request-diffs", { mode, fromRef: commitFrom, toRef: commitTo });
    return msg;
  }
  const msg: RequestDiffsMessage = { type: "request-diffs", mode };
  log.debug("request-diffs", { mode });
  return msg;
}

/** True when Refresh can send a request-diffs payload. */
export function shouldBeginRefresh(connected: boolean, refreshing: boolean): boolean {
  const ok = connected && !refreshing;
  log.debug("shouldBeginRefresh", { connected, refreshing, ok });
  return ok;
}

/** Refresh keeps the current tree/panes; only the button is busy. */
export function refreshButtonState(
  refreshing: boolean,
  connected = true,
): { disabled: boolean; spinning: boolean; unmountBody: boolean } {
  const disabled = refreshing || !connected;
  log.debug("refreshButtonState", { refreshing, connected, disabled });
  return { disabled, spinning: refreshing, unmountBody: false };
}

/** Commits-mode refresh uses the on-screen comparison, not leftover picker state. */
export function commitRefsForRefresh(
  mode: DiffMode,
  displayedFrom: string | undefined,
  displayedTo: string | undefined,
  selectedFrom: string,
  selectedTo: string,
): { from: string; to: string } {
  if (mode !== "commits") {
    log.debug("commitRefsForRefresh skipped", { mode });
    return { from: "", to: "" };
  }
  const from = displayedFrom || selectedFrom;
  const to = displayedTo || selectedTo;
  log.debug("commitRefsForRefresh", { from, to });
  return { from, to };
}

/** App requestDiffs: skip when disconnected or already refreshing, then send. */
export function runAppRefresh(
  connected: boolean,
  refreshing: boolean,
  send: (msg: object) => unknown,
  mode: DiffMode,
  displayedFrom: string | undefined,
  displayedTo: string | undefined,
  selectedFrom: string,
  selectedTo: string,
): { skipped: boolean; sent: boolean } {
  log.debug("runAppRefresh", { connected, refreshing, mode });
  if (!shouldBeginRefresh(connected, refreshing)) {
    log.debug("runAppRefresh skipped", { connected, refreshing });
    return { skipped: true, sent: false };
  }
  const refs = commitRefsForRefresh(mode, displayedFrom, displayedTo, selectedFrom, selectedTo);
  const sent = Boolean(send(buildRequestDiffsMessage(mode, refs.from, refs.to)));
  if (!sent) log.error("runAppRefresh dropped", { connected });
  return { skipped: false, sent };
}

/** True only when the refresh payload reached the socket. */
export function beginRefreshUi(result: { skipped: boolean; sent: boolean }): boolean {
  const ok = result.sent && !result.skipped;
  log.debug("beginRefreshUi", { ...result, ok });
  return ok;
}
