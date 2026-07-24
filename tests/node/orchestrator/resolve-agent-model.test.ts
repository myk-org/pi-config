/**
 * resolveAgentModelProvider — priority chain for agent model/provider.
 *
 * Isolates settings via setGlobalSettingsPath so tests ignore real ~/.pi/.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	clearSettingsCache,
	setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";
import { resolveAgentModelProvider } from "../../../extensions/orchestrator/resolve-agent-model.js";

describe("resolveAgentModelProvider", () => {
	let tmp: string;
	let globalTmp: string;

	beforeEach(() => {
		clearSettingsCache();
		tmp = mkdtempSync(join(tmpdir(), "pi-resolve-agent-model-"));
		globalTmp = mkdtempSync(join(tmpdir(), "pi-resolve-agent-model-global-"));
		setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
	});

	afterEach(() => {
		setGlobalSettingsPath(null);
		clearSettingsCache();
		rmSync(tmp, { recursive: true, force: true });
		rmSync(globalTmp, { recursive: true, force: true });
	});

	function writeSettings(data: Record<string, unknown>): void {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(join(tmp, ".pi", "pi-config-settings.json"), JSON.stringify(data));
		clearSettingsCache();
	}

	it("no settings, no frontmatter → parent model/provider", () => {
		const result = resolveAgentModelProvider(
			"worker",
			{},
			"parent-model",
			"parent-provider",
			tmp
		);
		assert.deepEqual(result, { model: "parent-model", provider: "parent-provider" });
	});

	it("global agent_provider + agent_model → those values", () => {
		writeSettings({
			agent_provider: "global-provider",
			agent_model: "global-model",
		});
		const result = resolveAgentModelProvider(
			"worker",
			{},
			"parent-model",
			"parent-provider",
			tmp
		);
		assert.deepEqual(result, { model: "global-model", provider: "global-provider" });
	});

	it("agent frontmatter overrides global settings", () => {
		writeSettings({
			agent_provider: "global-provider",
			agent_model: "global-model",
		});
		const result = resolveAgentModelProvider(
			"worker",
			{ model: "fm-model", provider: "fm-provider" },
			"parent-model",
			"parent-provider",
			tmp
		);
		assert.deepEqual(result, { model: "fm-model", provider: "fm-provider" });
	});

	it("agent_overrides with specific values → uses override", () => {
		writeSettings({
			agent_provider: "global-provider",
			agent_model: "global-model",
			agent_overrides: {
				worker: { model: "override-model", provider: "override-provider" },
			},
		});
		const result = resolveAgentModelProvider(
			"worker",
			{ model: "fm-model", provider: "fm-provider" },
			"parent-model",
			"parent-provider",
			tmp
		);
		assert.deepEqual(result, { model: "override-model", provider: "override-provider" });
	});

	it("agent_overrides with null model → parent model (skips settings + frontmatter)", () => {
		writeSettings({
			agent_provider: "global-provider",
			agent_model: "global-model",
			agent_overrides: {
				worker: { model: null, provider: "override-provider" },
			},
		});
		const result = resolveAgentModelProvider(
			"worker",
			{ model: "fm-model", provider: "fm-provider" },
			"parent-model",
			"parent-provider",
			tmp
		);
		assert.deepEqual(result, { model: "parent-model", provider: "override-provider" });
	});

	it("agent_overrides with null provider → parent provider", () => {
		writeSettings({
			agent_provider: "global-provider",
			agent_model: "global-model",
			agent_overrides: {
				worker: { model: "override-model", provider: null },
			},
		});
		const result = resolveAgentModelProvider(
			"worker",
			{ model: "fm-model", provider: "fm-provider" },
			"parent-model",
			"parent-provider",
			tmp
		);
		assert.deepEqual(result, { model: "override-model", provider: "parent-provider" });
	});

	it("partial override (only model) → model from override, provider from fallback chain", () => {
		writeSettings({
			agent_provider: "global-provider",
			agent_model: "global-model",
			agent_overrides: {
				worker: { model: "override-model" },
			},
		});
		const result = resolveAgentModelProvider(
			"worker",
			{ provider: "fm-provider" },
			"parent-model",
			"parent-provider",
			tmp
		);
		// model from override; provider falls through override → frontmatter
		assert.deepEqual(result, { model: "override-model", provider: "fm-provider" });
	});

	it("resolves model and provider independently from override", () => {
		// override sets only model — provider falls through normally
		writeSettings({ agent_overrides: { myagent: { model: "custom-model" } } });
		const result = resolveAgentModelProvider(
			"myagent",
			{ provider: "agent-provider" },
			"parent-model",
			"parent-provider",
			tmp
		);
		assert.strictEqual(result.model, "custom-model");
		assert.strictEqual(result.provider, "agent-provider"); // from frontmatter, not parent
	});
});
