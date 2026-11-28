/**
 * Coms peer supervisor.
 *
 * A headless peer (`pi --mode rpc`) exits as soon as its stdin closes, so SOMETHING has to hold the
 * pipe. That something is this supervisor: it stays alive for the peer's whole life, records both
 * pids so the peer can be managed later, and kills the child when it is itself told to stop.
 *
 * Supports both native host processes (`--sandbox off`, default) and opt-in rootless Podman
 * containers (`--sandbox podman --image <tag>`).
 *
 * There is deliberately no lifetime: a peer lives until someone kills it.
 *
 *   node coms-peer-supervisor.mjs <cname> [--project <p>] [--cwd <dir>] [--purpose <text>]
 *     [--session <id|path>] [--agent-dir <dir>] [--sandbox <off|podman>] [--image <tag>]
 *     [--cpus <n>] [--memory <str>]
 *
 * State: ~/.pi/coms/peers/<cname>@<project>.json
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLoggerCore } from "../extensions/shared/logger-core.mjs";
import { extractAgentDirFromArgv, normalizeAgentDir } from "../extensions/shared/pi-agent-dir-parser.mjs";
import {
  buildPeerContainerName,
  buildPodmanRunArgs,
  isPidAlive,
  isSelinuxEnforcing,
  isValidPeerContainerName,
  prepareSandboxWorkspace,
  resolveHostGitIdentity,
  resolvePackageRoot,
  resolveSandboxBaseDir,
} from "./podman-peer-image.mjs";

// Provenance, read before the env is scrubbed below: a supervisor started from an agent's bash
// tool inherits the parent session id, a human's own shell does not.
const spawnerSessionId = process.env.__PI_CONFIG_SESSION_ID || process.env.__PI_PARENT_SESSION_ID || null;
const createdBy = spawnerSessionId ? "agent" : "user";

const [cname, ...rest] = process.argv.slice(2);
if (!cname) {
  process.stderr.write("usage: coms-peer-supervisor.mjs <cname> [--project p] [--cwd d] [--purpose text] [--agent-dir dir] [--sandbox off|podman] [--image tag]\n");
  process.exit(2);
}
const flag = (name, fallback = undefined) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const SUPERVISOR_VALUE_FLAGS = new Set([
  "--project",
  "--cwd",
  "--purpose",
  "--session",
  "--sandbox",
  "--image",
  "--cpus",
  "--memory",
]);
const project = flag("project", "default");
const cwd = flag("cwd", process.cwd());
const purpose = flag("purpose", "");
const session = flag("session", "");
const sandbox = flag("sandbox", "off");
const imageTag = flag("image", "");
const cpusRaw = flag("cpus", "4");
const cpus = Math.max(1, Number.parseInt(cpusRaw, 10) || 4);
const memory = flag("memory", "4g");
const rawCliAgentDir = extractAgentDirFromArgv(rest, { valueFlags: SUPERVISOR_VALUE_FLAGS });
const cliAgentDir = rawCliAgentDir ? normalizeAgentDir(rawCliAgentDir) : undefined;

const comsBase = process.env.PI_COMS_DIR && process.env.PI_COMS_DIR.trim()
  ? process.env.PI_COMS_DIR.trim()
  : path.join(os.homedir(), ".pi", "coms");
const peersDir = path.join(comsBase, "peers");
fs.mkdirSync(peersDir, { recursive: true, mode: 0o700 });
// Keyed by name AND project: two peers may share a name in different projects,
// and a shared key made one supervisor overwrite the other's record.
const statePath = path.join(peersDir, `${cname}@${project}.json`);
const logDir = path.join(os.homedir(), ".pi", "logs", "coms-peers");
fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
const peerLog = path.join(logDir, `${cname}@${project}.log`);

const LEVEL_ORDER = { off: -1, debug: 0, info: 1, warn: 2, error: 3 };
const minLogLevel = LEVEL_ORDER[(process.env.PI_LOG_COMS || process.env.PI_LOG_LEVEL || "info").toLowerCase()] ?? LEVEL_ORDER.info;
const log = createLoggerCore("coms-peer-supervisor", `supervisor:${cname}`, {
  isLevelEnabled: (level) => minLogLevel >= 0 && (LEVEL_ORDER[level] ?? 1) >= minLogLevel,
  write: (line) => {
    try { fs.appendFileSync(peerLog, line, { mode: 0o600 }); } catch { /* logging must never break the supervisor */ }
    if (process.stdout.isTTY) process.stdout.write(line);
  },
});

