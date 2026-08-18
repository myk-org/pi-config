import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ensureSidecarPortEnv,
  resolveSidecarListenPort,
} from "../../src/sidecar-port.js";

describe("sidecar listen port env (#768 MCP)", () => {
  it("resolveSidecarListenPort prefers options.port over env", () => {
    assert.equal(resolveSidecarListenPort(9200, { SIDECAR_PORT: "9100" }), 9200);
  });

  it("resolveSidecarListenPort defaults to 9100 when env is unset", () => {
    assert.equal(resolveSidecarListenPort(undefined, {}), 9100);
  });

  it("resolveSidecarListenPort keeps explicit port 0 for ephemeral listen", () => {
    assert.equal(resolveSidecarListenPort(0, { SIDECAR_PORT: "9100" }), 0);
  });

  it("resolveSidecarListenPort falls back to 9100 for malformed SIDECAR_PORT", () => {
    assert.equal(resolveSidecarListenPort(undefined, { SIDECAR_PORT: "abc" }), 9100);
  });

  it("resolveSidecarListenPort falls back to 9100 for zero SIDECAR_PORT", () => {
    assert.equal(resolveSidecarListenPort(undefined, { SIDECAR_PORT: "0" }), 9100);
  });

  it("resolveSidecarListenPort falls back to 9100 for negative SIDECAR_PORT", () => {
    assert.equal(resolveSidecarListenPort(undefined, { SIDECAR_PORT: "-5" }), 9100);
  });

  it("resolveSidecarListenPort falls back to 9100 for invalid optionsPort", () => {
    assert.equal(resolveSidecarListenPort(-1, {}), 9100);
    assert.equal(resolveSidecarListenPort(Number.NaN, {}), 9100);
    assert.equal(resolveSidecarListenPort(Number.POSITIVE_INFINITY, {}), 9100);
  });

  it("ensureSidecarPortEnv writes SIDECAR_PORT for programmatic launches", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(resolveSidecarListenPort(9200, env), env);
    assert.equal(env.SIDECAR_PORT, "9200");
    release();
  });

  it("ensureSidecarPortEnv writes SIDECAR_PORT for the default port", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(resolveSidecarListenPort(undefined, env), env);
    assert.equal(env.SIDECAR_PORT, "9100");
    release();
  });

  it("ensureSidecarPortEnv stamps ephemeral 0 as a non-empty sidecar marker", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(0, env);
    assert.equal(env.SIDECAR_PORT, "0");
    release();
    assert.equal(env.SIDECAR_PORT, undefined);
  });

  it("ensureSidecarPortEnv restores inherited SIDECAR_PORT on release", () => {
    const env: NodeJS.ProcessEnv = { SIDECAR_PORT: "9100" };
    const release = ensureSidecarPortEnv(9200, env);
    assert.equal(env.SIDECAR_PORT, "9200");
    release();
    assert.equal(env.SIDECAR_PORT, "9100");
  });

  it("ensureSidecarPortEnv deletes SIDECAR_PORT when it was originally unset", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(9200, env);
    assert.equal(env.SIDECAR_PORT, "9200");
    release();
    assert.equal("SIDECAR_PORT" in env, false);
  });

  it("resolveSidecarListenPort ignores an active stamp so concurrent starts do not collide", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(9200, env);
    assert.equal(env.SIDECAR_PORT, "9200");
    assert.equal(resolveSidecarListenPort(undefined, env), 9100);
    release();
  });

  it("ensureSidecarPortEnv keeps a marker while concurrent sidecars remain", () => {
    const env: NodeJS.ProcessEnv = { SIDECAR_PORT: "9100" };
    const first = ensureSidecarPortEnv(9200, env);
    const second = ensureSidecarPortEnv(9300, env);
    assert.equal(env.SIDECAR_PORT, "9300");
    first();
    assert.equal(env.SIDECAR_PORT, "9300");
    second();
    assert.equal(env.SIDECAR_PORT, "9100");
  });

  it("ensureSidecarPortEnv release is idempotent", () => {
    const env: NodeJS.ProcessEnv = {};
    const release = ensureSidecarPortEnv(9200, env);
    release();
    release();
    assert.equal("SIDECAR_PORT" in env, false);
  });
});
