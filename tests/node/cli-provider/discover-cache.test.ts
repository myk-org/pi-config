/**
 * Tests for in-process PATH resolveBinary (no spawnSync which).
 *
 * Mutates process.env.PATH — run serially (concurrency: false) so parallel
 * cases cannot race the shared env / resolveBinaryCache.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateSuffixesFor,
  clearResolveBinaryCache,
  isExecutableForPlatform,
  isLaunchableWin32,
  parsePathext,
  resolveBinary,
  resolveBinaryForPlatform,
} from "../../../extensions/cli-provider/shared/discover-cache.js";

describe("resolveBinary", { concurrency: false }, () => {
  const prevPath = process.env.PATH;
  let tmpRoot: string | undefined;

  beforeEach(() => {
    clearResolveBinaryCache();
  });

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
    assert.equal(resolveBinary("no-such-cli-binary-xyz"), null);
  });

  it("finds executable on PATH with realpath when possible", () => {
    const dir = makeBinDir();
    const dest = join(dir, "fake-cli");
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = dir;
    const resolved = resolveBinary("fake-cli");
    assert.ok(resolved);
    assert.equal(resolved, realpathSync(dest));
  });

  it("returns null for non-executable file on PATH", () => {
    const dir = makeBinDir();
    const dest = join(dir, "not-exec");
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    process.env.PATH = dir;
    assert.equal(resolveBinary("not-exec"), null);
  });

  it("returns null when PATH candidate is a directory", () => {
    const dir = makeBinDir();
    const nested = join(dir, "agent");
    // Directory named like the binary — searchable (X_OK) but not a file
    mkdirSync(nested, { mode: 0o755 });
    process.env.PATH = dir;
    assert.equal(resolveBinary("agent"), null);
  });

  it("resolves absolute path without PATH lookup", () => {
    const dir = makeBinDir();
    const dest = join(dir, "abs-cli");
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = "";
    const resolved = resolveBinary(dest);
    assert.ok(resolved);
    assert.equal(resolved, realpathSync(dest));
  });

  it("caches successful resolve path", () => {
    const dir = makeBinDir();
    const dest = join(dir, "cached-cli");
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = dir;
    const first = resolveBinary("cached-cli");
    assert.equal(first, realpathSync(dest));
    assert.equal(resolveBinary("cached-cli"), first);
  });

  it("invalidates cached resolve when binary is removed", () => {
    const dir = makeBinDir();
    const dest = join(dir, "cached-cli");
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = dir;
    assert.equal(resolveBinary("cached-cli"), realpathSync(dest));
    rmSync(dest);
    assert.equal(resolveBinary("cached-cli"), null);
  });

  it("rediscovers binary after miss when reinstalled on same PATH", () => {
    const dir = makeBinDir();
    const dest = join(dir, "cached-cli");
    process.env.PATH = dir;
    assert.equal(resolveBinary("cached-cli"), null);
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(resolveBinary("cached-cli"), realpathSync(dest));
  });
});

describe("win32 launchability helpers", () => {
  it("parsePathext normalizes extensions to uppercase with dots", () => {
    assert.deepEqual(parsePathext(".exe;.Cmd;.BAT"), [".EXE", ".CMD", ".BAT"]);
  });

  it("isLaunchableWin32 rejects extensionless paths", () => {
    assert.equal(isLaunchableWin32("C:\\tools\\agent", ".EXE;.CMD"), false);
  });

  it("isLaunchableWin32 accepts PATHEXT extension", () => {
    assert.equal(isLaunchableWin32("C:\\tools\\agent.exe", ".EXE;.CMD"), true);
    assert.equal(isLaunchableWin32("C:\\tools\\agent.CMD", ".EXE;.CMD"), true);
  });

  it("isLaunchableWin32 rejects non-PATHEXT extension", () => {
    assert.equal(isLaunchableWin32("C:\\tools\\agent.txt", ".EXE;.CMD"), false);
  });

  it("candidateSuffixesFor win32 uses PATHEXT only for bare names", () => {
    assert.deepEqual(
      candidateSuffixesFor("agent", "win32", ".EXE;.CMD"),
      [".EXE", ".CMD"],
    );
  });

  it("candidateSuffixesFor win32 keeps as-is when binary has PATHEXT ext", () => {
    assert.deepEqual(
      candidateSuffixesFor("agent.exe", "win32", ".EXE;.CMD"),
      [""],
    );
  });

  it("candidateSuffixesFor non-win32 uses empty suffix only", () => {
    assert.deepEqual(candidateSuffixesFor("agent", "linux"), [""]);
  });
});

describe("resolveBinaryForPlatform win32", { concurrency: false }, () => {
  let tmpRoot: string | undefined;

  beforeEach(() => {
    clearResolveBinaryCache();
  });

  afterEach(() => {
    clearResolveBinaryCache();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  function makeBinDir(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), "resolve-win-"));
    return tmpRoot;
  }

  it("rejects extensionless agent file on win32 PATH", () => {
    const dir = makeBinDir();
    const dest = join(dir, "agent");
    writeFileSync(dest, "fake\n", { mode: 0o755 });
    assert.equal(
      resolveBinaryForPlatform("agent", "win32", {
        PATH: dir,
        PATHEXT: ".EXE;.CMD;.BAT",
      }),
      null,
    );
    assert.equal(
      isExecutableForPlatform(dest, "win32", ".EXE;.CMD;.BAT"),
      false,
    );
  });

  it("rejects extensionless absolute path on win32", () => {
    const dir = makeBinDir();
    const dest = join(dir, "agent");
    writeFileSync(dest, "fake\n", { mode: 0o755 });
    assert.equal(
      resolveBinaryForPlatform(dest, "win32", {
        PATH: "",
        PATHEXT: ".EXE;.CMD",
      }),
      null,
    );
  });

  it("resolves agent.exe via PATHEXT suffix on win32", () => {
    const dir = makeBinDir();
    const dest = join(dir, "agent.exe");
    writeFileSync(dest, "fake\n", { mode: 0o644 });
    const resolved = resolveBinaryForPlatform("agent", "win32", {
      PATH: dir,
      PATHEXT: ".EXE;.CMD",
    });
    assert.ok(resolved);
    assert.equal(resolved, realpathSync(dest));
  });

  it("prefers PATHEXT candidate over extensionless sibling on win32", () => {
    const dir = makeBinDir();
    const bare = join(dir, "agent");
    const withExt = join(dir, "agent.exe");
    writeFileSync(bare, "bare\n", { mode: 0o755 });
    writeFileSync(withExt, "exe\n", { mode: 0o644 });
    const resolved = resolveBinaryForPlatform("agent", "win32", {
      PATH: dir,
      PATHEXT: ".EXE;.CMD",
    });
    assert.equal(resolved, realpathSync(withExt));
  });
});
