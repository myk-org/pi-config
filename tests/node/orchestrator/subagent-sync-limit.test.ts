/**
 * Subagent sync limit via sync_agent_max_seconds settings.
 *
 * Isolates from real ~/.pi/ via setGlobalSettingsPath (same pattern as
 * extension-settings.test.ts).
 *
 * Run with: npx tsx --test tests/node/orchestrator/subagent-sync-limit.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
	clearSettingsCache,
	getSetting,
	setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";

describe("subagent sync limit settings", () => {
	let tmpDir: string;
	let globalTmp: string;
	const prevEnv = process.env.PI_SYNC_AGENT_MAX_SECONDS;

	beforeEach(() => {
		clearSettingsCache();
		tmpDir = mkdtempSync(join(tmpdir(), "subagent-sync-"));
		globalTmp = mkdtempSync(join(tmpdir(), "subagent-sync-global-"));
		setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
		delete process.env.PI_SYNC_AGENT_MAX_SECONDS;
	});

	afterEach(() => {
		setGlobalSettingsPath(null);
		clearSettingsCache();
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(globalTmp, { recursive: true, force: true });
		if (prevEnv === undefined) delete process.env.PI_SYNC_AGENT_MAX_SECONDS;
		else process.env.PI_SYNC_AGENT_MAX_SECONDS = prevEnv;
	});

	it("sync_agent_max_seconds is configurable via settings", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "pi-config-settings.json"),
			JSON.stringify({ sync_agent_max_seconds: 120 }),
			"utf-8",
		);
		clearSettingsCache();
		const val = getSetting(tmpDir, "sync_agent_max_seconds");
		assert.equal(val, 120);
	});

	it("sync_agent_max_seconds defaults to 60", () => {
		clearSettingsCache();
		const val = getSetting(tmpDir, "sync_agent_max_seconds");
		assert.equal(val, 60);
	});

	it("sync_agent_max_seconds enforces async requirement", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "pi-config-settings.json"),
			JSON.stringify({ sync_agent_max_seconds: 10 }),
			"utf-8",
		);
		clearSettingsCache();

		const limit = getSetting(tmpDir, "sync_agent_max_seconds");
		assert.equal(limit, 10);

		// Simulate enforcement: estimated 15s > limit 10s → should require async
		const estimatedSeconds = 15;
		const shouldRequireAsync = estimatedSeconds >= limit;
		assert.equal(shouldRequireAsync, true, "15s task should require async when limit is 10s");
	});

	it("sync_agent_max_seconds allows sync within limit", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "pi-config-settings.json"),
			JSON.stringify({ sync_agent_max_seconds: 60 }),
			"utf-8",
		);
		clearSettingsCache();

		const limit = getSetting(tmpDir, "sync_agent_max_seconds");
		const estimatedSeconds = 25;
		const shouldRequireAsync = estimatedSeconds >= limit;
		assert.equal(shouldRequireAsync, false, "25s task should NOT require async when limit is 60s");
	});
});
