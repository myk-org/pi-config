import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	clearAsyncAgentCachesForTests,
	resolveJitiCliPath,
} from "../../../extensions/orchestrator/async-agents.js";
import { getPiInvocation } from "../../../extensions/orchestrator/utils.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const tempDirs: string[] = [];

afterEach(() => {
	clearAsyncAgentCachesForTests();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempRoot(prefix: string): string {
	const dir = makeTempDir(prefix);
	tempDirs.push(dir);
	return dir;
}

function createRelease(
	installRoot: string,
	version: string,
	opts: { withJiti?: boolean } = {},
): { releaseDir: string; releaseBin: string; cliJs: string; jitiCli: string } {
	const releaseDir = join(installRoot, "releases", version);
	const cliJs = join(
		releaseDir,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"bundle",
		"cli.js",
	);
	const releaseBin = join(releaseDir, "node_modules", ".bin", "pi");
	const jitiCli = join(releaseDir, "node_modules", "jiti", "lib", "jiti-cli.mjs");

	mkdirSync(dirname(cliJs), { recursive: true });
	writeFileSync(cliJs, "#!/usr/bin/env node\n", { mode: 0o755 });
	chmodSync(cliJs, 0o755);

	mkdirSync(dirname(releaseBin), { recursive: true });
	symlinkSync("../@earendil-works/pi-coding-agent/dist/bundle/cli.js", releaseBin);

	if (opts.withJiti !== false) {
		mkdirSync(dirname(jitiCli), { recursive: true });
		writeFileSync(jitiCli, "export {};\n");
	}

	return { releaseDir, releaseBin, cliJs, jitiCli };
}

function createManagedLauncher(agentDir: string, currentVersion: string): {
	binDir: string;
	launcherPath: string;
	installRoot: string;
} {
	const binDir = join(agentDir, "bin");
	const installRoot = join(agentDir, "install");
	mkdirSync(binDir, { recursive: true });
	mkdirSync(installRoot, { recursive: true });

	const launcherPath = join(binDir, "pi");
	writeFileSync(launcherPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	chmodSync(launcherPath, 0o755);
	writeFileSync(join(installRoot, "current-version"), `${currentVersion}\n`);

	return { binDir, launcherPath, installRoot };
}

describe("resolveJitiCliPath pruned release recovery (#1493)", () => {
	it("caches resolved jiti-cli.mjs while file exists on disk", () => {
		const root = createTempRoot("jiti-cache-hit-");
		const installRoot = join(root, "install");
		const r170 = createRelease(installRoot, "1.7.0");

		const first = resolveJitiCliPath({ argv1: r170.releaseBin, envPath: "", managedInstallRoot: "" });
		assert.equal(first.path, r170.jitiCli);
		assert.ok(first.probes.length > 0);

		const second = resolveJitiCliPath({ argv1: r170.releaseBin, envPath: "", managedInstallRoot: "" });
		assert.equal(second.path, r170.jitiCli);
		assert.deepEqual(second.probes, []);
	});

	it("invalidates stale cachedJitiCliPath after deletion to resolve active managed pi on PATH", () => {
		const agentDir = createTempRoot("jiti-managed-prune-");
		const { binDir, installRoot } = createManagedLauncher(agentDir, "1.6.0");
		const r160 = createRelease(installRoot, "1.6.0");
		const r170 = createRelease(installRoot, "1.7.0");

		const before = resolveJitiCliPath({ argv1: r160.releaseBin, envPath: binDir, managedInstallRoot: "" });
		assert.equal(before.path, r160.jitiCli);

		// Simulate `pi update`: flip current-version to 1.7.0 and prune 1.6.0
		writeFileSync(join(installRoot, "current-version"), "1.7.0\n");
		rmSync(r160.releaseDir, { recursive: true, force: true });

		const after = resolveJitiCliPath({ argv1: r160.releaseBin, envPath: binDir, managedInstallRoot: "" });
		assert.equal(after.path, r170.jitiCli);
		assert.ok(after.probes.some((p) => p.startsWith("HIT ") && p.endsWith(r170.jitiCli)));

		// Newly resolved path is cached for subsequent calls
		const cached = resolveJitiCliPath({ argv1: r160.releaseBin, envPath: binDir, managedInstallRoot: "" });
		assert.equal(cached.path, r170.jitiCli);
		assert.deepEqual(cached.probes, []);
	});

	it("resolves jiti-cli.mjs from direct-symlink pi on PATH after running release is pruned", () => {
		const root = createTempRoot("jiti-symlink-prune-");
		const binDir = join(root, "bin");
		const installRoot = join(root, "install");
		mkdirSync(binDir, { recursive: true });
		const r160 = createRelease(installRoot, "1.6.0");
		const r170 = createRelease(installRoot, "1.7.0");
		symlinkSync(r170.releaseBin, join(binDir, "pi"));

		const before = resolveJitiCliPath({ argv1: r160.releaseBin, envPath: binDir, managedInstallRoot: "" });
		assert.equal(before.path, r160.jitiCli);

		rmSync(r160.releaseDir, { recursive: true, force: true });

		const after = resolveJitiCliPath({ argv1: r160.releaseBin, envPath: binDir, managedInstallRoot: "" });
		assert.equal(after.path, r170.jitiCli);
	});

	it("resolves jiti-cli.mjs from managed current-version when PATH has no pi", () => {
		const agentDir = createTempRoot("jiti-no-path-");
		const { installRoot } = createManagedLauncher(agentDir, "1.6.0");
		const r160 = createRelease(installRoot, "1.6.0");
		const r170 = createRelease(installRoot, "1.7.0");

		const before = resolveJitiCliPath({ argv1: r160.releaseBin, envPath: "", managedInstallRoot: "" });
		assert.equal(before.path, r160.jitiCli);

		writeFileSync(join(installRoot, "current-version"), "1.7.0\n");
		rmSync(r160.releaseDir, { recursive: true, force: true });

		const after = resolveJitiCliPath({ argv1: r160.releaseBin, envPath: "", managedInstallRoot: "" });
		assert.equal(after.path, r170.jitiCli);
	});
});

describe("getPiInvocation pruned release recovery (#1493)", () => {
	const fakeNode = "/usr/bin/node";

	it("keeps process.argv[1] when running inside the active managed release", () => {
		const agentDir = createTempRoot("pi-inv-active-");
		const { binDir, installRoot } = createManagedLauncher(agentDir, "1.7.0");
		const r170 = createRelease(installRoot, "1.7.0");

		const inv = getPiInvocation(["--mode", "json"], {
			argv1: r170.releaseBin,
			execPath: fakeNode,
			envPath: binDir,
		});
		assert.deepEqual(inv, { command: fakeNode, args: [r170.releaseBin, "--mode", "json"] });
	});

	it("keeps process.argv[1] when running through a symlinked copy of the active release", () => {
		const root = createTempRoot("pi-inv-stow-");
		const realAgentDir = join(root, "dotfiles-agent");
		const linkAgentDir = join(root, "linked-agent");
		const { binDir, installRoot } = createManagedLauncher(realAgentDir, "1.7.0");
		createRelease(installRoot, "1.7.0");
		symlinkSync(realAgentDir, linkAgentDir);

		const symlinkedArgv1 = join(linkAgentDir, "install", "releases", "1.7.0", "node_modules", ".bin", "pi");
		const inv = getPiInvocation(["-p", "hi"], {
			argv1: symlinkedArgv1,
			execPath: fakeNode,
			envPath: binDir,
		});
		assert.deepEqual(inv, { command: fakeNode, args: [symlinkedArgv1, "-p", "hi"] });
	});

	it("falls back to active pi on PATH when process.argv[1] release dir is pruned", () => {
		const agentDir = createTempRoot("pi-inv-pruned-");
		const { binDir, launcherPath, installRoot } = createManagedLauncher(agentDir, "1.7.0");
		const r160 = createRelease(installRoot, "1.6.0");
		createRelease(installRoot, "1.7.0");

		rmSync(r160.releaseDir, { recursive: true, force: true });

		const inv = getPiInvocation(["--mode", "json"], {
			argv1: r160.releaseBin,
			execPath: fakeNode,
			envPath: binDir,
		});
		assert.deepEqual(inv, { command: launcherPath, args: ["--mode", "json"] });
	});

	it("falls back to bare pi when release dir is pruned without pi on PATH", () => {
		const root = createTempRoot("pi-inv-pruned-nopath-");
		const installRoot = join(root, "install");
		const r160 = createRelease(installRoot, "1.6.0");

		rmSync(r160.releaseDir, { recursive: true, force: true });

		const inv = getPiInvocation(["--mode", "json"], {
			argv1: r160.releaseBin,
			execPath: fakeNode,
			envPath: "",
		});
		assert.deepEqual(inv, { command: "pi", args: ["--mode", "json"] });
	});

	it("falls back to active pi on PATH when process.argv[1] points to a superseded managed release", () => {
		const agentDir = createTempRoot("pi-inv-superseded-");
		const { binDir, launcherPath, installRoot } = createManagedLauncher(agentDir, "1.7.0");
		const r160 = createRelease(installRoot, "1.6.0");
		createRelease(installRoot, "1.7.0");

		const inv = getPiInvocation(["--mode", "json"], {
			argv1: r160.releaseBin,
			execPath: fakeNode,
			envPath: binDir,
		});
		assert.deepEqual(inv, { command: launcherPath, args: ["--mode", "json"] });
	});

	it("falls back to active pi on PATH when direct-symlink pi points to a newer release", () => {
		const root = createTempRoot("pi-inv-symlink-superseded-");
		const binDir = join(root, "bin");
		const installRoot = join(root, "install");
		mkdirSync(binDir, { recursive: true });
		const r160 = createRelease(installRoot, "1.6.0");
		const r170 = createRelease(installRoot, "1.7.0");
		const pathPi = join(binDir, "pi");
		symlinkSync(r170.releaseBin, pathPi);

		const inv = getPiInvocation(["--mode", "json"], {
			argv1: r160.releaseBin,
			execPath: fakeNode,
			envPath: binDir,
		});
		assert.deepEqual(inv, { command: pathPi, args: ["--mode", "json"] });
	});

	it("falls back to current release bin when superseded without pi on PATH", () => {
		const agentDir = createTempRoot("pi-inv-superseded-nopath-");
		const { installRoot } = createManagedLauncher(agentDir, "1.7.0");
		const r160 = createRelease(installRoot, "1.6.0");
		const r170 = createRelease(installRoot, "1.7.0");

		const inv = getPiInvocation(["--mode", "json"], {
			argv1: r160.releaseBin,
			execPath: fakeNode,
			envPath: "",
		});
		assert.deepEqual(inv, { command: fakeNode, args: [r170.releaseBin, "--mode", "json"] });
	});

	it("keeps non-release process.argv[1] unchanged", () => {
		const root = createTempRoot("pi-inv-custom-");
		const script = join(root, "custom-cli.js");
		writeFileSync(script, "console.log('ok');\n");

		const inv = getPiInvocation(["--flag"], {
			argv1: script,
			execPath: fakeNode,
			envPath: "",
		});
		assert.deepEqual(inv, { command: fakeNode, args: [script, "--flag"] });
	});

	it("returns bare pi when process.argv[1] is empty under node", () => {
		const inv = getPiInvocation(["--version"], {
			argv1: "",
			execPath: fakeNode,
			envPath: "",
		});
		assert.deepEqual(inv, { command: "pi", args: ["--version"] });
	});
});
