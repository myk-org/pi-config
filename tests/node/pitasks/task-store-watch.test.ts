import { after, afterEach, beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { makeTempDir, TEST_TMP_BASE } from "../helpers/temp-dirs.js";

const createdBy = { type: "local" as const, origin: "system", session: "", project: "" };
const projectTmpBase = join(process.cwd(), ".pi", "tmp");
const projectRunRoot = join(projectTmpBase, `task-watch-run-${process.pid}`);
after(() => { rmSync(projectRunRoot, { recursive: true, force: true }); });

const fixtureBases = [
	{
		name: "default-temp",
		createDir(prefix: string): { dir: string; expectedBase: string; cleanup(): void } {
			const dir = makeTempDir(prefix);
			return { dir, expectedBase: TEST_TMP_BASE, cleanup() {} };
		},
	},
	{
		name: "project-local",
		createDir(prefix: string): { dir: string; expectedBase: string; cleanup(): void } {
			mkdirSync(projectRunRoot, { recursive: true });
			const dir = mkdtempSync(join(projectRunRoot, prefix));
			return { dir, expectedBase: projectTmpBase, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
		},
	},
] as const;
let child: string | undefined;
beforeEach(() => { child = process.env.PI_SUBAGENT_CHILD; delete process.env.PI_SUBAGENT_CHILD; });
afterEach(() => { if (child === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = child; });

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = performance.now() + 3_000;
	while (!check() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	assert.ok(check(), "watcher should notify within 3000ms");
}

const taskStoreModuleUrl = new URL("../../../extensions/pitasks/task-store.ts", import.meta.url).href;

function runStoreProcess(home: string, sessionId: string, logLevel: string, body: string, args: string[] = []): string {
	const script = `process.chdir(process.env.HOME); const { TaskStore } = await import(${JSON.stringify(taskStoreModuleUrl)}); ${body}`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, ...args], {
		cwd: process.cwd(),
		env: { ...process.env, HOME: home, USERPROFILE: home, __PI_CONFIG_SESSION_ID: sessionId, __PI_PARENT_SESSION_ID: "", PI_LOG_PITASKS: logLevel },
		timeout: 20_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr.toString());
	return readFileSync(join(home, ".pi", "logs", "pitasks", sessionId, "main.log"), "utf8");
}

for (const base of fixtureBases) {
	for (const existing of [false, true]) {
		it(`notifies after repeated external atomic replacements of an initially ${existing ? "existing" : "missing"} file on the ${base.name} base`, async () => {
			const fixture = base.createDir("task-watch-");
			const file = join(fixture.dir, "tasks.json");
			if (existing) writeFileSync(file, JSON.stringify({ nextId: 1, tasks: [] }));
			const store = new TaskStore(file);
			let notifications = 0;
			store.setOnChange(() => { notifications++; });
			try {
				assert.ok(realpathSync(fixture.dir).startsWith(realpathSync(fixture.expectedBase)));
				for (let i = 1; i <= 3; i++) {
					const baseline = notifications;
					writeFileSync(file + ".external", JSON.stringify({ nextId: i, tasks: [] }));
					renameSync(file + ".external", file);
					await waitFor(() => notifications > baseline);
				}
			} finally {
				store.close();
				fixture.cleanup();
			}
		});
	}

	it(`notifies external changes after an immediate local write-close-reopen on the ${base.name} base`, async () => {
		const fixture = base.createDir("task-watch-");
		const file = join(fixture.dir, "tasks.json");
		const store = new TaskStore(file);
		let subjects: string[] = [];
		store.setOnChange(() => { subjects = store.list().map(task => task.subject); });
		try {
			assert.ok(realpathSync(fixture.dir).startsWith(realpathSync(fixture.expectedBase)));
			store.create("local", "", createdBy);
			assert.deepEqual(subjects, ["local"], "local notifications remain synchronous");
			store.close(); store.reopen(); store.reopen();
			const data = JSON.parse(readFileSync(file, "utf8"));
			data.tasks[0].subject = "external";
			writeFileSync(file + ".external", JSON.stringify(data));
			renameSync(file + ".external", file);
			await waitFor(() => subjects.includes("external"));
			assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks[0].subject, "external");
		} finally {
			store.close();
			fixture.cleanup();
		}
	});
}

it("local watcher invalidations do not rewrite the store or loop", async () => {
	const file = join(makeTempDir("task-watch-local-"), "tasks.json");
	const store = new TaskStore(file);
	let notifications = 0;
	store.setOnChange(() => { store.list(); notifications++; });
	try {
		store.create("local", "", createdBy);
		assert.equal(notifications, 1, "local mutation notifies synchronously");
		const inode = statSync(file).ino;
		await waitFor(() => notifications > 1);
		await new Promise(resolve => setTimeout(resolve, 50));
		const settled = notifications;
		writeFileSync(file + ".unrelated", "ignored");
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(notifications, settled, "unrelated files must not notify");
		assert.equal(statSync(file).ino, inode, "refresh must not save another snapshot");
	} finally { store.close(); }
});

for (const atomic of [false, true]) {
	it(`observes ${atomic ? "atomic replacements of" : "in-place writes to"} a symlink target in another directory`, async () => {
		const file = join(makeTempDir("task-watch-link-"), "tasks.json");
		const target = join(makeTempDir("task-watch-target-"), "target.json");
		writeFileSync(target, JSON.stringify({ nextId: 1, tasks: [] }));
		symlinkSync(target, file);
		const store = new TaskStore(file);
		let notifications = 0;
		store.setOnChange(() => { notifications++; });
		try {
			for (let i = 2; i <= 3; i++) {
				const baseline = notifications;
				writeFileSync(atomic ? target + ".tmp" : target, JSON.stringify({ nextId: i, tasks: [] }));
				if (atomic) renameSync(target + ".tmp", target);
				await waitFor(() => notifications > baseline);
			}
		} finally { store.close(); }
	});
}

it("observes creation of an initially missing symlink target", async () => {
	const file = join(makeTempDir("task-watch-dangling-"), "tasks.json");
	const target = join(makeTempDir("task-watch-target-"), "target.json");
	symlinkSync(target, file);
	const store = new TaskStore(file);
	let nextId = 0;
	store.setOnChange(() => { nextId = store.snapshot().nextId; });
	try {
		writeFileSync(target, JSON.stringify({ nextId: 2, tasks: [] }));
		await waitFor(() => nextId === 2);
	} finally { store.close(); }
});

it("observes creation of a symlink target inside an initially missing directory", async () => {
	const file = join(makeTempDir("task-watch-dangling-dir-"), "tasks.json");
	const targetRoot = makeTempDir("task-watch-target-root-");
	const target = join(targetRoot, "missing", "deep", "target.json");
	symlinkSync(target, file);
	const store = new TaskStore(file);
	let nextId = 0;
	store.setOnChange(() => { nextId = store.snapshot().nextId; });
	try {
		assert.equal(existsSync(join(targetRoot, "missing")), false, "store must not create external target directories");
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, JSON.stringify({ nextId: 2, tasks: [] }));
		await waitFor(() => nextId === 2);
		writeFileSync(target, JSON.stringify({ nextId: 3, tasks: [] }));
		await waitFor(() => nextId === 3);
	} finally { store.close(); }
});

