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
export const PROJECT_PI_RESOURCE_DIRS = ["skills", "agents", "prompts"];
export const BUNDLED_CONTAINER_PACKAGES = new Set([
  "pi-orchestrator-config",
  "@myk-org/pi-vertex-claude",
  "pi-web-access",
]);
export const MAX_COPY_DEPTH = 32;

const HOST_PACKAGES_CONTAINER_ROOT = "/opt/host-packages";
const PI_PROVIDED_PEER_PACKAGES = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
  ...BUNDLED_CONTAINER_PACKAGES,
]);

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
  "PI_COMS_PARENT_SESSION_ID",
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

function expandHomePath(rawPath, homeDir = os.homedir()) {
  if (rawPath === "~") return homeDir;
  if (rawPath.startsWith("~/") || rawPath.startsWith(`~${path.sep}`)) {
    return path.join(homeDir, rawPath.slice(2));
  }
  return rawPath;
}

function isWithinRoot(candidatePath, rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function toPosixRelPath(relPath) {
  return relPath.split(path.sep).join("/");
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyFilePreservingExec(srcFile, dstFile, stat) {
  try {
    const existing = fs.lstatSync(dstFile);
    if (existing.isDirectory() || existing.isSymbolicLink()) {
      fs.rmSync(dstFile, { recursive: true, force: true });
    }
  } catch { /* destination does not exist */ }
  fs.mkdirSync(path.dirname(dstFile), { recursive: true, mode: 0o700 });
  fs.copyFileSync(srcFile, dstFile);
  try {
    // Keep owner read/write so later refresh/cleanup rmSync never hits EACCES on 0o444 host files,
    // while preserving any executable bit on bundled skill scripts.
    fs.chmodSync(dstFile, (stat.mode & 0o777) | 0o600);
  } catch { /* best-effort */ }
}

function copyDirDereferencedInner(srcDir, dstDir, ancestors, depth, skipNames, validateRealTarget, stats, log) {
  if (depth > MAX_COPY_DEPTH) {
    log.warn("sandbox_host_tree_max_depth", { srcDir, depth });
    stats.skipped += 1;
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    log.warn("sandbox_host_tree_readdir_failed", { srcDir, error: err?.code || err?.message || String(err) });
    stats.skipped += 1;
    stats.dirReadErrors += 1;
    return;
  }

  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const entrySrc = path.join(srcDir, entry.name);
    const entryDst = path.join(dstDir, entry.name);

    let entryStat;
    try {
      entryStat = fs.statSync(entrySrc);
    } catch (err) {
      log.warn("sandbox_host_tree_entry_skipped", {
        path: entrySrc,
        error: err?.code || err?.message || String(err),
      });
      stats.skipped += 1;
      continue;
    }

    let realTarget;
    try {
      realTarget = fs.realpathSync(entrySrc);
    } catch (err) {
      log.warn("sandbox_host_tree_realpath_failed", {
        path: entrySrc,
        error: err?.code || err?.message || String(err),
      });
      stats.skipped += 1;
      continue;
    }

    if (validateRealTarget && !validateRealTarget(realTarget, entrySrc)) {
      log.warn("sandbox_host_tree_target_rejected", { path: entrySrc, target: realTarget });
      stats.skipped += 1;
      continue;
    }

    if (entryStat.isDirectory()) {
      if (ancestors.has(realTarget)) {
        log.warn("sandbox_host_tree_symlink_loop", { path: entrySrc, target: realTarget });
        stats.skipped += 1;
        continue;
      }
      try {
        const existing = fs.lstatSync(entryDst);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          fs.rmSync(entryDst, { recursive: true, force: true });
        }
      } catch { /* does not exist */ }
      fs.mkdirSync(entryDst, { recursive: true, mode: 0o755 });
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(realTarget);
      copyDirDereferencedInner(entrySrc, entryDst, nextAncestors, depth + 1, skipNames, validateRealTarget, stats, log);
    } else if (entryStat.isFile()) {
      try {
        copyFilePreservingExec(entrySrc, entryDst, entryStat);
        stats.copiedFiles += 1;
      } catch (err) {
        log.warn("sandbox_host_tree_copy_failed", {
          src: entrySrc,
          dst: entryDst,
          error: err?.code || err?.message || String(err),
        });
        stats.skipped += 1;
      }
    } else {
      log.debug("sandbox_host_tree_special_skipped", { path: entrySrc });
      stats.skipped += 1;
    }
  }
}

/**
 * Safely copy a host file or directory tree with symlink dereferencing.
 * - Guards against broken symlinks, ELOOP, max depth, and ancestor symlink loops.
 * - Optionally validates every resolved symlink/file target via `validateRealTarget(realTarget, srcPath)`.
 * - Propagates directory read failures (`incomplete: true`) without overwriting an existing destination.
 * - Skips `.git` metadata by default and skips non-regular special files (FIFOs/sockets/devices).
 * - Never throws on missing optional host directories; logs skipped entries via `createLoggerCore`.
 */
