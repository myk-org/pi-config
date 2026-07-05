/**
 * Subagent tool — delegates tasks to specialist subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getMarkdownTheme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

// Import TaskStore for taskId validation (bypasses raw file reads)
let TaskStoreClass: any = null;
(async () => {
  const candidates = [
    "@tintinweb/pi-tasks/dist/task-store.js",
    pathToFileURL(path.join(os.homedir(), ".pi/agent/npm/node_modules/@tintinweb/pi-tasks/dist/task-store.js")).href,
  ];
  for (const c of candidates) {
    try { const mod = await import(c); if (mod.TaskStore) { TaskStoreClass = mod.TaskStore; break; } } catch { continue; }
  }
  if (!TaskStoreClass) {
    throw new Error("[subagent] FATAL: TaskStore not found — @tintinweb/pi-tasks is required but failed to load");
  }
})();
import { clockHHMM, getPiInvocation, getProjectTmpDir } from "./utils.js";

// ── Constants ────────────────────────────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MISSING_CWD_ERROR = "Missing required parameter: cwd. Always specify the working directory for subagent tasks.";
const MAX_SYNC_SECONDS = 30;
const SYNC_TIME_EXCEEDED_ERROR = (seconds: number) =>
  `Estimated time ${seconds}s meets or exceeds ${MAX_SYNC_SECONDS}s sync limit. Use async: true instead.`;
const MISSING_ESTIMATE_ERROR = "Missing required parameter: estimatedSeconds. Provide an estimated duration in seconds for sync agent tasks.";

/** Agents that MUST be dispatched with async: true. Sync calls are rejected.
 *  Keep in sync with rules/20-code-review-loop.md when changing this list. */
const ASYNC_ONLY_AGENTS = new Set([
  "code-reviewer-quality",
  "code-reviewer-guidelines",
  "code-reviewer-security",
  "code-reviewer-docs",
]);
// ── Schemas ──────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task to delegate" }),
  cwd: Type.String({ description: "Working directory" }),
  name: Type.Optional(Type.String({ description: "Display name for async status" })),
  estimatedSeconds: Type.Optional(Type.Number({ description: "Estimated task duration in seconds. Required for sync parallel tasks." })),
  taskId: Type.Optional(Type.String({ description: "Task ID to auto-complete when this async agent finishes" })),
});
const ChainItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({
    description: "Task with optional {previous} placeholder",
  }),
  cwd: Type.String({ description: "Working directory" }),
  estimatedSeconds: Type.Number({ description: "Estimated step duration in seconds" }),
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
    Type.String({ description: "Working directory. Required for single/async mode." }),
  ),
  // Optional at schema level because async mode doesn't need it; runtime enforces for sync
  estimatedSeconds: Type.Optional(
    Type.Number({ description: "Estimated task duration in seconds. Required for sync agents. If >= 30s, must use async: true instead." }),
  ),
  async: Type.Optional(
    Type.Boolean({ description: "Run in background (default: false). Agent runs detached, results surface when complete.", default: false }),
  ),
  fireAndForget: Type.Optional(
    Type.Boolean({ description: "When true with async, skip result delivery to conversation. Agent runs silently — only terminal notification on completion. Use for maintenance tasks like memory dreaming.", default: false }),
  ),
  name: Type.Optional(
    Type.String({ description: "Display name for async agents in status line and notifications (e.g., 'Dream', 'Code Review'). Defaults to agent name." }),
  ),
  taskId: Type.Optional(
    Type.String({ description: "Task ID to auto-complete when this async agent finishes. Required for async agents — pass \"-1\" if not linked to any task." }),
  ),
  asyncKill: Type.Optional(
    Type.String({ description: "Kill async agent(s) by name, id prefix, or 'all'. Returns which agents were killed." }),
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
  durationMs?: number;
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

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
    durationMs?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.durationMs != null) {
    const s = Math.floor(usage.durationMs / 1000);
    if (s < 60) parts.push(`${s}s`);
    else if (s < 3600) parts.push(`${Math.floor(s / 60)}m${s % 60}s`);
    else parts.push(`${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`);
  }
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

