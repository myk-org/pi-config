/**
 * Tests for global acpx runtime loader memoization.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearAcpxRuntimeCache,
  loadAcpxRuntime,
} from "../../../extensions/acpx-provider/load-runtime.js";

describe("loadAcpxRuntime", () => {
  afterEach(() => {
    clearAcpxRuntimeCache();
  });

  it("memoizes successful resolution across calls", async () => {
    clearAcpxRuntimeCache();
    const a = loadAcpxRuntime();
    const b = loadAcpxRuntime();
    assert.equal(a, b);
    const mod = await a;
    assert.equal(typeof mod.createAcpRuntime, "function");
  });
});
