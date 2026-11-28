import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  MIN_PI_VERSION,
  assertPiVersionFloor,
  compareVersions,
  extractPiVersionToken,
  getInstalledPiVersion,
} from "../../src/pi-version.js";

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    assert.equal(compareVersions("0.81.1", "0.81.1"), 0);
  });

  it("returns negative when a < b (patch)", () => {
    assert.ok(compareVersions("0.81.0", "0.81.1") < 0);
  });

  it("returns positive when a > b (patch)", () => {
    assert.ok(compareVersions("0.81.2", "0.81.1") > 0);
  });

  it("returns negative when a < b (minor)", () => {
    assert.ok(compareVersions("0.80.9", "0.81.0") < 0);
  });

  it("returns positive when a > b (major)", () => {
    assert.ok(compareVersions("1.0.0", "0.81.1") > 0);
  });

  it("treats prerelease/build suffixes as unparsable (fail-closed for floor)", () => {
    // Strict x.y.z only — prereleases must not satisfy MIN_PI_VERSION via compare.
    assert.equal(compareVersions("0.81.1-beta.1", "0.81.0"), 0);
    assert.equal(compareVersions("0.81.1+build.1", "0.81.1"), 0);
  });

  it("treats unparsable versions as equal (does not throw)", () => {
    // compareVersions stays permissive for advisory callers; assertPiVersionFloor
    // separately rejects unparsable installed versions (fail-closed).
    assert.equal(compareVersions("not-a-version", "0.81.1"), 0);
    assert.equal(compareVersions("0.81.1", "also-not-a-version"), 0);
  });
});

describe("getInstalledPiVersion", () => {
  it("resolves the installed @earendil-works/pi-coding-agent version", () => {
    const version = getInstalledPiVersion();
    assert.ok(version, "should resolve a version string");
    assert.match(version!, /^\d+\.\d+\.\d+/);
  });
});

describe("extractPiVersionToken", () => {
  it("preserves prerelease and build suffixes from pi --version output", () => {
    assert.equal(extractPiVersionToken("pi 0.81.1-beta.1"), "0.81.1-beta.1");
    assert.equal(extractPiVersionToken("0.81.1+build.9"), "0.81.1+build.9");
    assert.equal(extractPiVersionToken("version: 0.81.1"), "0.81.1");
  });

  it("returns null when no semver token is present", () => {
    assert.equal(extractPiVersionToken("not a version"), null);
  });
});

describe("MIN_PI_VERSION", () => {
  it("requires Pi 1.7.0", () => {
    assert.equal(MIN_PI_VERSION, "1.7.0");
  });

  it("is a valid x.y.z version string", () => {
    assert.match(MIN_PI_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it("matches the pi-config orchestrator floor", function () {
    // True sync check — parse the shared floor constant instead of duplicating
    // a literal here (a hardcoded string would silently tolerate drift).
    const sharedSrc = new URL("../../../../extensions/shared/pi-version.ts", import.meta.url);
    if (!fs.existsSync(sharedSrc)) {
      // Published tarballs ship only packages/ — extension source is a
      // monorepo-only artifact, so cross-package sync cannot be verified there.
      this.skip();
    }
    const m = fs.readFileSync(sharedSrc, "utf8").match(/MIN_PI_VERSION = "([^\"]+)"/);
    assert.ok(m, "MIN_PI_VERSION not found in extensions/shared/pi-version.ts");
    assert.equal(MIN_PI_VERSION, m[1]);
  });
});

describe("assertPiVersionFloor", () => {
  it("requires the installed SDK to meet the 1.7.0 floor", () => {
    // This environment may intentionally retain an older SDK. The package
    // metadata enforces the floor for consumers; exercise the comparator here.
    const installed = getInstalledPiVersion();
    assert.ok(installed, "precondition: installed version must resolve");
    assert.equal(compareVersions("0.86.9", MIN_PI_VERSION) < 0, true);
    assert.equal(compareVersions("1.7.0", MIN_PI_VERSION) >= 0, true);
    assert.equal(compareVersions("1.6.1", MIN_PI_VERSION) >= 0, false);
    if (compareVersions(installed!, MIN_PI_VERSION) >= 0) {
      assert.doesNotThrow(() => assertPiVersionFloor());
    } else {
      assert.throws(() => assertPiVersionFloor(), new RegExp(`below the required floor ${MIN_PI_VERSION}`));
    }
  });

  it("recommends a targeted @earendil-works/pi-coding-agent npm upgrade rather than global pi update or deleting lockfiles", () => {
    const source = fs.readFileSync(new URL("../../src/pi-version.ts", import.meta.url), "utf8");
    const sdkThrowBlock = source.slice(
      source.indexOf("if (compareVersions(installed, MIN_PI_VERSION) < 0)"),
      source.indexOf("PI_VERSION_CHECK_OK"),
    );
    assert.match(sdkThrowBlock, /npm install @earendil-works\/pi-coding-agent@\^\$\{MIN_PI_VERSION\}/);
    assert.doesNotMatch(sdkThrowBlock, /pi update/);
    assert.doesNotMatch(sdkThrowBlock, /package-lock\.json/);
  });

  it("keeps pi-version.ts free of SDK runtime imports so floor checks precede ESM linking", () => {
    const source = fs.readFileSync(new URL("../../src/pi-version.ts", import.meta.url), "utf8");
    assert.ok(!source.includes("provider-runtime"), "pi-version.ts must not import provider-runtime");
    assert.ok(!source.includes('from "@earendil-works/'), "pi-version.ts must not statically import Pi SDK packages");
  });
});
