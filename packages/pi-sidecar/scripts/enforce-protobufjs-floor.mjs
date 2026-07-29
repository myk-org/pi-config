#!/usr/bin/env node
/**
 * After npm install, force protobufjs@7.6.5 into the pi-coding-agent subtree.
 *
 * @earendil-works/pi-coding-agent ships an npm-shrinkwrap.json that seals
 * protobufjs@7.6.4 against root package.json overrides (see AGENTS.md §10).
 * This script replaces that sealed copy when it is still below the CVE floor,
 * so the installed tree matches the intended override even though npm itself
 * cannot apply it.
 *
 * Safe no-op when the nested copy is already >= 7.6.5 or absent.
 * Replacement is best-effort: filesystem errors are warned and the install
 * still exits 0 (never abort npm install over a locked/read-only tree).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const FLOOR = "7.6.5";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nestedPkg = join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
  "protobufjs",
  "package.json",
);

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

if (!existsSync(nestedPkg)) {
  process.exit(0);
}

const nestedVersion = JSON.parse(readFileSync(nestedPkg, "utf8")).version;
if (cmp(nestedVersion, FLOOR) >= 0) {
  process.exit(0);
}

const require = createRequire(import.meta.url);
let floorRoot;
try {
  floorRoot = dirname(require.resolve(`protobufjs/package.json`));
} catch {
  console.warn(
    `[sidecar] protobufjs-floor: nested protobufjs@${nestedVersion} is below ${FLOOR}, but no root protobufjs is installed to copy from`,
  );
  process.exit(0);
}

const floorVersion = JSON.parse(readFileSync(join(floorRoot, "package.json"), "utf8")).version;
if (cmp(floorVersion, FLOOR) < 0) {
  console.warn(
    `[sidecar] protobufjs-floor: root protobufjs@${floorVersion} is below floor ${FLOOR}; not replacing nested@${nestedVersion}`,
  );
  process.exit(0);
}

const dest = dirname(nestedPkg);
try {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(floorRoot, dest, { recursive: true });
  console.log(
    `[sidecar] protobufjs-floor: replaced nested protobufjs@${nestedVersion} with @${floorVersion} (CVE floor)`,
  );
} catch (err) {
  // Best-effort: never fail npm install over a locked/read-only node_modules tree.
  const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
  console.warn(
    `[sidecar] protobufjs-floor: failed to replace nested protobufjs@${nestedVersion} at ${dest}` +
      `${code ? ` (code=${code})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
  );
}
process.exit(0);
