#!/usr/bin/env node
/**
 * Host-agnostic rootless Podman COMS peer image builder, tag hasher,
 * non-blocking file-locked background pre-warm, workspace isolator, and `podman run` argv builder.
 *
 * Zero hardcoded host paths, usernames, UIDs, or Pi versions.
 * All runtime logging goes through `createLoggerCore` (never `console.*`).
 */

import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLoggerCore } from "../extensions/shared/logger-core.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_BASE_IMAGE = "registry.fedoraproject.org/fedora:45";
export const IMAGE_REPO = "localhost/pi-peer";
/** Kept in sync with `extensions/shared/pi-version.ts`. */
export const MIN_PI_VERSION = "1.7.0";
export const DEFAULT_PIDS_LIMIT = 512;
export const DEFAULT_PIDASH_HOST = "host.containers.internal";
export const DEFAULT_PIDIFF_HOST = "host.containers.internal";
export const MAX_SANDBOX_BACKUPS = 3;

/** Hardened git flags preventing repository-controlled `.git/config` hooks/fsmonitor execution on the host. */
const SAFE_GIT_INSPECT_FLAGS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.sshCommand=false",
  "-c", "core.pager=cat",
  "-c", "core.editor=false",
];

/** Strict validation pattern for deterministic Podman peer container names (`pi-peer-...`). */
export const VALID_PEER_CONTAINER_RE = /^pi-peer-[a-z0-9][a-z0-9._-]{0,55}$/;

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
  "PI_COMS_INSTANCE_ID",
  "PI_COMS_SHUTDOWN_TOKEN",
];

const LEVEL_ORDER = { off: -1, debug: 0, info: 1, warn: 2, error: 3 };

let cachedHostPiVersion = null;

export function clearCachedHostPiVersion() {
  cachedHostPiVersion = null;
}

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

/** Per-container sandboxes live under `~/.pi/sandboxes/<container>` — outside `~/.pi/coms/`. */
export function resolveSandboxBaseDir(homeDir = os.homedir()) {
  return path.join(homeDir, ".pi", "sandboxes");
}

export function resolvePackageRoot(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

export function isValidPeerContainerName(value) {
  return typeof value === "string" && VALID_PEER_CONTAINER_RE.test(value);
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

function readPiVersionFromEnvPackageDir() {
  const dir = (process.env.PI_PACKAGE_DIR || "").trim();
  if (!dir) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg?.name === "@earendil-works/pi-coding-agent" && typeof pkg.version === "string") {
      return pkg.version;
    }
  } catch { /* fall through */ }
  return null;
}

function validateParsedPiVersion(raw, minVersion) {
  const parsed = parseSemver(raw);
  if (!parsed) {
    throw new Error(
      `Could not parse host Pi version "${raw}"; requires >= ${minVersion}. Run \`pi update\` and restart Pi.`,
    );
  }
  const cmp = compareSemver(parsed.version, minVersion);
  if (cmp === null || cmp < 0) {
    throw new Error(
      `Host Pi version ${parsed.version} is below required minimum ${minVersion}. Run \`pi update\` and restart Pi.`,
    );
  }
  return parsed.version;
}

export function detectHostPiVersion(opts = {}) {
  const minVersion = opts.minVersion ?? MIN_PI_VERSION;
  const hasCustomOverride = Boolean(opts.piVersion || opts.execFileSync);
  if (!hasCustomOverride && cachedHostPiVersion) {
    return validateParsedPiVersion(cachedHostPiVersion, minVersion);
  }

  let raw = opts.piVersion;
  if (!raw && !opts.execFileSync) {
    raw = readPiVersionFromEnvPackageDir();
  }
  if (!raw) {
    const execFn = opts.execFileSync ?? execFileSync;
    try {
      raw = String(execFn("pi", ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] })).trim();
    } catch (err) {
      throw new Error(
        `Could not detect host Pi version via \`pi --version\`: ${err?.message ?? err}. Run \`pi update\` and restart Pi.`,
      );
    }
  }
  const version = validateParsedPiVersion(raw, minVersion);
  if (!hasCustomOverride) cachedHostPiVersion = version;
  return version;
}

