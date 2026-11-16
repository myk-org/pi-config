/**
 * Task-id rejection message (issue #1016).
 *
 * `taskIdError` is the decision the guard makes for every async spawn: reject an id the
 * store does not know, exempt the `-1` read-only sentinel, and stay silent when the id
 * resolves. It had no test while shipping a behaviour change, so it has one now.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { registerSubagentTool, taskIdError, validateTaskId } from "../../../extensions/orchestrator/subagent-tool.ts";
import { publishTaskStore, TASK_STORE_SYMBOL } from "../../../extensions/shared/task-store-bridge.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const known = (ids: string[]) => (id: string) => ids.includes(id);

describe("taskIdError", () => {
  it("rejects an id the store does not know", () => {
    const message = taskIdError("99997", known(["1", "2"]));
    assert.ok(message?.includes("Task #99997 not found"));
    assert.ok(message?.includes('pass taskId: "-1" for a read-only check'));
  });

  it("accepts an id the store knows", () => {
    assert.equal(taskIdError("2", known(["1", "2"])), null);
  });

  it("exempts the -1 read-only sentinel without consulting the store", () => {
    let consulted = false;
    const lookup = () => {
      consulted = true;
      return false;
    };
    assert.equal(taskIdError("-1", lookup), null);
    assert.equal(consulted, false, "the sentinel must not hit the store");
  });
});

/** A published store with one task; the guard reads it through the same bridge the tool does. */
function storeWith(assignee: string) {
	return { get: (id: string) => (id === "7" ? { id: "7", assignee } : undefined) };
}

describe("validateTaskId owner tasks (#1102)", () => {
	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL];
	});

	it("refuses a task assigned to the owner", async () => {
		// The lifecycle helpers never start or complete an owner task, so a spawn on it did the
		// owner's step and then left the task untouched with no error delivered.
		publishTaskStore(() => storeWith("user"));
		const message = await validateTaskId("7", "/tmp");
		assert.match(message ?? "", /assigned to the user \(assignee="user"\)/);
		assert.match(message ?? "", /agents cannot start or complete it/);
	});

	it("accepts an llm-assigned task", async () => {
		publishTaskStore(() => storeWith("llm"));
		assert.equal(await validateTaskId("7", "/tmp"), null);
	});

	it("still reports an id the store does not know", async () => {
		publishTaskStore(() => storeWith("llm"));
		assert.match((await validateTaskId("8", "/tmp")) ?? "", /Task #8 not found/);
	});
});

/**
 * The sync entry points (single / parallel / chain) must refuse an owner task too: their lifecycle
 * helpers skip it, so a sync spawn would do the owner's step and leave the task untouched (#1102).
 * `process.argv[1]` points at a script that exits immediately, so a regression that loses the
 * guard finishes fast instead of launching a real agent.
 */
function syncHarness() {
	const cwd = makeTempDir("sync-task-guard-");
	const childScript = join(cwd, "child.cjs");
	writeFileSync(childScript, "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ran' }] } }) + '\\n');\n");
	const previousArgv1 = process.argv[1];
	process.argv[1] = childScript;

	let tool: any;
	const pi = {
		registerTool(definition: any) {
			tool = definition;
		},
		registerCommand() {},
		on() {},
		sendMessage() {},
		events: { on() {}, emit() {} },
	} as any;
	withSubagentChildEnv(undefined, () => {
		registerSubagentTool(pi, () => ({ id: "async-job" }), () => ({ killed: [], errors: [] }));
	});
	assert.ok(tool, "the subagent tool must register");

	const ctx = {
		cwd,
		hasUI: false,
		model: { id: "claude-sonnet-4-5", provider: "anthropic" },
		ui: { theme: { fg: (_: string, value: string) => value, bold: (value: string) => value }, notify() {}, setWorkingMessage() {}, setStatus() {}, confirm: async () => true },
		sessionManager: { getSessionId: () => "sess-sync-guard" },
	};

	return {
		run: (params: Record<string, unknown>) =>
			tool.execute("call-sync", { confirmProjectAgents: false, ...params }, new AbortController().signal, undefined, ctx),
		restore: () => {
			process.argv[1] = previousArgv1;
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

describe("sync subagent owner-task guard (#1102)", { concurrency: false }, () => {
	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL];
	});

	it("refuses a sync single call on an owner task", async () => {
		publishTaskStore(() => storeWith("user"));
		const h = syncHarness();
		try {
			const result = await h.run({ agent: "worker", task: "do the owner step", cwd: process.cwd(), estimatedSeconds: 5, taskId: "7" });
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /assigned to the user/);
		} finally {
			h.restore();
		}
	});

	it("refuses a sync parallel call on an owner task", async () => {
		publishTaskStore(() => storeWith("user"));
		const h = syncHarness();
		try {
			const result = await h.run({
				tasks: [{ agent: "worker", task: "parallel owner work", cwd: process.cwd(), estimatedSeconds: 5, taskId: "7" }],
			});
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /assigned to the user/);
		} finally {
			h.restore();
		}
	});

	it("refuses a sync chain call on an owner task", async () => {
		publishTaskStore(() => storeWith("user"));
		const h = syncHarness();
		try {
			const result = await h.run({
				chain: [{ agent: "worker", task: "chain owner work", cwd: process.cwd(), estimatedSeconds: 5, taskId: "7" }],
			});
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /assigned to the user/);
		} finally {
			h.restore();
		}
	});
});
