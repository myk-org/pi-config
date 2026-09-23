import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { it } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startSidecar } from "../../src/index.js";
import { createApiKeyRedactor, isValidApiKey, SessionStore, redactDiagnostic } from "../../src/sessions.js";
import { logger } from "../../src/logger.js";

const key = "secret-é-😀/"; // pragma: allowlist secret — test sentinel
const variants = [
  "secret-\\u00e9-\\ud83d\\ude00/",
  "secret-\\u00E9-\\uD83D\\uDE00/",
  "secret-\\u00e9-😀/",
  "secret-\\u00e9-\\ud83d\\uDE00/",
  JSON.stringify(key).slice(1, -1),
  encodeURIComponent(key).toLowerCase(),
  encodeURIComponent(key),
  key,
];

it("redacts raw and percent-encoded characters mixed per Unicode code point", () => {
  const redact = createApiKeyRedactor("a é");
  assert.equal(redact("a%20é"), "[REDACTED]");
  assert.equal(redact("a %C3%A9"), "[REDACTED]");
  assert.equal(redact("a%20%C3%A9"), "[REDACTED]");
  assert.equal(redact("A%20é"), "A%20é");
  assert.equal(redact("a%20É"), "a%20É");
  assert.equal(redact("a%20%C3%89"), "a%20%C3%89");
  assert.equal(createApiKeyRedactor("😀é")("😀%c3%a9"), "[REDACTED]");
  assert.equal(createApiKeyRedactor("😀é")("%f0%9f%98%80é"), "[REDACTED]");
  assert.equal(createApiKeyRedactor("a é")("a\\u0020%C3%A9"), "[REDACTED]");
});

it("does not decode malformed percent sequences or match partial Unicode code points", () => {
  const redact = createApiKeyRedactor("a é");
  for (const input of ["a%20%C3%A", "a%20%C3%28", "a%20%C3é"]) {
    assert.equal(redact(input), input);
  }
  assert.equal(redact("a%20%C3%A9x"), "[REDACTED]x");
  for (const input of ["a%20%C0%A9", "a%20%E0%80%A9", "a%20%ED%A0%80", "a%20%F4%90%80%80"]) {
    assert.equal(redact(input), input);
  }
  assert.equal(createApiKeyRedactor("😀")("%F0%9F%98%80"), "[REDACTED]");
});

it("redacts raw, Unicode-escaped, JSON-escaped and percent-encoded key representations", () => {
  const redact = createApiKeyRedactor(key);
  for (const variant of variants) assert.equal(redact(`prefix ${variant} suffix`), "prefix [REDACTED] suffix", variant);
});

it("redacts mixed JSON and Unicode escapes in the same key", () => {
  const mixedKey = 'a"é/b'; // pragma: allowlist secret — test sentinel
  assert.equal(createApiKeyRedactor(mixedKey)('a\\"\\u00E9/b'), "[REDACTED]");
});

it("bounds API key length before redactor construction", () => {
  assert.ok(isValidApiKey("x".repeat(1024)));
  assert.equal(isValidApiKey("x".repeat(1025)), false);
  assert.throws(() => createApiKeyRedactor("x".repeat(1025)), RangeError);
  assert.equal(isValidApiKey("\ud800"), false);
});

it("handles repeated backslashes followed by a near match without stalling", () => {
  const redact = createApiKeyRedactor("\\".repeat(80) + "X");
  const input = "\\".repeat(50_000) + "Y";
  const start = performance.now();
  assert.equal(redact(input), input);
  assert.ok(performance.now() - start < 2_000, "redaction blocked the event loop");
  const mixed = createApiKeyRedactor("\\".repeat(80) + "é");
  const mixedInput = "\\".repeat(50_000) + "%C3%A8";
  const mixedStart = performance.now();
  assert.equal(mixed(mixedInput), mixedInput);
  assert.ok(performance.now() - mixedStart < 2_000, "mixed redaction blocked the event loop");
});

it("bounds large malformed percent input without changing its contents", () => {
  const redact = createApiKeyRedactor("a".repeat(1023) + "X");
  const input = "%FF".repeat(166_666);
  const start = performance.now();
  assert.equal(redact(input), input);
  assert.ok(performance.now() - start < 3_000, "malformed percent redaction blocked the event loop");
});

it("bounds long near-matches without dropping ordinary response text", () => {
  const redact = createApiKeyRedactor("a".repeat(1023) + "X");
  const input = "a".repeat(8_000_000);
  const start = performance.now();
  assert.equal(redact(input), input);
  assert.ok(performance.now() - start < 2_000, "large response redaction blocked the event loop");
});

