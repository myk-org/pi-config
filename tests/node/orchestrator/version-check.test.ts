/**
 * Tests for process-authoritative Pi version detection and enforcement
 * (`extensions/shared/pi-version.ts` + `extensions/orchestrator/session-validation.ts`
 * + standalone extension entrypoints).
 *
 * Hermetic by construction: never depends on any host `pi` binary on PATH.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import {
  MIN_PI_VERSION,
  assertMinPiVersionOnLoad,
  compareSemver,
  checkMinPiVersion,
  formatMinPiVersionError,
  getPiVersion,
  resetPiVersionCache,
  setPiVersionResolverForTests,
} from "../../../extensions/orchestrator/utils.ts";
import { registerSessionValidation } from "../../../extensions/orchestrator/session-validation.ts";
import orchestratorExtension from "../../../extensions/orchestrator/index.ts";
import comsExtension from "../../../extensions/coms/index.ts";
import comsP2pExtension from "../../../extensions/coms/coms-p2p.ts";
import discoveryExtension from "../../../extensions/openai-compatible-discovery/index.ts";
import pitasksExtension from "../../../extensions/pitasks/index.ts";
import pidashExtension from "../../../extensions/pidash/index.ts";
import pidiffExtension from "../../../extensions/pidiff/index.ts";
import providersExtension from "../../../extensions/providers/index.ts";
import reloadFlagExtension from "../../../extensions/reload-flag/index.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

let cleanupFns: Array<() => void> = [];

/** Create a fake `@earendil-works/pi-coding-agent` package directory with a CLI script. */
function makeFakePiPackage(version: string): { pkgDir: string; cliPath: string } {
  const pkgDir = makeTempDir("fake-pi-pkg-");
  const distDir = path.join(pkgDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
    "utf-8",
  );
  const cliPath = path.join(distDir, "cli.js");
  fs.writeFileSync(cliPath, "// fake pi cli\n", "utf-8");
  cleanupFns.push(() => fs.rmSync(pkgDir, { recursive: true, force: true }));
  return { pkgDir, cliPath };
}

/** Put an unrelated fake `pi` binary reporting `version` at the front of PATH. */
function putStalePiOnPath(version: string): void {
  const binDir = makeTempDir("stale-pi-path-");
  const script = path.join(binDir, "pi");
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  const prevPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
  cleanupFns.push(() => {
    process.env.PATH = prevPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });
}

afterEach(() => {
  resetPiVersionCache();
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

  it("orders prereleases strictly below matching stable releases", () => {
    assert.equal(compareSemver("1.6.0-beta.1", "1.6.0"), -1);
    assert.equal(compareSemver("1.6.0", "1.6.0-beta.1"), 1);
    assert.equal(compareSemver("1.6.1-alpha.1", "1.6.0"), 1);
    assert.equal(compareSemver("1.6.0-alpha.2", "1.6.0-alpha.10"), -1);
    assert.equal(compareSemver("1.6.0-alpha", "1.6.0-alpha.1"), -1);
  });

  it("ignores semver build metadata during precedence comparison", () => {
    assert.equal(compareSemver("1.2.3-rc.1+build.7", "1.2.3"), -1);
    assert.equal(compareSemver("1.2.3+build.7", "1.2.3"), 0);
  });

  it("pads missing components as zeros", () => {
    assert.equal(compareSemver("1.2", "1.2.0"), 0);
    assert.equal(compareSemver("1", "1.0.1"), -1);
  });
});

