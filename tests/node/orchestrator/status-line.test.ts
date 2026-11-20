import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerStatusLine } from "../../../extensions/orchestrator/status-line.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

function makeHarness(opts: { debounceMs?: number } = {}) {
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
	const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	let notifyCalls = 0;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: any) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};

	const runGitAsync = async (args: string[], cwd?: string) => {
		gitCalls.push({ args, cwd });
		if (args[0] === "rev-parse") return { stdout: "feat/test", code: 0 };
		if (args[0] === "status") return { stdout: " M a.ts\n?? b.ts\n", code: 0 };
		if (args[0] === "remote") return { stdout: "https://example.com/org/repo.git", code: 0 };
		return { stdout: "", code: 0 };
	};

	withSubagentChildEnv(undefined, () => {
		registerStatusLine(
			pi as any,
			false,
			() => {
				notifyCalls++;
			},
			{ runGitAsync, debounceMs: opts.debounceMs ?? 20 },
		);
	});

	const makeCtx = (hasUI: boolean, cwd = "/repo") => ({
		hasUI,
		cwd,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
		},
	});

	const emit = (event: string, ctx: any) => {
		for (const h of handlers.get(event) ?? []) h({}, ctx);
	};

	return { handlers, gitCalls, statuses, makeCtx, emit, getNotifyCalls: () => notifyCalls };
}

describe("status-line (#1203)", () => {
	it("skips registration completely when PI_SUBAGENT_CHILD=1", () => {
		const registered: string[] = [];
		const pi = {
			on(event: string) {
				registered.push(event);
			},
		};
		withSubagentChildEnv("1", () => {
			registerStatusLine(pi as any, false, () => {});
		});
		assert.deepEqual(registered, []);
	});

	it("skips git spawns when ctx.hasUI is false", async () => {
		const h = makeHarness();
		try {
			const ctx = h.makeCtx(false);
			h.emit("session_start", ctx);
			h.emit("agent_end", ctx);
			h.emit("tool_execution_end", ctx);
			await new Promise((r) => setTimeout(r, 50));
			assert.equal(h.gitCalls.length, 0);
			assert.equal(h.statuses.length, 0);
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("does not subscribe to duplicate tool_result or turn_end for git status", async () => {
		const h = makeHarness();
		try {
			assert.equal(h.handlers.has("tool_result"), false);
			const ctx = h.makeCtx(true);
			h.emit("turn_end", ctx);
			await new Promise((r) => setTimeout(r, 40));
			assert.equal(h.gitCalls.length, 0);
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("coalesces rapid tool_execution_end bursts via trailing debounce and caches isGithubRepo per cwd", async () => {
		const h = makeHarness({ debounceMs: 25 });
		try {
			const ctx = h.makeCtx(true, "/repo-cache");
			h.emit("session_start", ctx);
			await new Promise((r) => setTimeout(r, 15));
			// Initial session_start: rev-parse + status + remote (3 calls)
			assert.equal(h.gitCalls.length, 3);
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "remote").length, 1);

			// 5 rapid tool_execution_end events coalesce into 1 debounced update (2 git calls, remote cached)
			for (let i = 0; i < 5; i++) {
				h.emit("tool_execution_end", ctx);
			}
			await new Promise((r) => setTimeout(r, 60));
			assert.equal(h.gitCalls.length, 5);
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "remote").length, 1);

			// agent_end cancels pending debounce and updates immediately without re-running remote
			h.emit("tool_execution_end", ctx);
			h.emit("agent_end", ctx);
			await new Promise((r) => setTimeout(r, 50));
			assert.equal(h.gitCalls.length, 7);
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "remote").length, 1);
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("cancels pending debounced updates on session_shutdown", async () => {
		const h = makeHarness({ debounceMs: 30 });
		const ctx = h.makeCtx(true, "/repo-shutdown");
		h.emit("tool_execution_end", ctx);
		h.emit("session_shutdown", {});
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(h.gitCalls.length, 0);
	});
});
