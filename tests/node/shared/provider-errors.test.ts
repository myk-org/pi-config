import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderDriverError, ProviderProbeError, ProviderValidationError,
  ProviderInstanceNotFoundError, ProviderAdapterValidationError,
  ProviderAdapterSessionNotFoundError, ProviderAdapterSessionClosedError,
  ProviderAdapterRequestError, ProviderAdapterProcessError,
  buildUnavailableSnapshot,
} from "../../../extensions/shared/provider-errors.js";

describe("provider-errors", () => {
  it("ProviderDriverError has correct tag with populated fields", () => {
    const err = new ProviderDriverError({ driver: "cursor-cli", instanceId: "cli-cursor", detail: "binary not found" });
    assert.equal(err.tag, "ProviderDriverError");
    assert.equal(err.driver, "cursor-cli");
    assert.ok(err.message.includes("cursor-cli"));
    assert.ok(err instanceof Error);
  });
  it("ProviderDriverError carries cause", () => {
    const cause = new Error("root");
    assert.equal(new ProviderDriverError({ driver: "d", instanceId: "i", detail: "x", cause }).cause, cause);
  });
  it("ProviderProbeError has correct tag", () => {
    assert.equal(new ProviderProbeError({ driver: "claude-cli", detail: "not on PATH" }).tag, "ProviderProbeError");
  });
  it("ProviderValidationError has correct tag", () => {
    assert.equal(new ProviderValidationError({ operation: "configDecode", issue: "missing" }).tag, "ProviderValidationError");
  });
  it("ProviderInstanceNotFoundError has correct tag", () => {
    assert.equal(new ProviderInstanceNotFoundError({ instanceId: "cli-cursor" }).tag, "ProviderInstanceNotFoundError");
  });
  it("ProviderAdapterValidationError has correct tag", () => {
    assert.equal(new ProviderAdapterValidationError({ provider: "p", operation: "o", issue: "i" }).tag, "ProviderAdapterValidationError");
  });
  it("ProviderAdapterSessionNotFoundError has correct tag", () => {
    assert.equal(new ProviderAdapterSessionNotFoundError({ provider: "p", sessionId: "s" }).tag, "ProviderAdapterSessionNotFoundError");
  });
  it("ProviderAdapterSessionClosedError has correct tag", () => {
    assert.equal(new ProviderAdapterSessionClosedError({ provider: "p", sessionId: "s" }).tag, "ProviderAdapterSessionClosedError");
  });
  it("ProviderAdapterRequestError has correct tag", () => {
    assert.equal(new ProviderAdapterRequestError({ provider: "p", method: "m", detail: "d" }).tag, "ProviderAdapterRequestError");
  });
  it("ProviderAdapterProcessError has correct tag", () => {
    assert.equal(new ProviderAdapterProcessError({ provider: "p", sessionId: "s", detail: "d" }).tag, "ProviderAdapterProcessError");
  });
  it("all 9 error types have unique tags", () => {
    const errors = [
      new ProviderDriverError({ driver: "d", instanceId: "i", detail: "x" }),
      new ProviderProbeError({ driver: "d", detail: "x" }),
      new ProviderValidationError({ operation: "o", issue: "i" }),
      new ProviderInstanceNotFoundError({ instanceId: "i" }),
      new ProviderAdapterValidationError({ provider: "p", operation: "o", issue: "i" }),
      new ProviderAdapterSessionNotFoundError({ provider: "p", sessionId: "s" }),
      new ProviderAdapterSessionClosedError({ provider: "p", sessionId: "s" }),
      new ProviderAdapterRequestError({ provider: "p", method: "m", detail: "d" }),
      new ProviderAdapterProcessError({ provider: "p", sessionId: "s", detail: "d" }),
    ];
    assert.equal(new Set(errors.map((e) => e.tag)).size, 9);
  });
  it("buildUnavailableSnapshot builds correct snapshot", () => {
    const snap = buildUnavailableSnapshot({ instanceId: "cli-cursor", driverKind: "cursor-cli", displayName: "Cursor CLI", reason: "not found" });
    assert.equal(snap.instanceId, "cli-cursor");
    assert.equal(snap.available, false);
    assert.ok(snap.checkedAt);
  });
  it("buildUnavailableSnapshot defaults displayName", () => {
    assert.equal(buildUnavailableSnapshot({ instanceId: "x", driverKind: "test", reason: "m" }).displayName, "test");
  });
});
