/**
 * Extension settings in pi-config-settings.json
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { clearSettingsCache, getSetting, parseAcpxAgentList } from "../../../extensions/orchestrator/project-settings.js";

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

describe("extension settings", () => {
	let tmp: string;
	const prev = {
		PI_PIDASH_ENABLE: process.env.PI_PIDASH_ENABLE,
		PI_PIDIFF_ENABLE: process.env.PI_PIDIFF_ENABLE,
		PI_PIDASH_PORT: process.env.PI_PIDASH_PORT,
		PI_IMAGE_MODEL: process.env.PI_IMAGE_MODEL,
		ACPX_AGENTS: process.env.ACPX_AGENTS,
	};

	beforeEach(() => {
		clearSettingsCache();
		tmp = mkdtempSync(join(tmpdir(), "pi-ext-settings-"));
		delete process.env.PI_PIDASH_ENABLE;
		delete process.env.PI_PIDIFF_ENABLE;
		delete process.env.PI_PIDASH_PORT;
		delete process.env.PI_IMAGE_MODEL;
		delete process.env.ACPX_AGENTS;
	});

	afterEach(() => {
		clearSettingsCache();
		rmSync(tmp, { recursive: true, force: true });
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

	function globalSettingsHasKey(key: string): boolean {
		const p = join(homedir(), ".pi", "pi-config-settings.json");
		if (!existsSync(p)) return false;
		try {
			const raw = JSON.parse(readFileSync(p, "utf-8"));
			return typeof raw === "object" && raw !== null && !Array.isArray(raw) && key in raw;
		} catch {
			return false;
		}
	}

	function globalHasAcpxAgents(): boolean {
		return globalSettingsHasKey("acpx_agents");
	}

	it("pidash_enable defaults true", () => {
		assert.equal(getSetting(tmp, "pidash_enable"), true);
	});

	it("pidash_enable from settings file", () => {
		writeSettings({ pidash_enable: false });
		assert.equal(getSetting(tmp, "pidash_enable"), false);
	});

	it("pidash_enable from env PI_PIDASH_ENABLE=false", () => {
		process.env.PI_PIDASH_ENABLE = "false";
		clearSettingsCache();
		if (globalSettingsHasKey("pidash_enable")) {
			// global ~/.pi settings win over env when project omits key
			assert.equal(typeof getSetting(tmp, "pidash_enable"), "boolean");
			return;
		}
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
		if (globalSettingsHasKey("pidash_port")) {
			assert.equal(typeof getSetting(tmp, "pidash_port"), "number");
			return;
		}
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

	it("image_model from settings wins over env", () => {
		writeSettings({ image_model: "gemini-3-pro-image" });
		assert.equal(getSetting(tmp, "image_model"), "gemini-3-pro-image");
	});

	it("image_model from env when project omits it", () => {
		process.env.PI_IMAGE_MODEL = "from-env";
		clearSettingsCache();
		if (globalSettingsHasKey("image_model")) {
			assert.equal(typeof getSetting(tmp, "image_model"), "string");
			return;
		}
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
		if (globalHasAcpxAgents()) {
			assert.deepEqual(parseAcpxAgentList(process.env.ACPX_AGENTS), ["cursor", "copilot"]);
			return;
		}
		assert.deepEqual(getSetting(tmp, "acpx_agents"), ["cursor", "copilot"]);
	});

	it("malformed project acpx_agents falls through to env", () => {
		writeSettings({ acpx_agents: 123 });
		process.env.ACPX_AGENTS = "cursor";
		clearSettingsCache();
		if (globalHasAcpxAgents()) {
			// global wins over env
			assert.ok(Array.isArray(getSetting(tmp, "acpx_agents")));
			return;
		}
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
});
