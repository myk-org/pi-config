/**
 * Tests for cli-provider createProvider model mapping / fetchModels shape.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapCliDiscoveredModels } from "../../../extensions/cli-provider/runtime-models.js";
import {
  bindCliAgentStates,
  bindCliAgentStatesForTests,
  isCliAgentConfigured,
} from "../../../extensions/cli-provider/configured.js";
import { clearResolveBinaryCache } from "../../../extensions/cli-provider/shared/discover-cache.js";
import {
  buildAmbientLoginAuth,
  filterModelsWhenConfigured,
} from "../../../extensions/shared/create-runtime-provider.js";
import type { DiscoveredCliModel } from "../../../extensions/cli-provider/discover.js";

/**
 * Mirrors cli-provider fetchModels gate + mapping (without loading index/stream).
 * available ≡ isCliBinaryAvailable(agent) && agents.has(agent).
 */
async function simulateCliFetchModels(
  available: boolean,
  discover: () => Promise<readonly DiscoveredCliModel[]>,
  agent: string,
  availableModelIds?: string[],
): Promise<ReturnType<typeof mapCliDiscoveredModels>> {
  if (!available) return [];
  const next = await discover();
  if (availableModelIds) {
    availableModelIds.length = 0;
    availableModelIds.push(...next.map((m) => m.id));
  }
  return mapCliDiscoveredModels(agent, next);
}

describe("mapCliDiscoveredModels", () => {
  it("maps discovered models to full cli Model shape", () => {
    const models = mapCliDiscoveredModels("cursor", [
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "gpt-5.4", name: "GPT 5.4" },
    ]);
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "cursor:composer-2.5");
    assert.equal(models[0].name, "Composer 2.5 (cursor)");
    assert.equal(models[0].api, "cli");
    assert.equal(models[0].provider, "cli-cursor");
    assert.ok(models[0].baseUrl);
    assert.equal(models[1].id, "cursor:gpt-5.4");
  });

  it("falls back to agent:default when discovery empty", () => {
    const models = mapCliDiscoveredModels("claude", []);
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "claude:default");
    assert.equal(models[0].name, "claude (default)");
    assert.equal(models[0].api, "cli");
    assert.equal(models[0].provider, "cli-claude");
  });
});

describe("cli fetchModels (gate + map)", () => {
  it("unavailable → []", async () => {
    const out = await simulateCliFetchModels(
      false,
      async () => [{ id: "composer-2.5", name: "Composer 2.5" }],
      "cursor",
    );
    assert.deepEqual(out, []);
  });

  it("available + empty discovery → agent:default", async () => {
    const out = await simulateCliFetchModels(true, async () => [], "claude");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "claude:default");
  });

  it("available + models → mapped full models", async () => {
    const out = await simulateCliFetchModels(
      true,
      async () => [
        { id: "composer-2.5", name: "Composer 2.5" },
        { id: "gpt-5.4", name: "GPT 5.4" },
      ],
      "cursor",
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "cursor:composer-2.5");
    assert.equal(out[0].api, "cli");
    assert.equal(out[0].provider, "cli-cursor");
    assert.equal(out[1].id, "cursor:gpt-5.4");
  });

  it("available + models updates availableModelIds", async () => {
    const availableModelIds: string[] = ["stale"];
    const out = await simulateCliFetchModels(
      true,
      async () => [
        { id: "composer-2.5", name: "Composer 2.5" },
        { id: "gpt-5.4", name: "GPT 5.4" },
      ],
      "cursor",
      availableModelIds,
    );
    assert.equal(out.length, 2);
    assert.deepEqual(availableModelIds, ["composer-2.5", "gpt-5.4"]);
  });
});

describe("cli-provider auth/filter wiring shape", () => {
  it("auth display name uses CLI agent label", () => {
    const auth = buildAmbientLoginAuth({
      displayName: "CLI cursor",
      isConfigured: () => false,
      sourceLabel: "cursor CLI on PATH",
    });
    assert.equal(auth.name, "CLI cursor");
  });

  it("filter hides models when binary unavailable", () => {
    const models = mapCliDiscoveredModels("cursor", [
      { id: "composer-2.5", name: "Composer 2.5" },
    ]);
    const filtered = filterModelsWhenConfigured(models, undefined, () => false);
    assert.deepEqual(filtered, []);
  });
});

describe("isCliAgentConfigured", () => {
  const prevPath = process.env.PATH;
  let binDir: string | undefined;

  afterEach(() => {
    process.env.PATH = prevPath;
    clearResolveBinaryCache();
    bindCliAgentStatesForTests([]);
    if (binDir) {
      rmSync(binDir, { recursive: true, force: true });
      binDir = undefined;
    }
  });

  function installFakeBinary(name: string): void {
    binDir = mkdtempSync(join(tmpdir(), "cli-bin-"));
    const dest = join(binDir, name);
    writeFileSync(dest, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${binDir}${prevPath ? `:${prevPath}` : ""}`;
    clearResolveBinaryCache();
  }

  it("false when agent state missing", () => {
    installFakeBinary("agent");
    bindCliAgentStatesForTests([]);
    assert.equal(isCliAgentConfigured("cursor"), false);
  });

  it("false when binary missing despite agent state", () => {
    binDir = mkdtempSync(join(tmpdir(), "cli-bin-empty-"));
    // PATH with empty dir — no "agent" binary
    process.env.PATH = binDir;
    clearResolveBinaryCache();
    bindCliAgentStatesForTests(["cursor"]);
    assert.equal(isCliAgentConfigured("cursor"), false);
  });

  it("true when binary on PATH with agent state", () => {
    installFakeBinary("agent");
    bindCliAgentStatesForTests(["cursor"]);
    assert.equal(isCliAgentConfigured("cursor"), true);
  });

  it("false for unknown agent name", () => {
    installFakeBinary("agent");
    bindCliAgentStatesForTests(["not-a-cli-agent"]);
    assert.equal(isCliAgentConfigured("not-a-cli-agent"), false);
  });

  it("bindCliAgentStates wires a live Map used by isCliAgentConfigured", () => {
    installFakeBinary("agent");
    const live = new Map<string, unknown>();
    bindCliAgentStates(live);
    assert.equal(isCliAgentConfigured("cursor"), false);
    live.set("cursor", {});
    assert.equal(isCliAgentConfigured("cursor"), true);
    live.delete("cursor");
    assert.equal(isCliAgentConfigured("cursor"), false);
  });
});