export async function detectHostPiVersionAsync(opts = {}) {
  const minVersion = opts.minVersion ?? MIN_PI_VERSION;
  const hasCustomOverride = Boolean(opts.piVersion || opts.execFile);
  if (!hasCustomOverride && cachedHostPiVersion) {
    return validateParsedPiVersion(cachedHostPiVersion, minVersion);
  }

  let raw = opts.piVersion;
  if (!raw && !opts.execFile) {
    raw = readPiVersionFromEnvPackageDir();
  }
  if (!raw) {
    const execFn = opts.execFile ?? execFileAsync;
    try {
      const out = await execFn("pi", ["--version"], { encoding: "utf8", timeout: 5000 });
      raw = String(typeof out === "string" ? out : out?.stdout ?? "").trim();
    } catch (err) {
      throw new Error(
        `Could not detect host Pi version via \`pi --version\`: ${err?.message ?? err}. Run \`pi update\` and restart Pi.`,
      );
    }
  }
  const version = validateParsedPiVersion(raw, minVersion);
  if (!hasCustomOverride) cachedHostPiVersion = version;
  return version;
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

function finalizeTargetPeerImage(opts, baseImageValue, piVersion) {
  const pkgRoot = opts.packageRoot ?? resolvePackageRoot();
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
    baseImage: baseImageValue,
    piVersion,
  });
  return {
    baseImage: baseImageValue,
    piVersion,
    hash,
    tag: buildPeerImageTag(hash),
    containerfilePath,
    installPyPath,
    installSourcesPath,
  };
}

export function resolveTargetPeerImage(opts = {}) {
  const baseImageInput = opts.baseImage ?? DEFAULT_BASE_IMAGE;
  const baseCheck = validateBaseImage(baseImageInput);
  if (!baseCheck.ok) {
    throw new Error(baseCheck.error);
  }
  const piVersion = detectHostPiVersion({ piVersion: opts.piVersion, execFileSync: opts.execFileSync });
  return finalizeTargetPeerImage(opts, baseCheck.value, piVersion);
}

export async function resolveTargetPeerImageAsync(opts = {}) {
  const baseImageInput = opts.baseImage ?? DEFAULT_BASE_IMAGE;
  const baseCheck = validateBaseImage(baseImageInput);
  if (!baseCheck.ok) {
    throw new Error(baseCheck.error);
  }
  const piVersion = await detectHostPiVersionAsync({ piVersion: opts.piVersion, execFile: opts.execFile });
  return finalizeTargetPeerImage(opts, baseCheck.value, piVersion);
}

export function sanitizeContainerToken(value, maxLen = 20) {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, maxLen)
    .replace(/[._-]+$/g, "");
  return cleaned || "peer";
}

/**
 * Deterministic, collision-free Podman container name for a `(project, cname)` identity.
 * Appends an 8-char SHA-256 suffix of exact `${project}\0${cname}` so identities differing
 * only in case or beyond the display prefix never collide.
 */
export function buildPeerContainerName(project, cname) {
  const exactProject = String(project ?? "");
  const exactCname = String(cname ?? "");
  const proj = sanitizeContainerToken(exactProject, 20);
  const name = sanitizeContainerToken(exactCname, 20);
  const hash8 = createHash("sha256").update(`${exactProject}\0${exactCname}`).digest("hex").slice(0, 8);
  return `pi-peer-${proj}-${name}-${hash8}`;
}

export function isSelinuxEnforcing(readFileFn = fs.readFileSync) {
  try {
    return String(readFileFn("/sys/fs/selinux/enforce", "utf8")).trim() === "1";
  } catch {
    return false;
  }
}

/**
 * Normalize a git remote URL to credential-free HTTPS.
 * Strips any embedded URL username/password so secrets are never written into container `.git/config`.
 */
export function rewriteRemoteToHttps(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  let candidate = null;
  if (/^https?:\/\//i.test(trimmed)) {
    candidate = trimmed;
  } else {
    const scpMatch = trimmed.match(/^[^@\s]+@([^:\s/]+):(.+)$/);
    if (scpMatch) {
      candidate = `https://${scpMatch[1]}/${scpMatch[2].replace(/^\/+/, "")}`;
    } else {
      const sshMatch = trimmed.match(/^ssh:\/\/(?:[^@\s/]+@)?([^/\s]+)\/(.+)$/i);
      if (sshMatch) {
        candidate = `https://${sshMatch[1]}/${sshMatch[2].replace(/^\/+/, "")}`;
      }
    }
  }
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!parsed.hostname) return null;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return null;
  }
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

