/**
 * Process-local flag for whether P2P coms is active in this session.
 * Kept in shared/ to avoid circular imports between orchestrator/rules and coms.
 */

import { createLogger } from "./logger.js";

const log = createLogger("coms-active");

let active = false;

export function setComsActive(v: boolean): void {
  if (active === v) {
    log.debug("setComsActive no-op", `already ${v}`);
    return;
  }
  active = v;
  log.info("coms active", String(v));
}

export function isComsActive(): boolean {
  return active;
}