describe("getPiVersion (process-authoritative & cached)", () => {
  it("resolves version from PI_PACKAGE_DIR when present", () => {
    const { pkgDir } = makeFakePiPackage("2.3.4");
    assert.equal(
      getPiVersion({ packageDir: pkgDir, argv1: null, runtimeModuleVersion: "1.7.0" }),
      "2.3.4",
    );
  });

  it("resolves version from argv[1] package root", () => {
    const { cliPath } = makeFakePiPackage("1.8.2");
    assert.equal(
      getPiVersion({ packageDir: null, argv1: cliPath, runtimeModuleVersion: "1.7.0" }),
      "1.8.2",
    );
  });

  it("ignores an unrelated stale pi binary on PATH when running Pi 1.7.0 through a wrapper", async () => {
    const wrapperDir = makeTempDir("pi-wrapper-170-");
    const wrapperPath = path.join(wrapperDir, "custom-pi-wrapper.js");
    const fakePiModule = path.join(wrapperDir, "fake-pi-170.mjs");
    fs.writeFileSync(wrapperPath, "// wrapper without @earendil-works/pi-coding-agent package.json\n", "utf-8");
    fs.writeFileSync(fakePiModule, 'export const VERSION = "1.7.0";\n', "utf-8");
    cleanupFns.push(() => fs.rmSync(wrapperDir, { recursive: true, force: true }));

    putStalePiOnPath("1.5.0");

    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { "@earendil-works/pi-coding-agent": fakePiModule },
    });
    const loaded = (await jiti.import(
      path.resolve("extensions/shared/pi-version.ts"),
    )) as typeof import("../../../extensions/shared/pi-version.ts");

    assert.equal(loaded.getPiVersion({ packageDir: null, argv1: wrapperPath }), "1.7.0");
    assert.equal(loaded.checkMinPiVersion(MIN_PI_VERSION, { packageDir: null, argv1: wrapperPath }).ok, true);
  });

  it("rejects an older host Pi via jiti alias even when local node_modules has Pi 1.7.0", async () => {
    const wrapperDir = makeTempDir("pi-wrapper-161-");
    const wrapperPath = path.join(wrapperDir, "custom-pi-wrapper.js");
    const fakeOlderPiModule = path.join(wrapperDir, "fake-pi-161.mjs");
    fs.writeFileSync(wrapperPath, "// wrapper without @earendil-works/pi-coding-agent package.json\n", "utf-8");
    fs.writeFileSync(fakeOlderPiModule, 'export const VERSION = "1.6.1";\n', "utf-8");
    cleanupFns.push(() => fs.rmSync(wrapperDir, { recursive: true, force: true }));

    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { "@earendil-works/pi-coding-agent": fakeOlderPiModule },
    });
    const loaded = (await jiti.import(
      path.resolve("extensions/shared/pi-version.ts"),
    )) as typeof import("../../../extensions/shared/pi-version.ts");

    assert.equal(loaded.getPiVersion({ packageDir: null, argv1: wrapperPath }), "1.6.1");
    assert.throws(
      () => loaded.assertMinPiVersionOnLoad("wrapper-ext", { packageDir: null, argv1: wrapperPath }),
      /pi-config requires Pi >= 1\.7\.0, but Pi 1\.6\.1 is installed/,
    );
  });

  it("does not fall back to extension-local node_modules when argv[1] misses outside Pi's loader", () => {
    const wrapperDir = makeTempDir("pi-wrapper-nolocal-");
    const wrapperPath = path.join(wrapperDir, "custom-pi-wrapper.js");
    fs.writeFileSync(wrapperPath, "// wrapper without package.json\n", "utf-8");
    cleanupFns.push(() => fs.rmSync(wrapperDir, { recursive: true, force: true }));

    putStalePiOnPath("9.9.9");
    // In native ESM (outside Pi's jiti loader), neither PI_PACKAGE_DIR nor argv[1] matches,
    // so local node_modules/@earendil-works/pi-coding-agent (1.7.0) must NOT be treated as the host Pi.
    assert.equal(getPiVersion({ packageDir: null, argv1: wrapperPath }), null);
  });

  it("caches the resolved version per process until resetPiVersionCache() is called", () => {
    const prevPkgDir = process.env.PI_PACKAGE_DIR;
    const { pkgDir: firstPkg } = makeFakePiPackage("1.7.5");
    const { pkgDir: secondPkg } = makeFakePiPackage("1.6.0");
    cleanupFns.push(() => {
      if (prevPkgDir === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = prevPkgDir;
    });

    process.env.PI_PACKAGE_DIR = firstPkg;
    resetPiVersionCache();
    assert.equal(getPiVersion(), "1.7.5");

    // Mutating env after first lookup must still return the cached process value.
    process.env.PI_PACKAGE_DIR = secondPkg;
    assert.equal(getPiVersion(), "1.7.5");

    // After resetting cache, the new env value is picked up.
    resetPiVersionCache();
    assert.equal(getPiVersion(), "1.6.0");
  });
});

