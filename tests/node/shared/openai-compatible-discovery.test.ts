import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import installOpenAiCompatibleDiscovery from "../../../extensions/openai-compatible-discovery/index.js";
import {
  findEligibleOpenAiCompatibleProviderConfigs,
  findEligibleOpenAiCompatibleProviderConfigsResult,
  formatOpenAiCompatibleDiscoverySummary,
  materializeOpenAiCompatibleModels,
  redactOpenAiCompatibleDiagnostic,
} from "../../../extensions/shared/openai-compatible-discovery.js";

function modelIds(registry: ModelRegistry, provider = "gateway") {
  return registry.getAll().filter((model) => model.provider === provider).map((model) => model.id);
}

describe("OpenAI-compatible provider discovery", { concurrency: false }, () => {
  const originalFetch = globalThis.fetch;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "openai-compatible-discovery-agent-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function setup(options: {
    provider?: string;
    name?: string;
    mode?: "tui" | "json" | "print";
    headers?: Record<string, string>;
    discoverModelCapabilities?: boolean;
    staticModels?: Array<Record<string, unknown>>;
    beforeStart?: (runtime: ModelRuntime) => void;
    onRegister?: () => void;
  } = {}) {
    const provider = options.provider ?? "gateway";
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      [provider]: {
        name: options.name,
        baseUrl: "https://gateway.example/v1?tenant=fake",
        apiKey: "fake-key", // pragma: allowlist secret
        api: "openai-completions",
        discoverModels: true,
        discoverModelCapabilities: options.discoverModelCapabilities,
        headers: options.headers,
        models: options.staticModels ?? [{ id: "static" }],
      },
    } }));
    const { ModelRegistry, ModelRuntime } = await import("./pi-model-runtime.mts");
    const runtime = await ModelRuntime.create({
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "model-cache"),
      refreshOnCreate: false,
    });
    options.beforeStart?.(runtime);
    const registry = new ModelRegistry(runtime);
    const handlers = new Map<string, (...args: any[]) => any>();
    const appended: Array<{ type: string; data: any }> = [];
    const shortcuts: string[] = [];
    const renderers: Array<{ type: string; render: any }> = [];
    const pi = {
      on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
      registerProvider: (id: string, config: any) => {
        registry.registerProvider(id, config);
        options.onRegister?.();
      },
      unregisterProvider: (id: string) => registry.unregisterProvider(id),
      appendEntry: (type: string, data: any) => appended.push({ type, data }),
      registerEntryRenderer: (type: string, render: any) => renderers.push({ type, render }),
      registerShortcut: (shortcut: string) => shortcuts.push(shortcut),
    };
    installOpenAiCompatibleDiscovery(pi as any);
    await handlers.get("session_start")?.({}, {
      mode: options.mode ?? "tui",
      hasUI: (options.mode ?? "tui") === "tui",
      modelRegistry: registry,
    });
    return { runtime, registry, handlers, appended, shortcuts, renderers };
  }

  it("finds only exact opted-in OpenAI-compatible provider objects", () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      gateway: { api: "openai-completions", discoverModels: true },
      disabled: { api: "openai-completions" },
      wrongApi: { api: "openai-responses", discoverModels: true },
    } }));
    assert.deepEqual(findEligibleOpenAiCompatibleProviderConfigsResult().providers, [{
      id: "gateway",
      headers: undefined,
      discoverModelCapabilities: false,
    }]);
  });

  it("maps eligible provider headers through the public wrapper", () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      gateway: { api: "openai-completions", discoverModels: true, headers: { "X-Gateway": "relay" } },
    } }));
    assert.deepEqual(findEligibleOpenAiCompatibleProviderConfigs(), [{
      id: "gateway",
      headers: { "X-Gateway": "relay" },
      discoverModelCapabilities: false,
    }]);
  });

  it("publishes the startup catalog under the configured provider identity with static precedence", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [
      { id: "static", reasoning: true, contextWindow: 999 },
      { id: "discovered" },
    ] }));
    const { registry } = await setup({ staticModels: [{ id: "static", reasoning: false, contextWindow: 42 }] });

    assert.deepEqual(modelIds(registry), ["static", "discovered"]);
    const staticEntry = registry.find("gateway", "static")!;
    assert.equal(staticEntry.reasoning, false);
    assert.equal(staticEntry.contextWindow, 42);
    assert.equal(registry.find("gateway", "discovered")?.provider, "gateway");
  });

  it("waits for registration's offline refresh before startup discovery", async () => {
    let releaseOffline!: () => void;
    const offlineGate = new Promise<void>((resolve) => { releaseOffline = resolve; });
    let registered!: () => void;
    const registration = new Promise<void>((resolve) => { registered = resolve; });
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response(JSON.stringify({ data: [{ id: "discovered" }] }));
    };
    const starting = setup({
      beforeStart: (runtime) => {
        const refresh = runtime.refresh.bind(runtime);
        runtime.refresh = ((options) => options?.allowNetwork === false
          ? offlineGate.then(() => refresh(options))
          : refresh(options)) as typeof runtime.refresh;
      },
      onRegister: registered,
    });
    try {
      await registration;
      // The registration-triggered refresh has not finished. Network discovery must wait for it.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests, 0);
    } finally {
      releaseOffline();
    }
    const { registry, appended } = await starting;
    assert.deepEqual(modelIds(registry), ["static", "discovered"]);
    assert.deepEqual(appended.map(({ data }) => data.summary), ["Providers: gateway (1)"]);
  });

  it("retains the discovered snapshot during offline restore", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ id: "discovered" }] }));
    };
    const { runtime, registry } = await setup();
    assert.equal(calls, 1);

    await runtime.refresh({ providers: ["gateway"], allowNetwork: false, force: true });
    assert.equal(calls, 1);
    assert.deepEqual(modelIds(registry), ["static", "discovered"]);
  });

  it("recovers through the public provider refresh after startup discovery fails", async () => {
    let succeeds = false;
    globalThis.fetch = async () => succeeds
      ? new Response(JSON.stringify({ data: [{ id: "recovered" }] }))
      : new Response("unavailable", { status: 503 });
    const { runtime, registry, appended } = await setup();
    assert.deepEqual(modelIds(registry), ["static"]);
    assert.deepEqual(appended, []);

    succeeds = true;
    await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    assert.deepEqual(modelIds(registry), ["static", "recovered"]);
    assert.deepEqual(appended, []);
  });

  it("removes discovered models after a successful empty response", async () => {
    let data = [{ id: "old" }];
    globalThis.fetch = async () => new Response(JSON.stringify({ data }));
    const { runtime, registry } = await setup();
    assert.deepEqual(modelIds(registry), ["static", "old"]);

    data = [];
    await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    assert.deepEqual(modelIds(registry), ["static"]);
  });

  it("retains the discovered snapshot after a failed response", async () => {
    let response = new Response(JSON.stringify({ data: [{ id: "old" }] }));
    globalThis.fetch = async () => response.clone();
    const { runtime, registry } = await setup();

    response = new Response("failed", { status: 502 });
    await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    assert.deepEqual(modelIds(registry), ["static", "old"]);

    response = new Response(JSON.stringify({ data: [{ id: "new" }] }));
    await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    assert.deepEqual(modelIds(registry), ["static", "new"]);
  });

  it("drops the old catalog after API key rotation on offline refresh", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "tenant-a" }] }));
    const { runtime, registry } = await setup();
    await runtime.setRuntimeApiKey("gateway", "tenant-b-key"); // pragma: allowlist secret
    assert.deepEqual(modelIds(registry), ["static"]);
    await runtime.refresh({ providers: ["gateway"], allowNetwork: false, force: true });
    assert.deepEqual(modelIds(registry), ["static"]);
  });

  it("retains only the new key's snapshot after a failed refresh", async () => {
    let id = "tenant-a";
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id }] }));
    const { runtime, registry } = await setup();
    await runtime.setRuntimeApiKey("gateway", "tenant-b-key"); // pragma: allowlist secret
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    assert.deepEqual(modelIds(registry), ["static"]);
    id = "tenant-b";
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id }] }));
    await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    assert.deepEqual(modelIds(registry), ["static", "tenant-b"]);
  });

  it("drops the old catalog after routing header rotation", async () => {
    const previous = process.env.DISCOVERY_TEST_ROUTE;
    try {
      process.env.DISCOVERY_TEST_ROUTE = "tenant-a";
      globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "tenant-a" }] }));
      const { runtime, registry } = await setup({ headers: { "X-Route": "$DISCOVERY_TEST_ROUTE" } });
      process.env.DISCOVERY_TEST_ROUTE = "tenant-b";
      globalThis.fetch = async () => new Response("unavailable", { status: 503 });
      await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
      assert.deepEqual(modelIds(registry), ["static"]);
      await runtime.refresh({ providers: ["gateway"], allowNetwork: false, force: true });
      assert.deepEqual(modelIds(registry), ["static"]);
    } finally {
      if (previous === undefined) delete process.env.DISCOVERY_TEST_ROUTE;
      else process.env.DISCOVERY_TEST_ROUTE = previous;
    }
  });

  it("drops the old catalog after base URL rotation", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "tenant-a" }] }));
    const { runtime, registry } = await setup();
    const path = join(agentDir, "models.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.providers.gateway.baseUrl = "https://tenant-b.example/v1";
    writeFileSync(path, JSON.stringify(config));
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    assert.deepEqual(modelIds(registry), ["static"]);
    await runtime.refresh({ providers: ["gateway"], allowNetwork: false, force: true });
    assert.deepEqual(modelIds(registry), ["static"]);
  });

  it("ignores a superseded A response after B succeeds", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "initial-a" }] }));
    const { runtime, registry } = await setup();
    let release!: (response: Response) => void;
    let started!: () => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const requested = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = async () => { started(); return pending; };
    const first = runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    await requested;
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "tenant-b" }] }));
    const second = runtime.setRuntimeApiKey("gateway", "tenant-b-key"); // pragma: allowlist secret
    await second;
    await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    release(new Response(JSON.stringify({ data: [{ id: "late-a" }] })));
    await first;
    assert.deepEqual(modelIds(registry), ["static", "tenant-b"]);
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    assert.deepEqual(modelIds(registry), ["static", "tenant-b"]);
  });

  it("prevents an older concurrent refresh from replacing the newest generation", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "initial" }] }));
    const { runtime, registry } = await setup();
    const signals: AbortSignal[] = [];
    globalThis.fetch = async (_input, init) => {
      const signal = init!.signal as AbortSignal;
      signals.push(signal);
      if (signals.length > 1)
        return new Response(JSON.stringify({ data: [{ id: "newest" }] }));
      return new Promise<Response>((_resolve, reject) => signal.addEventListener(
        "abort",
        () => reject(new DOMException("Superseded", "AbortError")),
        { once: true },
      ));
    };

    const first = runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    while (signals.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    await Promise.all([first, second]);

    assert.equal(signals[0].aborted, true);
    assert.deepEqual(modelIds(registry), ["static", "newest"]);
  });

  it("preserves the previous snapshot when a superseding refresh fails", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "initial" }] }));
    const { runtime, registry } = await setup();
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = async (_input, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => (init!.signal as AbortSignal).addEventListener(
        "abort", () => reject(new DOMException("Superseded", "AbortError")), { once: true },
      ));
    };
    const first = runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    await firstStarted;
    globalThis.fetch = async () => new Response("failed", { status: 503 });
    const second = runtime.refresh({ providers: ["gateway"], allowNetwork: true, force: true });
    await Promise.all([first, second]);
    assert.deepEqual(modelIds(registry), ["static", "initial"]);
  });

  it("grants the capability endpoint a fresh timeout", async () => {
    const originalTimeout = AbortSignal.timeout;
    const timeoutSignals: AbortSignal[] = [];
    const requests: AbortSignal[] = [];
    AbortSignal.timeout = ((ms: number) => {
      const signal = originalTimeout(ms);
      timeoutSignals.push(signal);
      return signal;
    }) as typeof AbortSignal.timeout;
    try {
      globalThis.fetch = async (input, init) => {
        requests.push(init!.signal as AbortSignal);
        return new Response(JSON.stringify({ data: String(input).includes("model/info") ? [] : [{ id: "current" }] }));
      };
      await setup({ discoverModelCapabilities: true });
      assert.equal(requests.length, 2);
      assert.equal(timeoutSignals.length, 2);
      assert.notEqual(requests[0], requests[1]);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });

  it("does not intercept Ctrl+P model snapshot cycling", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ data: [{ id: "discovered" }] }));
    };
    const { shortcuts } = await setup();
    assert.deepEqual(shortcuts, []);
    assert.equal(fetchCalls, 1);
  });

  it("preserves the configured provider stream implementation for discovered models", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "discovered" }] }));
    const { registry } = await setup();
    const source = registry.getProvider("gateway")!;
    assert.equal(source.getModels().some((model) => model.id === "discovered"), true);
    assert.equal(typeof source.stream, "function");
    assert.equal(typeof source.streamSimple, "function");
  });

  it("discovers models in non-TUI mode", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "headless" }] }));
    const { registry, appended } = await setup({ mode: "json" });
    assert.deepEqual(modelIds(registry), ["static", "headless"]);
    assert.deepEqual(appended, []);
  });

  it("does not infer capability discovery from provider strings containing litellm", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "plain" }] }));
    };
    await setup({ provider: "contains-litellm", name: "also litellm" });

    assert.deepEqual(requests.map((url) => new URL(url).pathname), ["/v1/models"]);
  });

  it("enriches capabilities only for an explicitly opted-in arbitrary provider", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return String(input).includes("model/info")
        ? new Response(JSON.stringify({ data: [
          { model_name: "reasoning", model_info: { supported_openai_params: ["reasoning_effort"] } },
          { model_name: "static", model_info: { supports_reasoning: true } },
        ] }))
        : new Response(JSON.stringify({ data: [{ id: "reasoning" }, { id: "static" }] }));
    };
    const { registry } = await setup({
      provider: "arbitrary-relay",
      name: "Unrelated vendor",
      discoverModelCapabilities: true,
      headers: { "X-Route": "fake-route" },
      staticModels: [{ id: "static", reasoning: false }],
    });

    assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), ["/v1/models", "/v1/model/info"]);
    assert.equal(requests[0].headers.get("authorization"), "Bearer fake-key");
    assert.equal(requests[1].headers.get("x-route"), "fake-route");
    assert.equal(registry.find("arbitrary-relay", "reasoning")?.reasoning, true);
    assert.equal(registry.find("arbitrary-relay", "static")?.reasoning, false);
  });

  it("keeps current discovered models un-enriched when capability discovery fails", async () => {
    globalThis.fetch = async (input) => String(input).includes("model/info")
      ? new Response("unavailable", { status: 503 })
      : new Response(JSON.stringify({ data: [{ id: "current", reasoning: false }] }));
    const { registry } = await setup({ provider: "arbitrary", discoverModelCapabilities: true });

    assert.deepEqual(modelIds(registry, "arbitrary"), ["static", "current"]);
    assert.equal(registry.find("arbitrary", "current")?.reasoning, false);
  });

  it("renders a durable TUI discovery summary with a valid theme color", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "one" }, { id: "two" }] }));
    const { appended, renderers } = await setup();
    assert.deepEqual(appended, [{ type: "openai-compatible-discovery-summary", data: { summary: "Providers: gateway (2)" } }]);
    const rendered = renderers[0].render(
      { data: appended[0].data },
      {},
      { fg: (color: string, text: string) => {
        assert.equal(color, "muted");
        return text;
      } },
    );
    assert.equal(rendered.render(80).join("\n"), "Providers: gateway (2)");
    assert.doesNotThrow(() => rendered.invalidate());
  });

  it("unregisters only its provider refresh overlays on shutdown", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "discovered" }] }));
    const { handlers, registry } = await setup();
    handlers.get("session_shutdown")?.();
    assert.deepEqual(modelIds(registry), ["static"]);
  });
});

