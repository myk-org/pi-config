import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface PackFile {
  path: string;
}

interface PackResult {
  files: PackFile[];
}

function runRootNpmPackJson(): ReturnType<typeof spawnSync> {
  return spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO_DIR,
    encoding: "utf8",
  });
}

describe("root npm pack JSON output", () => {
  it("keeps stdout parseable JSON", () => {
    const result = runRootNpmPackJson();

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotThrow(() => JSON.parse(result.stdout), result.stdout);
  });

  it("reports UI build diagnostics on stderr", () => {
    const result = runRootNpmPackJson();

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /Building extensions\/pidash\/pidash-ui/);
  });

  it("lists required runtime and built UI files", () => {
    const result = runRootNpmPackJson();

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload: unknown = JSON.parse(result.stdout);
    const pack = (Array.isArray(payload) ? payload[0] : payload) as PackResult;
    const paths = pack.files.map(({ path }) => path);
    for (const requiredPath of [
      "package.json",
      "extensions/pidash/pidash.ts",
      "extensions/pidiff/pidiff.ts",
      "extensions/pidash/pidash-ui/dist/index.html",
      "extensions/pidiff/pidiff-ui/dist/index.html",
    ]) {
      assert.ok(paths.includes(requiredPath), `npm pack must include ${requiredPath}`);
    }
  });
});