describe("checkMinPiVersion", () => {
  it("reports the configured floor as required", () => {
    setPiVersionResolverForTests(() => "4.5.6");
    assert.equal(checkMinPiVersion().required, MIN_PI_VERSION);
  });

  it("marks installs at or above the floor as ok", () => {
    setPiVersionResolverForTests(() => "99.0.0");
    const r = checkMinPiVersion();
    assert.equal(r.installed, "99.0.0");
    assert.equal(r.ok, true);
  });

  it("rejects an older stable version below the floor", () => {
    setPiVersionResolverForTests(() => "1.6.1");
    const older = checkMinPiVersion();
    assert.equal(older.installed, "1.6.1");
    assert.equal(older.required, "1.7.0");
    assert.equal(older.ok, false);
  });

  it("rejects a prerelease of the floor version", () => {
    setPiVersionResolverForTests(() => "1.7.0-beta.1");
    const pre = checkMinPiVersion();
    assert.equal(pre.installed, "1.7.0-beta.1");
    assert.equal(pre.required, "1.7.0");
    assert.equal(pre.ok, false);
  });

  it("rejects an undetermined running version", () => {
    setPiVersionResolverForTests(() => null);
    const unknown = checkMinPiVersion();
    assert.equal(unknown.installed, null);
    assert.equal(unknown.required, "1.7.0");
    assert.equal(unknown.ok, false);
  });

  it("accepts the exact floor version", () => {
    setPiVersionResolverForTests(() => "1.7.0");
    assert.equal(checkMinPiVersion().ok, true);
  });

  it("accepts a newer stable version above the floor", () => {
    setPiVersionResolverForTests(() => "1.7.1");
    assert.equal(checkMinPiVersion().ok, true);
  });

  it("marks installs below a custom floor as not ok", () => {
    setPiVersionResolverForTests(() => "0.0.1");
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

  it("reports undetermined running version with actionable upgrade guidance", () => {
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

  it("notifies with error severity in interactive mode when running Pi version is undetermined", async () => {
    const handler = setupValidation(() => ({ ok: false, installed: null, required: "1.7.0" }));
    const notices: Array<{ message: string; type: string }> = [];
    await handler({}, {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
    });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, "error");
    assert.match(notices[0].message, /could not be determined/);
  });

  it("throws an actionable error in headless mode when running Pi version is undetermined", async () => {
    const handler = setupValidation(() => ({ ok: false, installed: null, required: "1.7.0" }));
    await assert.rejects(
      () => handler({}, { hasUI: false, cwd: process.cwd(), ui: { notify: () => {} } }),
      /Pi >= 1\.7\.0.*could not be determined.*pi update/,
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

describe("load-time minimum Pi version guard across all standalone extensions", () => {
  const standaloneEntrypoints: Array<[string, (pi: any) => unknown]> = [
    ["orchestrator", (pi) => orchestratorExtension(pi)],
    ["coms", (pi) => comsExtension(pi)],
    ["coms-p2p", (pi) => comsP2pExtension(pi)],
    ["openai-compatible-discovery", (pi) => discoveryExtension(pi)],
    ["pitasks", (pi) => pitasksExtension(pi)],
    ["pidash", (pi) => pidashExtension(pi)],
    ["pidiff", (pi) => pidiffExtension(pi)],
    ["providers", (pi) => providersExtension(pi, { argv: ["node", "pi"] })],
    ["reload-flag", (pi) => reloadFlagExtension(pi)],
  ];

  for (const [name, loadExtension] of standaloneEntrypoints) {
    it(`${name}: throws a clear upgrade error before calling Pi 1.7.0 APIs when Pi is 1.6.1`, () => {
      setPiVersionResolverForTests(() => "1.6.1");
      // Empty mock API proves the guard runs BEFORE any missing Pi 1.7.0 API TypeError.
      assert.throws(
        () => loadExtension({}),
        /pi-config requires Pi >= 1\.7\.0, but Pi 1\.6\.1 is installed.*pi update/,
      );
    });

    it(`${name}: fails closed with a clear upgrade error when running Pi version is undetermined`, () => {
      setPiVersionResolverForTests(() => null);
      assert.throws(
        () => loadExtension({}),
        /pi-config requires Pi >= 1\.7\.0, but the running Pi version could not be determined.*pi update/,
      );
    });
  }

  it("assertMinPiVersionOnLoad succeeds cleanly when running Pi meets MIN_PI_VERSION", () => {
    setPiVersionResolverForTests(() => "1.7.0");
    assert.doesNotThrow(() => assertMinPiVersionOnLoad("test-ext"));
  });
});
