import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { startSidecar } from "../../src/index.js";
import { SessionStore } from "../../src/sessions.js";
import { logger } from "../../src/logger.js";
import { buildAmbientLoginAuth } from "../../../../extensions/shared/create-runtime-provider.js";

describe("GET /providers", () => {
  let port: number;
  let sidecar: ReturnType<typeof startSidecar>;
  const offline = process.env.PI_OFFLINE;
  const openaiKey = process.env.OPENAI_API_KEY;

  before(async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    process.env.PI_OFFLINE = "1";
    delete process.env.OPENAI_API_KEY;
    sidecar = startSidecar({ port, host: "127.0.0.1" });
    await sidecar.ready;
  });
  after(async () => {
    await sidecar?.close();
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
    if (openaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = openaiKey;
  });

  it("preserves exact provider IDs", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/providers`);
    assert.equal(response.status, 200);
    const body = await response.json() as { providers: Array<{ provider: string; supportsSessionApiKey: boolean }> };
    assert.ok(body.providers.some((p) => p.provider === "openai"));
  });

  it("returns only public provider fields", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/providers`);
    assert.equal(response.status, 200);
    const body = await response.json() as { providers: Array<{ provider: string; supportsSessionApiKey: boolean }> };
    assert.ok(body.providers.every((p) => Object.keys(p).sort().join(",") === "provider,supportsSessionApiKey"));
  });

  it("reports session-key capability without credentials", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/providers`);
    assert.equal(response.status, 200);
    const body = await response.json() as { providers: Array<{ provider: string; supportsSessionApiKey: boolean }> };
    assert.deepEqual(body.providers.find((p) => p.provider === "openai"), { provider: "openai", supportsSessionApiKey: true });
  });

  it("logs the endpoint provider count", async () => {
    const debug = logger.debug;
    const records: unknown[][] = [];
    logger.debug = (...args: unknown[]) => { records.push(args); };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/providers`);
      assert.equal(response.status, 200);
      const body = await response.json() as { providers: unknown[] };
      assert.ok(records.some(([message]) => typeof message === "string" &&
        message.includes("GET /providers 200") && message.includes(`count=${body.providers.length}`)));
    } finally {
      logger.debug = debug;
    }
  });

  it("keeps OpenAI discoverable when the auth-filtered model catalog omits it", async () => {
    const modelsResponse = await fetch(`http://127.0.0.1:${port}/models`);
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json() as { models: Array<{ provider: string }> };
    assert.ok(!models.models.some((model) => model.provider === "openai"));
    const response = await fetch(`http://127.0.0.1:${port}/providers`);
    assert.equal(response.status, 200);
    const body = await response.json() as { providers: Array<{ provider: string }> };
    assert.ok(body.providers.some((provider) => provider.provider === "openai"));
  });
});

describe("SessionStore provider discovery", () => {
  let runtime: ModelRuntime;
  let store: SessionStore;
  const dir = mkdtempSync(join(tmpdir(), "sidecar-providers-"));
  before(async () => {
    runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const extension = fauxProvider({ provider: "extension-exact_ID", models: [] });
    extension.provider.auth = { apiKey: { name: "secret-sentinel", resolve: async () => undefined } } as never; // pragma: allowlist secret — synthetic auth label
    runtime.registerNativeProvider(extension.provider);
    const authless = fauxProvider({ provider: "extension-authless", models: [] });
    (authless.provider as { auth?: unknown }).auth = undefined;
    runtime.registerNativeProvider(authless.provider);
    const ambient = fauxProvider({ provider: "cli-ambient", models: [] });
    ambient.provider.auth = { apiKey: buildAmbientLoginAuth({ displayName: "Local login", isConfigured: () => false, sourceLabel: "local" }) };
    runtime.registerNativeProvider(ambient.provider);
    store = new SessionStore();
    Object.assign(store, { internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} }, modelRuntime: runtime });
  });
  after(async () => { await store?.disposeAll(); rmSync(dir, { recursive: true, force: true }); });

  it("lists extension-registered IDs even with no models", async () => {
    const providers = await store.getProviders();
    assert.deepEqual(providers.find((p) => p.provider === "extension-exact_ID"),
      { provider: "extension-exact_ID", supportsSessionApiKey: true });
    assert.ok(!JSON.stringify(providers).includes("secret-sentinel"));
  });
  it("lists native providers without auth as unsupported", async () => {
    assert.deepEqual((await store.getProviders()).find((p) => p.provider === "extension-authless"),
      { provider: "extension-authless", supportsSessionApiKey: false });
  });
  it("marks ambient login providers unsupported", async () => {
    assert.deepEqual((await store.getProviders()).find((p) => p.provider === "cli-ambient"),
      { provider: "cli-ambient", supportsSessionApiKey: false });
  });
  it("includes excluded providers but marks session keys unsupported", async () => {
    assert.deepEqual((await store.getProviders()).find((p) => p.provider === "github-copilot"),
      { provider: "github-copilot", supportsSessionApiKey: false });
  });
  it("omits unknown provider IDs", async () => {
    assert.equal((await store.getProviders()).some((p) => p.provider === "not-registered"), false);
  });
  it("logs the runtime provider count", async () => {
    const debug = logger.debug;
    const records: unknown[][] = [];
    logger.debug = (...args: unknown[]) => { records.push(args); };
    try {
      const providers = await store.getProviders();
      assert.ok(records.some(([name, message, context]) => name === "[provider-discovery]" &&
        message === "Runtime providers listed" &&
        typeof context === "object" && context !== null && "count" in context && context.count === providers.length));
    } finally {
      logger.debug = debug;
    }
  });
  it("does not call filtered model discovery or auth checks", async () => {
    runtime.getAvailable = () => { throw new Error("filtered models called"); };
    runtime.checkAuth = async () => { throw new Error("auth called"); };
    assert.ok((await store.getProviders()).some((p) => p.provider === "openai"));
  });
  it("rejects discovery after shutdown", async () => {
    await store.disposeAll();
    await assert.rejects(store.getProviders(), (err: any) => err.statusCode === 503);
  });
});
