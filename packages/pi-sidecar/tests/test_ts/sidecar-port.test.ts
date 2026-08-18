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

  it("ensureSidecarPortEnv writes SIDECAR_PORT for programmatic launches", () => {
    const env: NodeJS.ProcessEnv = {};
    ensureSidecarPortEnv(resolveSidecarListenPort(9200, env), env);
    assert.equal(env.SIDECAR_PORT, "9200");
  });

  it("ensureSidecarPortEnv writes SIDECAR_PORT for the default port", () => {
    const env: NodeJS.ProcessEnv = {};
    ensureSidecarPortEnv(resolveSidecarListenPort(undefined, env), env);
    assert.equal(env.SIDECAR_PORT, "9100");
  });
});
