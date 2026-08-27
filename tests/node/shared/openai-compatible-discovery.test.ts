import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installOpenAiCompatibleDiscovery from "../../../extensions/openai-compatible-discovery/index.js";
import {
  findEligibleOpenAiCompatibleProviderConfigs,
  findEligibleOpenAiCompatibleProviderConfigsResult,
  formatOpenAiCompatibleDiscoverySummary,
  materializeOpenAiCompatibleModels,
} from "../../../extensions/shared/openai-compatible-discovery.js";

function staticModel(id: string, provider = "litellm") {
  return { id, name: id, api: "openai-completions", provider, baseUrl: "https://gateway.example/v1" };
}

function sourceProvider(id: string, stream = () => "streamed") {
  return {
    id,
    name: id,
    baseUrl: "https://gateway.example/v1",
    auth: { apiKey: { name: id, resolve: async () => ({ auth: {} }), check: async () => ({ type: "api_key" as const, source: id }) } },
    stream,
    streamSimple: () => "simple-streamed",
  };
}

describe("OpenAI-compatible provider discovery", () => {
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

  it("finds only exact opted-in OpenAI-compatible provider objects", () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      gateway: { api: "openai-completions", discoverModels: true },
      disabled: { api: "openai-completions" },
      wrongApi: { api: "openai-responses", discoverModels: true },
    } }));
    assert.deepEqual(findEligibleOpenAiCompatibleProviderConfigsResult().providers, [{ id: "gateway", headers: undefined }]);
  });

  it("maps eligible provider configuration objects through the public wrapper", () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      gateway: {
        api: "openai-completions",
        discoverModels: true,
        headers: { "X-Gateway": "relay" },
      },
      disabled: { api: "openai-completions" },
    } }));

    assert.deepEqual(findEligibleOpenAiCompatibleProviderConfigs(), [{
      id: "gateway",
      headers: { "X-Gateway": "relay" },
    }]);
  });

  it("augments the configured provider so the ordinary picker renders its exact source key", async () => {
    const modelsJson = JSON.stringify({ providers: { litellm: { api: "openai-completions", discoverModels: true } } });
    writeFileSync(join(agentDir, "models.json"), modelsJson);
    const registered: any[] = [];
    let sessionStart: any;
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [
      { id: "chatgpt-image-latest" }, { id: "  opaque  " }, { id: "chatgpt-image-latest" }, { id: "" },
    ] }));
    installOpenAiCompatibleDiscovery({
      on: (event: string, handler: any) => { if (event === "session_start") sessionStart = handler; },
      registerProvider: (item: any) => registered.push(item),
    } as any);
    await sessionStart({}, { mode: "tui", hasUI: true, modelRegistry: {
      getProvider: () => sourceProvider("litellm"),
      getProviderAuth: async () => ({ auth: {} }),
      getAll: () => [staticModel("static-model")],
    } });

    assert.equal(readFileSync(join(agentDir, "models.json"), "utf8"), modelsJson);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].id, "litellm");
    assert.deepEqual(registered[0].getModels().map((model: any) => [model.provider, model.id]), [
      ["litellm", "static-model"], ["litellm", "chatgpt-image-latest"], ["litellm", "  opaque  "], ["litellm", ""],
    ]);
  });

  it("materializes an opaque discovered model with Pi's complete contract", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { genericKey: { api: "openai-completions", discoverModels: true } } }));
    let sessionStart: any;
    const source = sourceProvider("genericKey");
    const registered: any[] = [];
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "opaque-discovered-model" }] }));
    installOpenAiCompatibleDiscovery({
      on: (event: string, handler: any) => { if (event === "session_start") sessionStart = handler; },
      registerProvider: (item: any) => registered.push(item),
    } as any);
    await sessionStart({}, { mode: "tui", hasUI: true, modelRegistry: {
      getProvider: () => source, getProviderAuth: async () => ({ auth: {} }), getAll: () => [],
    } });

    const model = registered[0].getModels().find((item: any) => item.id === "opaque-discovered-model");
    assert.deepEqual(model, {
      id: "opaque-discovered-model",
      name: "opaque-discovered-model",
      api: "openai-completions",
      provider: "genericKey",
      baseUrl: "https://gateway.example/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
    assert.equal(model.input.includes("image"), true);
  });

  it("routes a selected discovered model through the original configured provider", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { genericKey: { api: "openai-completions", discoverModels: true } } }));
    let sessionStart: any;
    const calls: unknown[][] = [];
    const source = sourceProvider("genericKey", (...args: unknown[]) => { calls.push(args); return "source-result"; });
    const registered: any[] = [];
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "returned-id" }] }));
    installOpenAiCompatibleDiscovery({
      on: (event: string, handler: any) => { if (event === "session_start") sessionStart = handler; },
      registerProvider: (item: any) => registered.push(item),
    } as any);
    await sessionStart({}, { mode: "tui", hasUI: true, modelRegistry: {
      getProvider: () => source, getProviderAuth: async () => ({ auth: {} }), getAll: () => [],
    } });
    assert.equal(registered[0].stream("returned-id", "context"), "source-result");
    assert.deepEqual(calls, [["returned-id", "context", undefined]]);
  });

  it("renders the durable discovery summary with a valid Pi theme color", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { relay: { api: "openai-completions", discoverModels: true } } }));
    let sessionStart: any;
    const appended: Array<{ type: string; data: any }> = [];
    const renderers: Array<{ type: string; render: any }> = [];
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "one" }, { id: "two" }] }));
    installOpenAiCompatibleDiscovery({
      on: (event: string, handler: any) => { if (event === "session_start") sessionStart = handler; },
      registerProvider: () => {},
      appendEntry: (type: string, data: any) => appended.push({ type, data }),
      registerEntryRenderer: (type: string, render: any) => renderers.push({ type, render }),
    } as any);
    await sessionStart({}, { mode: "tui", hasUI: true, modelRegistry: {
      getProvider: () => sourceProvider("relay"), getProviderAuth: async () => ({ auth: {} }), getAll: () => [],
    } });

    assert.deepEqual(appended, [{ type: "openai-compatible-discovery-summary", data: { summary: "Providers: relay (2)" } }]);
    assert.equal(renderers.length, 1);
    assert.equal(renderers[0].type, "openai-compatible-discovery-summary");
    const piThemeColors = new Set([
      "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
      "thinkingText", "searchMatchText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
      "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr",
      "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction",
      "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff",
      "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "bashMode",
    ]);
    let rendered: any;
    assert.doesNotThrow(() => {
      rendered = renderers[0].render(
        { data: appended[0].data },
        {},
        { fg: (color: string, text: string) => {
          if (!piThemeColors.has(color)) throw new Error(`Unknown theme color: ${color}`);
          return text;
        } },
      );
    });
    assert.equal(rendered.render(80).join("\n").trimEnd(), "Providers: relay (2)");
  });

  it("invalidates the durable discovery summary renderer", () => {
    const renderers: Array<{ type: string; render: any }> = [];
    installOpenAiCompatibleDiscovery({
      on: () => {},
      registerEntryRenderer: (type: string, render: any) => renderers.push({ type, render }),
    } as any);

    const rendered = renderers[0].render(
      { data: { summary: "Providers: relay (2)" } },
      {},
      { fg: (_color: string, text: string) => text },
    );
    assert.doesNotThrow(() => rendered.invalidate());
  });

  it("does not append a prior session's summary when new-session discovery fails", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { relay: { api: "openai-completions", discoverModels: true } } }));
    let sessionStart: any;
    const appended: Array<{ type: string; data: any }> = [];
    let succeeds = true;
    globalThis.fetch = async () => succeeds
      ? new Response(JSON.stringify({ data: [{ id: "one" }, { id: "two" }] }))
      : new Response("nope", { status: 502 });
    installOpenAiCompatibleDiscovery({
      on: (event: string, handler: any) => { if (event === "session_start") sessionStart = handler; },
      registerProvider: () => {}, unregisterProvider: () => {},
      appendEntry: (type: string, data: any) => appended.push({ type, data }),
      registerEntryRenderer: () => {},
    } as any);
    const ctx = { mode: "tui", hasUI: true, modelRegistry: {
      getProvider: () => sourceProvider("relay"), getProviderAuth: async () => ({ auth: {} }), getAll: () => [],
    } };
    await sessionStart({}, ctx);
    succeeds = false;
    await sessionStart({}, ctx);

    assert.deepEqual(appended, [{ type: "openai-compatible-discovery-summary", data: { summary: "Providers: relay (2)" } }]);
  });

  it("does not register after discovery errors", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { gateway: { api: "openai-completions", discoverModels: true } } }));
    let sessionStart: any;
    let registrations = 0;
    globalThis.fetch = async () => new Response("nope", { status: 502 });
    installOpenAiCompatibleDiscovery({
      on: (event: string, handler: any) => { if (event === "session_start") sessionStart = handler; },
      registerProvider: () => registrations++,
    } as any);
    await sessionStart({}, { mode: "tui", hasUI: true, modelRegistry: {
      getProvider: () => sourceProvider("gateway"), getProviderAuth: async () => ({ auth: {} }), getAll: () => [],
    } });
    assert.equal(registrations, 0);
  });

  it("does not fetch outside the interactive TUI lifecycle", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { gateway: { api: "openai-completions", discoverModels: true } } }));
    let sessionStart: any;
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error("must not fetch"); };
    installOpenAiCompatibleDiscovery({ on: (event: string, handler: any) => { if (event === "session_start") sessionStart = handler; } } as any);
    await sessionStart({}, { mode: "json", hasUI: false, modelRegistry: {} });
    assert.equal(fetchCalls, 0);
  });

  it("restores the unchanged static provider on session shutdown", async () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { gateway: { api: "openai-completions", discoverModels: true } } }));
    let sessionStart: any;
    let shutdown: any;
    const unregistered: string[] = [];
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "returned-id" }] }));
    installOpenAiCompatibleDiscovery({
      on: (event: string, handler: any) => { if (event === "session_start") sessionStart = handler; if (event === "session_shutdown") shutdown = handler; },
      registerProvider: () => {}, unregisterProvider: (id: string) => unregistered.push(id),
    } as any);
    await sessionStart({}, { mode: "tui", hasUI: true, modelRegistry: {
      getProvider: () => sourceProvider("gateway"), getProviderAuth: async () => ({ auth: {} }), getAll: () => [staticModel("static", "gateway")],
    } });
    shutdown();
    assert.deepEqual(unregistered, ["gateway"]);
  });
});

describe("OpenAI-compatible discovery helpers", () => {
  it("formats the configured provider key and discovered count without provider-specific naming", () => {
    assert.equal(formatOpenAiCompatibleDiscoverySummary("my-openai-relay", 242), "Providers: my-openai-relay (242)");
  });

  it("retains only exact duplicate returned IDs", () => {
    assert.deepEqual(materializeOpenAiCompatibleModels(
      [{ id: "x" }, { id: "x" }, { id: " x " }, { id: "" }], "https://gateway.example/v1", "generic",
    ).map((model) => model.id), ["x", " x ", ""]);
  });
});
