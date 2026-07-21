/**
 * Tests for in-process PATH resolveBinary (no spawnSync which).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResolveBinaryCache,
  resolveBinary,
} from "../../../extensions/cli-provider/shared/discover-cache.js";

describe("resolveBinary", () => {
  const prevPath = process.env.PATH;
  let tmpRoot: string | undefined;

  afterEach(() => {
    process.env.PATH = prevPath;
    clearResolveBinaryCache();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  function makeBinDir(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), "resolve-bin-"));
    return tmpRoot;
  }

  it("returns null when binary missing from PATH", () => {
    const dir = makeBinDir();
    process.env.PATH = dir;
    clearResolveBinaryCache();
    assert.equal(resolveBinary("no-such-cli-binary-xyz"), null);
  });

  it("finds executable on PATH with realpath when possible", () => {
    const dir = makeBinDir();
    const dest = join(dir, "fake-cli");
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = dir;
    clearResolveBinaryCache();
    const resolved = resolveBinary("fake-cli");
    assert.ok(resolved);
    assert.equal(resolved, realpathSync(dest));
  });

  it("returns null for non-executable file on PATH", () => {
    const dir = makeBinDir();
    const dest = join(dir, "not-exec");
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    process.env.PATH = dir;
    clearResolveBinaryCache();
    assert.equal(resolveBinary("not-exec"), null);
  });

  it("resolves absolute path without PATH lookup", () => {
    const dir = makeBinDir();
    const dest = join(dir, "abs-cli");
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = "";
    clearResolveBinaryCache();
    const resolved = resolveBinary(dest);
    assert.ok(resolved);
    assert.equal(resolved, realpathSync(dest));
  });

  it("caches by binary name + PATH string", () => {
    const dir = makeBinDir();
    const dest = join(dir, "cached-cli");
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = dir;
    clearResolveBinaryCache();
    const first = resolveBinary("cached-cli");
    rmSync(dest);
    // Same PATH → negative re-validate drops stale positive, then miss caches null
    assert.equal(resolveBinary("cached-cli"), null);
    // Restore + same PATH still has null cached until PATH changes or clear
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(resolveBinary("cached-cli"), null);
    process.env.PATH = `${dir}:/usr/bin`;
    assert.equal(resolveBinary("cached-cli"), realpathSync(dest));
    assert.equal(first, realpathSync(dest));
  });
});