it("follows a replacement symlink at the configured pathname", async () => {
	const file = join(makeTempDir("task-watch-retarget-"), "tasks.json");
	const targets = ["first", "second"].map(name => join(makeTempDir("task-watch-target-"), name + ".json"));
	for (const target of targets) writeFileSync(target, JSON.stringify({ nextId: 1, tasks: [] }));
	symlinkSync(targets[0], file);
	const store = new TaskStore(file);
	let nextId = 0;
	store.setOnChange(() => { nextId = store.snapshot().nextId; });
	try {
		symlinkSync(targets[1], file + ".new");
		renameSync(file + ".new", file);
		await waitFor(() => nextId === 1);
		writeFileSync(targets[1], JSON.stringify({ nextId: 2, tasks: [] }));
		await waitFor(() => nextId === 2);
	} finally { store.close(); }
});

it("follows a retargeted intermediate symlink in a chain", async () => {
	const file = join(makeTempDir("task-watch-chain-"), "tasks.json");
	const middle = join(makeTempDir("task-watch-mid-"), "mid.json");
	const first = join(makeTempDir("task-watch-first-"), "first.json");
	const second = join(makeTempDir("task-watch-second-"), "second.json");
	writeFileSync(first, JSON.stringify({ nextId: 1, tasks: [] }));
	writeFileSync(second, JSON.stringify({ nextId: 2, tasks: [] }));
	symlinkSync(first, middle);
	symlinkSync(middle, file);
	const store = new TaskStore(file);
	let nextId = 0;
	store.setOnChange(() => { nextId = store.snapshot().nextId; });
	try {
		symlinkSync(second, middle + ".new");
		renameSync(middle + ".new", middle);
		await waitFor(() => nextId === 2);
		writeFileSync(second, JSON.stringify({ nextId: 3, tasks: [] }));
		await waitFor(() => nextId === 3);
	} finally { store.close(); }
});

