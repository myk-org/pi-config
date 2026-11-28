#!/usr/bin/env node
/**
 * Host-agnostic rootless Podman COMS peer image builder, tag hasher,
 * non-blocking file-locked background pre-warm, and `podman run` argv builder.
 *
 * Zero hardcoded host paths, usernames, UIDs, or Pi versions.
 * All runtime logging goes through `createLoggerCore` (never `console.*`).
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLoggerCore } from "../extensions/shared/logger-core.mjs";

export const DEFAULT_BASE_IMAGE = "registry.fedoraproject.org/fedora:45";
export const IMAGE_REPO = "localhost/pi-peer";
export const MIN_PI_VERSION = "1.6.1";
export const DEFAULT_PIDS_LIMIT = 512;
export const DEFAULT_PIDASH_HOST = "host.containers.internal";
export const DEFAULT_PIDIFF_HOST = "host.containers.internal";

export const DEFAULT_PASSTHROUGH_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "PI_LOG_LEVEL",
];

const LEVEL_ORDER = { off: -1, debug: 0, info: 1, warn: 2, error: 3 };

export function createPodmanLogger(logPath = resolveDefaultBuildPaths().logPath) {
  const levelName = (process.env.PI_LOG_COMS || process.env.PI_LOG_LEVEL || "info").toLowerCase();
  const minimum = LEVEL_ORDER[levelName] ?? LEVEL_ORDER.info;
  return createLoggerCore("podman-peer", "podman-peer", {
    isLevelEnabled: (level) => minimum >= 0 && (LEVEL_ORDER[level] ?? 1) >= minimum,
    write: (line) => {
      fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(logPath, line, { mode: 0o600 });
    },
  });
}

export function resolveDefaultBuildPaths(homeDir = os.homedir()) {
  return {
    lockPath: path.join(homeDir, ".pi", "run", "podman-peer-build.lock"),
    statusPath: path.join(homeDir, ".pi", "run", "podman-peer-build.status.json"),
    logPath: path.join(homeDir, ".pi", "logs", "coms", "podman-build.log"),
  };
}

export function resolvePackageRoot(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

export function validateBaseImage(baseImage) {
  if (typeof baseImage !== "string" || !baseImage.trim()) {
    return { ok: false, error: "coms_peer_sandbox_base_image must be a non-empty pinned image reference" };
  }
  const ref = baseImage.trim();
  if (/[\s"'`$;|&<>\\\x00-\x1f]/.test(ref)) {
    return { ok: false, error: `Invalid base image reference: "${ref}"` };
  }
  if (ref.includes("@sha256:")) {
    return /^.+@sha256:[a-f0-9]{64}$/i.test(ref)
      ? { ok: true, value: ref }
      : { ok: false, error: `Invalid digest-pinned base image reference: "${ref}"` };
  }
  const lastSlash = ref.lastIndexOf("/");
  const lastColon = ref.lastIndexOf(":");
  if (lastColon <= lastSlash) {
    return { ok: false, error: `Base image "${ref}" must specify an explicit pinned tag (never untagged or :latest)` };
  }
  const tag = ref.slice(lastColon + 1);
  if (!tag || tag.toLowerCase() === "latest") {
    return { ok: false, error: `Base image "${ref}" must not use floating :latest tag` };
  }
  return { ok: true, value: ref };
}

export function parseSemver(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    version: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

export function detectHostPiVersion(opts = {}) {
  const execFn = opts.execFileSync ?? execFileSync;
  const minVersion = opts.minVersion ?? MIN_PI_VERSION;
  let raw = opts.piVersion;
  if (!raw) {
    try {
      raw = String(execFn("pi", ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] })).trim();
    } catch (err) {
      throw new Error(`Could not detect host Pi version via \`pi --version\`: ${err?.message ?? err}`);
    }
  }
  const parsed = parseSemver(raw);
  if (!parsed) {
    throw new Error(`Could not parse host Pi version "${raw}"; requires >= ${minVersion}`);
  }
  const cmp = compareSemver(parsed.version, minVersion);
  if (cmp === null || cmp < 0) {
    throw new Error(`Host Pi version ${parsed.version} is below required minimum ${minVersion}`);
  }
  return parsed.version;
}

export function computePeerImageHash(inputs) {
  const payload = JSON.stringify({
    containerfile: inputs.containerfileContent ?? "",
    installPy: inputs.installPyContent ?? "",
    installSourcesPy: inputs.installSourcesContent ?? "",
    baseImage: inputs.baseImage,
    piVersion: inputs.piVersion,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

export function buildPeerImageTag(hash) {
  return `${IMAGE_REPO}:${hash}`;
}

export function resolveTargetPeerImage(opts = {}) {
  const pkgRoot = opts.packageRoot ?? resolvePackageRoot();
  const baseImageInput = opts.baseImage ?? DEFAULT_BASE_IMAGE;
  const baseCheck = validateBaseImage(baseImageInput);
  if (!baseCheck.ok) {
    throw new Error(baseCheck.error);
  }
  const piVersion = detectHostPiVersion({ piVersion: opts.piVersion, execFileSync: opts.execFileSync });
  const containerfilePath = opts.containerfilePath ?? path.join(pkgRoot, "Containerfile.peer");
  const installPyPath = opts.installPyPath ?? path.join(pkgRoot, "scripts", "install.py");
  const installSourcesPath = opts.installSourcesPath ?? path.join(pkgRoot, "scripts", "install_sources.py");

  const containerfileContent = opts.containerfileContent ?? fs.readFileSync(containerfilePath, "utf8");
  const installPyContent = opts.installPyContent ?? fs.readFileSync(installPyPath, "utf8");
  const installSourcesContent = opts.installSourcesContent
    ?? (fs.existsSync(installSourcesPath) ? fs.readFileSync(installSourcesPath, "utf8") : "");

  const hash = computePeerImageHash({
    containerfileContent,
    installPyContent,
    installSourcesContent,
    baseImage: baseCheck.value,
    piVersion,
  });
  return {
    baseImage: baseCheck.value,
    piVersion,
    hash,
    tag: buildPeerImageTag(hash),
    containerfilePath,
    installPyPath,
    installSourcesPath,
  };
}

export function sanitizeContainerToken(value, maxLen = 26) {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, maxLen)
    .replace(/[._-]+$/g, "");
  return cleaned || "peer";
}

export function buildPeerContainerName(project, cname) {
  const proj = sanitizeContainerToken(project, 26);
  const name = sanitizeContainerToken(cname, 26);
  return `pi-peer-${proj}-${name}`;
}

export function isSelinuxEnforcing(readFileFn = fs.readFileSync) {
  try {
    return String(readFileFn("/sys/fs/selinux/enforce", "utf8")).trim() === "1";
  } catch {
    return false;
  }
}

export function rewriteRemoteToHttps(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const scpMatch = trimmed.match(/^[^@\s]+@([^:\s/]+):(.+)$/);
  if (scpMatch) {
    return `https://${scpMatch[1]}/${scpMatch[2].replace(/^\/+/, "")}`;
  }
  const sshMatch = trimmed.match(/^ssh:\/\/(?:[^@\s/]+@)?([^/\s]+)\/(.+)$/i);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2].replace(/^\/+/, "")}`;
  }
  return null;
}

export function resolveHostGitIdentity(cwd, execFn = execFileSync) {
  const readKey = (key) => {
    try {
      return String(execFn("git", ["config", "--get", key], { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })).trim();
    } catch {
      return "";
    }
  };
  return { name: readKey("user.name"), email: readKey("user.email") };
}

export function resolveHostOriginHttpsUrl(cwd, execFn = execFileSync) {
  try {
    const raw = String(execFn("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })).trim();
    return rewriteRemoteToHttps(raw);
  } catch {
    return null;
  }
}

export function buildPodmanRunArgs(opts) {
  const containerName = opts.containerName || buildPeerContainerName(opts.project, opts.cname);
  const cpus = opts.cpus ?? 4;
  const memory = opts.memory ?? "4g";
  const pidsLimit = opts.pidsLimit ?? DEFAULT_PIDS_LIMIT;
  const pidashHost = opts.pidashHost || DEFAULT_PIDASH_HOST;
  const pidiffHost = opts.pidiffHost || DEFAULT_PIDIFF_HOST;
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 1000);
  const gid = opts.gid ?? (typeof process.getgid === "function" ? process.getgid() : 1000);
  const env = opts.env ?? process.env;
  const passthroughKeys = opts.passthroughEnvKeys ?? DEFAULT_PASSTHROUGH_ENV_KEYS;

  const args = [
    "run",
    "-d",
    "--name", containerName,
    "--init",
    "--cpus", String(cpus),
    "--memory", String(memory),
    "--pids-limit", String(pidsLimit),
  ];

  // Map calling host user to container `peer` (1000:1000) dynamically for any non-root UID/GID.
  if (uid !== 0 && gid !== 0) {
    args.push("--userns=keep-id:uid=1000,gid=1000");
  }

  // Only disable SELinux confinement when SELinux is actually Enforcing; NEVER relabel host ~/.pi/ with :Z/:z.
  if (opts.selinuxEnforcing === true) {
    args.push("--security-opt", "label=disable");
  }

  args.push(
    "-v", `${opts.piConfigDir}:/opt/pi-config:ro`,
    "-v", `${opts.agentDir}:/home/peer/.pi/agent:rw`,
  );
  if (opts.hostAuthJsonPath) {
    args.push("-v", `${opts.hostAuthJsonPath}:/home/peer/.pi/agent/auth.json:ro`);
  }
  if (opts.hostModelsJsonPath) {
    args.push("-v", `${opts.hostModelsJsonPath}:/home/peer/.pi/agent/models.json:ro`);
  }
  args.push(
    "-v", `${opts.entrypointPath}:/opt/entrypoint.sh:ro`,
    "-v", `${opts.gitconfigSeedPath}:/opt/gitconfig.seed:ro`,
    "-v", `${opts.workspacePath}:${opts.workspacePath}:rw`,
    "-v", `${opts.comsDir}:${opts.comsDir}:rw`,
    "-w", opts.workspacePath,
  );

  const envFlags = [
    "-e", "PI_COMS_SUPERVISED_PEER=1",
    "-e", "PI_CODING_AGENT_DIR=/home/peer/.pi/agent",
    "-e", `PI_COMS_DIR=${opts.comsDir}`,
    "-e", `PI_COMS_CONTAINER_NAME=${containerName}`,
    "-e", `PI_PIDASH_HOST=${pidashHost}`,
    "-e", `PI_PIDIFF_HOST=${pidiffHost}`,
    "-e", `PI_PEER_CNAME=${opts.cname}`,
    "-e", `PI_PEER_PROJECT=${opts.project}`,
  ];
  if (opts.pidashPort) {
    envFlags.push("-e", `PI_PIDASH_PORT=${opts.pidashPort}`);
  }
  if (opts.purpose) {
    envFlags.push("-e", `PI_PEER_PURPOSE=${opts.purpose}`);
  }
  if (opts.session) {
    envFlags.push("-e", `PI_PEER_SESSION=${opts.session}`);
  }
  for (const key of passthroughKeys) {
    if (env && typeof env[key] === "string" && env[key].length > 0) {
      envFlags.push("-e", key);
    }
  }

  args.push(...envFlags, opts.imageTag, "/opt/entrypoint.sh");
  return args;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function writeJsonAtomic(filePath, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmpPath, filePath);
}

export function readBuildLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isBuildLockActive(lockPath, pidAliveFn = isPidAlive) {
  if (!fs.existsSync(lockPath)) return { active: false, owner: null };
  const owner = readBuildLock(lockPath);
  if (owner && Number.isInteger(owner.pid) && pidAliveFn(owner.pid)) {
    return { active: true, owner };
  }
  // Stale or corrupt lockfile — safe to remove
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  return { active: false, owner: null };
}

export function acquireBuildLock(lockPath, payload, pidAliveFn = isPidAlive) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      return {
        acquired: true,
        owner: payload,
        release: () => {
          try {
            const current = readBuildLock(lockPath);
            if (!current || current.pid === payload.pid) {
              fs.unlinkSync(lockPath);
            }
          } catch { /* ignore */ }
        },
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const check = isBuildLockActive(lockPath, pidAliveFn);
      if (check.active) {
        return { acquired: false, owner: check.owner, release: () => {} };
      }
    }
  }
  return { acquired: false, owner: readBuildLock(lockPath), release: () => {} };
}

