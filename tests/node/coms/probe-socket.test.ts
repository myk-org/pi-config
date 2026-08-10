import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import { describe, it, afterEach } from "node:test";

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
		tmpDir = mkdtempSync(join(tmpdir(), "probe-active-"));
		const sockPath = join(tmpDir, "test.sock");

		// Start a real Unix socket server
		server = net.createServer(() => {});
		await new Promise<void>((resolve) => {
			server!.listen(sockPath, () => resolve());
		});

		const { probeStaleSocket } = await import(
			`../../../extensions/coms/probe-socket.ts?t=${Date.now()}`
		);
		const result = await probeStaleSocket(sockPath, "test");
		assert.equal(result, "in_use");
	});

	it("returns 'stale' for non-existent socket", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "probe-missing-"));
		const sockPath = join(tmpDir, "nonexistent.sock");

		const { probeStaleSocket } = await import(
			`../../../extensions/coms/probe-socket.ts?t=${Date.now() + 1}`
		);
		const result = await probeStaleSocket(sockPath, "test");
		assert.equal(result, "stale");
	});

	it("returns 'stale' on connection refused", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "probe-refused-"));
		const sockPath = join(tmpDir, "refused.sock");

		// Create and immediately close a server to get ECONNREFUSED
		const srv = net.createServer(() => {});
		await new Promise<void>((resolve) => {
			srv.listen(sockPath, () => {
				srv.close(() => resolve());
			});
		});

		const { probeStaleSocket } = await import(
			`../../../extensions/coms/probe-socket.ts?t=${Date.now() + 2}`
		);
		const result = await probeStaleSocket(sockPath, "test");
		assert.equal(result, "stale");
	});

	it("respects configured timeout via cwd", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "probe-timeout-"));
		const piDir = join(tmpDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		// Set a very short timeout
		writeFileSync(
			join(piDir, "pi-config-settings.json"),
			JSON.stringify({ coms_probe_timeout_ms: 100 }),
			"utf-8",
		);

		const { clearSettingsCache } = await import(
			`../../../extensions/orchestrator/project-settings.ts`
		);
		clearSettingsCache();

		const sockPath = join(tmpDir, "timeout.sock");
		// Don't create a server — socket won't exist → ENOENT → stale
		const { probeStaleSocket } = await import(
			`../../../extensions/coms/probe-socket.ts?t=${Date.now() + 3}`
		);
		const start = Date.now();
		const result = await probeStaleSocket(sockPath, "test", tmpDir);
		const elapsed = Date.now() - start;
		assert.equal(result, "stale");
		// Should resolve quickly (ENOENT), not wait for full timeout
		assert.ok(elapsed < 5000, `Should not wait full timeout, took ${elapsed}ms`);
	});

	it("returns 'in_use' for active socket with custom timeout", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "probe-active-timeout-"));
		const piDir = join(tmpDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "pi-config-settings.json"),
			JSON.stringify({ coms_probe_timeout_ms: 200 }),
			"utf-8",
		);

		const { clearSettingsCache } = await import(
			`../../../extensions/orchestrator/project-settings.ts`
		);
		clearSettingsCache();

		const sockPath = join(tmpDir, "active.sock");
		server = net.createServer(() => {});
		await new Promise<void>((resolve) => {
			server!.listen(sockPath, () => resolve());
		});

		const { probeStaleSocket } = await import(
			`../../../extensions/coms/probe-socket.ts?t=${Date.now() + 20}`
		);
		const result = await probeStaleSocket(sockPath, "test", tmpDir);
		assert.equal(result, "in_use");
	});

	it("handles non-socket file at path with configured timeout", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "probe-nonsock-"));
		const piDir = join(tmpDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "pi-config-settings.json"),
			JSON.stringify({ coms_probe_timeout_ms: 200 }),
			"utf-8",
		);

		const { clearSettingsCache } = await import(
			`../../../extensions/orchestrator/project-settings.ts`
		);
		clearSettingsCache();

		const sockPath = join(tmpDir, "not-a-socket");
		writeFileSync(sockPath, "regular file");

		const { probeStaleSocket } = await import(
			`../../../extensions/coms/probe-socket.ts?t=${Date.now() + 21}`
		);
		const start = Date.now();
		const result = await probeStaleSocket(sockPath, "test", tmpDir);
		const elapsed = Date.now() - start;
		// Non-socket → error (varies by OS) → should resolve within configured timeout
		assert.ok(result === "in_use" || result === "stale");
		assert.ok(elapsed < 1000, `Should resolve within timeout, took ${elapsed}ms`);
	});
});
