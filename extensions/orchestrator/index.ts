/**
 * Orchestrator Extension for pi
 *
 * Bundles:
 * - Subagent tool (based on pi's subagent example, with package agent discovery)
 * - Enforcement handlers (python/pip, git protection, dangerous commands)
 * - Rule injection (before_agent_start)
 * - Slash commands (/pr-review, /release, /review-local, /query-db)
 * - Notifications and status line
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	DynamicBorder,
	getMarkdownTheme,
	isToolCallEventType,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Input, Markdown, Spacer, Text, matchesKey, Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Subagent tool internals
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens?: number; turns?: number },
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(toolName: string, args: Record<string, unknown>, fg: (c: any, t: string) => string): string {
	const shorten = (p: string) => { const h = os.homedir(); return p.startsWith(h) ? `~${p.slice(h.length)}` : p; };
	switch (toolName) {
		case "bash": { const c = (args.command as string) || "..."; const p = c.length > 60 ? `${c.slice(0, 60)}...` : c; return fg("muted", "$ ") + fg("toolOutput", p); }
		case "read": { const f = shorten((args.file_path || args.path || "...") as string); let t = fg("accent", f); const o = args.offset as number | undefined; const l = args.limit as number | undefined; if (o !== undefined || l !== undefined) { const s = o ?? 1; const e = l !== undefined ? s + l - 1 : ""; t += fg("warning", `:${s}${e ? `-${e}` : ""}`); } return fg("muted", "read ") + t; }
		case "write": { const f = shorten((args.file_path || args.path || "...") as string); const c = (args.content || "") as string; let t = fg("muted", "write ") + fg("accent", f); if (c.split("\n").length > 1) t += fg("dim", ` (${c.split("\n").length} lines)`); return t; }
		case "edit": return fg("muted", "edit ") + fg("accent", shorten((args.file_path || args.path || "...") as string));
		case "ls": return fg("muted", "ls ") + fg("accent", shorten((args.path || ".") as string));
		case "find": return fg("muted", "find ") + fg("accent", (args.pattern || "*") as string) + fg("dim", ` in ${shorten((args.path || ".") as string)}`);
		case "grep": return fg("muted", "grep ") + fg("accent", `/${(args.pattern || "") as string}/`) + fg("dim", ` in ${shorten((args.path || ".") as string)}`);
		default: { const s = JSON.stringify(args); return fg("accent", toolName) + fg("dim", ` ${s.length > 50 ? s.slice(0, 50) + "..." : s}`); }
	}
}

interface UsageStats { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number; }
interface SingleResult { agent: string; agentSource: "user" | "project" | "package" | "unknown"; task: string; exitCode: number; messages: Message[]; stderr: string; usage: UsageStats; model?: string; stopReason?: string; errorMessage?: string; step?: number; }
interface SubagentDetails { mode: "single" | "parallel" | "chain"; agentScope: AgentScope; projectAgentsDir: string | null; results: SingleResult[]; }
type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m.role === "assistant") for (const p of m.content) if (p.type === "text") return p.text; }
	return "";
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const m of messages) if (m.role === "assistant") for (const p of m.content) { if (p.type === "text") items.push({ type: "text", text: p.text }); else if (p.type === "toolCall") items.push({ type: "toolCall", name: p.name, args: p.arguments }); }
	return items;
}

async function mapWithConcurrency<I, O>(items: I[], concurrency: number, fn: (item: I, i: number) => Promise<O>): Promise<O[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: O[] = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: limit }, async () => { while (true) { const i = next++; if (i >= items.length) return; results[i] = await fn(items[i], i); } }));
	return results;
}

async function writePromptFile(name: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(dir, `prompt-${name.replace(/[^\w.-]+/g, "_")}.md`);
	await withFileMutationQueue(filePath, async () => { await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 }); });
	return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const s = process.argv[1];
	if (s && fs.existsSync(s)) return { command: process.execPath, args: [s, ...args] };
	const e = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(e)) return { command: process.execPath, args };
	return { command: "pi", args };
}

type OnUpdate = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string, agents: AgentConfig[], agentName: string, task: string, cwd: string | undefined, step: number | undefined,
	signal: AbortSignal | undefined, onUpdate: OnUpdate | undefined, makeDetails: (r: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const avail = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return { agent: agentName, agentSource: "unknown", task, exitCode: 1, messages: [], stderr: `Unknown agent: "${agentName}". Available: ${avail}.`, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, step };
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	let tmpFile: string | null = null;

	const cur: SingleResult = { agent: agentName, agentSource: agent.source, task, exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, model: agent.model, step };

	const emit = () => { if (onUpdate) onUpdate({ content: [{ type: "text", text: getFinalOutput(cur.messages) || "(running...)" }], details: makeDetails([cur]) }); };

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptFile(agent.name, agent.systemPrompt);
			tmpDir = tmp.dir; tmpFile = tmp.filePath;
			args.push("--append-system-prompt", tmpFile);
		}
		args.push(`Task: ${task}`);
		let aborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const inv = getPiInvocation(args);
			const proc = spawn(inv.command, inv.args, { cwd: cwd ?? defaultCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buf = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try { ev = JSON.parse(line); } catch { return; }
				if (ev.type === "message_end" && ev.message) {
					const msg = ev.message as Message;
					cur.messages.push(msg);
					if (msg.role === "assistant") {
						cur.usage.turns++;
						const u = msg.usage;
						if (u) { cur.usage.input += u.input || 0; cur.usage.output += u.output || 0; cur.usage.cacheRead += u.cacheRead || 0; cur.usage.cacheWrite += u.cacheWrite || 0; cur.usage.cost += u.cost?.total || 0; cur.usage.contextTokens = u.totalTokens || 0; }
						if (!cur.model && msg.model) cur.model = msg.model;
						if (msg.stopReason) cur.stopReason = msg.stopReason;
						if (msg.errorMessage) cur.errorMessage = msg.errorMessage;
					}
					emit();
				}
				if (ev.type === "tool_result_end" && ev.message) { cur.messages.push(ev.message as Message); emit(); }
			};

			proc.stdout.on("data", (d) => { buf += d.toString(); const lines = buf.split("\n"); buf = lines.pop() || ""; for (const l of lines) processLine(l); });
			proc.stderr.on("data", (d) => { cur.stderr += d.toString(); });
			proc.on("close", (c) => { if (buf.trim()) processLine(buf); resolve(c ?? 0); });
			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => { aborted = true; proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); };
				if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
			}
		});

		cur.exitCode = exitCode;
		if (aborted) throw new Error("Subagent was aborted");
		return cur;
	} finally {
		if (tmpFile) try { fs.unlinkSync(tmpFile); } catch {}
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch {}
	}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Git helpers for enforcement
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function runGit(args: string[], cwd?: string): { stdout: string; code: number } {
	try {
		const stdout = execSync(`git --no-optional-locks ${args.join(" ")}`, { cwd, timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } });
		return { stdout: stdout.trim(), code: 0 };
	} catch (e: any) {
		return { stdout: (e.stdout || "").trim(), code: e.status || 1 };
	}
}

function getCurrentBranch(cwd?: string): string | null {
	const r = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (r.code === 0 && r.stdout && r.stdout !== "HEAD") return r.stdout;
	const s = runGit(["symbolic-ref", "HEAD"], cwd);
	if (s.code === 0 && s.stdout.startsWith("refs/heads/")) return s.stdout.slice("refs/heads/".length);
	return null;
}

function getMainBranch(cwd?: string): string | null {
	for (const b of ["main", "master"]) if (runGit(["rev-parse", "--verify", "--end-of-options", b], cwd).code === 0) return b;
	return null;
}

function isGitRepo(cwd?: string): boolean { return runGit(["rev-parse", "--git-dir"], cwd).code === 0; }

function isGithubRepo(cwd?: string): boolean { const r = runGit(["remote", "get-url", "origin"], cwd); return r.code === 0 && r.stdout.toLowerCase().includes("github.com"); }

function isBranchMerged(branch: string, main: string, cwd?: string): boolean {
	const u = runGit(["rev-list", "--count", `${main}..${branch}`], cwd);
	if (u.code !== 0) return false;
	const n = parseInt(u.stdout, 10);
	if (isNaN(n) || n === 0) return false;
	return runGit(["merge-base", "--is-ancestor", branch, main], cwd).code === 0;
}

function isBranchAhead(cwd?: string): boolean {
	if (runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd).code !== 0) return true;
	const s = runGit(["status", "--short", "--branch"], cwd);
	return s.code === 0 && s.stdout.includes("ahead");
}

function getPrMergeStatus(branch: string, cwd?: string): { merged: boolean | null; info: string | null } {
	if (!isGithubRepo(cwd)) return { merged: false, info: null };
	try {
		const out = execSync(`gh pr list --head "${branch}" --state merged --json number --limit 1`, { cwd, timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
		const data = JSON.parse(out);
		if (Array.isArray(data) && data.length > 0) return { merged: true, info: String(data[0].number || "") };
		return { merged: false, info: null };
	} catch { return { merged: null, info: "Could not check PR status" }; }
}

function hasGitSub(command: string, sub: string): boolean { return new RegExp(`\\bgit\\b(?:\\s+(?:-[a-zA-Z]\\s+\\S+|-\\S+))*\\s+${sub}\\b`).test(command); }

const DANGEROUS = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i, /\bmkfs\b/i, /\bdd\b.*\bof=\/dev\//i];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Extension entry point
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TaskItem = Type.Object({ agent: Type.String({ description: "Agent name" }), task: Type.String({ description: "Task to delegate" }), cwd: Type.Optional(Type.String({ description: "Working directory" })) });
const ChainItem = Type.Object({ agent: Type.String({ description: "Agent name" }), task: Type.String({ description: "Task with optional {previous} placeholder" }), cwd: Type.Optional(Type.String({ description: "Working directory" })) });
const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, { description: 'Agent directories to use. Default: "user".', default: "user" });

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before project agents. Default: true.", default: true })),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Container detection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function isRunningInContainer(): boolean {
	try {
		// Check for /.dockerenv (Docker) or /run/.containerenv (Podman)
		if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")) return true;
		// Check cgroup for container runtimes
		const cgroup = fs.readFileSync("/proc/1/cgroup", "utf-8");
		if (/docker|containerd|kubepods|libpod/.test(cgroup)) return true;
	} catch {}
	return false;
}

const IN_CONTAINER = isRunningInContainer();

export default function (pi: ExtensionAPI) {

	// ── ask_user tool ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: "Present a question to the user with selectable options. Returns the user's choice or free-text input. Use this whenever a workflow needs user input — never ask via plain text.",
		promptSnippet: "Ask the user a question with selectable options",
		promptGuidelines: [
			"Use ask_user when you need user input during a workflow (approvals, selections, confirmations).",
			"Do NOT ask users questions via plain text — always use this tool for structured choices.",
			"Provide clear, concise options. Include a 'no' or 'cancel' option when appropriate.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question to display to the user" }),
			options: Type.Optional(Type.Array(Type.String(), { description: "List of selectable options. If omitted, only free-text input is shown." })),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "No UI available for user interaction" }], isError: true };
			}

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				let mode: "select" | "input" = params.options?.length ? "select" : "input";

				// Top border
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				// Question
				container.addChild(new Text(theme.fg("accent", theme.bold(params.question)), 1, 0));
				container.addChild(new Spacer(1));

				// Free-text input (always created, shown/hidden based on mode)
				const input = new Input();
				const inputLabel = new Text(theme.fg("dim", "Type your response • enter submit • esc back"), 1, 0);

				// SelectList (only if options provided)
				let selectList: SelectList | null = null;
				if (params.options && params.options.length > 0) {
					const items: SelectItem[] = [
						...params.options.map((opt: string) => ({ value: opt, label: opt })),
						{ value: "__free_input__", label: "✎  Other (type custom answer)", description: "free-text" },
					];
					selectList = new SelectList(items, Math.min(items.length + 1, 15), {
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					});
					selectList.onSelect = (item: SelectItem) => {
						if (item.value === "__free_input__") {
							mode = "input";
							tui.requestRender();
						} else {
							done(item.value);
						}
					};
					selectList.onCancel = () => done(null);
				}

				const selectHelp = new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0);

				// Bottom border
				const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));

				return {
					render: (w: number) => {
						// Rebuild container based on current mode
						container.clear();
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(theme.fg("accent", theme.bold(params.question)), 1, 0));
						container.addChild(new Spacer(1));
						if (mode === "select" && selectList) {
							container.addChild(selectList);
							container.addChild(selectHelp);
						} else {
							container.addChild(input);
							container.addChild(inputLabel);
						}
						container.addChild(bottomBorder);
						return container.render(w);
					},
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (mode === "select" && selectList) {
							selectList.handleInput(data);
						} else {
							if (matchesKey(data, Key.enter)) {
								const text = input.getText().trim();
								if (text) done(text);
							} else if (matchesKey(data, Key.escape)) {
								if (selectList) { mode = "select"; } else { done(null); }
							} else {
								input.handleInput(data);
							}
						}
						tui.requestRender();
					},
				};
			});

			if (result === null) {
				return { content: [{ type: "text", text: "User cancelled" }] };
			}
			return { content: [{ type: "text", text: result }] };
		},

		renderCall(args, theme) {
			let t = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("accent", args.question || "...");
			if (args.options?.length > 0) {
				t += `\n  ${theme.fg("dim", args.options.join(" • "))}`;
			}
			return new Text(t, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			const value = text?.type === "text" ? text.text : "(no response)";
			const icon = value === "User cancelled" ? theme.fg("warning", "✗") : theme.fg("success", "✓");
			return new Text(`${icon} ${theme.fg("toolOutput", value)}`, 0, 0);
		},
	});

	// ── Subagent tool ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Agents are bundled with this package, plus user (~/.pi/agent/agents) and project (.pi/agents) agents.",
		].join(" "),
		promptSnippet: "Delegate tasks to specialized subagents (single, parallel, or chain mode)",
		promptGuidelines: [
			"Use subagent to delegate code changes, git operations, debugging, tests, and reviews to specialist agents.",
			"Route by intent: python code → python-expert, git commit → git-expert, PR → github-expert, etc.",
			"Run independent tasks in parallel using the tasks array.",
			"For multi-step workflows, use chain mode with {previous} placeholder.",
		],
		parameters: SubagentParams,

		async execute(_id, params, signal, onUpdate, ctx) {
			const scope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, scope);
			const agents = discovery.agents;
			const confirm = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modes = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const mkd = (mode: "single" | "parallel" | "chain") => (results: SingleResult[]): SubagentDetails => ({ mode, agentScope: scope, projectAgentsDir: discovery.projectAgentsDir, results });

			if (modes !== 1) {
				const avail = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return { content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${avail}` }], details: mkd("single")([]) };
			}

			// Confirm project agents
			if ((scope === "project" || scope === "both") && confirm && ctx.hasUI) {
				const requested = new Set<string>();
				if (params.chain) for (const s of params.chain) requested.add(s.agent);
				if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
				if (params.agent) requested.add(params.agent);
				const projAgents = Array.from(requested).map((n) => agents.find((a) => a.name === n)).filter((a): a is AgentConfig => a?.source === "project");
				if (projAgents.length > 0) {
					const ok = await ctx.ui.confirm("Run project-local agents?", `Agents: ${projAgents.map((a) => a.name).join(", ")}\nSource: ${discovery.projectAgentsDir}`);
					if (!ok) return { content: [{ type: "text", text: "Canceled: project-local agents not approved." }], details: mkd(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]) };
				}
			}

			// Chain mode
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let prev = "";
				for (let i = 0; i < params.chain.length; i++) {
					const s = params.chain[i];
					const t = s.task.replace(/\{previous\}/g, prev);
					const chainUpdate: OnUpdate | undefined = onUpdate ? (p) => { const c = p.details?.results[0]; if (c) onUpdate({ content: p.content, details: mkd("chain")([...results, c]) }); } : undefined;
					const r = await runSingleAgent(ctx.cwd, agents, s.agent, t, s.cwd, i + 1, signal, chainUpdate, mkd("chain"));
					results.push(r);
					if (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted") {
						return { content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${s.agent}): ${r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)"}` }], details: mkd("chain")(results), isError: true };
					}
					prev = getFinalOutput(r.messages);
				}
				return { content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }], details: mkd("chain")(results) };
			}

			// Parallel mode
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) return { content: [{ type: "text", text: `Too many tasks (${params.tasks.length}). Max ${MAX_PARALLEL_TASKS}.` }], details: mkd("parallel")([]) };
				const all: SingleResult[] = params.tasks.map((t) => ({ agent: t.agent, agentSource: "unknown" as const, task: t.task, exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } }));
				const emitAll = () => { if (onUpdate) { const run = all.filter((r) => r.exitCode === -1).length; const done = all.filter((r) => r.exitCode !== -1).length; onUpdate({ content: [{ type: "text", text: `Parallel: ${done}/${all.length} done, ${run} running...` }], details: mkd("parallel")([...all]) }); } };
				const results = await mapWithConcurrency(params.tasks, MAX_CONCURRENCY, async (t, i) => {
					const r = await runSingleAgent(ctx.cwd, agents, t.agent, t.task, t.cwd, undefined, signal, (p) => { if (p.details?.results[0]) { all[i] = p.details.results[0]; emitAll(); } }, mkd("parallel"));
					all[i] = r; emitAll(); return r;
				});
				const ok = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => { const o = getFinalOutput(r.messages); const p = o.slice(0, 100) + (o.length > 100 ? "..." : ""); return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${p || "(no output)"}`; });
				return { content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }], details: mkd("parallel")(results) };
			}

			// Single mode
			if (params.agent && params.task) {
				const r = await runSingleAgent(ctx.cwd, agents, params.agent, params.task, params.cwd, undefined, signal, onUpdate, mkd("single"));
				const err = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				if (err) return { content: [{ type: "text", text: `Agent ${r.stopReason || "failed"}: ${r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)"}` }], details: mkd("single")([r]), isError: true };
				return { content: [{ type: "text", text: getFinalOutput(r.messages) || "(no output)" }], details: mkd("single")([r]) };
			}

			return { content: [{ type: "text", text: `Invalid parameters. Available: ${agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none"}` }], details: mkd("single")([]) };
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain?.length > 0) {
				let t = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`) + theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) { const s = args.chain[i]; const p = s.task.replace(/\{previous\}/g, "").trim(); t += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", s.agent)}${theme.fg("dim", ` ${p.length > 40 ? p.slice(0, 40) + "..." : p}`)}`; }
				if (args.chain.length > 3) t += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(t, 0, 0);
			}
			if (args.tasks?.length > 0) {
				let t = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`) + theme.fg("muted", ` [${scope}]`);
				for (const tk of args.tasks.slice(0, 3)) t += `\n  ${theme.fg("accent", tk.agent)}${theme.fg("dim", ` ${tk.task.length > 40 ? tk.task.slice(0, 40) + "..." : tk.task}`)}`;
				if (args.tasks.length > 3) t += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(t, 0, 0);
			}
			let t = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent || "...") + theme.fg("muted", ` [${scope}]`);
			t += `\n  ${theme.fg("dim", args.task ? (args.task.length > 60 ? args.task.slice(0, 60) + "..." : args.task) : "...")}`;
			return new Text(t, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) { const t = result.content[0]; return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0); }
			const mdTheme = getMarkdownTheme();

			const renderItems = (items: DisplayItem[], limit?: number) => {
				const show = limit ? items.slice(-limit) : items;
				const skip = limit && items.length > limit ? items.length - limit : 0;
				let t = ""; if (skip > 0) t += theme.fg("muted", `... ${skip} earlier items\n`);
				for (const i of show) { if (i.type === "text") { const p = expanded ? i.text : i.text.split("\n").slice(0, 3).join("\n"); t += `${theme.fg("toolOutput", p)}\n`; } else t += `${theme.fg("muted", "→ ") + formatToolCall(i.name, i.args, theme.fg.bind(theme))}\n`; }
				return t.trimEnd();
			};

			const aggUsage = (rs: SingleResult[]) => { const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }; for (const r of rs) { t.input += r.usage.input; t.output += r.usage.output; t.cacheRead += r.usage.cacheRead; t.cacheWrite += r.usage.cacheWrite; t.cost += r.usage.cost; t.turns += r.usage.turns; } return t; };

			// Single
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isErr = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isErr ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const items = getDisplayItems(r.messages);
				const final = getFinalOutput(r.messages);
				if (expanded) {
					const c = new Container();
					let h = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isErr && r.stopReason) h += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					c.addChild(new Text(h, 0, 0));
					if (isErr && r.errorMessage) c.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					c.addChild(new Spacer(1)); c.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0)); c.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					c.addChild(new Spacer(1)); c.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (items.length === 0 && !final) c.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					else { for (const i of items) if (i.type === "toolCall") c.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(i.name, i.args, theme.fg.bind(theme)), 0, 0)); if (final) { c.addChild(new Spacer(1)); c.addChild(new Markdown(final.trim(), 0, 0, mdTheme)); } }
					const u = formatUsageStats(r.usage, r.model); if (u) { c.addChild(new Spacer(1)); c.addChild(new Text(theme.fg("dim", u), 0, 0)); }
					return c;
				}
				let t = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isErr && r.stopReason) t += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isErr && r.errorMessage) t += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (items.length === 0) t += `\n${theme.fg("muted", "(no output)")}`;
				else { t += `\n${renderItems(items, COLLAPSED_ITEM_COUNT)}`; if (items.length > COLLAPSED_ITEM_COUNT) t += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`; }
				const u = formatUsageStats(r.usage, r.model); if (u) t += `\n${theme.fg("dim", u)}`;
				return new Text(t, 0, 0);
			}

			// Chain
			if (details.mode === "chain") {
				const ok = details.results.filter((r) => r.exitCode === 0).length;
				const icon = ok === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
				if (expanded) {
					const c = new Container();
					c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${details.results.length} steps`)}`, 0, 0));
					for (const r of details.results) {
						const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						c.addChild(new Spacer(1)); c.addChild(new Text(`${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${ri}`, 0, 0));
						c.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						for (const i of getDisplayItems(r.messages)) if (i.type === "toolCall") c.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(i.name, i.args, theme.fg.bind(theme)), 0, 0));
						const f = getFinalOutput(r.messages); if (f) { c.addChild(new Spacer(1)); c.addChild(new Markdown(f.trim(), 0, 0, mdTheme)); }
						const su = formatUsageStats(r.usage, r.model); if (su) c.addChild(new Text(theme.fg("dim", su), 0, 0));
					}
					const tu = formatUsageStats(aggUsage(details.results)); if (tu) { c.addChild(new Spacer(1)); c.addChild(new Text(theme.fg("dim", `Total: ${tu}`), 0, 0)); }
					return c;
				}
				let t = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${details.results.length} steps`)}`;
				for (const r of details.results) { const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗"); const di = getDisplayItems(r.messages); t += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${ri}`; t += di.length === 0 ? `\n${theme.fg("muted", "(no output)")}` : `\n${renderItems(di, 5)}`; }
				const tu = formatUsageStats(aggUsage(details.results)); if (tu) t += `\n\n${theme.fg("dim", `Total: ${tu}`)}`;
				t += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(t, 0, 0);
			}

			// Parallel
			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const ok = details.results.filter((r) => r.exitCode === 0).length;
				const fail = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning ? theme.fg("warning", "⏳") : fail > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
				const status = isRunning ? `${ok + fail}/${details.results.length} done, ${running} running` : `${ok}/${details.results.length} tasks`;
				if (expanded && !isRunning) {
					const c = new Container();
					c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0));
					for (const r of details.results) {
						const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						c.addChild(new Spacer(1)); c.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${ri}`, 0, 0));
						c.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						for (const i of getDisplayItems(r.messages)) if (i.type === "toolCall") c.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(i.name, i.args, theme.fg.bind(theme)), 0, 0));
						const f = getFinalOutput(r.messages); if (f) { c.addChild(new Spacer(1)); c.addChild(new Markdown(f.trim(), 0, 0, mdTheme)); }
						const su = formatUsageStats(r.usage, r.model); if (su) c.addChild(new Text(theme.fg("dim", su), 0, 0));
					}
					const tu = formatUsageStats(aggUsage(details.results)); if (tu) { c.addChild(new Spacer(1)); c.addChild(new Text(theme.fg("dim", `Total: ${tu}`), 0, 0)); }
					return c;
				}
				let t = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) { const ri = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗"); const di = getDisplayItems(r.messages); t += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${ri}`; t += di.length === 0 ? `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}` : `\n${renderItems(di, 5)}`; }
				if (!isRunning) { const tu = formatUsageStats(aggUsage(details.results)); if (tu) t += `\n\n${theme.fg("dim", `Total: ${tu}`)}`; }
				if (!expanded) t += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(t, 0, 0);
			}

			const t = result.content[0]; return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
		},
	});

	// ── Enforcement: tool_call handler ──────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = event.input.command;
		const cmdLower = command.trim().toLowerCase();

		// Block direct python/pip — check at start or after pipe/semicolon/&& operators
		if (!cmdLower.startsWith("uv ") && !cmdLower.startsWith("uvx ")) {
			if (/(?:^|[|;&]\s*)(?:python3?|pip3?)\b/.test(cmdLower)) {
				return { block: true, reason: "Direct python/pip forbidden. Use: uv run python3 / uv run script.py / uvx tool / uv add pkg" };
			}
		}

		// Block direct pre-commit
		if (cmdLower.startsWith("pre-commit ")) return { block: true, reason: "Direct pre-commit forbidden. Use: prek run --all-files" };

		// Git protection
		if (isGitRepo(ctx.cwd)) {
			// Block git add . / git add -A
			if (hasGitSub(command, "add") && /\bgit\b.*\badd\b\s+(\.|--all|-A)\b/.test(command)) {
				return { block: true, reason: "⛔ 'git add .' / 'git add -A' forbidden. Stage specific files." };
			}

			// Block --no-verify
			if (hasGitSub(command, "commit") && command.includes("--no-verify")) {
				return { block: true, reason: "⛔ --no-verify forbidden. Pre-commit hooks must run." };
			}

			const branch = getCurrentBranch(ctx.cwd);
			const mainBranch = getMainBranch(ctx.cwd);

			// Block commits to protected branches
			if (hasGitSub(command, "commit")) {
				if (!branch) return { block: true, reason: "⛔ Detached HEAD. Create a branch first: git checkout -b my-branch" };
				if (branch === "main" || branch === "master") return { block: true, reason: `⛔ Cannot commit to '${branch}'. Create a feature branch.` };

				const pr = getPrMergeStatus(branch, ctx.cwd);
				if (pr.merged) return { block: true, reason: `⛔ PR #${pr.info} for '${branch}' already merged. Create a new branch from ${mainBranch || "main"}.` };

				if (command.includes("--amend") && isBranchAhead(ctx.cwd)) return undefined;

				if (mainBranch && isBranchMerged(branch, mainBranch, ctx.cwd)) return { block: true, reason: `⛔ Branch '${branch}' already merged into '${mainBranch}'. Create a new branch.` };
			}

			// Block pushes to protected branches + require user approval for all pushes
			if (hasGitSub(command, "push")) {
				if (branch === "main" || branch === "master") return { block: true, reason: `⛔ Cannot push to '${branch}'. Create a feature branch.` };
				if (branch) {
					const pr = getPrMergeStatus(branch, ctx.cwd);
					if (pr.merged) return { block: true, reason: `⛔ PR #${pr.info} for '${branch}' already merged. Create a new branch.` };
					if (mainBranch && isBranchMerged(branch, mainBranch, ctx.cwd)) return { block: true, reason: `⛔ Branch '${branch}' already merged into '${mainBranch}'. Create a new branch.` };
				}
			}
		}

		// Dangerous command confirmation
		if (DANGEROUS.some((p) => p.test(command))) {
			if (!ctx.hasUI) return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			const ok = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);
			if (ok !== "Yes") return { block: true, reason: "Blocked by user" };
		}

		return undefined;
	});

	// ── Rule injection ─────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		const rules =
			"\n\n[ORCHESTRATOR RULES] You are a MANAGER. Delegate work to subagents. Never write code directly.\n" +
			"\n[ISSUE-FIRST WORKFLOW]\n" +
			"Before ANY code changes (except trivial fixes, questions, or when user says 'just do it'):\n" +
			"1. Create a GitHub issue first (delegate to github-expert)\n" +
			"2. Create branch from origin/main: feat/issue-N-description or fix/issue-N-description\n" +
			"3. Ask user: 'Issue #N created. Work on it now?'\n" +
			"4. Only proceed after user confirms\n" +
			"Skip for: typos, single-line fixes, exploration, urgent hotfixes.\n" +
			"\n[DELEGATION]\n" +
			"Route by intent, not tool:\n" +
			"Python\u2192python-expert, Go\u2192go-expert, Frontend\u2192frontend-expert, Java\u2192java-expert,\n" +
			"Shell\u2192bash-expert, Docs\u2192technical-documentation-writer, Docker\u2192docker-expert,\n" +
			"K8s\u2192kubernetes-expert, Jenkins\u2192jenkins-expert, Git\u2192git-expert, GitHub\u2192github-expert,\n" +
			"Tests\u2192test-automator/test-runner, Debug\u2192debugger, API docs\u2192api-documenter,\n" +
			"External docs\u2192docs-fetcher, General\u2192worker\n" +
			"\n[PARALLEL EXECUTION]\n" +
			"Before every response: can operations run in parallel?\n" +
			"YES \u2192 use tasks array in subagent tool. NO \u2192 prove dependency before sequencing.\n" +
			"\n[CODE REVIEW LOOP]\n" +
			"After ANY code change:\n" +
			"1. Run 3 reviewers in parallel: code-reviewer-quality, code-reviewer-guidelines, code-reviewer-security\n" +
			"2. Merge and deduplicate findings\n" +
			"3. Fix issues \u2192 re-review until all approve\n" +
			"4. Run tests\n" +
			"\n[BRANCH RULES]\n" +
			"- Never work on main/master\n" +
			"- Never stage all files at once\n" +
			"- Never skip pre-commit hooks\n" +
			"- Stage specific files only\n" +
			"- Branch naming: feature/, fix/, hotfix/, refactor/\n" +
			"\n[PYTHON RULES]\n" +
			"- NEVER use `python` or `pip` directly.\n" +
			"- Use `uv run`, `uvx`, `uv add` instead.\n" +
			"- For arbitrary scripts: `uv run --with <package> script.py`\n" +
			"- NEVER use `uv run pip install`\n" +
			"\n[MCP SERVERS]\n" +
			"MCP servers are available via the `mcpl` CLI (MCP Launchpad).\n" +
			"Never guess tool names \u2014 always discover first:\n" +
			"  mcpl list --refresh \u2014 Discover all MCP servers and refresh tools\n" +
			"  mcpl search \"<query>\" \u2014 Find tools across all servers\n" +
			"  mcpl list <server> \u2014 List a server's tools\n" +
			"  mcpl inspect <server> <tool> \u2014 Get full schema\n" +
			"  mcpl call <server> <tool> '{}' \u2014 Execute tool\n" +
			"Workflow: search \u2192 inspect \u2192 call. Subagents can use mcpl directly.\n" +
			"\n[WEB ACCESS]\n" +
			"- Web search and fetch: Use the `web_search` and `fetch_content` tools (from pi-web-access)\n" +
			"- Browser automation: Use `agent-browser` CLI via bash for interactive web pages\n" +
			"  (navigate, click, fill forms, screenshots)\n" +
			"- Do NOT use `curl` for reading web pages \u2014 use `fetch_content` instead\n" +
			"- Do NOT use SearXNG MCP for web search \u2014 use `web_search` instead\n" +
			"\n[USER INTERACTION]\n" +
			"When a workflow or prompt template needs user input (approvals, selections, confirmations):\n" +
			"- Use the `ask_user` tool with clear options\n" +
			"- NEVER ask users questions via plain text in the conversation\n" +
			"- This applies to all prompt templates, extensions, and workflows\n" +
			"\n[TEMP FILES]\n" +
			"All temp files go to `/tmp/pi-work/` \u2014 never in the project directory.\n" +
			"\n[EXTERNAL GIT REPOS]\n" +
			"When exploring external repos, clone locally first:\n" +
			"  git clone --depth 1 https://github.com/org/repo.git /tmp/pi-work/repo\n" +
			"Never use full clones. Clean up when done.\n" +
			"\n[DOCKER / DOCKERFILE]\n" +
			"This repo includes a Dockerfile for running pi in a sandboxed container.\n" +
			"The image is published at ghcr.io/myk-org/pi-config:latest.\n" +
			"When adding a new feature that requires a new CLI tool or system dependency:\n" +
			"- Update the Dockerfile to install the new tool\n" +
			"- Update the README Docker section if new mounts or env vars are needed\n" +
			"- Never assume a tool exists in the container \u2014 check the Dockerfile\n" +
			"\n[AGENT BUG REPORTING]\n" +
			"If you discover a logic flaw or bug in an agent's instructions:\n" +
			"1. Ask user: 'I found a bug in [agent]. Create a GitHub issue?'\n" +
			"2. If yes, delegate to github-expert to create issue on myk-org/pi-config\n" +
			"3. Continue with original task (fix or workaround)\n";
		return { systemPrompt: event.systemPrompt + rules };
	});

	// ── Git branch status line ─────────────────────────────────────────────

	const updateBranch = (_event: any, ctx: any) => {
		try {
			const b = getCurrentBranch(ctx.cwd);
			if (!b) return;

			const status = runGit(["status", "--porcelain"], ctx.cwd);
			let modified = 0, added = 0, deleted = 0, untracked = 0;
			if (status.code === 0 && status.stdout) {
				for (const line of status.stdout.split("\n")) {
					if (!line.trim()) continue;
					const xy = line.slice(0, 2);
					if (xy.includes("?")) untracked++;
					else if (xy.includes("D")) deleted++;
					else if (xy.includes("A")) added++;
					else if (xy.includes("M") || xy.includes("R") || xy.includes("C")) modified++;
				}
			}

			const changes: string[] = [];
			if (modified > 0) changes.push(`~${modified}`);
			if (added > 0) changes.push(`+${added}`);
			if (deleted > 0) changes.push(`-${deleted}`);
			if (untracked > 0) changes.push(`?${untracked}`);
			const sep = IN_CONTAINER ? "| " : "";
			ctx.ui.setStatus("git", changes.length > 0 ? `${sep}git-status: ${changes.join(" ")}` : `${sep}git-status: ✓`);
		} catch {}
	};
	pi.on("session_start", updateBranch);
	pi.on("agent_end", updateBranch);
	pi.on("turn_end", updateBranch);

	// ── Container indicator in status line ─────────────────────────────────

	if (IN_CONTAINER) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.setStatus("container", "📦 container");
		});
	}

	// ── Notification on task completion ─────────────────────────────────────

	pi.on("agent_end", async () => {
		try { execSync('notify-send "pi" "Task completed" 2>/dev/null || true', { timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }); } catch {}
	});

	// ── Session start: validate required tools ───────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const missing: string[] = [];
		const optional: string[] = [];

		const hasCmd = (cmd: string): boolean => {
			try { execSync(`command -v ${cmd}`, { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }); return true; } catch { return false; }
		};

		// Critical
		if (!hasCmd("uv")) missing.push("uv — Required for Python. Install: https://docs.astral.sh/uv/");

		// Optional
		if (!hasCmd("gh")) optional.push("gh — GitHub CLI. Install: https://cli.github.com/");
		if (!hasCmd("mcpl")) optional.push("mcpl — MCP Launchpad. Install: https://github.com/kenneth-liao/mcp-launchpad");
		if (!hasCmd("myk-pi-tools")) optional.push("myk-pi-tools — PR/release/review CLI. Install: uv tool install git+https://github.com/myk-org/pi-config");

		// Check prek only if .pre-commit-config.yaml exists
		try {
			if (fs.existsSync(path.join(ctx.cwd, ".pre-commit-config.yaml")) && !hasCmd("prek")) {
				optional.push("prek — pre-commit wrapper (.pre-commit-config.yaml detected). Install: https://github.com/j178/prek");
			}
		} catch {}

		if (missing.length > 0 || optional.length > 0) {
			const parts: string[] = [];
			if (missing.length > 0) parts.push(`⚠️ CRITICAL missing:\n${missing.map(m => `  • ${m}`).join("\n")}`);
			if (optional.length > 0) parts.push(`Optional missing:\n${optional.map(m => `  • ${m}`).join("\n")}`);
			ctx.ui.notify(parts.join("\n\n"), missing.length > 0 ? "warning" : "info");
		}
	});

}
