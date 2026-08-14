/**
 * Regression for #752: session_shutdown must reset `initialized` so the
 * providers factory re-enters discovery + registerProvider after /new|/resume|/fork.
 * Same-session double-load (cli/acpx shims + providers/) must still early-return.
 *
 * Imports session-shutdown / initialized-guard (not providers/index) to avoid
 * pulling @earendil-works/pi-ai under the node:test + tsx CJS path.
 *
 * Run: npx tsx --test tests/node/providers/initialized-reset.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ProviderDriverRegistry } from "../../../extensions/shared/provider-registry.js";
import {
  isProvidersInitialized,
  markProvidersInitialized,
  resetProvidersInitialized,
} from "../../../extensions/providers/initialized-guard.js";
import { teardownProvidersOnSessionShutdown } from "../../../extensions/providers/session-shutdown.js";

describe("providers initialized guard (#752)", () => {
  afterEach(() => {
    resetProvidersInitialized();
  });

  it("session_shutdown clears initialized so factory would not early-return", async () => {
    markProvidersInitialized();
    assert.equal(isProvidersInitialized(), true);

    const registry = new ProviderDriverRegistry();
    const cliInstances = new Map<string, unknown>([["cursor", {}]]);
    const acpxInstances = new Map<string, unknown>([["cursor", {}]]);

    await teardownProvidersOnSessionShutdown(
      registry,
      cliInstances,
      acpxInstances,
    );

    assert.equal(
      isProvidersInitialized(),
      false,
      "after shutdown, next default(pi) must re-enter discovery + registerProvider",
    );
    assert.equal(cliInstances.size, 0);
    assert.equal(acpxInstances.size, 0);
  });

  it("keeps initialized across same-session double-load without shutdown", () => {
    markProvidersInitialized();
    // cli-provider shim + acpx-provider shim + providers/ all call the same
    // default — guard must stay set until session_shutdown.
    assert.equal(isProvidersInitialized(), true);
    assert.equal(isProvidersInitialized(), true);
  });

  it("second shutdown while already cleared stays cleared", async () => {
    markProvidersInitialized();
    const registry = new ProviderDriverRegistry();
    const cliInstances = new Map<string, unknown>();
    const acpxInstances = new Map<string, unknown>();
    await teardownProvidersOnSessionShutdown(
      registry,
      cliInstances,
      acpxInstances,
    );
    await teardownProvidersOnSessionShutdown(
      registry,
      cliInstances,
      acpxInstances,
    );
    assert.equal(isProvidersInitialized(), false);
  });

  it("resets initialized in finally even if teardownAll throws", async () => {
    markProvidersInitialized();
    const registry = new ProviderDriverRegistry();
    const cliInstances = new Map<string, unknown>([["cursor", {}]]);
    const acpxInstances = new Map<string, unknown>([["claude", {}]]);
    const original = registry.teardownAll.bind(registry);
    registry.teardownAll = async () => {
      await original();
      throw new Error("teardown boom");
    };

    await assert.rejects(
      () =>
        teardownProvidersOnSessionShutdown(
          registry,
          cliInstances,
          acpxInstances,
        ),
      /teardown boom/,
    );

    assert.equal(
      isProvidersInitialized(),
      false,
      "guard must clear even when teardown fails",
    );
    assert.equal(cliInstances.size, 0);
    assert.equal(acpxInstances.size, 0);
  });
});
