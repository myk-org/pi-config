/**
 * Coms settings resolution via project-settings.
 *
 * process.cwd() usage in coms is intentional for global settings; these
 * tests prove the coms timeout keys resolve correctly through getSetting
 * (project cwd / empty project → defaults).
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

describe("coms settings cwd resolution", () => {
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
});
