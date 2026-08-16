import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST_DIR = join(PKG_DIR, "dist");
const SENTINEL_WHEEL = join(DIST_DIR, "pi_sidecar_client-0.0.0-sentinel.whl");
const SENTINEL_SDIST = join(DIST_DIR, "pi_sidecar_client-0.0.0-sentinel.tar.gz");

function packedPaths(): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PKG_DIR,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed: unknown = JSON.parse(result.stdout);
  const payload = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (payload as { files: Array<string | { path: string }> }).files;
  return files.map((entry) => (typeof entry === "string" ? entry : entry.path));
}

function plantSentinels(): void {
  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(SENTINEL_WHEEL, "sentinel");
  writeFileSync(SENTINEL_SDIST, "sentinel");
}

function unlinkIfMissingOk(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") {
      throw err;
    }
  }
}

function removeSentinels(): void {
  unlinkIfMissingOk(SENTINEL_WHEEL);
  unlinkIfMissingOk(SENTINEL_SDIST);
}

function assertPackedNodeContract(paths: string[]): void {
  assert.ok(paths.includes("package.json"), "npm pack must include package.json");
  for (const name of ["index.js", "server.js"] as const) {
    if (existsSync(join(DIST_DIR, name))) {
      assert.ok(paths.includes(`dist/${name}`), `npm pack must include dist/${name} when built`);
    }
  }
}

describe("npm pack excludes Python artifacts from dist/", () => {
  it("does not include dist/*.whl or dist/*.tar.gz even when they exist", () => {
    plantSentinels();
    try {
      const paths = packedPaths();
      assertPackedNodeContract(paths);
      const leaked = paths.filter((path) => path.endsWith(".whl") || path.endsWith(".tar.gz"));
      assert.deepEqual(leaked, [], "npm pack must not ship PyPI wheels/sdists");
    } finally {
      removeSentinels();
    }
  });

  it("postbuild strips dist/*.whl and dist/*.tar.gz", () => {
    plantSentinels();
    try {
      const result = spawnSync("npm", ["run", "postbuild"], {
        cwd: PKG_DIR,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(SENTINEL_WHEEL), false);
      assert.equal(existsSync(SENTINEL_SDIST), false);
    } finally {
      removeSentinels();
    }
  });
});
