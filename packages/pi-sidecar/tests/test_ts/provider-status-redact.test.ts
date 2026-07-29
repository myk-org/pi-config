import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isLoopbackBindHost, redactProviderStatusAuth } from "../../src/index.js";

describe("isLoopbackBindHost", () => {
  it("accepts common loopback forms", () => {
    assert.equal(isLoopbackBindHost("127.0.0.1"), true);
    assert.equal(isLoopbackBindHost("127.0.0.2"), true);
    assert.equal(isLoopbackBindHost("::1"), true);
    assert.equal(isLoopbackBindHost("0:0:0:0:0:0:0:1"), true);
    assert.equal(isLoopbackBindHost("localhost"), true);
    assert.equal(isLoopbackBindHost("LOCALHOST"), true);
    assert.equal(isLoopbackBindHost("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackBindHost("::ffff:7f00:1"), true);
  });

  it("rejects non-loopback and wildcard binds", () => {
    assert.equal(isLoopbackBindHost("0.0.0.0"), false);
    assert.equal(isLoopbackBindHost("::"), false);
    assert.equal(isLoopbackBindHost("192.168.1.10"), false);
    assert.equal(isLoopbackBindHost("example.com"), false);
  });
});

describe("redactProviderStatusAuth", () => {
  const full = {
    provider: "google",
    registered: true,
    modelCount: 3,
    authStatus: {
      configured: true,
      source: "environment" as const,
      label: "GEMINI_API_KEY",
    },
    authCheck: { type: "api_key" as const, source: "GEMINI_API_KEY" },
  };

  it("passes through full auth detail on loopback", () => {
    assert.deepEqual(redactProviderStatusAuth(full, "127.0.0.1"), full);
  });

  it("strips source/label on non-loopback binds", () => {
    const redacted = redactProviderStatusAuth(full, "0.0.0.0");
    assert.deepEqual(redacted.authStatus, { configured: true });
    assert.deepEqual(redacted.authCheck, { type: "api_key" });
    assert.equal(redacted.provider, "google");
    assert.equal(redacted.modelCount, 3);
  });

  it("preserves null auth fields when redacting", () => {
    const empty = {
      provider: "x",
      registered: false,
      modelCount: 0,
      authStatus: null,
      authCheck: null,
    };
    assert.deepEqual(redactProviderStatusAuth(empty, "0.0.0.0"), empty);
  });
});
