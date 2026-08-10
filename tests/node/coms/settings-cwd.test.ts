/**
 * Coms settings resolution via project-settings.
 *
 * Tests prove coms timeout keys resolve correctly through getSetting
 * from a provided cwd (project settings / empty project → defaults).
 *
 * Run with: npx tsx --test tests/node/coms/settings-cwd.test.ts
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

describe("coms settings configurability", () => {
	let tmpDir: string;
	let globalTmp: string;

	beforeEach(() => {
		clearSettingsCache();
		tmpDir = mkdtempSync(join(tmpdir(), "coms-settings-"));
		globalTmp = mkdtempSync(join(tmpdir(), "coms-settings-global-"));
		setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
	});

	afterEach(() => {
		setGlobalSettingsPath(null);
		clearSettingsCache();
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(globalTmp, { recursive: true, force: true });
	});

	it("coms_entry_grace_period_ms is configurable", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "pi-config-settings.json"),
			JSON.stringify({ coms_entry_grace_period_ms: 60000 }),
			"utf-8",
		);
		clearSettingsCache();
		assert.equal(getSetting(tmpDir, "coms_entry_grace_period_ms"), 60000);
	});

	it("coms_probe_timeout_ms defaults to 1000", () => {
		clearSettingsCache();
		assert.equal(getSetting(tmpDir, "coms_probe_timeout_ms"), 1000);
	});

	it("coms settings resolve from provided cwd, not process.cwd()", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "pi-config-settings.json"),
			JSON.stringify({ coms_entry_grace_period_ms: 99999 }),
			"utf-8",
		);
		clearSettingsCache();
		// Verify settings resolve from the specified cwd, not process.cwd()
		assert.equal(getSetting(tmpDir, "coms_entry_grace_period_ms"), 99999);
	});

	it("coms_entry_grace_period_ms does not bleed to other cwds", () => {
		// tmpDir has custom setting from previous test — verify process.cwd() is independent
		clearSettingsCache();
		assert.notEqual(getSetting(process.cwd(), "coms_entry_grace_period_ms"), 99999);
	});

	it("coms_probe_timeout_ms resolves per-cwd", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "pi-config-settings.json"),
			JSON.stringify({ coms_probe_timeout_ms: 5000 }),
			"utf-8",
		);
		clearSettingsCache();
		// Custom cwd returns configured value
		assert.equal(getSetting(tmpDir, "coms_probe_timeout_ms"), 5000);
	});

	it("coms_probe_timeout_ms does not bleed to other cwds", () => {
		clearSettingsCache();
		assert.notEqual(getSetting(process.cwd(), "coms_probe_timeout_ms"), 5000);
	});
});
