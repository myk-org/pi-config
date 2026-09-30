/**
 * Tests for the provider_stream_event diagnostic hook (issue #848).
 * Run with: npx tsx --test tests/node/shared/provider-stream-log.test.ts
 *
 * No network: handlers are invoked directly against a fake ExtensionAPI.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  const home = mkdtempSync(join(tmpdir(), "pi-provider-stream-home-"));
  const project = mkdtempSync(join(tmpdir(), "pi-provider-stream-project-"));
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
  const settingsSource = await import("../../../extensions/orchestrator/settings-source.js");
  settingsSource.setRepoRootResolverForTests(() => project);

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
  it("does not register when provider debug logging is off", async () => {
    const { mod } = await loadModule("info");
    const pi = fakePi();

    mod.registerProviderStreamLog(pi.api);

    assert.deepEqual(pi.registered, []);
  });

  it("does not register when provider logging is off entirely", async () => {
    const { mod } = await loadModule("off");
    const pi = fakePi();

    mod.registerProviderStreamLog(pi.api);

    assert.deepEqual(pi.registered, []);
  });

  it("registers the stream hook once when provider debug logging is on", async () => {
    const { mod } = await loadModule("debug");
    const pi = fakePi();

    mod.registerProviderStreamLog(pi.api);

    assert.deepEqual(pi.registered.sort(), ["provider_stream_event", "turn_start"]);
    assert.equal(pi.handlers.get("provider_stream_event")!.length, 1);
  });

  it("logs provider, api, model and redacted, truncated data", async () => {
    const { mod, home } = await loadModule("debug");
    const pi = fakePi();
    mod.registerProviderStreamLog(pi.api);

    pi.handlers.get("provider_stream_event")![0]!({
      type: "provider_stream_event",
      provider: "acpx-provider",
      api: "anthropic-messages",
      model: "test-model",
      data: {
        authorization: "Bearer placeholder-value", // pragma: allowlist secret — fake fixture
        choices: [{ delta: { content: "x".repeat(5000) } }],
        api_key: "fixture-key-value", // pragma: allowlist secret — fake fixture
      },
    });

    const body = readFileSync(logFile(home), "utf-8");
    assert.match(body, /acpx-provider\/anthropic-messages\/test-model/);
    assert.match(body, /authorization:…redacted/);
    assert.match(body, /api_key:…redacted/);
    assert.doesNotMatch(body, /placeholder-value|fixture-key-value/);
    // Large payloads are truncated so one chunk cannot flood the log.
    assert.doesNotMatch(body, /x{201}/);
    assert.match(body, /\(\+4800\)/); // truncated marker: …(+4800)
  });

  it("bounds cyclic payloads by depth and survives uncloneable data", async () => {
    const { mod, home } = await loadModule("debug");
    const pi = fakePi();
    mod.registerProviderStreamLog(pi.api);

    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const handler = pi.handlers.get("provider_stream_event")![0]!;
    // structuredClone preserves cycles but they must not recurse forever.
    handler({ type: "provider_stream_event", provider: "p", api: "a", model: "m", data: cyclic });
    // A function is not structured-cloneable — handler must log, not throw.
    handler({ type: "provider_stream_event", provider: "p", api: "a", model: "m", data: { fn: () => "boom" } });

    const body = readFileSync(logFile(home), "utf-8");
    assert.match(body, /stream event data not cloneable, logged un-cloned/);
    assert.match(body, /\[function\]/);
    assert.ok(body.split("\n").length <= 10);
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
