/**
 * Unit tests for opt-in post-merge PR retrospective (issue #1343):
 * - Deterministic $0 collector (digest, session telemetry, repo signals, budget, trivial filter, dedupe)
 * - Orchestrator extension hook (setting gate, oneshot skip, subagent-child guard, bash & github-expert triggers)
 * - Conditional rule assembly in rules/20-code-review-loop.md (0 tokens when off)
 * - Manual /retro prompt template contract
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	classifyTrivialPr,
	collectPrRetro,
	encodeSessionDirPrefix,
	fitDigestBudget,
	isAlreadyRetroed,
	loadRetroState,
	scanRepoSignals,
	scanSessionLogs,
} from "../../../scripts/pr-retro-collect.mjs";
import {
	buildRetroFollowUpPrompt,
	detectMergedPrFromBash,
	detectMergedPrFromSubagent,
	registerPrRetro,
} from "../../../extensions/orchestrator/pr-retro.js";
import {
	clearSettingsCache,
	getSetting,
	setGlobalSettingsPath,
	SETTINGS_KEYS,
} from "../../../extensions/orchestrator/project-settings.js";
import { assembleRuleText } from "../../../extensions/orchestrator/rule-placeholders.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

const RULE_20 = readFileSync(
	new URL("../../../rules/20-code-review-loop.md", import.meta.url),
	"utf-8",
);
const RETRO_PROMPT = readFileSync(
	new URL("../../../prompts/retro.md", import.meta.url),
	"utf-8",
);

interface FakePiHarness {
	pi: ExtensionAPI;
	handlers: Map<string, Array<(event: any, ctx: any) => any>>;
}

function createFakePi(): FakePiHarness {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const pi = {
		on(eventName: string, handler: (event: any, ctx: any) => any) {
			const list = handlers.get(eventName) ?? [];
			list.push(handler);
			handlers.set(eventName, list);
		},
		sendMessage: async () => {},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function makeSamplePr(overrides: Record<string, unknown> = {}) {
	return {
		number: 1343,
		title: "feat(orchestrator): add opt-in post-merge PR retrospective",
		url: "https://github.com/myk-org/pi-config/pull/1343",
		state: "MERGED",
		createdAt: "2026-04-10T10:00:00Z",
		mergedAt: "2026-04-10T12:00:00Z",
		baseRefName: "main",
		headRefName: "feat/issue-1343-pr-retro-on-merge",
		additions: 120,
		deletions: 15,
		changedFiles: 6,
		author: { login: "myakove" },
		commits: [{ oid: "1111111222222", messageHeadline: "feat(orchestrator): add pr-retro" }],
		reviews: [],
		statusCheckRollup: [{ name: "tests", conclusion: "SUCCESS" }],
		...overrides,
	};
}

describe("pr-retro collector", () => {
	let tmpRepo: string;
	let tmpSessions: string;

	beforeEach(() => {
		tmpRepo = makeTempDir("pi-pr-retro-repo-");
		tmpSessions = makeTempDir("pi-pr-retro-sessions-");
	});

	afterEach(() => {
		rmSync(tmpRepo, { recursive: true, force: true });
		rmSync(tmpSessions, { recursive: true, force: true });
	});

	it("classifies version-bump and trivial PRs accurately", () => {
		assert.deepEqual(
			classifyTrivialPr(makeSamplePr({ title: "chore: bump version 5.0.1", additions: 50, deletions: 2 })).reason,
			"version_bump",
		);
		assert.deepEqual(
			classifyTrivialPr(makeSamplePr({ headRefName: "chore/bump-version", additions: 50, deletions: 2 })).reason,
			"version_bump",
		);
		assert.deepEqual(
			classifyTrivialPr(makeSamplePr({ additions: 10, deletions: 5 })).reason,
			"trivial_pr",
		);
		// <20 lines but has review findings -> do NOT skip
		assert.equal(
			classifyTrivialPr(makeSamplePr({ additions: 5, deletions: 2 }), [{ id: 1, body: "Fix edge case" }]).skip,
			false,
		);
		// <20 lines but has CI failure -> do NOT skip
		assert.equal(
			classifyTrivialPr(
				makeSamplePr({
					additions: 5,
					deletions: 2,
					statusCheckRollup: [{ name: "lint", conclusion: "FAILURE" }],
				}),
			).skip,
			false,
		);
		// >=20 lines -> do NOT skip
		assert.equal(classifyTrivialPr(makeSamplePr({ additions: 15, deletions: 5 })).skip, false);
	});

	it("scans project & worktree session JSONLs while excluding sibling repos", () => {
		const prefix = encodeSessionDirPrefix(tmpRepo);
		const mainDir = join(tmpSessions, `${prefix}--`);
		const wtDir = join(tmpSessions, `${prefix}-.worktrees-issue-1343--`);
		const siblingDir = join(tmpSessions, `${prefix}-other--`);
		mkdirSync(mainDir, { recursive: true });
		mkdirSync(wtDir, { recursive: true });
		mkdirSync(siblingDir, { recursive: true });

		const bigText = "X".repeat(5000);
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: join(tmpRepo, ".worktrees/issue-1343") }),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", name: "bash", arguments: { command: "npm run typecheck" } },
						{ type: "toolCall", name: "bash", arguments: { command: "npm run typecheck" } },
						{ type: "toolCall", name: "bash", arguments: { command: "npm run typecheck" } },
						{ type: "toolCall", name: "TaskList", arguments: {} },
						{ type: "toolCall", name: "TaskUpdate", arguments: {} },
						{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
					],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "Error: command failed for #1343" }],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: bigText }],
				},
			}),
		];
		writeFileSync(join(wtDir, "session-1.jsonl"), lines.join("\n") + "\n");

		// Sibling repo with shared dir prefix must be rejected via session header cwd
		writeFileSync(
			join(siblingDir, "sibling.jsonl"),
			[
				JSON.stringify({ type: "session", version: 3, id: "s2", cwd: `${tmpRepo}-other` }),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "edit", arguments: {} }],
					},
				}),
			].join("\n") + "\n",
		);

		const stats = scanSessionLogs({
			sessionsDir: tmpSessions,
			repoRoot: tmpRepo,
			prNumber: 1343,
			headRefName: "feat/issue-1343-pr-retro-on-merge",
		});

		assert.equal(stats.sessionsScanned, 1);
		assert.equal(stats.sessionFilesMatched, 1);
		assert.equal(stats.totalToolCalls, 6);
		assert.equal(stats.toolCounts.bash, 3);
		assert.equal(stats.toolCounts.edit, undefined, "sibling repo session must be ignored");
		assert.equal(stats.errorCount, 1);
		assert.equal(stats.largeOutputCount, 1);
		assert.equal(stats.largeOutputs[0]?.bytes, 5000);
		assert.equal(stats.repeatedCommands.length, 1);
		assert.equal(stats.repeatedCommands[0]?.cmd, "npm run typecheck");
		assert.equal(stats.repeatedCommands[0]?.count, 3);
		assert.equal(stats.taskListChurn.total, 2);
	});

	it("scans steering files and CI/lint configs", () => {
		writeFileSync(join(tmpRepo, "AGENTS.md"), "# Agents\nline2\n");
		mkdirSync(join(tmpRepo, "rules"), { recursive: true });
		writeFileSync(join(tmpRepo, "rules", "00-core.md"), "# Core\n");
		writeFileSync(join(tmpRepo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }));
		writeFileSync(join(tmpRepo, "tox.toml"), "requires = ['tox>=4']\n");
		writeFileSync(
			join(tmpRepo, ".pre-commit-config.yaml"),
			"repos:\n  - repo: local\n    hooks:\n      - id: ruff\n      - id: tsc-typecheck\n",
		);
		mkdirSync(join(tmpRepo, ".github", "workflows"), { recursive: true });
		writeFileSync(join(tmpRepo, ".github", "workflows", "ci.yml"), "name: CI\n");

		const signals = scanRepoSignals(tmpRepo);
		assert.equal(signals.steeringFiles["AGENTS.md"]?.lines, 3);
		assert.equal(signals.steeringFiles["rules/"]?.files, 1);
		assert.equal(signals.checks.hasToxToml, true);
		assert.equal(signals.checks.hasPreCommit, true);
		assert.deepEqual(signals.checks.packageJsonScripts, ["typecheck"]);
		assert.deepEqual(signals.checks.preCommitHooks, ["ruff", "tsc-typecheck"]);
		assert.deepEqual(signals.checks.workflows, ["ci.yml"]);
	});

	it("enforces the compact JSON digest byte budget", () => {
		const huge = {
			status: "collected",
			pr: {
				number: 99,
				commits: Array.from({ length: 12 }, (_, i) => ({ sha: `abc000${i}`, msg: "M".repeat(80) })),
				reviewSample: Array.from({ length: 8 }, (_, i) => ({
					path: `file${i}.ts`,
					line: i,
					author: "bot",
					summary: "R".repeat(300),
				})),
			},
			sessions: {
				errorSamples: Array.from({ length: 8 }, () => ({ tool: "bash", snippet: "E".repeat(300) })),
				largeOutputs: Array.from({ length: 6 }, () => ({ tool: "read", bytes: 9999, preview: "L".repeat(300) })),
				repeatedCommands: Array.from({ length: 8 }, (_, i) => ({ cmd: `cmd-${i}-${"A".repeat(200)}`, count: 5 })),
			},
			repo: { checks: { preCommitHooks: Array.from({ length: 20 }, (_, i) => `hook-name-${i}`) } },
		};
		const trimmed = fitDigestBudget(huge, 3000);
		assert.ok(Buffer.byteLength(JSON.stringify(trimmed), "utf-8") <= 3000);
		assert.equal(trimmed.truncated, true);
	});

	it("deduplicates via .pi/data/pr-retro-state.json and respects --force", () => {
		const prDataOverride = {
			pr: makeSamplePr(),
			inlineComments: [{ id: 10, path: "extensions/orchestrator/pr-retro.ts", line: 12, body: "Check edge case", user: { login: "qodo" } }],
			repoSlug: "myk-org/pi-config",
		};
		const fakeExec = () => {
			throw new Error("should not invoke git/gh");
		};

		const first = collectPrRetro({
			pr: "1343",
			cwd: tmpRepo,
			repo: "myk-org/pi-config",
			sessionsDir: tmpSessions,
			execFn: fakeExec,
			prDataOverride,
		});
		assert.equal(first.status, "collected");
		assert.equal(first.key, "myk-org/pi-config#1343");
		assert.ok(Buffer.byteLength(JSON.stringify(first), "utf-8") <= 5120);

		const state = loadRetroState(join(tmpRepo, ".pi", "data"));
		assert.equal(isAlreadyRetroed(state, "myk-org/pi-config#1343"), true);

		const second = collectPrRetro({
			pr: "1343",
			cwd: tmpRepo,
			repo: "myk-org/pi-config",
			sessionsDir: tmpSessions,
			execFn: fakeExec,
			prDataOverride,
		});
		assert.equal(second.status, "skipped");
		assert.equal(second.reason, "already_retroed");

		const forced = collectPrRetro({
			pr: "1343",
			cwd: tmpRepo,
			repo: "myk-org/pi-config",
			sessionsDir: tmpSessions,
			force: true,
			execFn: fakeExec,
			prDataOverride,
		});
		assert.equal(forced.status, "collected");
	});

	it("skips trivial PR by default and collects when force: true", () => {
		const prDataOverride = {
			pr: makeSamplePr({ number: 55, additions: 3, deletions: 1 }),
			inlineComments: [],
			repoSlug: "myk-org/pi-config",
		};
		const fakeExec = () => {
			throw new Error("should not invoke git/gh");
		};

		const skipped = collectPrRetro({
			pr: "55",
			cwd: tmpRepo,
			repo: "myk-org/pi-config",
			sessionsDir: tmpSessions,
			execFn: fakeExec,
			prDataOverride,
		});
		assert.equal(skipped.status, "skipped");
		assert.equal(skipped.reason, "trivial_pr");

		const forced = collectPrRetro({
			pr: "55",
			cwd: tmpRepo,
			repo: "myk-org/pi-config",
			sessionsDir: tmpSessions,
			force: true,
			execFn: fakeExec,
			prDataOverride,
		});
		assert.equal(forced.status, "collected");
		assert.equal(forced.trivialHint, "trivial_pr");
	});
});

describe("pr-retro extension hook", () => {
	let tmpRepo: string;
	let tmpGlobal: string;
	const prevEnv = process.env.PI_PR_RETRO_ON_MERGE;

	beforeEach(() => {
		clearSettingsCache();
		tmpRepo = makeTempDir("pi-pr-retro-ext-");
		tmpGlobal = makeTempDir("pi-pr-retro-global-");
		setGlobalSettingsPath(join(tmpGlobal, "pi-config-settings.json"));
		delete process.env.PI_PR_RETRO_ON_MERGE;
	});

	afterEach(() => {
		setGlobalSettingsPath(null);
		clearSettingsCache();
		rmSync(tmpRepo, { recursive: true, force: true });
		rmSync(tmpGlobal, { recursive: true, force: true });
		if (prevEnv === undefined) delete process.env.PI_PR_RETRO_ON_MERGE;
		else process.env.PI_PR_RETRO_ON_MERGE = prevEnv;
	});

	it("defaults pr_retro_on_merge to false and honors project/env overrides", () => {
		assert.equal(getSetting(tmpRepo, "pr_retro_on_merge"), false);
		process.env.PI_PR_RETRO_ON_MERGE = "true";
		assert.equal(getSetting(tmpRepo, "pr_retro_on_merge"), true);
		delete process.env.PI_PR_RETRO_ON_MERGE;

		mkdirSync(join(tmpRepo, ".pi"), { recursive: true });
		writeFileSync(join(tmpRepo, ".pi", "pi-config-settings.json"), JSON.stringify({ pr_retro_on_merge: true }));
		clearSettingsCache();
		assert.equal(getSetting(tmpRepo, "pr_retro_on_merge"), true);
	});

	it("detects gh pr merge from bash commands and rejects non-merge/help/dry-run", () => {
		assert.deepEqual(
			detectMergedPrFromBash("gh pr merge 1343 --squash", "✓ Squashed and merged pull request #1343"),
			{ prNumber: 1343, repo: null },
		);
		assert.deepEqual(
			detectMergedPrFromBash("gh pr merge https://github.com/myk-org/pi-config/pull/42 --merge", ""),
			{ prNumber: 42, repo: "myk-org/pi-config" },
		);
		assert.deepEqual(
			detectMergedPrFromBash("gh -R myk-org/pi-config pr merge --squash", "Merged pull request #77"),
			{ prNumber: 77, repo: "myk-org/pi-config" },
		);
		assert.equal(detectMergedPrFromBash("gh pr merge --help", "Usage: gh pr merge"), null);
		assert.equal(detectMergedPrFromBash("echo 'gh pr merge 123'", "gh pr merge 123"), null);
		assert.equal(detectMergedPrFromBash("gh pr merge 123", "merge failed: checks pending"), null);
	});

	it("detects PR merge from synchronous github-expert subagent results only", () => {
		assert.deepEqual(
			detectMergedPrFromSubagent(
				{ agent: "github-expert", task: "Merge PR #88 with squash" },
				"✓ Merged pull request #88 (https://github.com/myk-org/pi-config/pull/88)",
			),
			{ prNumber: 88, repo: "myk-org/pi-config" },
		);
		assert.equal(
			detectMergedPrFromSubagent(
				{ agent: "github-expert", task: "Merge PR #88", async: true },
				"Spawned async agent github-expert",
			),
			null,
		);
		assert.equal(
			detectMergedPrFromSubagent(
				{ agent: "git-expert", task: "Merge branch feature" },
				"Merged PR #88",
			),
			null,
		);
		assert.equal(
			detectMergedPrFromSubagent(
				{ agent: "github-expert", task: "Merge PR #88" },
				"Failed to merge PR #88: branch protection",
			),
			null,
		);
	});

	it("is a complete no-op when pr_retro_on_merge is false (default)", () => {
		const notes: string[] = [];
		const { pi, handlers } = createFakePi();
		withSubagentChildEnv(undefined, () => {
			registerPrRetro(pi, {
				argv: ["node", "pi"],
				sendNote: async (_api, text) => {
					notes.push(text);
				},
			});
			return undefined;
		});
		const toolResult = handlers.get("tool_result")?.[0];
		assert.ok(toolResult);

		toolResult(
			{
				toolName: "bash",
				isError: false,
				input: { command: "gh pr merge 1343 --squash" },
				content: [{ type: "text", text: "✓ Squashed and merged pull request #1343" }],
			},
			{ cwd: tmpRepo },
		);
		assert.equal(notes.length, 0);
	});

	it("emits non-blocking follow-up on bash and github-expert merges when enabled and deduplicates", () => {
		mkdirSync(join(tmpRepo, ".pi"), { recursive: true });
		writeFileSync(join(tmpRepo, ".pi", "pi-config-settings.json"), JSON.stringify({ pr_retro_on_merge: true }));
		clearSettingsCache();

		const notes: string[] = [];
		const { pi, handlers } = createFakePi();
		withSubagentChildEnv(undefined, () => {
			registerPrRetro(pi, {
				argv: ["node", "pi"],
				collectorPath: "/opt/pr-retro-collect.mjs",
				sendNote: async (_api, text) => {
					notes.push(text);
				},
			});
			return undefined;
		});
		const toolResult = handlers.get("tool_result")?.[0];
		assert.ok(toolResult);

		// First bash merge triggers
		toolResult(
			{
				toolName: "bash",
				isError: false,
				input: { command: "gh pr merge https://github.com/myk-org/pi-config/pull/101 --squash" },
				content: [{ type: "text", text: "✓ Merged pull request #101" }],
			},
			{ cwd: tmpRepo },
		);
		assert.equal(notes.length, 1);
		assert.match(notes[0]!, /--pr 101/);
		assert.match(notes[0]!, /Never auto-edit `AGENTS\.md`/);

		// Repeat same PR in same session is deduplicated
		toolResult(
			{
				toolName: "bash",
				isError: false,
				input: { command: "gh pr merge https://github.com/myk-org/pi-config/pull/101 --squash" },
				content: [{ type: "text", text: "✓ Merged pull request #101" }],
			},
			{ cwd: tmpRepo },
		);
		assert.equal(notes.length, 1);

		// Subagent github-expert merge for another PR triggers
		toolResult(
			{
				toolName: "subagent",
				isError: false,
				input: { agent: "github-expert", task: "Run gh pr merge 102" },
				content: [{ type: "text", text: "Successfully merged pull request #102 (https://github.com/myk-org/pi-config/pull/102)" }],
			},
			{ cwd: tmpRepo },
		);
		assert.equal(notes.length, 2);
		assert.match(notes[1]!, /--pr 102/);

		// PR already recorded on disk in .pi/data/pr-retro-state.json is skipped
		mkdirSync(join(tmpRepo, ".pi", "data"), { recursive: true });
		writeFileSync(
			join(tmpRepo, ".pi", "data", "pr-retro-state.json"),
			JSON.stringify({ version: 1, retroed: { "myk-org/pi-config#103": { at: "2026-04-10T00:00:00Z" } } }),
		);
		toolResult(
			{
				toolName: "bash",
				isError: false,
				input: { command: "gh pr merge https://github.com/myk-org/pi-config/pull/103 --squash" },
				content: [{ type: "text", text: "✓ Merged pull request #103" }],
			},
			{ cwd: tmpRepo },
		);
		assert.equal(notes.length, 2);
	});

	it("skips registration in oneshot mode (-p / --mode json)", () => {
		for (const argv of [
			["node", "pi", "-p", "hello"],
			["node", "pi", "--mode", "json", "hello"],
		]) {
			const { pi, handlers } = createFakePi();
			withSubagentChildEnv(undefined, () => {
				registerPrRetro(pi, { argv });
				return undefined;
			});
			assert.equal(handlers.size, 0, `expected zero handlers for argv ${argv.join(" ")}`);
		}
	});

	it("skips registration when PI_SUBAGENT_CHILD=1", () => {
		const { pi, handlers } = createFakePi();
		withSubagentChildEnv("1", () => {
			registerPrRetro(pi, { argv: ["node", "pi"] });
			return undefined;
		});
		assert.equal(handlers.size, 0);
	});

	it("builds concise follow-up prompt with collector args and read-only guardrails", () => {
		const prompt = buildRetroFollowUpPrompt({
			prNumber: 77,
			repo: "myk-org/pi-config",
			cwd: "/tmp/repo",
			collectorPath: "/opt/pr-retro-collect.mjs",
		});
		assert.match(prompt, /--pr 77/);
		assert.match(prompt, /--repo "myk-org\/pi-config"/);
		assert.match(prompt, /\.pi\/data\/retros\/pr-77\.md/);
		assert.match(prompt, /never auto-file GitHub issues/i);
	});
});

describe("pr-retro conditional rule assembly & /retro prompt", () => {
	const knownKeys = new Set(Object.keys(SETTINGS_KEYS));

	it("emits zero retro text in rules/20-code-review-loop.md when pr_retro_on_merge is false", () => {
		const assembled = assembleRuleText([RULE_20], {
			resolve: (key) => (key === "pr_retro_on_merge" ? false : false),
			knownKeys,
			featurePredicates: {},
			reviewLoopMaxCycles: 3,
		});
		assert.doesNotMatch(assembled, /Post-Merge PR Retrospective/);
		assert.doesNotMatch(assembled, /pr-retro-collect\.mjs/);
	});

	it("injects the Post-Merge PR Retrospective block when pr_retro_on_merge is true", () => {
		const assembled = assembleRuleText([RULE_20], {
			resolve: (key) => key === "pr_retro_on_merge",
			knownKeys,
			featurePredicates: {},
			reviewLoopMaxCycles: 3,
		});
		assert.match(assembled, /## Post-Merge PR Retrospective/);
		assert.match(assembled, /completedBy: "user"/);
		assert.match(assembled, /\.pi\/data\/retros\/pr-<N>\.md/);
		assert.match(assembled, /Never auto-edit `AGENTS\.md`\/`rules\/`/);
	});

	it("prompts/retro.md includes all 7 retro categories and read-only guardrails", () => {
		assert.match(RETRO_PROMPT, /\$ARGUMENTS/);
		assert.match(RETRO_PROMPT, /pr-retro-collect\.mjs/);
		for (const category of [
			"Navigation",
			"Automated checks",
			"Coding standards (mechanical vs judgement)",
			"Global `AGENTS.md`",
			"Tool economy",
			"No-ops",
			"Information access",
		]) {
			assert.ok(RETRO_PROMPT.includes(category), `missing retro category: ${category}`);
		}
		assert.match(RETRO_PROMPT, /\.pi\/data\/retros\/pr-<N>\.md/);
		assert.match(RETRO_PROMPT, /\*\*Never\*\* automatically edit `AGENTS\.md`/);
	});
});
