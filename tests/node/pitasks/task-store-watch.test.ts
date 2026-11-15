import { afterEach, beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const createdBy = { type: "local" as const, origin: "system", session: "", project: "" };
let child: string | undefined;
beforeEach(() => { child = process.env.PI_SUBAGENT_CHILD; delete process.env.PI_SUBAGENT_CHILD; });
afterEach(() => { if (child === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = child; });

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = performance.now() + 3_000;
	while (!check() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	assert.ok(check(), "watcher should notify within 3000ms");
}

for (const existing of [false, true]) {
	it(`notifies after repeated external atomic replacements with an initially ${existing ? "existing" : "missing"} file`, async () => {
		const file = join(makeTempDir("task-watch-"), "tasks.json");
		if (existing) writeFileSync(file, JSON.stringify({ nextId: 1, tasks: [] }));
		const store = new TaskStore(file);
		let notifications = 0;
		store.setOnChange(() => { notifications++; });
		try {
			for (let i = 1; i <= 3; i++) {
				const baseline = notifications;
				writeFileSync(file + ".external", JSON.stringify({ nextId: i, tasks: [] }));
				renameSync(file + ".external", file);
				await waitFor(() => notifications > baseline);
			}
		} finally { store.close(); }
	});
}

it("notifies external changes after an immediate local write-close-reopen", async () => {
	const file = join(makeTempDir("task-watch-"), "tasks.json");
	const store = new TaskStore(file);
	let subjects: string[] = [];
	store.setOnChange(() => { subjects = store.list().map(task => task.subject); });
	try {
		store.create("local", "", createdBy);
		assert.deepEqual(subjects, ["local"], "local notifications remain synchronous");
		store.close(); store.reopen(); store.reopen();
		const data = JSON.parse(readFileSync(file, "utf8"));
		data.tasks[0].subject = "external";
		writeFileSync(file + ".external", JSON.stringify(data));
		renameSync(file + ".external", file);
		await waitFor(() => subjects.includes("external"));
		assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks[0].subject, "external");
	} finally { store.close(); }
});

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

it("does not log corrupt task contents", () => {
	const home = makeTempDir("task-watch-private-log-");
	const file = join(home, "tasks.json");
	writeFileSync(file, "SECRET");
	const script = `import { TaskStore } from './extensions/pitasks/task-store.ts'; const s = new TaskStore(process.argv[1]); s.close();`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, file], {
		cwd: process.cwd(), env: { ...process.env, HOME: home, __PI_CONFIG_SESSION_ID: "privacy-test", __PI_PARENT_SESSION_ID: "", PI_LOG_PITASKS: "warn" }, timeout: 20_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr.toString());
	const logs = readFileSync(join(home, ".pi", "logs", "pitasks", "privacy-test", "main.log"), "utf8");
	assert.match(logs, /task_store_load_failed/);
	assert.ok(!logs.includes("SECRET"), "task contents must not appear in parse-error diagnostics");
});

it("logs only the errno code for a filesystem load failure", () => {
	const home = makeTempDir("task-watch-errno-");
	const script = `import { TaskStore } from './extensions/pitasks/task-store.ts'; const s = new TaskStore(process.argv[1]); s.close();`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, home], {
		cwd: process.cwd(), env: { ...process.env, HOME: home, __PI_CONFIG_SESSION_ID: "errno-test", __PI_PARENT_SESSION_ID: "", PI_LOG_PITASKS: "warn" }, timeout: 20_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr.toString());
	const logs = readFileSync(join(home, ".pi", "logs", "pitasks", "errno-test", "main.log"), "utf8");
	assert.match(logs, /"errorCode":"EISDIR"/);
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