it("tolerates a symlink cycle without hanging", async () => {
	const first = join(makeTempDir("task-watch-cycle-a-"), "a.json");
	const second = join(makeTempDir("task-watch-cycle-b-"), "b.json");
	const third = join(makeTempDir("task-watch-cycle-c-"), "c.json");
	symlinkSync(second, first);
	symlinkSync(third, second);
	symlinkSync(first, third);
	const store = new TaskStore(first);
	let nextId = 0;
	store.setOnChange(() => { nextId = store.snapshot().nextId; });
	try {
		writeFileSync(third + ".real", JSON.stringify({ nextId: 4, tasks: [] }));
		renameSync(third + ".real", third);
		await waitFor(() => nextId === 4);
	} finally { store.close(); }
});

it("local saves replace the configured symlink without writing its target", async () => {
	const file = join(makeTempDir("task-watch-link-save-"), "tasks.json");
	const target = join(makeTempDir("task-watch-target-save-"), "target.json");
	const original = JSON.stringify({ nextId: 1, tasks: [] });
	writeFileSync(target, original);
	symlinkSync(target, file);
	const store = new TaskStore(file);
	let notifications = 0;
	store.setOnChange(() => { notifications++; });
	try {
		store.create("local", "", createdBy);
		assert.equal(lstatSync(file).isSymbolicLink(), false);
		assert.equal(readFileSync(target, "utf8"), original);
		await waitFor(() => notifications > 1);
		const baseline = notifications;
		writeFileSync(file + ".external", JSON.stringify({ nextId: 2, tasks: [] }));
		renameSync(file + ".external", file);
		await waitFor(() => notifications > baseline);
	} finally { store.close(); }
});

it("reopen restores notifications after a watcher error", async () => {
	const file = join(makeTempDir("task-watch-error-"), "tasks.json");
	const store = new TaskStore(file);
	let notifications = 0;
	store.setOnChange(() => { notifications++; });
	try {
		// Native resource exhaustion is nondeterministic; inject its error on the real handle.
		const watcher = (store as unknown as { _watcher: FSWatcher })._watcher;
		watcher.close();
		watcher.emit("error", new Error("injected watcher failure"));
		store.reopen();
		writeFileSync(file, JSON.stringify({ nextId: 1, tasks: [] }));
		await waitFor(() => notifications > 0);
	} finally { store.close(); }
});

it("logs a warning when symlink resolution hits a non-directory ancestor", () => {
	const home = makeTempDir("task-watch-symlink-err-");
	const blocker = join(home, "blocker");
	const file = join(home, "tasks.json");
	writeFileSync(blocker, "file");
	symlinkSync(join(blocker, "target.json"), file);
	const logs = runStoreProcess(home, "symlink-err-test", "warn", "const s = new TaskStore(process.argv[1]); s.close();", [file]);
	assert.match(logs, /\[warn\] \[pitasks\] task_watch_symlink_failed .*"code":"ENOTDIR"/);
});

it("does not log corrupt task contents", () => {
	const home = makeTempDir("task-watch-private-log-");
	const file = join(home, "tasks.json");
	writeFileSync(file, "SECRET");
	const logs = runStoreProcess(home, "privacy-test", "error", "const s = new TaskStore(process.argv[1]); s.close();", [file]);
	assert.match(logs, /\[error\] \[pitasks\] task_store_load_failed/);
	assert.ok(!logs.includes("SECRET"), "task contents must not appear in parse-error diagnostics");
});

