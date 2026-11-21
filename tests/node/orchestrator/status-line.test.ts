import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { registerStatusLine } from "../../../extensions/orchestrator/status-line.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

function makeHarness(opts: {
	debounceMs?: number;
	githubRepoCacheTtlMs?: number;
	worktreeCacheTtlMs?: number;
	remoteFailFirst?: boolean;
	worktreePorcelain?: string | (() => string);
	hasLinkedWorktreesHint?: (cwd: string) => boolean | null;
	detachedHead?: boolean;
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
		if (args[0] === "rev-parse") {
			return opts.detachedHead ? { stdout: "HEAD", code: 0 } : { stdout: "feat/test", code: 0 };
		}
		if (args[0] === "symbolic-ref") {
			return opts.detachedHead ? { stdout: "", code: 128 } : { stdout: "refs/heads/feat/test", code: 0 };
		}
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

	const presenceHint =
		opts.hasLinkedWorktreesHint ??
		(opts.worktreePorcelain !== undefined ? () => true : () => false);

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
				hasLinkedWorktreesHint: presenceHint,
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

	it("renders [wt] tag in git slot inside a linked worktree (#1316)", async () => {
		const porcelain = [
			"worktree /repo",
			"HEAD aaa",
			"branch refs/heads/main",
			"",
			"worktree /repo/.worktrees/feat-a",
			"HEAD bbb",
			"branch refs/heads/feat/a",
			"",
		].join("\n");
		const h = makeHarness({ worktreePorcelain: porcelain });
		try {
			const ctx = h.makeCtx(true, "/repo/.worktrees/feat-a");
			h.emit("session_start", ctx);
			await new Promise((r) => setTimeout(r, 20));
			const gitSlot = h.statuses.find((s) => s.key === "4-git");
			assert.ok(gitSlot?.text?.includes("[wt]"), `expected [wt] in git slot, got: ${gitSlot?.text}`);
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("renders 4a-worktrees badge with linked worktree count (#1316)", async () => {
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
			const wtSlot = h.statuses.find((s) => s.key === "4a-worktrees");
			assert.equal(wtSlot?.text, "⊞ 2 wt");
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("omits [wt] tag when on the main checkout (#1316)", async () => {
		const h = makeHarness({
			worktreePorcelain:
				"worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo/.worktrees/wt1\nHEAD bbb\nbranch refs/heads/feat/x\n",
		});
		try {
			const ctx = h.makeCtx(true, "/repo");
			h.emit("session_start", ctx);
			await new Promise((r) => setTimeout(r, 20));
			const gitSlot = h.statuses.find((s) => s.key === "4-git");
			assert.ok(gitSlot?.text && !gitSlot.text.includes("[wt]"), "main checkout must not show [wt]");
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("clears 4a-worktrees badge when linked count drops to 0 (#1316)", async () => {
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
			assert.equal(h.statuses.filter((s) => s.key === "4a-worktrees").at(-1)?.text, "⊞ 1 wt");

			hasLinked = false;
			h.pi.events.emit("orchestrator:worktrees-changed", {});
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(h.statuses.filter((s) => s.key === "4a-worktrees").at(-1)?.text, undefined);
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("avoids extra git worktree calls in single-checkout repositories (#1316)", async () => {
		const repoDir = makeTempDir("status-line-single-");
		execFileSync("git", ["init", "-q"], { cwd: repoDir });
		const gitCalls: string[][] = [];
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const handlers = new Map<string, Array<(e: unknown, ctx: any) => void>>();
		const pi: any = {
			on(ev: string, fn: (e: unknown, ctx: any) => void) {
				handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
			},
			events: { on() {}, emit() {} },
		};
		try {
			withSubagentChildEnv(undefined, () => {
				registerStatusLine(pi, false, () => {}, {
					runGitAsync: async (args) => {
						gitCalls.push(args);
						if (args[0] === "rev-parse") return { stdout: "main", code: 0 };
						if (args[0] === "status") return { stdout: "", code: 0 };
						if (args[0] === "remote") return { stdout: "", code: 128 };
						return { stdout: "", code: 0 };
					},
					debounceMs: 10,
				});
			});
			const ctx = {
				hasUI: true,
				cwd: repoDir,
				ui: {
					theme: { fg: (_c: string, t: string) => t },
					setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
				},
			};
			for (const fn of handlers.get("session_start") ?? []) fn({}, ctx);
			await new Promise((r) => setTimeout(r, 25));
			for (const fn of handlers.get("agent_end") ?? []) fn({}, ctx);
			await new Promise((r) => setTimeout(r, 25));
			assert.equal(gitCalls.some((a) => a[0] === "worktree"), false);
			assert.equal(statuses.some((s) => s.key === "4a-worktrees"), false);
		} finally {
			for (const fn of handlers.get("session_shutdown") ?? []) fn({}, {});
			rmSync(repoDir, { recursive: true, force: true });
		}
	});

	it("skips worktree lookup in non-git directories (#1316)", async () => {
		const h = makeHarness({ notGitRepo: true, hasLinkedWorktreesHint: () => null });
		try {
			const ctx = h.makeCtx(true, "/plain-dir");
			h.emit("session_start", ctx);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(h.gitCalls.some((c) => c.args[0] === "worktree"), false);
			assert.equal(h.statuses.some((s) => s.key === "4a-worktrees"), false);
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("shows worktree status for detached HEAD linked checkouts (#1316)", async () => {
		const porcelain = [
			"worktree /repo",
			"HEAD aaa",
			"branch refs/heads/main",
			"",
			"worktree /repo/.worktrees/detached",
			"HEAD bbb",
			"detached",
			"",
		].join("\n");
		const h = makeHarness({ detachedHead: true, worktreePorcelain: porcelain });
		try {
			const ctx = h.makeCtx(true, "/repo/.worktrees/detached");
			h.emit("session_start", ctx);
			await new Promise((r) => setTimeout(r, 20));
			const gitSlot = h.statuses.find((s) => s.key === "4-git");
			const wtSlot = h.statuses.find((s) => s.key === "4a-worktrees");
			assert.ok(gitSlot?.text?.includes("[wt]"), `expected [wt] for detached linked worktree, got: ${gitSlot?.text}`);
			assert.equal(wtSlot?.text, "⊞ 1 wt");
		} finally {
			h.emit("session_shutdown", {});
		}
	});

	it("writes 4a-worktrees badge to a replacement context with unchanged linked count (#1316)", async () => {
		const porcelain =
			"worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo/.worktrees/wt1\nHEAD bbb\nbranch refs/heads/feat/x\n";
		const h = makeHarness({ worktreePorcelain: porcelain });
		try {
			const ctx1Statuses: Array<{ key: string; text: string | undefined }> = [];
			const ctx2Statuses: Array<{ key: string; text: string | undefined }> = [];
			const ctx1 = {
				hasUI: true,
				cwd: "/repo",
				ui: {
					theme: { fg: (_c: string, t: string) => t },
					setStatus: (key: string, text: string | undefined) => ctx1Statuses.push({ key, text }),
				},
			};
			const ctx2 = {
				hasUI: true,
				cwd: "/repo",
				ui: {
					theme: { fg: (_c: string, t: string) => t },
					setStatus: (key: string, text: string | undefined) => ctx2Statuses.push({ key, text }),
				},
			};

			h.emit("session_start", ctx1);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(ctx1Statuses.find((s) => s.key === "4a-worktrees")?.text, "⊞ 1 wt");

			h.emit("session_start", ctx2);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(ctx2Statuses.find((s) => s.key === "4a-worktrees")?.text, "⊞ 1 wt");
		} finally {
			h.emit("session_shutdown", {});
		}
	});
});
