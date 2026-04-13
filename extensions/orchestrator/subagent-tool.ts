/**
 * Subagent tool — delegates tasks to specialist subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  getMarkdownTheme,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { getPiInvocation } from "./utils.js";

// ── Constants ────────────────────────────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

// ── Schemas ──────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task to delegate" }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
});
const ChainItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({
    description: "Task with optional {previous} placeholder",
  }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
});
const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Agent directories to use. Default: "user".',
  default: "user",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Agent name (single mode)" }),
  ),
  task: Type.Optional(
    Type.String({ description: "Task to delegate (single mode)" }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: "Parallel execution" }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, { description: "Sequential execution" }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Prompt before project agents. Default: true.",
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory (single mode)" }),
  ),
  async: Type.Optional(
    Type.Boolean({ description: "Run in background (default: false). Agent runs detached, results surface when complete.", default: false }),
  ),
});

// ── Interfaces ───────────────────────────────────────────────────────────

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "package" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

// ── Helper functions ─────────────────────────────────────────────────────

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  fg: (c: any, t: string) => string,
): string {
  const shorten = (p: string) => {
    const h = os.homedir();
    return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
  };
  switch (toolName) {
    case "bash": {
      const c = (args.command as string) || "...";
      const p = c.length > 60 ? `${c.slice(0, 60)}...` : c;
      return fg("muted", "$ ") + fg("toolOutput", p);
    }
    case "read": {
      const f = shorten((args.file_path || args.path || "...") as string);
      let t = fg("accent", f);
      const o = args.offset as number | undefined;
      const l = args.limit as number | undefined;
      if (o !== undefined || l !== undefined) {
        const s = o ?? 1;
        const e = l !== undefined ? s + l - 1 : "";
        t += fg("warning", `:${s}${e ? `-${e}` : ""}`);
      }
      return fg("muted", "read ") + t;
    }
    case "write": {
      const f = shorten((args.file_path || args.path || "...") as string);
      const c = (args.content || "") as string;
      let t = fg("muted", "write ") + fg("accent", f);
      if (c.split("\n").length > 1)
        t += fg("dim", ` (${c.split("\n").length} lines)`);
      return t;
    }
    case "edit":
      return (
        fg("muted", "edit ") +
        fg("accent", shorten((args.file_path || args.path || "...") as string))
      );
    case "ls":
      return (
        fg("muted", "ls ") + fg("accent", shorten((args.path || ".") as string))
      );
    case "find":
      return (
        fg("muted", "find ") +
        fg("accent", (args.pattern || "*") as string) +
        fg("dim", ` in ${shorten((args.path || ".") as string)}`)
      );
    case "grep":
      return (
        fg("muted", "grep ") +
        fg("accent", `/${(args.pattern || "") as string}/`) +
        fg("dim", ` in ${shorten((args.path || ".") as string)}`)
      );
    default: {
      const s = JSON.stringify(args);
      return (
        fg("accent", toolName) +
        fg("dim", ` ${s.length > 50 ? s.slice(0, 50) + "..." : s}`)
      );
    }
  }
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant")
      for (const p of m.content) if (p.type === "text") return p.text;
  }
  return "";
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const m of messages)
    if (m.role === "assistant")
      for (const p of m.content) {
        if (p.type === "text") items.push({ type: "text", text: p.text });
        else if (p.type === "toolCall")
          items.push({ type: "toolCall", name: p.name, args: p.arguments });
      }
  return items;
}

async function mapWithConcurrency<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I, i: number) => Promise<O>,
): Promise<O[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: O[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

async function writePromptFile(
  name: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const filePath = path.join(
    dir,
    `prompt-${name.replace(/[^\w.-]+/g, "_")}.md`,
  );
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return { dir, filePath };
}

// ── Types ────────────────────────────────────────────────────────────────

type OnUpdate = (partial: AgentToolResult<SubagentDetails>) => void;

// ── runSingleAgent ───────────────────────────────────────────────────────

export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate | undefined,
  makeDetails: (r: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const avail = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available: ${avail}.`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0)
    args.push("--tools", agent.tools.join(","));

  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  const cur: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: agent.model,
    step,
  };

  const emit = () => {
    if (onUpdate)
      onUpdate({
        content: [
          {
            type: "text",
            text: getFinalOutput(cur.messages) || "(running...)",
          },
        ],
        details: makeDetails([cur]),
      });
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptFile(agent.name, agent.systemPrompt);
      tmpDir = tmp.dir;
      tmpFile = tmp.filePath;
      args.push("--append-system-prompt", tmpFile);
    }
    args.push(`Task: ${task}`);
    let aborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const inv = getPiInvocation(args);
      const proc = spawn(inv.command, inv.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
      });
      let buf = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "message_end" && ev.message) {
          const msg = ev.message as Message;
          cur.messages.push(msg);
          if (msg.role === "assistant") {
            cur.usage.turns++;
            const u = msg.usage;
            if (u) {
              cur.usage.input += u.input || 0;
              cur.usage.output += u.output || 0;
              cur.usage.cacheRead += u.cacheRead || 0;
              cur.usage.cacheWrite += u.cacheWrite || 0;
              cur.usage.cost += u.cost?.total || 0;
              cur.usage.contextTokens = u.totalTokens || 0;
            }
            if (!cur.model && msg.model) cur.model = msg.model;
            if (msg.stopReason) cur.stopReason = msg.stopReason;
            if (msg.errorMessage) cur.errorMessage = msg.errorMessage;
          }
          emit();
        }
        if (ev.type === "tool_result_end" && ev.message) {
          cur.messages.push(ev.message as Message);
          emit();
        }
      };

      proc.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) processLine(l);
      });
      proc.stderr.on("data", (d) => {
        cur.stderr += d.toString();
      });
      proc.on("close", (c) => {
        if (buf.trim()) processLine(buf);
        resolve(c ?? 0);
      });
      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => {
          aborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    cur.exitCode = exitCode;
    if (aborted) throw new Error("Subagent was aborted");
    return cur;
  } finally {
    if (tmpFile)
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    if (tmpDir)
      try {
        fs.rmdirSync(tmpDir);
      } catch {}
  }
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerSubagentTool(
  pi: ExtensionAPI,
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: AgentConfig[]) => { id: string; error?: string },
): void {
  // Only the orchestrator (top-level pi) can spawn subagents.
  // Child processes set PI_SUBAGENT_CHILD=1 to prevent infinite recursion.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      "Agents are bundled with this package, plus user (~/.pi/agent/agents) and project (.pi/agents) agents.",
    ].join(" "),
    promptSnippet:
      "Delegate tasks to specialized subagents (single, parallel, or chain mode)",
    promptGuidelines: [
      "Use subagent to delegate code changes, git operations, debugging, tests, and reviews to specialist agents.",
      "Route by intent: python code → python-expert, git commit → git-expert, PR → github-expert, etc.",
      "Run independent tasks in parallel using the tasks array.",
      "For multi-step workflows, use chain mode with {previous} placeholder.",
      "Set async: true when you don't need the result immediately for your next step. The result will surface automatically when complete. Use sync (default) only when the next step depends on this agent's output.",
      "ALWAYS use async: true for independent tasks that can run in parallel — code reviews, opening issues, research, analysis. Only use sync when the very next step depends on this agent's output (e.g., chain where step 2 needs step 1's result).",
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

      const mkd =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentScope: scope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

      if (modes !== 1) {
        const avail =
          agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${avail}`,
            },
          ],
          details: mkd("single")([]),
        };
      }

      // Confirm project agents
      if ((scope === "project" || scope === "both") && confirm && ctx.hasUI) {
        const requested = new Set<string>();
        if (params.chain) for (const s of params.chain) requested.add(s.agent);
        if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
        if (params.agent) requested.add(params.agent);
        const projAgents = Array.from(requested)
          .map((n) => agents.find((a) => a.name === n))
          .filter((a): a is AgentConfig => a?.source === "project");
        if (projAgents.length > 0) {
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Agents: ${projAgents.map((a) => a.name).join(", ")}\nSource: ${discovery.projectAgentsDir}`,
          );
          if (!ok)
            return {
              content: [
                {
                  type: "text",
                  text: "Canceled: project-local agents not approved.",
                },
              ],
              details: mkd(
                hasChain ? "chain" : hasTasks ? "parallel" : "single",
              )([]),
            };
        }
      }

      // Async mode — spawn in background and return immediately
      if (params.async === true) {
        if (params.chain || params.tasks) {
          return {
            content: [{ type: "text", text: "Async mode currently supports single agent only. Use agent + task without chain/tasks." }],
            details: mkd("single")([]),
            isError: true,
          };
        }
        if (!params.agent || !params.task) {
          return {
            content: [{ type: "text", text: "Async mode requires agent and task." }],
            details: mkd("single")([]),
            isError: true,
          };
        }
        const result = spawnAsyncAgent(params.agent, params.task, params.cwd ?? ctx.cwd, agents);
        if (result.error) {
          return {
            content: [{ type: "text", text: result.error }],
            details: mkd("single")([]),
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Async agent spawned: ${params.agent} [${result.id}]\nUse /async-status to check progress. Results will appear when complete.` }],
          details: mkd("single")([]),
        };
      }

      // Chain mode
      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let prev = "";
        for (let i = 0; i < params.chain.length; i++) {
          const s = params.chain[i];
          const t = s.task.replace(/\{previous\}/g, prev);
          const chainUpdate: OnUpdate | undefined = onUpdate
            ? (p) => {
                const c = p.details?.results[0];
                if (c)
                  onUpdate({
                    content: p.content,
                    details: mkd("chain")([...results, c]),
                  });
              }
            : undefined;
          const r = await runSingleAgent(
            ctx.cwd,
            agents,
            s.agent,
            t,
            s.cwd,
            i + 1,
            signal,
            chainUpdate,
            mkd("chain"),
          );
          results.push(r);
          if (
            r.exitCode !== 0 ||
            r.stopReason === "error" ||
            r.stopReason === "aborted"
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: `Chain stopped at step ${i + 1} (${s.agent}): ${r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)"}`,
                },
              ],
              details: mkd("chain")(results),
              isError: true,
            };
          }
          prev = getFinalOutput(r.messages);
        }
        return {
          content: [
            {
              type: "text",
              text:
                getFinalOutput(results[results.length - 1].messages) ||
                "(no output)",
            },
          ],
          details: mkd("chain")(results),
        };
      }

      // Parallel mode
      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: "text",
                text: `Too many tasks (${params.tasks.length}). Max ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: mkd("parallel")([]),
          };
        const all: SingleResult[] = params.tasks.map((t) => ({
          agent: t.agent,
          agentSource: "unknown" as const,
          task: t.task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
        }));
        const emitAll = () => {
          if (onUpdate) {
            const run = all.filter((r) => r.exitCode === -1).length;
            const done = all.filter((r) => r.exitCode !== -1).length;
            onUpdate({
              content: [
                {
                  type: "text",
                  text: `Parallel: ${done}/${all.length} done, ${run} running...`,
                },
              ],
              details: mkd("parallel")([...all]),
            });
          }
        };
        const results = await mapWithConcurrency(
          params.tasks,
          MAX_CONCURRENCY,
          async (t, i) => {
            const r = await runSingleAgent(
              ctx.cwd,
              agents,
              t.agent,
              t.task,
              t.cwd,
              undefined,
              signal,
              (p) => {
                if (p.details?.results[0]) {
                  all[i] = p.details.results[0];
                  emitAll();
                }
              },
              mkd("parallel"),
            );
            all[i] = r;
            emitAll();
            return r;
          },
        );
        const ok = results.filter((r) => r.exitCode === 0).length;
        const summaries = results.map((r) => {
          const o = getFinalOutput(r.messages);
          const p = o.slice(0, 100) + (o.length > 100 ? "..." : "");
          return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${p || "(no output)"}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${ok}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
            },
          ],
          details: mkd("parallel")(results),
        };
      }

      // Single mode
      if (params.agent && params.task) {
        const r = await runSingleAgent(
          ctx.cwd,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          mkd("single"),
        );
        const err =
          r.exitCode !== 0 ||
          r.stopReason === "error" ||
          r.stopReason === "aborted";
        if (err)
          return {
            content: [
              {
                type: "text",
                text: `Agent ${r.stopReason || "failed"}: ${r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)"}`,
              },
            ],
            details: mkd("single")([r]),
            isError: true,
          };
        return {
          content: [
            { type: "text", text: getFinalOutput(r.messages) || "(no output)" },
          ],
          details: mkd("single")([r]),
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Invalid parameters. Available: ${agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none"}`,
          },
        ],
        details: mkd("single")([]),
      };
    },

    renderCall(args, theme) {
      const scope: AgentScope = args.agentScope ?? "user";
      if (args.chain?.length > 0) {
        let t =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`) +
          theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const s = args.chain[i];
          const p = s.task.replace(/\{previous\}/g, "").trim();
          t += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", s.agent)}${theme.fg("dim", ` ${p.length > 40 ? p.slice(0, 40) + "..." : p}`)}`;
        }
        if (args.chain.length > 3)
          t += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(t, 0, 0);
      }
      if (args.tasks?.length > 0) {
        let t =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
          theme.fg("muted", ` [${scope}]`);
        for (const tk of args.tasks.slice(0, 3))
          t += `\n  ${theme.fg("accent", tk.agent)}${theme.fg("dim", ` ${tk.task.length > 40 ? tk.task.slice(0, 40) + "..." : tk.task}`)}`;
        if (args.tasks.length > 3)
          t += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(t, 0, 0);
      }
      const asyncLabel = args.async === true ? theme.fg("warning", " [async]") : "";
      let t =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", args.agent || "...") +
        theme.fg("muted", ` [${scope}]`) + asyncLabel;
      t += `\n  ${theme.fg("dim", args.task ? (args.task.length > 60 ? args.task.slice(0, 60) + "..." : args.task) : "...")}`;
      return new Text(t, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
      }
      const mdTheme = getMarkdownTheme();

      const renderItems = (items: DisplayItem[], limit?: number) => {
        const show = limit ? items.slice(-limit) : items;
        const skip = limit && items.length > limit ? items.length - limit : 0;
        let t = "";
        if (skip > 0) t += theme.fg("muted", `... ${skip} earlier items\n`);
        for (const i of show) {
          if (i.type === "text") {
            const p = expanded
              ? i.text
              : i.text.split("\n").slice(0, 3).join("\n");
            t += `${theme.fg("toolOutput", p)}\n`;
          } else
            t += `${theme.fg("muted", "→ ") + formatToolCall(i.name, i.args, theme.fg.bind(theme))}\n`;
        }
        return t.trimEnd();
      };

      const aggUsage = (rs: SingleResult[]) => {
        const t = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
        };
        for (const r of rs) {
          t.input += r.usage.input;
          t.output += r.usage.output;
          t.cacheRead += r.usage.cacheRead;
          t.cacheWrite += r.usage.cacheWrite;
          t.cost += r.usage.cost;
          t.turns += r.usage.turns;
        }
        return t;
      };

      // Single
      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isErr =
          r.exitCode !== 0 ||
          r.stopReason === "error" ||
          r.stopReason === "aborted";
        const icon = isErr ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const items = getDisplayItems(r.messages);
        const final = getFinalOutput(r.messages);
        if (expanded) {
          const c = new Container();
          let h = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
          if (isErr && r.stopReason)
            h += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
          c.addChild(new Text(h, 0, 0));
          if (isErr && r.errorMessage)
            c.addChild(
              new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
            );
          c.addChild(new Spacer(1));
          c.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
          c.addChild(new Text(theme.fg("dim", r.task), 0, 0));
          c.addChild(new Spacer(1));
          c.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
          if (items.length === 0 && !final)
            c.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          else {
            for (const i of items)
              if (i.type === "toolCall")
                c.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(i.name, i.args, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
            if (final) {
              c.addChild(new Spacer(1));
              c.addChild(new Markdown(final.trim(), 0, 0, mdTheme));
            }
          }
          const u = formatUsageStats(r.usage, r.model);
          if (u) {
            c.addChild(new Spacer(1));
            c.addChild(new Text(theme.fg("dim", u), 0, 0));
          }
          return c;
        }
        let t = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isErr && r.stopReason)
          t += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        if (isErr && r.errorMessage)
          t += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        else if (items.length === 0)
          t += `\n${theme.fg("muted", "(no output)")}`;
        else {
          t += `\n${renderItems(items, COLLAPSED_ITEM_COUNT)}`;
          if (items.length > COLLAPSED_ITEM_COUNT)
            t += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const u = formatUsageStats(r.usage, r.model);
        if (u) t += `\n${theme.fg("dim", u)}`;
        return new Text(t, 0, 0);
      }

      // Chain
      if (details.mode === "chain") {
        const ok = details.results.filter((r) => r.exitCode === 0).length;
        const icon =
          ok === details.results.length
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");
        if (expanded) {
          const c = new Container();
          c.addChild(
            new Text(
              `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${details.results.length} steps`)}`,
              0,
              0,
            ),
          );
          for (const r of details.results) {
            const ri =
              r.exitCode === 0
                ? theme.fg("success", "✓")
                : theme.fg("error", "✗");
            c.addChild(new Spacer(1));
            c.addChild(
              new Text(
                `${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${ri}`,
                0,
                0,
              ),
            );
            c.addChild(
              new Text(
                theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
                0,
                0,
              ),
            );
            for (const i of getDisplayItems(r.messages))
              if (i.type === "toolCall")
                c.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(i.name, i.args, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
            const f = getFinalOutput(r.messages);
            if (f) {
              c.addChild(new Spacer(1));
              c.addChild(new Markdown(f.trim(), 0, 0, mdTheme));
            }
            const su = formatUsageStats(r.usage, r.model);
            if (su) c.addChild(new Text(theme.fg("dim", su), 0, 0));
          }
          const tu = formatUsageStats(aggUsage(details.results));
          if (tu) {
            c.addChild(new Spacer(1));
            c.addChild(new Text(theme.fg("dim", `Total: ${tu}`), 0, 0));
          }
          return c;
        }
        let t = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${details.results.length} steps`)}`;
        for (const r of details.results) {
          const ri =
            r.exitCode === 0
              ? theme.fg("success", "✓")
              : theme.fg("error", "✗");
          const di = getDisplayItems(r.messages);
          t += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${ri}`;
          t +=
            di.length === 0
              ? `\n${theme.fg("muted", "(no output)")}`
              : `\n${renderItems(di, 5)}`;
        }
        const tu = formatUsageStats(aggUsage(details.results));
        if (tu) t += `\n\n${theme.fg("dim", `Total: ${tu}`)}`;
        t += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(t, 0, 0);
      }

      // Parallel
      if (details.mode === "parallel") {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const ok = details.results.filter((r) => r.exitCode === 0).length;
        const fail = details.results.filter((r) => r.exitCode > 0).length;
        const isRunning = running > 0;
        const icon = isRunning
          ? theme.fg("warning", "⏳")
          : fail > 0
            ? theme.fg("warning", "◐")
            : theme.fg("success", "✓");
        const status = isRunning
          ? `${ok + fail}/${details.results.length} done, ${running} running`
          : `${ok}/${details.results.length} tasks`;
        if (expanded && !isRunning) {
          const c = new Container();
          c.addChild(
            new Text(
              `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
              0,
              0,
            ),
          );
          for (const r of details.results) {
            const ri =
              r.exitCode === 0
                ? theme.fg("success", "✓")
                : theme.fg("error", "✗");
            c.addChild(new Spacer(1));
            c.addChild(
              new Text(
                `${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${ri}`,
                0,
                0,
              ),
            );
            c.addChild(
              new Text(
                theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
                0,
                0,
              ),
            );
            for (const i of getDisplayItems(r.messages))
              if (i.type === "toolCall")
                c.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(i.name, i.args, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
            const f = getFinalOutput(r.messages);
            if (f) {
              c.addChild(new Spacer(1));
              c.addChild(new Markdown(f.trim(), 0, 0, mdTheme));
            }
            const su = formatUsageStats(r.usage, r.model);
            if (su) c.addChild(new Text(theme.fg("dim", su), 0, 0));
          }
          const tu = formatUsageStats(aggUsage(details.results));
          if (tu) {
            c.addChild(new Spacer(1));
            c.addChild(new Text(theme.fg("dim", `Total: ${tu}`), 0, 0));
          }
          return c;
        }
        let t = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const r of details.results) {
          const ri =
            r.exitCode === -1
              ? theme.fg("warning", "⏳")
              : r.exitCode === 0
                ? theme.fg("success", "✓")
                : theme.fg("error", "✗");
          const di = getDisplayItems(r.messages);
          t += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${ri}`;
          t +=
            di.length === 0
              ? `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`
              : `\n${renderItems(di, 5)}`;
        }
        if (!isRunning) {
          const tu = formatUsageStats(aggUsage(details.results));
          if (tu) t += `\n\n${theme.fg("dim", `Total: ${tu}`)}`;
        }
        if (!expanded) t += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(t, 0, 0);
      }

      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
    },
  });
}