it("preserves a corrupt task file once before saving over it", () => {
	const home = makeTempDir("task-watch-corrupt-preserve-");
	const file = join(home, "tasks.json");
	writeFileSync(file, "SECRET_CORRUPT_ONE");
	const body = `const { writeFileSync } = await import('node:fs'); const by = ${JSON.stringify(createdBy)}; const s = new TaskStore(process.argv[1]); s.create('first', '', by); writeFileSync(process.argv[1], 'SECRET_CORRUPT_TWO'); s.create('second', '', by); s.close();`;
	const logs = runStoreProcess(home, "corrupt-preserve-test", "warn", body, [file]);
	assert.equal(readFileSync(file + ".corrupt", "utf8"), "SECRET_CORRUPT_ONE");
	assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks.at(-1).subject, "second");
	assert.match(logs, /\[warn\] \[pitasks\] task_store_corrupt_preserved/);
	assert.ok(!logs.includes("SECRET_CORRUPT_ONE") && !logs.includes("SECRET_CORRUPT_TWO"));
});

it("logs only the errno code for a filesystem load failure", () => {
	const home = makeTempDir("task-watch-errno-");
	const logs = runStoreProcess(home, "errno-test", "error", "const s = new TaskStore(process.argv[1]); s.close();", [home]);
	assert.match(logs, /\[error\] \[pitasks\] task_store_load_failed .*"errorCode":"EISDIR"/);
});

it("logs structured debug fields for watcher events", () => {
	const home = makeTempDir("task-watch-debug-event-");
	const file = join(home, "tasks.json");
	const body = `const { writeFileSync } = await import('node:fs'); const s = new TaskStore(process.argv[1]); await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 3000); s.setOnChange(() => { clearTimeout(t); resolve(undefined); }); writeFileSync(process.argv[1], JSON.stringify({ nextId: 1, tasks: [] })); }); s.close();`;
	const logs = runStoreProcess(home, "debug-event-test", "debug", body, [file]);
	assert.match(logs, /\[debug\] \[pitasks\] task_watch_event .*"filePath":.*"eventType":.*"changedFile":"tasks\.json"/);
});

it("logs structured debug fields on watcher close", () => {
	const home = makeTempDir("task-watch-debug-close-");
	const file = join(home, "tasks.json");
	const logs = runStoreProcess(home, "debug-close-test", "debug", "const s = new TaskStore(process.argv[1]); s.close(); s.close();", [file]);
	assert.match(logs, /\[debug\] \[pitasks\] task_watch_close .*"filePath":.*"hadWatcher":true/);
	assert.match(logs, /\[debug\] \[pitasks\] task_watch_close .*"filePath":.*"hadWatcher":false/);
});

it("logs structured debug fields on watcher reopen", () => {
	const home = makeTempDir("task-watch-debug-reopen-");
	const file = join(home, "tasks.json");
	const logs = runStoreProcess(home, "debug-reopen-test", "debug", "const s = new TaskStore(process.argv[1]); s.close(); s.reopen(); s.reopen(); s.close();", [file]);
	assert.match(logs, /\[debug\] \[pitasks\] task_watch_reopen .*"filePath":.*"reopened":true/);
	assert.match(logs, /\[debug\] \[pitasks\] task_watch_reopen .*"filePath":.*"reopened":false/);
});

it("child stores skip watching across reopen without preventing process exit", () => {
	const file = join(makeTempDir("task-watch-child-"), "tasks.json");
	const script = `import { TaskStore } from './extensions/pitasks/task-store.ts'; const s = new TaskStore(process.argv[1]); s.create('child', '', ${JSON.stringify(createdBy)}); s.close(); s.reopen();`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, file], {
		cwd: process.cwd(), env: { ...process.env, PI_SUBAGENT_CHILD: "1" }, timeout: 20_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr.toString());
	assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks[0].subject, "child");
});

