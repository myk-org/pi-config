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
