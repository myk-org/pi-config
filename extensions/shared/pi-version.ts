import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("pi-version");

declare const require: NodeRequire | undefined;

/**
 * Minimum pi version required by this pi-config version.
 *
 * 1.7.0: `--agent-dir`, `createAgentSessionServices()` diagnostics,
 * `models.generateImages()` `{ aspectRatio, size }` + Radius catalog,
 * idle RPC `ctx.shutdown()`, and native Pi 1.7 `ExtensionAPI` guarantees
 * (no pre-floor compatibility shims).
 */
export const MIN_PI_VERSION = "1.7.0";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const SEMVER_RE = /^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PiVersionCheckResult {
  ok: boolean;
  installed: string | null;
  required: string;
}

export interface PiVersionDetectionOptions {
  /** Override `process.env.PI_PACKAGE_DIR` lookup (for tests). */
  packageDir?: string | null;
  /** Override `process.argv[1]` walk-up (for tests). */
  argv1?: string | null;
  /** Override Pi-loader aliased `@earendil-works/pi-coding-agent` `VERSION` (for tests). */
  runtimeModuleVersion?: string | null;
}

let cachedVersion: string | null | undefined = undefined;
let testVersionResolver: (() => string | null) | null = null;

function normalizeSemverCandidate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !SEMVER_RE.test(trimmed)) return null;
  return trimmed;
}

function readPiVersionFromPackageDir(dir: string): string | null {
  try {
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== PI_PACKAGE_NAME) return null;
    return normalizeSemverCandidate(pkg.version);
  } catch {
    return null;
  }
}

function readPiVersionFromEntrypoint(argv1: string): string | null {
  try {
    let resolved: string;
    try {
      resolved = fs.realpathSync(argv1);
    } catch {
      resolved = path.resolve(argv1);
    }
    let dir = path.dirname(resolved);
    while (dir !== path.dirname(dir)) {
      const version = readPiVersionFromPackageDir(dir);
      if (version) return version;
      dir = path.dirname(dir);
    }
  } catch {
    // ignore unreadable paths
  }
  return null;
}

/**
 * Read `VERSION` from the `@earendil-works/pi-coding-agent` module injected by
 * Pi's extension loader (`jiti` `_aliases` in Node mode, `VIRTUAL_MODULES` in
 * compiled binaries).
 *
 * Intentionally does NOT use Node's `createRequire(import.meta.url)` or
 * extension-relative disk probes, which would read `pi-config`'s own local
 * `node_modules` copy instead of the running Pi host process. Under native ESM
 * (outside Pi's loader), ambient `require` is undefined and this returns `null`.
 */
function readPiLoaderModuleVersion(): string | null {
  if (typeof require !== "function") return null;
  try {
    const mod = require(PI_PACKAGE_NAME) as { VERSION?: unknown } | undefined;
    return normalizeSemverCandidate(mod?.VERSION);
  } catch {
    return null;
  }
}

/**
 * Resolve the version of the running Pi process loading this extension.
 *
 * Strictly process-authoritative (never shells out to an unrelated `pi` binary
 * on `PATH` and never probes `pi-config`'s local `node_modules`):
 * 1) `PI_PACKAGE_DIR/package.json` when set for the running Pi installation.
 * 2) Ancestor `package.json` walk from `process.argv[1]`.
 * 3) `VERSION` exported by `@earendil-works/pi-coding-agent` via Pi's loader.
 */
function detectRuntimePiVersion(options: PiVersionDetectionOptions = {}): string | null {
  const packageDir = options.packageDir !== undefined ? options.packageDir : process.env.PI_PACKAGE_DIR;
  if (typeof packageDir === "string" && packageDir.trim()) {
    const fromPackageDir = readPiVersionFromPackageDir(packageDir.trim());
    if (fromPackageDir) {
      log.debug("pi_version_detected", { source: "package_dir", installed: fromPackageDir });
      return fromPackageDir;
    }
  }

  const argv1 = options.argv1 !== undefined ? options.argv1 : process.argv[1];
  if (typeof argv1 === "string" && argv1.trim()) {
    const fromEntrypoint = readPiVersionFromEntrypoint(argv1.trim());
    if (fromEntrypoint) {
      log.debug("pi_version_detected", { source: "argv1", installed: fromEntrypoint });
      return fromEntrypoint;
    }
  }

  const fromLoader =
    options.runtimeModuleVersion !== undefined
      ? normalizeSemverCandidate(options.runtimeModuleVersion)
      : readPiLoaderModuleVersion();
  if (fromLoader) {
    log.debug("pi_version_detected", { source: "pi_loader_module", installed: fromLoader });
    return fromLoader;
  }

  log.debug("pi_version_undetermined", {
    hasPackageDir: Boolean(packageDir),
    hasArgv1: Boolean(argv1),
  });
  return null;
}

