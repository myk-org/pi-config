/**
 * Tests for pi version detection (utils.ts#getPiVersion / compareSemver /
 * checkMinPiVersion).
 *
 * Hermetic by construction: the `pi --version` CLI fallback is exercised
 * against a throwaway fake `pi` on an isolated PATH, so results never depend
 * on the host's global pi installation (Qodo finding, PR #774 cycle 2).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MIN_PI_VERSION,
  compareSemver,
  checkMinPiVersion,
  getPiVersion,
} from "../../../extensions/orchestrator/utils.ts";

let cleanupFns: Array<() => void> = [];

/** Put a fake `pi` that prints `version` at the front of PATH for this test. */
function useFakePi(version: string): void {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-bin-"));
  const script = path.join(binDir, "pi");
  fs.writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
    { mode: 0o755 },
  );
  const prevPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
  cleanupFns.push(() => {
    process.env.PATH = prevPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });
}

function useEmptyPath(): void {
  const prevPath = process.env.PATH ?? "";
  process.env.PATH = "";
  cleanupFns.push(() => {
    process.env.PATH = prevPath;
  });
}

afterEach(() => {
  for (const fn of cleanupFns.reverse()) {
    try { fn(); } catch {}
  }
  cleanupFns = [];
});

describe("compareSemver", () => {
  it("orders patch releases", () => {
    assert.equal(compareSemver("0.84.2", "0.84.3"), -1);
    assert.equal(compareSemver("0.84.3", "0.84.2"), 1);
    assert.equal(compareSemver("0.84.3", "0.84.3"), 0);
  });

  it("orders minor releases", () => {
    assert.equal(compareSemver("0.83.9", "0.84.0"), -1);
    assert.equal(compareSemver("0.9.0", "1.0.0"), -1);
  });

  it("orders major releases numerically", () => {
    assert.equal(compareSemver("2.0.0", "10.0.0"), -1);
  });

  it("strips prerelease metadata before comparing", () => {
    assert.equal(compareSemver("0.80.4-beta.1", "0.80.4"), 0);
    assert.equal(compareSemver("1.2.3-rc.1+build.7", "1.2.3"), 0);
  });

  it("pads missing components as zeros", () => {
    assert.equal(compareSemver("1.2", "1.2.0"), 0);
    assert.equal(compareSemver("1", "1.0.1"), -1);
  });
});

describe("getPiVersion", () => {
  it("returns the version reported by pi on PATH", () => {
    useFakePi("4.5.6");
    assert.equal(getPiVersion(), "4.5.6");
  });

  it("returns null when no pi is reachable", () => {
    useEmptyPath();
    assert.equal(getPiVersion(), null);
  });
});

describe("checkMinPiVersion", () => {
  it("reports the configured floor as required", () => {
    useFakePi("4.5.6");
    assert.equal(checkMinPiVersion().required, MIN_PI_VERSION);
  });

  it("marks installs at or above the floor as ok", () => {
    useFakePi("99.0.0");
    const r = checkMinPiVersion();
    assert.equal(r.installed, "99.0.0");
    assert.equal(r.ok, true);
  });

  it("marks installs below a custom floor as not ok", () => {
    useFakePi("0.0.1");
    const r = checkMinPiVersion("999.0.0");
    assert.equal(r.required, "999.0.0");
    assert.equal(r.installed, "0.0.1");
    assert.equal(r.ok, false);
  });
});
