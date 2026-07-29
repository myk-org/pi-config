import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BadRouteParamError, routeMatch, sanitizeForLog } from "../../src/index.js";

describe("routeMatch", () => {
  it("matches exact path /health", () => {
    const result = routeMatch("/health", "/health");
    assert.deepEqual(result, {});
  });

  it("matches parameterized path /sessions/:id/prompt and extracts id", () => {
    const result = routeMatch("/sessions/abc-123/prompt", "/sessions/:id/prompt");
    assert.ok(result);
    assert.equal(result.id, "abc-123");
  });

  it("extracts multiple params", () => {
    const result = routeMatch("/a/foo/b/bar", "/a/:x/b/:y");
    assert.ok(result);
    assert.equal(result.x, "foo");
    assert.equal(result.y, "bar");
  });

  it("rejects wrong path length (too many segments)", () => {
    const result = routeMatch("/sessions/abc/prompt/extra", "/sessions/:id/prompt");
    assert.equal(result, null);
  });

  it("rejects wrong path length (too few segments)", () => {
    const result = routeMatch("/sessions/abc", "/sessions/:id/prompt");
    assert.equal(result, null);
  });

  it("rejects mismatched segments", () => {
    const result = routeMatch("/users/abc/prompt", "/sessions/:id/prompt");
    assert.equal(result, null);
  });

  it("strips query string before matching", () => {
    const result = routeMatch("/sessions/xyz/prompt?timeout=30", "/sessions/:id/prompt");
    assert.ok(result);
    assert.equal(result.id, "xyz");
  });

  it("strips query string for exact match", () => {
    const result = routeMatch("/health?verbose=true", "/health");
    assert.deepEqual(result, {});
  });

  it("returns empty params for no-param pattern match", () => {
    const result = routeMatch("/models", "/models");
    assert.deepEqual(result, {});
  });

  it("returns null when pattern has params but URL does not match structure", () => {
    const result = routeMatch("/completely/different", "/sessions/:id");
    assert.equal(result, null);
  });

  it("matches /models/:provider/status and extracts a builtin provider id", () => {
    const result = routeMatch("/models/google/status", "/models/:provider/status");
    assert.ok(result);
    assert.equal(result.provider, "google");
  });

  it("matches /models/:provider/status with a hyphenated acpx-* provider id", () => {
    const result = routeMatch("/models/acpx-cursor/status", "/models/:provider/status");
    assert.ok(result);
    assert.equal(result.provider, "acpx-cursor");
  });

  it("matches /models/:provider/status with a hyphenated cli-* provider id", () => {
    const result = routeMatch("/models/cli-cursor/status", "/models/:provider/status");
    assert.ok(result);
    assert.equal(result.provider, "cli-cursor");
  });

  it("does not match /models/:provider/status against the plain /models route", () => {
    const result = routeMatch("/models", "/models/:provider/status");
    assert.equal(result, null);
  });

  it("does not match /models/:provider/status against /models/refresh (wrong segment count)", () => {
    const result = routeMatch("/models/refresh", "/models/:provider/status");
    assert.equal(result, null);
  });

  it("does not match /models/:provider/status against extra nested segments", () => {
    const result = routeMatch("/models/google/status/extra", "/models/:provider/status");
    assert.equal(result, null);
  });

  it("decodes percent-encoded :provider segments", () => {
    const result = routeMatch("/models/weird%2Fprovider/status", "/models/:provider/status");
    assert.ok(result);
    assert.equal(result.provider, "weird/provider");
  });

  it("throws BadRouteParamError for malformed percent-encoding in a param", () => {
    assert.throws(
      () => routeMatch("/models/bad%2/status", "/models/:provider/status"),
      (err: unknown) =>
        err instanceof BadRouteParamError && err.statusCode === 400 && /percent-encoding/.test(err.message),
    );
  });

  it("throws BadRouteParamError when a decoded param contains control characters (log-injection)", () => {
    assert.throws(
      () => routeMatch("/models/evil%0Aprovider/status", "/models/:provider/status"),
      (err: unknown) => err instanceof BadRouteParamError && err.statusCode === 400,
    );
    assert.throws(
      () => routeMatch("/sessions/abc%0Did/prompt", "/sessions/:id/prompt"),
      (err: unknown) => err instanceof BadRouteParamError && err.statusCode === 400,
    );
  });
});

describe("sanitizeForLog", () => {
  it("escapes ASCII control characters for single-line logs", () => {
    assert.equal(sanitizeForLog("ok-id"), "ok-id");
    assert.equal(sanitizeForLog("a\nb"), "a\\x0ab");
    assert.equal(sanitizeForLog("a\rb"), "a\\x0db");
  });

  it("escapes comma and equals so key=value log fields cannot be forged", () => {
    assert.equal(sanitizeForLog("a,b=c"), "a\\x2cb\\x3dc");
  });
});
