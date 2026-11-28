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
import {
  formatMinPiVersionError,
  registerSessionValidation,
} from "../../../extensions/orchestrator/session-validation.ts";
import orchestratorExtension from "../../../extensions/orchestrator/index.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";


let cleanupFns: Array<() => void> = [];

/** Put a fake `pi` that prints `version` at the front of PATH for this test. */
function useFakePi(version: string): void {
  const binDir = makeTempDir("fake-pi-bin-");
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

describe("minimum Pi version", () => {
  it("requires Pi 1.7.0", () => {
    assert.equal(MIN_PI_VERSION, "1.7.0");
  });
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

  it("orders prereleases strictly below matching stable releases and ignores build metadata", () => {
    assert.equal(compareSemver("1.6.0-beta.1", "1.6.0"), -1);
    assert.equal(compareSemver("1.6.0", "1.6.0-beta.1"), 1);
    assert.equal(compareSemver("1.2.3-rc.1+build.7", "1.2.3"), -1);
    assert.equal(compareSemver("1.2.3+build.7", "1.2.3"), 0);
    assert.equal(compareSemver("1.6.1-alpha.1", "1.6.0"), 1);
    assert.equal(compareSemver("1.6.0-alpha.2", "1.6.0-alpha.10"), -1);
    assert.equal(compareSemver("1.6.0-alpha", "1.6.0-alpha.1"), -1);
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

  it("rejects older and prerelease versions of the floor while accepting exact and higher stable versions", () => {
    useFakePi("1.6.1");
    const older = checkMinPiVersion();
    assert.equal(older.installed, "1.6.1");
    assert.equal(older.required, "1.7.0");
    assert.equal(older.ok, false);

    useFakePi("1.7.0-beta.1");
    const pre = checkMinPiVersion();
    assert.equal(pre.installed, "1.7.0-beta.1");
    assert.equal(pre.required, "1.7.0");
    assert.equal(pre.ok, false);

    useFakePi("1.7.0");
    assert.equal(checkMinPiVersion().ok, true);

    useFakePi("1.7.1");
    assert.equal(checkMinPiVersion().ok, true);
  });

  it("marks installs below a custom floor as not ok", () => {
    useFakePi("0.0.1");
    const r = checkMinPiVersion("999.0.0");
    assert.equal(r.required, "999.0.0");
    assert.equal(r.installed, "0.0.1");
    assert.equal(r.ok, false);
  });
});

describe("formatMinPiVersionError", () => {
  it("includes installed version, required floor, pi update, and restart guidance", () => {
    const msg = formatMinPiVersionError({ installed: "1.6.1", required: "1.7.0" });
    assert.match(msg, /Pi >= 1\.7\.0/);
    assert.match(msg, /Pi 1\.6\.1/);
    assert.match(msg, /pi update/);
    assert.match(msg, /restart/i);
  });

  it("reports undetermined installed version with actionable upgrade guidance", () => {
    const msg = formatMinPiVersionError({ installed: null, required: "1.7.0" });
    assert.match(msg, /Pi >= 1\.7\.0/);
    assert.match(msg, /could not be determined/);
    assert.match(msg, /pi update/);
    assert.match(msg, /restart/i);
  });
});

describe("registerSessionValidation minimum Pi version enforcement", () => {
  function setupValidation(checkPiVersion: () => { ok: boolean; installed: string | null; required: string }) {
    let sessionStartHandler: ((event: unknown, ctx: any) => Promise<void>) | null = null;
    const mockPi = {
      registerCommand: () => {},
      on: (event: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
        if (event === "session_start") sessionStartHandler = handler;
      },
    };
    registerSessionValidation(mockPi as any, { checkPiVersion });
    assert.ok(sessionStartHandler, "session_start handler must be registered");
    return sessionStartHandler as (event: unknown, ctx: any) => Promise<void>;
  }

  it("notifies with error severity in interactive mode when Pi is below MIN_PI_VERSION", async () => {
    const handler = setupValidation(() => ({ ok: false, installed: "1.6.1", required: "1.7.0" }));
    const notices: Array<{ message: string; type: string }> = [];
    await handler({}, {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
    });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, "error");
    assert.match(notices[0].message, /Pi >= 1\.7\.0/);
    assert.match(notices[0].message, /Pi 1\.6\.1/);
    assert.match(notices[0].message, /pi update/);
  });

  it("throws an actionable error in headless mode when Pi is below MIN_PI_VERSION", async () => {
    const handler = setupValidation(() => ({ ok: false, installed: "1.6.1", required: "1.7.0" }));
    await assert.rejects(
      () => handler({}, { hasUI: false, cwd: process.cwd(), ui: { notify: () => {} } }),
      /Pi >= 1\.7\.0.*Pi 1\.6\.1.*pi update/,
    );
  });

  it("does not emit a version error when Pi meets MIN_PI_VERSION", async () => {
    const handler = setupValidation(() => ({ ok: true, installed: "1.7.0", required: "1.7.0" }));
    const notices: Array<{ message: string; type: string }> = [];
    await handler({}, {
      hasUI: false,
      cwd: process.cwd(),
      ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
    });
    assert.equal(notices.length, 0);
  });
});

describe("orchestrator extension load-time minimum Pi version guard", () => {
  it("throws a clear upgrade error before registering any Pi 1.7.0+ APIs when Pi is below MIN_PI_VERSION", () => {
    useFakePi("1.6.1");
    // Deliberately pass an empty mock API — if the guard did not fail fast,
    // registration would crash with a TypeError on missing Pi 1.7.0 APIs.
    assert.throws(
      () => orchestratorExtension({} as any),
      /pi-config requires Pi >= 1\.7\.0, but Pi 1\.6\.1 is installed.*pi update/,
    );
  });
});
