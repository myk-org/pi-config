import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startSidecar } from "../../src/index.js";
import { createServer } from "node:http";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { SessionStore, redactApiKey } from "../../src/sessions.js";
import { logger } from "../../src/logger.js";

const secret = 'session-"\\-key';
const escaped = JSON.stringify(secret).slice(1, -1);

describe("session API key", () => {
  let store: SessionStore;
  let runtime: ModelRuntime;
  let cwd: string;
  const seen: string[] = [];
  let echoError = false;

  before(async () => {
    cwd = mkdtempSync(join(tmpdir(), "sidecar-key-"));
    const faux = fauxProvider({ provider: "test-session-key", models: [{ id: "local" }] });
    // Real SDK runtime and agent sessions; the only fake is the external model provider.
    faux.setResponses(Array.from({ length: 30 }, () => async (_context, options) => {
      seen.push(options?.apiKey ?? "");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return echoError
        ? fauxAssistantMessage("", { stopReason: "error", errorMessage: options?.apiKey ? `failed ${secret} / ${escaped} / ${encodeURIComponent(secret)}` : "provider failed without key" })
        : fauxAssistantMessage(options?.apiKey ?? "ambient");
    }));
    runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const keyOnly = fauxProvider({ provider: "test-key-only", models: [{ id: "local" }] });
    keyOnly.provider.auth = { apiKey: { name: "Key only", resolve: async ({ credential }: any) => credential ? { auth: { apiKey: credential.key }, source: "key" } : undefined } } as never; // pragma: allowlist secret — fake provider
    runtime.registerNativeProvider(keyOnly.provider);
    store = new SessionStore();
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime,
      modelRegistry: new ModelRegistry(runtime),
      _ready: true,
    });
  });
  after(async () => {
    await store?.disposeAll();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  const create = (apiKey?: string) => store.create({
    provider: "test-session-key", model: "local", systemPrompt: "Reply briefly", cwd, agentDir: cwd, tools: [], apiKey,
  });

  it("keeps concurrent session streams separate from ambient credentials", async () => {
    const [a, b, ambient] = await Promise.all([create("first-key"), create("second-key"), create()]);
    const responses = await Promise.all([a, b, ambient].map((id) => store.prompt(id, "hi")));
    assert.deepEqual(responses.map((r) => r.text), ["[REDACTED]", "[REDACTED]", "ambient"]);
    assert.deepEqual(seen.slice(-3).sort(), ["", "first-key", "second-key"].sort());
    for (const id of [a, b, ambient]) store.delete(id);
  });

  it("rejects ambient CLI/ACPX login markers even when they advertise apiKey", async () => {
    for (const provider of ["cli-test", "acpx-test"]) {
      const marker = fauxProvider({ provider, models: [{ id: "local" }] });
      marker.provider.auth = { apiKey: { name: "Local login", resolve: async () => ({ auth: { apiKey: "ambient" }, source: "local" }) } } as never; // pragma: allowlist secret — fake provider marker
      runtime.registerNativeProvider(marker.provider);
      (store as any)[provider.startsWith("cli-") ? "cliModels" : "acpxModels"].push({ provider, id: "local", name: "local" });
      await assert.rejects(() => store.create({ provider, model: "local", systemPrompt: "hi", cwd, agentDir: cwd, tools: [], apiKey: secret }),
        (error: any) => error.statusCode === 400 && /ambient login/.test(error.message) && !error.message.includes(secret));
    }
  });

  it("rejects provider without API key capability", async () => {
    const oauth = fauxProvider({ provider: "test-oauth-only", models: [{ id: "local" }] });
    oauth.provider.auth = { oauth: { name: "test", login: async () => { throw new Error("unused"); } } } as never;
    runtime.registerNativeProvider(oauth.provider);
    await assert.rejects(() => store.create({ provider: "test-oauth-only", model: "local", systemPrompt: "hi", cwd, agentDir: cwd, tools: [], apiKey: secret }),
      (error: any) => error.statusCode === 400 && /does not support API key/.test(error.message));
  });

  it("redacts the key in session creation errors", async () => {
    await assert.rejects(() => store.create({ provider: secret, model: "missing", systemPrompt: "hi", cwd, apiKey: secret }),
      (error: any) => !error.message.includes(secret) && !error.message.includes(escaped) && error.message.includes("[REDACTED]"));
  });

  it("redacts the key in session creation logs", async () => {
    const oldError = logger.error;
    const logs: string[] = [];
    logger.error = (...args) => { logs.push(args.join(" ")); };
    try {
      await assert.rejects(() => store.create({ provider: secret, model: "missing", systemPrompt: "hi", cwd, apiKey: secret }));
      assert.ok(logs.some((message) => message.includes("[REDACTED]")));
      assert.ok(logs.every((message) => !message.includes(secret) && !message.includes(escaped)));
    } finally { logger.error = oldError; }
  });

  it("redacts lowercase percent escapes in rejected model names", async () => {
    const key = "a/b";
    const encoded = "a%2fb";
    const logs: string[] = [];
    const oldError = logger.error;
    logger.error = (...args) => { logs.push(args.join(" ")); };
    try {
      await assert.rejects(() => store.create({ provider: "test-session-key", model: encoded, systemPrompt: "hi", cwd, apiKey: key }),
        (error: any) => error.message.includes("[REDACTED]") && !error.message.includes(key) && !error.message.includes(encoded));
      assert.ok(logs.some((line) => line.includes("[REDACTED]")));
      assert.ok(logs.every((line) => !line.includes(key) && !line.includes(encoded)));
    } finally { logger.error = oldError; }
  });

  it("matches percent-escape hex case", () => {
    assert.equal(redactApiKey("a%2fb a%2Fb", "a/b"), "[REDACTED] [REDACTED]");
    assert.equal(redactApiKey("%c2%af %C2%AF %c2%AF", "¯"), "[REDACTED] [REDACTED] [REDACTED]");
  });

  it("keeps raw key matching case-sensitive", () => {
    assert.equal(redactApiKey('Ab ab', 'Ab'), '[REDACTED] ab');
  });

  it("keeps JSON-escaped key matching case-sensitive", () => {
    assert.equal(redactApiKey('A\\nB a\\nB', 'A\nB'), '[REDACTED] a\\nB');
  });

  it("rejects unpaired surrogate keys before session creation", async () => {
    for (const key of ["\ud800", "\udc00", "x\ud800y", "\ud800\ud800\udc00"]) {
      await assert.rejects(() => create(key), (error: any) => error.statusCode === 400 && !error.message.includes(key));
    }
  });

  it("rejects blank keys", async () => {
    await assert.rejects(() => create("   "), (error: any) => error.statusCode === 400);
  });

  it("uses the session key for prompts", async () => {
    const id = await create("direct-key");
    try {
      assert.equal((await store.prompt(id, "hi")).text, "[REDACTED]");
      assert.equal(seen.at(-1), "direct-key");
    } finally { store.delete(id); }
  });

  const keyOnlyProvider = "test-key-only";
  const createKeyOnly = (apiKey?: string) => store.create({
    provider: keyOnlyProvider, model: "local", systemPrompt: "hi", cwd, agentDir: cwd, tools: [], apiKey,
  });

  it("accepts a private key-backed model", async () => {
    const count = store.count();
    const id = await createKeyOnly("view-key"); // pragma: allowlist secret — test sentinel
    try {
      assert.equal(store.count(), count + 1);
    } finally { store.delete(id); }
  });

  it("does not add a private key-backed model to shared availability", async () => {
    const before = await store.getModels();
    assert.ok(!before.some((m) => m.provider === keyOnlyProvider));
    const id = await createKeyOnly("view-key"); // pragma: allowlist secret — test sentinel
    try {
      assert.deepEqual(await store.getModels(), before);
    } finally { store.delete(id); }
  });

  it("filters private models from the shared provider catalog", async () => {
    const id = await createKeyOnly("view-key"); // pragma: allowlist secret — test sentinel
    try {
      const models = await store.getModels();
      assert.deepEqual(models.filter((model) => model.provider === keyOnlyProvider), []);
    } finally { store.delete(id); }
  });

  it("keeps another provider usable with ambient credentials", async () => {
    const id = await createKeyOnly("view-key"); // pragma: allowlist secret — test sentinel
    try {
      const other = await create();
      try {
        assert.equal((await store.prompt(other, "hi")).text, "ambient");
      } finally { store.delete(other); }
    } finally { store.delete(id); }
  });

  it("preserves the shared availability snapshot after private session creation", async () => {
    await runtime.getAvailable();
    const snapshot = runtime.getAvailableSnapshot();
    const id = await createKeyOnly("view-key"); // pragma: allowlist secret — test sentinel
    try {
      assert.deepEqual(runtime.getAvailableSnapshot(), snapshot);
    } finally { store.delete(id); }
  });

  it("accepts supplied auth for a builtin provider without ambient credentials", async () => {
    const model = runtime.getModels("openai")[0];
    assert.ok(model);
    const id = await store.create({ provider: "openai", model: model.id, systemPrompt: "hi", cwd, agentDir: cwd, tools: [], apiKey: "auth-only-key" }); // pragma: allowlist secret — test sentinel
    store.delete(id);
  });

  it("keeps another provider's prompt on ambient credentials", async () => {
    const id = await create("private-key");
    const other = await create();
    try {
      assert.equal((await store.prompt(other, "hi")).text, "ambient");
      assert.equal(seen.at(-1), "");
    } finally { store.delete(id); store.delete(other); }
  });

  it("redacts echoed keys in prompt text", async () => {
    const id = await create(secret);
    const result = await store.prompt(id, "hi");
    assert.equal(result.text, "[REDACTED]");
    store.delete(id);
  });

  const providerError = async () => {
    const id = await create(secret);
    echoError = true;
    try { return await store.prompt(id, "hi"); }
    finally { echoError = false; store.delete(id); }
  };

  it("redacts URL-encoded keys in provider errors", async () => {
    const result = await providerError();
    assert.ok(!JSON.stringify(result).includes(encodeURIComponent(secret)));
    assert.match(result.error ?? "", /\[REDACTED\]/);
  });

  it("redacts raw keys in provider errors", async () => {
    const result = await providerError();
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.match(result.error ?? "", /\[REDACTED\]/);
  });

  it("redacts JSON-escaped keys in provider errors", async () => {
    const result = await providerError();
    assert.ok(!JSON.stringify(result).includes(escaped));
    assert.match(result.error ?? "", /\[REDACTED\]/);
  });

  it("redacts keys in provider diagnostic logs", async () => {
    const logs: string[] = [];
    const oldError = logger.error;
    logger.error = (...args) => { logs.push(args.join(" ")); };
    try {
      await providerError();
      assert.ok(logs.every((message) => !message.includes(secret) && !message.includes(escaped) && !message.includes(encodeURIComponent(secret))));
    } finally { logger.error = oldError; }
  });

  it("returns final assistant errors without a session key", async () => {
    const id = await create();
    echoError = true;
    try {
      const result = await store.prompt(id, "hi");
      assert.equal(result.text, "");
      assert.equal(result.error, "provider failed without key");
    } finally {
      echoError = false;
      store.delete(id);
    }
  });

  it("removes deleted session credentials before later sessions", async () => {
    const first = await create("retired-key");
    store.delete(first);
    const next = await create();
    const result = await store.prompt(next, "hi");
    assert.equal(result.text, "ambient");
    store.delete(next);
  });
});