it("redacts keys spanning chunks with mixed JSON and percent encodings", () => {
  const secret = 'a"é/b'; // pragma: allowlist secret — test sentinel
  const redact = createApiKeyRedactor(secret);
  const prefix = "z".repeat(16_382);
  const variant = 'a\\"%C3%A9\\/b';
  const response = prefix + variant + "!".repeat(2_000_000);
  assert.equal(redact(response), prefix + "[REDACTED]" + "!".repeat(2_000_000));
});

it("omits oversized diagnostics even when the key crosses the cap", () => {
  const secret = "a".repeat(1023) + "X"; // pragma: allowlist secret — synthetic test sentinel
  const input = "z".repeat(16_000) + secret + "z".repeat(8_000_000);
  const start = performance.now();
  assert.equal(redactDiagnostic(input, createApiKeyRedactor(secret)), "[oversized diagnostic omitted]");
  assert.ok(performance.now() - start < 2_000);
});

it("preserves large successful session responses while redacting a boundary-spanning key", async () => {
  const store = new SessionStore();
  const secret = "a é"; // pragma: allowlist secret — synthetic test sentinel
  const prefix = "z".repeat(16_383);
  const response = prefix + "a\\u0020%C3%A9" + "!".repeat(2_000_000);
  store.putSessionFixture("large", {
    prompt: async () => {}, subscribe: (onEvent: any) => {
      onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: response } });
      return () => {};
    }, dispose: () => {}, abort: async () => {},
  }, "/tmp");
  (store as any).sessions.get("large").redact = createApiKeyRedactor(secret);
  try {
    assert.equal((await store.prompt("large", "hi")).text, prefix + "[REDACTED]" + "!".repeat(2_000_000));
  } finally { await store.disposeAll(); }
});

it("omits eight-million-character prompt errors from results and logs", async () => {
  const store = new SessionStore();
  const secret = "a".repeat(1023) + "X";
  const error = new Error("z".repeat(16_000) + secret + "a".repeat(8_000_000));
  store.putSessionFixture("error", {
    prompt: async () => { throw error; }, subscribe: () => () => {}, dispose: () => {}, abort: async () => {},
  }, "/tmp");
  (store as any).sessions.get("error").redact = createApiKeyRedactor(secret);
  const lines: string[] = [];
  const old = logger.error;
  logger.error = (...args) => lines.push(args.join(" "));
  try {
    await assert.rejects(store.prompt("error", "hi"), (err: any) =>
      err.message === "[oversized diagnostic omitted]" && err.cause === error);
    assert.ok(lines.every(line => !line.includes(secret) && line.length < 20_000));
  } finally { logger.error = old; await store.disposeAll(); }
});

it("matches mixed raw and escaped characters but preserves raw letter case", () => {
  const redact = createApiKeyRedactor('Ab/é😀\\Z');
  assert.equal(redact('Ab\\/\\u00C9😀\\\\Z'), 'Ab\\/\\u00C9😀\\\\Z');
  assert.equal(redact('Ab\\/\\u00e9\\uD83d\\uDe00\\\\Z'), '[REDACTED]');
  assert.equal(redact('ab\\/\\u00e9\\uD83d\\uDe00\\\\Z'), 'ab\\/\\u00e9\\uD83d\\uDe00\\\\Z');
  const url = createApiKeyRedactor("Ab/é");
  assert.equal(url("Ab%2f%c3%a9"), "[REDACTED]");
  assert.equal(url("ab%2f%c3%a9"), "ab%2f%c3%a9");
});

it("rejects oversized keys via HTTP without echoing them", async () => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>(resolve => blocker.close(() => resolve()));
  const offline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const handle = startSidecar({ port, host: "127.0.0.1" });
  try {
    await handle.ready;
    const oversized = "s".repeat(1025);
    const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "missing", system_prompt: "hi", api_key: oversized }),
    });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.ok(!body.includes(oversized));
    assert.match(body, /api_key/);
  } finally {
    await handle.close();
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  }
});

it("retains original error as cause while sanitizing creation stack", async () => {
  const store = new SessionStore();
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  Object.assign(store, { _ready: true, modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), ensureInternalRuntime: async () => { const err = new Error(`runtime ${key}`); err.stack = `Error: runtime ${key}\n at provider ${variants[0]}`; throw err; } });
  const lines: string[] = [];
  const old = logger.error;
  logger.error = (...args) => lines.push(args.join(" "));
  try {
    await assert.rejects(store.create({ provider: "bad", model: "bad", systemPrompt: "hi", cwd: "/tmp", apiKey: key }), (error: any) => {
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.stack, /at provider/);
      assert.ok(!error.message.includes(key));
      return true;
    });
    assert.ok(lines.some(line => line.includes("at provider") && line.includes("[REDACTED]")), lines.join("\n"));
    assert.ok(lines.every(line => !variants.some(variant => line.includes(variant))));
  } finally { logger.error = old; await store.disposeAll(); }
});

