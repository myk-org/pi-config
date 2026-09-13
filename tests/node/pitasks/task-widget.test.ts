import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { TaskWidget } from "../../../extensions/pitasks/task-widget.js";

describe("TaskWidget completed metrics", () => {
	it("keeps completed elapsed time and token counts without rendering task body", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		const task = store.create("Completed task", "SECRET TASK BODY");
		const originalNow = Date.now;
		try {
			Date.now = () => 1_000;
			store.update(task.id, { status: "in_progress", activeForm: "leaking active form" });
			widget.setActiveTask(task.id);
			widget.addTokenUsage(1_234, 567);
			Date.now = () => 61_000;
			store.update(task.id, { status: "completed" });
			widget.setActiveTask(task.id, false);

			const render = () => (widget as any).buildWidgetLines(
				{ terminal: { columns: 200 } },
				{ fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
			).join("\n");
			const completed = render();
			Date.now = () => 999_999;

			assert.match(completed, /\(1m · ↑ 1\.2k ↓ 567\)/);
			assert.equal(render(), completed);
			assert.doesNotMatch(completed, /SECRET TASK BODY|leaking active form/);
		} finally {
			Date.now = originalNow;
			widget.dispose();
		}
	});
});

describe("TaskWidget telemetry lifecycle", () => {
	it("reactivates persisted in-progress telemetry after reload", () => {
		const dir = mkdtempSync(join(tmpdir(), "pitasks-"));
		const path = join(dir, "tasks.json");
		const originalNow = Date.now;
		try {
			Date.now = () => 1_000;
			const store = new TaskStore(path);
			const task = store.create("Running task", "body", { type: "local", origin: "system", session: "", project: "" });
			store.update(task.id, { status: "in_progress", telemetry: { startedAt: 1_000, inputTokens: 5, outputTokens: 3 } });
			store.close();

			Date.now = () => 2_000;
			const reloaded = new TaskStore(path);
			const widget = new TaskWidget(reloaded);
			widget.setActiveTask(task.id);
			widget.addTokenUsage(7, 11);
			assert.deepEqual(reloaded.get(task.id)?.telemetry, { startedAt: 1_000, inputTokens: 12, outputTokens: 14 });
			widget.dispose();
			reloaded.close();
		} finally {
			Date.now = originalNow;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("starts a fresh telemetry attempt when a completed task restarts", () => {
		const store = new TaskStore();
		const widget = new TaskWidget(store);
		const task = store.create("Restarted task", "body", { type: "local", origin: "system", session: "", project: "" });
		const originalNow = Date.now;
		try {
			Date.now = () => 1_000;
			store.update(task.id, { status: "in_progress" });
			widget.setActiveTask(task.id);
			widget.addTokenUsage(10, 20);
			Date.now = () => 2_000;
			store.update(task.id, { status: "completed" });
			widget.setActiveTask(task.id, false);

			Date.now = () => 3_000;
			store.update(task.id, { status: "in_progress" });
			widget.setActiveTask(task.id);
			widget.addTokenUsage(1, 2);
			assert.deepEqual(store.get(task.id)?.telemetry, { startedAt: 3_000, inputTokens: 1, outputTokens: 2 });
		} finally {
			Date.now = originalNow;
			widget.dispose();
		}
	});
});

describe("TaskWidget persisted metrics", () => {
	it("hydrates completed telemetry with frozen duration after reload", () => {
		const dir = mkdtempSync(join(tmpdir(), "pitasks-"));
		const path = join(dir, "tasks.json");
		const originalNow = Date.now;
		try {
			Date.now = () => 1_000;
			const store = new TaskStore(path);
			const task = store.create("Persisted task", "body", { type: "local", origin: "system", session: "", project: "" });
			store.update(task.id, { status: "in_progress" });
			const widget = new TaskWidget(store);
			widget.setActiveTask(task.id);
			widget.addTokenUsage(1_234, 567);
			Date.now = () => 61_000;
			store.update(task.id, { status: "completed" });
			widget.setActiveTask(task.id, false);
			widget.dispose();
			store.close();

			const reloaded = new TaskStore(path);
			assert.deepEqual(reloaded.get(task.id)?.telemetry, { startedAt: 1_000, endedAt: 61_000, inputTokens: 1_234, outputTokens: 567 });
			const pending = reloaded.create("Queued task", "body", { type: "local", origin: "system", session: "", project: "" });
			reloaded.update(pending.id, { telemetry: { startedAt: 1_000, inputTokens: 20, outputTokens: 10 } });
			const reloadedWidget = new TaskWidget(reloaded);
			const lines = (reloadedWidget as any).buildWidgetLines(
				{ terminal: { columns: 200 } },
				{ fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
			).join("\n");
			Date.now = () => 999_999;
			assert.match(lines, /\(1m · ↑ 1\.2k ↓ 567\)/);
			assert.match(lines, /#2 Queued task \(1m · ↑ 20 ↓ 10\)/);
			reloadedWidget.dispose();
			reloaded.close();
		} finally {
			Date.now = originalNow;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
