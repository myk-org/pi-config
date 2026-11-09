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

const peersDir = path.join(os.homedir(), ".pi", "coms", "peers");
fs.mkdirSync(peersDir, { recursive: true, mode: 0o700 });
const statePath = path.join(peersDir, `${cname}.json`);

const env = { ...process.env };
// The parent's identity must not leak into the peer, or coms adopts its session id and the
// endpoint collides with a live peer (the reason rex's slim env "worked").
delete env.__PI_CONFIG_SESSION_ID;
delete env.__PI_PARENT_SESSION_ID;
delete env.PI_SUBAGENT_CHILD;
delete env.PI_SUBAGENT_NAME;

const args = ["--mode", "rpc", "--coms", "--cname", cname, "--project", project];
if (purpose) args.push("--purpose", purpose);

const child = spawn("pi", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

/** Set once: later records (stop/exit) must not rewrite the peer's real start time. */
const startedAt = new Date().toISOString();

const record = (extra = {}) => {
  const state = {
    cname,
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
    console.error(`could not write ${statePath}: ${error?.message ?? error}`);
  }
  return state;
};
record();
console.log(`peer ${cname} started (supervisor ${process.pid}, child ${child.pid})`);

// Keep the peer's lifecycle visible without swallowing its output: log only the lines that matter.
child.stderr.on("data", (data) => {
  const text = String(data);
  if (/bind failed|Unknown option|error/i.test(text)) console.error(`[${cname}] ${text.slice(0, 200).trim()}`);
});
child.stdout.on("data", () => { /* protocol stream: kept drained so the peer never blocks */ });

const stop = (signal) => {
  console.log(`peer ${cname} stopping (${signal})`);
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  record({ stoppedAt: new Date().toISOString(), signal });
  process.exit(0);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGHUP", () => stop("SIGHUP"));

child.on("exit", (code, signal) => {
  console.log(`peer ${cname} exited code=${code} signal=${signal}`);
  record({ exitedAt: new Date().toISOString(), exitCode: code, exitSignal: signal });
  process.exit(0);
});
