/**
 * Extension settings in pi-config-settings.json
 *
 * Uses setGlobalSettingsPath to isolate tests from the real ~/.pi/ directory,
 * ensuring deterministic results regardless of developer machine config.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	clearSettingsCache,
	getSetting,
	parseAcpxAgentList,
	parseReviewLoopMaxCycles,
	asStringArray,
	setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";

describe("parseReviewLoopMaxCycles", () => {
	it("accepts integer boundaries 1 and 10", () => {
		assert.equal(parseReviewLoopMaxCycles(1), 1);
		assert.equal(parseReviewLoopMaxCycles(10), 10);
	});

	it("accepts numeric string boundaries", () => {
		assert.equal(parseReviewLoopMaxCycles("1"), 1);
		assert.equal(parseReviewLoopMaxCycles("10"), 10);
	});

	it("rejects 0", () => {
		assert.equal(parseReviewLoopMaxCycles(0), undefined);
	});

	it("rejects 11 (above range)", () => {
		assert.equal(parseReviewLoopMaxCycles(11), undefined);
	});

	it("rejects -1 (negative)", () => {
		assert.equal(parseReviewLoopMaxCycles(-1), undefined);
	});

	it("rejects 3.5 (non-integer)", () => {
		assert.equal(parseReviewLoopMaxCycles(3.5), undefined);
	});

	it("rejects NaN", () => {
		assert.equal(parseReviewLoopMaxCycles(NaN), undefined);
	});

	it("rejects Infinity", () => {
		assert.equal(parseReviewLoopMaxCycles(Number.POSITIVE_INFINITY), undefined);
		assert.equal(parseReviewLoopMaxCycles(Number.NEGATIVE_INFINITY), undefined);
	});

	it('rejects "inf" string', () => {
		assert.equal(parseReviewLoopMaxCycles("inf"), undefined);
	});

	it("rejects empty string", () => {
		assert.equal(parseReviewLoopMaxCycles(""), undefined);
	});

	it("rejects non-numeric strings", () => {
		assert.equal(parseReviewLoopMaxCycles("not-a-number"), undefined);
	});

	it('rejects non-digit numeric strings ("1e1", "0b1010", "10.0", "01")', () => {
		assert.equal(parseReviewLoopMaxCycles("1e1"), undefined);
		assert.equal(parseReviewLoopMaxCycles("0b1010"), undefined);
		assert.equal(parseReviewLoopMaxCycles("10.0"), undefined);
		assert.equal(parseReviewLoopMaxCycles("01"), undefined);
		assert.equal(parseReviewLoopMaxCycles("0xA"), undefined);
	});

	it("rejects non-string/non-number types", () => {
		assert.equal(parseReviewLoopMaxCycles(null), undefined);
		assert.equal(parseReviewLoopMaxCycles(undefined), undefined);
		assert.equal(parseReviewLoopMaxCycles([]), undefined);
		assert.equal(parseReviewLoopMaxCycles({}), undefined);
	});
});

describe("parseAcpxAgentList", () => {
	it("parses comma-separated string", () => {
		assert.deepEqual(parseAcpxAgentList("cursor, claude"), ["cursor", "claude"]);
	});

	it("parses array", () => {
		assert.deepEqual(parseAcpxAgentList(["cursor", "gemini"]), ["cursor", "gemini"]);
	});

	it("filters invalid agent names", () => {
		assert.deepEqual(parseAcpxAgentList("cursor, bad name!, claude"), ["cursor", "claude"]);
	});
});

describe("asStringArray", () => {
	it("returns empty for non-arrays", () => {
		assert.deepEqual(asStringArray(false), []);
		assert.deepEqual(asStringArray(undefined), []);
		assert.deepEqual(asStringArray(null), []);
		assert.deepEqual(asStringArray("cursor"), []);
		assert.deepEqual(asStringArray(1), []);
	});

	it("keeps only string entries", () => {
		assert.deepEqual(asStringArray(["cursor", 1, "claude", null]), ["cursor", "claude"]);
	});
});

describe("extension settings", () => {
	let tmp: string;
	let globalTmp: string;
	const prev = {
		PI_PIDASH_ENABLE: process.env.PI_PIDASH_ENABLE,
		PI_PIDIFF_ENABLE: process.env.PI_PIDIFF_ENABLE,
		PI_PIDASH_PORT: process.env.PI_PIDASH_PORT,
		PI_IMAGE_MODEL: process.env.PI_IMAGE_MODEL,
		PI_INTERNAL_OPERATIONS_PROVIDER: process.env.PI_INTERNAL_OPERATIONS_PROVIDER,
		PI_INTERNAL_OPERATIONS_MODEL: process.env.PI_INTERNAL_OPERATIONS_MODEL,
		ACPX_AGENTS: process.env.ACPX_AGENTS,
		CLI_AGENTS: process.env.CLI_AGENTS,
		PI_REVIEW_LOOP_MAX_CYCLES: process.env.PI_REVIEW_LOOP_MAX_CYCLES,
	};

	beforeEach(() => {
		clearSettingsCache();
		tmp = mkdtempSync(join(tmpdir(), "pi-ext-settings-"));
		globalTmp = mkdtempSync(join(tmpdir(), "pi-ext-global-"));
		// Isolate from real ~/.pi/pi-config-settings.json
		setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
		delete process.env.PI_PIDASH_ENABLE;
		delete process.env.PI_PIDIFF_ENABLE;
		delete process.env.PI_PIDASH_PORT;
		delete process.env.PI_IMAGE_MODEL;
		delete process.env.PI_INTERNAL_OPERATIONS_PROVIDER;
		delete process.env.PI_INTERNAL_OPERATIONS_MODEL;
		delete process.env.ACPX_AGENTS;
		delete process.env.CLI_AGENTS;
		delete process.env.PI_REVIEW_LOOP_MAX_CYCLES;
	});

	afterEach(() => {
		setGlobalSettingsPath(null);
		clearSettingsCache();
		rmSync(tmp, { recursive: true, force: true });
		rmSync(globalTmp, { recursive: true, force: true });
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
			else (process.env as Record<string, string>)[k] = v;
		}
	});

	function writeSettings(data: Record<string, unknown>): void {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(join(tmp, ".pi", "pi-config-settings.json"), JSON.stringify(data));
		clearSettingsCache();
	}

	function writeGlobalSettings(data: Record<string, unknown>): void {
		writeFileSync(join(globalTmp, "pi-config-settings.json"), JSON.stringify(data));
		clearSettingsCache();
	}

	it("pidash_enable defaults true", () => {
		assert.equal(getSetting(tmp, "pidash_enable"), true);
	});

	it("pidash_enable from settings file", () => {
		writeSettings({ pidash_enable: false });
		assert.equal(getSetting(tmp, "pidash_enable"), false);
	});

	it("pidash_enable from env when no settings file", () => {
		process.env.PI_PIDASH_ENABLE = "false";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "pidash_enable"), false);
	});

	it("pidiff_enable defaults true", () => {
		assert.equal(getSetting(tmp, "pidiff_enable"), true);
	});

	it("pidash_port defaults 19190", () => {
		assert.equal(getSetting(tmp, "pidash_port"), 19190);
	});

	it("pidash_port from settings wins over env", () => {
		writeSettings({ pidash_port: 9999 });
		process.env.PI_PIDASH_PORT = "8888";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "pidash_port"), 9999);
	});

	it("pidash_port from env when project omits it", () => {
		process.env.PI_PIDASH_PORT = "8888";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "pidash_port"), 8888);
	});

	it("pidash_port rejects negative values", () => {
		writeSettings({ pidash_port: -1 });
		assert.equal(getSetting(tmp, "pidash_port"), 19190);
	});

	it("pidash_port rejects zero", () => {
		writeSettings({ pidash_port: 0 });
		assert.equal(getSetting(tmp, "pidash_port"), 19190);
	});

	it("pidash_port rejects out-of-range values", () => {
		writeSettings({ pidash_port: 70000 });
		assert.equal(getSetting(tmp, "pidash_port"), 19190);
	});

	it("pidash_port rejects non-integer values", () => {
		writeSettings({ pidash_port: 19190.5 });
		assert.equal(getSetting(tmp, "pidash_port"), 19190);
	});

	it("pidash_port global wins over env", () => {
		writeGlobalSettings({ pidash_port: 7777 });
		process.env.PI_PIDASH_PORT = "8888";
		assert.equal(getSetting(tmp, "pidash_port"), 7777);
	});

	it("image_model from settings wins over env", () => {
		writeSettings({ image_model: "gemini-3-pro-image" });
		process.env.PI_IMAGE_MODEL = "from-env";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "image_model"), "gemini-3-pro-image");
	});

	it("image_model from env when project omits it", () => {
		process.env.PI_IMAGE_MODEL = "from-env";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "image_model"), "from-env");
	});

	it("explicit empty project acpx_agents disables agents", () => {
		writeSettings({ acpx_agents: [] });
		process.env.ACPX_AGENTS = "cursor";
		assert.deepEqual(getSetting(tmp, "acpx_agents"), []);
	});

	it("reads acpx_agents string from project settings", () => {
		writeSettings({ acpx_agents: "cursor,claude" });
		assert.deepEqual(getSetting(tmp, "acpx_agents"), ["cursor", "claude"]);
	});

	it("reads acpx_agents array from project settings", () => {
		writeSettings({ acpx_agents: ["cursor", "gemini"] });
		assert.deepEqual(getSetting(tmp, "acpx_agents"), ["cursor", "gemini"]);
	});

	it("falls back to ACPX_AGENTS env when project omits it", () => {
		process.env.ACPX_AGENTS = "cursor,copilot";
		clearSettingsCache();
		assert.deepEqual(getSetting(tmp, "acpx_agents"), ["cursor", "copilot"]);
	});

	it("acpx_agents global wins over env", () => {
		writeGlobalSettings({ acpx_agents: ["gemini"] });
		process.env.ACPX_AGENTS = "cursor";
		assert.deepEqual(getSetting(tmp, "acpx_agents"), ["gemini"]);
	});

	it("malformed project acpx_agents falls through to env", () => {
		writeSettings({ acpx_agents: 123 });
		process.env.ACPX_AGENTS = "cursor";
		clearSettingsCache();
		assert.deepEqual(getSetting(tmp, "acpx_agents"), ["cursor"]);
	});

	it("trims whitespace in acpx_agents array entries", () => {
		writeSettings({ acpx_agents: [" cursor ", " claude"] });
		assert.deepEqual(getSetting(tmp, "acpx_agents"), ["cursor", "claude"]);
	});

	it("project acpx_agents win over env", () => {
		process.env.ACPX_AGENTS = "claude";
		writeSettings({ acpx_agents: "cursor" });
		assert.deepEqual(getSetting(tmp, "acpx_agents"), ["cursor"]);
	});

	it("project settings win over global settings", () => {
		writeGlobalSettings({ pidash_port: 7777, image_model: "global-model" });
		writeSettings({ pidash_port: 5555 });
		assert.equal(getSetting(tmp, "pidash_port"), 5555);
		assert.equal(getSetting(tmp, "image_model"), "global-model");
	});

	it("internal_operations_provider/model default empty", () => {
		assert.equal(getSetting(tmp, "internal_operations_provider"), "");
		assert.equal(getSetting(tmp, "internal_operations_model"), "");
	});

	it("internal_operations_* from settings file", () => {
		writeSettings({
			internal_operations_provider: "anthropic",
			internal_operations_model: "claude-sonnet-4-20250514",
		});
		assert.equal(getSetting(tmp, "internal_operations_provider"), "anthropic");
		assert.equal(getSetting(tmp, "internal_operations_model"), "claude-sonnet-4-20250514");
	});

	it("internal_operations_* from env when unset in file", () => {
		process.env.PI_INTERNAL_OPERATIONS_PROVIDER = "openai";
		process.env.PI_INTERNAL_OPERATIONS_MODEL = "gpt-5.4";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "internal_operations_provider"), "openai");
		assert.equal(getSetting(tmp, "internal_operations_model"), "gpt-5.4");
	});

	it("cli_agents defaults empty", () => {
		assert.deepEqual(getSetting(tmp, "cli_agents"), []);
	});

	it("cli_agents from settings", () => {
		writeSettings({ cli_agents: ["claude", "cursor"] });
		assert.deepEqual(getSetting(tmp, "cli_agents"), ["claude", "cursor"]);
	});

	it("cli_agents from env when project omits it", () => {
		writeSettings({});
		process.env.CLI_AGENTS = "gemini";
		clearSettingsCache();
		assert.deepEqual(getSetting(tmp, "cli_agents"), ["gemini"]);
	});

	it("cli_agents normalizes mixed case", () => {
		process.env.CLI_AGENTS = "Cursor,Gemini";
		clearSettingsCache();
		assert.deepEqual(getSetting(tmp, "cli_agents"), ["cursor", "gemini"]);
	});

	it("ACPX_AGENTS normalizes mixed case", () => {
		process.env.ACPX_AGENTS = "Cursor";
		clearSettingsCache();
		assert.deepEqual(getSetting(tmp, "acpx_agents"), ["cursor"]);
	});

	it("parseAgentNameList dedupes after lowercase", () => {
		writeSettings({ cli_agents: ["Cursor", "cursor", "CURSOR"] });
		assert.deepEqual(getSetting(tmp, "cli_agents"), ["cursor"]);
	});

	it("review_loop_max_cycles defaults to 3", () => {
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 3);
	});

	it("review_loop_max_cycles from project settings wins", () => {
		writeSettings({ review_loop_max_cycles: 5 });
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 5);
	});

	it("review_loop_max_cycles from env when unset in file", () => {
		process.env.PI_REVIEW_LOOP_MAX_CYCLES = "7";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 7);
	});

	it("review_loop_max_cycles accepts 1 and 10", () => {
		writeSettings({ review_loop_max_cycles: 1 });
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 1);
		writeSettings({ review_loop_max_cycles: 10 });
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 10);
	});

	it("review_loop_max_cycles rejects 0 — fallthrough to default 3", () => {
		writeSettings({ review_loop_max_cycles: 0 });
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 3);
	});

	it("review_loop_max_cycles rejects 11 (above range) — fallthrough to default 3", () => {
		writeSettings({ review_loop_max_cycles: 11 });
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 3);
	});

	it("review_loop_max_cycles rejects -1 (negative) — fallthrough to default 3", () => {
		writeSettings({ review_loop_max_cycles: -1 });
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 3);
	});

	it('review_loop_max_cycles rejects "inf" string — fallthrough to default 3', () => {
		writeSettings({ review_loop_max_cycles: "inf" });
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 3);
	});

	it("review_loop_max_cycles rejects invalid project value — fallthrough to env", () => {
		// Note: JSON.stringify(Infinity) serializes to null, so Infinity rejection
		// itself is covered directly by the parseReviewLoopMaxCycles unit tests above;
		// this exercises the fallthrough path with a non-numeric string instead.
		process.env.PI_REVIEW_LOOP_MAX_CYCLES = "4";
		clearSettingsCache();
		writeSettings({ review_loop_max_cycles: "not-a-number" });
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 4);
	});

	it("review_loop_max_cycles rejects invalid env value — fallthrough to default 3", () => {
		process.env.PI_REVIEW_LOOP_MAX_CYCLES = "inf";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 3);
	});

	it("review_loop_max_cycles project wins over global", () => {
		writeGlobalSettings({ review_loop_max_cycles: 8 });
		writeSettings({ review_loop_max_cycles: 2 });
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 2);
	});

	it("review_loop_max_cycles global wins over env", () => {
		writeGlobalSettings({ review_loop_max_cycles: 6 });
		process.env.PI_REVIEW_LOOP_MAX_CYCLES = "9";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "review_loop_max_cycles"), 6);
	});

	describe("agent model settings", () => {
		it("agent_provider and agent_model parse from settings JSON", () => {
			writeSettings({
				agent_provider: "cli-cursor",
				agent_model: "cursor:cursor-grok-4.5-high-fast",
			});
			assert.equal(getSetting(tmp, "agent_provider"), "cli-cursor");
			assert.equal(getSetting(tmp, "agent_model"), "cursor:cursor-grok-4.5-high-fast");
		});

		it("agent_overrides parses with null values preserved", () => {
			writeSettings({
				agent_overrides: {
					debugger: { provider: null, model: null },
					reviewer: { provider: "cli-claude", model: "claude-sonnet" },
				},
			});
			assert.deepEqual(getSetting(tmp, "agent_overrides"), {
				debugger: { provider: null, model: null },
				reviewer: { provider: "cli-claude", model: "claude-sonnet" },
			});
		});

		it("empty/missing agent settings return defaults", () => {
			assert.equal(getSetting(tmp, "agent_provider"), "");
			assert.equal(getSetting(tmp, "agent_model"), "");
			assert.deepEqual(getSetting(tmp, "agent_overrides"), {});
		});

		it("whitespace-only agent_provider/agent_model return defaults", () => {
			writeSettings({ agent_provider: "   ", agent_model: "  " });
			assert.equal(getSetting(tmp, "agent_provider"), "");
			assert.equal(getSetting(tmp, "agent_model"), "");
		});

		it("invalid agent_overrides shapes are skipped", () => {
			writeSettings({
				agent_overrides: {
					ok: { provider: "cli-cursor", model: "m1" },
					badArray: ["not", "an", "object"],
					badNull: null,
					badString: "nope",
					emptyObj: {},
				},
			});
			assert.deepEqual(getSetting(tmp, "agent_overrides"), {
				ok: { provider: "cli-cursor", model: "m1" },
			});
		});

		it("array agent_overrides falls through to default {}", () => {
			writeSettings({ agent_overrides: ["not", "an", "object"] });
			assert.deepEqual(getSetting(tmp, "agent_overrides"), {});
		});
	});
});

describe("JSONC and file discovery", () => {
	let tmp: string;
	let globalTmp: string;
	const prev = {
		PI_COMS_MAX_HOPS: process.env.PI_COMS_MAX_HOPS,
	};

	beforeEach(() => {
		clearSettingsCache();
		tmp = mkdtempSync(join(tmpdir(), "pi-ext-settings-jsonc-"));
		globalTmp = mkdtempSync(join(tmpdir(), "pi-ext-global-jsonc-"));
		setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
		delete process.env.PI_COMS_MAX_HOPS;
	});

	afterEach(() => {
		setGlobalSettingsPath(null);
		clearSettingsCache();
		rmSync(tmp, { recursive: true, force: true });
		rmSync(globalTmp, { recursive: true, force: true });
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
			else (process.env as Record<string, string>)[k] = v;
		}
	});

	it("JSONC settings file parses correctly", () => {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(
			join(tmp, ".pi", "pi-config-settings.jsonc"),
			`{
  // project comment
  "image_model": "https://example.com/model", // trailing
  "coms_max_hops": 7
}
`,
		);
		clearSettingsCache();
		assert.equal(getSetting(tmp, "image_model"), "https://example.com/model");
		assert.equal(getSetting(tmp, "coms_max_hops"), 7);
	});

	it("findSettingsFile prefers .jsonc over .json", () => {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(
			join(tmp, ".pi", "pi-config-settings.jsonc"),
			JSON.stringify({ image_model: "from-jsonc" }),
		);
		writeFileSync(
			join(tmp, ".pi", "pi-config-settings.json"),
			JSON.stringify({ image_model: "from-json" }),
		);
		clearSettingsCache();
		assert.equal(getSetting(tmp, "image_model"), "from-jsonc");
	});

	it("Falls back to .json when no .jsonc exists", () => {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(
			join(tmp, ".pi", "pi-config-settings.json"),
			JSON.stringify({ image_model: "from-json-only" }),
		);
		clearSettingsCache();
		assert.equal(getSetting(tmp, "image_model"), "from-json-only");
	});

	it("Global settings file supports .jsonc", () => {
		const globalJsonc = join(globalTmp, "pi-config-settings.jsonc");
		setGlobalSettingsPath(globalJsonc);
		writeFileSync(
			globalJsonc,
			`{
  // global comment
  "image_model": "https://cdn.example.com/global", // keep // in string
  "coms_max_hops": 9
}
`,
		);
		clearSettingsCache();
		assert.equal(getSetting(tmp, "image_model"), "https://cdn.example.com/global");
		assert.equal(getSetting(tmp, "coms_max_hops"), 9);
	});

	it("int env strict parsing rejects malformed values", () => {
		process.env.PI_COMS_MAX_HOPS = "10abc";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "coms_max_hops"), 5);
		delete process.env.PI_COMS_MAX_HOPS;
	});

	it("int env accepts valid integer", () => {
		process.env.PI_COMS_MAX_HOPS = "15";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "coms_max_hops"), 15);
		delete process.env.PI_COMS_MAX_HOPS;
	});

	it("Empty string stored for string settings", () => {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(
			join(tmp, ".pi", "pi-config-settings.json"),
			JSON.stringify({ enforcement_allowed_commands: "" }),
		);
		clearSettingsCache();
		assert.equal(getSetting(tmp, "enforcement_allowed_commands"), "");
	});
});
