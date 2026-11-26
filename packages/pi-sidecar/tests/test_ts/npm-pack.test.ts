import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SENTINEL_WHEEL = "pi_sidecar_client-0.0.0-sentinel.whl";
const SENTINEL_SDIST = "pi_sidecar_client-0.0.0-sentinel.tar.gz";
// Same compiler the package's `build` script runs ("build": "tsc").
const req = createRequire(import.meta.url);
const TSC = req.resolve("typescript/bin/tsc");
// Resolve hoisted node_modules via @types/node: typescript may be nested under
// packages/pi-sidecar/node_modules when another workspace hoists a newer TS.
const NODE_MODULES = join(dirname(req.resolve("@types/node/package.json")), "..", "..");

/**
 * Pack a scratch copy of the real package, built for real inside the fixture.
 *
 * packages/pi-sidecar/tsconfig.json emits into dist/ and `npm run typecheck`
 * (the tsc-typecheck pre-commit hook) runs it in parallel with this suite, so
 * packing the real package raced a concurrent build emitting dist/index.js
 * between npm pack's file listing and the existsSync below (issue #1137).
 * The fixture therefore builds src/ into its own dist/ (node_modules is
 * symlinked so the build resolves the same types) and never touches the
 * repo's dist/.
 */
function withFixturePackage(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-sidecar-npm-pack-"));
  try {
    // Packaging config comes from the repo (asserted byte-identical below).
    for (const name of ["package.json", ".npmignore", ".gitignore"]) {
      cpSync(join(PKG_DIR, name), join(dir, name));
      assert.deepEqual(
        readFileSync(join(dir, name)),
        readFileSync(join(PKG_DIR, name)),
        `${name} must be a faithful copy of the repo's`,
      );
    }
    for (const name of ["scripts", "src"]) {
      cpSync(join(PKG_DIR, name), join(dir, name), { recursive: true });
    }
    cpSync(join(PKG_DIR, "tsconfig.json"), join(dir, "tsconfig.json"));
    symlinkSync(NODE_MODULES, join(dir, "node_modules"), "junction");
    const build = spawnSync(process.execPath, [TSC, "-p", "tsconfig.json"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    for (const built of ["index.js", "server.js"] as const) {
      assert.ok(
        existsSync(join(dir, "dist", built)),
        `build must emit dist/${built} — packing a stub dist/ would prove nothing`,
      );
    }
    writeFileSync(join(dir, "dist", SENTINEL_WHEEL), "sentinel");
    writeFileSync(join(dir, "dist", SENTINEL_SDIST), "sentinel");
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

describe("package.json dependency hygiene (#1426)", () => {
  const FORBIDDEN_DEPS = [
    "pi-orchestrator-config",
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-web",
  ] as const;

  it("does not declare orchestrator or ML runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as Record<string, unknown>;
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      const deps = pkg[section] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const forbidden of FORBIDDEN_DEPS) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(deps, forbidden),
          false,
          `packages/pi-sidecar/package.json ${section} must not depend on ${forbidden}`,
        );
      }
    }
  });
});
