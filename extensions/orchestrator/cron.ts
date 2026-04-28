/**
 * Cron-like scheduled tasks — pi-process-scoped.
 *
 * Tasks survive /reload, /resume, /new but die on pi exit.
 * Persisted to a PID-scoped file so they survive extension re-evaluation.
 *
 * The /cron command is a natural-language interface — the AI parses
 * the user's intent and calls the cron_manage tool with structured params.
 *
 * Slash command tasks (starting with /) execute as commands.
 * Prompt tasks run as async agents with triggerTurn: true.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "./agents.js";

// ── Types ────────────────────────────────────────────────────────────

interface CronTask {
  id: number;
  description: string; // human-readable description
  task: string; // what to execute
  intervalMs?: number; // for interval-based
  atHour?: number; // for time-based (daily)
  atMinute?: number;
  createdAt: number;
  lastRun?: number;
  nextRun?: number;
}

// ── Persistence ──────────────────────────────────────────────────────

const CRON_FILE = path.join(os.tmpdir(), `pi-cron-${process.pid}.json`);

function saveCrons(tasks: CronTask[]): void {
  try {
    fs.writeFileSync(CRON_FILE, JSON.stringify(tasks), { mode: 0o600 });
  } catch {}
}

function loadCrons(): CronTask[] {
  try {
    const data = JSON.parse(fs.readFileSync(CRON_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function cleanupOrphanedCronFiles(): void {
  try {
    const dir = os.tmpdir();
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^pi-cron-(\d+)\.json$/);
      if (m && +m[1] !== process.pid) {
        try { process.kill(+m[1], 0); } catch {
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
      }
    }
  } catch {}
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function formatSchedule(task: CronTask): string {
  if (task.intervalMs) return `every ${formatDuration(task.intervalMs)}`;
  if (task.atHour !== undefined && task.atMinute !== undefined) {
    return `daily at ${String(task.atHour).padStart(2, "0")}:${String(task.atMinute).padStart(2, "0")}`;
  }
  return "unknown";
}

function msUntilNextTime(hour: number, minute: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

// ── Registration ─────────────────────────────────────────────────────

export function registerCron(
  pi: ExtensionAPI,
  spawnAsyncAgent: (agentName: string, task: string, cwd: string, agents: any[], options?: { fireAndForget?: boolean; name?: string }) => { id: string; error?: string },
): void {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  const tasks = new Map<number, CronTask>();
  const timers = new Map<number, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();
  let nextId = 1;
  let lastCwd = "";
  let lastCtx: any = null;

  function updateCronStatus() {
    const count = tasks.size;
    if (lastCtx?.hasUI) {
      if (count > 0) {
        lastCtx.ui.setStatus("crons", lastCtx.ui.theme.fg("muted", `⏰ ${count} cron${count > 1 ? "s" : ""}`));
      } else {
        lastCtx.ui.setStatus("crons", lastCtx.ui.theme.fg("muted", `⏰ 0 crons`));
      }
    }
    pi.events.emit("pidash:cron-status", {
      count,
      tasks: [...tasks.values()].map(t => ({
        id: t.id,
        description: t.description,
        schedule: formatSchedule(t),
        lastRun: t.lastRun,
        nextRun: t.nextRun,
      })),
    });
  }

  function executeCronTask(task: CronTask) {
    task.lastRun = Date.now();
    saveCrons([...tasks.values()]);

    const cmd = task.task.trim();

    if (cmd.startsWith("/")) {
      // Slash command — send as user message
      pi.sendUserMessage(cmd, { deliverAs: "followUp" });
    } else {
      // Prompt task — run as async agent, result surfaces to AI
      const cwd = lastCwd || process.cwd();
      const { agents } = discoverAgents(cwd, "user");
      spawnAsyncAgent("worker", cmd, cwd, agents, { name: `Cron: ${task.description.slice(0, 40)}` });
    }
  }

  function startTask(task: CronTask) {
    const existing = timers.get(task.id);
    if (existing) { clearTimeout(existing as any); clearInterval(existing as any); }

    if (task.intervalMs) {
      const timer = setInterval(() => executeCronTask(task), task.intervalMs);
      if ((timer as any).unref) (timer as any).unref();
      timers.set(task.id, timer);
    } else if (task.atHour !== undefined && task.atMinute !== undefined) {
      const scheduleNext = () => {
        const ms = msUntilNextTime(task.atHour!, task.atMinute!);
        task.nextRun = Date.now() + ms;
        saveCrons([...tasks.values()]);
        const timer = setTimeout(() => {
          executeCronTask(task);
          scheduleNext();
        }, ms);
        if (timer.unref) timer.unref();
        timers.set(task.id, timer);
      };
      scheduleNext();
    }
  }

  function stopTask(id: number) {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer as any);
      clearInterval(timer as any);
      timers.delete(id);
    }
  }

  // Restore persisted crons on session start
  pi.on("session_start", (_event, ctx) => {
    lastCwd = ctx.cwd;
    lastCtx = ctx;
    cleanupOrphanedCronFiles();

    // Restore from persistence (after /reload or /new)
    const restored = loadCrons();
    for (const task of restored) {
      if (!tasks.has(task.id)) {
        if (task.id >= nextId) nextId = task.id + 1;
        tasks.set(task.id, task);
      }
    }
    // Restart all timers with fresh context
    for (const task of tasks.values()) {
      startTask(task);
    }
    updateCronStatus();
  });

  // Handle cron kill from pidash browser
  pi.events.on("pidash:cron-kill", (data: unknown) => {
    const target = data as string;
    if (target === "all") {
      for (const id of [...tasks.keys()]) {
        stopTask(id);
        tasks.delete(id);
      }
    } else {
      const id = parseInt(target, 10);
      if (id && tasks.has(id)) {
        stopTask(id);
        tasks.delete(id);
      }
    }
    saveCrons([...tasks.values()]);
    updateCronStatus();
  });

  // Stop all timers and persist on shutdown
  pi.on("session_shutdown", () => {
    for (const id of timers.keys()) {
      stopTask(id);
    }
    saveCrons([...tasks.values()]);
  });

  // Register cron_manage tool — the AI calls this with structured params
  pi.registerTool({
    name: "cron_manage",
    description: "Manage scheduled cron tasks. Use this tool when the user wants to schedule, list, or remove recurring tasks.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("remove")], {
        description: "The action to perform",
      }),
      description: Type.Optional(Type.String({
        description: "Human-readable description of the task (for 'add')",
      })),
      task: Type.Optional(Type.String({
        description: "What to execute — a prompt for the AI or a /slash-command (for 'add')",
      })),
      interval_seconds: Type.Optional(Type.Number({
        description: "Run every N seconds (for interval-based 'add'). Minimum 10 seconds.",
      })),
      at_hour: Type.Optional(Type.Number({
        description: "Hour (0-23) for daily time-based schedule (for 'add')",
      })),
      at_minute: Type.Optional(Type.Number({
        description: "Minute (0-59) for daily time-based schedule (for 'add')",
      })),
      id: Type.Optional(Type.Number({
        description: "Task ID to remove (for 'remove')",
      })),
    }),
    async execute(_id, params) {
      const action = params.action as string;

      if (action === "add") {
        if (!params.task) {
          return { content: [{ type: "text", text: "Error: 'task' is required for add action" }] };
        }
        if (!params.interval_seconds && params.at_hour === undefined) {
          return { content: [{ type: "text", text: "Error: either 'interval_seconds' or 'at_hour'+'at_minute' is required" }] };
        }

        const intervalMs = params.interval_seconds ? Math.max(10, params.interval_seconds) * 1000 : undefined;
        const atHour = params.at_hour !== undefined ? Math.max(0, Math.min(23, params.at_hour)) : undefined;
        const atMinute = params.at_minute !== undefined ? Math.max(0, Math.min(59, params.at_minute)) : (atHour !== undefined ? 0 : undefined);

        const task: CronTask = {
          id: nextId++,
          description: (params.description as string) || (params.task as string).slice(0, 60),
          task: params.task as string,
          intervalMs,
          atHour,
          atMinute,
          createdAt: Date.now(),
        };

        tasks.set(task.id, task);
        startTask(task);
        saveCrons([...tasks.values()]);

        updateCronStatus();
        return {
          content: [{
            type: "text",
            text: `Cron #${task.id} created: ${formatSchedule(task)} → ${task.description}`,
          }],
        };
      }

      if (action === "list") {
        if (tasks.size === 0) {
          return { content: [{ type: "text", text: "No scheduled tasks." }] };
        }
        const lines = [...tasks.values()].map(t => {
          const last = t.lastRun ? new Date(t.lastRun).toLocaleTimeString() : "never";
          return `#${t.id} | ${formatSchedule(t)} | ${t.description} | last run: ${last}`;
        });
        return {
          content: [{ type: "text", text: `Scheduled tasks:\n\n${lines.join("\n")}` }],
        };
      }

      if (action === "remove") {
        const id = params.id as number;
        if (!id || !tasks.has(id)) {
          return { content: [{ type: "text", text: `Task #${id || "?"} not found.` }] };
        }
        const task = tasks.get(id)!;
        stopTask(id);
        tasks.delete(id);
        saveCrons([...tasks.values()]);
        updateCronStatus();
        return {
          content: [{ type: "text", text: `Cron #${id} removed: ${task.description}` }],
        };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
    },
  });

  // /cron command — natural language interface, forwarded to the AI
  pi.registerCommand("cron", {
    description: "Schedule recurring tasks — /cron <natural language>",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const text = (args || "").trim();
      if (!text) {
        pi.sendUserMessage(
          "The user wants to manage scheduled cron tasks. Show them the current cron tasks using the cron_manage tool with action 'list'. Then explain how they can add or remove tasks using natural language, for example:\n\n- /cron check for new issues every 2 hours\n- /cron run /review-handler daily at noon\n- /cron remind me every 30 minutes to check build status\n- /cron stop task 1\n- /cron show my tasks",
          { deliverAs: "followUp" },
        );
        return;
      }

      // Forward the user's natural language to the AI
      pi.sendUserMessage(
        `The user wants to manage a cron/scheduled task. Parse their request and use the cron_manage tool to fulfill it.\n\nUser request: "${text}"\n\nInterpret the schedule and task from the natural language. For interval-based schedules, convert to seconds. For time-based schedules, extract hour and minute. If they want to list or remove tasks, use the appropriate action.`,
        { deliverAs: "followUp" },
      );
    },
  });
}
