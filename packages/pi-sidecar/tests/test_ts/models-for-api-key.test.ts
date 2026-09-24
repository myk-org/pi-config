import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { startSidecar } from "../../src/index.js";
import { SessionStore } from "../../src/sessions.js";
import { logger } from "../../src/logger.js";

const keyA = 'local-"\\/key-a'; // pragma: allowlist secret — synthetic test credential
const keyB = "local-key-b"; // pragma: allowlist secret — synthetic test credential
const variants = (key: string) => [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)];
const noKey = (text: string, key: string) => {
  for (const variant of variants(key)) assert.ok(!text.includes(variant), "credential leaked");
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("POST /models/for-api-key", { concurrency: false }, () => {
  let upstream: Server;
  let upstreamUrl: string;
  let sidecar: ReturnType<typeof startSidecar>;
  let url: string;
  let originalFetch: typeof fetch;
  let offline: string | undefined;
  let ambient: string | undefined;
  const received: Array<{ path: string; authorization: string; googleKey: string; anthropicKey: string; version: string }> = [];
  let upstreamStatus = 200;
  let upstreamBody: unknown;
  let byKey = false;
  let pageResponse: ((path: string) => unknown) | undefined;

  const request = (body: unknown) => fetch(`${url}/models/for-api-key`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  before(async () => {
    upstream = createServer((req, res) => {
      const authorization = req.headers.authorization ?? "";
      received.push({ path: req.url ?? "", authorization, googleKey: String(req.headers["x-goog-api-key"] ?? ""), anthropicKey: String(req.headers["x-api-key"] ?? ""), version: String(req.headers["anthropic-version"] ?? "") });
      res.writeHead(upstreamStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(pageResponse ? pageResponse(req.url ?? "") : byKey ? { data: [{ id: authorization === `Bearer ${keyA}` ? "only-a" : "only-b" }] } : upstreamBody));
    });
    upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
    originalFetch = globalThis.fetch;
    // Only the external OpenAI model-list API is redirected; the sidecar and SDK remain real.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input);
      const origin = ["https://api.openai.com", "https://generativelanguage.googleapis.com", "https://api.anthropic.com"]
        .find((host) => target.startsWith(`${host}/`));
      if (origin) {
        const redirected = target.replace(origin, upstreamUrl);
        return originalFetch(input instanceof Request ? new Request(redirected, input) : redirected, init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    offline = process.env.PI_OFFLINE;
    ambient = process.env.OPENAI_API_KEY;
    process.env.PI_OFFLINE = "1";
    delete process.env.OPENAI_API_KEY;
    const blocker = createServer();
    const port = await listen(blocker);
    await close(blocker);
    url = `http://127.0.0.1:${port}`;
    sidecar = startSidecar({ host: "127.0.0.1", port });
    await sidecar.ready;
  });
  after(async () => {
    await sidecar?.close();
    globalThis.fetch = originalFetch;
    await close(upstream);
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
    if (ambient === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ambient;
  });

  it("returns key-listed OpenAI IDs without static catalog guesses or invented capabilities", async () => {
    upstreamBody = { data: [
      { id: "key-only-model-839", name: "Key only" },
      { id: "opaque-model-839" },
      { id: "text-embedding-3-small" }, { id: "omni-moderation-latest" },
      { id: "gpt-image-1" }, { id: "dall-e-3" }, { id: "whisper-1" },
      { id: "tts-1" }, { id: "gpt-4o-audio-preview" },
      { id: "gpt-4o-mini" }, { id: "gpt-4o-transcribe" },
    ] };
    const response = await request({ provider: "openai", api_key: keyA });
    assert.equal(response.status, 200, await response.clone().text());
    const { models, modelListingSupported } = await response.json() as { models: Array<Record<string, unknown>>; modelListingSupported: boolean };
    assert.equal(modelListingSupported, true);
    assert.deepEqual(models.map((model) => model.id), ["key-only-model-839", "opaque-model-839", "gpt-4o-mini"]);
    assert.deepEqual(models.map((model) => model.provider), ["openai", "openai", "openai"]);
    assert.equal(models[0].name, "Key only");
    assert.equal(models[0].capabilities, undefined);
    assert.equal(models[1].capabilities, undefined);
    assert.equal(received.at(-1)?.authorization, `Bearer ${keyA}`);
    noKey(JSON.stringify(models), keyA);
  });

  it("discovers heterogeneous Google models using the Google key header", async () => {
    upstreamBody = { models: [
      { name: "models/gemini-private-839", displayName: "Private Gemini", supportedGenerationMethods: ["generateContent", "countTokens"], inputTokenLimit: 8192, outputTokenLimit: 2048 },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"], inputTokenLimit: 8192, outputTokenLimit: 2048 },
      { name: "models/gemini-without-methods", inputTokenLimit: 8192, outputTokenLimit: 2048 },
      { name: "not-a-model", displayName: "Invalid" },
      { name: `models/${keyA}`, displayName: "Echoed credential" },
    ] };
    const response = await request({ provider: "google", api_key: keyA });
    assert.equal(response.status, 200, await response.clone().text());
    noKey(await response.clone().text(), keyA);
    assert.deepEqual(await response.json(), { models: [{ provider: "google", id: "gemini-private-839", name: "Private Gemini", capabilities: { supportedGenerationMethods: ["generateContent", "countTokens"], inputTokenLimit: 8192, outputTokenLimit: 2048 } }], modelListingSupported: true });
    assert.equal(received.at(-1)?.path, "/v1beta/models");
    assert.equal(received.at(-1)?.googleKey, keyA);
    assert.equal(received.at(-1)?.authorization, "");
  });

  it("discovers heterogeneous Anthropic models using the Anthropic key header", async () => {
    upstreamBody = { data: [
      { id: "claude-private-839", display_name: "Private Claude" },
      { id: "claude-other-839", display_name: "Other" },
    ] };
    const response = await request({ provider: "anthropic", api_key: keyB });
    assert.equal(response.status, 200, await response.clone().text());
    noKey(await response.clone().text(), keyB);
    assert.deepEqual(await response.json(), { models: [
      { provider: "anthropic", id: "claude-private-839", name: "Private Claude" },
      { provider: "anthropic", id: "claude-other-839", name: "Other" },
    ], modelListingSupported: true });
    assert.equal(received.at(-1)?.path, "/v1/models");
    assert.equal(received.at(-1)?.anthropicKey, keyB);
    assert.equal(received.at(-1)?.version, "2023-06-01");
    assert.equal(received.at(-1)?.authorization, "");
  });

  it("collects every Anthropic page without leaking the credential into pagination URLs", async () => {
    const paths: string[] = [];
    pageResponse = (path) => {
      paths.push(path);
      return path === "/v1/models"
        ? { data: [{ id: "claude-page-one", display_name: "Page one" }], has_more: true, last_id: "claude-page-one" }
        : { data: [{ id: "claude-page-two", display_name: "Page two" }], has_more: false };
    };
    try {
      const response = await request({ provider: "anthropic", api_key: keyA });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual((await response.json()).models.map((model: { id: string }) => model.id), ["claude-page-one", "claude-page-two"]);
      assert.deepEqual(paths, ["/v1/models", "/v1/models?after_id=claude-page-one"]);
      assert.ok(received.slice(-2).every((entry) => entry.anthropicKey === keyA));
      paths.forEach((path) => noKey(path, keyA));
    } finally { pageResponse = undefined; }
  });

  it("collects every Google page with a header-only credential", async () => {
    const paths: string[] = [];
    pageResponse = (path) => {
      paths.push(path);
      return path === "/v1beta/models"
        ? { models: [{ name: "models/gemini-page-one", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "next-page" }
        : { models: [{ name: "models/gemini-page-two", supportedGenerationMethods: ["generateContent"] }] };
    };
    try {
      const response = await request({ provider: "google", api_key: keyA });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual((await response.json()).models.map((model: { id: string }) => model.id), ["gemini-page-one", "gemini-page-two"]);
      assert.deepEqual(paths, ["/v1beta/models", "/v1beta/models?pageToken=next-page"]);
      assert.ok(received.slice(-2).every((entry) => entry.googleKey === keyA));
      paths.forEach((path) => noKey(path, keyA));
    } finally { pageResponse = undefined; }
  });

  it("rejects a deeply encoded credential in providerId", async () => {
    const nested = Array.from({ length: 8 }, (_, i) => i).reduce((value) => encodeURIComponent(value), keyA);
    const response = await request({ provider: nested, api_key: keyA });
    assert.equal(response.status, 400, await response.clone().text());
    noKey(await response.text(), keyA);
  });

  it("omits model fields with deeply percent-encoded credentials", async () => {
    const nested = Array.from({ length: 8 }, (_, i) => i).reduce((value) => encodeURIComponent(value), keyA);
    upstreamBody = { data: [{ id: "safe-model" }, { id: `echo-${nested}` }, { id: "echo-name", name: nested }] };
    const response = await request({ provider: "openai", api_key: keyA });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await response.json()).models.map((m: { id: string }) => m.id), ["safe-model"]);
  });

  it("rejects deeply encoded pagination credentials before another request", async () => {
    const nested = Array.from({ length: 8 }, (_, i) => i).reduce((value) => encodeURIComponent(value), keyA);
    pageResponse = () => ({ models: [], nextPageToken: nested });
    const before = received.length;
    try {
      const response = await request({ provider: "google", api_key: keyA });
      assert.equal(response.status, 502, await response.clone().text());
      assert.equal(received.length, before + 1);
      noKey(await response.text(), keyA);
    } finally { pageResponse = undefined; }
  });

  it("rejects pagination tokens beyond the decode bound", async () => {
    const token = Array.from({ length: 34 }, (_, i) => i).reduce((value) => encodeURIComponent(value), "%41");
    pageResponse = () => ({ models: [], nextPageToken: token });
    try {
      const response = await request({ provider: "google", api_key: keyA });
      assert.equal(response.status, 502, await response.clone().text());
    } finally { pageResponse = undefined; }
  });

  it("rejects undecodable pagination tokens at the decode bound", async () => {
    pageResponse = () => ({ models: [], nextPageToken: "%".repeat(200) });
    try {
      const response = await request({ provider: "google", api_key: keyA });
      assert.equal(response.status, 502, await response.clone().text());
    } finally { pageResponse = undefined; }
  });

  it("reports native listing support when upstream returns an empty list", async () => {
    upstreamBody = { data: [] };
    const response = await request({ provider: "openai", api_key: keyA });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { models: [], modelListingSupported: true });
    assert.equal(received.at(-1)?.authorization, `Bearer ${keyA}`);
  });

  it("isolates concurrent credentials without changing GET /models or creating sessions", async () => {
    const baseline = await (await fetch(`${url}/models`)).json();
    const healthBefore = await (await fetch(`${url}/health`)).json() as { sessions: number };
    byKey = true;
    const [a, b] = await Promise.all([
      request({ provider: "openai", api_key: keyA }),
      request({ provider: "openai", api_key: keyB }),
    ]);
    assert.equal(a.status, 200, await a.clone().text());
    assert.equal(b.status, 200, await b.clone().text());
    const resultA = await a.json();
    const resultB = await b.json();
    assert.equal(resultA.modelListingSupported, true);
    assert.equal(resultB.modelListingSupported, true);
    assert.deepEqual(resultA.models.map((model: { id: string }) => model.id), ["only-a"]);
    assert.deepEqual(resultB.models.map((model: { id: string }) => model.id), ["only-b"]);
    assert.deepEqual(received.slice(-2).map((entry) => entry.authorization).sort(), [`Bearer ${keyA}`, `Bearer ${keyB}`].sort());
    byKey = false;
    assert.deepEqual(await (await fetch(`${url}/models`)).json(), baseline);
    assert.equal((await (await fetch(`${url}/health`)).json() as { sessions: number }).sessions, healthBefore.sessions);
  });

  for (const [name, api_key] of [["missing", undefined], ["null", null], ["empty", ""], ["blank", "  "], ["numeric", 42], ["oversized", "x".repeat(1025)], ["unpaired surrogate", "a\ud800b"]] as const) {
    it(`rejects ${name} keys without contacting the provider`, async () => {
      const count = received.length;
      const response = await request({ provider: "openai", api_key });
      assert.equal(response.status, 400, await response.clone().text());
      assert.equal(received.length, count);
      noKey(await response.text(), keyA);
    });
  }

  it("rejects providers without session-key capability before model discovery", async () => {
    for (const provider of [undefined, "", "unknown-provider-839", "github-copilot"]) {
      const count = received.length;
      const response = await request({ provider, api_key: keyA });
      assert.ok(response.status >= 400 && response.status < 500, await response.clone().text());
      noKey(await response.text(), keyA);
      assert.equal(received.length, count);
    }
  });

  it("rejects upstream invalid credentials without publishing static models or credential text", async () => {
    upstreamStatus = 401;
    upstreamBody = { error: `invalid ${keyA} ${encodeURIComponent(keyA)}` };
    try {
      const response = await request({ provider: "openai", api_key: keyA });
      assert.ok(response.status >= 400, await response.clone().text());
      noKey(await response.text(), keyA);
    } finally { upstreamStatus = 200; }
  });

  for (const [name, status, body] of [["invalid model-list payloads", 200, { data: "invalid" }], ["upstream failures", 503, { error: "unavailable" }]] as const) {
    it(`rejects ${name} without static model fallback`, async () => {
      upstreamStatus = status;
      upstreamBody = body;
      try {
        const response = await request({ provider: "openai", api_key: keyA });
        assert.ok(response.status >= 400, await response.clone().text());
        assert.ok(!('models' in await response.json()));
      } finally { upstreamStatus = 200; }
    });
  }

  it("does not expose credential variants in malicious upstream fields, responses, or logs", async () => {
    const captured: string[] = [];
    const original = { debug: logger.debug, info: logger.info, warn: logger.warn, error: logger.error, log: logger.log };
    for (const level of Object.keys(original) as Array<keyof typeof original>) {
      (logger[level] as (...args: unknown[]) => void) = (...args: unknown[]) => { captured.push(JSON.stringify(args)); };
    }
    try {
      upstreamBody = { data: [{ id: `model-${keyA}`, name: encodeURIComponent(keyA), description: JSON.stringify(keyA) }] };
      const response = await request({ provider: "openai", api_key: keyA });
      noKey(await response.text(), keyA);
      upstreamStatus = 401;
      upstreamBody = { error: `invalid ${keyA} ${encodeURIComponent(keyA)} ${JSON.stringify(keyA).slice(1, -1)}` };
      const error = await request({ provider: "openai", api_key: keyA });
      noKey(await error.text(), keyA);
      noKey(captured.join("\n"), keyA);
    } finally {
      upstreamStatus = 200;
      Object.assign(logger, original);
    }
  });
});

describe("SessionStore key-scoped OpenAI-compatible discovery", { concurrency: false }, () => {
  for (const [provider, base] of [["groq", "https://api.groq.com/openai/v1"], ["xai", "https://api.x.ai/v1"]]) {
    it(`lists ${provider} models only at the SDK builtin endpoint`, async () => {
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      const store = new SessionStore();
      Object.assign(store, { internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} }, modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true });
      const originalFetch = globalThis.fetch;
      const paths: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        paths.push(String(input));
        return new Response(JSON.stringify({ data: [{ id: "new-private-839" }] }), { status: 200 });
      }) as typeof fetch;
      try {
        assert.deepEqual((await store.getModelsForApiKey(provider, keyA)).models.map((m) => m.id), ["new-private-839"]);
        assert.equal(paths.at(-1), `${base}/models`);
      } finally { globalThis.fetch = originalFetch; await store.disposeAll(); }
    });
  }

  it("rejects a builtin ID whose runtime endpoint differs from Pi's builtin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-shadow-"));
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { groq: {
      baseUrl: "https://evil.example/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [{ id: "static" }],
    } } }));
    const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, { internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} }, modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true });
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw new Error("unexpected request"); }) as typeof fetch;
    try {
      assert.deepEqual(await store.getModelsForApiKey("groq", keyA), { models: [], modelListingSupported: false });
      assert.equal(requests, 0);
    } finally { globalThis.fetch = originalFetch; await store.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns no listing for a session-key provider without a native model-list endpoint", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const native = fauxProvider({ provider: "key-no-list-839", models: [{ id: "static-only" }] });
    native.provider.auth = { apiKey: { name: "Key", resolve: async () => undefined } } as never;
    runtime.registerNativeProvider(native.provider);
    const store = new SessionStore();
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true,
    });
    try {
      assert.equal((await store.getProviderStatus("key-no-list-839")).supportsSessionApiKey, true);
      assert.ok(runtime.getModels("key-no-list-839").some((model) => model.id === "static-only"));
      assert.deepEqual(await store.getModelsForApiKey("key-no-list-839", keyA), {
        models: [], modelListingSupported: false,
      });
      assert.equal(store.count(), 0);
    } finally {
      await store.disposeAll();
    }
  });

  it("never fetches a custom provider's private-network model URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-ssrf-"));
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { unsafe839: {
      baseUrl: "http://169.254.169.254/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [{ id: "static-only", name: "Static only" }],
    } } }));
    const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true,
    });
    const originalFetch = globalThis.fetch;
    let externalRequests = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      externalRequests++;
      throw new Error("unexpected outbound request");
    }) as typeof fetch;
    try {
      assert.equal((await store.getProviderStatus("unsafe839")).supportsSessionApiKey, true);
      try {
        const result = await store.getModelsForApiKey("unsafe839", keyA);
        assert.deepEqual(result, { models: [], modelListingSupported: false });
      } catch (error) {
        assert.equal((error as { statusCode?: number }).statusCode, 400);
      }
      assert.equal(externalRequests, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declines a dotted provider's non-loopback gateway without outbound traffic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-dotted-"));
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { "gateway.example": {
      baseUrl: "https://gateway.example.com/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [{ id: "static-only", name: "Static" }],
    } } }));
    const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true,
    });
    const originalFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = (async () => { outbound++; throw new Error("unexpected outbound request"); }) as typeof fetch;
    try {
      assert.equal((await store.getProviderStatus("gateway.example")).supportsSessionApiKey, true);
      const result = await store.getModelsForApiKey("gateway.example", keyA);
      assert.deepEqual(result, { models: [], modelListingSupported: false });
      assert.equal(outbound, 0);
      noKey(JSON.stringify(result), keyA);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs sanitized provider context for unsupported model listing", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const native = fauxProvider({ provider: "key-no-list-log-839", models: [{ id: "static-only" }] });
    native.provider.auth = { apiKey: { name: "Key", resolve: async () => undefined } } as never;
    runtime.registerNativeProvider(native.provider);
    const store = new SessionStore();
    Object.assign(store, { internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} }, modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true });
    const original = logger.debug;
    const logs: string[] = [];
    logger.debug = (...args) => { logs.push(JSON.stringify(args)); };
    try {
      assert.equal((await store.getModelsForApiKey("key-no-list-log-839", keyA)).modelListingSupported, false);
      assert.ok(logs.some((line) => line.includes("Provider has no native model listing") && line.includes("key-no-list-log-839") && line.includes("modelListingSupported")));
      noKey(logs.join("\n"), keyA);
    } finally { logger.debug = original; await store.disposeAll(); }
  });

  it("does not contact a custom gateway when no key is supplied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-no-key-"));
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { "gateway.example": {
      baseUrl: "https://gateway.example.com/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [{ id: "static-only", name: "Static" }],
    } } }));
    const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true,
    });
    const originalFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = (async () => { outbound++; throw new Error("unexpected outbound request"); }) as typeof fetch;
    try {
      await assert.rejects(() => store.getModelsForApiKey("gateway.example", ""), (error: any) => error.statusCode === 400);
      await assert.rejects(() => store.create({ provider: "gateway.example", model: "not-in-catalog", systemPrompt: "hi", cwd: dir, agentDir: dir, tools: [] }),
        (error: any) => error.statusCode === 400);
      assert.equal(outbound, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns unsupported without outbound requests when a gateway has no compatible models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-fallback-"));
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { "gateway.example": {
      baseUrl: "https://gateway.example.com/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [],
    } } }));
    const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true,
    });
    const originalFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = (async () => { outbound++; throw new Error("unexpected outbound request"); }) as typeof fetch;
    try {
      try {
        assert.deepEqual(await store.getModelsForApiKey("gateway.example", keyA), { models: [], modelListingSupported: false });
      } catch (error) {
        assert.equal((error as { statusCode?: number }).statusCode, 400);
      }
      assert.equal(outbound, 0);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const status of [401, 502]) {
    it(`preserves discovery status ${status} for an unknown session model`, async () => {
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      const store = new SessionStore();
      Object.assign(store, { internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} }, modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response("{}", { status: status === 401 ? 401 : 503 })) as typeof fetch;
      const dir = mkdtempSync(join(tmpdir(), "sidecar-839-fail-"));
      try {
        await assert.rejects(() => store.create({ provider: "openai", model: "unknown-839", systemPrompt: "hi", cwd: dir, agentDir: dir, tools: [], apiKey: keyA }),
          (error: any) => error.statusCode === status && !error.message.includes(keyA));
      } finally { globalThis.fetch = originalFetch; await store.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it("uses validated Google token limits for a session-only model", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, { internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} }, modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ models: [{
      name: "models/gemini-new-839", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 4096, outputTokenLimit: 1024,
    }] }), { status: 200 })) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-google-"));
    try {
      const session = await store.create({ provider: "google", model: "gemini-new-839", systemPrompt: "hi", cwd: dir, agentDir: dir, tools: [], apiKey: keyA });
      const selected = (store as any).sessions.get(session).session.model;
      assert.equal(selected?.contextWindow, 4096);
      assert.equal(selected?.maxTokens, 1024);
      store.delete(session);
    } finally { globalThis.fetch = originalFetch; await store.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects embedding-only Google models even with native limits", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, { internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} }, modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ models: [{
      name: "models/embedding-private-839", supportedGenerationMethods: ["embedContent"], inputTokenLimit: 4096, outputTokenLimit: 1024,
    }] }), { status: 200 })) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-embed-"));
    try {
      await assert.rejects(
        () => store.create({ provider: "google", model: "embedding-private-839", systemPrompt: "hi", cwd: dir, agentDir: dir, tools: [], apiKey: keyA }),
        (error: any) => error.statusCode === 400,
      );
      assert.equal(store.count(), 0);
    } finally { globalThis.fetch = originalFetch; await store.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects unknown Google models with incomplete native limits", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, { internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} }, modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ models: [{
      name: "models/gemini-incomplete-839", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 4096,
    }] }), { status: 200 })) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-incomplete-"));
    try {
      await assert.rejects(
        () => store.create({ provider: "google", model: "gemini-incomplete-839", systemPrompt: "hi", cwd: dir, agentDir: dir, tools: [], apiKey: keyA }),
        (error: any) => error.statusCode === 400 && /metadata missing reliable input\/output token limits/.test(error.message),
      );
      assert.equal(store.count(), 0);
    } finally { globalThis.fetch = originalFetch; await store.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses the local model API per key without modifying the shared catalog or cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-"));
    const seen: string[] = [];
    const api = createServer((req, res) => {
      seen.push(req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: req.headers.authorization === `Bearer ${keyA}` ? "only-a" : "only-b", name: "Private" }] }));
    });
    const port = await listen(api);
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { "gateway.839": {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [{ id: "unverified-static", name: "Unverified" }],
    } } }));
    const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true,
    });
    try {
      const before = (await store.getModels()).filter((model) => model.provider === "gateway.839");
      const snapshot = runtime.getAvailableSnapshot().filter((model) => model.provider === "gateway.839");
      const [a, b] = await Promise.all([
        store.getModelsForApiKey("gateway.839", keyA),
        store.getModelsForApiKey("gateway.839", keyB),
      ]);
      assert.equal(a.modelListingSupported, true);
      assert.equal(b.modelListingSupported, true);
      assert.deepEqual(a.models.map((model) => model.id), ["only-a"]);
      assert.deepEqual(b.models.map((model) => model.id), ["only-b"]);
      assert.deepEqual(a.models.map((model) => model.provider), ["gateway.839"]);
      assert.deepEqual(b.models.map((model) => model.provider), ["gateway.839"]);
      assert.deepEqual(seen.sort(), [`Bearer ${keyA}`, `Bearer ${keyB}`].sort());
      assert.deepEqual((await store.getModels()).filter((model) => model.provider === "gateway.839"), before);
      assert.deepEqual(runtime.getAvailableSnapshot().filter((model) => model.provider === "gateway.839"), snapshot);
      assert.equal(store.count(), 0);
      await assert.rejects(
        () => store.create({ provider: "gateway.839", model: "only-a", systemPrompt: "hi", cwd: dir, agentDir: dir, tools: [], apiKey: keyA }),
        (error: any) => error.statusCode === 400 && /metadata missing reliable input\/output token limits/.test(error.message),
      );
      assert.equal(store.count(), 0);
      assert.deepEqual((await store.getModels()).filter((model) => model.provider === "gateway.839"), before);
      assert.deepEqual(runtime.getAvailableSnapshot().filter((model) => model.provider === "gateway.839"), snapshot);
      noKey(JSON.stringify(runtime.getModels("gateway.839")), keyA);
      noKey(JSON.stringify(runtime.getModels("gateway.839")), keyB);
      noKey(JSON.stringify(runtime.getAvailableSnapshot()), keyA);
      noKey(JSON.stringify(runtime.getAvailableSnapshot()), keyB);
    } finally {
      await store.disposeAll();
      await close(api);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
