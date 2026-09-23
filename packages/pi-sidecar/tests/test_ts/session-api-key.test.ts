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

  it("redacts errors during session creation without leaking the key", async () => {
    const oldError = logger.error;
    const logs: string[] = [];
    logger.error = (...args) => { logs.push(args.join(" ")); };
    try {
      await assert.rejects(() => store.create({ provider: secret, model: "missing", systemPrompt: "hi", cwd, apiKey: secret }),
        (error: any) => !error.message.includes(secret) && !error.message.includes(escaped) && error.message.includes("[REDACTED]"));
      assert.ok(logs.every((message) => !message.includes(secret) && !message.includes(escaped)));
    } finally {
      logger.error = oldError;
    }
  });

  it("redacts lowercase percent escapes in rejected model names without changing raw or JSON matching", async () => {
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

  it("matches percent-escape hex case but keeps raw and JSON matching case-sensitive", () => {
    assert.equal(redactApiKey("a%2fb a%2Fb", "a/b"), "[REDACTED] [REDACTED]");
    assert.equal(redactApiKey("%c2%af %C2%AF %c2%AF", "¯"), "[REDACTED] [REDACTED] [REDACTED]");
    assert.equal(redactApiKey('Ab ab A\\nB a\\nB', 'Ab'), '[REDACTED] ab A\\nB a\\nB');
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

  it("uses the session key for direct SDK complete calls", async () => {
    const id = await create("direct-key");
    try {
      const session = (store as any).sessions.get(id).session;
      const result = await session.modelRuntime.completeSimple(session.model, { messages: [] });
      assert.equal(result.content[0]?.type === "text" && result.content[0].text, "direct-key");
    } finally {
      store.delete(id);
    }
  });

  it("shows only its own key-backed models without changing shared availability", async () => {
    const keyOnly = fauxProvider({ provider: "test-key-only", models: [{ id: "local" }] });
    keyOnly.provider.auth = { apiKey: { name: "Key only", resolve: async ({ credential }: any) => credential ? { auth: { apiKey: credential.key }, source: "key" } : undefined } } as never; // pragma: allowlist secret — fake provider
    runtime.registerNativeProvider(keyOnly.provider);
    await runtime.getAvailable();
    const shared = runtime.getAvailableSnapshot();
    const id = await store.create({ provider: "test-key-only", model: "local", systemPrompt: "hi", cwd, agentDir: cwd, tools: [], apiKey: "view-key" }); // pragma: allowlist secret — test sentinel
    try {
      const view = (store as any).sessions.get(id).session.modelRuntime;
      assert.ok(view.getAvailableSnapshot().some((m: any) => m.provider === "test-key-only" && m.id === "local"));
      assert.ok((await view.getAvailable()).some((m: any) => m.provider === "test-key-only" && m.id === "local"));
      assert.ok((await view.getAvailable("test-key-only")).some((m: any) => m.id === "local"));
      assert.deepEqual(await view.getAvailable("test-oauth-only"), await runtime.getAvailable("test-oauth-only"));
      assert.ok(!view.getAvailableSnapshot().some((m: any) => m.provider === "test-oauth-only"));
      assert.deepEqual(runtime.getAvailableSnapshot(), shared);
      assert.ok(!shared.some((m) => m.provider === "test-key-only"));
    } finally { store.delete(id); }
  });

  it("resolves supplied auth for a builtin provider without ambient credentials", async () => {
    const model = runtime.getModels("openai")[0];
    assert.ok(model);
    const id = await store.create({ provider: "openai", model: model.id, systemPrompt: "hi", cwd, agentDir: cwd, tools: [], apiKey: "auth-only-key" }); // pragma: allowlist secret — test sentinel
    try {
      const session = (store as any).sessions.get(id).session;
      const auth = await session.modelRuntime.getAuth(model);
      assert.equal(auth?.auth.apiKey, "auth-only-key");
    } finally {
      store.delete(id);
    }
  });

  it("does not attach a session key to another provider's model", async () => {
    const id = await create("private-key");
    try {
      const view = (store as any).sessions.get(id).session.modelRuntime;
      const other = runtime.getModels("openai")[0];
      assert.ok(other);
      const auth = await view.getAuth(other);
      assert.notEqual(auth?.auth.apiKey, "private-key");
      assert.deepEqual(await view.getAvailable("openai"), await runtime.getAvailable("openai"));
    } finally { store.delete(id); }
  });

  it("redacts echoed keys in prompt text", async () => {
    const id = await create(secret);
    const result = await store.prompt(id, "hi");
    assert.equal(result.text, "[REDACTED]");
    store.delete(id);
  });

  it("redacts URL-encoded keys and SDK diagnostic errors", async () => {
    const encoded = encodeURIComponent(secret);
    const id = await create(secret);
    const oldError = logger.error;
    const logs: string[] = [];
    logger.error = (...args) => { logs.push(args.join(" ")); };
    try {
      echoError = true;
      const result = await store.prompt(id, "hi");
      assert.equal(result.text, "");
      assert.equal(result.error, "failed [REDACTED] / [REDACTED] / [REDACTED]");
      assert.ok(!JSON.stringify(result).includes(encoded));
      assert.ok(logs.every((message) => !message.includes(encoded)));
    } finally {
      logger.error = oldError;
      echoError = false;
      store.delete(id);
    }
  });

  it("redacts raw and escaped keys in provider errors", async () => {
    const id = await create(secret);
    const oldError = logger.error;
    const logs: string[] = [];
    logger.error = (...args) => { logs.push(args.join(" ")); };
    echoError = true;
    try {
      const result = await store.prompt(id, "hi");
      assert.equal(result.error, "failed [REDACTED] / [REDACTED] / [REDACTED]");
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.ok(!JSON.stringify(result).includes(escaped));
      assert.ok(logs.every((message) => !message.includes(secret) && !message.includes(escaped)));
    } finally {
      logger.error = oldError;
      echoError = false;
      store.delete(id);
    }
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