/**
 * Prepare an isolated workspace clone for a containerized peer.
 * - Rejects non-Git directories (never bind-mounts a host non-Git directory `:rw`).
 * - Uses `git clone --no-hardlinks` so container writes cannot corrupt host Git object inodes.
 * - Records `{ sourceCwd, headSha, project, cname }` in `sandboxDir/source.json`; re-clones when
 *   source path or HEAD changed, while preserving the existing clone on revive (`cwd === workspaceDir`).
 */
export function prepareSandboxWorkspace(opts) {
  const { sandboxDir, sourceCwd, project, cname } = opts;
  const execFn = opts.execFileSync ?? execFileSync;
  const log = opts.logger ?? createPodmanLogger();

  const resolvedSource = path.resolve(sourceCwd);
  const workspaceDir = path.join(sandboxDir, "workspace");
  const resolvedWorkspace = path.resolve(workspaceDir);
  const markerPath = path.join(sandboxDir, "source.json");

  let existingMarker = null;
  try {
    existingMarker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    existingMarker = null;
  }

  if (
    existingMarker &&
    (existingMarker.project !== project || existingMarker.cname !== cname)
  ) {
    throw new Error(
      `Sandbox directory ${sandboxDir} belongs to peer ${existingMarker.cname}@${existingMarker.project}, not ${cname}@${project}`,
    );
  }

  // Revive path: `/coms` revive passes the peer's recorded sandbox workspace path directly.
  if (resolvedSource === resolvedWorkspace && fs.existsSync(path.join(workspaceDir, ".git"))) {
    log.info("sandbox_workspace_revived", { workspaceDir, project, cname });
    return { workspaceDir, cloned: false, revived: true };
  }

  let isGit = false;
  try {
    execFn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: resolvedSource,
      stdio: "ignore",
      timeout: 3000,
    });
    isGit = true;
  } catch {
    isGit = false;
  }

  if (!isGit) {
    throw new Error(
      `Podman peer sandbox requires a Git repository (${resolvedSource} is not a Git work tree). Pass sandbox: "off" for non-Git directories.`,
    );
  }

  let sourceHead = "";
  try {
    sourceHead = String(execFn("git", ["rev-parse", "HEAD"], {
      cwd: resolvedSource,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
  } catch {
    sourceHead = "";
  }

  const hasExistingClone = fs.existsSync(path.join(workspaceDir, ".git"));
  const matchesSource =
    hasExistingClone &&
    existingMarker &&
    existingMarker.sourceCwd === resolvedSource &&
    existingMarker.headSha === sourceHead &&
    sourceHead.length > 0;

  if (matchesSource) {
    log.info("sandbox_workspace_reused", { sourceCwd: resolvedSource, workspaceDir, headSha: sourceHead });
    return { workspaceDir, cloned: false, revived: false, backupPath: null };
  }

  fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });

  // Clone into a separate staging directory first so a failed clone NEVER erases an existing workspace.
  const stagingDir = path.join(sandboxDir, `workspace.staging.${process.pid}.${Date.now()}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  try {
    // --no-hardlinks copies Git object storage so container writes cannot modify shared host object inodes.
    execFn("git", ["clone", "--no-hardlinks", resolvedSource, stagingDir], {
      stdio: "ignore",
      timeout: 120_000,
    });

    const httpsOrigin = resolveHostOriginHttpsUrl(resolvedSource, execFn);
    if (httpsOrigin) {
      try {
        execFn("git", ["remote", "set-url", "origin", httpsOrigin], {
          cwd: stagingDir,
          stdio: "ignore",
          timeout: 5000,
        });
      } catch (err) {
        log.warn("sandbox_origin_rewrite_failed", { error: err?.message ?? String(err) });
      }
    } else {
      // Strip local filesystem origin path if host origin could not be safely normalized to HTTPS
      try {
        execFn("git", ["remote", "remove", "origin"], {
          cwd: stagingDir,
          stdio: "ignore",
          timeout: 5000,
        });
      } catch { /* ignore */ }
    }

    // Check if the previous workspace has uncommitted changes (including ignored peer files)
    // or unpushed local commits beyond the recorded source HEAD before replacing it.
    // Run git with core.fsmonitor=false & core.hooksPath=/dev/null so peer-controlled .git/config
    // can never execute host commands.
    let backupPath = null;
    let cleanOldDir = null;
    if (fs.existsSync(workspaceDir)) {
      let hasUnsavedWork = false;
      if (hasExistingClone) {
        try {
          const safeGitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
          const dirty = String(execFn(
            "git",
            [...SAFE_GIT_INSPECT_FLAGS, "status", "--porcelain", "--ignored=matching"],
            {
              cwd: workspaceDir,
              encoding: "utf8",
              timeout: 5000,
              env: safeGitEnv,
              stdio: ["ignore", "pipe", "ignore"],
            },
          )).trim();
          const baseSha =
            typeof existingMarker?.headSha === "string" && /^[a-f0-9]{40}$/i.test(existingMarker.headSha)
              ? existingMarker.headSha
              : null;
          const logArgs = [
            ...SAFE_GIT_INSPECT_FLAGS,
            "log",
            "--branches",
            "--not",
            ...(baseSha ? [baseSha] : []),
            "--remotes",
            "--oneline",
          ];
          const unpushed = String(execFn("git", logArgs, {
            cwd: workspaceDir,
            encoding: "utf8",
            timeout: 5000,
            env: safeGitEnv,
            stdio: ["ignore", "pipe", "ignore"],
          })).trim();
          hasUnsavedWork = dirty.length > 0 || unpushed.length > 0;
        } catch {
          // If git inspection fails on an existing dir, preserve it as a backup rather than deleting blindly.
          hasUnsavedWork = true;
        }
      } else {
        hasUnsavedWork = fs.readdirSync(workspaceDir).length > 0;
      }

      if (hasUnsavedWork) {
        backupPath = path.join(sandboxDir, `workspace.${Date.now()}.bak`);
        fs.renameSync(workspaceDir, backupPath);
        log.warn("sandbox_workspace_backed_up", {
          previousWorkspace: workspaceDir,
          backupPath,
          reason: "uncommitted_ignored_or_unpushed_work",
        });
      } else {
        cleanOldDir = path.join(sandboxDir, `workspace.old.${process.pid}.${Date.now()}`);
        fs.renameSync(workspaceDir, cleanOldDir);
      }
    }

    try {
      fs.renameSync(stagingDir, workspaceDir);
    } catch (renameErr) {
      // Roll back previous workspace if swap fails
      const restoreFrom = backupPath || cleanOldDir;
      if (restoreFrom && fs.existsSync(restoreFrom) && !fs.existsSync(workspaceDir)) {
        try { fs.renameSync(restoreFrom, workspaceDir); } catch { /* ignore */ }
      }
      throw renameErr;
    }

    if (cleanOldDir) {
      try { fs.rmSync(cleanOldDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // Bound workspace.*.bak retention to the N newest backups so ~/.pi/sandboxes never grows unbounded.
    const maxBackups = Number.isInteger(opts.maxBackups) && opts.maxBackups >= 1 ? opts.maxBackups : MAX_SANDBOX_BACKUPS;
    try {
      const backups = fs.readdirSync(sandboxDir)
        .filter((name) => /^workspace\.\d+\.bak$/.test(name))
        .map((name) => {
          const full = path.join(sandboxDir, name);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
          return { name, full, mtimeMs };
        })
        .sort((a, b) => (b.mtimeMs !== a.mtimeMs ? b.mtimeMs - a.mtimeMs : b.name.localeCompare(a.name)));
      for (const stale of backups.slice(maxBackups)) {
        try {
          fs.rmSync(stale.full, { recursive: true, force: true });
          log.info("sandbox_workspace_backup_pruned", { prunedPath: stale.full, kept: maxBackups });
        } catch (pruneErr) {
          log.warn("sandbox_workspace_backup_prune_failed", { path: stale.full, error: pruneErr?.message ?? String(pruneErr) });
        }
      }
    } catch { /* best-effort */ }

    writeJsonAtomic(markerPath, {
      sourceCwd: resolvedSource,
      headSha: sourceHead,
      project,
      cname,
      clonedAt: new Date().toISOString(),
    });
    log.info("sandbox_workspace_cloned", {
      sourceCwd: resolvedSource,
      workspaceDir,
      headSha: sourceHead,
      httpsOrigin: Boolean(httpsOrigin),
      ...(backupPath ? { backupPath } : {}),
    });
    return { workspaceDir, cloned: true, revived: false, backupPath };
  } catch (err) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export function buildPodmanRunArgs(opts) {
  const containerName = opts.containerName || buildPeerContainerName(opts.project, opts.cname);
  if (!isValidPeerContainerName(containerName)) {
    throw new Error(`Invalid Podman peer container name: "${containerName}"`);
  }
  const cpus = opts.cpus ?? 4;
  const memory = opts.memory ?? "4g";
  const pidsLimit = opts.pidsLimit ?? DEFAULT_PIDS_LIMIT;
  const pidashHost = opts.pidashHost || DEFAULT_PIDASH_HOST;
  const pidiffHost = opts.pidiffHost || DEFAULT_PIDIFF_HOST;
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 1000);
  const gid = opts.gid ?? (typeof process.getgid === "function" ? process.getgid() : 1000);
  const env = opts.env ?? process.env;
  const passthroughKeys = opts.passthroughEnvKeys ?? DEFAULT_PASSTHROUGH_ENV_KEYS;

  // Mount ONLY this peer's project registry dir and the sockets dir — NEVER the entire COMS root
  // (which holds host-owned `peers/` supervisor records, `history.jsonl`, and other projects).
  const projectComsDir = path.join(opts.comsDir, "projects", opts.project);
  const socketsComsDir = path.join(opts.comsDir, "sockets");

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
    "-v", `${projectComsDir}:${projectComsDir}:rw`,
    "-v", `${socketsComsDir}:${socketsComsDir}:rw`,
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

export async function isPodmanAvailableAsync(execFn = execFileAsync) {
  try {
    await execFn("podman", ["--version"], { timeout: 5000 });
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

export async function podmanImageExistsAsync(imageTag, execFn = execFileAsync) {
  try {
    await execFn("podman", ["image", "exists", imageTag], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function parsePeerImageLines(out) {
  const seen = new Set();
  const tags = [];
  for (const line of String(out ?? "").split(/\r?\n/)) {
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
}

export function listCachedPeerImageTags(opts = {}) {
  const execFn = opts.execFileSync ?? execFileSync;
  try {
    const out = String(execFn(
      "podman",
      ["images", "--format", "{{.Repository}}:{{.Tag}}", IMAGE_REPO],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ));
    return parsePeerImageLines(out);
  } catch {
    return [];
  }
}

export async function listCachedPeerImageTagsAsync(opts = {}) {
  const execFn = opts.execFile ?? execFileAsync;
  try {
    const out = await execFn(
      "podman",
      ["images", "--format", "{{.Repository}}:{{.Tag}}", IMAGE_REPO],
      { encoding: "utf8", timeout: 5000 },
    );
    return parsePeerImageLines(typeof out === "string" ? out : out?.stdout);
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

function spawnBuildWorker(opts, target, lockPath, statusPath, logPath, log) {
  const spawnFn = opts.spawn ?? spawn;
  const scriptPath = opts.builderScriptPath ?? fileURLToPath(import.meta.url);
  const attemptId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();

  // Write initial `building` status BEFORE spawning the worker so a fast worker finishing
  // immediately with `ready`/`error` can never be overwritten by the parent.
  writeJsonAtomic(statusPath, {
    state: "building",
    attemptId,
    targetTag: target.tag,
    startedAt,
    logPath,
  });

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
    "--attempt-id", attemptId,
  ];

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const child = spawnFn(process.execPath, workerArgs, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref?.();
    log.info("podman_background_build_started", { pid: child.pid ?? null, targetTag: target.tag, attemptId, logPath });
    return { status: "building", targetTag: target.tag, logPath, pid: child.pid ?? null };
  } catch (err) {
    const error = err?.message ?? String(err);
    log.error("podman_background_build_spawn_failed", { targetTag: target.tag, error });
    try {
      writeJsonAtomic(statusPath, {
        state: "error",
        attemptId,
        targetTag: target.tag,
        finishedAt: new Date().toISOString(),
        error,
        logPath,
      });
    } catch { /* ignore */ }
    return { status: "error", targetTag: target.tag, logPath, error };
  }
}

export function startBackgroundPeerImageBuild(opts = {}) {
  const defaults = resolveDefaultBuildPaths(opts.homeDir);
  const lockPath = opts.lockPath ?? defaults.lockPath;
  const statusPath = opts.statusPath ?? defaults.statusPath;
  const logPath = opts.logPath ?? defaults.logPath;
  const execFn = opts.execFileSync ?? execFileSync;
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

  return spawnBuildWorker(opts, target, lockPath, statusPath, logPath, log);
}

export async function startBackgroundPeerImageBuildAsync(opts = {}) {
  const defaults = resolveDefaultBuildPaths(opts.homeDir);
  const lockPath = opts.lockPath ?? defaults.lockPath;
  const statusPath = opts.statusPath ?? defaults.statusPath;
  const logPath = opts.logPath ?? defaults.logPath;
  const execFn = opts.execFile ?? execFileAsync;
  const pidAliveFn = opts.pidAliveFn ?? isPidAlive;
  const log = opts.logger ?? createPodmanLogger(logPath);

  if (!(await isPodmanAvailableAsync(execFn))) {
    const error = "podman not found on PATH — install rootless Podman or use sandbox: \"off\"";
    log.warn("podman_unavailable", { error });
    return { status: "error", targetTag: null, logPath, error };
  }

  let target;
  try {
    target = await resolveTargetPeerImageAsync(opts);
  } catch (err) {
    const error = err?.message ?? String(err);
    log.error("podman_target_resolve_failed", { error });
    return { status: "error", targetTag: null, logPath, error };
  }

  if (await podmanImageExistsAsync(target.tag, execFn)) {
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

  return spawnBuildWorker(opts, target, lockPath, statusPath, logPath, log);
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

/** Non-blocking async variant for interactive session tool calls (`coms_peer_spawn`). */
export async function resolveImageForSpawnAsync(opts = {}) {
  const defaults = resolveDefaultBuildPaths(opts.homeDir);
  const logPath = opts.logPath ?? defaults.logPath;
  const execFn = opts.execFile ?? execFileAsync;
  const log = opts.logger ?? createPodmanLogger(logPath);

  if (!(await isPodmanAvailableAsync(execFn))) {
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
    target = await resolveTargetPeerImageAsync(opts);
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

  if (await podmanImageExistsAsync(target.tag, execFn)) {
    return {
      action: "run",
      imageTag: target.tag,
      targetTag: target.tag,
      usingFallback: false,
      logPath,
    };
  }

  const bg = await startBackgroundPeerImageBuildAsync(opts);
  if (bg.status === "ready") {
    return {
      action: "run",
      imageTag: target.tag,
      targetTag: target.tag,
      usingFallback: false,
      logPath,
    };
  }

  const cachedTags = await listCachedPeerImageTagsAsync({ execFile: execFn });
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
  const attemptId = opts.attemptId || randomBytes(8).toString("hex");

  const target = resolveTargetPeerImage(opts);
  const targetTag = opts.targetTag || target.tag;

  const lock = acquireBuildLock(lockPath, {
    pid: process.pid,
    attemptId,
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
    attemptId,
    targetTag,
    pid: process.pid,
    startedAt,
    logPath,
  });

  let tmpCtxDir = null;
  let logFd = null;
  try {
    if (podmanImageExists(targetTag, execFn)) {
      writeJsonAtomic(statusPath, { state: "ready", attemptId, targetTag, finishedAt: new Date().toISOString(), logPath });
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
      attemptId,
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
        attemptId,
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
function safeRealPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Determine whether `argv1` points to this module, resolving symlinks on both sides
 * so dotfiles installs (e.g. `~/.pi -> ~/dotfiles/.pi`) never silently skip CLI mode.
 */
export function isCliEntrypoint(argv1, moduleUrl = import.meta.url) {
  if (!argv1) return false;
  return safeRealPath(argv1) === safeRealPath(fileURLToPath(moduleUrl));
}

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

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
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
      attemptId: flags["attempt-id"] || undefined,
    });
    process.exit(result.ok ? 0 : 1);
  }
}
