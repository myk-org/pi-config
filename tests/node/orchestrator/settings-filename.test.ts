/**
 * One settings filename — `pi-config-settings.json` — plus the one-time migration away from
 * the legacy `.jsonc` file (issue #1086). The legacy file used to win over `.json`, silently
 * hiding settings written to `.json`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	LEGACY_SETTINGS_FILENAME,
	SETTINGS_FILENAMES,
	findSettingsFile,
	migrateLegacySettingsFile,
} from "../../../extensions/orchestrator/settings-source.js";
import { getSettingsPath } from "../../../extensions/orchestrator/project-settings.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const JSON_NAME = "pi-config-settings.json";
const MIGRATED_NAME = `${LEGACY_SETTINGS_FILENAME}.migrated`;

describe("single settings filename", () => {
	let root: string;
	let piDir: string;

	beforeEach(() => {
		root = makeTempDir("settings-filename-");
		mkdirSync(join(root, ".git"), { recursive: true });
		piDir = join(root, ".pi");
		mkdirSync(piDir, { recursive: true });
	});

	it("is the only filename, and resolution returns the .json path while a .jsonc exists", () => {
		assert.deepEqual(SETTINGS_FILENAMES, [JSON_NAME]);
		writeFileSync(join(piDir, LEGACY_SETTINGS_FILENAME), JSON.stringify({ dco: true }));
		assert.equal(getSettingsPath(root), join(piDir, JSON_NAME));
		assert.equal(findSettingsFile(piDir), join(piDir, JSON_NAME));
	});

	it("migrates a legacy .jsonc once: content preserved, legacy renamed aside", () => {
		const legacy = join(piDir, LEGACY_SETTINGS_FILENAME);
		writeFileSync(
			legacy,
			`{
  // project comment
  "dco": true, // trailing comment
  "dangerous_command_allowlist": ["bash .dev/deploy-all.sh"]
}
`,
		);

		assert.equal(findSettingsFile(piDir), join(piDir, JSON_NAME));

		const migrated = JSON.parse(readFileSync(join(piDir, JSON_NAME), "utf-8"));
		assert.deepEqual(migrated, {
			dco: true,
			dangerous_command_allowlist: ["bash .dev/deploy-all.sh"],
		});
		assert.equal(existsSync(legacy), false, "legacy file cannot shadow the .json again");
		assert.ok(existsSync(join(piDir, MIGRATED_NAME)), "legacy bytes are kept, not deleted");
		assert.ok(readFileSync(join(piDir, MIGRATED_NAME), "utf-8").includes("project comment"));
	});

	it("touches neither file when the .json already exists", () => {
		const legacy = join(piDir, LEGACY_SETTINGS_FILENAME);
		const target = join(piDir, JSON_NAME);
		const legacyBytes = JSON.stringify({ dco: false });
		const targetBytes = JSON.stringify({ dco: true });
		writeFileSync(legacy, legacyBytes);
		writeFileSync(target, targetBytes);

		migrateLegacySettingsFile(piDir);

		assert.equal(readFileSync(legacy, "utf-8"), legacyBytes);
		assert.equal(readFileSync(target, "utf-8"), targetBytes);
		assert.equal(existsSync(join(piDir, MIGRATED_NAME)), false);
	});

	it("refuses a corrupt legacy file: nothing written, nothing renamed", () => {
		const legacy = join(piDir, LEGACY_SETTINGS_FILENAME);
		const corrupt = '{ "dco": tru';
		writeFileSync(legacy, corrupt);

		assert.equal(findSettingsFile(piDir), null, "nothing is read from the legacy file");
		assert.equal(existsSync(join(piDir, JSON_NAME)), false, "no .json is written");
		assert.equal(readFileSync(legacy, "utf-8"), corrupt, "bytes are exactly as they were");
		assert.equal(existsSync(join(piDir, MIGRATED_NAME)), false);
	});

	it("is idempotent: a second call with the legacy gone is a no-op", () => {
		writeFileSync(join(piDir, LEGACY_SETTINGS_FILENAME), JSON.stringify({ dco: true }));
		findSettingsFile(piDir);
		const targetBytes = readFileSync(join(piDir, JSON_NAME), "utf-8");

		migrateLegacySettingsFile(piDir);

		assert.equal(readFileSync(join(piDir, JSON_NAME), "utf-8"), targetBytes);
		assert.ok(existsSync(join(piDir, MIGRATED_NAME)));
		assert.equal(existsSync(join(piDir, `${MIGRATED_NAME}.migrated`)), false, "migrated only once");
	});
});
