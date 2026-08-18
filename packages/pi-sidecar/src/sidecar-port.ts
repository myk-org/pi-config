/**
 * Listen-port env so nested CLI agents can detect sidecar (no TTY).
 * startSidecar() stamps SIDECAR_PORT while a sidecar is active (including
 * default 9100, programmatic options.port, and ephemeral 0). close() restores
 * the inherited value so later default binds and Cursor MCP gating do not leak.
 */

import { createLogger } from "./logger.js";

const log = createLogger("sidecar-port");

const DEFAULT_PORT = 9100;

type SidecarPortLease = { id: number; port: string };

type EnvPortState = {
  inherited: string | undefined;
  leases: SidecarPortLease[];
};

let nextLeaseId = 1;
const envPortState = new WeakMap<NodeJS.ProcessEnv, EnvPortState>();

const MAX_TCP_PORT = 65535;

function isValidListenPort(port: number): boolean {
  const valid = Number.isInteger(port) && port >= 0 && port <= MAX_TCP_PORT;
  log.debug(`isValidListenPort port=${port} valid=${valid}`);
  return valid;
}

function getEnvPortState(env: NodeJS.ProcessEnv): EnvPortState {
  let state = envPortState.get(env);
  if (!state) {
    state = { inherited: undefined, leases: [] };
    envPortState.set(env, state);
    log.debug("getEnvPortState created");
  } else {
    log.debug(`getEnvPortState existing leases=${state.leases.length}`);
  }
  return state;
}

/** Env SIDECAR_PORT from before any active stamp on this env object. */
function inheritedSidecarPort(env: NodeJS.ProcessEnv): string | undefined {
  const state = envPortState.get(env);
  if (state && state.leases.length > 0) {
    log.debug(`inheritedSidecarPort from captured leaseCount=${state.leases.length}`);
    return state.inherited;
  }
  log.debug(`inheritedSidecarPort from env set=${env.SIDECAR_PORT !== undefined}`);
  return env.SIDECAR_PORT;
}

function parsePositivePort(raw: string | undefined): number {
  const parsed = parseInt(raw || String(DEFAULT_PORT), 10);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TCP_PORT
    ? parsed
    : DEFAULT_PORT;
  log.debug(`parsePositivePort rawSet=${raw !== undefined} port=${port}`);
  return port;
}

export function resolveSidecarListenPort(
  optionsPort?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof optionsPort === "number" && isValidListenPort(optionsPort)) {
    log.debug(`resolveSidecarListenPort from options.port=${optionsPort}`);
    return optionsPort;
  }
  const port = parsePositivePort(inheritedSidecarPort(env));
  log.debug(`resolveSidecarListenPort from env/default=${port}`);
  return port;
}

/**
 * Stamp SIDECAR_PORT so Cursor --approve-mcps sidecar detection cannot miss.
 * Returns a disposer that restores the inherited value when this sidecar (and
 * any concurrent ones sharing the env) have closed.
 */
export function ensureSidecarPortEnv(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const state = getEnvPortState(env);
  if (state.leases.length === 0) {
    state.inherited = env.SIDECAR_PORT;
  }
  const lease: SidecarPortLease = { id: nextLeaseId++, port: String(port) };
  state.leases.push(lease);
  env.SIDECAR_PORT = lease.port;
  log.debug(
    `ensureSidecarPortEnv stamp SIDECAR_PORT=${lease.port} leases=${state.leases.length}`,
  );

  let released = false;
  return function releaseSidecarPortEnv(): void {
    if (released) {
      log.debug(`releaseSidecarPortEnv already released id=${lease.id}`);
      return;
    }
    released = true;
    const idx = state.leases.findIndex((item) => item.id === lease.id);
    if (idx < 0) {
      log.debug(`releaseSidecarPortEnv missing lease id=${lease.id}`);
      return;
    }
    state.leases.splice(idx, 1);
    if (state.leases.length === 0) {
      if (state.inherited === undefined) {
        delete env.SIDECAR_PORT;
      } else {
        env.SIDECAR_PORT = state.inherited;
      }
      log.debug("releaseSidecarPortEnv restored inherited SIDECAR_PORT");
      return;
    }
    env.SIDECAR_PORT = state.leases[state.leases.length - 1].port;
    log.debug(
      `releaseSidecarPortEnv remaining SIDECAR_PORT=${env.SIDECAR_PORT} leases=${state.leases.length}`,
    );
  };
}
