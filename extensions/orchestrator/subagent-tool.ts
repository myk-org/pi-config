/**
 * Subagent tool — delegates tasks to specialist subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../shared/logger.js";
import { sendSystemNote } from "../shared/system-note.js";
import { publishedTaskStore } from "../shared/task-store-bridge.js";
import { createBridgedUi } from "../shared/ui-bridge.js";
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
import { type AgentConfig, type AgentScope, discoverAgentByName, discoverAgents } from "./agents.js";
import type { AsyncChainState } from "./async-agents.js";
import { beginSyncAgentRun } from "./sync-agent-runs.js";

// Task store access via the pitasks module.
// `taskStore` is `export let` — a live binding the pitasks extension assigns when it
// initializes. Copying the value at import time captured `undefined` and disabled
// task-id validation for the whole session (issue #1016), so the binding is read fresh.
let _pitasksModule: any = null;
let _pitasksLoad: Promise<any> | null = null;
async function pitasksModule(): Promise<any> {
  if (_pitasksModule) return _pitasksModule;
  if (!_pitasksLoad) {
    _pitasksLoad = (async () => {
      try {
        _pitasksModule = await import("../pitasks/index.js");
        return _pitasksModule;
      } catch (err) {
        log.warn(`[subagent] pitasks module unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
        _pitasksLoad = null; // retry on the next call
        return null;
      }
    })();
  }
  return _pitasksLoad;
}

/** The live task store, or null while pitasks has not initialized it yet.
 *  Read from the global symbol registry: this tool's module instance cannot see the
 *  pitasks extension's `export let taskStore` binding (it snapshots `undefined`), which
 *  is why task-id validation silently failed open (issue #1016). */
async function getTaskStore(sessionId?: string): Promise<any> {
  const published = publishedTaskStore(sessionId);
  if (published) return published;
  // Fall back to the module binding for in-process loads that share this instance.
  const mod = await pitasksModule();
  const store = mod?.taskStore ?? null;
  if (!store) {
    // Validation is about to be skipped: that is a degraded state, not routine flow.
    log.warn("task_store_unavailable", { note: "pitasks store not initialized — taskId validation skipped" });
  }
  return store;
}
import { autoMarkInProgress, autoCompleteTask, resolveTaskStorePath, type AsyncKillOrigin } from "./async-agents.js";
import { getSetting } from "./project-settings.js";
import { checkSyncLimit } from "./sync-limit.js";
import { resolveAgentModelProvider } from "./resolve-agent-model.js";
import { buildSubagentChildSpec } from "./subagent-child-spec.js";
import { parseModelOverride, mergeModelOverride } from "./parse-model-override.js";
import { clockHHMM, formatElapsedDuration, getPiInvocation, getProjectTmpDir } from "./utils.js";

export { resolveAgentModelProvider, parseModelOverride, checkSyncLimit };

// ── Constants ────────────────────────────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MISSING_CWD_ERROR = "Missing required parameter: cwd. Always specify the working directory for subagent tasks.";
// Resolved per-call from settings
const log = createLogger("subagent");
const SYNC_TIME_EXCEEDED_ERROR = (seconds: number, limit: number, cwd: string) => {
  log.info("sync_time_exceeded", "seconds", seconds, "limit", limit, "cwd", cwd);
  return `Estimated time ${seconds}s meets or exceeds ${limit}s sync limit. Use async: true instead.`;
};
const MISSING_ESTIMATE_ERROR = "Missing required parameter: estimatedSeconds. Provide an estimated duration in seconds for sync agent tasks.";

/** Cap for the {previous} substitution: the whole task becomes ONE argv entry, so a
 *  large result would blow past ARG_MAX and fail the next step's spawn. */
const MAX_PREVIOUS_CHARS = 32_000;

/** Truncate a step result for the next step, saying how much was dropped. */
function capPrevious(previous: string): string {
  const dropped = previous.length - MAX_PREVIOUS_CHARS;
  if (dropped <= 0) return previous;
  return `${previous.slice(0, MAX_PREVIOUS_CHARS)}\n\n[truncated: ${dropped} of ${previous.length} chars dropped to keep the next step's task argument under the OS limit]`;
}

/** Substitute {previous} literally — String.replace would expand $&, $$, $' and $` in the result. */
function withPrevious(task: string, previous: string): string {
  if (!task.includes("{previous}")) return task;
  return task.split("{previous}").join(capPrevious(previous));
}

let syncPenalty = 0;
let lastSyncAgent = "";
let lastSyncEstimate = 0;
let lastSyncActual = 0;

/** Agents that MUST be dispatched with async: true. Sync calls are rejected.
 *  Keep in sync with rules/20-code-review-loop.md when changing this list. */
const ASYNC_ONLY_AGENTS = new Set([
  "code-reviewer-quality",
  "code-reviewer-guidelines",
  "code-reviewer-security",
  "code-reviewer-docs",
  "code-reviewer-spec",
]);
// ── Schemas ──────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task to delegate" }),
  cwd: Type.String({ description: "Working directory" }),
  name: Type.Optional(Type.String({ description: "Display name for async status" })),
  estimatedSeconds: Type.Optional(Type.Number({ description: "Estimated seconds (required for sync)" })),
  taskId: Type.Optional(Type.String({ description: "Task ID to auto-complete when async finishes" })),
  model: Type.Optional(Type.String({ description: "Override model ('provider/model-id' or 'model-id')" })),
});
const ChainItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({
    description: "Task (supports {previous} placeholder)",
  }),
  cwd: Type.String({ description: "Working directory" }),
  estimatedSeconds: Type.Number({ description: "Estimated step seconds" }),
  taskId: Type.Optional(Type.String({ description: "Task ID to auto-complete when async step finishes" })),
});
// pi 1.5.0's StringEnum returns a pi-schema Schema, which TypeBox's Static cannot
// read — params.agentScope degraded to `unknown`. Unsafe keeps the JSON-Schema
// shape providers need while carrying the literal union in the static type.
const AgentScopeSchema = Type.Unsafe<AgentScope>({
  type: "string",
  enum: ["user", "project", "both"],
  description: 'Agent directories scope (default: "both")',
  default: "both",
});