/** How long a peer gets to finish its own shutdown before SIGKILL / forced container removal. */
const STOP_TIMEOUT_DEFAULT_MS = 5000;
const STOP_TIMEOUT_MS = (() => {
  const raw = Number(process.env.PI_COMS_STOP_TIMEOUT_MS ?? STOP_TIMEOUT_DEFAULT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : STOP_TIMEOUT_DEFAULT_MS;
})();

/** Set once: later records (stop/exit) must not rewrite the peer's real start time. */
const startedAt = new Date().toISOString();

function writeStateRecord(baseFields, extra = {}) {
  const state = {
    cname,
    createdBy,
    createdBySession: spawnerSessionId,
    pid: process.pid,
    project,
    purpose,
    ...(session ? { session } : {}),
    startedAt,
    ...baseFields,
    ...extra,
  };
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (error) {
    log.warn("state_write_failed", { statePath, error: error?.message ?? String(error) });
  }
  return state;
}

function preserveSessionAndCheckOwner() {
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* no record yet */ }
  if (owner && owner.pid !== process.pid) {
    log.info("record_owned_by_replacement", { statePath, ownerPid: owner.pid });
    return { owned: false, preservedSessionId: {} };
  }
  const preservedSessionId = owner && typeof owner.piSessionId === "string" && owner.piSessionId
    ? { piSessionId: owner.piSessionId }
    : {};
  return { owned: true, preservedSessionId };
}

function scrubPeerEnv() {
  const env = { ...process.env };
  // The parent's identity must not leak into the peer, or coms adopts its session id and the
  // endpoint collides with a live peer.
  delete env.__PI_CONFIG_SESSION_ID;
  delete env.__PI_PARENT_SESSION_ID;
  delete env.PI_SUBAGENT_CHILD;
  delete env.PI_SUBAGENT_NAME;
  // Mark only the spawned child process as a supervised headless COMS peer so interactive-only
  // tools like ask_user stay disabled on the peer without touching the spawner's environment.
  env.PI_COMS_SUPERVISED_PEER = "1";
  return env;
}

// ── Rootless Podman sandbox mode ──────────────────────────────────────

function resolveHostAgentDir() {
  if (cliAgentDir) return cliAgentDir;
  const fromEnv = (process.env.PI_CODING_AGENT_DIR || "").trim();
  if (fromEnv) return normalizeAgentDir(fromEnv);
  return path.join(os.homedir(), ".pi", "agent");
}

