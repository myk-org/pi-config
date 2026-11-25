/**
 * Tests for the provider_stream_event diagnostic hook (issue #848).
 * Run with: npx tsx --test tests/node/shared/provider-stream-log.test.ts
 *
 * No network: handlers are invoked directly against a fake ExtensionAPI.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeTempDir } from "../helpers/temp-dirs.js";


const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const MODULE = join(REPO, "extensions/shared/provider-stream-log.ts");

let cleanup: Array<() => void> = [];
let importCounter = 0;

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

interface FakePi {
  handlers: Map<string, Array<(event: unknown) => unknown>>;
  registered: string[];
  api: ExtensionAPI;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Array<(event: unknown) => unknown>>();
  const registered: string[] = [];
  const api = {
    on(event: string, handler: (e: unknown) => unknown) {
      registered.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  return { handlers, registered, api };
}

/** Load the module with provider log level `level` and an isolated HOME/cwd. */
async function loadModule(level: string): Promise<{
  mod: typeof import("../../../extensions/shared/provider-stream-log.js");
  home: string;
}> {
  const home = makeTempDir("pi-provider-stream-home-");
  const project = makeTempDir("pi-provider-stream-project-");
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevParent = process.env.__PI_PARENT_SESSION_ID;
  const prevLevel = process.env.PI_LOG_PROVIDERS;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.__PI_PARENT_SESSION_ID;
  process.env.PI_LOG_PROVIDERS = level;
  cleanup.push(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevParent === undefined) delete process.env.__PI_PARENT_SESSION_ID;
    else process.env.__PI_PARENT_SESSION_ID = prevParent;
    if (prevLevel === undefined) delete process.env.PI_LOG_PROVIDERS;
    else process.env.PI_LOG_PROVIDERS = prevLevel;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  // Project settings win over env — point resolution at a settings-free dir.
  const projectSettings = await import("../../../extensions/orchestrator/project-settings.js");
  projectSettings.setRepoRootResolverForTests(() => project);

  const fileLogger = await import("../../../extensions/shared/file-logger.js");
  // file-logger.js is a single instance across these tests — drop its 30s
  // level cache so each case re-resolves with its own PI_LOG_PROVIDERS value.
  fileLogger.clearLogLevelCache();
  fileLogger.setGlobalSessionId("provider-stream-test");
  cleanup.push(() => {
    delete (globalThis as any).__piConfigSessionId;
    delete process.env.__PI_CONFIG_SESSION_ID;
  });

  importCounter += 1;
  return {
    mod: (await import(`${MODULE}?t=${Date.now()}-${importCounter}`)) as typeof import("../../../extensions/shared/provider-stream-log.js"),
    home,
  };
}

function logFile(home: string): string {
  return join(home, ".pi", "logs", "providers", "provider-stream-test", "main.log");
}

