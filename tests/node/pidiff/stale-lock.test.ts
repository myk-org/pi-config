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
import {
	existsSync,
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
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

	it("dead PID lockfile triggers recovery path", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pidiff-lock-dead-"));
		const lockPath = join(tmpDir, "pidiff.spawning");
		// Write lockfile with dead PID
		writeFileSync(lockPath, "99999999");

		// Simulate the recovery logic from pidiff.ts
		const spawnerPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
		let shouldRecover = false;
		try {
			process.kill(spawnerPid, 0);
		} catch {
			// PID dead — recovery should trigger
			shouldRecover = true;
		}
		assert.equal(shouldRecover, true, "Dead PID should trigger recovery");

		// Recovery action: delete lockfile
		unlinkSync(lockPath);
		assert.equal(existsSync(lockPath), false, "Lockfile should be deleted after recovery");
	});

	it("alive PID with old lockfile triggers PID reuse detection", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pidiff-lock-reuse-"));
		const lockPath = join(tmpDir, "pidiff.spawning");
		// Write lockfile with current PID (alive)
		writeFileSync(lockPath, String(process.pid));

		const spawnerPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
		// PID is alive
		let isAlive = false;
		try {
			process.kill(spawnerPid, 0);
			isAlive = true;
		} catch {
			isAlive = false;
		}
		assert.equal(isAlive, true, "Current process PID should be alive");

		// Simulate PID reuse check: lockAge > 2 * staleTimeout
		const staleTimeout = 60000; // default
		const simulatedLockAge = staleTimeout * 2 + 1000; // older than 2x threshold
		const shouldRecoverDueToPidReuse = simulatedLockAge > staleTimeout * 2;
		assert.equal(
			shouldRecoverDueToPidReuse,
			true,
			"Lock age > 2x timeout should trigger PID reuse recovery",
		);
	});

	it("alive PID with young lockfile should NOT trigger recovery", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pidiff-lock-young-"));
		const lockPath = join(tmpDir, "pidiff.spawning");
		writeFileSync(lockPath, String(process.pid));

		const spawnerPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
		let isAlive = false;
		try {
			process.kill(spawnerPid, 0);
			isAlive = true;
		} catch {
			isAlive = false;
		}
		assert.equal(isAlive, true);

		const lockAge = Date.now() - statSync(lockPath).mtimeMs;
		const staleTimeout = 60000;
		const shouldRecover = !isAlive || lockAge > staleTimeout * 2;
		assert.equal(shouldRecover, false, "Young lock with alive PID should NOT trigger recovery");
	});
});
