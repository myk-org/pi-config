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
    log.info("request-diffs", { mode, fromRef: commitFrom, toRef: commitTo });
    return msg;
  }
  const msg: RequestDiffsMessage = { type: "request-diffs", mode };
  log.info("request-diffs", { mode });
  return msg;
}

/** Refresh keeps the current tree/panes; only the button is busy. */
export function refreshButtonState(refreshing: boolean): { disabled: boolean; spinning: boolean; unmountBody: boolean } {
  log.debug("refreshButtonState", { refreshing });
  return { disabled: refreshing, spinning: refreshing, unmountBody: false };
}