describe("provider-stream-log", () => {
  it("registers only after_provider_response when provider debug logging is off", async () => {
    const { mod } = await loadModule("info");
    const pi = fakePi();

    mod.registerProviderStreamLog(pi.api);

    assert.deepEqual(pi.registered, ["after_provider_response"]);
  });

  it("registers only after_provider_response when provider logging is off entirely", async () => {
    const { mod } = await loadModule("off");
    const pi = fakePi();

    mod.registerProviderStreamLog(pi.api);

    assert.deepEqual(pi.registered, ["after_provider_response"]);
  });

  it("registers all diagnostic hooks when provider debug logging is on", async () => {
    const { mod } = await loadModule("debug");
    const pi = fakePi();

    mod.registerProviderStreamLog(pi.api);

    assert.deepEqual(pi.registered.sort(), ["after_provider_response", "provider_stream_event", "turn_start"]);
    assert.equal(pi.handlers.get("provider_stream_event")!.length, 1);
  });

  it("skips 2xx provider responses when provider debug logging is off", async () => {
    const { mod, home } = await loadModule("info");
    const pi = fakePi();
    mod.registerProviderStreamLog(pi.api);

    const handler = pi.handlers.get("after_provider_response")![0]!;
    handler({
      type: "after_provider_response",
      status: 200,
      headers: { "x-request-id": "ok-should-not-log-at-info" },
    });

    assert.equal(existsSync(logFile(home)), false);
  });

  it("logs 4xx/5xx provider responses at warn with allowlisted truncated headers", async () => {
    const { mod, home } = await loadModule("info");
    const pi = fakePi();
    mod.registerProviderStreamLog(pi.api);

    const handler = pi.handlers.get("after_provider_response")![0]!;
    handler({
      type: "after_provider_response",
      status: 429,
      headers: {
        "Retry-After": "30",
        "X-Request-Id": "req-123",
        "CF-Ray": "r".repeat(300),
        Authorization: "Bearer super-secret", // pragma: allowlist secret — fake fixture
        Cookie: "session=secret-cookie",
        "Set-Cookie": "sid=secret-set-cookie",
        "X-Unknown-Header": "unknown-val",
      },
    });

    const body = readFileSync(logFile(home), "utf-8");
    assert.match(body, /provider_http_error/);
    assert.match(body, /"status":429/);
    assert.match(body, /"retry-after":"30"/);
    assert.match(body, /"x-request-id":"req-123"/);
    assert.match(body, /"cf-ray":"r{200}…\(\+100\)"/);
    assert.doesNotMatch(body, /super-secret|secret-cookie|secret-set-cookie|unknown-val/);
  });

  it("logs 2xx provider responses at debug when debug logging is enabled", async () => {
    const { mod, home } = await loadModule("debug");
    const pi = fakePi();
    mod.registerProviderStreamLog(pi.api);

    const handler = pi.handlers.get("after_provider_response")![0]!;
    handler({
      type: "after_provider_response",
      status: 200,
      headers: { "Request-Id": "req-ok-1", Authorization: "Bearer secret" }, // pragma: allowlist secret — fake fixture
    });

    const body = readFileSync(logFile(home), "utf-8");
    assert.match(body, /provider_http_response/);
    assert.match(body, /"status":200/);
    assert.match(body, /"request-id":"req-ok-1"/);
    assert.doesNotMatch(body, /secret/);
  });

  it("logs provider, api, model and redacted, truncated data", async () => {
    const { mod, home } = await loadModule("debug");
    const pi = fakePi();
    mod.registerProviderStreamLog(pi.api);

    pi.handlers.get("provider_stream_event")![0]!({
      type: "provider_stream_event",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "test-model",
      data: {
        authorization: "Bearer placeholder-value", // pragma: allowlist secret — fake fixture
        choices: [{ delta: { content: "x".repeat(5000) } }],
        api_key: "fixture-key-value", // pragma: allowlist secret — fake fixture
      },
    });

    const body = readFileSync(logFile(home), "utf-8");
    assert.match(body, /anthropic\/anthropic-messages\/test-model/);
    assert.match(body, /authorization:…redacted/);
    assert.match(body, /api_key:…redacted/);
    assert.doesNotMatch(body, /placeholder-value|fixture-key-value/);
    // Large payloads are truncated so one chunk cannot flood the log.
    assert.doesNotMatch(body, /x{201}/);
    assert.match(body, /\(\+4800\)/); // truncated marker: …(+4800)
  });

  it("bounds cyclic payloads by depth and logs uncloneable data directly (#1188)", async () => {
    const { mod, home } = await loadModule("debug");
    const pi = fakePi();
    mod.registerProviderStreamLog(pi.api);

    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const handler = pi.handlers.get("provider_stream_event")![0]!;
    handler({ type: "provider_stream_event", provider: "p", api: "a", model: "m", data: cyclic });
    handler({ type: "provider_stream_event", provider: "p", api: "a", model: "m", data: { fn: () => "boom" } });

    const body = readFileSync(logFile(home), "utf-8");
    assert.match(body, /name:loop/);
    assert.match(body, /fn:\[function\]/);
    assert.doesNotMatch(body, /not cloneable/);
    assert.ok(body.split("\n").length <= 10);
  });

  it("previewStreamData stops after MAX_ITEMS own keys without invoking trailing getters (#1188)", async () => {
    const { mod } = await loadModule("debug");
    let trailingGetterCalled = false;
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      payload[`k${i}`] = i;
    }
    Object.defineProperty(payload, "k99", {
      enumerable: true,
      get() {
        trailingGetterCalled = true;
        return "should-not-read";
      },
    });
    const out = mod.previewStreamData(payload);
    assert.equal(trailingGetterCalled, false);
    assert.match(out, /^\{k0:0,.*,k7:7,…\}$/);
  });

  it("does not invoke structuredClone on stream chunks (#1188)", async (t) => {
    const { mod, home } = await loadModule("debug");
    const pi = fakePi();
    mod.registerProviderStreamLog(pi.api);

    let cloneCalls = 0;
    t.mock.method(globalThis, "structuredClone", (val: unknown) => {
      cloneCalls += 1;
      return val;
    });

    pi.handlers.get("provider_stream_event")![0]!({
      type: "provider_stream_event",
      provider: "p",
      api: "a",
      model: "m",
      data: { ok: true },
    });

    assert.equal(cloneCalls, 0);
    assert.match(readFileSync(logFile(home), "utf-8"), /ok:true/);
  });

  it("has no executable console.* calls", () => {
    const src = readFileSync(MODULE, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/\bconsole\.(debug|log|info|warn|error)\s*\(/.test(src), false);
  });

  it("is registered from the orchestrator entrypoint", () => {
    const src = readFileSync(join(REPO, "extensions/orchestrator/index.ts"), "utf-8");
    assert.match(src, /registerProviderStreamLog/);
    assert.ok(existsSync(MODULE));
  });
});