describe("session key HTTP validation", () => {
  it("returns 400 for unknown models even when redaction removes the status clue", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    const offline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    const handle = startSidecar({ port, host: "127.0.0.1" });
    const logs: string[] = [];
    const oldError = logger.error;
    const oldWarn = logger.warn;
    logger.error = (...args) => { logs.push(args.join(" ")); };
    logger.warn = (...args) => { logs.push(args.join(" ")); };
    try {
      await handle.ready;
      for (const [api_key, model] of [["a/b", "a%2fb"], ["o", "o"]]) {
        const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "openai", model, system_prompt: "hi", api_key }),
        });
        const body = await response.text();
        assert.equal(response.status, 400, body);
        assert.match(body, /\[REDACTED\]/);
        assert.ok(!body.includes(`'${api_key}'`) && !body.includes(`'${model}'`), body);
        assert.ok(logs.filter((line) => line.includes("Session creation rejected") || line.includes("REQUEST_FAILED"))
          .every((line) => !line.includes(`'${api_key}'`) && !line.includes(`'${model}'`)));
      }
    } finally {
      logger.error = oldError;
      logger.warn = oldWarn;
      await handle.close();
      if (offline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = offline;
    }
  });

  it("returns 400 without echoing an unpaired surrogate key", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    const offline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    const handle = startSidecar({ port, host: "127.0.0.1" });
    try {
      await handle.ready;
      const key = "\ud800";
      const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", model: "missing", system_prompt: "hi", api_key: key }),
      });
      const body = await response.text();
      assert.equal(response.status, 400, body);
      assert.match(body, /api_key/);
      assert.ok(!body.includes(key) && !body.includes("\\ud800"), body);
    } finally {
      await handle.close();
      if (offline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = offline;
    }
  });

  it("rejects invalid keys without echoing their input", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    const offline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    const handle = startSidecar({ port, host: "127.0.0.1" });
    try {
      await handle.ready;
      for (const api_key of [null, "", "  ", 42, { password: secret }]) {
        const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "bad", system_prompt: "hi", api_key }),
        });
        assert.equal(response.status, 400);
        const body = await response.text();
        assert.match(body, /api_key must be a non-empty string/);
        assert.ok(!body.includes(secret));
      }
    } finally {
      await handle.close();
      if (offline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = offline;
    }
  });
});
