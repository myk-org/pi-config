/**
 * Coms peer supervisor.
 *
 * A headless peer (`pi --mode rpc`) exits as soon as its stdin closes, so SOMETHING has to hold the
 * pipe. That something is this supervisor: it stays alive for the peer's whole life, records both
 * pids so the peer can be managed later, and kills the child when it is itself told to stop.
 *
 * There is deliberately no lifetime: a peer lives until someone kills it.
 *
 *   node coms-peer-supervisor.mjs <cname> [--project <p>] [--cwd <dir>] [--purpose <text>]
 *
 * State: ~/.pi/coms/peers/<cname>.json — { cname, pid, childPid, session, project, cwd, startedAt }
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Provenance, read before the env is scrubbed below: a supervisor started from an agent's bash
// tool inherits the parent session id, a human's own shell does not.
const spawnerSessionId = process.env.__PI_CONFIG_SESSION_ID || process.env.__PI_PARENT_SESSION_ID || null;
const createdBy = spawnerSessionId ? "agent" : "user";

const [cname, ...rest] = process.argv.slice(2);
if (!cname) {
  console.error("usage: coms-peer-supervisor.mjs <cname> [--project p] [--cwd d] [--purpose text]");
  process.exit(2);
}
const flag = (name, fallback = undefined) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const project = flag("project", "default");
const cwd = flag("cwd", process.cwd());
const purpose = flag("purpose", "");

const comsBase = process.env.PI_COMS_DIR && process.env.PI_COMS_DIR.trim()
  ? process.env.PI_COMS_DIR.trim()
  : path.join(os.homedir(), ".pi", "coms");
const peersDir = path.join(comsBase, "peers");
fs.mkdirSync(peersDir, { recursive: true, mode: 0o700 });
// Keyed by name AND project: two peers may share a name in different projects (rootcoz ↔ pi-sidecar
// are deliberately one project), and a shared key made one supervisor overwrite the other's record.
const statePath = path.join(peersDir, `${cname}@${project}.json`);
const logDir = path.join(os.homedir(), ".pi", "logs", "coms-peers");
fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
const peerLog = path.join(logDir, `${cname}@${project}.log`);
const say = (message) => {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { fs.appendFileSync(peerLog, line); } catch { /* logging must never break the supervisor */ }
  if (process.stdout.isTTY) process.stdout.write(line);
};

const env = { ...process.env };
// The parent's identity must not leak into the peer, or coms adopts its session id and the
// endpoint collides with a live peer (the reason rex's slim env "worked").
delete env.__PI_CONFIG_SESSION_ID;
delete env.__PI_PARENT_SESSION_ID;
delete env.PI_SUBAGENT_CHILD;
delete env.PI_SUBAGENT_NAME;

const args = ["--mode", "rpc", "--coms", "--cname", cname, "--project", project];
if (purpose) args.push("--purpose", purpose);

let child;
try {
  child = spawn("pi", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
} catch (error) {
  // A missing pi binary is a startup failure, not a running peer.
  say(`peer ${cname} failed to start: ${error?.message ?? error}`);
  process.exit(1);
}

/** Set once: later records (stop/exit) must not rewrite the peer's real start time. */
const startedAt = new Date().toISOString();

const record = (extra = {}) => {
  const state = {
    cname,
    createdBy,
    createdBySession: spawnerSessionId,
    pid: process.pid,
    childPid: child.pid ?? null,
    project,
    cwd,
    purpose,
    startedAt,
    ...extra,
  };
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (error) {
    say(`could not write ${statePath}: ${error?.message ?? error}`);
  }
  return state;
};
// Report success only once the child actually spawned: a record claiming a running peer that never
// started is worse than no record.
child.once("error", (error) => {
  say(`peer ${cname} failed to start: ${error?.message ?? error}`);
  record({ failedAt: new Date().toISOString(), failure: String(error?.message ?? error) });
  process.exit(1);
});
child.once("spawn", () => {
  record();
  say(`peer ${cname} started (supervisor ${process.pid}, child ${child.pid})`);
});

// Keep the peer's lifecycle visible without swallowing its output: log only the lines that matter.
child.stderr.on("data", (data) => {
  const text = String(data);
  if (/bind failed|Unknown option|error/i.test(text)) console.error(`[${cname}] ${text.slice(0, 200).trim()}`);
});
child.stdout.on("data", () => { /* protocol stream: kept drained so the peer never blocks */ });

/** How long a peer gets to finish its own shutdown before SIGKILL. */
const STOP_TIMEOUT_MS = Number(process.env.PI_COMS_STOP_TIMEOUT_MS ?? 5000);

let stopping = false;
let stopSignal = null;
let stoppedAt = null;
let forced = false;
let stopTimer = null;

const stop = (signal) => {
  if (stopping) return; // a second signal must not restart the wait or double-record
  stopping = true;
  stopSignal = signal;
  stoppedAt = new Date().toISOString();
  say(`peer ${cname} stopping (${signal})`);
  // Orderly sequence: end stdin FIRST (pi treats EOF as "shut down", and since pi 1.5.1 it completes
  // its cleanup instead of losing it to the stdin+signal race), then ask it to stop.
  try { child.stdin.end(); } catch { /* already gone */ }
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  // The supervisor used to exit right here, which closed the pipe again and never observed the child
  // finishing: no `exitedAt`, and a ghost registry entry left behind when the peer died mid-cleanup.
  stopTimer = setTimeout(() => {
    forced = true;
    say(`peer ${cname} did not exit within ${STOP_TIMEOUT_MS}ms — sending SIGKILL`);
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, STOP_TIMEOUT_MS);
  stopTimer.unref?.();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGHUP", () => stop("SIGHUP"));

child.on("exit", (code, signal) => {
  if (stopTimer) clearTimeout(stopTimer);
  say(`peer ${cname} exited code=${code} signal=${signal}`);
  // One record shape either way, but a stop records WHEN it was asked and WHEN it finished, and a
  // peer that had to be killed says so.
  record({
    ...(stopping ? { stoppedAt, stopSignal } : {}),
    exitedAt: new Date().toISOString(),
    exitCode: code,
    exitSignal: signal,
    ...(forced ? { forced: true } : {}),
  });
  process.exit(0);
});
