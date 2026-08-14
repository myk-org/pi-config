/**
 * models.dev cache, CLI/ACPX id mapping, and missing-field fill.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MODELS_DEV_TTL_MS,
  applyThinkingLevelFromModel,
  catalogIndexCacheStats,
  fillRuntimeModelFromCatalog,
  loadModelsDevCatalog,
  lookupModelsDevModel,
  modelsDevCachePath,
  resetCatalogIndexCacheForTests,
  thinkingLevelFromDiscoveredId,
} from "../../../extensions/shared/models-dev.js";
import { mapCliDiscoveredModels } from "../../../extensions/cli-provider/runtime-models.js";
import { mapAcpxDiscoveredModels } from "../../../extensions/acpx-provider/runtime-models.js";
import { buildRuntimeModel } from "../../../extensions/shared/create-runtime-provider.js";

const SAMPLE_CATALOG = {
  xai: {
    models: {
      "grok-4.6": {
        id: "grok-4.6",
        name: "Grok 4.6",
        reasoning: true,
        limit: { context: 500_000, output: 500_000 },
        cost: { input: 2, output: 6, cache_read: 0.5 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
  anthropic: {
    models: {
      "claude-opus-4-6": {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        reasoning: true,
        limit: { context: 200_000, output: 128_000 },
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
};

function catalogResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("modelsDevCachePath", () => {
  it("is ~/.pi/pi-config/models.dev.json", () => {
    assert.equal(modelsDevCachePath("/home/me"), join("/home/me", ".pi", "pi-config", "models.dev.json"));
  });
});

describe("loadModelsDevCatalog", () => {
  it("fetches catalog when cache file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-dev-"));
    const cachePath = join(dir, "models.dev.json");
    let fetches = 0;
    try {
      const catalog = await loadModelsDevCatalog({
        cachePath,
        fetchImpl: async () => {
          fetches += 1;
          return catalogResponse(SAMPLE_CATALOG);
        },
      });
      assert.equal(fetches, 1);
      assert.equal(catalog?.xai?.models?.["grok-4.6"]?.limit?.context, 500_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes cache file when catalog fetch succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-dev-"));
    const cachePath = join(dir, "models.dev.json");
    try {
      await loadModelsDevCatalog({
        cachePath,
        fetchImpl: async () => catalogResponse(SAMPLE_CATALOG),
      });
      const disk = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.equal(disk.xai.models["grok-4.6"].id, "grok-4.6");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concurrent refreshes leave a valid cache file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-dev-"));
    const cachePath = join(dir, "models.dev.json");
    try {
      await Promise.all([
        loadModelsDevCatalog({
          cachePath,
          fetchImpl: async () => catalogResponse(SAMPLE_CATALOG),
        }),
        loadModelsDevCatalog({
          cachePath,
          fetchImpl: async () => catalogResponse(SAMPLE_CATALOG),
        }),
      ]);
      const disk = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.equal(disk.xai.models["grok-4.6"].id, "grok-4.6");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses cache younger than one day without fetching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-dev-"));
    mkdirSync(dir, { recursive: true });
    const cachePath = join(dir, "models.dev.json");
    writeFileSync(cachePath, JSON.stringify(SAMPLE_CATALOG));
    let fetches = 0;
    try {
      const catalog = await loadModelsDevCatalog({
        cachePath,
        nowMs: Date.now(),
        fetchImpl: async () => {
          fetches += 1;
          return catalogResponse({ should: "not-run" });
        },
      });
      assert.equal(fetches, 0);
      assert.equal(catalog?.xai?.models?.["grok-4.6"]?.id, "grok-4.6");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refetches when cache is older than one day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-dev-"));
    const cachePath = join(dir, "models.dev.json");
    writeFileSync(cachePath, JSON.stringify({ stale: { models: {} } }));
    const old = (Date.now() - MODELS_DEV_TTL_MS - 1000) / 1000;
    utimesSync(cachePath, old, old);
    let fetches = 0;
    try {
      const catalog = await loadModelsDevCatalog({
        cachePath,
        nowMs: Date.now(),
        fetchImpl: async () => {
          fetches += 1;
          return catalogResponse(SAMPLE_CATALOG);
        },
      });
      assert.equal(fetches, 1);
      assert.equal(catalog?.xai?.models?.["grok-4.6"]?.id, "grok-4.6");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps stale cache when refresh fetch fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-dev-"));
    const cachePath = join(dir, "models.dev.json");
    writeFileSync(cachePath, JSON.stringify(SAMPLE_CATALOG));
    const old = (Date.now() - MODELS_DEV_TTL_MS - 1000) / 1000;
    utimesSync(cachePath, old, old);
    try {
      const catalog = await loadModelsDevCatalog({
        cachePath,
        nowMs: Date.now(),
        fetchImpl: async () => catalogResponse({ error: true }, 500),
      });
      assert.equal(catalog?.xai?.models?.["grok-4.6"]?.id, "grok-4.6");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lookupModelsDevModel", () => {
  it("maps cursor-grok-4.6-high to xai grok-4.6", () => {
    const hit = lookupModelsDevModel(SAMPLE_CATALOG, "cursor", "cursor-grok-4.6-high");
    assert.equal(hit?.provider, "xai");
    assert.equal(hit?.modelId, "grok-4.6");
    assert.equal(hit?.entry.limit?.context, 500_000);
  });

  it("maps acpx grok-4.6[effort=xhigh,fast=false] to xai grok-4.6", () => {
    const hit = lookupModelsDevModel(
      SAMPLE_CATALOG,
      "cursor",
      "grok-4.6[effort=xhigh,fast=false]",
    );
    assert.equal(hit?.modelId, "grok-4.6");
  });

  it("maps claude-4.6-opus-high to anthropic claude-opus-4-6", () => {
    const hit = lookupModelsDevModel(SAMPLE_CATALOG, "claude", "claude-4.6-opus-high");
    assert.equal(hit?.provider, "anthropic");
    assert.equal(hit?.modelId, "claude-opus-4-6");
  });

  it("returns undefined for unknown composer ids", () => {
    assert.equal(lookupModelsDevModel(SAMPLE_CATALOG, "cursor", "composer-2.5"), undefined);
  });

  it("reuses WeakMap catalog index on second lookup", () => {
    resetCatalogIndexCacheForTests();
    lookupModelsDevModel(SAMPLE_CATALOG, "cursor", "cursor-grok-4.6-high");
    assert.deepEqual(catalogIndexCacheStats(), { builds: 1, reuses: 0 });
    lookupModelsDevModel(SAMPLE_CATALOG, "cursor", "cursor-grok-4.6-high");
    assert.deepEqual(catalogIndexCacheStats(), { builds: 1, reuses: 1 });
  });
});

describe("thinkingLevelFromDiscoveredId", () => {
  it("maps CLI -high suffix to high", () => {
    assert.equal(thinkingLevelFromDiscoveredId("cursor-grok-4.6-high"), "high");
  });

  it("maps ACPX effort=xhigh to xhigh", () => {
    assert.equal(
      thinkingLevelFromDiscoveredId("grok-4.6[effort=xhigh,fast=false]"),
      "xhigh",
    );
  });

  it("maps effort=high in brackets over a missing suffix", () => {
    assert.equal(thinkingLevelFromDiscoveredId("grok-4.6[effort=high]"), "high");
  });

  it("maps trailing -off suffix to off", () => {
    assert.equal(thinkingLevelFromDiscoveredId("cursor-grok-4.6-off"), "off");
  });

  it("maps trailing -max suffix to max", () => {
    assert.equal(thinkingLevelFromDiscoveredId("cursor-grok-4.6-max"), "max");
  });

  it("ignores thinking=true (not a level)", () => {
    assert.equal(
      thinkingLevelFromDiscoveredId("claude-opus-4-6[thinking=true]"),
      undefined,
    );
  });

  it("returns undefined when id has no effort/thinking token", () => {
    assert.equal(thinkingLevelFromDiscoveredId("composer-2.5"), undefined);
    assert.equal(thinkingLevelFromDiscoveredId("grok-4-fast"), undefined);
  });
});

describe("applyThinkingLevelFromModel", () => {
  it("sets high for cli-cursor cursor-grok-4.6-high", () => {
    const calls: string[] = [];
    const level = applyThinkingLevelFromModel(
      { id: "cursor:cursor-grok-4.6-high", provider: "cli-cursor" },
      (next) => calls.push(next),
      () => "off",
    );
    assert.equal(level, "high");
    assert.deepEqual(calls, ["high"]);
  });

  it("skips native providers", () => {
    const calls: string[] = [];
    const level = applyThinkingLevelFromModel(
      { id: "grok-4.6", provider: "xai" },
      (next) => calls.push(next),
    );
    assert.equal(level, undefined);
    assert.deepEqual(calls, []);
  });

  it("skips set when already at that level", () => {
    const calls: string[] = [];
    applyThinkingLevelFromModel(
      { id: "cursor:cursor-grok-4.6-high", provider: "cli-cursor" },
      (next) => calls.push(next),
      () => "high",
    );
    assert.deepEqual(calls, []);
  });
});

describe("fillRuntimeModelFromCatalog", () => {
  it("fills missing contextWindow maxTokens cost from catalog; reasoning from -high id", () => {
    const filled = fillRuntimeModelFromCatalog(
      {
        id: "cursor:cursor-grok-4.6-high",
        name: "Cursor Grok 4.6 (cursor)",
        api: "cli",
        provider: "cli-cursor",
      },
      SAMPLE_CATALOG,
      "cursor",
      "cursor-grok-4.6-high",
    );
    assert.equal(filled.contextWindow, 500_000);
    assert.equal(filled.maxTokens, 500_000);
    assert.equal(filled.reasoning, true);
    assert.equal(filled.cost?.input, 2);
    assert.equal(filled.cost?.output, 6);
    assert.equal(filled.cost?.cacheRead, 0.5);
  });

  it("does not copy catalog reasoning onto ids with no effort token", () => {
    const filled = fillRuntimeModelFromCatalog(
      {
        id: "cursor:composer-2.5",
        name: "Composer 2.5 (cursor)",
        api: "cli",
        provider: "cli-cursor",
      },
      { xai: { models: { "composer-2.5": { id: "composer-2.5", reasoning: true } } } },
      "cursor",
      "composer-2.5",
    );
    assert.equal(filled.reasoning, undefined);
  });

  it("enables xhigh on thinkingLevelMap so pi will not clamp to high", () => {
    const filled = fillRuntimeModelFromCatalog(
      {
        id: "cursor:grok-4.6[effort=xhigh,fast=false]",
        name: "Grok 4.6 (cursor)",
        api: "acpx",
        provider: "acpx-cursor",
      },
      SAMPLE_CATALOG,
      "cursor",
      "grok-4.6[effort=xhigh,fast=false]",
    );
    assert.equal(filled.reasoning, true);
    assert.equal(filled.thinkingLevelMap?.xhigh, "xhigh");
  });

  it("uses bracket context= over catalog", () => {
    const filled = fillRuntimeModelFromCatalog(
      {
        id: "cursor:grok-4.6[context=200k]",
        name: "Grok 4.6 (cursor)",
        api: "acpx",
        provider: "acpx-cursor",
        contextWindow: undefined,
      },
      SAMPLE_CATALOG,
      "cursor",
      "grok-4.6[context=200k,effort=high]",
    );
    assert.equal(filled.contextWindow, 200_000);
  });

  it("keeps explicit reasoning false over catalog", () => {
    const filled = fillRuntimeModelFromCatalog(
      {
        id: "cursor:grok-4.6[context=200k]",
        name: "Grok 4.6 (cursor)",
        api: "acpx",
        provider: "acpx-cursor",
        reasoning: false,
      },
      SAMPLE_CATALOG,
      "cursor",
      "grok-4.6[context=200k,effort=high]",
    );
    assert.equal(filled.reasoning, false);
  });

  it("leaves defaults when catalog has no match", () => {
    const filled = fillRuntimeModelFromCatalog(
      {
        id: "cursor:composer-2.5",
        name: "Composer 2.5 (cursor)",
        api: "cli",
        provider: "cli-cursor",
      },
      SAMPLE_CATALOG,
      "cursor",
      "composer-2.5",
    );
    const built = buildRuntimeModel(filled);
    assert.equal(built.contextWindow, 200_000);
    assert.equal(built.maxTokens, 32_768);
  });
});

describe("mapCli/mapAcpx with catalog", () => {
  it("fills cli-cursor grok from catalog", () => {
    const models = mapCliDiscoveredModels(
      "cursor",
      [{ id: "cursor-grok-4.6-high", name: "Cursor Grok 4.6" }],
      SAMPLE_CATALOG,
    );
    const grok = models.find((m) => m.id === "cursor:cursor-grok-4.6-high");
    assert.equal(grok?.contextWindow, 500_000);
  });

  it("leaves unmatched cli models at defaults", () => {
    const models = mapCliDiscoveredModels(
      "cursor",
      [{ id: "composer-2.5", name: "Composer 2.5" }],
      SAMPLE_CATALOG,
    );
    const composer = models.find((m) => m.id === "cursor:composer-2.5");
    assert.equal(composer?.contextWindow, 200_000);
  });

  it("fills acpx ids from catalog", () => {
    const models = mapAcpxDiscoveredModels(
      "cursor",
      ["grok-4.6[effort=xhigh,fast=false]"],
      SAMPLE_CATALOG,
    );
    assert.equal(models[0].contextWindow, 500_000);
    assert.equal(models[0].reasoning, true);
    assert.equal(models[0].thinkingLevelMap?.xhigh, "xhigh");
  });

  it("without catalog still sets reasoning from -high id", () => {
    const models = mapCliDiscoveredModels("cursor", [
      { id: "cursor-grok-4.6-high", name: "Cursor Grok 4.6" },
    ]);
    assert.equal(models[0].contextWindow, 200_000);
    assert.equal(models[0].reasoning, true);
  });
});
