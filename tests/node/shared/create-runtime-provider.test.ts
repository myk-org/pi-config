/**
 * Unit tests for shared createProvider helpers (auth / filter / model builder).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AMBIENT_AUTH_KEY,
  CONFIGURED_CREDENTIAL_KEY,
  DEFAULT_RUNTIME_BASE_URL,
  buildAmbientLoginAuth,
  buildRuntimeModel,
  createRuntimeProvider,
  filterModelsWhenConfigured,
} from "../../../extensions/shared/create-runtime-provider.js";

describe("buildRuntimeModel", () => {
  it("fills api, provider, baseUrl and defaults", () => {
    const m = buildRuntimeModel({
      id: "cursor:composer-2.5",
      name: "Composer 2.5 (cursor)",
      api: "cli",
      provider: "cli-cursor",
    });
    assert.equal(m.id, "cursor:composer-2.5");
    assert.equal(m.api, "cli");
    assert.equal(m.provider, "cli-cursor");
    assert.equal(m.baseUrl, DEFAULT_RUNTIME_BASE_URL);
    assert.equal(m.reasoning, false);
    assert.deepEqual(m.input, ["text", "image"]);
    assert.equal(m.contextWindow, 200_000);
    assert.equal(m.maxTokens, 32_768);
  });

  it("allows baseUrl override", () => {
    const m = buildRuntimeModel({
      id: "x:default",
      name: "x",
      api: "acpx",
      provider: "acpx-x",
      baseUrl: "acpx://local",
    });
    assert.equal(m.baseUrl, "acpx://local");
  });
});

describe("buildAmbientLoginAuth", () => {
  it("login stores configured marker when isConfigured", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "CLI cursor",
      isConfigured: () => true,
      sourceLabel: "cursor CLI on PATH",
    });
    const cred = await auth.login!({
      prompt: async () => "confirm",
      notify: () => {},
    });
    assert.equal(cred.type, "api_key");
    assert.equal(cred.key, CONFIGURED_CREDENTIAL_KEY);
  });

  it("login throws when not configured", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "CLI cursor",
      isConfigured: () => false,
      sourceLabel: "cursor CLI on PATH",
    });
    await assert.rejects(
      () =>
        auth.login!({
          prompt: async () => "confirm",
          notify: () => {},
        }),
      /not available/,
    );
  });

  it("login cancel throws", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "CLI cursor",
      isConfigured: () => true,
      sourceLabel: "cursor CLI on PATH",
    });
    await assert.rejects(
      () =>
        auth.login!({
          prompt: async () => {
            throw new Error("Login cancelled");
          },
          notify: () => {},
        }),
      /Login cancelled/,
    );
  });

  it("resolve with credential and isConfigured true → success", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "CLI cursor",
      isConfigured: () => true,
      sourceLabel: "cursor CLI on PATH",
    });
    const result = await auth.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      credential: { type: "api_key", key: CONFIGURED_CREDENTIAL_KEY },
    });
    assert.ok(result);
    assert.equal(result!.auth.apiKey, CONFIGURED_CREDENTIAL_KEY);
    assert.equal(result!.source, "cursor CLI on PATH");
  });

  it("resolve with credential but isConfigured false → undefined", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "CLI cursor",
      isConfigured: () => false,
      sourceLabel: "cursor CLI on PATH",
    });
    const result = await auth.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      credential: { type: "api_key", key: CONFIGURED_CREDENTIAL_KEY },
    });
    assert.equal(result, undefined);
  });

  it("resolve falls back to ambient when configured without credential", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "CLI cursor",
      isConfigured: () => true,
      sourceLabel: "cursor CLI on PATH",
    });
    const result = await auth.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
    });
    assert.ok(result);
    assert.equal(result!.auth.apiKey, AMBIENT_AUTH_KEY);
  });

  it("resolve ignores arbitrary credential.key (returns ambient marker)", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "CLI cursor",
      isConfigured: () => true,
      sourceLabel: "cursor CLI on PATH",
    });
    const result = await auth.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      credential: { type: "api_key", key: "evil-injected-secret" },
    });
    assert.ok(result);
    assert.equal(result!.auth.apiKey, AMBIENT_AUTH_KEY);
  });

  it("resolve returns undefined when unconfigured and no credential", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "CLI cursor",
      isConfigured: () => false,
      sourceLabel: "cursor CLI on PATH",
    });
    const result = await auth.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
    });
    assert.equal(result, undefined);
  });

  it("check returns api_key when configured", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "ACPX cursor",
      isConfigured: () => true,
      sourceLabel: "cursor acpx runtime",
    });
    const check = await auth.check!({
      ctx: { env: async () => undefined, fileExists: async () => false },
    });
    assert.deepEqual(check, {
      type: "api_key",
      source: "cursor acpx runtime",
    });
  });

  it("check returns undefined when not configured", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "ACPX cursor",
      isConfigured: () => false,
      sourceLabel: "cursor acpx runtime",
    });
    const check = await auth.check!({
      ctx: { env: async () => undefined, fileExists: async () => false },
    });
    assert.equal(check, undefined);
  });

  it("check returns undefined when credential present but isConfigured false", async () => {
    const auth = buildAmbientLoginAuth({
      displayName: "CLI cursor",
      isConfigured: () => false,
      sourceLabel: "cursor CLI on PATH",
    });
    const check = await auth.check!({
      ctx: { env: async () => undefined, fileExists: async () => false },
      credential: { type: "api_key", key: CONFIGURED_CREDENTIAL_KEY },
    });
    assert.equal(check, undefined);
  });
});

describe("filterModelsWhenConfigured", () => {
  const models = [
    buildRuntimeModel({
      id: "a:m1",
      name: "m1",
      api: "cli",
      provider: "cli-a",
    }),
  ];

  it("hides models when not configured", () => {
    const out = filterModelsWhenConfigured(models, undefined, () => false);
    assert.deepEqual(out, []);
  });

  it("keeps models when configured without credential", () => {
    const out = filterModelsWhenConfigured(models, undefined, () => true);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "a:m1");
  });

  it("keeps models when configured with credential", () => {
    const out = filterModelsWhenConfigured(
      models,
      { type: "api_key", key: CONFIGURED_CREDENTIAL_KEY },
      () => true,
    );
    assert.equal(out.length, 1);
  });
});

describe("createRuntimeProvider", () => {
  it("builds a Provider with id and getModels when pi-ai is resolvable", async (t) => {
    let provider;
    try {
      provider = await createRuntimeProvider({
        id: "cli-test",
        name: "CLI test",
        auth: {
          apiKey: buildAmbientLoginAuth({
            displayName: "CLI test",
            isConfigured: () => true,
            sourceLabel: "test",
          }),
        },
        models: [
          buildRuntimeModel({
            id: "test:default",
            name: "test (default)",
            api: "cli",
            provider: "cli-test",
          }),
        ],
        api: {
          stream: () => {
            throw new Error("stream not used in test");
          },
          streamSimple: () => {
            throw new Error("streamSimple not used in test");
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Cannot find package") ||
        msg.includes("Cannot find module") ||
        msg.includes("ERR_MODULE_NOT_FOUND")
      ) {
        t.skip(
          `@earendil-works/pi-ai not resolvable — cannot exercise createProvider (${msg})`,
        );
        return;
      }
      throw err;
    }
    assert.equal(provider.id, "cli-test");
    assert.equal(provider.getModels().length, 1);
    assert.equal(provider.getModels()[0].id, "test:default");
    assert.ok(provider.auth.apiKey);
  });
});
