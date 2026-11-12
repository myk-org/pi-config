/**
 * One settings filename — `pi-config-settings.json` — plus the one-time migration away from
 * the legacy `.jsonc` file (issue #1086). The legacy file used to win over `.json`, silently
 * hiding settings written to `.json`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	LEGACY_SETTINGS_FILENAME,
	SETTINGS_FILENAMES,
	findSettingsFile,
	migrateLegacySettingsFile,
	readLegacySettings,
	setPublishSettingsFileForTests,
	setSettingsSourceLogger,
} from "../../../extensions/orchestrator/settings-source.js";
import { SettingsFileCorruptError, writeSettingsFile } from "../../../extensions/orchestrator/settings-tui-helpers.js";
import { getSettingsPath } from "../../../extensions/orchestrator/project-settings.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const JSON_NAME = "pi-config-settings.json";
const MIGRATED_NAME = `${LEGACY_SETTINGS_FILENAME}.migrated`;

/** Every warning the settings source emits while `body` runs. */
function captureWarnings(body: () => void): string[] {
	const messages: string[] = [];
	setSettingsSourceLogger({ debug: () => {}, warn: (message) => messages.push(message) });
	try {
		body();
	} finally {
		setSettingsSourceLogger({ debug: () => {}, warn: () => {} });
	}
	return messages;
}

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

	it("does not report corruption when the legacy file vanishes between the check and the read", () => {
		const legacy = join(piDir, LEGACY_SETTINGS_FILENAME);
		writeFileSync(legacy, JSON.stringify({ dco: true }));
		rmSync(legacy); // the racing process renamed it away after migrateLegacySettingsFile's existsSync

		const warnings = captureWarnings(() => {
			assert.equal(readLegacySettings(legacy), null, "a vanished file is nothing to migrate");
			assert.doesNotThrow(() => migrateLegacySettingsFile(piDir));
		});

		assert.deepEqual(warnings, [], "no corrupt warning, and 'migrated' is not logged twice");
		assert.equal(existsSync(join(piDir, JSON_NAME)), false, "nothing is written for a gone legacy file");
	});

	it("reports a legacy file that is there but unparseable as corrupt", () => {
		writeFileSync(join(piDir, LEGACY_SETTINGS_FILENAME), '{ "dco": tru');

		assert.deepEqual(captureWarnings(() => migrateLegacySettingsFile(piDir)), [
			"settings_legacy_jsonc_corrupt",
		]);
	});

	it("reports a non-ENOENT read error as corrupt, not as an already-migrated file", () => {
		const other = join(root, "read-error");
		mkdirSync(join(other, LEGACY_SETTINGS_FILENAME), { recursive: true }); // a directory: read gives EISDIR

		assert.deepEqual(captureWarnings(() => migrateLegacySettingsFile(other)), [
			"settings_legacy_jsonc_corrupt",
		]);
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

	it("runs the tracked-file git check once per directory, however often settings are resolved", () => {
		const legacy = join(piDir, LEGACY_SETTINGS_FILENAME);
		writeFileSync(legacy, JSON.stringify({ dco: true }));
		execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["add", "-f", join(".pi", LEGACY_SETTINGS_FILENAME)], { cwd: root, stdio: "ignore" });

		// A `git` first on PATH that records each call and delegates: settings resolution runs on
		// nearly every tool call, so a tracked legacy file must cost exactly one subprocess.
		const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		const shimDir = makeTempDir("settings-filename-git-");
		const calls = join(shimDir, "calls");
		writeFileSync(
			join(shimDir, "git"),
			`#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
			{ mode: 0o755 },
		);
		const savedPath = process.env.PATH;
		process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
		try {
			const warnings = captureWarnings(() => {
				for (let i = 0; i < 4; i++) assert.equal(findSettingsFile(piDir), null);
			});

			assert.deepEqual(warnings, ["settings_legacy_jsonc_tracked_refused"], "the refusal is still reported once");
			assert.equal(
				readFileSync(calls, "utf8").trim().split("\n").length,
				1,
				"one git subprocess per directory, not one per resolution",
			);
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
		}
	});

	it("refuses a TRACKED legacy file in a PROJECT dir (the default scope): no untracked .json copy, no rename", () => {
		const legacy = join(piDir, LEGACY_SETTINGS_FILENAME);
		const bytes = JSON.stringify({ dangerous_command_allowlist: ["*"] });
		writeFileSync(legacy, bytes);
		// A real repo: a clone ships this file, so migrating it would launder it into a NEW
		// untracked `.json` — the exact file `projectSettingsTrust` withholds its trust from.
		execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["add", "-f", join(".pi", LEGACY_SETTINGS_FILENAME)], { cwd: root, stdio: "ignore" });

		const warnings = captureWarnings(() => assert.equal(findSettingsFile(piDir), null));

		assert.equal(existsSync(join(piDir, JSON_NAME)), false, "no .json earns trust the repo shipped with");
		assert.equal(readFileSync(legacy, "utf-8"), bytes, "the legacy file is untouched");
		assert.equal(existsSync(join(piDir, MIGRATED_NAME)), false, "and nothing was renamed");
		assert.deepEqual(warnings, ["settings_legacy_jsonc_tracked_refused"]);
	});

	it("migrates a TRACKED legacy file in a GLOBAL dir: a dotfiles-managed ~/.pi is not an attack", () => {
		const legacy = join(piDir, LEGACY_SETTINGS_FILENAME);
		writeFileSync(legacy, JSON.stringify({ dco: true }));
		execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["add", "-f", join(".pi", LEGACY_SETTINGS_FILENAME)], { cwd: root, stdio: "ignore" });

		const warnings = captureWarnings(() =>
			assert.equal(findSettingsFile(piDir, { scope: "global" }), join(piDir, JSON_NAME)),
		);

		assert.deepEqual(JSON.parse(readFileSync(join(piDir, JSON_NAME), "utf-8")), { dco: true });
		assert.equal(existsSync(legacy), false, "the legacy file is moved aside");
		assert.ok(existsSync(join(piDir, MIGRATED_NAME)));
		assert.deepEqual(warnings, ["settings_legacy_jsonc_migrated"]);
	});

	it("strands nothing when the publish is DENIED: no target, so the legacy file stays exactly where it is", () => {
		const legacy = join(piDir, LEGACY_SETTINGS_FILENAME);
		const bytes = JSON.stringify({ dco: true });
		writeFileSync(legacy, bytes);
		// Windows hands back EPERM for a rename it refused, indistinguishable by code from a racer.
		setPublishSettingsFileForTests(() => {
			throw Object.assign(new Error("denied"), { code: "EPERM" });
		});
		try {
			const warnings = captureWarnings(() => migrateLegacySettingsFile(piDir));

			assert.equal(existsSync(join(piDir, JSON_NAME)), false, "no .json appeared");
			assert.equal(readFileSync(legacy, "utf8"), bytes, "the settings are still readable where the user left them");
			assert.equal(existsSync(join(piDir, MIGRATED_NAME)), false, "nothing is renamed away from a missing target");
			assert.deepEqual(warnings, ["settings_legacy_jsonc_migrate_failed"]);
		} finally {
			setPublishSettingsFileForTests(null);
		}
	});

	it("treats a publish error with a VALID target as another process's win: the legacy file is renamed", () => {
		const legacy = join(piDir, LEGACY_SETTINGS_FILENAME);
		writeFileSync(legacy, JSON.stringify({ dco: false }));
		setPublishSettingsFileForTests((_from, to) => {
			writeFileSync(to, `${JSON.stringify({ dco: true }, null, 2)}\n`); // the racer published first
			throw Object.assign(new Error("denied"), { code: "EPERM" });
		});
		try {
			const warnings = captureWarnings(() => migrateLegacySettingsFile(piDir));

			assert.deepEqual(warnings, ["settings_legacy_jsonc_migrated"], "not reported as a failure");
			assert.deepEqual(JSON.parse(readFileSync(join(piDir, JSON_NAME), "utf8")), { dco: true }, "the racer's content is kept");
			assert.equal(existsSync(legacy), false, "the readable target makes the rename safe");
			assert.ok(existsSync(join(piDir, MIGRATED_NAME)));
		} finally {
			setPublishSettingsFileForTests(null);
		}
	});

	it("migrates a GLOBAL dir reached through a symlinked parent: ~/.pi -> dotfiles/.pi is that layout", () => {
		const realGlobal = makeTempDir("settings-filename-global-");
		const legacy = join(realGlobal, LEGACY_SETTINGS_FILENAME);
		writeFileSync(legacy, JSON.stringify({ dco: true }));
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		const linked = join(home, ".pi");
		symlinkSync(realGlobal, linked);

		captureWarnings(() => assert.equal(findSettingsFile(linked, { scope: "global" }), join(linked, JSON_NAME)));

		assert.deepEqual(JSON.parse(readFileSync(join(realGlobal, JSON_NAME), "utf-8")), { dco: true });
		assert.equal(existsSync(legacy), false, "the legacy file in the linked-to dir is moved aside");
	});

	it("refuses a SYMLINKED legacy file in BOTH scopes: nothing outside the settings dir is copied in", () => {
		const scopes = ["project", "global"] as const;
		for (const scope of scopes) {
			const dir = scope === "project" ? piDir : makeTempDir("settings-filename-global-");
			const outside = makeTempDir("settings-filename-outside-");
			const source = join(outside, LEGACY_SETTINGS_FILENAME);
			writeFileSync(source, JSON.stringify({ dangerous_command_allowlist: ["*"] }));
			const legacy = join(dir, LEGACY_SETTINGS_FILENAME);
			symlinkSync(source, legacy);

			const warnings = captureWarnings(() => assert.equal(findSettingsFile(dir, { scope }), null));

			assert.equal(existsSync(join(dir, JSON_NAME)), false, `[${scope}] no real file is created from the link target`);
			assert.ok(lstatSync(legacy).isSymbolicLink(), `[${scope}] the link itself is untouched`);
			assert.ok(existsSync(source), `[${scope}] the target is untouched`);
			assert.deepEqual(warnings, ["settings_legacy_jsonc_symlink_refused"], `[${scope}] refused, not followed`);
		}
	});

	it("does not migrate through a .pi symlink that points outside the temp tree", () => {
		// Lexical check would accept the fixture path while the write landed outside the sandbox.
		const outside = `/var/tmp/pi-config-legacy-${process.pid}-${Date.now()}`;
		mkdirSync(outside, { recursive: true });
		const legacy = join(outside, LEGACY_SETTINGS_FILENAME);
		writeFileSync(legacy, JSON.stringify({ dco: true }));
		const fixture = join(root, "linked-fixture");
		mkdirSync(fixture, { recursive: true });
		symlinkSync(outside, join(fixture, ".pi"));

		const saved = process.env.NODE_TEST_CONTEXT;
		process.env.NODE_TEST_CONTEXT = "1";
		try {
			migrateLegacySettingsFile(join(fixture, ".pi"));
			assert.equal(existsSync(join(outside, JSON_NAME)), false, "nothing written outside the temp tree");
			assert.equal(existsSync(join(outside, MIGRATED_NAME)), false, "nothing renamed there either");
			assert.ok(existsSync(legacy));
		} finally {
			if (saved === undefined) delete process.env.NODE_TEST_CONTEXT;
			else process.env.NODE_TEST_CONTEXT = saved;
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("logs a corrupt legacy file once, however often settings are resolved", () => {
		writeFileSync(join(piDir, LEGACY_SETTINGS_FILENAME), '{ "dco": tru');

		const warnings = captureWarnings(() => {
			findSettingsFile(piDir);
			findSettingsFile(piDir);
		});

		assert.deepEqual(warnings, ["settings_legacy_jsonc_corrupt"], "resolution runs on every tool call");
	});

	it("refuses settings writes while a corrupt legacy file waits to be repaired", () => {
		const legacy = join(piDir, LEGACY_SETTINGS_FILENAME);
		writeFileSync(legacy, '{ "dco": tru');

		assert.throws(
			() => writeSettingsFile(join(piDir, JSON_NAME), { dco: true }),
			SettingsFileCorruptError,
			"bypassing the legacy would make it 'ignored' and lose the user's settings",
		);
		assert.equal(existsSync(join(piDir, JSON_NAME)), false, "no fresh .json shadows the legacy file");

		writeFileSync(legacy, JSON.stringify({ dco: true })); // the human repairs it
		assert.equal(findSettingsFile(piDir), join(piDir, JSON_NAME));
		assert.deepEqual(JSON.parse(readFileSync(join(piDir, JSON_NAME), "utf-8")), { dco: true });
		assert.equal(existsSync(legacy), false, "and it is migrated, not ignored");
	});
});