function createSubagentParams(syncLimit: number) {
  return Type.Object({
    agent: Type.Optional(
      Type.String({ description: "Agent name (single mode)" }),
    ),
    task: Type.Optional(
      Type.String({ description: "Task to delegate (single mode)" }),
    ),
    tasks: Type.Optional(
      Type.Array(TaskItem, { description: "Parallel tasks" }),
    ),
    chain: Type.Optional(
      Type.Array(ChainItem, { description: "Sequential steps" }),
    ),
    agentScope: Type.Optional(AgentScopeSchema),
    confirmProjectAgents: Type.Optional(
      Type.Boolean({
        description: "Prompt before project agents (default: true)",
        default: true,
      }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Working directory (required for single/async)" }),
    ),
    // Optional at schema level because async mode doesn't need it; runtime enforces for sync
    estimatedSeconds: Type.Optional(
      Type.Number({ description: `Estimated seconds (required for sync; use async if >= ${syncLimit}s)` }),
    ),
    async: Type.Optional(
      Type.Boolean({ description: "Run in background; results auto-deliver (default: false)", default: false }),
    ),
    fireAndForget: Type.Optional(
      Type.Boolean({ description: "With async, run silently without conversation delivery (default: false)", default: false }),
    ),
    name: Type.Optional(
      Type.String({ description: "Display name for async status/notifications" }),
    ),
    taskId: Type.Optional(
      Type.String({ description: "Task ID to auto-complete (required for async; '-1' only for read-only check)" }),
    ),
    asyncKill: Type.Optional(
      Type.String({ description: "Kill async agent(s) by name, id prefix, or 'all'" }),
    ),
    persistSession: Type.Optional(
      Type.Boolean({ description: "Reuse agent session across calls in this project (default: false)" }),
    ),
    model: Type.Optional(
      Type.String({ description: "Override model ('provider/model-id' or 'model-id')" }),
    ),
  });
}

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
  /** Stopped from /async-status instead of failing on its own: not an overrun, not the parent's abort. */
  stoppedByRegistry?: boolean;
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
    parts.push(formatElapsedDuration(usage.durationMs));
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
  persistSession?: boolean,
  explicit?: { model?: string; provider?: string },
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

  const spec = buildSubagentChildSpec({
    mode: "sync",
    agentName,
    agent,
    task,
    cwd,
    persistSession: persistSession === true,
    parentModelId,
    parentProvider,
    explicit,
    onWarn: (msg) => log.warn("agent conditional evaluation:", msg),
  });
  const args = spec.args;
  const effectiveModel = spec.effectiveModel;

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

  // Registered before the spawn so the footer/overlay see the run from its first instant,
  // and cleared in the finally below so abort, throw and error paths cannot leak it.
  const syncRun = beginSyncAgentRun({ agent: agentName, task, cwd });
  // Two independent flags, because both can happen: a shutdown abort landing right after a
  // /async-status stop must still cancel the call instead of returning a failed result.
  // A parent abort cancels the whole call; a registry stop only fails this one result so the
  // batch's siblings survive and still render.
  let stoppedByRegistry = false;
  let parentAborted = false;
  // `proc.killed` turns true the moment SIGTERM is *sent*, so escalation needs the real exit.
  let exited = false;
  let exitCode = 1; // stays 1 when the spawn never happens, so `end` reports failure

  try {
    if (spec.resolvedPrompt) {
      const tmp = await writePromptFile(agent.name, spec.resolvedPrompt, cwd);
      tmpDir = tmp.dir;
      tmpFile = tmp.filePath;
      args.push("--append-system-prompt", tmpFile);
    }
    args.push(`Task: ${task}`);

    log.info("sync_spawn_start", agentName, "cwd", cwd, "run", syncRun.id);
    exitCode = await new Promise<number>((resolve) => {
      const inv = getPiInvocation(args);
      const proc = spawn(inv.command, inv.args, {
        cwd: cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: spec.env,
      });
      let buf = "";
      if (proc.pid != null) syncRun.setPid(proc.pid);

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
          // Current activity for the overlay: the tool an assistant message is asking
          // for, cleared as soon as the assistant answers without a tool call.
          const toolCall = msg.role === "assistant"
            ? msg.content.filter((p) => p.type === "toolCall").pop()
            : undefined;
          syncRun.setTool(toolCall && toolCall.type === "toolCall" ? toolCall.name : undefined);
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
          syncRun.setTool((ev.message as any).toolName || undefined);
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
        exited = true;
        log.info("sync_proc_close", agentName, "code", c);
        if (buf.trim()) processLine(buf);
        resolve(c ?? 0);
      });
      proc.on("error", (err) => {
        exited = true;
        log.error("sync_proc_error", agentName, err?.message);
        resolve(1);
      });

      const kill = (source: "parent-signal" | "async-status") => {
        if (source === "parent-signal") parentAborted = true;
        else stoppedByRegistry = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!exited) proc.kill("SIGKILL");
        }, 5000);
      };
      // A stop that arrived before this spawn existed is recorded on the run; kill the child
      // now instead of letting it run to completion unnoticed.
      if (syncRun.setAbort(() => kill("async-status"))) kill("async-status");
      if (signal) {
        if (signal.aborted) kill("parent-signal");
        else signal.addEventListener("abort", () => kill("parent-signal"), { once: true });
      }
    });

    log.info("sync_proc_resolved", agentName, "exitCode", exitCode, "elapsed", Date.now() - startTime, "run", syncRun.id);
    cur.exitCode = exitCode;
    cur.durationMs = Date.now() - startTime;

    // Order matters: a parent abort always wins, even when a registry stop came first.
    if (parentAborted) throw new Error("Subagent was aborted");
    if (stoppedByRegistry) {
      // One row was stopped: return a failed result so the batch's other agents survive and
      // still render, instead of rejecting the whole parallel call.
      const note = "stopped from /async-status";
      cur.exitCode = 1;
      cur.stoppedByRegistry = true;
      cur.stderr = cur.stderr.trim() ? `${cur.stderr.trim()}\n${note}` : note;
      log.info("sync_run_stopped", agentName, "run", syncRun.id);
      return cur;
    }
    return cur;
  } finally {
    // A zero exit is not success on its own: a JSON child can report an error/aborted stop
    // reason and still exit 0, which would leave the row saying "complete".
    const failedByChild = cur.stopReason === "error" || cur.stopReason === "aborted";
    const ok = !stoppedByRegistry && !parentAborted && exitCode === 0 && !failedByChild;
    syncRun.end(ok);
    if (ok) log.info("sync_run_end", syncRun.id, agentName);
    // Both stops are user-requested outcomes, not a failure of the agent.
    else if (stoppedByRegistry || parentAborted)
      log.info("sync_run_end", syncRun.id, agentName, "stopped", parentAborted ? "parent-abort" : "async-status");
    else
      log.warn("sync_run_end", syncRun.id, agentName, "exitCode", exitCode, "stopReason", cur.stopReason ?? null);
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

/** The message for a task id the store does not know; null when it is valid or exempt. */
export function taskIdError(taskId: string, lookup: (id: string) => boolean): string | null {
  if (taskId === "-1") return null;
  return lookup(taskId)
    ? null
    : `Task #${taskId} not found. Verify the task ID exists (use TaskList to check), or pass taskId: "-1" for a read-only check (editing or PR work needs a real task id).`;
}

/** Validate that a taskId references an existing task the agent may work on. Awaits the store
 *  load, so the first async call of a session validates too instead of failing open (issue #1016).
 *  An owner-assigned task is refused here: the lifecycle helpers never start or complete it, so
 *  spawning on it would do the owner's step and silently leave the task untouched (#1102). */
export async function validateTaskId(taskId: string, _cwd: string, sessionId?: string): Promise<string | null> {
  if (taskId === "-1") return null;
  const store = await getTaskStore(sessionId);
  if (!store) return null; // pitasks genuinely unavailable — warned in getTaskStore
  try {
    const task = store.get(taskId);
    if (task?.assignee === "user") {
      log.debug("task_id_validation_refused_owner", { taskId });
      return `Task #${taskId} is assigned to the user (assignee="user"); agents cannot start or complete it. Pick an llm-assigned task or pass taskId: "-1" for a read-only check.`;
    }
    return taskIdError(taskId, () => Boolean(task));
  } catch (err) {
    // Same fail-open as before, but a broken store must not look like a valid id.
    log.warn("task_id_validation_failed", { reason: String((err as Error)?.message ?? err).slice(0, 120) });
    return null;
  }
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerSubagentTool(
  pi: ExtensionAPI,
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: AgentConfig[], options?: { fireAndForget?: boolean; name?: string; parentModelId?: string; parentProvider?: string; groupId?: string; taskId?: string; projectCwd?: string; sessionId?: string; persistSession?: boolean; explicit?: { model?: string; provider?: string }; chain?: AsyncChainState; onComplete?: (result: { text: string; isError: boolean }) => void }) => { id: string; error?: string; model?: string },
  killAsyncAgent: (target: string, origin?: AsyncKillOrigin) => { killed: string[]; errors: string[] },
): void {
  // Only the orchestrator (top-level pi) can spawn subagents.
  // Child processes set PI_SUBAGENT_CHILD=1 to prevent infinite recursion.
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  // #968 part B: the project-agent approval is bridged — answerable from
  // TUI or pidash browser, first answer wins.
  const bridgedUi = createBridgedUi(pi);

  // ── Extracted execute helpers (closure over pi, spawnAsyncAgent, killAsyncAgent) ──

  // asyncKill is an LLM-issued decision, not a user action.
  function executeAsyncKill(
    params: { asyncKill: string },
    mkd: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
  ) {
    const { killed, errors } = killAsyncAgent(params.asyncKill, "orchestrator");
    log.info("subagent_async_kill", { target: params.asyncKill, origin: "orchestrator", killed: killed.length });
    const lines: string[] = [];
    if (killed.length > 0) lines.push(`Killed: ${killed.join(", ")}`);
    if (errors.length > 0) lines.push(errors.join("\n"));
    return {
      content: [{ type: "text" as const, text: lines.join("\n") || "No action taken." }],
      details: mkd("single")([]),
      isError: errors.length > 0 && killed.length === 0,
    };
  }

  /** The async paths' taskId refusal, delivered to a sync call: a sync spawn on an owner-assigned
   *  or unknown task would do the step the lifecycle helpers then refuse to record (#1102). */
  async function refuseSyncTask(
    taskErr: string,
    where: string,
    details: SubagentDetails,
    meta: { agent: string; taskId: string; mode: "chain" | "parallel" | "single" },
  ) {
    log.warn("sync_subagent_task_refused", { ...meta, reason: taskErr.slice(0, 120) });
    await sendSystemNote(
      pi,
      `🚨 CRITICAL: ${taskErr} (${where}). NO agents were spawned. Fix the taskId and retry.`,
      { customType: "subagent-taskid-error", triggerTurn: true, deliverAs: "followUp" },
    );
    return {
      content: [{ type: "text" as const, text: `${taskErr} (${where})` }],
      details,
      isError: true,
    };
  }

  /** Async chain — spawns step 1, and each step's completion hook spawns the next
   *  with {previous} replaced by that step's result text. */
  async function executeAsyncChain(
    params: any,
    agents: AgentConfig[],
    mkd: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
    parentModelId: string | undefined,
    parentProvider: string | undefined,
    ctx: any,
    explicit?: { model?: string; provider?: string },
  ) {
    const steps = (params.chain ?? []) as Array<{ agent: string; task: string; cwd: string; taskId?: string }>;
    const total = steps.length;
    const fail = (text: string) => ({
      content: [{ type: "text" as const, text }],
      details: mkd("chain")([]),
      isError: true,
    });

    if (total === 0) return fail("Error: chain array is empty — at least one step is required.");
    for (let i = 0; i < total; i++) {
      const s = steps[i];
      if (!s.agent || !s.task) return fail(`Async chain step ${i + 1} requires both agent and task.`);
      if (!s.cwd) return fail(`${MISSING_CWD_ERROR} (chain step ${i + 1}, agent: ${s.agent})`);
      if (s.taskId == null) {
        // Force a follow-up turn so the AI MUST deal with this error, as the other async paths do
        await sendSystemNote(
          pi,
          `🚨 CRITICAL: Async chain call was REJECTED — missing taskId for step ${i + 1} (${s.agent}). NO agents were spawned. You MUST retry with a taskId on every chain step. Use TaskList to find task IDs; "-1" is only for a single read-only check.`,
          { customType: "subagent-taskid-error", triggerTurn: true, deliverAs: "followUp" },
        );
        return fail(`Missing required parameter: taskId. Every async agent MUST have a taskId (chain step ${i + 1}, agent: ${s.agent}).\n\nIf this step is working on a task: pass the task ID (e.g., taskId: "5")\nIf it is only doing a single read-only check: pass taskId: "-1" (editing or PR work needs a real task id)`);
      }
      const taskErr = await validateTaskId(s.taskId, ctx.cwd, ctx.sessionManager?.getSessionId?.());
      if (taskErr) {
        await sendSystemNote(
          pi,
          `🚨 CRITICAL: ${taskErr} (chain step ${i + 1}, agent: ${s.agent}). NO agents were spawned. Fix the taskId and retry.`,
          { customType: "subagent-taskid-error", triggerTurn: true, deliverAs: "followUp" },
        );
        return fail(`${taskErr} (chain step ${i + 1}, agent: ${s.agent})`);
      }
    }
    if (syncPenalty > 0) {
      log.info("sync_penalty_reset", "async chain used");
      syncPenalty = 0;
    }

    /** Step names carry the position so the status line and result header say which step ran. */
    const stepName = (i: number): string =>
      i === 0 && params.name ? params.name : `${steps[i].agent} (chain ${i + 1}/${total})`;

    /** A step's cwd may hold project agents the parent's cwd does not — discover per step. */
    const stepAgents = (cwd: string): AgentConfig[] => discoverAgents(cwd, params.agentScope ?? "both").agents;

    const spawnStep = (i: number, prev: string): { id: string; error?: string; model?: string } => {
      const s = steps[i];
      const name = stepName(i);
      log.info("async_chain_step_spawn", { step: i + 1, total, agent: s.agent, name });
      return spawnAsyncAgent(s.agent, withPrevious(s.task, prev), s.cwd, stepAgents(s.cwd), {
        name,
        parentModelId,
        parentProvider,
        taskId: s.taskId,
        projectCwd: ctx?.cwd,
        sessionId: ctx?.sessionManager?.getSessionId?.(),
        persistSession: params.persistSession,
        explicit,
        // Durable so a reload can report the chain it can no longer continue.
        chain: {
          steps: steps.map(st => ({ agent: st.agent, task: st.task, cwd: st.cwd, taskId: st.taskId })),
          index: i,
          previous: capPrevious(prev),
        },
        onComplete: (result) => {
          if (result.isError) {
            // Chain stops here — the delivered async result header names this step.
            log.error("async_chain_step_failed", { step: i + 1, total, agent: s.agent, name, output: result.text.slice(0, 200) });
            return;
          }
          log.info("async_chain_step_complete", { step: i + 1, total, agent: s.agent, name, output_chars: result.text.length });
          if (i + 1 >= total) {
            log.info("async_chain_done", { steps: total });
            return;
          }
          log.info("async_chain_next_step", { from: i + 1, to: i + 2, agent: steps[i + 1].agent });
          let next: { id: string; error?: string; model?: string };
          try {
            next = spawnStep(i + 1, result.text);
          } catch (err) {
            // A synchronous throw must not escape the completion hook — the chain is dead either way.
            const reason = String((err as Error)?.message ?? err);
            log.error("async_chain_next_step_spawn_failed", { step: i + 2, agent: steps[i + 1].agent, error: reason });
            void sendSystemNote(
              pi,
              `🚨 Async chain stopped: step ${i + 2} (${steps[i + 1].agent}) could not be spawned after step ${i + 1} completed — ${reason}`,
              { customType: "subagent-chain-error", triggerTurn: true, deliverAs: "followUp" },
            );
            return;
          }
          if (next.error) {
            log.error("async_chain_next_step_spawn_failed", { step: i + 2, agent: steps[i + 1].agent, error: next.error });
            void sendSystemNote(
              pi,
              `🚨 Async chain stopped: step ${i + 2} (${steps[i + 1].agent}) could not be spawned after step ${i + 1} completed — ${next.error}`,
              { customType: "subagent-chain-error", triggerTurn: true, deliverAs: "followUp" },
            );
          } else {
            log.info("async_chain_next_step_spawned", { step: i + 2, id: next.id });
          }
        },
      });
    };

    const first = spawnStep(0, "");
    if (first.error) return fail(`Async chain step 1 (${steps[0].agent}) failed to spawn: ${first.error}`);
    const modelInfo = first.model ? ` (${first.model})` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Async chain started: ${stepName(0)} [${first.id}]${modelInfo}\n${total} step(s) run in sequence — each step receives the previous step's output as {previous}.\nA failed step stops the chain and is named in its result.\nUse /async-status to check progress.`,
      }],
      details: mkd("chain")([]),
    };
  }

  async function executeAsync(
    params: any,
    agents: AgentConfig[],
    mkd: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
    parentModelId: string | undefined,
    parentProvider: string | undefined,
    ctx: any,
    explicit?: { model?: string; provider?: string },
  ) {
    if (params.chain) {
      return executeAsyncChain(params, agents, mkd, parentModelId, parentProvider, ctx, explicit);
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
        const errorMsg = `Missing required parameter: taskId. Every async agent MUST have a taskId.\n\nMissing taskId for: ${noTaskId.map((t: any) => t.agent).join(", ")}\n\nIf an agent is working on a task: pass the task ID (e.g., taskId: "5")\nIf an agent is only doing a single read-only check: pass taskId: "-1" (editing or PR work needs a real task id)`;
        // Force a follow-up turn so the AI MUST deal with this error
        await sendSystemNote(
          pi,
          `🚨 CRITICAL: Async subagent call was REJECTED — missing taskId for: ${noTaskId.map((t: any) => t.agent).join(", ")}. NO agents were spawned. You MUST retry with taskId for each agent. Use TaskList to find task IDs; "-1" is only for a single read-only check.`,
          { customType: "subagent-taskid-error", triggerTurn: true, deliverAs: "followUp" },
        );
        return {
          content: [{ type: "text" as const, text: errorMsg }],
          details: mkd("single")([]),
          isError: true,
        };
      }
      for (const t of params.tasks) {
        const tid = (t as any).taskId as string;
        const taskErr = await validateTaskId(tid, ctx.cwd, ctx.sessionManager?.getSessionId?.());
        if (taskErr) {
          await sendSystemNote(
            pi,
            `🚨 CRITICAL: ${taskErr} (agent: ${t.agent}). NO agents were spawned. Fix the taskId and retry.`,
            { customType: "subagent-taskid-error", triggerTurn: true, deliverAs: "followUp" },
          );
          return {
            content: [{ type: "text" as const, text: `${taskErr} (agent: ${t.agent})` }],
            details: mkd("single")([]),
            isError: true,
          };
        }
      }
      const results: string[] = [];
      const errors: string[] = [];
      // Tag parallel async tasks with one groupId for display/status grouping only —
      // each task's result is delivered the moment that task finishes (issue #1110).
      const groupId = params.tasks.length > 1
        ? `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : undefined;
      for (const t of params.tasks) {
        const taskExplicit = mergeModelOverride(t.model, explicit);
        const r = spawnAsyncAgent(t.agent, t.task, t.cwd, agents, {
          fireAndForget: params.fireAndForget,
          name: (t as any).name,
          parentModelId,
          parentProvider,
          groupId,
          taskId: (t as any).taskId,
          projectCwd: ctx?.cwd,
          sessionId: ctx?.sessionManager?.getSessionId?.(),
          persistSession: params.persistSession,
          explicit: taskExplicit,
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
      const errorMsg = `Missing required parameter: taskId. Every async agent MUST have a taskId.\n\nIf this agent is working on a task: pass the task ID (e.g., taskId: "5")\nIf this agent is only doing a single read-only check: pass taskId: "-1" (editing or PR work needs a real task id)\n\nExample: subagent(agent="${params.agent}", task="...", async=true, name="${params.name}", taskId="-1")`;
      // Force a follow-up turn so the AI MUST deal with this error
      await sendSystemNote(
        pi,
        `🚨 CRITICAL: Async subagent call for "${params.agent}" was REJECTED — missing taskId. The agent was NOT spawned. You MUST retry the subagent call with taskId. Use TaskList to find the task ID; "-1" is only for a single read-only check. Do NOT proceed without fixing this.`,
        { customType: "subagent-taskid-error", triggerTurn: true, deliverAs: "followUp" },
      );
      return {
        content: [{ type: "text" as const, text: errorMsg }],
        details: mkd("single")([]),
        isError: true,
      };
    }
    {
      const taskErr = await validateTaskId(params.taskId, ctx.cwd, ctx.sessionManager?.getSessionId?.());
      if (taskErr) {
        await sendSystemNote(
          pi,
          `🚨 CRITICAL: ${taskErr} The agent was NOT spawned. Fix the taskId and retry.`,
          { customType: "subagent-taskid-error", triggerTurn: true, deliverAs: "followUp" },
        );
        return {
          content: [{ type: "text" as const, text: taskErr }],
          details: mkd("single")([]),
          isError: true,
        };
      }
    }
    if (syncPenalty > 0) {
      log.info("sync_penalty_reset", "async used");
      syncPenalty = 0;
    }
    const result = spawnAsyncAgent(params.agent, params.task, params.cwd, agents, {
      fireAndForget: params.fireAndForget,
      name: params.name,
      parentModelId,
      parentProvider,
      taskId: params.taskId,
      projectCwd: ctx?.cwd,
      sessionId: ctx?.sessionManager?.getSessionId?.(),
      persistSession: params.persistSession,
      explicit: explicit,
    });
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

  function validateSyncEstimate(
    mode: "single" | "parallel" | "chain",
    items: Array<{ agent: string; estimatedSeconds?: number }>,
    cwd: string,
    mkd: (mode: "single" | "parallel" | "chain") => (results: SingleResult[]) => SubagentDetails,
  ): { ok: true; limit: number } | { ok: false; response: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails; isError: true } } {
    const contextLabel = mode === "chain" ? "chain step" : mode === "parallel" ? "parallel task" : null;
    const missing = items.find((item) => item.estimatedSeconds == null);
    if (missing) {
      const suffix = contextLabel ? ` (${contextLabel}, agent: ${missing.agent})` : "";
      return {
        ok: false,
        response: {
          content: [{ type: "text" as const, text: `${MISSING_ESTIMATE_ERROR}${suffix}` }],
          details: mkd(mode)([]),
          isError: true,
        },
      };
    }
    const invalid = items.find((item) => item.estimatedSeconds != null && item.estimatedSeconds <= 0);
    if (invalid) {
      const suffix = contextLabel ? ` (${contextLabel}, agent: ${invalid.agent})` : "";
      return {
        ok: false,
        response: {
          content: [{ type: "text" as const, text: `estimatedSeconds must be a positive number.${suffix}` }],
          details: mkd(mode)([]),
          isError: true,
        },
      };
    }

    const effectiveSeconds = mode === "chain"
      ? items.reduce((sum, item) => sum + item.estimatedSeconds!, 0)
      : mode === "parallel"
        ? Math.max(...items.map((item) => item.estimatedSeconds!))
        : items[0].estimatedSeconds!;

    const { limit } = checkSyncLimit(0, cwd);
    if (syncPenalty > 0) {
      const adjusted = effectiveSeconds + syncPenalty;
      if (adjusted >= limit) {
        if (mode === "chain") {
          log.info("sync_penalty_rejected_chain", "penalty", syncPenalty, "adjusted", adjusted);
        } else if (mode === "parallel") {
          log.info("sync_penalty_rejected_parallel", "penalty", syncPenalty, "adjusted", adjusted);
        } else {
          log.info("sync_penalty_rejected", items[0].agent, "estimate", effectiveSeconds, "penalty", syncPenalty, "adjusted", adjusted);
        }
        const estimateLabel = mode === "chain"
          ? "Chain total"
          : mode === "parallel"
            ? "Max parallel estimate"
            : "Your estimate";
        return {
          ok: false,
          response: {
            content: [{ type: "text" as const, text: `Rejected: your last sync agent '${lastSyncAgent}' estimated ${lastSyncEstimate}s but took ${lastSyncActual}s. Penalty: ${syncPenalty}s. ${estimateLabel} ${effectiveSeconds}s + penalty ${syncPenalty}s = ${adjusted}s — exceeds ${limit}s limit. Use async: true.` }],
            details: mkd(mode)([]),
            isError: true,
          },
        };
      }
    }
    if (effectiveSeconds >= limit) {
      return {
        ok: false,
        response: {
          content: [{ type: "text" as const, text: SYNC_TIME_EXCEEDED_ERROR(effectiveSeconds, limit, cwd) }],
          details: mkd(mode)([]),
          isError: true,
        },
      };
    }
    return { ok: true, limit };
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
    sessionId?: string,
    explicit?: { model?: string; provider?: string },
    projectCwd?: string,
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
    // Same guard as the async chain — no sync step runs on an owner-assigned or unknown task.
    for (let i = 0; i < params.chain.length; i++) {
      const stepTaskId = params.chain[i].taskId as string | undefined;
      if (!stepTaskId || stepTaskId === "-1") continue;
      const taskErr = await validateTaskId(stepTaskId, params.chain[i].cwd, sessionId);
      if (taskErr) {
        return refuseSyncTask(taskErr, `chain step ${i + 1}, agent: ${params.chain[i].agent}`, mkd("chain")([]), {
          agent: params.chain[i].agent,
          taskId: stepTaskId,
          mode: "chain",
        });
      }
    }
    if (!params.chain || params.chain.length === 0) {
      return { content: [{ type: "text" as const, text: "Error: chain array is empty — at least one step is required." }], details: undefined };
    }
    // defensive: LLMs may omit schema-required fields; chain runs sequentially (sum all steps)
    const chainCheck = validateSyncEstimate("chain", params.chain, params.chain[0].cwd, mkd);
    if (!chainCheck.ok) return chainCheck.response;

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
      // Auto-mark linked task as in_progress (same as async path)
      const chainTaskId = s.taskId as string | undefined;
      if (chainTaskId && chainTaskId !== "-1") {
        await autoMarkInProgress(chainTaskId, projectCwd || s.cwd, resolveTaskStorePath(projectCwd || s.cwd, sessionId), undefined, sessionId).catch(() => {});
      }
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
        params.persistSession,
        explicit,
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
      // Auto-complete linked task on success (same as async path)
      if (chainTaskId && chainTaskId !== "-1") {
        await autoCompleteTask(chainTaskId, projectCwd || s.cwd, resolveTaskStorePath(projectCwd || s.cwd, sessionId), undefined, sessionId).catch(() => {});
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
    sessionId?: string,
    explicit?: { model?: string; provider?: string },
    projectCwd?: string,
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
    // defensive: LLMs may omit required fields; parallel runs concurrently (max estimate)
    const parallelCheck = validateSyncEstimate(
      "parallel",
      params.tasks,
      params.tasks[0]?.cwd ?? process.cwd(),
      mkd,
    );
    if (!parallelCheck.ok) return parallelCheck.response;
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
    // Same guard as the async paths — no sync task runs on an owner-assigned or unknown task.
    for (const t of params.tasks) {
      const tid = (t as any).taskId as string | undefined;
      if (!tid || tid === "-1") continue;
      const taskErr = await validateTaskId(tid, t.cwd, sessionId);
      if (taskErr) {
        return refuseSyncTask(taskErr, `parallel, agent: ${t.agent}`, mkd("parallel")([]), {
          agent: t.agent,
          taskId: tid,
          mode: "parallel",
        });
      }
    }
    // Auto-mark linked tasks as in_progress
    for (const t of params.tasks) {
      const tid = (t as any).taskId as string | undefined;
      if (tid && tid !== "-1") {
        await autoMarkInProgress(tid, projectCwd || t.cwd, resolveTaskStorePath(projectCwd || t.cwd, sessionId), undefined, sessionId).catch(() => {});
      }
    }
    const results = await mapWithConcurrency(
      params.tasks,
      MAX_CONCURRENCY,
      async (t: any, i: number) => {
        const label = t.name || t.agent;
        activeAgents.add(label);
        updateWorking();
        const taskExplicit = mergeModelOverride(t.model, explicit);
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
          params.persistSession,
          taskExplicit,
        );
        all[i] = r;
        activeAgents.delete(t.name || t.agent);
        updateWorking();
        emitAll();
        // Auto-complete linked task on success (same as async path)
        const tid = t.taskId as string | undefined;
        if (
          tid &&
          tid !== "-1" &&
          r.exitCode === 0 &&
          r.stopReason !== "error" &&
          r.stopReason !== "aborted"
        ) {
          await autoCompleteTask(tid, projectCwd || t.cwd, resolveTaskStorePath(projectCwd || t.cwd, sessionId), undefined, sessionId).catch(() => {});
        }
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
    sessionId?: string,
    explicit?: { model?: string; provider?: string },
    projectCwd?: string,
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
    const singleCheck = validateSyncEstimate(
      "single",
      [{ agent: params.agent, estimatedSeconds: params.estimatedSeconds }],
      params.cwd,
      mkd,
    );
    if (!singleCheck.ok) return singleCheck.response;
    const singleLimit = singleCheck.limit;
    const label = params.name || params.agent;
    if (params.taskId && params.taskId !== "-1") {
      const taskErr = await validateTaskId(params.taskId, params.cwd, sessionId);
      if (taskErr) {
        return refuseSyncTask(taskErr, `single, agent: ${params.agent}`, mkd("single")([]), {
          agent: params.agent,
          taskId: params.taskId,
          mode: "single",
        });
      }
    }
    activeAgents.add(label);
    updateWorking();
    // Auto-mark linked task as in_progress (same as async path)
    const syncTaskId = params.taskId as string | undefined;
    if (syncTaskId && syncTaskId !== "-1") {
      await autoMarkInProgress(syncTaskId, projectCwd || params.cwd, resolveTaskStorePath(projectCwd || params.cwd, sessionId), undefined, sessionId).catch(() => {});
    }
    log.info("sync_execute_start", params.agent, "taskId", syncTaskId ?? "none");
    const syncStartTime = Date.now();
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
      params.persistSession,
      explicit,
    );
    const actualSeconds = Math.round((Date.now() - syncStartTime) / 1000);
    // A registry stop is the user killing a runaway child, not an overrun: penalising it would
    // reject the next sync call because of a child the user chose to stop.
    if (!r.stoppedByRegistry && actualSeconds > singleLimit && actualSeconds - (params.estimatedSeconds ?? 0) > 30) {
      syncPenalty = actualSeconds - (params.estimatedSeconds ?? 0);
      lastSyncAgent = params.agent;
      lastSyncEstimate = params.estimatedSeconds ?? 0;
      lastSyncActual = actualSeconds;
      log.info("sync_penalty_set", params.agent, "estimate", params.estimatedSeconds, "actual", actualSeconds, "penalty", syncPenalty);
    }
    log.info("sync_execute_done", params.agent, "exitCode", r.exitCode, "stopReason", r.stopReason, "elapsed", Date.now() - syncStartTime);
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
    // Auto-complete linked task on success (same as async path)
    if (syncTaskId && syncTaskId !== "-1") {
      await autoCompleteTask(syncTaskId, projectCwd || params.cwd, resolveTaskStorePath(projectCwd || params.cwd, sessionId), undefined, sessionId).catch(() => {});
    }
    log.info("sync_execute_returning", params.agent);
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

  function renderMultiAgentResults(
    details: SubagentDetails,
    expanded: boolean,
    theme: any,
    ts: string,
    mdTheme: any,
    renderItems: (items: DisplayItem[], limit?: number) => string,
    aggUsage: (rs: SingleResult[]) => { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; durationMs: number },
    opts: {
      label: string;
      icon: string;
      status: string;
      isRunning: boolean;
      stepPrefix: (r: SingleResult) => string;
    },
  ) {
    const { label, icon, status, isRunning, stepPrefix } = opts;
    if (expanded && !isRunning) {
      const c = new Container();
      c.addChild(
        new Text(
          `${ts}${icon} ${theme.fg("toolTitle", theme.bold(label))}${theme.fg("accent", status)}`,
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
            `${theme.fg("muted", stepPrefix(r))}${theme.fg("accent", r.agent)} ${ri}`,
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
    let t = `${ts}${icon} ${theme.fg("toolTitle", theme.bold(label))}${theme.fg("accent", status)}`;
    for (const r of details.results) {
      const ri =
        r.exitCode === -1
          ? theme.fg("warning", "⏳")
          : r.exitCode === 0
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");
      const di = getDisplayItems(r.messages);
      t += `\n\n${theme.fg("muted", stepPrefix(r))}${theme.fg("accent", r.agent)} ${ri}`;
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

  const syncLimit = checkSyncLimit(0, process.cwd()).limit;
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate tasks to specialized subagents with isolated context (single, parallel, or chain with {previous}). Agents come from package, user (~/.pi/agent/agents), and project (.pi/agents).",
    promptSnippet:
      "Delegate tasks to specialized subagents (single, parallel, or chain mode)",
    promptGuidelines: [
      "Delegate specialist work by intent (python → python-expert, git → git-expert, PR → github-expert, etc.).",
      "Use tasks[] for independent parallel work; chain[] with {previous} for sequential steps.",
      `Use async: true if estimated >= ${syncLimit}s or the next step doesn't need the output immediately; end your turn after spawning async agents (no bash/sleep/poll loops — results auto-deliver).`,
      "Always pass cwd and (for sync) estimatedSeconds.",
    ],
    parameters: createSubagentParams(syncLimit),

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

      const scope: AgentScope = params.agentScope ?? "both";
      const fallbackCwd = ctx?.cwd || params.cwd || params.tasks?.[0]?.cwd || params.chain?.[0]?.cwd || process.cwd();
      const discovery = discoverAgents(fallbackCwd, scope);
      const agents = discovery.agents;
      const confirm = params.confirmProjectAgents ?? true;
      const parentModelId = ctx.model?.id as string | undefined;
      const parentProvider = ctx.model?.provider as string | undefined;
      // Parse explicit model override from params (applies to all execution modes)
      const explicitOverride = parseModelOverride(params.model);

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

      // Enforce async-only agents — always run async.
      {
        const requested: string[] = [];
        if (params.agent) requested.push(params.agent);
        if (params.tasks) for (const t of params.tasks) requested.push(t.agent);
        if (params.chain) for (const s of params.chain) requested.push(s.agent);
        const violators = [...new Set(requested.filter(n => ASYNC_ONLY_AGENTS.has(n)))];
        if (violators.length > 0) {
          const inChain = params.chain?.some(s => ASYNC_ONLY_AGENTS.has(s.agent));
          // An async chain satisfies the async-only requirement; a sync chain runs steps in the foreground.
          if (inChain && params.async !== true) {
            return {
              content: [{ type: "text", text: `These agents can only run async, and a sync chain runs its steps in the foreground: ${violators.join(", ")}. Async chain needs async: true.` }],
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
        // A chain step carries its own cwd, so it can resolve a DIFFERENT project agent set
        // than the parent's — including a project agent that shadows a user agent of the
        // same name. Resolve every step against its own cwd or the approval is bypassed.
        const projAgents: AgentConfig[] = [];
        const sources: string[] = [];
        for (const name of requested) {
          const parentAgent = agents.find((a) => a.name === name);
          if (parentAgent?.source === "project") {
            projAgents.push(parentAgent);
            if (discovery.projectAgentsDir) sources.push(discovery.projectAgentsDir);
          }
        }
        // Async chains resolve agents per step, so a step's own cwd can contribute a
        // project agent — including one that SHADOWS a parent user agent of the same name.
        // Sync chains still resolve against the parent list, so asking about their steps
        // would prompt for an agent that never runs.
        if (params.async === true) {
          // Structured key: a "@" join is ambiguous when a name or path contains "@".
          const seen = new Set(projAgents.map((a) => JSON.stringify([a.name, discovery.projectAgentsDir ?? ""])));
          for (const step of params.chain ?? []) {
            if (!step.cwd || step.cwd === ctx.cwd) continue;
            const { agent: stepAgent, projectAgentsDir: stepProjectAgentsDir } = discoverAgentByName(step.cwd, scope, step.agent);
            if (stepAgent?.source !== "project") continue;
            // Dedupe on name+directory: the same name in a second project dir is a
            // DIFFERENT agent and its source must appear in the prompt.
            const key = JSON.stringify([stepAgent.name, stepProjectAgentsDir ?? ""]);
            if (seen.has(key)) continue;
            seen.add(key);
            projAgents.push(stepAgent);
            if (stepProjectAgentsDir) sources.push(stepProjectAgentsDir);
          }
        }
        if (projAgents.length > 0) {
          const uniqueSources = [...new Set(sources)];
          const ok = await bridgedUi.confirm(
            ctx,
            "Run project-local agents?",
            `Agents: ${projAgents.map((a) => a.name).join(", ")}\nSource: ${uniqueSources.join(", ")}`,
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

      const explicit = explicitOverride;

      // Async mode — spawn in background and return immediately
      if (params.async === true) {
        return await executeAsync(params, agents, mkd, parentModelId, parentProvider, ctx, explicit);
      }

      const sessionId = ctx.sessionManager?.getSessionId?.();
      const projectCwd = ctx?.cwd;

      // Chain mode
      if (params.chain && params.chain.length > 0) {
        return await executeChain(params, agents, mkd, signal, onUpdate, activeAgents, updateWorking, parentModelId, parentProvider, sessionId, explicit, projectCwd);
      }

      // Parallel mode
      if (params.tasks && params.tasks.length > 0) {
        return await executeParallel(params, agents, mkd, signal, onUpdate, activeAgents, updateWorking, parentModelId, parentProvider, sessionId, explicit, projectCwd);
      }

      // Single mode
      if (params.agent && params.task) {
        return await executeSingle(params, agents, mkd, signal, onUpdate, activeAgents, updateWorking, parentModelId, parentProvider, sessionId, explicit, projectCwd);
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
      const scope: AgentScope = args.agentScope ?? "both";
      if (args.chain && args.chain.length > 0) {
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
      if (args.tasks && args.tasks.length > 0) {
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
        const ok = details.results.filter((r) => r.exitCode === 0).length;
        return renderMultiAgentResults(details, expanded, theme, ts, mdTheme, renderItems, aggUsage, {
          label: "chain ",
          icon: ok === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗"),
          status: `${ok}/${details.results.length} steps`,
          isRunning: false,
          stepPrefix: (r) => `─── Step ${r.step}: `,
        });
      }

      // Parallel
      if (details.mode === "parallel") {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const ok = details.results.filter((r) => r.exitCode === 0).length;
        const fail = details.results.filter((r) => r.exitCode > 0).length;
        const isRunning = running > 0;
        return renderMultiAgentResults(details, expanded, theme, ts, mdTheme, renderItems, aggUsage, {
          label: "parallel ",
          icon: isRunning
            ? theme.fg("warning", "⏳")
            : fail > 0
              ? theme.fg("warning", "◐")
              : theme.fg("success", "✓"),
          status: isRunning
            ? `${ok + fail}/${details.results.length} done, ${running} running`
            : `${ok}/${details.results.length} tasks`,
          isRunning,
          stepPrefix: () => "─── ",
        });
      }

      const t = result.content[0];
      return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
    },
  });
}
