/**
 * Tests for pi version detection (utils.ts#getPiVersion / compareSemver /
 * checkMinPiVersion) — added after getPiVersion gained a directory-walk plus
 * `pi --version` CLI fallback (Qodo finding, PR #774).
 *
 * utils.ts imports only node builtins + shared/oneshot.js, so a direct import
 * is safe here (unlike async-agents.ts which pulls pi SDK internals).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_PI_VERSION,
  compareSemver,
  checkMinPiVersion,
  getPiVersion,
} from "../../../extensions/orchestrator/utils.ts";

describe("compareSemver", () => {
  it("orders patch releases", () => {
    assert.equal(compareSemver("0.84.2", "0.84.3"), -1);
    assert.equal(compareSemver("0.84.3", "0.84.2"), 1);
    assert.equal(compareSemver("0.84.3", "0.84.3"), 0);
  });

  it("orders minor and major releases", () => {
    assert.equal(compareSemver("0.83.9", "0.84.0"), -1);
    assert.equal(compareSemver("0.9.0", "1.0.0"), -1);
    assert.equal(compareSemver("2.0.0", "10.0.0"), -1);
  });

  it("strips prerelease/build metadata before comparing", () => {
    assert.equal(compareSemver("0.80.4-beta.1", "0.80.4"), 0);
    assert.equal(compareSemver("1.2.3-rc.1+build.7", "1.2.3"), 0);
  });

  it("pads missing components as zeros", () => {
    assert.equal(compareSemver("1.2", "1.2.0"), 0);
    assert.equal(compareSemver("1", "1.0.1"), -1);
  });
});

describe("checkMinPiVersion", () => {
  it("reports the required floor and a detected install", () => {
    const r = checkMinPiVersion();
    assert.equal(r.required, MIN_PI_VERSION);
    if (r.installed !== null) {
      assert.match(r.installed, /^\d+\.\d+\.\d+/);
      // Detected version must satisfy the floor in a healthy environment;
      // if it does not, ok must be false rather than silently true.
      assert.equal(r.ok, compareSemver(r.installed, MIN_PI_VERSION) >= 0);
    }
  });

  it("flags custom floors above the installed version", () => {
    const r = checkMinPiVersion("999.0.0");
    assert.equal(r.required, "999.0.0");
    if (r.installed !== null) assert.equal(r.ok, false);
  });
});

describe("getPiVersion", () => {
  it("returns null or a semver token (never garbage)", () => {
    const v = getPiVersion();
    if (v !== null) assert.match(v, /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/);
  });
});
