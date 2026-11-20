import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { parseBody } from "../../src/index.js";
import { readBoundedResponseBytes, ResponseTooLargeError, sanitizeUrlForLog } from "../../src/http-helpers.js";

/** Create a mock IncomingMessage from a PassThrough stream */
function createMockRequest(): PassThrough {
  return new PassThrough();
}

describe("parseBody", () => {
  it("parses valid JSON body", async () => {
    const stream = createMockRequest();
    const promise = parseBody(stream as unknown as IncomingMessage);

    stream.write(JSON.stringify({ message: "hello", count: 42 }));
    stream.end();

    const result = await promise;
    assert.deepEqual(result, { message: "hello", count: 42 });
  });

  it("returns empty object for empty body", async () => {
    const stream = createMockRequest();
    const promise = parseBody(stream as unknown as IncomingMessage);

    stream.end();

    const result = await promise;
    assert.deepEqual(result, {});
  });

  it("rejects invalid JSON", async () => {
    const stream = createMockRequest();
    const promise = parseBody(stream as unknown as IncomingMessage);

    stream.write("not valid json {{{");
    stream.end();

    await assert.rejects(promise, { message: "Invalid JSON body" });
  });

  it("rejects body exceeding 1MB limit", async () => {
    const stream = createMockRequest();
    const promise = parseBody(stream as unknown as IncomingMessage);

    // Write a payload larger than MAX_BODY_SIZE (1MB)
    const chunk = "x".repeat(64 * 1024); // 64KB chunks
    for (let i = 0; i < 20; i++) {
      stream.write(chunk);
    }
    // Total: 1.25MB > 1MB

    await assert.rejects(promise, { message: "Payload too large" });

    // End the stream to clean up
    stream.end();
  });

  it("accepts body at exactly 1MB boundary", async () => {
    const stream = createMockRequest();
    const promise = parseBody(stream as unknown as IncomingMessage);

    // Build a JSON string that is exactly 1,048,576 bytes
    // We need valid JSON, so use a string value padded to hit exactly 1MB
    const overhead = '{"d":""}'; // 8 bytes
    const padding = "a".repeat(1_048_576 - overhead.length);
    const json = `{"d":"${padding}"}`;
    assert.equal(json.length, 1_048_576, "test payload must be exactly 1MB");

    stream.write(json);
    stream.end();

    const result = await promise;
    assert.equal(result.d.length, padding.length);
  });

  it("handles chunked JSON body", async () => {
    const stream = createMockRequest();
    const promise = parseBody(stream as unknown as IncomingMessage);

    // Send JSON in multiple chunks
    stream.write('{"key');
    stream.write('": "val');
    stream.write('ue"}');
    stream.end();

    const result = await promise;
    assert.deepEqual(result, { key: "value" });
  });

  it("handles split multi-byte UTF-8 characters across TCP chunks (#1256)", async () => {
    const stream = createMockRequest();
    const promise = parseBody(stream as unknown as IncomingMessage);

    // 4-byte UTF-8 emoji split mid-codepoint across two chunks
    const raw = Buffer.from(JSON.stringify({ msg: "hello 🚀 world" }), "utf8");
    const emojiStart = raw.indexOf(Buffer.from("🚀", "utf8"));
    stream.write(raw.subarray(0, emojiStart + 2));
    stream.write(raw.subarray(emojiStart + 2));
    stream.end();

    const result = await promise;
    assert.deepEqual(result, { msg: "hello 🚀 world" });
  });

  it("rejects on stream error", async () => {
    const stream = createMockRequest();
    const promise = parseBody(stream as unknown as IncomingMessage);

    stream.destroy(new Error("Connection reset"));

    await assert.rejects(promise, { message: "Connection reset" });
  });
});

describe("http-helpers shared utilities (#1254)", () => {
  it("sanitizeUrlForLog defaults to origin-only and supports includePath", () => {
    const url = "https://user:pass@example.com:8443/secret/path?api_key=123#frag"; // pragma: allowlist secret — synthetic test URL
    assert.equal(sanitizeUrlForLog(url), "https://example.com:8443");
    assert.equal(sanitizeUrlForLog(url, { includePath: true }), "https://example.com:8443/secret/path");
    assert.equal(sanitizeUrlForLog(undefined), "(unparseable)");
    assert.equal(sanitizeUrlForLog("not-a-url", { fallback: "[invalid-url]" }), "[invalid-url]");
  });

  it("readBoundedResponseBytes handles exact fit, truncate mode, and throw mode", async () => {
    const okResp = new Response("hello world");
    const ok = await readBoundedResponseBytes(okResp, 11);
    assert.equal(ok.hasBody, true);
    assert.equal(ok.truncated, false);
    assert.equal(new TextDecoder().decode(ok.bytes), "hello world");

    const truncResp = new Response("0123456789");
    const trunc = await readBoundedResponseBytes(truncResp, 4, { truncate: true });
    assert.equal(trunc.truncated, true);
    assert.equal(new TextDecoder().decode(trunc.bytes), "0123");

    const overflowResp = new Response("0123456789");
    await assert.rejects(
      readBoundedResponseBytes(overflowResp, 4),
      ResponseTooLargeError,
    );
  });
});