it("stat-caches TaskStore.load() across unchanged reads and reloads on external replacement (#1162)", () => {
	const dir = makeTempDir("task-store-stat-cache-");
	const file = join(dir, "tasks.json");
	const store = new TaskStore(file);
	try {
		const created = store.create("Initial", "body", createdBy);
		const firstList = store.list();
		const secondList = store.list();
		const fetched = store.get(created.id);
		assert.strictEqual(firstList[0], secondList[0], "unchanged file should skip re-parsing and reuse task objects");
		assert.strictEqual(fetched, firstList[0]);

		// External atomic replacement updates inode/mtime/size and invalidates the stat cache even without watcher event
		const raw = JSON.parse(readFileSync(file, "utf8"));
		raw.tasks[0].subject = "External update";
		writeFileSync(file + ".ext", JSON.stringify(raw));
		renameSync(file + ".ext", file);

		const reloaded = store.list();
		assert.equal(reloaded[0].subject, "External update");
		assert.notStrictEqual(reloaded[0], firstList[0]);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("acquireLock recovers stale dead-PID locks immediately and waits without CPU spin on live locks (#1166)", async () => {
	const dir = makeTempDir("task-store-lock-sleep-");
	const file = join(dir, "tasks.json");
	const lockFile = `${file}.lock`;
	const store = new TaskStore(file);
	try {
		// Dead PID lock is stolen immediately without waiting
		const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		assert.ok(deadChild.pid);
		writeFileSync(lockFile, String(deadChild.pid));
		const t0 = performance.now();
		store.create("After stale lock", "body", createdBy);
		assert.ok(performance.now() - t0 < 500, "stale lock should be stolen immediately");

		// Live child holds lock for ~200ms then releases it
		const holder = spawn(process.execPath, [
			"-e",
			`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid), { flag: 'wx' }); setTimeout(() => { try { fs.unlinkSync(${JSON.stringify(lockFile)}); } catch {} }, 200);`,
		], { stdio: "ignore" });
		const lockDeadline = performance.now() + 2_000;
		while (!existsSync(lockFile) && performance.now() < lockDeadline) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.ok(existsSync(lockFile), "holder child must create lock file");

		const cpuBefore = process.cpuUsage();
		const wallBefore = performance.now();
		const created = store.create("After live lock", "body", createdBy);
		const wallElapsed = performance.now() - wallBefore;
		const cpuDeltaMs = (cpuBefore ? process.cpuUsage(cpuBefore) : { user: 0, system: 0 });
		const totalCpuMs = (cpuDeltaMs.user + cpuDeltaMs.system) / 1000;

		await new Promise<void>(resolve => holder.on("exit", () => resolve()));
		assert.equal(created.subject, "After live lock");
		assert.ok(wallElapsed >= 100, `expected lock wait >= 100ms, got ${wallElapsed.toFixed(1)}ms`);
		assert.ok(totalCpuMs < Math.max(80, wallElapsed * 0.5), `expected low CPU during Atomics.wait lock sleep, used ${totalCpuMs.toFixed(1)}ms over ${wallElapsed.toFixed(1)}ms`);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("unwatched TaskStore({ watch: false }) defers load and allocates zero fs.watch watchers (#1170)", () => {
	const dir = makeTempDir("task-store-no-watch-");
	const missingParent = join(dir, "never-created", "tasks.json");
	const unwatchedMissing = new TaskStore(missingParent, { watch: false });
	try {
		assert.equal(existsSync(dirname(missingParent)), false, "watch:false must not mkdirSync parent dir on init");
		assert.equal((unwatchedMissing as any)._watcher, null);
		assert.equal((unwatchedMissing as any)._targetWatchers.size, 0);
	} finally {
		unwatchedMissing.close();
	}

	const existing = join(dir, "existing.json");
	writeFileSync(existing, JSON.stringify({
		nextId: 2,
		tasks: [{ id: "1", subject: "Existing", description: "d", status: "pending", assignee: "llm", blocks: [], blockedBy: [], metadata: {} }],
	}));
	const unwatched = new TaskStore(existing, { watch: false });
	try {
		assert.equal((unwatched as any)._watcher, null, "watch:false must skip fs.watch");
		assert.equal((unwatched as any)._lastStat, null, "watch:false must defer initial load until first query");
		const tasks = unwatched.list();
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0].subject, "Existing");
		assert.ok((unwatched as any)._lastStat, "first query populates stat cache");
	} finally {
		unwatched.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
