import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as net from "node:net";
import { describe, it, afterEach } from "node:test";
import { probeStaleSocket } from "../../../extensions/coms/coms-registry.js";
import { clearSettingsCache } from "../../../extensions/orchestrator/project-settings.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

describe("probeStaleSocket", () => {
	let tmpDir: string | undefined;
	let server: net.Server | undefined;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => {
				server!.close(() => resolve());
			}).catch(() => {});
			server = undefined;
		}
		if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} tmpDir = undefined; }
	});

	it("returns 'in_use' for active socket", async () => {
		tmpDir = makeTempDir("probe-active-");
		const sockPath = join(tmpDir, "test.sock");

		server = net.createServer(() => {});
		await new Promise<void>((resolve) => {
			server!.listen(sockPath, () => resolve());
		});

		const result = await probeStaleSocket(sockPath, "test");
		assert.equal(result, "in_use");
	});

	it("returns 'stale' for non-existent socket", async () => {
		tmpDir = makeTempDir("probe-missing-");
		const sockPath = join(tmpDir, "nonexistent.sock");

		const result = await probeStaleSocket(sockPath, "test");
		assert.equal(result, "stale");
	});

	it("returns 'stale' on connection refused", async () => {
		tmpDir = makeTempDir("probe-refused-");
		const sockPath = join(tmpDir, "refused.sock");

		const srv = net.createServer(() => {});
		await new Promise<void>((resolve) => {
			srv.listen(sockPath, () => {
				srv.close(() => resolve());
			});
		});

		const result = await probeStaleSocket(sockPath, "test");
		assert.equal(result, "stale");
	});

	it("respects configured timeout via cwd", async () => {
		tmpDir = makeTempDir("probe-timeout-");
		const piDir = join(tmpDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "pi-config-settings.json"),
			JSON.stringify({ coms_probe_timeout_ms: 100 }),
			"utf-8",
		);
		clearSettingsCache();

		const sockPath = join(tmpDir, "timeout.sock");
		const start = Date.now();
		const result = await probeStaleSocket(sockPath, "test", tmpDir);
		const elapsed = Date.now() - start;
		assert.equal(result, "stale");
		assert.ok(elapsed < 5000, `Should not wait full timeout, took ${elapsed}ms`);
	});
});
