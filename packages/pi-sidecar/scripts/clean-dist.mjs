#!/usr/bin/env node
/**
 * Portable postbuild cleanup for @myk-org/pi-sidecar.
 *
 * tsc and uv build share dist/. Strip Unix-only leftovers so npm pack never
 * ships Python wheels/sdists and so tests can run postbuild on Windows.
 */
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

function rmForce(path) {
  rmSync(path, { force: true });
}

rmForce(join(dist, ".gitignore"));

let names;
try {
  names = readdirSync(dist);
} catch (err) {
  const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
  if (code === "ENOENT") {
    console.log("[sidecar] clean-dist: dist/ missing, nothing to strip");
    process.exit(0);
  }
  throw err;
}

const removed = [];
for (const name of names) {
  if (!name.endsWith(".whl") && !name.endsWith(".tar.gz")) continue;
  rmForce(join(dist, name));
  removed.push(name);
}

console.log(
  removed.length > 0
    ? `[sidecar] clean-dist: removed ${removed.join(", ")}`
    : "[sidecar] clean-dist: no Python artifacts in dist/",
);
