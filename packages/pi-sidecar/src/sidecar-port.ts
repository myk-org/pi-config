/**
 * Listen-port env so nested CLI agents can detect sidecar (no TTY).
 * startSidecar() always writes SIDECAR_PORT, including default 9100 and
 * programmatic options.port launches that never inherited the env var.
 */

import { createLogger } from "./logger.js";

const log = createLogger("sidecar-port");

export function resolveSidecarListenPort(
  optionsPort?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof optionsPort === "number" && Number.isFinite(optionsPort) && optionsPort > 0) {
    log.debug(`resolveSidecarListenPort from options.port=${optionsPort}`);
    return optionsPort;
  }
  const parsed = parseInt(env.SIDECAR_PORT || "9100", 10);
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : 9100;
  log.debug(`resolveSidecarListenPort from env/default=${port}`);
  return port;
}

/** Stamp SIDECAR_PORT so Cursor --approve-mcps sidecar detection cannot miss. */
export function ensureSidecarPortEnv(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.SIDECAR_PORT = String(port);
  log.debug(`ensureSidecarPortEnv SIDECAR_PORT=${env.SIDECAR_PORT}`);
}