function formatToolCall(
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

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant")
      for (const p of m.content) if (p.type === "text") return p.text;
  }
  return "";
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
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
  cwd?: string,
): Promise<{ dir: string; filePath: string }> {
  let dir: string;
  const projectDir = getProjectTmpDir(cwd || process.cwd());
  dir = await fs.promises.mkdtemp(path.join(projectDir, "subagent-"));
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
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate | undefined,
  makeDetails: (r: SingleResult[]) => SubagentDetails,
  parentModelId?: string,
  parentProvider?: string,
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
  const effectiveModel = agent.model || parentModelId;
  if (effectiveModel) args.push("--model", effectiveModel);
  const effectiveProvider = agent.provider || parentProvider;
  if (effectiveProvider) args.push("--provider", effectiveProvider);
  if (agent.tools && agent.tools.length > 0)
    args.push("--tools", agent.tools.join(","));

  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  const startTime = Date.now();
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
    model: effectiveModel,
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
      const tmp = await writePromptFile(agent.name, agent.systemPrompt, cwd);
      tmpDir = tmp.dir;
      tmpFile = tmp.filePath;
      args.push("--append-system-prompt", tmpFile);
    }
    args.push(`Task: ${task}`);
    let aborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const inv = getPiInvocation(args);
      const proc = spawn(inv.command, inv.args, {
        cwd: cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_SUBAGENT_CHILD: "1", PI_AGENT_NAME: agentName },
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
    cur.durationMs = Date.now() - startTime;
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

/** Validate that a taskId references an existing task in the pi-tasks store. */
function validateTaskId(taskId: string, cwd: string, sessionId?: string): string | null {
  if (taskId === "-1") return null;

  const tasksDir = path.join(cwd, ".pi", "tasks");
  const paths: string[] = [];
  if (sessionId) paths.push(path.join(tasksDir, `tasks-${sessionId}.json`));
  paths.push(path.join(tasksDir, "tasks.json"));

  for (const p of paths) {
    try {
      if (TaskStoreClass) {
        const store = new TaskStoreClass(p);
        if (store.get(taskId)) return null;
      } else {
        // Fallback: raw file read when TaskStore hasn't loaded yet (async init race)
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        if ((data.tasks || []).some((t: any) => t.id === taskId)) return null;
      }
    } catch (e: any) {
      // Only continue silently for missing files; report other errors
      if (e?.code === "ENOENT" || e?.message?.includes("ENOENT")) continue;
      return `Task store error for ${path.basename(p)}: ${e?.message || e}. Fix the task store or pass taskId: "-1".`;
    }
  }

  return `Task #${taskId} not found. Verify the task ID exists (use TaskList to check), or pass taskId: "-1" if not linked to a task.`;
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerSubagentTool(
  pi: ExtensionAPI,
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: AgentConfig[], options?: { fireAndForget?: boolean; name?: string; parentModelId?: string; parentProvider?: string; groupId?: string; taskId?: string }) => { id: string; error?: string; model?: string },
  killAsyncAgent: (target: string) => { killed: string[]; errors: string[] },
): void {
  // Only the orchestrator (top-level pi) can spawn subagents.
  // Child processes set PI_SUBAGENT_CHILD=1 to prevent infinite recursion.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  // ── Extracted execute helpers (closure over pi, spawnAsyncAgent, killAsyncAgent) ──

  function executeAsyncKill(
    params: { asyncKill: string },
    mkd: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
  ) {
    const { killed, errors } = killAsyncAgent(params.asyncKill);
    const lines: string[] = [];
    if (killed.length > 0) lines.push(`Killed: ${killed.join(", ")}`);
    if (errors.length > 0) lines.push(errors.join("\n"));
    return {
      content: [{ type: "text" as const, text: lines.join("\n") || "No action taken." }],
      details: mkd("single")([]),
      isError: errors.length > 0 && killed.length === 0,
    };
  }

  function executeAsync(
    params: any,
    agents: AgentConfig[],
    mkd: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
    parentModelId: string | undefined,
    parentProvider: string | undefined,
    ctx: any,
  ) {
    if (params.chain) {
      return {
        content: [{ type: "text" as const, text: "Async mode does not support chain. Use agent + task or tasks array." }],
        details: mkd("single")([]),
        isError: true,
      };
    }

    // Parallel async — spawn each task as a separate async agent
    if (params.tasks && params.tasks.length > 0) {
      // Validate all tasks have names
      const unnamed = params.tasks.filter((t: any) => !(t as any).name);
      if (unnamed.length > 0) {
        return {
          content: [{ type: "text" as const, text: `Async agents require a name for display in status line. Missing name for: ${unnamed.map((t: any) => t.agent).join(", ")}` }],
          details: mkd("single")([]),
          isError: true,
        };
      }
      const noTaskId = params.tasks.filter((t: any) => (t as any).taskId == null);
      if (noTaskId.length > 0) {
        const errorMsg = `Missing required parameter: taskId. Every async agent MUST have a taskId.\n\nMissing taskId for: ${noTaskId.map((t: any) => t.agent).join(", ")}\n\nIf an agent is working on a task: pass the task ID (e.g., taskId: "5")\nIf an agent is NOT linked to any task: pass taskId: "-1"`;
        // Force a follow-up turn so the AI MUST deal with this error
        pi.sendMessage({
          customType: "subagent-taskid-error",
          content: `🚨 CRITICAL: Async subagent call was REJECTED — missing taskId for: ${noTaskId.map((t: any) => t.agent).join(", ")}. NO agents were spawned. You MUST retry with taskId for each agent. Use TaskList to find task IDs, or pass taskId: "-1" if not linked.`,
          display: true,
        }, { triggerTurn: true, deliverAs: "followUp" });
        return {
          content: [{ type: "text" as const, text: errorMsg }],
          details: mkd("single")([]),
          isError: true,
        };
      }
      for (const t of params.tasks) {
        const tid = (t as any).taskId as string;
        const taskErr = validateTaskId(tid, ctx.cwd, ctx.sessionManager?.getSessionId?.());
        if (taskErr) {
          pi.sendMessage({
            customType: "subagent-taskid-error",
            content: `🚨 CRITICAL: ${taskErr} (agent: ${t.agent}). NO agents were spawned. Fix the taskId and retry.`,
            display: true,
          }, { triggerTurn: true, deliverAs: "followUp" });
          return {
            content: [{ type: "text" as const, text: `${taskErr} (agent: ${t.agent})` }],
            details: mkd("single")([]),
            isError: true,
          };
        }
      }
      const results: string[] = [];
      const errors: string[] = [];
      // Group parallel async tasks so results are delivered together
      const groupId = params.tasks.length > 1
        ? `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : undefined;
      for (const t of params.tasks) {
        const r = spawnAsyncAgent(t.agent, t.task, t.cwd, agents, {
          fireAndForget: params.fireAndForget,
          name: (t as any).name,
          parentModelId,
          parentProvider,
          groupId,
          taskId: (t as any).taskId,
        });
        if (r.error) {
          errors.push(`${t.agent}: ${r.error}`);
        } else {
          const label = (t as any).name || t.agent;
          results.push(`${label} [${r.id}]${r.model ? ` (${r.model})` : ""}`);
        }
      }
      const lines: string[] = [];
      if (results.length > 0) lines.push(`Spawned ${results.length} async agents:\n${results.map(r => `- ${r}`).join("\n")}`);
      if (errors.length > 0) lines.push(`Failed:\n${errors.map(e => `- ${e}`).join("\n")}`);
      lines.push("\nUse /async-status to check progress.");
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: mkd("single")([]),
        isError: errors.length > 0 && results.length === 0,
      };
    }

    // Single async
    if (!params.agent || !params.task) {
      return {
        content: [{ type: "text" as const, text: "Async mode requires agent and task (or tasks array)." }],
        details: mkd("single")([]),
        isError: true,
      };
    }
    if (!params.cwd) {
      return {
        content: [{ type: "text" as const, text: MISSING_CWD_ERROR }],
        details: mkd("single")([]),
        isError: true,
      };
    }
    if (!params.name) {
      return {
        content: [{ type: "text" as const, text: "Async agents require a name for display in status line (e.g., 'Dream', 'Code Review', 'PR #42')." }],
        details: mkd("single")([]),
        isError: true,
      };
    }
    if (params.taskId == null) {
      const errorMsg = `Missing required parameter: taskId. Every async agent MUST have a taskId.\n\nIf this agent is working on a task: pass the task ID (e.g., taskId: "5")\nIf this agent is NOT linked to any task: pass taskId: "-1"\n\nExample: subagent(agent="${params.agent}", task="...", async=true, name="${params.name}", taskId="-1")`;
      // Force a follow-up turn so the AI MUST deal with this error
      pi.sendMessage({
        customType: "subagent-taskid-error",
        content: `🚨 CRITICAL: Async subagent call for "${params.agent}" was REJECTED — missing taskId. The agent was NOT spawned. You MUST retry the subagent call with taskId. Use TaskList to find the task ID, or pass taskId: "-1" if not linked to any task. Do NOT proceed without fixing this.`,
        display: true,
      }, { triggerTurn: true, deliverAs: "followUp" });
      return {
        content: [{ type: "text" as const, text: errorMsg }],
        details: mkd("single")([]),
        isError: true,
      };
    }
    {
      const taskErr = validateTaskId(params.taskId, ctx.cwd, ctx.sessionManager?.getSessionId?.());
      if (taskErr) {
        pi.sendMessage({
          customType: "subagent-taskid-error",
          content: `🚨 CRITICAL: ${taskErr} The agent was NOT spawned. Fix the taskId and retry.`,
          display: true,
        }, { triggerTurn: true, deliverAs: "followUp" });
        return {
          content: [{ type: "text" as const, text: taskErr }],
          details: mkd("single")([]),
          isError: true,
        };
      }
    }
    const result = spawnAsyncAgent(params.agent, params.task, params.cwd, agents, { fireAndForget: params.fireAndForget, name: params.name, parentModelId, parentProvider, taskId: params.taskId });
    if (result.error) {
      return {
        content: [{ type: "text" as const, text: result.error }],
        details: mkd("single")([]),
        isError: true,
      };
    }
    const label = params.name || params.agent;
    const modelInfo = result.model ? ` (${result.model})` : "";
    return {
      content: [{ type: "text" as const, text: `Async agent spawned: ${label} [${result.id}]${modelInfo}\nUse /async-status to check progress. Results will appear when complete.` }],
      details: mkd("single")([]),
    };
  }

  async function executeChain(
    params: any,
    agents: AgentConfig[],
    mkd: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdate | undefined,
    activeAgents: Set<string>,
    updateWorking: () => void,
    parentModelId: string | undefined,
    parentProvider: string | undefined,
  ) {
    const results: SingleResult[] = [];
    let prev = "";

    for (let i = 0; i < params.chain.length; i++) {
      if (!params.chain[i].cwd) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${MISSING_CWD_ERROR} (chain step ${i + 1}, agent: ${params.chain[i].agent})`,
            },
          ],
          details: mkd("chain")([]),
          isError: true,
        };
      }
    }
    // defensive: LLMs may omit schema-required fields
    const missingChainEstimate = params.chain.find((s: any) => s.estimatedSeconds == null);
    if (missingChainEstimate) {
      return {
        content: [{ type: "text" as const, text: `${MISSING_ESTIMATE_ERROR} (chain step, agent: ${missingChainEstimate.agent})` }],
        details: mkd("chain")([]),
        isError: true,
      };
    }
    const invalidChainEstimate = params.chain.find((s: any) => s.estimatedSeconds != null && s.estimatedSeconds <= 0);
    if (invalidChainEstimate) {
      return {
        content: [{ type: "text" as const, text: `estimatedSeconds must be a positive number. (chain step, agent: ${invalidChainEstimate.agent})` }],
        details: mkd("chain")([]),
        isError: true,
      };
    }
    // chain runs sequentially — sum all steps
    const totalChainSeconds = params.chain.reduce((sum: number, s: any) => sum + s.estimatedSeconds, 0);
    if (totalChainSeconds >= MAX_SYNC_SECONDS) {
      return {
        content: [{ type: "text" as const, text: SYNC_TIME_EXCEEDED_ERROR(totalChainSeconds) }],
        details: mkd("chain")([]),
        isError: true,
      };
    }

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
      activeAgents.clear();
      activeAgents.add(s.agent);
      updateWorking();
      const r = await runSingleAgent(
        agents,
        s.agent,
        t,
        s.cwd,
        i + 1,
        signal,
        chainUpdate,
        mkd("chain"),
        parentModelId,
        parentProvider,
      );
      activeAgents.delete(s.agent);
      updateWorking();
      results.push(r);
      if (
        r.exitCode !== 0 ||
        r.stopReason === "error" ||
        r.stopReason === "aborted"
      ) {
        return {
          content: [
            {
              type: "text" as const,
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
          type: "text" as const,
          text:
            getFinalOutput(results[results.length - 1].messages) ||
            "(no output)",
        },
      ],
      details: mkd("chain")(results),
    };
  }

  async function executeParallel(
    params: any,
    agents: AgentConfig[],
    mkd: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdate | undefined,
    activeAgents: Set<string>,
    updateWorking: () => void,
    parentModelId: string | undefined,
    parentProvider: string | undefined,
  ) {
    if (params.tasks.length > MAX_PARALLEL_TASKS)
      return {
        content: [
          {
            type: "text" as const,
            text: `Too many tasks (${params.tasks.length}). Max ${MAX_PARALLEL_TASKS}.`,
          },
        ],
        details: mkd("parallel")([]),
        isError: true,
      };
    // defensive: LLMs may omit required fields
    const missingEstimate = params.tasks.find((t: any) => t.estimatedSeconds == null);
    if (missingEstimate) {
      return {
        content: [{ type: "text" as const, text: `${MISSING_ESTIMATE_ERROR} (parallel task, agent: ${missingEstimate.agent})` }],
        details: mkd("parallel")([]),
        isError: true,
      };
    }
    const invalidEstimate = params.tasks.find((t: any) => t.estimatedSeconds != null && t.estimatedSeconds <= 0);
    if (invalidEstimate) {
      return {
        content: [{ type: "text" as const, text: `estimatedSeconds must be a positive number. (parallel task, agent: ${invalidEstimate.agent})` }],
        details: mkd("parallel")([]),
        isError: true,
      };
    }
    // parallel runs concurrently — use longest task
    const maxParallelSeconds = Math.max(...params.tasks.map((t: any) => t.estimatedSeconds!));
    if (maxParallelSeconds >= MAX_SYNC_SECONDS) {
      return {
        content: [{ type: "text" as const, text: SYNC_TIME_EXCEEDED_ERROR(maxParallelSeconds) }],
        details: mkd("parallel")([]),
        isError: true,
      };
    }
    const all: SingleResult[] = params.tasks.map((t: any) => ({
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
    for (let i = 0; i < params.tasks.length; i++) {
      if (!params.tasks[i].cwd) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${MISSING_CWD_ERROR} (parallel task ${i + 1}, agent: ${params.tasks[i].agent})`,
            },
          ],
          details: mkd("parallel")([]),
          isError: true,
        };
      }
    }
    const results = await mapWithConcurrency(
      params.tasks,
      MAX_CONCURRENCY,
      async (t: any, i: number) => {
        const label = t.name || t.agent;
        activeAgents.add(label);
        updateWorking();
        const r = await runSingleAgent(
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
          parentModelId,
          parentProvider,
        );
        all[i] = r;
        activeAgents.delete(t.name || t.agent);
        updateWorking();
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
          type: "text" as const,
          text: `Parallel: ${ok}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
        },
      ],
      details: mkd("parallel")(results),
    };
  }

  async function executeSingle(
    params: any,
    agents: AgentConfig[],
    mkd: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdate | undefined,
    activeAgents: Set<string>,
    updateWorking: () => void,
    parentModelId: string | undefined,
    parentProvider: string | undefined,
  ) {
    if (!params.cwd) {
      return {
        content: [
          {
            type: "text" as const,
            text: MISSING_CWD_ERROR,
          },
        ],
        details: mkd("single")([]),
        isError: true,
      };
    }
    if (params.estimatedSeconds == null) {
      return {
        content: [{ type: "text" as const, text: MISSING_ESTIMATE_ERROR }],
        details: mkd("single")([]),
        isError: true,
      };
    }
    if (params.estimatedSeconds <= 0) {
      return {
        content: [{ type: "text" as const, text: "estimatedSeconds must be a positive number." }],
        details: mkd("single")([]),
        isError: true,
      };
    }
    if (params.estimatedSeconds >= MAX_SYNC_SECONDS) {
      return {
        content: [{ type: "text" as const, text: SYNC_TIME_EXCEEDED_ERROR(params.estimatedSeconds) }],
        details: mkd("single")([]),
        isError: true,
      };
    }
    const label = params.name || params.agent;
    activeAgents.add(label);
    updateWorking();
    const r = await runSingleAgent(
      agents,
      params.agent,
      params.task,
      params.cwd,
      undefined,
      signal,
      onUpdate,
      mkd("single"),
      parentModelId,
      parentProvider,
    );
    activeAgents.delete(label);
    updateWorking();
    const err =
      r.exitCode !== 0 ||
      r.stopReason === "error" ||
      r.stopReason === "aborted";
    if (err)
      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${r.stopReason || "failed"}: ${r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)"}`,
          },
        ],
        details: mkd("single")([r]),
        isError: true,
      };
    return {
      content: [
        { type: "text" as const, text: getFinalOutput(r.messages) || "(no output)" },
      ],
      details: mkd("single")([r]),
    };
  }

  // ── Extracted renderResult helpers ──

  function renderSingleResult(
    r: SingleResult,
    expanded: boolean,
    theme: any,
    ts: string,
    mdTheme: any,
    renderItems: (items: DisplayItem[], limit?: number) => string,
  ) {
    const isErr =
      r.exitCode !== 0 ||
      r.stopReason === "error" ||
      r.stopReason === "aborted";
    const icon = isErr ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const items = getDisplayItems(r.messages);
    const final = getFinalOutput(r.messages);
    if (expanded) {
      const c = new Container();
      let h = `${ts}${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
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
      const u = formatUsageStats({ ...r.usage, durationMs: r.durationMs }, r.model);
      if (u) {
        c.addChild(new Spacer(1));
        c.addChild(new Text(theme.fg("dim", u), 0, 0));
      }
      return c;
    }
    let t = `${ts}${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
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
    const u = formatUsageStats({ ...r.usage, durationMs: r.durationMs }, r.model);
    if (u) t += `\n${theme.fg("dim", u)}`;
    return new Text(t, 0, 0);
  }

  function renderChainResults(
    details: SubagentDetails,
    expanded: boolean,
    theme: any,
    ts: string,
    mdTheme: any,
    renderItems: (items: DisplayItem[], limit?: number) => string,
    aggUsage: (rs: SingleResult[]) => { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; durationMs: number },
  ) {
    const ok = details.results.filter((r) => r.exitCode === 0).length;
    const icon =
      ok === details.results.length
        ? theme.fg("success", "✓")
        : theme.fg("error", "✗");
    if (expanded) {
      const c = new Container();
      c.addChild(
        new Text(
          `${ts}${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${details.results.length} steps`)}`,
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
        const su = formatUsageStats({ ...r.usage, durationMs: r.durationMs }, r.model);
        if (su) c.addChild(new Text(theme.fg("dim", su), 0, 0));
      }
      const tu = formatUsageStats(aggUsage(details.results));
      if (tu) {
        c.addChild(new Spacer(1));
        c.addChild(new Text(theme.fg("dim", `Total: ${tu}`), 0, 0));
      }
      return c;
    }
    let t = `${ts}${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${details.results.length} steps`)}`;
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

  function renderParallelResults(
    details: SubagentDetails,
    expanded: boolean,
    theme: any,
    ts: string,
    mdTheme: any,
    renderItems: (items: DisplayItem[], limit?: number) => string,
    aggUsage: (rs: SingleResult[]) => { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; durationMs: number },
  ) {
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
          `${ts}${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
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
        const su = formatUsageStats({ ...r.usage, durationMs: r.durationMs }, r.model);
        if (su) c.addChild(new Text(theme.fg("dim", su), 0, 0));
      }
      const tu = formatUsageStats(aggUsage(details.results));
      if (tu) {
        c.addChild(new Spacer(1));
        c.addChild(new Text(theme.fg("dim", `Total: ${tu}`), 0, 0));
      }
      return c;
    }
    let t = `${ts}${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
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
      "ALWAYS pass cwd — use the project directory for current repo work, or the target path for external repos (e.g., ${PROJECT_TMP_DIR}/...).",
      "ALWAYS provide estimatedSeconds for sync agents. If estimated time is 30 seconds or more, you MUST use async: true instead.",
      "After spawning async agents, END YOUR TURN. Do NOT write bash loops, sleep commands, or poll for results — the system delivers results automatically as a follow-up message. Spawn the agent and stop.",
    ],
    parameters: SubagentParams,

    async execute(_id, params, signal, onUpdate, ctx) {
      // Track active subagents for working indicator
      const activeAgents = new Set<string>();
      const updateWorking = () => {
        if (!ctx.hasUI) return;
        if (activeAgents.size === 0) {
          ctx.ui.setWorkingMessage();
          return;
        }
        const names = [...activeAgents];
        if (names.length === 1) {
          ctx.ui.setWorkingMessage(`🔧 ${names[0]} working...`);
        } else {
          ctx.ui.setWorkingMessage(`🔧 ${names.length} agents (${names.join(", ")})...`);
        }
      };

      const scope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, scope);
      const agents = discovery.agents;
      const confirm = params.confirmProjectAgents ?? true;
      const parentModelId = ctx.model?.id;
      const parentProvider = ctx.model?.provider;

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

      // Kill async agents — early return before mode validation
      if (params.asyncKill) {
        return executeAsyncKill(params as { asyncKill: string }, mkd);
      }

      // Enforce async-only agents — reject sync/chain calls for reviewers etc.
      {
        const requested: string[] = [];
        if (params.agent) requested.push(params.agent);
        if (params.tasks) for (const t of params.tasks) requested.push(t.agent);
        if (params.chain) for (const s of params.chain) requested.push(s.agent);
        const violators = [...new Set(requested.filter(n => ASYNC_ONLY_AGENTS.has(n)))];
        if (violators.length > 0) {
          const inChain = params.chain?.some(s => ASYNC_ONLY_AGENTS.has(s.agent));
          if (inChain) {
            return {
              content: [{ type: "text", text: `These agents cannot be used in chain mode: ${violators.join(", ")}. Dispatch them as separate async tasks instead.` }],
              details: mkd("single")([]),
              isError: true,
            };
          }
          if (params.async !== true) {
            params.async = true;
            // Set default name(s) for async display — async path requires names
            if (params.agent && !params.name) {
              params.name = params.agent;
            }
            if (params.tasks) {
              for (const t of params.tasks) {
                if (!(t as any).name) (t as any).name = t.agent;
              }
            }
          }
        }
      }

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
        return executeAsync(params, agents, mkd, parentModelId, parentProvider, ctx);
      }

      // Chain mode
      if (params.chain && params.chain.length > 0) {
        return executeChain(params, agents, mkd, signal, onUpdate, activeAgents, updateWorking, parentModelId, parentProvider);
      }

      // Parallel mode
      if (params.tasks && params.tasks.length > 0) {
        return executeParallel(params, agents, mkd, signal, onUpdate, activeAgents, updateWorking, parentModelId, parentProvider);
      }

      // Single mode
      if (params.agent && params.task) {
        return executeSingle(params, agents, mkd, signal, onUpdate, activeAgents, updateWorking, parentModelId, parentProvider);
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

    renderCall(args, theme, context) {
      if (!context.state.startedAt) context.state.startedAt = clockHHMM();
      const ts = theme.fg("dim", `[${context.state.startedAt}] `);
      const scope: AgentScope = args.agentScope ?? "user";
      if (args.chain?.length > 0) {
        const chainEst = args.chain.every((s: any) => s.estimatedSeconds != null)
          ? theme.fg("dim", ` ~${args.chain.reduce((sum: number, s: any) => sum + s.estimatedSeconds, 0)}s (sum)`)
          : "";
        let t =
          ts +
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`) +
          theme.fg("muted", ` [${scope}]`) + chainEst;
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
        const parallelEst = args.tasks.every((tk: any) => tk.estimatedSeconds != null)
          ? theme.fg("dim", ` ~${Math.max(...args.tasks.map((tk: any) => tk.estimatedSeconds))}s (max)`)
          : "";
        let t =
          ts +
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
          theme.fg("muted", ` [${scope}]`) + parallelEst;
        for (const tk of args.tasks.slice(0, 3))
          t += `\n  ${theme.fg("accent", tk.agent)}${theme.fg("dim", ` ${tk.task.length > 40 ? tk.task.slice(0, 40) + "..." : tk.task}`)}`;
        if (args.tasks.length > 3)
          t += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(t, 0, 0);
      }
      const asyncLabel = args.async === true ? theme.fg("warning", " [async]") : "";
      const estLabel = args.estimatedSeconds != null && args.async !== true ? theme.fg("dim", ` ~${args.estimatedSeconds}s`) : "";
      let t =
        ts +
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", args.agent || "...") +
        theme.fg("muted", ` [${scope}]`) + asyncLabel + estLabel;
      t += `\n  ${theme.fg("dim", args.task ? (args.task.length > 60 ? args.task.slice(0, 60) + "..." : args.task) : "...")}`;
      return new Text(t, 0, 0);
    },

    renderResult(result, { expanded }, theme, context) {
      if (!context.state.completedAt) context.state.completedAt = clockHHMM();
      const ts = theme.fg("dim", `[${context.state.completedAt}] `);
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const t = result.content[0];
        return new Text(ts + (t?.type === "text" ? t.text : "(no output)"), 0, 0);
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
          durationMs: 0,
        };
        for (const r of rs) {
          t.input += r.usage.input;
          t.output += r.usage.output;
          t.cacheRead += r.usage.cacheRead;
          t.cacheWrite += r.usage.cacheWrite;
          t.cost += r.usage.cost;
          t.turns += r.usage.turns;
          t.durationMs = Math.max(t.durationMs, r.durationMs || 0);
        }
        return t;
      };

      // Single
      if (details.mode === "single" && details.results.length === 1) {
        return renderSingleResult(details.results[0], expanded, theme, ts, mdTheme, renderItems);
      }

      // Chain
      if (details.mode === "chain") {
        return renderChainResults(details, expanded, theme, ts, mdTheme, renderItems, aggUsage);
      }

      // Parallel
      if (details.mode === "parallel") {
        return renderParallelResults(details, expanded, theme, ts, mdTheme, renderItems, aggUsage);
      }

      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
    },
  });
}