export function syncHostTreeDereferenced(srcPath, dstPath, opts = {}) {
  const log = opts.logger ?? createPodmanLogger();
  const skipNames = opts.skipNames instanceof Set
    ? opts.skipNames
    : new Set(Array.isArray(opts.skipNames) ? opts.skipNames : [".git"]);
  const cleanDestination = opts.cleanDestination !== false;
  const validateRealTarget = typeof opts.validateRealTarget === "function" ? opts.validateRealTarget : null;

  const clearDstIfClean = () => {
    if (cleanDestination && fs.existsSync(dstPath)) {
      try { fs.rmSync(dstPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  };

  let rootStat;
  try {
    rootStat = fs.statSync(srcPath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      clearDstIfClean();
      // Distinguish a genuinely absent path from a broken top-level symlink.
      let isBrokenSymlink = false;
      try { isBrokenSymlink = fs.lstatSync(srcPath).isSymbolicLink(); } catch { /* absent */ }
      if (isBrokenSymlink) {
        log.warn("sandbox_host_tree_broken_symlink", { srcPath });
        return { synced: false, copiedFiles: 0, skipped: 1, isFile: false, incomplete: false };
      }
      log.debug("sandbox_host_tree_missing", { srcPath });
      return { synced: false, copiedFiles: 0, skipped: 0, isFile: false, incomplete: false };
    }
    log.warn("sandbox_host_tree_unreadable", {
      srcPath,
      error: err?.code || err?.message || String(err),
    });
    return { synced: false, copiedFiles: 0, skipped: 1, isFile: false, incomplete: true };
  }

  const rootRealPath = safeRealPath(srcPath);
  if (validateRealTarget && !validateRealTarget(rootRealPath, srcPath)) {
    clearDstIfClean();
    log.warn("sandbox_host_tree_target_rejected", { path: srcPath, target: rootRealPath });
    return { synced: false, copiedFiles: 0, skipped: 1, isFile: rootStat.isFile(), incomplete: false };
  }

  if (rootStat.isFile()) {
    try {
      copyFilePreservingExec(srcPath, dstPath, rootStat);
      return { synced: true, copiedFiles: 1, skipped: 0, isFile: true, incomplete: false };
    } catch (err) {
      log.warn("sandbox_host_tree_file_copy_failed", {
        srcPath,
        dstPath,
        error: err?.code || err?.message || String(err),
      });
      return { synced: false, copiedFiles: 0, skipped: 1, isFile: true, incomplete: true };
    }
  }

  if (!rootStat.isDirectory()) {
    clearDstIfClean();
    log.warn("sandbox_host_tree_unsupported_type", { srcPath });
    return { synced: false, copiedFiles: 0, skipped: 1, isFile: false, incomplete: false };
  }

  const stats = { copiedFiles: 0, skipped: 0, dirReadErrors: 0 };

  if (!cleanDestination) {
    fs.mkdirSync(dstPath, { recursive: true, mode: 0o755 });
    copyDirDereferencedInner(srcPath, dstPath, new Set([rootRealPath]), 0, skipNames, validateRealTarget, stats, log);
    const incomplete = stats.dirReadErrors > 0;
    return {
      synced: !incomplete,
      copiedFiles: stats.copiedFiles,
      skipped: stats.skipped,
      isFile: false,
      incomplete,
    };
  }

  const parentDir = path.dirname(dstPath);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const stagingDir = path.join(parentDir, `.${path.basename(dstPath)}.staging.${process.pid}.${Date.now()}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o755 });
  try {
    copyDirDereferencedInner(srcPath, stagingDir, new Set([rootRealPath]), 0, skipNames, validateRealTarget, stats, log);
    if (stats.dirReadErrors > 0) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
      log.warn("sandbox_host_tree_incomplete_preserved", { srcPath, dstPath, dirReadErrors: stats.dirReadErrors });
      return { synced: false, copiedFiles: 0, skipped: stats.skipped, isFile: false, incomplete: true };
    }
    fs.rmSync(dstPath, { recursive: true, force: true });
    fs.renameSync(stagingDir, dstPath);
    return { synced: true, copiedFiles: stats.copiedFiles, skipped: stats.skipped, isFile: false, incomplete: false };
  } catch (err) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    log.warn("sandbox_host_tree_sync_failed", {
      srcPath,
      dstPath,
      error: err?.code || err?.message || String(err),
    });
    return { synced: false, copiedFiles: 0, skipped: stats.skipped + 1, isFile: false, incomplete: true };
  }
}

/**
 * Resolve project roots for `.pi/{skills,agents,prompts}` in ascending precedence order:
 * main repository root (when `sourceCwd` is a linked worktree) → worktree top-level → `sourceCwd`.
 */
export function resolveProjectPiSourceRoots(sourceCwd, execFn = execFileSync) {
  const resolvedSource = path.resolve(sourceCwd);
  const candidates = [];
  const safeGitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };

  try {
    const rawCommon = String(execFn(
      "git",
      [...SAFE_GIT_INSPECT_FLAGS, "rev-parse", "--git-common-dir"],
      { cwd: resolvedSource, encoding: "utf8", timeout: 3000, env: safeGitEnv, stdio: ["ignore", "pipe", "ignore"] },
    )).trim();
    if (rawCommon) {
      const absCommon = path.resolve(resolvedSource, rawCommon);
      if (path.basename(absCommon) === ".git") {
        candidates.push(path.dirname(absCommon));
      }
    }
  } catch { /* not a worktree or git unavailable */ }

  try {
    const rawTop = String(execFn(
      "git",
      [...SAFE_GIT_INSPECT_FLAGS, "rev-parse", "--show-toplevel"],
      { cwd: resolvedSource, encoding: "utf8", timeout: 3000, env: safeGitEnv, stdio: ["ignore", "pipe", "ignore"] },
    )).trim();
    if (rawTop) {
      candidates.push(path.resolve(rawTop));
    }
  } catch { /* fallback to resolvedSource */ }

  candidates.push(resolvedSource);

  const unique = [];
  const seen = new Set();
  for (const dir of candidates) {
    const normalized = path.resolve(dir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function ensureWorkspacePiExcluded(workspaceDir) {
  const gitDir = path.join(workspaceDir, ".git");
  try {
    if (!fs.statSync(gitDir).isDirectory()) return;
    const infoDir = path.join(gitDir, "info");
    fs.mkdirSync(infoDir, { recursive: true, mode: 0o700 });
    const excludePath = path.join(infoDir, "exclude");
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const lines = existing.split(/\r?\n/);
    if (!lines.some((line) => line.trim() === ".pi/")) {
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(excludePath, `${prefix}.pi/\n`, { mode: 0o600 });
    }
  } catch { /* best-effort */ }
}

function listTrackedPathsUnder(repoDir, relPath, execFn) {
  const tracked = new Set();
  try {
    const out = String(execFn(
      "git",
      [...SAFE_GIT_INSPECT_FLAGS, "ls-files", "-z", "--", relPath],
      { cwd: repoDir, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ));
    for (const entry of out.split("\0")) {
      const trimmed = entry.trim();
      if (trimmed) tracked.add(trimmed);
    }
  } catch { /* best-effort */ }
  return tracked;
}

function isPathTrackedOrNestedTracked(relPosix, trackedSet) {
  if (trackedSet.size === 0) return false;
  if (trackedSet.has(relPosix)) return true;
  // Also cover when a tracked symlink is a directory target (e.g. tracked `.pi/skills/link` vs `.pi/skills/link/SKILL.md`).
  const parts = relPosix.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (trackedSet.has(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

function collectRelativeRegularFiles(rootDir, relBase = "") {
  const out = new Map();
  if (!fs.existsSync(rootDir)) return out;
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        try {
          out.set(rel, { absPath: abs, sha256: sha256File(abs), mode: fs.statSync(abs).mode });
        } catch { /* ignore unreadable */ }
      }
    }
  };
  walk(rootDir, relBase);
  return out;
}

function hasPathCollisionForNewFile(workspaceDir, relPosix) {
  const parts = relPosix.split("/");
  // Check every intervening path component (must be a real directory if it exists).
  let current = workspaceDir;
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    try {
      const st = fs.lstatSync(current);
      if (!st.isDirectory() || st.isSymbolicLink()) return true;
    } catch (err) {
      if (err?.code === "ENOENT") break;
      return true;
    }
  }
  // Check the target path itself (must not already exist as directory, symlink, file, or special node).
  const targetAbs = path.join(workspaceDir, ...parts);
  try {
    fs.lstatSync(targetAbs);
    return true;
  } catch (err) {
    return err?.code !== "ENOENT";
  }
}

function pruneEmptyDirsUpTo(startDir, stopDir) {
  let current = path.resolve(startDir);
  const resolvedStop = path.resolve(stopDir);
  while (current !== resolvedStop && current.startsWith(`${resolvedStop}${path.sep}`)) {
    try {
      if (fs.readdirSync(current).length > 0) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function createProjectSymlinkValidator({ roots, homeDir, hostAgentDir, allowedExternalRoots }) {
  const explicitApprovedRoots = [
    ...roots,
    path.join(hostAgentDir, "skills"),
    path.join(hostAgentDir, "agents"),
    path.join(hostAgentDir, "prompts"),
    path.join(homeDir, ".agents", "skills"),
    ...(Array.isArray(allowedExternalRoots) ? allowedExternalRoots : []),
  ].map((p) => safeRealPath(p));
  const realHome = safeRealPath(homeDir);

  return (realTarget) => {
    for (const approved of explicitApprovedRoots) {
      if (isWithinRoot(realTarget, approved)) return true;
    }
    if (isWithinRoot(realTarget, realHome)) {
      const relFromHome = path.relative(realHome, realTarget);
      if (!relFromHome || relFromHome.startsWith("..")) return false;
      const firstSegment = relFromHome.split(path.sep)[0];
      // Block dotfiles/dot-directories directly under $HOME (~/.ssh, ~/.aws, ~/.gnupg, ~/.pi/agent/auth.json, ~/.config/gh, etc.).
      if (!firstSegment || firstSegment.startsWith(".")) return false;
      return true;
    }
    return false;
  };
}

/**
 * Sync project `.pi/skills`, `.pi/agents`, and `.pi/prompts` from main repo root + worktree override
 * into `<workspaceDir>/.pi/{skills,agents,prompts}` with:
 * - Approved symlink target validation (blocking links to host secret dirs like `~/.ssh` or `/etc`).
 * - Preservation of tracked Git paths (never dirtying tracked `.pi` symlinks or files).
 * - Content-hash tracking so peer edits/additions under `.pi/{skills,agents,prompts}` survive reuse/revive
 *   and trigger workspace backup on re-clone.
 */
export function syncProjectPiResources(opts) {
  const { sandboxDir, workspaceDir, sourceCwd } = opts;
  const execFn = opts.execFileSync ?? execFileSync;
  const log = opts.logger ?? createPodmanLogger();
  const homeDir = opts.homeDir ?? os.homedir();
  const hostAgentDir = opts.hostAgentDir ?? path.join(homeDir, ".pi", "agent");
  const previousStagedFiles =
    opts.previousStagedFiles && typeof opts.previousStagedFiles === "object"
      ? opts.previousStagedFiles
      : {};

  const roots = resolveProjectPiSourceRoots(sourceCwd, execFn);
  const resolvedWorkspace = path.resolve(workspaceDir);
  const validateRealTarget = createProjectSymlinkValidator({
    roots,
    homeDir,
    hostAgentDir,
    allowedExternalRoots: opts.allowedExternalRoots,
  });

  const stagedDirs = [];
  const nextStagedFiles = {};
  let copiedFiles = 0;
  let skipped = 0;

  for (const kind of PROJECT_PI_RESOURCE_DIRS) {
    const relKind = `.pi/${kind}`;
    const dstDir = path.join(workspaceDir, ".pi", kind);
    const resolvedDst = path.resolve(dstDir);
    const trackedWorkspacePaths = listTrackedPathsUnder(workspaceDir, relKind, execFn);
    const existingSources = [];

    for (const root of roots) {
      const candidate = path.join(root, ".pi", kind);
      if (path.resolve(candidate) === resolvedDst) continue;
      try {
        if (fs.statSync(candidate).isDirectory()) {
          existingSources.push({ root, candidate });
        }
      } catch { /* optional dir absent or broken */ }
    }

    const stagingDir = path.join(sandboxDir, `.project-pi-${kind}.staging.${process.pid}.${Date.now()}`);
    let nextSnapshotFiles = new Map();
    let stageFailed = false;

    if (existingSources.length > 0) {
      fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.mkdirSync(stagingDir, { recursive: true, mode: 0o755 });
      try {
        for (const { candidate } of existingSources) {
          const res = syncHostTreeDereferenced(candidate, stagingDir, {
            logger: log,
            cleanDestination: false,
            validateRealTarget,
          });
          copiedFiles += res.copiedFiles;
          skipped += res.skipped;
          if (res.incomplete) stageFailed = true;
        }
        if (!stageFailed) {
          nextSnapshotFiles = collectRelativeRegularFiles(stagingDir, relKind);
        }
      } catch (err) {
        stageFailed = true;
        log.warn("sandbox_project_pi_sync_failed", {
          kind,
          workspaceDir: resolvedWorkspace,
          error: err?.message ?? String(err),
        });
      }
    }

    if (stageFailed) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
      // Preserve previous staged manifest entries for this kind on incomplete read.
      for (const [k, v] of Object.entries(previousStagedFiles)) {
        if (k.startsWith(`${relKind}/`)) nextStagedFiles[k] = v;
      }
      if (fs.existsSync(dstDir)) stagedDirs.push(kind);
      continue;
    }

    try {
      const currentWorkspaceFiles = collectRelativeRegularFiles(dstDir, relKind);
      let wroteOrKeptStaged = false;

      // 1. Reconcile existing workspace files: preserve peer-created & peer-modified files,
      //    and remove only unchanged previously staged files that disappeared on host.
      for (const [relPosix, current] of currentWorkspaceFiles.entries()) {
        if (isPathTrackedOrNestedTracked(relPosix, trackedWorkspacePaths)) continue;
        const prevHash = previousStagedFiles[relPosix];
        const nextEntry = nextSnapshotFiles.get(relPosix);

        if (prevHash === undefined) {
          // Peer-created file (not previously staged): never overwrite or delete.
          if (nextEntry && current.sha256 !== nextEntry.sha256) {
            log.warn("sandbox_project_pi_peer_edit_preserved", { path: relPosix });
          }
          continue;
        }

        if (current.sha256 !== prevHash) {
          // Previously staged file modified by peer: preserve peer's edit and leave out of
          // nextStagedFiles so dirty-check backs it up on HEAD advance.
          log.warn("sandbox_project_pi_peer_edit_preserved", { path: relPosix });
          continue;
        }

        // File is unchanged from what we previously staged.
        if (!nextEntry) {
          try {
            fs.unlinkSync(current.absPath);
            pruneEmptyDirsUpTo(path.dirname(current.absPath), path.join(workspaceDir, ".pi"));
          } catch { /* best-effort */ }
          continue;
        }

        if (nextEntry.sha256 !== current.sha256) {
          copyFilePreservingExec(nextEntry.absPath, current.absPath, { mode: nextEntry.mode });
        }
        nextStagedFiles[relPosix] = nextEntry.sha256;
        wroteOrKeptStaged = true;
      }

      // 2. Copy new untracked files from host snapshot into workspace, preserving peer deletions
      //    and never overwriting any peer-owned file, symlink, or directory at the target path.
      for (const [relPosix, nextEntry] of nextSnapshotFiles.entries()) {
        if (isPathTrackedOrNestedTracked(relPosix, trackedWorkspacePaths)) continue;
        if (currentWorkspaceFiles.has(relPosix)) continue;
        if (previousStagedFiles[relPosix] !== undefined) {
          // Previously staged file is absent from workspace: preserve peer deletion and keep the
          // manifest entry so subsequent reuses and HEAD-advance dirty checks recognize the deletion.
          log.warn("sandbox_project_pi_peer_deletion_preserved", { path: relPosix });
          nextStagedFiles[relPosix] = previousStagedFiles[relPosix];
          continue;
        }
        if (hasPathCollisionForNewFile(workspaceDir, relPosix)) {
          log.warn("sandbox_project_pi_peer_collision_preserved", { path: relPosix });
          continue;
        }
        const targetAbs = path.join(workspaceDir, ...relPosix.split("/"));
        copyFilePreservingExec(nextEntry.absPath, targetAbs, { mode: nextEntry.mode });
        nextStagedFiles[relPosix] = nextEntry.sha256;
        wroteOrKeptStaged = true;
      }

      // Clean up empty `.pi/<kind>` if we deleted all previously staged files and nothing remains.
      if (fs.existsSync(dstDir) && !isPathTrackedOrNestedTracked(relKind, trackedWorkspacePaths)) {
        try {
          if (fs.readdirSync(dstDir).length === 0) fs.rmdirSync(dstDir);
        } catch { /* ignore */ }
      }

      if (wroteOrKeptStaged) stagedDirs.push(kind);
    } finally {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  if (stagedDirs.length > 0) {
    ensureWorkspacePiExcluded(workspaceDir);
  }
  log.debug("sandbox_project_pi_synced", {
    sourceCwd: path.resolve(sourceCwd),
    roots,
    stagedDirs,
    stagedFileCount: Object.keys(nextStagedFiles).length,
    copiedFiles,
    skipped,
  });
  return { roots, stagedDirs, stagedFiles: nextStagedFiles, copiedFiles, skipped };
}

function isDirtyBeyondStagedProjectPi(dirtyOutput, workspaceDir, stagedDirs, stagedFiles) {
  const stagedSet = new Set(Array.isArray(stagedDirs) ? stagedDirs : []);
  const stagedFileMap = stagedFiles && typeof stagedFiles === "object" ? stagedFiles : null;
  const stagedKeys = stagedFileMap ? Object.keys(stagedFileMap) : [];

  // Every previously staged manifest entry must still exist on disk with its exact staged hash.
  // Checking this before `!dirtyOutput` catches peer deletions even when the entire `.pi/` dir was removed.
  for (const rel of stagedKeys) {
    const abs = path.join(workspaceDir, ...rel.split("/"));
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.isSymbolicLink()) return true;
      if (sha256File(abs) !== stagedFileMap[rel]) return true;
    } catch {
      return true;
    }
  }

  if (!dirtyOutput) return false;

  const verifyDirMatchesStagedManifest = (dirAbs, relPrefix) => {
    if (!stagedFileMap) return false;
    const walk = (dir, prefix) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = `${prefix}/${entry.name}`;
        if (entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) {
          if (!stagedKeys.some((k) => k.startsWith(`${rel}/`))) return false;
          if (!walk(abs, rel)) return false;
        } else if (entry.isFile()) {
          const expected = stagedFileMap[rel];
          if (!expected) return false;
          try {
            if (sha256File(abs) !== expected) return false;
          } catch {
            return false;
          }
        } else {
          return false;
        }
      }
      return true;
    };
    return walk(dirAbs, relPrefix);
  };

  const lines = dirtyOutput.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    if (!line.startsWith("!! ")) return true;
    const rel = line.slice(3).trim();
    if (rel === ".pi/") {
      if (stagedSet.size === 0) return true;
      try {
        const entries = fs.readdirSync(path.join(workspaceDir, ".pi"));
        if (entries.length === 0 || entries.some((name) => !stagedSet.has(name))) {
          return true;
        }
        for (const name of entries) {
          if (!verifyDirMatchesStagedManifest(path.join(workspaceDir, ".pi", name), `.pi/${name}`)) {
            return true;
          }
        }
      } catch {
        return true;
      }
      continue;
    }
    const subMatch = rel.match(/^\.pi\/([^/]+)\/?$/);
    if (subMatch && stagedSet.has(subMatch[1])) {
      if (!verifyDirMatchesStagedManifest(path.join(workspaceDir, ".pi", subMatch[1]), `.pi/${subMatch[1]}`)) {
        return true;
      }
      continue;
    }
    return true;
  }
  return false;
}

function parseNpmPackageName(spec) {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("@")) {
    const versionIdx = trimmed.indexOf("@", 1);
    return versionIdx > 0 ? trimmed.slice(0, versionIdx) : trimmed;
  }
  const versionIdx = trimmed.indexOf("@");
  return versionIdx > 0 ? trimmed.slice(0, versionIdx) : trimmed;
}

function parseGitPackageHostAndPath(rawSource) {
  let raw = rawSource.trim();
  if (!raw) return null;
  const hasGitPrefix = raw.startsWith("git:");
  if (hasGitPrefix) raw = raw.slice("git:".length).trim();

  // Strip optional @ref suffix on repo path without breaking git@host:...
  const stripTrailingRef = (repoPath) => {
    const idx = repoPath.indexOf("@");
    return idx > 0 ? repoPath.slice(0, idx) : repoPath;
  };

  let host = "";
  let repoPath = "";
  const scpMatch = raw.match(/^git@([^:\s/]+):(.+)$/);
  if (scpMatch) {
    host = scpMatch[1];
    repoPath = stripTrailingRef(scpMatch[2]);
  } else if (/^(?:https?|ssh|git):\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      host = parsed.hostname;
      repoPath = stripTrailingRef(parsed.pathname.replace(/^\/+/, ""));
    } catch {
      return null;
    }
  } else if (hasGitPrefix) {
    const slashIdx = raw.indexOf("/");
    if (slashIdx <= 0) return null;
    host = raw.slice(0, slashIdx);
    repoPath = stripTrailingRef(raw.slice(slashIdx + 1));
  } else {
    return null;
  }

  repoPath = repoPath.replace(/\.git$/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!host || !repoPath || repoPath.split("/").length < 2) return null;
  if (/[\x00\\/]/.test(host) || host === ".." || host === ".") return null;
  if (/[\x00\\]/.test(repoPath) || repoPath.split("/").some((seg) => !seg || seg === "." || seg === "..")) {
    return null;
  }
  return { host, repoPath };
}

/**
 * Resolve a host `settings.json` package source (`npm:`, `git:`, URL, or local path) to its local
 * installed filesystem path on the host without performing any network access.
 */
export function resolveHostPackageInstallPath(source, opts = {}) {
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  if (!trimmed) return null;
  const hostAgentDir = opts.hostAgentDir ?? path.join(os.homedir(), ".pi", "agent");
  const homeDir = opts.homeDir ?? os.homedir();

  if (trimmed.startsWith("npm:")) {
    const pkgName = parseNpmPackageName(trimmed.slice("npm:".length));
    if (!pkgName || /[\x00\\]/.test(pkgName) || pkgName.split("/").some((seg) => !seg || seg === "." || seg === "..")) {
      return null;
    }
    const npmRoot = path.join(hostAgentDir, "npm", "node_modules");
    const candidate = path.resolve(npmRoot, pkgName);
    if (!isWithinRoot(candidate, npmRoot)) return null;
    return {
      kind: "npm",
      bundled: BUNDLED_CONTAINER_PACKAGES.has(pkgName),
      name: pkgName,
      hostPath: candidate,
      label: pkgName.split("/").pop() || pkgName,
    };
  }

  const looksRemoteGit =
    trimmed.startsWith("git:") ||
    trimmed.startsWith("git@") ||
    /^(?:https?|ssh|git):\/\//i.test(trimmed);
  const gitParsed = parseGitPackageHostAndPath(trimmed);
  if (looksRemoteGit) {
    if (!gitParsed) return null;
    const gitRoot = path.join(hostAgentDir, "git");
    const candidate = path.resolve(gitRoot, gitParsed.host, gitParsed.repoPath);
    if (!isWithinRoot(candidate, gitRoot)) return null;
    return {
      kind: "git",
      bundled: false,
      name: `${gitParsed.host}/${gitParsed.repoPath}`,
      hostPath: candidate,
      label: gitParsed.repoPath.split("/").pop() || gitParsed.repoPath,
    };
  }

  const expanded = expandHomePath(trimmed, homeDir);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(hostAgentDir, expanded);
  return {
    kind: "local",
    bundled: false,
    name: resolved,
    hostPath: resolved,
    label: path.basename(resolved) || "local",
  };
}

function isBundledHostPackagePath(hostPath, piConfigDir) {
  if (piConfigDir && safeRealPath(hostPath) === safeRealPath(piConfigDir)) {
    return true;
  }
  try {
    const pkgJsonPath = path.join(hostPath, "package.json");
    if (!fs.existsSync(pkgJsonPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    return typeof pkg?.name === "string" && BUNDLED_CONTAINER_PACKAGES.has(pkg.name);
  } catch {
    return false;
  }
}

function buildHostPackageSlug(label, identityKey) {
  const token = sanitizeContainerToken(label, 32);
  const hash8 = createHash("sha256").update(identityKey).digest("hex").slice(0, 8);
  return `${token}-${hash8}`;
}

function seedSandboxWorkspaceTrust(agentDir, workspacePath, log) {
  if (!workspacePath) return;
  const trustPath = path.join(agentDir, "trust.json");
  let existing = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(trustPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (v === true || v === false || v === null) existing[k] = v;
      }
    }
  } catch { /* fresh trust store */ }

  const resolvedWs = path.resolve(workspacePath);
  const realWs = safeRealPath(workspacePath);
  existing[resolvedWs] = true;
  if (realWs !== resolvedWs) {
    existing[realWs] = true;
  }

  const sorted = {};
  for (const key of Object.keys(existing).sort()) {
    sorted[key] = existing[key];
  }
  try {
    writeJsonAtomic(trustPath, sorted, 0o600);
  } catch (err) {
    log.warn("sandbox_trust_seed_failed", { trustPath, error: err?.message ?? String(err) });
  }
}

function stageHoistedNpmDependencies(hostPkgDir, npmNodeModulesRoot, stageDir, log) {
  let rootPkg;
  try {
    rootPkg = JSON.parse(fs.readFileSync(path.join(hostPkgDir, "package.json"), "utf8"));
  } catch {
    return;
  }
  const readRuntimeDeps = (pkgObj) => {
    const names = [];
    for (const field of ["dependencies", "optionalDependencies"]) {
      const section = pkgObj?.[field];
      if (!section || typeof section !== "object") continue;
      for (const dep of Object.keys(section)) names.push(dep);
    }
    return names;
  };

  const queue = readRuntimeDeps(rootPkg);
  if (queue.length === 0) return;

  const visited = new Set(typeof rootPkg?.name === "string" ? [rootPkg.name] : []);
  while (queue.length > 0) {
    const depName = queue.shift();
    if (!depName || visited.has(depName) || PI_PROVIDED_PEER_PACKAGES.has(depName)) continue;
    if (/[\x00\\]/.test(depName) || depName.split("/").some((seg) => !seg || seg === "." || seg === "..")) continue;
    visited.add(depName);

    const depSrc = path.resolve(npmNodeModulesRoot, depName);
    if (!isWithinRoot(depSrc, npmNodeModulesRoot) || !fs.existsSync(depSrc)) continue;

    const depDst = path.join(stageDir, "node_modules", ...depName.split("/"));
    if (!fs.existsSync(depDst)) {
      syncHostTreeDereferenced(depSrc, depDst, { logger: log, cleanDestination: true });
    }
    try {
      const depPkg = JSON.parse(fs.readFileSync(path.join(depSrc, "package.json"), "utf8"));
      for (const transitive of readRuntimeDeps(depPkg)) {
        if (!visited.has(transitive)) queue.push(transitive);
      }
    } catch { /* no package.json or unreadable */ }
  }
}

function splitGlobBaseAndSuffix(rawPath) {
  const normalized = rawPath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const firstWildcardIdx = segments.findIndex((seg) => seg.includes("*") || seg.includes("?"));
  if (firstWildcardIdx < 0) return { base: rawPath, globSuffix: null };
  const baseSegments = segments.slice(0, firstWildcardIdx);
  const suffixSegments = segments.slice(firstWildcardIdx);
  return {
    base: baseSegments.join("/"),
    globSuffix: suffixSegments.join("/"),
  };
}

/**
 * Prepare and refresh the isolated container `agent-dir/`, read-only host user snapshots
 * (`~/.pi/agent/{skills,agents,prompts}` + `~/.agents/skills`), read-only mirrored host
 * `settings.json` packages/extensions/skills/prompts (including hoisted npm deps & filters),
 * and sandbox workspace trust.
 */
export function prepareSandboxAgentDir(opts) {
  const { sandboxDir, hostAgentDir } = opts;
  const homeDir = opts.homeDir ?? os.homedir();
  const workspacePath = opts.workspacePath ?? null;
  const piConfigDir = opts.piConfigDir ?? null;
  const log = opts.logger ?? createPodmanLogger();

  const agentDir = path.join(sandboxDir, "agent-dir");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

  const resolveSnapshotMount = (srcDir, snapDir) => {
    const res = syncHostTreeDereferenced(srcDir, snapDir, { logger: log });
    if (res.synced) return snapDir;
    // Retain last usable snapshot when a directory read failed rather than replacing or dropping it.
    if (res.incomplete && fs.existsSync(snapDir)) return snapDir;
    return null;
  };

  // 1. Stage dereferenced read-only snapshots of host user skills, agents, and prompts.
  const hostSkillsDir = resolveSnapshotMount(path.join(hostAgentDir, "skills"), path.join(sandboxDir, "host-skills"));
  if (hostSkillsDir) fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true, mode: 0o700 });

  const hostAgentsSkillsDir = resolveSnapshotMount(
    path.join(homeDir, ".agents", "skills"),
    path.join(sandboxDir, "host-agents-skills"),
  );

  const hostAgentsDir = resolveSnapshotMount(path.join(hostAgentDir, "agents"), path.join(sandboxDir, "host-agents"));
  if (hostAgentsDir) fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true, mode: 0o700 });

  const hostPromptsDir = resolveSnapshotMount(path.join(hostAgentDir, "prompts"), path.join(sandboxDir, "host-prompts"));
  if (hostPromptsDir) fs.mkdirSync(path.join(agentDir, "prompts"), { recursive: true, mode: 0o700 });

  // 2. Read host settings.json (read-only) and mirror non-bundled packages + local resources.
  let hostSettings = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(hostAgentDir, "settings.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      hostSettings = parsed;
    }
  } catch {
    hostSettings = {};
  }

  const hostPackagesRoot = path.join(sandboxDir, "host-packages");
  const npmNodeModulesRoot = path.join(hostAgentDir, "npm", "node_modules");
  const activeSlugs = new Set();
  const stagedByRealPath = new Map();
  const hostPackageMounts = [];
  const hostRootMappings = [];

  const registerHostMapping = (hostRoot, containerRoot) => {
    hostRootMappings.push({
      hostRoot: path.resolve(hostRoot),
      hostRealRoot: safeRealPath(hostRoot),
      containerRoot,
    });
  };
  if (piConfigDir) registerHostMapping(piConfigDir, "/opt/pi-config");
  if (hostSkillsDir) registerHostMapping(path.join(hostAgentDir, "skills"), "/home/peer/.pi/agent/skills");
  if (hostAgentsSkillsDir) registerHostMapping(path.join(homeDir, ".agents", "skills"), "/home/peer/.agents/skills");
  if (hostAgentsDir) registerHostMapping(path.join(hostAgentDir, "agents"), "/home/peer/.pi/agent/agents");
  if (hostPromptsDir) registerHostMapping(path.join(hostAgentDir, "prompts"), "/home/peer/.pi/agent/prompts");

  const translateHostPathToContainer = (absHostPath) => {
    const resolved = path.resolve(absHostPath);
    const real = safeRealPath(absHostPath);
    const ordered = [...hostRootMappings].sort((a, b) => b.hostRoot.length - a.hostRoot.length);
    for (const mapping of ordered) {
      for (const [candidate, root] of [[resolved, mapping.hostRoot], [real, mapping.hostRealRoot]]) {
        if (candidate === root) return mapping.containerRoot;
        if (candidate.startsWith(`${root}${path.sep}`)) {
          const rel = toPosixRelPath(path.relative(root, candidate));
          return `${mapping.containerRoot}/${rel}`;
        }
      }
    }
    return null;
  };

  const stageHostPackageSource = (hostPath, label, sourceKind = "local") => {
    let stat;
    try {
      stat = fs.statSync(hostPath);
    } catch (err) {
      log.warn("sandbox_host_package_not_installed", {
        hostPath,
        label,
        error: err?.code || err?.message || String(err),
      });
      return null;
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      log.warn("sandbox_host_package_unsupported_type", { hostPath, label });
      return null;
    }

    const realKey = safeRealPath(hostPath);
    if (stagedByRealPath.has(realKey)) {
      return stagedByRealPath.get(realKey);
    }

    const slug = buildHostPackageSlug(label, realKey);
    const stageDir = path.join(hostPackagesRoot, slug);
    const mountContainerDir = `${HOST_PACKAGES_CONTAINER_ROOT}/${slug}`;

    if (stat.isFile()) {
      const fileName = path.basename(hostPath);
      fs.rmSync(stageDir, { recursive: true, force: true });
      fs.mkdirSync(stageDir, { recursive: true, mode: 0o755 });
      const res = syncHostTreeDereferenced(hostPath, path.join(stageDir, fileName), {
        logger: log,
        cleanDestination: false,
      });
      if (!res.synced) {
        try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
        return null;
      }
      const containerEntryPath = `${mountContainerDir}/${fileName}`;
      activeSlugs.add(slug);
      hostPackageMounts.push({ hostPath: stageDir, containerPath: mountContainerDir });
      stagedByRealPath.set(realKey, containerEntryPath);
      registerHostMapping(hostPath, containerEntryPath);
      return containerEntryPath;
    }

    const res = syncHostTreeDereferenced(hostPath, stageDir, { logger: log, cleanDestination: true });
    if (!res.synced) {
      if (res.incomplete && fs.existsSync(stageDir)) {
        activeSlugs.add(slug);
        hostPackageMounts.push({ hostPath: stageDir, containerPath: mountContainerDir });
        stagedByRealPath.set(realKey, mountContainerDir);
        registerHostMapping(hostPath, mountContainerDir);
        return mountContainerDir;
      }
      return null;
    }
    if (sourceKind === "npm") {
      stageHoistedNpmDependencies(hostPath, npmNodeModulesRoot, stageDir, log);
    }
    activeSlugs.add(slug);
    hostPackageMounts.push({ hostPath: stageDir, containerPath: mountContainerDir });
    stagedByRealPath.set(realKey, mountContainerDir);
    registerHostMapping(hostPath, mountContainerDir);
    return mountContainerDir;
  };

  const mirroredPackages = [];
  if (Array.isArray(hostSettings.packages)) {
    for (const entry of hostSettings.packages) {
      const isObj = entry && typeof entry === "object" && !Array.isArray(entry);
      const rawSource = typeof entry === "string" ? entry : (isObj && typeof entry.source === "string" ? entry.source : null);
      if (!rawSource) continue;

      const resolved = resolveHostPackageInstallPath(rawSource, { hostAgentDir, homeDir });
      if (!resolved) {
        log.warn("sandbox_host_package_unrecognized", { source: rawSource });
        continue;
      }
      if (resolved.bundled || isBundledHostPackagePath(resolved.hostPath, piConfigDir)) {
        log.debug("sandbox_host_package_skipped_bundled", { source: rawSource });
        continue;
      }
      const containerPath = stageHostPackageSource(resolved.hostPath, resolved.label, resolved.kind);
      if (!containerPath) continue;
      mirroredPackages.push(isObj ? { ...entry, source: containerPath } : containerPath);
    }
  }

  const mirrorLocalResourceList = (rawList, resourceKind) => {
    const out = [];
    if (!Array.isArray(rawList)) return out;
    for (const item of rawList) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (!trimmed) continue;

      if (resourceKind === "extensions" && trimmed.startsWith("builtin:")) {
        out.push(trimmed);
        continue;
      }

      // Filter / override entries (!pattern, +path, -path): translate host paths to container
      // paths while preserving relative/glob patterns and exact evaluation order.
      if (trimmed.startsWith("!") || trimmed.startsWith("+") || trimmed.startsWith("-")) {
        const prefix = trimmed[0];
        const body = trimmed.slice(1).trim();
        if (!body) continue;
        if (resourceKind === "extensions" && body.startsWith("builtin:")) {
          out.push(`${prefix}${body}`);
          continue;
        }
        const { base, globSuffix } = splitGlobBaseAndSuffix(body);
        const looksPathLike =
          body.startsWith("/") ||
          body.startsWith("~") ||
          body.startsWith("./") ||
          body.startsWith("../");
        if (base) {
          const expandedBase = expandHomePath(base, homeDir);
          const resolvedBase = path.isAbsolute(expandedBase)
            ? path.resolve(expandedBase)
            : path.resolve(hostAgentDir, expandedBase);
          const translated = translateHostPathToContainer(resolvedBase);
          if (translated) {
            out.push(`${prefix}${globSuffix ? `${translated}/${globSuffix}` : translated}`);
            continue;
          }
          if (prefix === "+" && !globSuffix && fs.existsSync(resolvedBase) && !isBundledHostPackagePath(resolvedBase, piConfigDir)) {
            const containerPath = stageHostPackageSource(resolvedBase, `${resourceKind}-${path.basename(resolvedBase)}`);
            if (containerPath) out.push(`+${containerPath}`);
            continue;
          }
        }
        if (!looksPathLike) {
          out.push(`${prefix}${body}`);
        }
        continue;
      }

      // Wildcard glob resource entries (e.g. ~/extra-prompts/*.md): stage base dir & keep glob.
      if (trimmed.includes("*") || trimmed.includes("?")) {
        const { base, globSuffix } = splitGlobBaseAndSuffix(trimmed);
        if (!base) {
          out.push(trimmed);
          continue;
        }
        const expandedBase = expandHomePath(base, homeDir);
        const resolvedBase = path.isAbsolute(expandedBase)
          ? path.resolve(expandedBase)
          : path.resolve(hostAgentDir, expandedBase);
        const translated = translateHostPathToContainer(resolvedBase);
        if (translated) {
          out.push(`${translated}/${globSuffix}`);
          continue;
        }
        if (!isBundledHostPackagePath(resolvedBase, piConfigDir)) {
          const containerBase = stageHostPackageSource(resolvedBase, `${resourceKind}-${path.basename(resolvedBase)}`);
          if (containerBase) out.push(`${containerBase}/${globSuffix}`);
        }
        continue;
      }

      const expanded = expandHomePath(trimmed, homeDir);
      const resolvedPath = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(hostAgentDir, expanded);
      if (isBundledHostPackagePath(resolvedPath, piConfigDir)) continue;
      const alreadyMapped = translateHostPathToContainer(resolvedPath);
      if (alreadyMapped) {
        out.push(alreadyMapped);
        continue;
      }
      const containerPath = stageHostPackageSource(resolvedPath, `${resourceKind}-${path.basename(resolvedPath)}`);
      if (containerPath) out.push(containerPath);
    }
    return out;
  };

  const mirroredExtensions = mirrorLocalResourceList(hostSettings.extensions, "extensions");
  const mirroredSkills = mirrorLocalResourceList(hostSettings.skills, "skills");
  const mirroredPrompts = mirrorLocalResourceList(hostSettings.prompts, "prompts");

  // Clean up any stale staged host-package directories from previous runs.
  if (activeSlugs.size === 0) {
    try { fs.rmSync(hostPackagesRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  } else if (fs.existsSync(hostPackagesRoot)) {
    try {
      for (const existing of fs.readdirSync(hostPackagesRoot)) {
        if (!activeSlugs.has(existing)) {
          fs.rmSync(path.join(hostPackagesRoot, existing), { recursive: true, force: true });
        }
      }
    } catch { /* best-effort */ }
  }

  // 3. Always refresh container settings.json cleanly on every start/respawn.
  const containerSettingsPath = path.join(agentDir, "settings.json");
  const seeded = {
    ...(typeof hostSettings.defaultProvider === "string" ? { defaultProvider: hostSettings.defaultProvider } : {}),
    ...(typeof hostSettings.defaultModel === "string" ? { defaultModel: hostSettings.defaultModel } : {}),
    ...(typeof hostSettings.theme === "string" ? { theme: hostSettings.theme } : {}),
    ...(typeof hostSettings.defaultThinkingLevel === "string" ? { defaultThinkingLevel: hostSettings.defaultThinkingLevel } : {}),
    ...(typeof hostSettings.steeringMode === "string" ? { steeringMode: hostSettings.steeringMode } : {}),
    ...(typeof hostSettings.followUpMode === "string" ? { followUpMode: hostSettings.followUpMode } : {}),
    ...(typeof hostSettings.enableSkillCommands === "boolean" ? { enableSkillCommands: hostSettings.enableSkillCommands } : {}),
    enableInstallTelemetry: false,
    packages: [
      "/opt/pi-config",
      "/opt/node_modules/@myk-org/pi-vertex-claude",
      "/opt/node_modules/pi-web-access",
      ...mirroredPackages,
    ],
    ...(mirroredExtensions.length > 0 ? { extensions: mirroredExtensions } : {}),
    ...(mirroredSkills.length > 0 ? { skills: mirroredSkills } : {}),
    ...(mirroredPrompts.length > 0 ? { prompts: mirroredPrompts } : {}),
  };
  writeJsonAtomic(containerSettingsPath, seeded, 0o600);

  // 4. Seed sandbox workspace project trust so Pi loads `.pi/{skills,prompts}` in headless RPC mode.
  seedSandboxWorkspaceTrust(agentDir, workspacePath, log);

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

  log.info("sandbox_host_resources_staged", {
    hostSkills: Boolean(hostSkillsDir),
    hostAgentsSkills: Boolean(hostAgentsSkillsDir),
    hostAgents: Boolean(hostAgentsDir),
    hostPrompts: Boolean(hostPromptsDir),
    hostPackageCount: hostPackageMounts.length,
  });

  return {
    agentDir,
    hostAuthJsonPath: hasHostAuth ? hostAuthPath : null,
    hostModelsJsonPath: hasHostModels ? hostModelsPath : null,
    hostSkillsDir,
    hostAgentsSkillsDir,
    hostAgentsDir,
    hostPromptsDir,
    hostPackageMounts,
  };
}

/**
 * Prepare an isolated workspace clone for a containerized peer.
 * - Rejects non-Git directories (never bind-mounts a host non-Git directory `:rw`).
 * - Uses `git clone --no-hardlinks` so container writes cannot corrupt host Git object inodes.
 * - Syncs project `.pi/{skills,agents,prompts}` (resolving linked-worktree main repo root +
 *   dereferencing symlinks) on fresh clone, reuse, and revive while keeping `git status` clean.
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
    if (
      typeof existingMarker?.sourceCwd === "string" &&
      path.resolve(existingMarker.sourceCwd) !== resolvedWorkspace &&
      fs.existsSync(existingMarker.sourceCwd)
    ) {
      const synced = syncProjectPiResources({
        sandboxDir,
        workspaceDir,
        sourceCwd: existingMarker.sourceCwd,
        homeDir: opts.homeDir,
        hostAgentDir: opts.hostAgentDir,
        allowedExternalRoots: opts.allowedExternalRoots,
        previousStagedFiles: existingMarker?.stagedProjectPiFiles,
        execFileSync: execFn,
        logger: log,
      });
      writeJsonAtomic(markerPath, {
        ...existingMarker,
        stagedProjectPiDirs: synced.stagedDirs,
        stagedProjectPiFiles: synced.stagedFiles,
      });
    }
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
    const synced = syncProjectPiResources({
      sandboxDir,
      workspaceDir,
      sourceCwd: resolvedSource,
      homeDir: opts.homeDir,
      hostAgentDir: opts.hostAgentDir,
      allowedExternalRoots: opts.allowedExternalRoots,
      previousStagedFiles: existingMarker?.stagedProjectPiFiles,
      execFileSync: execFn,
      logger: log,
    });
    writeJsonAtomic(markerPath, {
      ...existingMarker,
      stagedProjectPiDirs: synced.stagedDirs,
      stagedProjectPiFiles: synced.stagedFiles,
    });
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
          hasUnsavedWork =
            isDirtyBeyondStagedProjectPi(
              dirty,
              workspaceDir,
              existingMarker?.stagedProjectPiDirs,
              existingMarker?.stagedProjectPiFiles,
            ) ||
            unpushed.length > 0;
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

    const synced = syncProjectPiResources({
      sandboxDir,
      workspaceDir,
      sourceCwd: resolvedSource,
      homeDir: opts.homeDir,
      hostAgentDir: opts.hostAgentDir,
      allowedExternalRoots: opts.allowedExternalRoots,
      execFileSync: execFn,
      logger: log,
    });

    writeJsonAtomic(markerPath, {
      sourceCwd: resolvedSource,
      headSha: sourceHead,
      project,
      cname,
      stagedProjectPiDirs: synced.stagedDirs,
      stagedProjectPiFiles: synced.stagedFiles,
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
  if (opts.hostSkillsDir) {
    args.push("-v", `${opts.hostSkillsDir}:/home/peer/.pi/agent/skills:ro`);
  }
  if (opts.hostAgentsSkillsDir) {
    args.push("-v", `${opts.hostAgentsSkillsDir}:/home/peer/.agents/skills:ro`);
  }
  if (opts.hostAgentsDir) {
    args.push("-v", `${opts.hostAgentsDir}:/home/peer/.pi/agent/agents:ro`);
  }
  if (opts.hostPromptsDir) {
    args.push("-v", `${opts.hostPromptsDir}:/home/peer/.pi/agent/prompts:ro`);
  }
  if (Array.isArray(opts.hostPackageMounts)) {
    for (const mount of opts.hostPackageMounts) {
      if (!mount || typeof mount.hostPath !== "string" || typeof mount.containerPath !== "string") continue;
      if (!mount.hostPath.trim() || /[:\x00-\x1f]/.test(mount.hostPath)) continue;
      if (!mount.containerPath.startsWith(`${HOST_PACKAGES_CONTAINER_ROOT}/`)) continue;
      if (mount.containerPath.includes("..") || /[:\x00-\x1f]/.test(mount.containerPath)) continue;
      args.push("-v", `${mount.hostPath}:${mount.containerPath}:ro`);
    }
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
  const explicitParentSessionId = typeof opts.parentSessionId === "string" ? opts.parentSessionId.trim() : "";
  const hasExplicitParentSessionId = Boolean(explicitParentSessionId) && !/[\x00-\x1f]/.test(explicitParentSessionId);
  if (hasExplicitParentSessionId) {
    envFlags.push("-e", `PI_COMS_PARENT_SESSION_ID=${explicitParentSessionId}`);
  }
  for (const key of passthroughKeys) {
    if (key === "PI_COMS_PARENT_SESSION_ID" && hasExplicitParentSessionId) continue;
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
