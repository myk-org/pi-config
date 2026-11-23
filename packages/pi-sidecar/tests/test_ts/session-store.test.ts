import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  PiProviderRuntime,
  SessionStore,
  hasKnownPricing,
  type DiscoveredModel,
  type InternalRuntimeHandle,
} from "../../src/sessions.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { logger } from "../../src/logger.js";
import {
  InMemoryProviderRuntime,
  createNoopStoredSession,
  type InMemoryProviderRuntimeOptions,
} from "./helpers/in-memory-runtime.js";
import { makeTempDir } from "./helpers/temp-dirs.js";

/**
 * Unit tests for SessionStore lifecycle (refresh / catalog / status / concurrency).
 *
 * Driven through the injected in-memory ProviderRuntime adapter — never creates
 * a real AgentSessionRuntime (except the explicit PiProviderRuntime shutdown test).
 */

function createTestStore(options: InMemoryProviderRuntimeOptions = {}): {
  store: SessionStore;
  runtime: InMemoryProviderRuntime;
} {
  const runtime = new InMemoryProviderRuntime(options);
  const store = new SessionStore({ runtime });
  return { store, runtime };
}

describe("SessionStore (in-memory runtime adapter)", () => {
  it("is not ready before any discovery has run", () => {
    const { store } = createTestStore();
    assert.equal(store.ready, false);
    assert.equal(store.discoveryError, null);
    assert.equal(store.count(), 0);
  });

  it("refreshModels() marks ready and returns the mocked available catalog", async () => {
    const { store, runtime } = createTestStore();

    const models = await store.refreshModels();
    assert.equal(store.ready, true);
    assert.equal(store.discoveryError, null);
    assert.equal(models.length, runtime.available.length);
    assert.ok(models.every((m: DiscoveredModel) => m.provider === "google"));
    assert.equal(runtime.refreshCalls, 1);
  });

  it("refreshModels() returns an empty available catalog without treating it as failure", async () => {
    const { store } = createTestStore({
      available: [],
      providerModels: { google: [{ id: "gemini-2.5-flash", name: "Flash", provider: "google" }] },
    });

    const models = await store.refreshModels();
    assert.equal(models.length, 0);
    assert.equal(store.ready, true);
    assert.equal(store.discoveryError, null);

    const google = await store.getProviderStatus("google");
    assert.equal(google.registered, true);
    assert.equal(google.modelCount, 1);
  });

  it("refreshModels() hits runtime refresh on repeated calls", async () => {
    const { store, runtime } = createTestStore();

    const first = await store.refreshModels();
    const second = await store.refreshModels();
    assert.equal(second.length, first.length);
    assert.equal(runtime.refreshCalls, 2);
    assert.equal(store.discoveryError, null);
  });

  it("getModels() matches the most recent refreshModels() snapshot", async () => {
    const { store } = createTestStore();

    const refreshed = await store.refreshModels();
    const listed = await store.getModels();
    assert.deepEqual(
      listed.map((m: DiscoveredModel) => m.id).sort(),
      refreshed.map((m: DiscoveredModel) => m.id).sort(),
    );
  });

  it("getModels() triggers discovery when store is not yet ready", async () => {
    const { store } = createTestStore();

    assert.equal(store.ready, false);
    const listed = await store.getModels();
    assert.equal(store.ready, true);
    assert.ok(listed.length >= 1);
  });

  it("concurrent getModels() before ready share one refreshModels pass", async () => {
    const { store, runtime } = createTestStore();

    const [a, b] = await Promise.all([store.getModels(), store.getModels()]);
    assert.deepEqual(
      a.map((m: DiscoveredModel) => m.id).sort(),
      b.map((m: DiscoveredModel) => m.id).sort(),
    );
    assert.equal(runtime.refreshCalls, 1);
  });

  it("getProviderStatus() reports a registered builtin provider with a positive model count", async () => {
    const { store } = createTestStore();
    await store.refreshModels();
    const status = await store.getProviderStatus("google");
    assert.equal(status.provider, "google");
    assert.equal(status.registered, true);
    assert.ok(status.modelCount > 0);
    assert.ok(status.authStatus && typeof status.authStatus.configured === "boolean");
  });

  it("getProviderStatus() reports registered=false and modelCount=0 for an unknown provider", async () => {
    const { store } = createTestStore();
    const status = await store.getProviderStatus("totally-unknown-provider-xyz");
    assert.equal(status.registered, false);
    assert.equal(status.modelCount, 0);
    assert.equal(status.supportsSessionApiKey, false);
  });

  it("create() rejects an unknown builtin model", async () => {
    const { store } = createTestStore();
    await store.refreshModels();
    await assert.rejects(
      () => store.create({ provider: "google", model: "not-a-real-model-xyz", systemPrompt: "test", cwd: "/tmp" }),
      /not found for provider 'google'/,
    );
  });

  describe("concurrent sessions interleaved with refresh", () => {
    it("keeps the model catalog stable while in-memory sessions are created/deleted concurrently with refreshModels()", async () => {
      const { store, runtime } = createTestStore();

      const baseline = await store.refreshModels();
      const baselineIds = baseline.map((m: DiscoveredModel) => `${m.provider}/${m.id}`).sort();

      const sessionIds = await Promise.all(
        Array.from({ length: 5 }, () =>
          store.create({
            provider: "google",
            model: "gemini-2.5-flash",
            systemPrompt: "test",
            cwd: "/tmp",
          }),
        ),
      );
      assert.equal(store.count(), 5);

      const concurrentRefreshes = Array.from({ length: 3 }, () => store.refreshModels());
      const refreshResults = await Promise.all(concurrentRefreshes);

      for (const refreshed of refreshResults) {
        assert.deepEqual(
          refreshed.map((m: DiscoveredModel) => `${m.provider}/${m.id}`).sort(),
          baselineIds,
          "every concurrent refreshModels() call must return the same stable catalog",
        );
      }
      assert.ok(runtime.refreshCalls >= 2); // 1 baseline + ≥1 coalesced concurrent batch (inFlight join)

      const [idsToDelete, idsToKeep] = [sessionIds.slice(0, 3), sessionIds.slice(3)];
      const [deleteResults, finalRefresh] = await Promise.all([
        Promise.all(idsToDelete.map((id) => store.delete(id))),
        store.refreshModels(),
      ]);

      assert.deepEqual(deleteResults, [true, true, true]);
      assert.equal(store.count(), idsToKeep.length);
      assert.deepEqual(
        finalRefresh.map((m: DiscoveredModel) => `${m.provider}/${m.id}`).sort(),
        baselineIds,
      );

      const finalCatalog = await store.getModels();
      assert.deepEqual(
        finalCatalog.map((m: DiscoveredModel) => `${m.provider}/${m.id}`).sort(),
        baselineIds,
      );

      for (const id of idsToKeep) {
        assert.equal(store.delete(id), true);
      }
      assert.equal(store.count(), 0);
    });
  });

  it("getProviderStatus() returns controlled 503 when discovery left no runtime", async () => {
    const runtime = new PiProviderRuntime({
      createInternalRuntime: async () => {
        throw new Error("synthetic init failure");
      },
    });
    const store = new SessionStore({ runtime });
    await assert.rejects(() => store.refreshModels(), /synthetic init failure/);
    assert.equal(store.ready, true);
    assert.equal(store.discoveryError, "synthetic init failure");
    await assert.rejects(
      () => store.getProviderStatus("google"),
      (err: any) => err?.statusCode === 503 && /runtime unavailable/.test(String(err?.message)),
    );
  });

  it("create() rejects HEADLESS_EXCLUDED_PROVIDERS (e.g. github-copilot)", async () => {
    const { store } = createTestStore();
    await assert.rejects(
      () =>
        store.create({
          provider: "github-copilot",
          model: "gpt-4.1",
          systemPrompt: "test",
          cwd: "/tmp",
        }),
      /requires interactive browser OAuth/,
    );
  });

  it("disposeAll() disposes a runtime created while shutdown awaits runtimeInit", async () => {
    let runtimeDisposed = false;
    let releaseInit!: (handle: InternalRuntimeHandle) => void;
    const initGate = new Promise<InternalRuntimeHandle>((resolve) => {
      releaseInit = resolve;
    });

    const piRuntime = new PiProviderRuntime({
      createInternalRuntime: () => initGate,
    });
    const store = new SessionStore({ runtime: piRuntime });

    const pendingProviders = store.getProviders();
    const disposePromise = store.disposeAll();
    assert.equal(store.disposed, true);

    const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    releaseInit({
      services: { modelRuntime },
      diagnostics: [],
      takeUnreportedDiagnostics: () => [],
      dispose: async () => {
        runtimeDisposed = true;
      },
    });

    await disposePromise;
    await assert.rejects(pendingProviders, (err: any) => err?.statusCode === 503);
    assert.equal(runtimeDisposed, true, "runtime created during awaited init must be disposed");
  });

  it("disposeAll() still drains transcript writes when runtime disposal rejects", async () => {
    const dir = makeTempDir("sidecar-dispose-drain-");
    const savedDir = process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
    const savedRec = process.env.RECORD_TRANSCRIPTS;
    const origError = logger.error;
    const errorLogs: string[] = [];
    logger.error = (...args: unknown[]) => {
      errorLogs.push(args.map(String).join(" "));
    };
    process.env.PI_SIDECAR_TRANSCRIPTS_DIR = dir;
    process.env.RECORD_TRANSCRIPTS = "1";
    try {
      let emit: (event: unknown) => void = () => {};
      const { store } = createTestStore({
        ready: true,
        allowAnyModel: true,
        sessionFactory: () => ({
          subscribe: (cb: (event: unknown) => void) => {
            emit = cb;
            return () => {};
          },
          prompt: async () => {
            emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
            emit({
              type: "agent_end",
              messages: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 2, output: 1 }, stopReason: "end_turn" },
              ],
            });
          },
          dispose: () => {},
          abort: async () => {},
        }),
        onDispose: async () => {
          throw new Error("synthetic runtime dispose failure");
        },
      });
      const id = await store.create({
        provider: "test",
        model: "test",
        systemPrompt: "dispose drain test",
        cwd: "/tmp",
      });
      await store.prompt(id, "hi");
      await store.disposeAll();
      assert.ok(existsSync(join(dir, `${id}.jsonl`)), "transcript write must drain even when runtime.dispose() rejects");
      assert.ok(
        errorLogs.some((line) => line.includes("RUNTIME_DISPOSE_FAILED")),
        "runtime dispose failure must be logged",
      );
    } finally {
      logger.error = origError;
      if (savedDir === undefined) delete process.env.PI_SIDECAR_TRANSCRIPTS_DIR;
      else process.env.PI_SIDECAR_TRANSCRIPTS_DIR = savedDir;
      if (savedRec === undefined) delete process.env.RECORD_TRANSCRIPTS;
      else process.env.RECORD_TRANSCRIPTS = savedRec;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("abort() reaches the SDK only while a turn is in flight (#1019)", async () => {
    let aborted = false;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const { store } = createTestStore({
      ready: true,
      allowAnyModel: true,
      sessionFactory: () =>
        createNoopStoredSession({
          prompt: async () => {
            await turn;
          },
          abort: async () => {
            aborted = true;
            release();
          },
        }),
    });
    const id = await store.create({
      provider: "test",
      model: "test",
      systemPrompt: "abort test",
      cwd: "/tmp/job-sidecar-768",
    });
    // An idle session has no turn to cancel — aborting must not flag the next one.
    await store.abort(id);
    assert.equal(aborted, false);

    const pending = store.prompt(id, "hi");
    await store.abort(id);
    await pending;
    assert.equal(aborted, true);
  });

  /**
   * Drives prompt() over an in-memory session that reports `reportedTotal` as the
   * turn cost, so cost and token assertions can live in separate tests.
   */
  const promptWithReportedCost = async (pricingKnown: boolean, reportedTotal: number | null, totalFromProvider?: boolean) => {
    let emit: (event: unknown) => void = () => {};
    const { store } = createTestStore({
      ready: true,
      allowAnyModel: true,
      sessionFactory: () => ({
        session: {
          subscribe: (cb: (event: unknown) => void) => {
            emit = cb;
            return () => {};
          },
          prompt: async () => {
            emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
            emit({
              type: "agent_end",
              messages: [{
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, cost: reportedTotal == null ? undefined : { total: reportedTotal, totalFromProvider } },
              }],
            });
          },
          dispose: () => {},
          abort: async () => {},
        },
        pricingKnown,
      }),
    });
    const id = await store.create({
      provider: "test",
      model: "test",
      systemPrompt: "pricing test",
      cwd: "/tmp/job-pricing",
    });
    return await store.prompt(id, "hi") as {
      usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_usd: number | null; cost_partial: boolean };
    };
  };

  /**
   * A model resolved from a key-scoped listing carries zero prices, which Pi
   * means as "unknown pricing" rather than "free". Reporting that $0 makes
   * unknown spend look free to consumers (rootcoz), so usage.cost_usd must stay
   * null instead of accumulating a numeric zero.
   *
   * A provider can still report a real turn cost for such a model, so a
   * *positive* total must always be kept.
   */
  it("prompt() distinguishes unknown pricing from a reported zero", async () => {
    const priced = await promptWithReportedCost(true, 0.42);
    assert.equal(priced.usage.cost_usd, 0.42, "a priced model reports its cost");

    const pricedFree = await promptWithReportedCost(true, 0);
    assert.equal(pricedFree.usage.cost_usd, 0, "a priced model reporting zero is genuinely free");
    assert.equal(pricedFree.usage.cost_partial, false, "a priced model has no unknown turns to withhold");

    const unknownZero = await promptWithReportedCost(false, 0);
    assert.equal(unknownZero.usage.cost_usd, null, "unknown pricing must stay null, not report as free");

    const unknownReal = await promptWithReportedCost(false, 1.75);
    assert.equal(
      unknownReal.usage.cost_usd,
      1.75,
      "a driver-reported positive cost must survive even when catalog pricing is unknown",
    );
  });

  /**
   * pi 1.5.0 tags a provider-billed total with `cost.totalFromProvider`. A
   * billing driver knows what it charged, so a billed zero is genuinely free
   * spend even when the model's catalog price is unknown — withholding it would
   * report free spend as unknown, the mirror of the bug the case above guards.
   */
  it("prompt() trusts a provider-billed total even when catalog pricing is unknown", async () => {
    const billedFree = await promptWithReportedCost(false, 0, true);
    assert.equal(billedFree.usage.cost_usd, 0, "a provider-billed zero is free spend, not unknown spend");
    assert.equal(billedFree.usage.cost_partial, false, "nothing was withheld, so the total is complete");

    const billedReal = await promptWithReportedCost(false, 1.25, true);
    assert.equal(billedReal.usage.cost_usd, 1.25, "a provider-billed amount is kept as sent");
    assert.equal(billedReal.usage.cost_partial, false, "a billed total is complete");

    const estimateFree = await promptWithReportedCost(false, 0, false);
    assert.equal(estimateFree.usage.cost_usd, null, "an unmarked zero stays unknown, not free");
    assert.equal(estimateFree.usage.cost_partial, true, "and the total stays a lower bound");
  });

  /**
   * Token accounting is independent of pricing: withholding an unknown cost must
   * not disturb the token counts, for either a priced or an unknown-priced model.
   */
  it("prompt() keeps token counts intact regardless of pricing", async () => {
    for (const pricingKnown of [true, false]) {
      const result = await promptWithReportedCost(pricingKnown, 0);
      assert.equal(result.usage.input_tokens, 10, `input tokens intact (pricingKnown=${pricingKnown})`);
      assert.equal(result.usage.output_tokens, 4, `output tokens intact (pricingKnown=${pricingKnown})`);
      assert.equal(result.usage.cache_read_tokens, 3, `cache reads intact (pricingKnown=${pricingKnown})`);
      assert.equal(result.usage.cache_write_tokens, 2, `cache writes intact (pricingKnown=${pricingKnown})`);
    }
  });

  /**
   * A prompt can mix a turn whose cost the driver reported with a turn whose zero
   * report means unknowable. The accumulated amount is then a floor, not a total,
   * and `cost_partial` must say so rather than let a partial figure read as complete.
   */
  it("prompt() flags a cost as partial when an unknown turn contributes nothing", async () => {
    let emit: (event: unknown) => void = () => {};
    const { store } = createTestStore({
      ready: true,
      allowAnyModel: true,
      sessionFactory: () => ({
        session: {
          subscribe: (cb: (event: unknown) => void) => {
            emit = cb;
            return () => {};
          },
          prompt: async () => {
            emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } });
            emit({ type: "agent_end", messages: [
              { role: "assistant", content: [{ type: "text", text: "a" }], usage: { input: 5, output: 2, cost: { total: 1.25 } } },
              { role: "assistant", content: [{ type: "text", text: "b" }], usage: { input: 5, output: 2, cost: { total: 0 } } },
            ] });
          },
          dispose: () => {},
          abort: async () => {},
        },
        pricingKnown: false,
      }),
    });
    const id = await store.create({
      provider: "test",
      model: "test",
      systemPrompt: "partial cost test",
      cwd: "/tmp/job-pricing",
    });
    const result = await store.prompt(id, "hi") as { usage: { cost_usd: number | null; cost_partial: boolean } };
    assert.equal(result.usage.cost_usd, 1.25, "the reported amount is kept");
    assert.equal(result.usage.cost_partial, true, "but the total is only a lower bound");
  });

  /**
   * An unknown-priced turn may omit cost entirely rather than report zero. That
   * turn's spend is equally unknowable, so it must mark the total partial too —
   * otherwise a mixed prompt returns a lower bound flagged as complete.
   */
  it("prompt() flags a cost as partial when an unknown turn reports no cost at all", async () => {
    let emit: (event: unknown) => void = () => {};
    const { store } = createTestStore({
      ready: true,
      allowAnyModel: true,
      sessionFactory: () => ({
        session: {
          subscribe: (cb: (event: unknown) => void) => {
            emit = cb;
            return () => {};
          },
          prompt: async () => {
            emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } });
            emit({ type: "agent_end", messages: [
              { role: "assistant", content: [{ type: "text", text: "a" }], usage: { input: 5, output: 2, cost: { total: 2.5 } } },
              { role: "assistant", content: [{ type: "text", text: "b" }], usage: { input: 5, output: 2 } },
            ] });
          },
          dispose: () => {},
          abort: async () => {},
        },
        pricingKnown: false,
      }),
    });
    const id = await store.create({
      provider: "test",
      model: "test",
      systemPrompt: "omitted cost test",
      cwd: "/tmp/job-pricing",
    });
    const result = await store.prompt(id, "hi") as { usage: { cost_usd: number | null; cost_partial: boolean } };
    assert.equal(result.usage.cost_usd, 2.5, "the reported amount is kept");
    assert.equal(result.usage.cost_partial, true, "an omitted cost is unknown, so the total is a lower bound");
  });

  /**
   * Detection itself must be covered: hasKnownPricing() is what marks a session
   * unknown-priced, and prompt() above supplies that flag directly.
   *
   * Pi requires numeric prices, so a source that published none yields zeros.
   * Those zeros mean *unknown* — and the fabrication sites mark the model to say
   * so. A catalog all-zero cost means the opposite: the price is known to be
   * zero (an OpenRouter `:free` variant), which must report as a real $0.
   */
  it("hasKnownPricing() reads the model's price metadata", () => {
    assert.equal(hasKnownPricing({ cost: { input: 0, output: 0.000003, cacheRead: 0, cacheWrite: 0 } }), true,
      "any priced component means the price is known");
    assert.equal(hasKnownPricing({ cost: {} }), false, "price metadata with no component means unknown");
    assert.equal(hasKnownPricing({}), false, "absent price metadata means unknown");
    assert.equal(hasKnownPricing(undefined), false, "an absent model means unknown");
  });

  it("hasKnownPricing() trusts the unknown marker over the numeric value", () => {
    const fabricated = { cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 } };
    (fabricated as Record<symbol, unknown>)[Symbol.for("pi-config.pricingUnknown")] = true;
    assert.equal(hasKnownPricing(fabricated), false,
      "a marked placeholder stays unknown even when it carries positive numbers");

    const sourced = { cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 } };
    (sourced as Record<symbol, unknown>)[Symbol.for("pi-config.pricingUnknown")] = false;
    assert.equal(hasKnownPricing(sourced), true, "only a true marker withholds the price");
  });

  /**
   * An unmarked all-zero cost is authoritative only when pi-ai's generated
   * catalog declares that model free. Pi's provider composer fills a models.json
   * definition that omits `cost` with zeros and marks nothing, so an unmarked
   * zero cost with no catalog entry behind it is unknown spend, not free spend.
   */
  it("hasKnownPricing() accepts an all-zero cost only from the generated catalog", () => {
    const catalogFree = builtinProviders()
      .flatMap((provider) => provider.getModels().map((model) => ({ provider: provider.id, model })))
      .find(({ model }) => {
        const prices = Object.values(model.cost ?? {});
        return prices.length > 0 && prices.every((value) => value === 0);
      });
    assert.ok(catalogFree, "pi-ai ships at least one genuinely free catalog model");
    assert.equal(
      hasKnownPricing({
        provider: catalogFree.provider,
        id: catalogFree.model.id,
        api: catalogFree.model.api,
        baseUrl: catalogFree.model.baseUrl,
        cost: catalogFree.model.cost,
      }),
      true,
      "a catalog free model, as the runtime resolves it, is a known $0",
    );

    assert.equal(
      hasKnownPricing({
        provider: "my-custom-gateway",
        id: "some-model",
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      false,
      "a models.json / custom-provider model with Pi-supplied zeros is unknown, not free",
    );

    assert.equal(
      hasKnownPricing({
        provider: "openrouter",
        id: "definitely-not-a-real-model-id",
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      false,
      "an all-zero cost with no catalog entry behind it stays unknown",
    );
  });

  it("hasKnownPricing() keeps a priced model known regardless of catalog membership", () => {
    assert.equal(
      hasKnownPricing({
        provider: "my-custom-gateway",
        id: "some-model",
        cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
      }),
      true,
      "a positive component is authoritative on its own",
    );
  });

    /**
   * Sharing a free catalog model's provider and id is not evidence of anything:
   * pi's provider composer fills an omitted cost with zeros, so the catalog check
   * also verifies the model still points at the catalog's api and endpoint.
   */
  it("hasKnownPricing() rejects an unpriced override of a free catalog model", () => {
    const catalogFree = builtinProviders()
      .flatMap((provider) => provider.getModels().map((model) => ({ provider: provider.id, model })))
      .find(({ model }) => {
        const prices = Object.values(model.cost ?? {});
        return prices.length > 0 && prices.every((value) => value === 0);
      });
    assert.ok(catalogFree, "pi-ai ships at least one genuinely free catalog model");
    const { provider: providerId, model } = catalogFree;

    assert.equal(
      hasKnownPricing({
        provider: providerId,
        id: model.id,
        api: model.api,
        baseUrl: model.baseUrl,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      true,
      "the catalog's own free entry is a known $0",
    );
    assert.equal(
      hasKnownPricing({
        provider: providerId,
        id: model.id,
        api: model.api,
        baseUrl: "https://some-other-gateway.example/v1",
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      false,
      "an unpriced override repointing the model at another endpoint is a different price source",
    );
    assert.equal(
      hasKnownPricing({ provider: providerId, id: model.id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      false,
      "without the api and endpoint, the identifier alone is not proof of provenance",
    );
  });

  it("hasKnownPricing() rejects an unpriced override of a priced catalog model", () => {
    const priced = builtinProviders()
      .flatMap((provider) => provider.getModels().map((model) => ({ provider: provider.id, model })))
      .find(({ model }) => Object.values(model.cost ?? {}).some((value) => value > 0));
    assert.ok(priced, "pi-ai ships priced models");
    assert.equal(
      hasKnownPricing({
        provider: priced.provider,
        id: priced.model.id,
        api: priced.model.api,
        baseUrl: priced.model.baseUrl,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      false,
      "a zero-filled cost must never stand in for a catalog price the catalog publishes as non-zero",
    );
  });

  it("hasKnownPricing() accepts source-published zero prices outside the catalog", () => {
    const published = { provider: "my-custom-gateway", id: "free-model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    (published as Record<symbol, unknown>)[Symbol.for("pi-config.pricingKnown")] = true;
    assert.equal(
      hasKnownPricing(published),
      true,
      "a models.dev or /v1/models record stating a zero price published real prices",
    );

    const bothMarkers = { provider: "my-custom-gateway", id: "free-model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    (bothMarkers as Record<symbol, unknown>)[Symbol.for("pi-config.pricingKnown")] = true;
    (bothMarkers as Record<symbol, unknown>)[Symbol.for("pi-config.pricingUnknown")] = true;
    assert.equal(hasKnownPricing(bothMarkers), false, "unknown wins when both markers are present");
  });
});
