import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerStatusLine } from "../../../extensions/orchestrator/status-line.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

function makeHarness(opts: {
	debounceMs?: number;
	githubRepoCacheTtlMs?: number;
	worktreeCacheTtlMs?: number;
	remoteFailFirst?: boolean;
	worktreePorcelain?: string | (() => string);
	notGitRepo?: boolean;
} = {}) {
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
	const eventBus = new Map<string, Array<(data?: unknown) => void>>();
	const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	let notifyCalls = 0;
	let remoteCalls = 0;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: any) => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		events: {
			on(ch: string, fn: (data?: unknown) => void) {
				const list = eventBus.get(ch) ?? [];
				list.push(fn);
				eventBus.set(ch, list);
			},
			emit(ch: string, data?: unknown) {
				for (const fn of eventBus.get(ch) ?? []) fn(data);
			},
		},
	};

	const runGitAsync = async (args: string[], cwd?: string) => {
		gitCalls.push({ args, cwd });
		if (opts.notGitRepo) return { stdout: "", code: 128 };
		if (args[0] === "rev-parse") return { stdout: "feat/test", code: 0 };
		if (args[0] === "status") return { stdout: " M a.ts\n?? b.ts\n", code: 0 };
		if (args[0] === "remote") {
			remoteCalls++;
			if (opts.remoteFailFirst && remoteCalls === 1) return { stdout: "", code: 128 };
			return { stdout: "https://github.com/myk-org/pi-config.git", code: 0 };
		}
		if (args[0] === "worktree") {
			const out =
				typeof opts.worktreePorcelain === "function"
					? opts.worktreePorcelain()
					: (opts.worktreePorcelain ?? "");
			return { stdout: out, code: 0 };
		}
		return { stdout: "", code: 0 };
	};

	withSubagentChildEnv(undefined, () => {
		registerStatusLine(
			pi as any,
			false,
			() => {
				notifyCalls++;
			},
			{
				runGitAsync,
				debounceMs: opts.debounceMs ?? 20,
				githubRepoCacheTtlMs: opts.githubRepoCacheTtlMs,
				worktreeCacheTtlMs: opts.worktreeCacheTtlMs,
			},
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

	return { handlers, eventBus, pi, gitCalls, statuses, makeCtx, emit, getNotifyCalls: () => notifyCalls };
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
			// Initial session_start: rev-parse + status + remote + worktree (4 calls)
			assert.equal(h.gitCalls.length, 4);
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "remote").length, 1);
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "worktree").length, 1);

			// 5 rapid tool_execution_end events coalesce into 1 debounced update (2 git calls, remote & worktree cached)
			for (let i = 0; i < 5; i++) {
				h.emit("tool_execution_end", ctx);
			}
			await new Promise((r) => setTimeout(r, 60));
			assert.equal(h.gitCalls.length, 6);
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "remote").length, 1);
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "worktree").length, 1);

			// agent_end cancels pending debounce and updates immediately without re-running remote or worktree
			h.emit("tool_execution_end", ctx);
			h.emit("agent_end", ctx);
			await new Promise((r) => setTimeout(r, 50));
			assert.equal(h.gitCalls.length, 8);
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "remote").length, 1);
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "worktree").length, 1);
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("does not cache failed remote lookups and refreshes cached classification after TTL", async () => {
		const h = makeHarness({ debounceMs: 10, githubRepoCacheTtlMs: 250, remoteFailFirst: true });
		try {
			const ctx = h.makeCtx(true, "/repo-retry");
			// First call fails remote check (code 128) — must NOT be cached
			h.emit("session_start", ctx);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "remote").length, 1);

			// Second call immediately retries remote and caches the success
			h.emit("agent_end", ctx);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "remote").length, 2);

			// Within TTL, cached success is reused
			h.emit("agent_end", ctx);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "remote").length, 2);

			// After TTL expires, remote is re-checked
			await new Promise((r) => setTimeout(r, 280));
			h.emit("agent_end", ctx);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "remote").length, 3);
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

	it("renders [wt] tag in git slot and 4a-worktrees badge when inside a linked worktree (#1316)", async () => {
		const porcelain = [
			"worktree /repo",
			"HEAD aaa",
			"branch refs/heads/main",
			"",
			"worktree /repo/.worktrees/feat-a",
			"HEAD bbb",
			"branch refs/heads/feat/a",
			"",
			"worktree /repo/.worktrees/feat-b",
			"HEAD ccc",
			"branch refs/heads/feat/b",
			"",
		].join("\n");
		const h = makeHarness({ worktreePorcelain: porcelain });
		try {
			const ctx = h.makeCtx(true, "/repo/.worktrees/feat-a");
			h.emit("session_start", ctx);
			await new Promise((r) => setTimeout(r, 20));
			const gitSlot = h.statuses.find((s) => s.key === "4-git");
			const wtSlot = h.statuses.find((s) => s.key === "4a-worktrees");
			assert.ok(gitSlot?.text?.includes("[wt]"), `expected [wt] in git slot, got: ${gitSlot?.text}`);
			assert.equal(wtSlot?.text, "⊞ 2 wt");
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("omits [wt] and 4a-worktrees badge in single-checkout repos and clears badge when linked count drops to 0 (#1316)", async () => {
		let hasLinked = true;
		const h = makeHarness({
			worktreeCacheTtlMs: 5_000,
			worktreePorcelain: () =>
				hasLinked
					? "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo/.worktrees/wt1\nHEAD bbb\nbranch refs/heads/feat/x\n"
					: "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n",
		});
		try {
			const ctx = h.makeCtx(true, "/repo");
			h.emit("session_start", ctx);
			await new Promise((r) => setTimeout(r, 20));
			const gitSlot = h.statuses.find((s) => s.key === "4-git");
			assert.ok(gitSlot?.text && !gitSlot.text.includes("[wt]"), "main checkout must not show [wt]");
			assert.equal(h.statuses.filter((s) => s.key === "4a-worktrees").at(-1)?.text, "⊞ 1 wt");

			// Linked worktree removed -> orchestrator:worktrees-changed clears the 4a-worktrees slot
			hasLinked = false;
			h.pi.events.emit("orchestrator:worktrees-changed", {});
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(h.statuses.filter((s) => s.key === "4a-worktrees").at(-1)?.text, undefined);
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("makes zero git worktree calls and sets no worktrees slot in non-git directories (#1316)", async () => {
		const h = makeHarness({ notGitRepo: true });
		try {
			const ctx = h.makeCtx(true, "/plain-dir");
			h.emit("session_start", ctx);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(h.gitCalls.filter((c) => c.args[0] === "worktree").length, 0);
			assert.equal(h.statuses.filter((s) => s.key === "4a-worktrees").length, 0);
		} finally {
			h.emit("session_shutdown", {});
		}
	});
});