function prepareSandboxAgentDir(sandboxDir, hostAgentDir) {
  const agentDir = path.join(sandboxDir, "agent-dir");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

  const containerSettingsPath = path.join(agentDir, "settings.json");
  if (!fs.existsSync(containerSettingsPath)) {
    let hostSettings = {};
    try {
      hostSettings = JSON.parse(fs.readFileSync(path.join(hostAgentDir, "settings.json"), "utf8"));
    } catch {
      hostSettings = {};
    }
    const seeded = {
      ...(typeof hostSettings.defaultProvider === "string" ? { defaultProvider: hostSettings.defaultProvider } : {}),
      ...(typeof hostSettings.defaultModel === "string" ? { defaultModel: hostSettings.defaultModel } : {}),
      ...(typeof hostSettings.theme === "string" ? { theme: hostSettings.theme } : {}),
      ...(typeof hostSettings.defaultThinkingLevel === "string" ? { defaultThinkingLevel: hostSettings.defaultThinkingLevel } : {}),
      ...(typeof hostSettings.steeringMode === "string" ? { steeringMode: hostSettings.steeringMode } : {}),
      ...(typeof hostSettings.followUpMode === "string" ? { followUpMode: hostSettings.followUpMode } : {}),
      enableInstallTelemetry: false,
      packages: [
        "/opt/pi-config",
        "/opt/node_modules/@myk-org/pi-vertex-claude",
        "/opt/node_modules/pi-web-access",
      ],
    };
    fs.writeFileSync(containerSettingsPath, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  }

  const hostAuthPath = path.join(hostAgentDir, "auth.json");
  const hasHostAuth = fs.existsSync(hostAuthPath);
  if (hasHostAuth) {
    const placeholder = path.join(agentDir, "auth.json");
    if (!fs.existsSync(placeholder)) fs.writeFileSync(placeholder, "", { mode: 0o600 });
  }

  const hostModelsPath = path.join(hostAgentDir, "models.json");
  const hasHostModels = fs.existsSync(hostModelsPath);
  if (hasHostModels) {
    const placeholder = path.join(agentDir, "models.json");
    if (!fs.existsSync(placeholder)) fs.writeFileSync(placeholder, "", { mode: 0o600 });
  }

  return {
    agentDir,
    hostAuthJsonPath: hasHostAuth ? hostAuthPath : null,
    hostModelsJsonPath: hasHostModels ? hostModelsPath : null,
  };
}

function writeGitconfigSeed(sandboxDir, sourceCwd) {
  const seedPath = path.join(sandboxDir, "gitconfig.seed");
  const identity = resolveHostGitIdentity(sourceCwd);
  const lines = [];
  if (identity.name || identity.email) {
    lines.push("[user]");
    if (identity.name) lines.push(`\tname = ${identity.name}`);
    if (identity.email) lines.push(`\temail = ${identity.email}`);
  }
  lines.push("[safe]", "\tdirectory = *");
  fs.writeFileSync(seedPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  return seedPath;
}

function startPodmanPeer() {
  if (!imageTag) {
    log.error("podman_missing_image_arg", { cname, project });
    process.exit(1);
  }
  const containerName = buildPeerContainerName(project, cname);
  if (!isValidPeerContainerName(containerName)) {
    log.error("podman_invalid_container_name", { containerName, cname, project });
    process.exit(1);
  }
  const pkgRoot = resolvePackageRoot(import.meta.url);
  const entrypointPath = path.join(pkgRoot, "scripts", "podman-peer-entrypoint.sh");
  const hostAgentDir = resolveHostAgentDir();
  // Keep per-container sandboxes outside comsBase (`~/.pi/sandboxes/<container>`) so peers
  // cannot access other peers' workspaces or host supervision records in `~/.pi/coms/peers/`.
  const sandboxDir = path.join(resolveSandboxBaseDir(), containerName);
  fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
  // Ensure minimal COMS subdirectories exist before bind-mounting into container.
  fs.mkdirSync(path.join(comsBase, "projects", project, "agents"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(comsBase, "sockets"), { recursive: true, mode: 0o700 });

  let workspacePath;
  try {
    const ws = prepareSandboxWorkspace({ sandboxDir, sourceCwd: cwd, project, cname, logger: log });
    workspacePath = ws.workspaceDir;
  } catch (err) {
    const msg = err?.message ?? String(err);
    log.error("sandbox_workspace_prepare_failed", { containerName, cwd, error: msg });
    writeStateRecord(
      { childPid: null, cwd, container: containerName, image: imageTag, sandbox: "podman" },
      { failedAt: new Date().toISOString(), failure: msg },
    );
    process.exit(1);
  }

  const { agentDir, hostAuthJsonPath, hostModelsJsonPath } = prepareSandboxAgentDir(sandboxDir, hostAgentDir);
  const gitconfigSeedPath = writeGitconfigSeed(sandboxDir, cwd);

  // Stop any previous container with the same verified identity-hashed container name.
  try {
    execFileSync("podman", ["rm", "-f", "--", containerName], { stdio: "ignore", timeout: 15_000 });
  } catch { /* not running */ }

  const containerEnv = scrubPeerEnv();
  // Resolve GitHub token via host `gh auth token` if not already in env (never logged, never in argv)
  if (!containerEnv.GITHUB_TOKEN && !containerEnv.GH_TOKEN) {
    try {
      const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (token) containerEnv.GITHUB_TOKEN = token;
    } catch { /* gh not authenticated or unavailable */ }
  }

  const runArgs = buildPodmanRunArgs({
    containerName,
    imageTag,
    uid: typeof process.getuid === "function" ? process.getuid() : 1000,
    gid: typeof process.getgid === "function" ? process.getgid() : 1000,
    selinuxEnforcing: isSelinuxEnforcing(),
    cpus,
    memory,
    piConfigDir: pkgRoot,
    agentDir,
    hostAuthJsonPath,
    hostModelsJsonPath,
    entrypointPath,
    gitconfigSeedPath,
    workspacePath,
    comsDir: comsBase,
    cname,
    project,
    purpose,
    session,
    pidashPort: process.env.PI_PIDASH_PORT ? Number.parseInt(process.env.PI_PIDASH_PORT, 10) || undefined : undefined,
    env: containerEnv,
  });

  let cid = "";
  try {
    cid = execFileSync("podman", runArgs, { encoding: "utf8", env: containerEnv, timeout: 60_000 }).trim();
  } catch (err) {
    const msg = err?.stderr ? String(err.stderr).trim() : (err?.message ?? String(err));
    log.error("podman_run_failed", { containerName, imageTag, error: msg });
    writeStateRecord(
      { childPid: null, cwd: workspacePath, container: containerName, image: imageTag, sandbox: "podman" },
      { failedAt: new Date().toISOString(), failure: msg },
    );
    process.exit(1);
  }

  let hostPid = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const raw = execFileSync("podman", ["inspect", "-f", "{{.State.Pid}}", "--", containerName], {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      const parsed = Number.parseInt(raw, 10);
      if (isPidAlive(parsed)) {
        hostPid = parsed;
        break;
      }
    } catch { /* retry */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  const baseFields = {
    childPid: hostPid,
    cwd: workspacePath,
    container: containerName,
    image: imageTag,
    sandbox: "podman",
  };
  writeStateRecord(baseFields);
  log.info("podman_peer_started", {
    cname,
    project,
    containerName,
    cid: cid.slice(0, 12),
    hostPid,
    imageTag,
    workspacePath,
  });

  let stopping = false;
  let stopSignal = null;
  let stoppedAt = null;
  let forced = false;
  let forceTimer = null;
  let exited = false;

  const finalize = (code, signal) => {
    if (exited) return;
    exited = true;
    clearInterval(pollTimer);
    if (forceTimer) clearTimeout(forceTimer);
    log.info("podman_peer_exited", { containerName, code, signal, forced });
    const { owned, preservedSessionId } = preserveSessionAndCheckOwner();
    if (!owned) process.exit(0);
    writeStateRecord(baseFields, {
      ...preservedSessionId,
      ...(stopping ? { stoppedAt, stopSignal } : {}),
      exitedAt: new Date().toISOString(),
      exitCode: code,
      exitSignal: signal,
      ...(forced ? { forced: true } : {}),
    });
    process.exit(0);
  };

  const stopContainer = (signal) => {
    if (stopping) return;
    stopping = true;
    stopSignal = signal;
    stoppedAt = new Date().toISOString();
    const stopSeconds = Math.max(1, Math.ceil(STOP_TIMEOUT_MS / 1000));
    log.info("podman_peer_stopping_graceful", { containerName, signal, stopSeconds });

    // Orderly stop first (`podman stop -t N -- <container>` sends SIGTERM to init -> entrypoint
    // closes Pi stdin & stops gracefully), then clean up container and finalize after exit.
    const stopper = spawn("podman", ["stop", "-t", String(stopSeconds), "--", containerName], {
      stdio: "ignore",
    });
    stopper.on("exit", () => {
      try {
        execFileSync("podman", ["rm", "-f", "--", containerName], { stdio: "ignore", timeout: 10_000 });
      } catch { /* already removed */ }
      finalize(0, signal);
    });
    stopper.on("error", () => {
      forced = true;
      try {
        execFileSync("podman", ["rm", "-f", "--", containerName], { stdio: "ignore", timeout: 10_000 });
      } catch { /* already removed */ }
      finalize(0, signal);
    });

    forceTimer = setTimeout(() => {
      forced = true;
      log.warn("podman_peer_stop_escalated", { containerName, timeoutMs: STOP_TIMEOUT_MS });
      try {
        execFileSync("podman", ["rm", "-f", "--", containerName], { stdio: "ignore", timeout: 10_000 });
      } catch { /* already gone */ }
      finalize(0, signal);
    }, STOP_TIMEOUT_MS + 3000);
    forceTimer.unref?.();
  };

  process.on("SIGTERM", () => stopContainer("SIGTERM"));
  process.on("SIGINT", () => stopContainer("SIGINT"));
  process.on("SIGHUP", () => stopContainer("SIGHUP"));

  const waiter = spawn("podman", ["wait", "--", containerName], { stdio: ["ignore", "pipe", "ignore"] });
  let waitOut = "";
  waiter.stdout.on("data", (d) => { waitOut += String(d); });
  waiter.on("exit", () => {
    if (stopping) return; // stopContainer finalizes after container removal
    const parsedCode = Number.parseInt(waitOut.trim(), 10);
    finalize(Number.isInteger(parsedCode) ? parsedCode : null, null);
  });
  waiter.on("error", () => {
    // Fall back to hostPid poll if `podman wait` fails to spawn
  });

  const pollTimer = setInterval(() => {
    if (!stopping && hostPid && !isPidAlive(hostPid)) {
      finalize(null, null);
    }
  }, 5000);
  pollTimer.unref?.();
}

// ── Native host process mode (default) ────────────────────────────────

function startNativePeer() {
  const env = scrubPeerEnv();
  if (cliAgentDir) {
    env.PI_CODING_AGENT_DIR = cliAgentDir;
    log.info(`peer ${cname} using agent dir ${cliAgentDir}`);
  }

  const args = ["--mode", "rpc", "--coms", "--cname", cname, "--project", project];
  if (purpose) args.push("--purpose", purpose);
  if (session) args.push("--session", session);

  let child;
  try {
    child = spawn("pi", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    log.error("native_peer_start_failed", { cname, error: error?.message ?? String(error) });
    process.exit(1);
  }

  const baseFields = () => ({ childPid: child.pid ?? null, cwd });

  child.once("error", (error) => {
    log.error("native_peer_spawn_error", { cname, error: error?.message ?? String(error) });
    writeStateRecord(baseFields(), { failedAt: new Date().toISOString(), failure: String(error?.message ?? error) });
    process.exit(1);
  });
  child.once("spawn", () => {
    writeStateRecord(baseFields());
    log.info("native_peer_started", { cname, supervisorPid: process.pid, childPid: child.pid });
  });

  child.stderr.on("data", (data) => {
    const text = String(data);
    if (/bind failed|Unknown option|error/i.test(text)) {
      log.warn("native_peer_stderr", { cname, text: text.slice(0, 200).trim() });
    }
  });
  child.stdout.on("data", () => { /* protocol stream: kept drained so the peer never blocks */ });

  let stopping = false;
  let stopSignal = null;
  let stoppedAt = null;
  let forced = false;
  let stopTimer = null;

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    stopSignal = signal;
    stoppedAt = new Date().toISOString();
    log.info("native_peer_stopping", { cname, signal });
    try { child.stdin.end(); } catch { /* already gone */ }
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    stopTimer = setTimeout(() => {
      forced = true;
      log.warn("native_peer_sigkill", { cname, timeoutMs: STOP_TIMEOUT_MS });
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, STOP_TIMEOUT_MS);
    stopTimer.unref?.();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGHUP", () => stop("SIGHUP"));

  child.on("exit", (code, signal) => {
    if (stopTimer) clearTimeout(stopTimer);
    log.info("native_peer_exited", { cname, code, signal });
    const { owned, preservedSessionId } = preserveSessionAndCheckOwner();
    if (!owned) process.exit(0);
    writeStateRecord(baseFields(), {
      ...preservedSessionId,
      ...(stopping ? { stoppedAt, stopSignal } : {}),
      exitedAt: new Date().toISOString(),
      exitCode: code,
      exitSignal: signal,
      ...(forced ? { forced: true } : {}),
    });
    process.exit(0);
  });
}

if (sandbox === "podman") {
  startPodmanPeer();
} else {
  startNativePeer();
}