it("retains prompt rejection cause and sanitized stack", async () => {
  const store = new SessionStore();
  const error = new Error(`failed ${key}`);
  error.stack = `Error: failed ${key}\n at tool ${variants[1]}`;
  store.putSessionFixture("fixture", {
    prompt: async () => { throw error; }, subscribe: () => () => {}, dispose: () => {}, abort: async () => {},
  }, "/tmp");
  (store as any).sessions.get("fixture").redact = createApiKeyRedactor(key);
  const lines: string[] = [];
  const old = logger.error;
  logger.error = (...args) => lines.push(args.join(" "));
  try {
    await assert.rejects(store.prompt("fixture", "hi"), (err: any) => err.cause === error && !err.message.includes(key));
    assert.ok(lines.some(line => line.includes("at tool") && line.includes("[REDACTED]")), lines.join("\n"));
    assert.ok(lines.every(line => !variants.some(variant => line.includes(variant))));
  } finally { logger.error = old; await store.disposeAll(); }
});

it("HTTP unexpected failures log a sanitized cause stack without exposing it to clients", async () => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>(resolve => blocker.close(() => resolve()));
  const offline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const originalCreate = SessionStore.prototype.create;
  const originalError = logger.error;
  const logs: string[] = [];
  SessionStore.prototype.create = async () => {
    const cause = new Error(`cause ${key}`);
    cause.stack = `Error: cause ${key}\n at handler ${variants[0]}`;
    throw Object.assign(new Error(`failed ${key}`), { statusCode: 500, cause });
  };
  logger.error = (...args) => logs.push(args.join(" "));
  const handle = startSidecar({ port, host: "127.0.0.1" });
  try {
    await handle.ready;
    const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "missing", system_prompt: "hi", api_key: key }),
    });
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.ok(!body.includes(key) && !body.includes("at handler"));
    assert.ok(logs.some(line => line.includes("at handler") && line.includes("[REDACTED]")), logs.join("\n"));
    assert.ok(logs.every(line => !variants.some(variant => line.includes(variant))));
  } finally {
    SessionStore.prototype.create = originalCreate;
    logger.error = originalError;
    await handle.close();
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  }
});

it("omits oversized HTTP creation errors from response and logs", async () => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>(resolve => blocker.close(() => resolve()));
  const secret = "a".repeat(1023) + "X";
  const originalCreate = SessionStore.prototype.create;
  const originalError = logger.error;
  const logs: string[] = [];
  SessionStore.prototype.create = async () => {
    throw new Error("z".repeat(16_000) + secret + "a".repeat(8_000_000));
  };
  logger.error = (...args) => logs.push(args.join(" "));
  const handle = startSidecar({ port, host: "127.0.0.1" });
  try {
    await handle.ready;
    const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "missing", system_prompt: "hi", api_key: secret }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "[oversized diagnostic omitted]" });
    assert.ok(logs.every(line => !line.includes(secret) && line.length < 20_000));
  } finally {
    SessionStore.prototype.create = originalCreate;
    logger.error = originalError;
    await handle.close();
  }
});

it("HTTP creation errors redact Unicode escape variants in response and logs", async () => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>(resolve => blocker.close(() => resolve()));
  const offline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const logs: string[] = [];
  const old = logger.error;
  logger.error = (...args) => logs.push(args.join(" "));
  const handle = startSidecar({ port, host: "127.0.0.1" });
  try {
    await handle.ready;
    for (const [apiKey, variant] of [
      ...[...variants, "secret-%c3%a9-😀/", "secret-é-%f0%9f%98%80/"].map(v => [key, v]),
      ["a é", "a%20é"],
      ["a é", "a %C3%A9"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", model: variant, system_prompt: "hi", api_key: apiKey }),
      });
      const body = await response.text();
      assert.equal(response.status, 400, body);
      assert.match(body, /\[REDACTED\]/);
      assert.ok(!body.includes(variant), body);
      assert.ok(logs.every(line => !line.includes(variant) && !line.includes(apiKey)), logs.join("\n"));
    }
  } finally {
    logger.error = old;
    await handle.close();
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  }
});