export function isPodmanAvailable(execFn = execFileSync) {
  try {
    execFn("podman", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function podmanImageExists(imageTag, execFn = execFileSync) {
  try {
    execFn("podman", ["image", "exists", imageTag], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function listCachedPeerImageTags(opts = {}) {
  const execFn = opts.execFileSync ?? execFileSync;
  try {
    const out = String(execFn(
      "podman",
      ["images", "--format", "{{.Repository}}:{{.Tag}}", IMAGE_REPO],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ));
    const seen = new Set();
    const tags = [];
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith(`${IMAGE_REPO}:`)) continue;
      const tagPart = trimmed.slice(IMAGE_REPO.length + 1);
      if (!tagPart || tagPart === "<none>") continue;
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        tags.push(trimmed);
      }
    }
    return tags;
  } catch {
    return [];
  }
}

export function pruneStalePeerImages(keepTag, opts = {}) {
  const execFn = opts.execFileSync ?? execFileSync;
  const log = opts.logger ?? createPodmanLogger(opts.logPath);
  const tags = listCachedPeerImageTags({ execFileSync: execFn });
  const pruned = [];
  for (const tag of tags) {
    if (tag === keepTag) continue;
    try {
      execFn("podman", ["rmi", tag], { stdio: "ignore", timeout: 15_000 });
      pruned.push(tag);
      log.info("podman_peer_image_pruned", { tag, kept: keepTag });
    } catch (err) {
      log.warn("podman_peer_image_prune_failed", { tag, error: err?.message ?? String(err) });
    }
  }
  return pruned;
}

export function readBuildStatus(opts = {}) {
  const defaults = resolveDefaultBuildPaths(opts.homeDir);
  const lockPath = opts.lockPath ?? defaults.lockPath;
  const statusPath = opts.statusPath ?? defaults.statusPath;
  const logPath = opts.logPath ?? defaults.logPath;
  const pidAliveFn = opts.pidAliveFn ?? isPidAlive;

  const lock = isBuildLockActive(lockPath, pidAliveFn);
  let persisted = null;
  try {
    persisted = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch {
    persisted = null;
  }

  if (lock.active) {
    return {
      state: "building",
      targetTag: lock.owner?.targetTag ?? persisted?.targetTag ?? null,
      pid: lock.owner?.pid ?? null,
      startedAt: lock.owner?.startedAt ?? persisted?.startedAt ?? null,
      logPath: lock.owner?.logPath ?? logPath,
    };
  }

  if (persisted && (persisted.state === "ready" || persisted.state === "error")) {
    return {
      state: persisted.state,
      targetTag: persisted.targetTag ?? null,
      finishedAt: persisted.finishedAt ?? null,
      error: persisted.error ?? null,
      logPath: persisted.logPath ?? logPath,
    };
  }

  return { state: "idle", targetTag: null, logPath };
}

export function startBackgroundPeerImageBuild(opts = {}) {
  const defaults = resolveDefaultBuildPaths(opts.homeDir);
  const lockPath = opts.lockPath ?? defaults.lockPath;
  const statusPath = opts.statusPath ?? defaults.statusPath;
  const logPath = opts.logPath ?? defaults.logPath;
  const execFn = opts.execFileSync ?? execFileSync;
  const spawnFn = opts.spawn ?? spawn;
  const pidAliveFn = opts.pidAliveFn ?? isPidAlive;
  const log = opts.logger ?? createPodmanLogger(logPath);

  if (!isPodmanAvailable(execFn)) {
    const error = "podman not found on PATH — install rootless Podman or use sandbox: \"off\"";
    log.warn("podman_unavailable", { error });
    return { status: "error", targetTag: null, logPath, error };
  }

  let target;
  try {
    target = resolveTargetPeerImage(opts);
  } catch (err) {
    const error = err?.message ?? String(err);
    log.error("podman_target_resolve_failed", { error });
    return { status: "error", targetTag: null, logPath, error };
  }

  if (podmanImageExists(target.tag, execFn)) {
    writeJsonAtomic(statusPath, {
      state: "ready",
      targetTag: target.tag,
      finishedAt: new Date().toISOString(),
      logPath,
    });
    return { status: "ready", targetTag: target.tag, logPath };
  }

  const lock = isBuildLockActive(lockPath, pidAliveFn);
  if (lock.active) {
    log.debug("podman_build_already_running", { pid: lock.owner?.pid, targetTag: lock.owner?.targetTag });
    return {
      status: "building",
      targetTag: lock.owner?.targetTag ?? target.tag,
      logPath: lock.owner?.logPath ?? logPath,
      pid: lock.owner?.pid ?? null,
    };
  }

  const scriptPath = opts.builderScriptPath ?? fileURLToPath(import.meta.url);
  const workerArgs = [
    scriptPath,
    "build",
    "--base-image", target.baseImage,
    "--pi-version", target.piVersion,
    "--target-tag", target.tag,
    "--lock-path", lockPath,
    "--status-path", statusPath,
    "--log-path", logPath,
    "--package-root", opts.packageRoot ?? resolvePackageRoot(),
  ];

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const child = spawnFn(process.execPath, workerArgs, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref?.();
    writeJsonAtomic(statusPath, {
      state: "building",
      targetTag: target.tag,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      logPath,
    });
    log.info("podman_background_build_started", { pid: child.pid ?? null, targetTag: target.tag, logPath });
    return { status: "building", targetTag: target.tag, logPath, pid: child.pid ?? null };
  } catch (err) {
    const error = err?.message ?? String(err);
    log.error("podman_background_build_spawn_failed", { targetTag: target.tag, error });
    return { status: "error", targetTag: target.tag, logPath, error };
  }
}

export function resolveImageForSpawn(opts = {}) {
  const defaults = resolveDefaultBuildPaths(opts.homeDir);
  const logPath = opts.logPath ?? defaults.logPath;
  const execFn = opts.execFileSync ?? execFileSync;
  const log = opts.logger ?? createPodmanLogger(logPath);

  if (!isPodmanAvailable(execFn)) {
    return {
      action: "error",
      imageTag: null,
      targetTag: null,
      usingFallback: false,
      logPath,
      error: "podman not found on PATH — install rootless Podman or pass sandbox: \"off\"",
    };
  }

  let target;
  try {
    target = resolveTargetPeerImage(opts);
  } catch (err) {
    return {
      action: "error",
      imageTag: null,
      targetTag: null,
      usingFallback: false,
      logPath,
      error: err?.message ?? String(err),
    };
  }

  if (podmanImageExists(target.tag, execFn)) {
    return {
      action: "run",
      imageTag: target.tag,
      targetTag: target.tag,
      usingFallback: false,
      logPath,
    };
  }

  // Trigger non-blocking file-locked background build for targetTag
  const bg = startBackgroundPeerImageBuild(opts);
  if (bg.status === "ready") {
    return {
      action: "run",
      imageTag: target.tag,
      targetTag: target.tag,
      usingFallback: false,
      logPath,
    };
  }

  // Zero-wait fallback: if a prior cached localhost/pi-peer:<old-hash> exists, boot immediately on it!
  const cachedTags = listCachedPeerImageTags({ execFileSync: execFn });
  if (cachedTags.length > 0) {
    log.info("podman_spawn_using_cached_fallback", {
      fallbackTag: cachedTags[0],
      targetTag: target.tag,
      logPath,
    });
    return {
      action: "run",
      imageTag: cachedTags[0],
      targetTag: target.tag,
      usingFallback: true,
      logPath,
    };
  }

  if (bg.status === "error") {
    return {
      action: "error",
      imageTag: null,
      targetTag: target.tag,
      usingFallback: false,
      logPath,
      error: bg.error || "Failed to start background Podman peer image build",
    };
  }

  return {
    action: "building",
    imageTag: null,
    targetTag: target.tag,
    usingFallback: false,
    logPath,
    pid: bg.pid ?? null,
  };
}

export function runPeerImageBuildWorker(opts) {
  const defaults = resolveDefaultBuildPaths(opts.homeDir);
  const lockPath = opts.lockPath ?? defaults.lockPath;
  const statusPath = opts.statusPath ?? defaults.statusPath;
  const logPath = opts.logPath ?? defaults.logPath;
  const execFn = opts.execFileSync ?? execFileSync;
  const spawnSyncFn = opts.spawnSync ?? spawnSync;
  const log = opts.logger ?? createPodmanLogger(logPath);

  const target = resolveTargetPeerImage(opts);
  const targetTag = opts.targetTag || target.tag;

  const lock = acquireBuildLock(lockPath, {
    pid: process.pid,
    targetTag,
    startedAt: new Date().toISOString(),
    logPath,
  }, opts.pidAliveFn);

  if (!lock.acquired) {
    log.info("podman_worker_lock_contended", { targetTag, ownerPid: lock.owner?.pid ?? null });
    return { ok: true, skipped: true, targetTag, logPath };
  }

  const startedAt = new Date().toISOString();
  writeJsonAtomic(statusPath, {
    state: "building",
    targetTag,
    pid: process.pid,
    startedAt,
    logPath,
  });

  let tmpCtxDir = null;
  let logFd = null;
  try {
    if (podmanImageExists(targetTag, execFn)) {
      writeJsonAtomic(statusPath, { state: "ready", targetTag, finishedAt: new Date().toISOString(), logPath });
      return { ok: true, skipped: false, targetTag, logPath };
    }

    tmpCtxDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peer-build-"));
    fs.copyFileSync(target.containerfilePath, path.join(tmpCtxDir, "Containerfile.peer"));
    fs.copyFileSync(target.installPyPath, path.join(tmpCtxDir, "install.py"));
    if (fs.existsSync(target.installSourcesPath)) {
      fs.copyFileSync(target.installSourcesPath, path.join(tmpCtxDir, "install_sources.py"));
    }

    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    logFd = fs.openSync(logPath, "a", 0o600);
    const buildArgs = [
      "build",
      "--format", "docker",
      "-f", path.join(tmpCtxDir, "Containerfile.peer"),
      "--build-arg", `BASE_IMAGE=${target.baseImage}`,
      "--build-arg", `PI_VERSION=${target.piVersion}`,
      "-t", targetTag,
      tmpCtxDir,
    ];
    log.info("podman_build_executing", { targetTag, baseImage: target.baseImage, piVersion: target.piVersion });
    const res = spawnSyncFn("podman", buildArgs, {
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    });

    if (res.error) {
      throw res.error;
    }
    if (res.status !== 0) {
      throw new Error(`podman build exited with code ${res.status ?? "unknown"} (see ${logPath})`);
    }

    pruneStalePeerImages(targetTag, { execFileSync: execFn, logger: log, logPath });
    writeJsonAtomic(statusPath, {
      state: "ready",
      targetTag,
      finishedAt: new Date().toISOString(),
      logPath,
    });
    log.info("podman_build_ready", { targetTag });
    return { ok: true, skipped: false, targetTag, logPath };
  } catch (err) {
    const error = err?.message ?? String(err);
    log.error("podman_build_failed", { targetTag, error });
    try {
      writeJsonAtomic(statusPath, {
        state: "error",
        targetTag,
        finishedAt: new Date().toISOString(),
        error,
        logPath,
      });
    } catch { /* ignore */ }
    return { ok: false, skipped: false, targetTag, logPath, error };
  } finally {
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    }
    if (tmpCtxDir) {
      try { fs.rmSync(tmpCtxDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    lock.release();
  }
}

// ── CLI entry point (`node scripts/podman-peer-image.mjs build ...`) ──
function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--") && i + 1 < argv.length) {
      out[arg.slice(2)] = argv[++i];
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "build") {
    const flags = parseCliArgs(rest);
    const result = runPeerImageBuildWorker({
      baseImage: flags["base-image"] || DEFAULT_BASE_IMAGE,
      piVersion: flags["pi-version"] || undefined,
      targetTag: flags["target-tag"] || undefined,
      lockPath: flags["lock-path"] || undefined,
      statusPath: flags["status-path"] || undefined,
      logPath: flags["log-path"] || undefined,
      packageRoot: flags["package-root"] || undefined,
    });
    process.exit(result.ok ? 0 : 1);
  }
}
