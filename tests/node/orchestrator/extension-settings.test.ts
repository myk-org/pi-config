/**
 * Extension settings in pi-config-settings.json
 *
 * Uses setGlobalSettingsPath to isolate tests from the real ~/.pi/ directory,
 * ensuring deterministic results regardless of developer machine config.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	SETTINGS_KEYS,
	clearSettingsCache,
	detectSource,
	getSetting,
	getSettingDynamic,
	getSettingsPath,
	parseReviewLoopMaxCycles,
	parseSettingInput,
	parseSettingsFile,
	readSettingsObject,
	resolveMainCheckoutRoot,
	resolveSetting,
	setGlobalSettingsPath,
	setSettingsLogger,
	settingsBackupPath,
	updateSetting,
	validateSetting,
} from "../../../extensions/orchestrator/project-settings.js";
import { resolveRepoRoot as utilsResolveRepoRoot } from "../../../extensions/orchestrator/utils.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


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

describe("extension settings", () => {
	let tmp: string;
	let globalTmp: string;
	const prev = {
		PI_PIDASH_ENABLE: process.env.PI_PIDASH_ENABLE,
		PI_PIDIFF_ENABLE: process.env.PI_PIDIFF_ENABLE,
		PI_PIDASH_PORT: process.env.PI_PIDASH_PORT,
		PI_INTERNAL_OPERATIONS_PROVIDER: process.env.PI_INTERNAL_OPERATIONS_PROVIDER,
		PI_INTERNAL_OPERATIONS_MODEL: process.env.PI_INTERNAL_OPERATIONS_MODEL,
		PI_REVIEW_LOOP_MAX_CYCLES: process.env.PI_REVIEW_LOOP_MAX_CYCLES,
	};

	beforeEach(() => {
		clearSettingsCache();
		tmp = makeTempDir("pi-ext-settings-");
		globalTmp = makeTempDir("pi-ext-global-");
		// Isolate from real ~/.pi/pi-config-settings.json
		setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
		delete process.env.PI_PIDASH_ENABLE;
		delete process.env.PI_PIDIFF_ENABLE;
		delete process.env.PI_PIDASH_PORT;
		delete process.env.PI_INTERNAL_OPERATIONS_PROVIDER;
		delete process.env.PI_INTERNAL_OPERATIONS_MODEL;
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

	it("internal_operations_model from settings wins over env", () => {
		writeSettings({ internal_operations_model: "claude-sonnet-4" });
		process.env.PI_INTERNAL_OPERATIONS_MODEL = "from-env";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "internal_operations_model"), "claude-sonnet-4");
	});

	it("internal_operations_model from env when project omits it", () => {
		process.env.PI_INTERNAL_OPERATIONS_MODEL = "from-env";
		clearSettingsCache();
		assert.equal(getSetting(tmp, "internal_operations_model"), "from-env");
	});

	it("project settings win over global settings", () => {
		writeGlobalSettings({ pidash_port: 7777, internal_operations_model: "global-model" });
		writeSettings({ pidash_port: 5555 });
		assert.equal(getSetting(tmp, "pidash_port"), 5555);
		assert.equal(getSetting(tmp, "internal_operations_model"), "global-model");
	});

	it("retires extensions/image-gen and ignores legacy image_model in existing settings files (#1447)", () => {
		assert.equal(existsSync(join(process.cwd(), "extensions", "image-gen")), false);
		assert.equal("image_model" in SETTINGS_KEYS, false);

		const projectFile = join(tmp, ".pi", "pi-config-settings.json");
		const globalFile = join(globalTmp, "pi-config-settings.json");
		writeGlobalSettings({ image_model: "gemini-3-pro-image", pidash_port: 7777 });
		writeSettings({ image_model: "gemini-2.5-flash-image", coms_max_hops: 8 });

		const parsedProject = parseSettingsFile(projectFile);
		assert.equal(parsedProject.coms_max_hops, 8);
		assert.equal("image_model" in parsedProject, false);
		assert.equal(getSetting(tmp, "coms_max_hops"), 8);
		assert.equal(getSetting(tmp, "pidash_port"), 7777);
		assert.equal(parseSettingsFile(globalFile).pidash_port, 7777);

		const saved = updateSetting(tmp, "project", "dco", true);
		assert.equal(saved.ok, true);
		assert.equal(getSetting(tmp, "dco"), true);
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
				agent_provider: "google",
				agent_model: "gemini-2.5-pro",
			});
			assert.equal(getSetting(tmp, "agent_provider"), "google");
			assert.equal(getSetting(tmp, "agent_model"), "gemini-2.5-pro");
		});

		it("agent_overrides parses with null values preserved", () => {
			writeSettings({
				agent_overrides: {
					debugger: { provider: null, model: null },
					reviewer: { provider: "anthropic", model: "claude-sonnet" },
				},
			});
			assert.deepEqual(getSetting(tmp, "agent_overrides"), {
				debugger: { provider: null, model: null },
				reviewer: { provider: "anthropic", model: "claude-sonnet" },
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
					ok: { provider: "google", model: "m1" },
					badArray: ["not", "an", "object"],
					badNull: null,
					badString: "nope",
					emptyObj: {},
				},
			});
			assert.deepEqual(getSetting(tmp, "agent_overrides"), {
				ok: { provider: "google", model: "m1" },
			});
		});

		it("array agent_overrides falls through to default {}", () => {
			writeSettings({ agent_overrides: ["not", "an", "object"] });
			assert.deepEqual(getSetting(tmp, "agent_overrides"), {});
		});
	});
});

describe("Settings file discovery", () => {
	let tmp: string;
	let globalTmp: string;
	const prev = {
		PI_COMS_MAX_HOPS: process.env.PI_COMS_MAX_HOPS,
	};

	beforeEach(() => {
		clearSettingsCache();
		tmp = makeTempDir("pi-ext-settings-file-");
		globalTmp = makeTempDir("pi-ext-global-file-");
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

	it("settings file with comments still parses", () => {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(
			join(tmp, ".pi", "pi-config-settings.json"),
			`{
  // project comment
  "internal_operations_model": "https://example.com/model", // trailing
  "coms_max_hops": 7
}
`,
		);
		clearSettingsCache();
		assert.equal(getSetting(tmp, "internal_operations_model"), "https://example.com/model");
		assert.equal(getSetting(tmp, "coms_max_hops"), 7);
	});

	it("ignores a legacy .jsonc next to an existing .json", () => {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(
			join(tmp, ".pi", "pi-config-settings.jsonc"),
			JSON.stringify({ internal_operations_model: "from-jsonc" }),
		);
		writeFileSync(
			join(tmp, ".pi", "pi-config-settings.json"),
			JSON.stringify({ internal_operations_model: "from-json" }),
		);
		clearSettingsCache();
		assert.equal(getSetting(tmp, "internal_operations_model"), "from-json");
	});

	it("Global settings file supports comments", () => {
		const globalJson = join(globalTmp, "pi-config-settings.json");
		setGlobalSettingsPath(globalJson);
		writeFileSync(
			globalJson,
			`{
  // global comment
  "internal_operations_model": "https://cdn.example.com/global", // keep // in string
  "coms_max_hops": 9
}
`,
		);
		clearSettingsCache();
		assert.equal(getSetting(tmp, "internal_operations_model"), "https://cdn.example.com/global");
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

	it("reuses cached project/global layers without re-reading disk (#1207)", () => {
		const globalJson = join(globalTmp, "pi-config-settings.json");
		setGlobalSettingsPath(globalJson);
		writeFileSync(globalJson, JSON.stringify({ pidash_port: 7777, internal_operations_model: "global-model" }));
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		const projectJson = join(tmp, ".pi", "pi-config-settings.json");
		writeFileSync(projectJson, JSON.stringify({ pidash_port: 8888 }));
		clearSettingsCache();

		assert.equal(getSetting(tmp, "pidash_port"), 8888);
		assert.equal(getSetting(tmp, "internal_operations_model"), "global-model");

		// Mutate disk inside the 30s cache window — cached layers must serve the cached values
		writeFileSync(projectJson, JSON.stringify({ pidash_port: 9999 }));
		writeFileSync(globalJson, JSON.stringify({ internal_operations_model: "updated-model" }));
		assert.equal(getSetting(tmp, "pidash_port"), 8888);
		assert.equal(getSetting(tmp, "internal_operations_model"), "global-model");

		// Explicit cache clear picks up the updated files immediately
		clearSettingsCache();
		assert.equal(getSetting(tmp, "pidash_port"), 9999);
		assert.equal(getSetting(tmp, "internal_operations_model"), "updated-model");
	});
});

describe("Deep settings store — unified schema, cache, and atomic persistence (#1353)", () => {
	let tmp: string;
	let globalTmp: string;
	const savedEnv: Record<string, string | undefined> = {};

	function setEnv(name: string, val: string | undefined): void {
		if (!(name in savedEnv)) savedEnv[name] = process.env[name];
		if (val === undefined) delete process.env[name];
		else process.env[name] = val;
	}

	beforeEach(() => {
		clearSettingsCache();
		tmp = makeTempDir("pi-deep-settings-");
		globalTmp = makeTempDir("pi-deep-settings-global-");
		setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
			delete savedEnv[k];
		}
		setGlobalSettingsPath(null);
		clearSettingsCache();
		rmSync(tmp, { recursive: true, force: true });
		rmSync(globalTmp, { recursive: true, force: true });
	});

	it("validates and resolves defaults for all keys in settings-keys.json without drift", () => {
		const keys = Object.keys(SETTINGS_KEYS);
		assert.ok(keys.length >= 72, `expected >=72 keys, got ${keys.length}`);
		for (const key of keys) {
			const def = SETTINGS_KEYS[key];
			const check = validateSetting(key, def.default);
			assert.equal(check.ok, true, `default for ${key} must validate cleanly`);
			// Clear any env var that could override the default
			if (def.env) setEnv(def.env, undefined);
			assert.deepEqual(getSettingDynamic(tmp, key), def.default, `default mismatch for ${key}`);
		}
	});

	it("enforces enum constraints consistently across file read, env, validateSetting, and parseSettingInput", () => {
		const projectFile = join(tmp, ".pi", "pi-config-settings.json");
		const globalFile = join(globalTmp, "pi-config-settings.json");
		mkdirSync(join(tmp, ".pi"), { recursive: true });

		// Invalid enum in project falls through to valid global value
		writeFileSync(projectFile, JSON.stringify({ widgets_default_mode: "floating", log_coms: "loud" }));
		writeFileSync(globalFile, JSON.stringify({ widgets_default_mode: "collapsed", log_coms: "warn" }));
		clearSettingsCache();

		assert.equal(parseSettingsFile(projectFile).widgets_default_mode, undefined);
		assert.equal(parseSettingsFile(projectFile).log_coms, undefined);
		assert.equal(getSetting(tmp, "widgets_default_mode"), "collapsed");
		assert.equal(getSetting(tmp, "log_coms"), "warn");
		assert.equal(detectSource("widgets_default_mode", SETTINGS_KEYS.widgets_default_mode, tmp), "G");

		// Invalid enum in env falls through to default
		rmSync(projectFile);
		rmSync(globalFile);
		clearSettingsCache();
		setEnv("PI_WIDGETS_DEFAULT_MODE", "bogus");
		setEnv("PI_LOG_COMS", "verbose");
		assert.equal(getSetting(tmp, "widgets_default_mode"), "expanded");
		assert.equal(getSetting(tmp, "log_coms"), "info");
		assert.equal(detectSource("widgets_default_mode", SETTINGS_KEYS.widgets_default_mode, tmp), "D");

		// validateSetting and parseSettingInput reject invalid enums and empty strings for enum keys
		assert.equal(validateSetting("widgets_default_mode", "floating").ok, false);
		assert.equal(validateSetting("widgets_default_mode", "").ok, false);
		assert.equal(validateSetting("log_coms", "loud").ok, false);
		assert.equal(validateSetting("log_coms", "").ok, false);
		assert.equal(parseSettingInput("widgets_default_mode", "floating").ok, false);
		assert.equal(parseSettingInput("log_coms", "(empty)").ok, false);
		assert.deepEqual(parseSettingInput("widgets_default_mode", "collapsed"), { ok: true, value: "collapsed" });
	});

	it("enforces min/max/strict_digits/port consistently across read, env, and TUI input", () => {
		// Out-of-range int rejected by parseSettingInput and validateSetting
		assert.equal(validateSetting("review_loop_max_cycles", 0).ok, false);
		assert.equal(validateSetting("review_loop_max_cycles", 11).ok, false);
		assert.equal(parseSettingInput("review_loop_max_cycles", "0").ok, false);
		assert.equal(parseSettingInput("review_loop_max_cycles", "11").ok, false);
		assert.equal(parseSettingInput("review_loop_max_cycles", "01").ok, false);
		assert.equal(parseSettingInput("pidash_port", "0").ok, false);
		assert.equal(parseSettingInput("pidash_port", "70000").ok, false);
		assert.deepEqual(parseSettingInput("pidash_port", "19191"), { ok: true, value: 19191 });
		assert.deepEqual(parseSettingInput("pidash_port", ""), { ok: true, value: undefined });

		// Out-of-range env var falls through to default
		setEnv("PI_SYNC_AGENT_MAX_SECONDS", "9999");
		assert.equal(getSetting(tmp, "sync_agent_max_seconds"), 60);
		setEnv("PI_SYNC_AGENT_MAX_SECONDS", "120");
		assert.equal(getSetting(tmp, "sync_agent_max_seconds"), 120);
	});

	it("preserves empty strings consistently for non-enum string settings", () => {
		// Global sets a shortcut; project explicitly clears it with ""
		const globalFile = join(globalTmp, "pi-config-settings.json");
		writeFileSync(globalFile, JSON.stringify({ widget_tasks_shortcut: "alt+x", internal_operations_model: "gemini-2.5-flash" }));
		clearSettingsCache();

		assert.deepEqual(validateSetting("widget_tasks_shortcut", ""), { ok: true, value: "" });
		assert.deepEqual(validateSetting("internal_operations_model", ""), { ok: true, value: "" });
		assert.deepEqual(parseSettingInput("widget_tasks_shortcut", "(empty)"), { ok: true, value: "" });

		const res = updateSetting(tmp, "project", "widget_tasks_shortcut", "");
		assert.equal(res.ok, true);
		// Cache auto-invalidated by updateSetting — no manual clearSettingsCache needed
		assert.equal(getSetting(tmp, "widget_tasks_shortcut"), "");
		assert.equal(resolveSetting(tmp, "widget_tasks_shortcut")?.source, "P");
	});

	it("updateSetting performs validated atomic write, preserves unknown keys, rotates backups, and auto-clears cache", () => {
		const projectFile = join(tmp, ".pi", "pi-config-settings.json");
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(projectFile, JSON.stringify({ custom_future_key: "keep", dco: false }));
		clearSettingsCache();
		assert.equal(getSetting(tmp, "dco"), false);

		// Invalid value is refused before touching disk
		const bad = updateSetting(tmp, "project", "review_loop_max_cycles", 99);
		assert.equal(bad.ok, false);
		assert.equal(bad.reason, "invalid");
		assert.equal(existsSync(settingsBackupPath(projectFile, 1)), false);

		// Valid write rotates backup, preserves unknown keys, and immediately updates getSetting cache
		const ok = updateSetting(tmp, "project", "dco", true);
		assert.equal(ok.ok, true);
		assert.equal(getSetting(tmp, "dco"), true);
		assert.deepEqual(JSON.parse(readFileSync(settingsBackupPath(projectFile, 1), "utf-8")), {
			custom_future_key: "keep",
			dco: false,
		});
		assert.deepEqual(JSON.parse(readFileSync(projectFile, "utf-8")), {
			custom_future_key: "keep",
			dco: true,
		});

		// Corrupt file refuses write and leaves bytes untouched
		writeFileSync(projectFile, "{ broken");
		const corrupt = updateSetting(tmp, "project", "dco", false);
		assert.equal(corrupt.ok, false);
		assert.equal(corrupt.reason, "corrupt");
		assert.equal(readFileSync(projectFile, "utf-8"), "{ broken");
	});

	it("does not emit bypass debug logs on hot getSetting or parseSettingInput calls", () => {
		const debugMessages: string[] = [];
		setSettingsLogger({
			debug: (msg) => debugMessages.push(msg),
			info: () => {},
			warn: () => {},
			error: () => {},
		});
		try {
			getSetting(tmp, "dco");
			getSettingDynamic(tmp, "log_coms");
			parseSettingInput("dangerous_command_allowlist", '["git status"]');
			assert.deepEqual(debugMessages, [], "hot lookups must not spam the bypass logger");

			// Opt-in audit mode (used by file-logger's 30s-cached resolveMinLevel) still emits diagnostics
			resolveSetting(tmp, "log_coms", { audit: true });
			assert.deepEqual(debugMessages, ["resolved setting"]);
		} finally {
			setSettingsLogger({});
		}
	});

	it("shares a single repo-root resolver with utils.ts even when git fails on a fake .git layout", () => {
		const fakeRepo = makeTempDir("pi-fake-repo-");
		const nested = join(fakeRepo, "a", "b");
		try {
			mkdirSync(join(fakeRepo, ".git"), { recursive: true });
			mkdirSync(nested, { recursive: true });
			assert.equal(resolveMainCheckoutRoot(nested), fakeRepo);
			assert.equal(utilsResolveRepoRoot(nested), fakeRepo);
			assert.equal(getSettingsPath(nested), join(fakeRepo, ".pi", "pi-config-settings.json"));
		} finally {
			rmSync(fakeRepo, { recursive: true, force: true });
		}
	});

	it("readSettingsObject returns the full raw JSON object and degrades to {} on null, missing, or corrupt files", () => {
		assert.deepEqual(readSettingsObject(null), {});
		const missing = join(tmp, ".pi", "missing.json");
		assert.deepEqual(readSettingsObject(missing), {});

		mkdirSync(join(tmp, ".pi"), { recursive: true });
		const file = join(tmp, ".pi", "pi-config-settings.json");
		writeFileSync(file, JSON.stringify({ project_tmp_max_size: "4G", extra_unknown_key: 123 }));
		assert.deepEqual(readSettingsObject(file), { project_tmp_max_size: "4G", extra_unknown_key: 123 });

		writeFileSync(file, "{ invalid json");
		assert.deepEqual(readSettingsObject(file), {});
	});
});
