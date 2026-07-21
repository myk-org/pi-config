/**
 * Tests for acpx-provider createProvider model mapping / fetchModels shape.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mapAcpxDiscoveredModels } from "../../../extensions/acpx-provider/runtime-models.js";
import {
  bindAcpxAgentStatesForTests,
  isAcpxAgentConfigured,
} from "../../../extensions/acpx-provider/configured.js";
import {
  buildAmbientLoginAuth,
  filterModelsWhenConfigured,
} from "../../../extensions/shared/create-runtime-provider.js";

/**
 * Mirrors acpx-provider fetchModels gate + mapping (without loading index/runtime).
 * available ≡ agents.has(agent) / isAcpxAgentConfigured(agent).
 */
async function simulateAcpxFetchModels(
  available: boolean,
  discover: () => Promise<readonly string[]>,
  agent: string,
): Promise<ReturnType<typeof mapAcpxDiscoveredModels>> {
  if (!available) return [];
  const nextIds = await discover();
  return mapAcpxDiscoveredModels(agent, nextIds);
}

describe("mapAcpxDiscoveredModels", () => {
  it("maps model ids to full acpx Model shape", () => {
    const models = mapAcpxDiscoveredModels("cursor", [
      "composer-2.5[fast=true]",
      "gpt-5.4",
    ]);
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "cursor:composer-2.5[fast=true]");
    assert.equal(models[0].api, "acpx");
    assert.equal(models[0].provider, "acpx-cursor");
    assert.match(models[0].name, /Composer 2\.5/);
    assert.match(models[0].name, /\(cursor\)/);
    assert.equal(models[1].id, "cursor:gpt-5.4");
  });

  it("falls back to agent:default when discovery empty", () => {
    const models = mapAcpxDiscoveredModels("claude", []);
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "claude:default");
    assert.equal(models[0].api, "acpx");
    assert.equal(models[0].provider, "acpx-claude");
  });
});

describe("acpx fetchModels (gate + map)", () => {
  it("unavailable → []", async () => {
    const out = await simulateAcpxFetchModels(
      false,
      async () => ["composer-2.5"],
      "cursor",
    );
    assert.deepEqual(out, []);
  });

  it("available + empty discovery → agent:default", async () => {
    const out = await simulateAcpxFetchModels(true, async () => [], "claude");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "claude:default");
    assert.equal(out[0].api, "acpx");
  });

  it("available + models → mapped full models", async () => {
    const out = await simulateAcpxFetchModels(
      true,
      async () => ["composer-2.5[fast=true]", "gpt-5.4"],
      "cursor",
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "cursor:composer-2.5[fast=true]");
    assert.equal(out[0].api, "acpx");
    assert.equal(out[0].provider, "acpx-cursor");
    assert.equal(out[1].id, "cursor:gpt-5.4");
  });
});

describe("acpx-provider auth/filter wiring shape", () => {
  it("hides models when runtime unavailable", () => {
    let configured = false;
    const auth = buildAmbientLoginAuth({
      displayName: "ACPX cursor",
      isConfigured: () => configured,
      sourceLabel: "cursor acpx runtime",
    });
    assert.equal(auth.name, "ACPX cursor");

    const models = mapAcpxDiscoveredModels("cursor", ["composer-2.5"]);
    assert.deepEqual(
      filterModelsWhenConfigured(models, undefined, () => configured),
      [],
    );
    configured = true;
    assert.equal(
      filterModelsWhenConfigured(models, undefined, () => configured).length,
      1,
    );
  });
});

describe("isAcpxAgentConfigured", () => {
  afterEach(() => {
    bindAcpxAgentStatesForTests([]);
  });

  it("false when agent state missing", () => {
    bindAcpxAgentStatesForTests([]);
    assert.equal(isAcpxAgentConfigured("cursor"), false);
  });

  it("true when agent state present", () => {
    bindAcpxAgentStatesForTests(["cursor", "claude"]);
    assert.equal(isAcpxAgentConfigured("cursor"), true);
    assert.equal(isAcpxAgentConfigured("claude"), true);
    assert.equal(isAcpxAgentConfigured("gemini"), false);
  });
});
