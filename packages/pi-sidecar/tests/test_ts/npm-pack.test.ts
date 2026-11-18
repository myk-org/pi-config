import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SENTINEL_WHEEL = "pi_sidecar_client-0.0.0-sentinel.whl";
const SENTINEL_SDIST = "pi_sidecar_client-0.0.0-sentinel.tar.gz";

/**
 * Pack a scratch copy of the real package with a dist/ this test owns.
 *
 * packages/pi-sidecar/tsconfig.json emits into dist/ and `npm run typecheck`
 * (the tsc-typecheck pre-commit hook) runs it in parallel with this suite, so
 * packing the real package raced a concurrent build emitting dist/index.js
 * between npm pack's file listing and the existsSync below (issue #1137).
 */
function withFixturePackage(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-sidecar-npm-pack-"));
  try {
    // Split by design: packaging config comes from the repo (asserted
    // byte-identical below), build output is a fixture, because the real dist/
    // is written by the parallel tsc-typecheck hook.
    for (const name of ["package.json", ".npmignore", ".gitignore"]) {
      cpSync(join(PKG_DIR, name), join(dir, name));
      assert.deepEqual(
        readFileSync(join(dir, name)),
        readFileSync(join(PKG_DIR, name)),
        `${name} must be a faithful copy of the repo's`,
      );
    }
    cpSync(join(PKG_DIR, "scripts"), join(dir, "scripts"), { recursive: true });
    const dist = join(dir, "dist");
    mkdirSync(dist);
    for (const built of ["index.js", "server.js"]) {
      writeFileSync(join(dist, built), "// built\n");
    }
    writeFileSync(join(dist, SENTINEL_WHEEL), "sentinel");
    writeFileSync(join(dist, SENTINEL_SDIST), "sentinel");
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function packedPaths(dir: string): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed: unknown = JSON.parse(result.stdout);
  const payload = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (payload as { files: Array<string | { path: string }> }).files;
  return files.map((entry) => (typeof entry === "string" ? entry : entry.path));
}

function assertPackedNodeContract(paths: string[]): void {
  assert.ok(paths.includes("package.json"), "npm pack must include package.json");
  for (const name of ["index.js", "server.js"] as const) {
    assert.ok(paths.includes(`dist/${name}`), `npm pack must include dist/${name} when built`);
  }
}

describe("npm pack excludes Python artifacts from dist/", () => {
  it("does not include dist/*.whl or dist/*.tar.gz even when they exist", () => {
    withFixturePackage((dir) => {
      const paths = packedPaths(dir);
      assertPackedNodeContract(paths);
      const leaked = paths.filter((path) => path.endsWith(".whl") || path.endsWith(".tar.gz"));
      assert.deepEqual(leaked, [], "npm pack must not ship PyPI wheels/sdists");
    });
  });

  it("postbuild strips dist/*.whl and dist/*.tar.gz", () => {
    withFixturePackage((dir) => {
      const result = spawnSync("npm", ["run", "postbuild"], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(join(dir, "dist", SENTINEL_WHEEL)), false);
      assert.equal(existsSync(join(dir, "dist", SENTINEL_SDIST)), false);
    });
  });

  it("postbuild keeps the built JS files", () => {
    withFixturePackage((dir) => {
      const result = spawnSync("npm", ["run", "postbuild"], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(join(dir, "dist", "index.js")), true, "postbuild must not strip dist/index.js");
    });
  });
});