/**
 * Get the version of the running Pi process, cached once per process.
 * Pass explicit `options` to probe custom inputs without mutating the cache.
 */
export function getPiVersion(options?: PiVersionDetectionOptions): string | null {
  if (
    options &&
    (options.packageDir !== undefined ||
      options.argv1 !== undefined ||
      options.runtimeModuleVersion !== undefined)
  ) {
    return detectRuntimePiVersion(options);
  }
  if (testVersionResolver !== null) {
    return normalizeSemverCandidate(testVersionResolver());
  }
  if (cachedVersion === undefined) {
    cachedVersion = detectRuntimePiVersion();
  }
  return cachedVersion;
}

/** Reset cached Pi version state (for unit tests). */
export function resetPiVersionCache(): void {
  cachedVersion = undefined;
  testVersionResolver = null;
}

/** Override runtime Pi version resolution in unit tests; pass `null` to restore. */
export function setPiVersionResolverForTests(resolver: (() => string | null) | null): void {
  testVersionResolver = resolver;
  cachedVersion = undefined;
}

function parseSemver(v: string): { core: number[]; pre: string[] } {
  const noBuild = v.split("+")[0];
  const dashIdx = noBuild.indexOf("-");
  const coreStr = dashIdx >= 0 ? noBuild.slice(0, dashIdx) : noBuild;
  const preStr = dashIdx >= 0 ? noBuild.slice(dashIdx + 1) : "";
  return {
    core: coreStr.split(".").map(Number),
    pre: preStr ? preStr.split(".") : [],
  };
}

/** Compare two semver strings per SemVer 2.0.0 precedence. Returns -1 if a < b, 0 if equal, 1 if a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const na = pa.core[i] || 0;
    const nb = pb.core[i] || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i++) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];
    if (ia === ib) continue;
    const aNum = /^\d+$/.test(ia);
    const bNum = /^\d+$/.test(ib);
    if (aNum && bNum) return Number(ia) < Number(ib) ? -1 : 1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return ia < ib ? -1 : 1;
  }
  if (pa.pre.length === pb.pre.length) return 0;
  return pa.pre.length < pb.pre.length ? -1 : 1;
}

/** Check if the running Pi version meets `minVersion` (fail-closed when undetermined). */
export function checkMinPiVersion(
  minVersion: string = MIN_PI_VERSION,
  options?: PiVersionDetectionOptions,
): PiVersionCheckResult {
  const installed = getPiVersion(options);
  if (!installed) return { ok: false, installed: null, required: minVersion };
  return { ok: compareSemver(installed, minVersion) >= 0, installed, required: minVersion };
}

/** Build a clear, actionable upgrade error when running Pi is below `MIN_PI_VERSION` or undetermined. */
export function formatMinPiVersionError(versionCheck: { installed: string | null; required: string }): string {
  if (versionCheck.installed === null) {
    return (
      `pi-config requires Pi >= ${versionCheck.required}, but the running Pi version could not be determined. ` +
      `Run \`pi update\` (or \`npm install -g @earendil-works/pi-coding-agent\`) and restart Pi.`
    );
  }
  return (
    `pi-config requires Pi >= ${versionCheck.required}, but Pi ${versionCheck.installed} is installed. ` +
    `Run \`pi update\` (or \`npm install -g @earendil-works/pi-coding-agent\`) and restart Pi.`
  );
}

/**
 * Enforce `MIN_PI_VERSION` at extension load before registering any Pi 1.7.0+ APIs.
 * Fails closed both when installed Pi is below `MIN_PI_VERSION` and when the running
 * Pi version cannot be determined, so older installs get an actionable upgrade error
 * regardless of which standalone extension Pi loads first.
 */
export function assertMinPiVersionOnLoad(
  extensionName: string,
  options?: PiVersionDetectionOptions,
): void {
  const versionCheck = checkMinPiVersion(MIN_PI_VERSION, options);
  if (!versionCheck.ok) {
    const errorMessage = formatMinPiVersionError(versionCheck);
    log.error("pi_version_below_floor_on_load", {
      extension: extensionName,
      installed: versionCheck.installed,
      required: versionCheck.required,
    });
    throw new Error(errorMessage);
  }
}
