/**
 * Pidiff stale-lock detection pieces.
 *
 * Stale-lock handling lives inline inside registerPidiff → connect() in
 * extensions/pidiff/pidiff.ts (not exported). These tests cover the
 * unit-testable fragments: dead-PID detection via process.kill(pid, 0)
 * and lockfile age via mtimeMs.
 *
 * Run with: npx tsx --test tests/node/pidiff/stale-lock.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";

describe("pidiff stale lock detection", () => {
	let tmpDir: string | undefined;

	afterEach(() => {
		if (tmpDir) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			tmpDir = undefined;
		}
	});

	it("stale lockfile with dead PID should be detectable", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pidiff-lock-"));
		const lockPath = join(tmpDir, "pidiff.spawning");
		// Write a lockfile with a PID that doesn't exist (99999999)
		writeFileSync(lockPath, "99999999");

		const spawnerPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
		assert.equal(spawnerPid, 99999999);

		// Verify the PID is dead (same check as connect() stale-lock path)
		let isAlive = false;
		try {
			process.kill(spawnerPid, 0);
			isAlive = true;
		} catch {
			isAlive = false;
		}
		assert.equal(isAlive, false, "PID 99999999 should not be alive");
	});

	it("lockfile age calculation works correctly", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pidiff-lock-age-"));
		const lockPath = join(tmpDir, "pidiff.spawning");
		const beforeWrite = Date.now();
		writeFileSync(lockPath, String(process.pid));

		const mtime = statSync(lockPath).mtimeMs;
		const lockAge = Date.now() - mtime;
		// mtime should be between beforeWrite and now (no timing threshold)
		assert.ok(mtime >= beforeWrite - 1000, `mtime should be >= beforeWrite - 1s`);
		assert.ok(lockAge >= 0, `Lock age should be >= 0, got ${lockAge}`);
	});
});
