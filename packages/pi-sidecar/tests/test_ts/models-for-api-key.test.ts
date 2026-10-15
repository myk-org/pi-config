import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { startSidecar } from "../../src/index.js";
import { SessionStore, readTrustedKeyScopedProviders } from "../../src/sessions.js";
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
      const origin = ["https://api.openai.com", "https://generativelanguage.googleapis.com", "https://api.anthropic.com", "https://openrouter.ai"]
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

  /**
   * A canonical builtin whose catalog is not uniformly OpenAI-shaped still lists.
   * OpenRouter fronts Anthropic models alongside OpenAI ones, which used to fail the
   * API-uniformity gate and return an empty list instead of the provider's own models.
   */
  it("lists models for a multi-API canonical builtin on its canonical host", async () => {
    upstreamBody = { data: [
      { id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha" },
      { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
    ] };
    const response = await request({ provider: "openrouter", api_key: keyA });
    assert.equal(response.status, 200, await response.clone().text());
    const { models, modelListingSupported } = await response.json() as { models: Array<Record<string, unknown>>; modelListingSupported: boolean };
    assert.equal(modelListingSupported, true, "a multi-API canonical builtin supports key-scoped listing");
    // An id pi-ai's runtime cannot resolve is withheld: the mixed-API catalog offers no
    // unambiguous template for it, so it could not be used in a session either.
    assert.deepEqual(models.map((model) => model.id), ["stealth/space-bunny-alpha", "openai/gpt-4o-mini"]);
    assert.deepEqual(models.map((model) => model.provider), ["openrouter", "openrouter"]);
    assert.equal(received.at(-1)?.path, "/api/v1/models", "listing must use the provider's own canonical models path");
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
    assert.deepEqual(await response.json(), { models: [{ provider: "google", id: "gemini-private-839", name: "Private Gemini", source: "listing", capabilities: { supportedGenerationMethods: ["generateContent", "countTokens"], inputTokenLimit: 8192, outputTokenLimit: 2048 } }], modelListingSupported: true });
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
      { provider: "anthropic", id: "claude-private-839", name: "Private Claude", source: "listing" },
      { provider: "anthropic", id: "claude-other-839", name: "Other", source: "listing" },
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

  /**
   * Relaxing the API-uniformity gate must not relax host trust: a models.json
   * `baseUrl` override repoints the builtin somewhere else, so the canonical
   * branch no longer applies and the key must never leave the process.
   */
  it("refuses to list for a builtin whose baseUrl is overridden away from canonical", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-892-redirect-"));
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { openrouter: {
      baseUrl: "https://redirected.example/v1",
    } } }));
    const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true,
    });
    const originalFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.startsWith("http")) outbound++;
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const result = await store.getModelsForApiKey("openrouter", keyA).catch((error: any) => error);
      assert.equal(result.modelListingSupported, false, "a redirected base must not be listed against");
      assert.deepEqual(result.models, []);
      assert.equal(outbound, 0, "no credential may reach a user-supplied endpoint");
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
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
          (error: any) => error.statusCode === status);
      } finally { globalThis.fetch = originalFetch; await store.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it("does not include the supplied key in discovery errors", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, { internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} }, modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: `invalid ${keyA}` }), { status: 401 })) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-secret-"));
    try {
      await assert.rejects(() => store.create({ provider: "openai", model: "unknown-839", systemPrompt: "hi", cwd: dir, agentDir: dir, tools: [], apiKey: keyA }),
        (error: Error) => { noKey(error.message, keyA); return true; });
    } finally { globalThis.fetch = originalFetch; await store.disposeAll(); rmSync(dir, { recursive: true, force: true }); }
  });

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

  it("marks a key-discovered model as unknown-priced on the stored session", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const store = new SessionStore();
    Object.assign(store, { internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} }, modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ models: [
      { name: "models/gemini-zeroprice-839", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 4096, outputTokenLimit: 1024 },
    ] }), { status: 200 })) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "sidecar-839-zeroprice-"));
    try {
      const id = await store.create({ provider: "google", model: "gemini-zeroprice-839", systemPrompt: "hi", cwd: dir, agentDir: dir, tools: [], apiKey: keyA });
      const entry = (store as any).sessions.get(id);
      assert.equal(entry.pricingKnown, false, "a key-discovered model has no catalog price, so pricing is unknown");
      store.delete(id);
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

/**
 * trustKeyScopedListing (issue 912): opt-in, per-provider flag in the agent-dir
 * models.json. The flag is a startup snapshot read by the SessionStore
 * constructor — the only source the key-scoped listing trust gate accepts.
 */
describe("trustKeyScopedListing manifest flag", { concurrency: false }, () => {
  const writeManifest = (dir: string, providers: Record<string, Record<string, unknown>>): void => {
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers }));
  };

  /** Same fixture shape as the surrounding SessionStore tests: real runtime over a
   * temp models.json, store built with that agentDir so the manifest flag is read. */
  const fixtureStore = async (dir: string) => {
    const runtime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const store = new SessionStore({ agentDir: dir });
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true,
    });
    return store;
  };

  /** Issue 913 fixtures where the startup manifest snapshot (store's agentDir)
   * and the lazily loaded runtime catalog (runtime's models.json) diverge —
   * the shape the snapshot-pinning and limits-fallback behaviors guard. */
  const splitFixtureStore = async (manifestDir: string, runtimeDir: string) => {
    const runtime = await ModelRuntime.create({ modelsPath: join(runtimeDir, "models.json"), authPath: join(runtimeDir, "auth.json"), refreshOnCreate: false });
    const store = new SessionStore({ agentDir: manifestDir });
    Object.assign(store, {
      internalRuntime: { services: { modelRuntime: runtime }, dispose: async () => {} },
      modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), _ready: true,
    });
    return store;
  };

  it("lists a manifest-flagged custom provider against its configured baseUrl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-912-flag-"));
    writeManifest(dir, {
      flagged912: { baseUrl: "https://flagged.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
        trustKeyScopedListing: true, models: [{ id: "static-only", name: "Static" }] },
    });
    const store = await fixtureStore(dir);
    const originalFetch = globalThis.fetch;
    const fetched: string[] = [];
    let authorization = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      const headers = init?.headers as Record<string, string> | undefined;
      authorization = String(headers?.Authorization ?? "");
      return new Response(JSON.stringify({ data: [{ id: "new-private-912" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      assert.equal((await store.getProviderStatus("flagged912")).supportsSessionApiKey, true);
      const result = await store.getModelsForApiKey("flagged912", keyA);
      assert.equal(result.modelListingSupported, true, "a flagged custom provider supports key-scoped listing");
      assert.deepEqual(result.models.map((model) => model.id), ["new-private-912", "static-only"],
        "live listing plus the provider's manifest-configured model (union)");
      assert.deepEqual(result.models.map((model) => model.provider), ["flagged912", "flagged912"]);
      assert.deepEqual(fetched, ["https://flagged.example.test/v1/models"], "listing must target the flagged provider's configured baseUrl");
      assert.equal(authorization, `Bearer ${keyA}`, "the request key, not the manifest key, must be sent");
      noKey(JSON.stringify(result), keyA);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses key-scoped listing for an unflagged sibling provider without any request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-912-plain-"));
    writeManifest(dir, {
      plain912: { baseUrl: "https://plain.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
        models: [{ id: "static-only", name: "Static" }] },
    });
    const store = await fixtureStore(dir);
    const originalFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = (async () => { outbound++; throw new Error("unexpected outbound request"); }) as typeof fetch;
    try {
      assert.equal((await store.getProviderStatus("plain912")).supportsSessionApiKey, true);
      assert.deepEqual(await store.getModelsForApiKey("plain912", keyA), { models: [], modelListingSupported: false });
      assert.equal(outbound, 0, "an identical provider without the flag keeps today's refusal, with no request");
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [name, baseUrl] of [
    ["userinfo", "https://user:secret@hygiene.example.test/v1"], // pragma: allowlist secret — synthetic URL, never fetched
    ["query", "https://hygiene.example.test/v1?x=1"],
    ["hash", "https://hygiene.example.test/v1#frag"],
  ] as const) {
    it(`rejects a flagged provider baseUrl with ${name}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `sidecar-912-hygiene-${name}-`));
      writeManifest(dir, { hygiene912: { baseUrl, api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
        trustKeyScopedListing: true, models: [{ id: "static-only", name: "Static" }] } });
      const store = await fixtureStore(dir);
      const originalFetch = globalThis.fetch;
      let outbound = 0;
      globalThis.fetch = (async () => { outbound++; throw new Error("unexpected outbound request"); }) as typeof fetch;
      try {
        assert.equal((await store.getProviderStatus("hygiene912")).supportsSessionApiKey, true);
        assert.deepEqual(await store.getModelsForApiKey("hygiene912", keyA), { models: [], modelListingSupported: false });
        assert.equal(outbound, 0, "the credential must never reach a URL failing hygiene checks");
      } finally {
        globalThis.fetch = originalFetch;
        await store.disposeAll();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("marks duplicate manifest ids as manifest-sourced when the gateway lists neither", async () => {
    // Regression: indexById accumulates manifest ids during the merge, so a
    // second manifest entry with the same id must NOT inherit "listing"
    // provenance from the first — source derives from the pre-merge live set.
    const dir = mkdtempSync(join(tmpdir(), "sidecar-913-dup-manifest-"));
    writeManifest(dir, {
      dup913: { baseUrl: "https://dup.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
        trustKeyScopedListing: true, models: [
          { id: "dup-913", name: "First Copy", contextWindow: 2048, maxTokens: 512 },
          { id: "dup-913", name: "Second Copy", contextWindow: 4096, maxTokens: 1024 },
        ] },
    });
    const store = await fixtureStore(dir);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "other-live-913", name: "Other" }] }), { status: 200 })) as typeof fetch;
    try {
      const result = await store.getModelsForApiKey("dup913", keyA);
      assert.equal(result.modelListingSupported, true);
      const copies = result.models.filter((model) => model.id === "dup-913");
      assert.equal(copies.length, 1, "duplicate manifest ids collapse to one entry (last wins)");
      assert.equal(copies[0].name, "Second Copy");
      assert.equal(copies[0].source, "manifest",
        "a manifest id the gateway never listed is NOT key-verified, even when duplicated in the manifest");
      const liveEntry = result.models.find((model) => model.id === "other-live-913")!;
      assert.equal(liveEntry.source, "listing");
      noKey(JSON.stringify(result), keyA);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unions the live listing with manifest-only models for a flagged provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-912-union-"));
    writeManifest(dir, {
      union912: { baseUrl: "https://union.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
        trustKeyScopedListing: true, models: [
          { id: "manifest-only-912", name: "Manifest Only", contextWindow: 8192, maxTokens: 4096 },
        ] },
    });
    const store = await fixtureStore(dir);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "live-only-912", name: "Live Only" }] }), { status: 200 })) as typeof fetch;
    try {
      const result = await store.getModelsForApiKey("union912", keyA);
      assert.equal(result.modelListingSupported, true);
      assert.deepEqual(result.models.map((model) => model.id), ["live-only-912", "manifest-only-912"],
        "live listing first, then manifest-only models appended");
      const manifestEntry = result.models.find((model) => model.id === "manifest-only-912")!;
      assert.equal(manifestEntry.provider, "union912");
      assert.equal(manifestEntry.name, "Manifest Only");
      assert.equal(manifestEntry.source, "manifest", "manifest-only entries are admin-declared, not verified for this key");
      assert.deepEqual(manifestEntry.capabilities, { inputTokenLimit: 8192, outputTokenLimit: 4096 },
        "manifest metadata uses the same capability schema as live entries");
      const liveEntry = result.models.find((model) => model.id === "live-only-912")!;
      assert.equal(liveEntry.name, "Live Only");
      assert.equal(liveEntry.source, "listing", "live-listed entries are verified for this key");
      noKey(JSON.stringify(result), keyA);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedupes by id with manifest metadata winning over the live entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-912-dedupe-"));
    writeManifest(dir, {
      dedupe912: { baseUrl: "https://dedupe.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
        trustKeyScopedListing: true, models: [
          { id: "shared-912", name: "Manifest Shared", contextWindow: 4096, maxTokens: 1024 },
        ] },
    });
    const store = await fixtureStore(dir);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "shared-912", name: "Live Shared" }] }), { status: 200 })) as typeof fetch;
    try {
      const result = await store.getModelsForApiKey("dedupe912", keyA);
      assert.equal(result.modelListingSupported, true);
      assert.equal(result.models.length, 1, "an id present in both live and manifest yields a single entry");
      // Deterministic collision rule: the admin-configured manifest entry replaces
      // the live one (explicit configuration outranks an inferred listing entry),
      // but keeps source "listing" — the gateway did list the id for this key.
      assert.deepEqual(result.models[0],
        { provider: "dedupe912", id: "shared-912", name: "Manifest Shared", source: "listing", capabilities: { inputTokenLimit: 4096, outputTokenLimit: 1024 } });
      noKey(JSON.stringify(result), keyA);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins trust to the startup snapshot baseUrl, refusing a later runtime URL change", async () => {
    // The flag was granted for the manifest's baseUrl at construction time; the
    // lazily loaded runtime provider carries a repointed URL (models.json edited
    // after SessionStore construction). The old flag must not send the user's
    // key to the new host.
    const manifestDir = mkdtempSync(join(tmpdir(), "sidecar-913-pin-manifest-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "sidecar-913-pin-runtime-"));
    writeManifest(manifestDir, { pinned913: {
      baseUrl: "https://snapshot.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      trustKeyScopedListing: true, models: [{ id: "static-only", name: "Static" }] } });
    writeManifest(runtimeDir, { pinned913: {
      baseUrl: "https://repointed.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [{ id: "static-only", name: "Static" }] } });
    const store = await splitFixtureStore(manifestDir, runtimeDir);
    const originalFetch = globalThis.fetch;
    let outbound = 0;
    globalThis.fetch = (async () => { outbound++; throw new Error("unexpected outbound request"); }) as typeof fetch;
    try {
      assert.equal((await store.getProviderStatus("pinned913")).supportsSessionApiKey, true);
      assert.deepEqual(await store.getModelsForApiKey("pinned913", keyA), { models: [], modelListingSupported: false },
        "a flagged provider whose runtime baseUrl differs from the snapshotted one stays refused");
      assert.equal(outbound, 0, "the user key must never reach the repointed host");
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(manifestDir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("redacts credential-bearing parts from the trust-mismatch warning's pinned URL", async () => {
    // The snapshot keeps the full normalized manifest URL (userinfo retained);
    // the mismatch warn must log only the origin, never credential or path.
    const manifestDir = mkdtempSync(join(tmpdir(), "sidecar-913-redact-manifest-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "sidecar-913-redact-runtime-"));
    writeManifest(manifestDir, { redact913: {
      baseUrl: "https://user:snapshot-secret@snapshot.example.test/v1", // pragma: allowlist secret — synthetic URL, never fetched
      api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      trustKeyScopedListing: true, models: [{ id: "static-only", name: "Static" }] } });
    writeManifest(runtimeDir, { redact913: {
      baseUrl: "https://repointed.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [{ id: "static-only", name: "Static" }] } });
    const store = await splitFixtureStore(manifestDir, runtimeDir);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("unexpected outbound request"); }) as typeof fetch;
    const warn = logger.warn;
    const warnings: string[] = [];
    logger.warn = (...args) => { warnings.push(JSON.stringify(args)); };
    try {
      assert.deepEqual(await store.getModelsForApiKey("redact913", keyA), { models: [], modelListingSupported: false });
      const mismatch = warnings.find((line) => line.includes("no longer matches its startup trust snapshot"));
      assert.ok(mismatch, "the mismatch warning must fire for a repointed runtime URL");
      assert.ok(mismatch.includes("https://snapshot.example.test"), "the sanitized origin is logged");
      assert.ok(!mismatch.includes("snapshot-secret"), "the credential part must never reach the log");
      assert.ok(!mismatch.includes("/v1"), "path segments are not logged (they can carry credentials)");
      noKey(warnings.join("\n"), keyA);
    } finally {
      logger.warn = warn;
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(manifestDir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("warns per skipped malformed manifest model entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-912-skip-"));
    writeManifest(dir, { skip912: {
      baseUrl: "https://skip.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      trustKeyScopedListing: true, models: [
        "not-an-object",
        { id: "", name: "Empty Id" },
        { id: "no-name-912" },
        { id: "valid-912", name: "Valid" },
      ] } });
    const warn = logger.warn;
    const warnings: string[] = [];
    logger.warn = (...args) => { warnings.push(JSON.stringify(args)); };
    try {
      const trusted = readTrustedKeyScopedProviders(dir);
      assert.deepEqual([...trusted.get("skip912")!.models], [{ id: "valid-912", name: "Valid" }],
        "only the valid entry survives");
      assert.ok(warnings.some((line) => line.includes("not an object") && line.includes("skip912")));
      assert.ok(warnings.some((line) => line.includes("invalid id or name") && line.includes("skip912")));
      assert.equal(warnings.length, 3, "one warn per skipped entry");
    } finally {
      logger.warn = warn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to manifest-declared limits when a key-listed model omits them", async () => {
    // Gateway listings (e.g. Acme) return ids without token-limit capabilities;
    // the admin declares limits for the same id in the agent-dir models.json.
    // Here the runtime catalog lacks the id, so create() must resolve it through
    // the key-scoped listing and take its limits from the manifest snapshot.
    const manifestDir = mkdtempSync(join(tmpdir(), "sidecar-913-fallback-manifest-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "sidecar-913-fallback-runtime-"));
    writeManifest(manifestDir, { limits913: {
      baseUrl: "https://limits.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      trustKeyScopedListing: true, models: [{ id: "live-no-limits-913", name: "Live No Limits", contextWindow: 8192, maxTokens: 4096 }] } });
    writeManifest(runtimeDir, { limits913: {
      baseUrl: "https://limits.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [{ id: "template-913", name: "Template" }] } });
    const store = await splitFixtureStore(manifestDir, runtimeDir);
    const originalFetch = globalThis.fetch;
    let completionsBody = "";
    let completionsAuth = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "live-no-limits-913", name: "Live No Limits" }] }), { status: 200 });
      }
      // POST chat/completions — minimal OpenAI SSE stream so the session can be
      // exercised through the public prompt() interface (no private state reads).
      completionsBody = String(init?.body ?? "");
      completionsAuth = String(new Headers(init?.headers).get("authorization") ?? "");
      const chunk = (delta: object, finishReason: string | null, usage?: object) =>
        `data: ${JSON.stringify({ id: "chatcmpl-913", object: "chat.completion.chunk", created: 1, model: "live-no-limits-913", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`;
      const sse = [
        chunk({ role: "assistant" }, null),
        chunk({ content: "manifest-limits-session-ok" }, null),
        chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
        "data: [DONE]\n\n",
      ].join("");
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode(sse)); controller.close(); },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const session = await store.create({ provider: "limits913", model: "live-no-limits-913", systemPrompt: "hi", cwd: runtimeDir, agentDir: manifestDir, tools: [], apiKey: keyA });
      // Public observable behavior: creation succeeds only with reliable limits
      // (create() 400s without them — see the remedy test below), and a real
      // prompt against the session's key-scoped model returns a real reply.
      const reply = await store.prompt(session, "hi");
      assert.equal(reply.error, undefined);
      assert.equal(reply.text, "manifest-limits-session-ok", "the manifest-limited session model must complete a real prompt");
      assert.ok(completionsBody.includes("\"live-no-limits-913\""), "the prompt must target the key-discovered model id");
      assert.equal(completionsAuth, `Bearer ${keyA}`, "the prompt must use the session key");
      noKey(JSON.stringify(reply), keyA);
      store.delete(session);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(manifestDir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("names the models.json remedy when a key-listed model has no limits anywhere", async () => {
    // Unknown limits are a hard failure by design — no fabricated defaults —
    // but the 400 must tell the admin how to make the model usable.
    const manifestDir = mkdtempSync(join(tmpdir(), "sidecar-913-remedy-manifest-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "sidecar-913-remedy-runtime-"));
    writeManifest(manifestDir, { remedy913: {
      baseUrl: "https://remedy.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      trustKeyScopedListing: true, models: [{ id: "live-no-limits-913", name: "Live No Limits" }] } });
    writeManifest(runtimeDir, { remedy913: {
      baseUrl: "https://remedy.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [{ id: "template-913", name: "Template" }] } });
    const store = await splitFixtureStore(manifestDir, runtimeDir);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "live-no-limits-913", name: "Live No Limits" }] }), { status: 200 })) as typeof fetch;
    try {
      await assert.rejects(
        () => store.create({ provider: "remedy913", model: "live-no-limits-913", systemPrompt: "hi", cwd: runtimeDir, agentDir: manifestDir, tools: [], apiKey: keyA }),
        (error: any) => error.statusCode === 400 &&
          /metadata missing reliable input\/output token limits/.test(error.message) &&
          /models\.json/.test(error.message) && /contextWindow/.test(error.message) && /maxTokens/.test(error.message),
      );
      assert.equal(store.count(), 0);
      noKey(JSON.stringify(store), keyA);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(manifestDir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("never leaks another provider's manifest models into a listing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-912-cross-"));
    writeManifest(dir, {
      crossA912: { baseUrl: "https://cross-a.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
        trustKeyScopedListing: true, models: [{ id: "a-manifest-only-912", name: "A Manifest" }] },
      crossB912: { baseUrl: "https://cross-b.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
        trustKeyScopedListing: true, models: [{ id: "b-manifest-only-912", name: "B Manifest" }] },
    });
    const store = await fixtureStore(dir);
    const originalFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ data: [{ id: "a-live-912" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await store.getModelsForApiKey("crossA912", keyA);
      assert.equal(result.modelListingSupported, true);
      assert.deepEqual(result.models.map((model) => model.id), ["a-live-912", "a-manifest-only-912"],
        "only the requested provider's live listing and manifest models are returned");
      assert.deepEqual(fetched, ["https://cross-a.example.test/v1/models"]);
      noKey(JSON.stringify(result), keyA);
    } finally {
      globalThis.fetch = originalFetch;
      await store.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a trustKeyScopedListing flag supplied in the request body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-912-body-"));
    writeManifest(dir, { plain912: { baseUrl: "https://plain.example.test/v1", api: "openai-completions", apiKey: "unused-ambient", // pragma: allowlist secret — synthetic config
      models: [{ id: "static-only", name: "Static" }] } });
    const offline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    const blocker = createServer();
    const port = await listen(blocker);
    await close(blocker);
    const sidecar = startSidecar({ host: "127.0.0.1", port, agentDir: dir });
    try {
      await sidecar.ready;
      const status = await (await fetch(`http://127.0.0.1:${port}/models/plain912/status`)).json() as { supportsSessionApiKey: boolean };
      assert.equal(status.supportsSessionApiKey, true, "fixture provider must be key-capable for the refusal path to be reachable");
      const response = await fetch(`http://127.0.0.1:${port}/models/for-api-key`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "plain912", api_key: keyA, trustKeyScopedListing: true }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      noKey(await response.clone().text(), keyA);
      assert.deepEqual(await response.json(), { models: [], modelListingSupported: false },
        "a flag from request input must never grant listing trust");
    } finally {
      await sidecar.close();
      if (offline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = offline;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