describe("OpenAI-compatible discovery helpers", () => {
  it("formats a provider discovery summary", () => {
    assert.equal(formatOpenAiCompatibleDiscoverySummary("my-openai-relay", 242), "Providers: my-openai-relay (242)");
  });

  it("materializes generic capacity metadata", () => {
    const [model] = materializeOpenAiCompatibleModels([{
      id: "gpt-5.6-terra",
      max_input_tokens: 922_000,
      max_output_tokens: 128_000,
    }], "https://gateway.example/v1", "arbitrary");
    assert.equal(model.contextWindow, 1_050_000);
    assert.equal(model.maxTokens, 128_000);
    assert.deepEqual(model.input, ["text", "image"]);
  });

  it("falls back to the static context window when capability capacity sum overflows", () => {
    const [model] = materializeOpenAiCompatibleModels(
      [{ id: "overflow", max_input_tokens: Number.MAX_VALUE, max_output_tokens: Number.MAX_VALUE }],
      "https://gateway.example/v1",
      "arbitrary",
    );
    assert.equal(model.contextWindow, 128_000);
  });

  it("redacts sensitive diagnostics", () => {
    const diagnostic = redactOpenAiCompatibleDiagnostic(
      "GET https://user:pass@gateway.example/v1/models?key=query-secret failed with Bearer fake-key and fake-route", // pragma: allowlist secret
      { apiKey: "fake-key", headers: { "X-Route": "fake-route" } }, // pragma: allowlist secret
    );
    for (const secret of ["user", "pass", "query-secret", "fake-key", "fake-route"])
      assert.equal(diagnostic.includes(secret), false);
  });

  it("retains opaque IDs while removing exact duplicates", () => {
    assert.deepEqual(materializeOpenAiCompatibleModels(
      [{ id: "x" }, { id: "x" }, { id: " x " }, { id: "" }], "https://gateway.example/v1", "generic",
    ).map((model) => model.id), ["x", " x ", ""]);
  });
});
