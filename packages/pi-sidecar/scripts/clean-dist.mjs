#!/usr/bin/env node
/**
 * Portable postbuild cleanup for @myk-org/pi-sidecar.
 *
 * tsc and uv build share dist/. Strip Unix-only leftovers so npm pack never
 * ships Python wheels/sdists and so tests can run postbuild on Windows.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

function createLogger(name) {
  const noop = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  let file;
  try {
    const dir = join(homedir(), ".pi", "logs", name);
    mkdirSync(dir, { recursive: true });
    file = join(dir, "postbuild.log");
  } catch {
    noop.debug("createLogger file logging unavailable", { name });
    return noop;
  }
  const emit = (level, args) => {
    try {
      const msg = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      appendFileSync(file, `${new Date().toISOString()} ${level} [clean-dist] ${msg}\n`);
    } catch {
      // Never fail postbuild on log I/O.
    }
  };
  const logger = {
    debug: (...args) => emit("debug", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
  };
  logger.debug("createLogger", { name, file });
  return logger;
}

const log = createLogger("pi-sidecar");

function rmForce(path) {
  log.debug("rmForce", { path });
  rmSync(path, { force: true });
}

rmForce(join(dist, ".gitignore"));

let names;
try {
  names = readdirSync(dist);
} catch (err) {
  const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
  if (code === "ENOENT") {
    log.info("dist/ missing, nothing to strip");
    process.exit(0);
  }
  log.error("readdir dist failed", { code, err: String(err) });
  throw err;
}

const removed = [];
for (const name of names) {
  if (!name.endsWith(".whl") && !name.endsWith(".tar.gz")) continue;
  rmForce(join(dist, name));
  removed.push(name);
}

if (removed.length > 0) {
  log.info("removed Python artifacts", { removed });
} else {
  log.debug("no Python artifacts in dist/");
}
