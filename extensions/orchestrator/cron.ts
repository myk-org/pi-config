/**
 * Cron-like scheduled tasks — pi-process-scoped.
 *
 * Tasks survive /reload, /resume, /new but die on pi exit.
 * Persisted to a session-scoped file so they survive extension re-evaluation.
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decideAsyncLlmDispatch } from "./async-capability.js";
import { discoverAgents } from "./agents.js";
import { formatCronSchedule, toCronStatusTaskView } from "./cron-status-format.js";
import { openCronStatusOverlay } from "./cron-status-ui.js";
import { getProjectTmpDir, parseProcStartTime } from "./utils.js";

// ── Types ────────────────────────────────────────────────────────────

export interface CronTask {
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

/** Shared mutable state + helpers passed to extracted registration functions */
interface CronInternals {
  tasks: Map<number, CronTask>;
  nextId: number;
  lastCwd: string;
  lastCtx: any;
  startTask(task: CronTask): void;
  stopTask(id: number): void;
  updateCronStatus(): void;
}

// ── Persistence ──────────────────────────────────────────────────────

let CRON_FILE = ""; // Set on session_start to project-scoped dir
/** Ignore fs.watch echoes from our own writes. */
let CRON_IGNORE_WATCH_UNTIL = 0;

/** Unique session suffix — prevents PID collisions across containers */
/** Suffix must be unique across containers but stable across reloads (same process).
 *  Use process start time from /proc or process.uptime() as a stable identifier. */
const SESSION_SUFFIX = (() => {
  try {
    const stat = fs.readFileSync("/proc/self/stat", "utf-8");
    const startTime = parseProcStartTime(stat);
    if (!startTime) throw new Error("failed to parse start time");
    return `${process.pid}-${startTime}`;
  } catch {
    const seed = `${process.pid}-${process.ppid}-${process.argv.join(",")}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    return `${process.pid}-${Math.abs(hash).toString(36)}`;
  }
})();

/** Matches both old (cron-{pid}.json) and new (cron-{pid}-{suffix}.json) formats */
const CRON_FILE_RE = /^cron-(\d+)(?:-[^.]+)?\.json$/;

/** Get current cron file path — used by autocomplete */
export function getCronFilePath(): string { return CRON_FILE; }

function saveCrons(tasks: CronTask[]): void {
  if (!CRON_FILE) return;
  try {
    CRON_IGNORE_WATCH_UNTIL = Date.now() + 400;
    fs.writeFileSync(CRON_FILE, JSON.stringify(tasks), { mode: 0o600 });
  } catch (e: any) { console.debug("[cron] save crons failed:", e?.message || e); }
}

function loadCrons(): CronTask[] {
  if (!CRON_FILE) return [];
  try {
    const data = JSON.parse(fs.readFileSync(CRON_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function cleanupOrphanedCronFiles(): void {
  try {
    const dir = path.dirname(CRON_FILE);
    const myFile = path.basename(CRON_FILE);
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(CRON_FILE_RE);
      if (!m || f === myFile) continue;
      // Old format (no suffix) — always delete (legacy)
      const isLegacy = /^cron-\d+\.json$/.test(f);
      if (isLegacy) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
        continue;
      }
      // New format — extract PID and suffix token
      const pid = +m[1];
      const suffixMatch = f.match(/^cron-\d+-(.+)\.json$/);
      const fileToken = suffixMatch?.[1];
      // Check /proc/{pid}/stat — if we can read it, verify start time matches
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
        const startTime = parseProcStartTime(stat);
        if (startTime && fileToken && startTime === fileToken) {
          // Same PID, same start time — process is alive, skip
          continue;
        }
        if (startTime && fileToken && startTime !== fileToken) {
          // PID reused — different process, safe to delete
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
          continue;
        }
      } catch {
        // /proc/{pid} not readable — either dead process or different PID namespace
        // Only delete if we can confirm PID is dead in our namespace
        try { process.kill(pid, 0); } catch {
          // PID dead in our namespace — safe to delete
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
        // If kill(pid, 0) succeeds but /proc is unreadable — skip (can't verify)
      }
    }
  } catch (e: any) { console.debug("[cron] cleanup orphaned cron files failed:", e?.message || e); }
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatSchedule(task: CronTask): string {
  return formatCronSchedule(task);
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

// ── Extracted registration functions ─────────────────────────────────

function registerCronTool(pi: ExtensionAPI, state: CronInternals): void {
  pi.registerTool({
    name: "cron_manage",
    description: "Manage scheduled cron tasks. Use this tool when the user wants to schedule, list, or remove recurring tasks.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("list-all"), Type.Literal("remove")], {
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
        // Block scheduling in one-shot modes
        if (state.lastCtx?.mode === "print" || state.lastCtx?.mode === "json") {
          return { content: [{ type: "text", text: "Error: cron scheduling is not available in one-shot modes (print/json)" }] };
        }
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
          id: state.nextId++,
          description: (params.description as string) || (params.task as string).slice(0, 60),
          task: params.task as string,
          intervalMs,
          atHour,
          atMinute,
          createdAt: Date.now(),
        };

        state.tasks.set(task.id, task);
        state.startTask(task);
        saveCrons([...state.tasks.values()]);

        state.updateCronStatus();
        return {
          content: [{
            type: "text",
            text: `Cron #${task.id} created: ${formatSchedule(task)} → ${task.description}`,
          }],
        };
      }

      if (action === "list") {
        if (state.tasks.size === 0) {
          return { content: [{ type: "text", text: "No scheduled tasks." }] };
        }
        const lines = [...state.tasks.values()].map(t => {
          const last = t.lastRun ? new Date(t.lastRun).toLocaleTimeString() : "never";
          return `#${t.id} | ${formatSchedule(t)} | ${t.description} | last run: ${last}`;
        });
        return {
          content: [{ type: "text", text: `Scheduled tasks:\n\n${lines.join("\n")}` }],
        };
      }

      if (action === "list-all") {
        const sections: string[] = [];
        if (!CRON_FILE) {
          return { content: [{ type: "text", text: "No scheduled tasks in any session." }] };
        }
        try {
          const dir = path.dirname(CRON_FILE);
          for (const f of fs.readdirSync(dir)) {
            const m = f.match(CRON_FILE_RE);
            if (!m) continue;
            const pid = +m[1];
            const isMe = f === path.basename(CRON_FILE);
            let alive = isMe;
            if (!isMe) { try { process.kill(pid, 0); alive = true; } catch {} }
            if (!alive) continue;
            const cronTasks: CronTask[] = isMe
              ? [...state.tasks.values()]
              : (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")); } catch { return []; } })();
            if (cronTasks.length === 0) continue;
            const label = isMe ? `PID ${pid} (this session)` : `PID ${pid}`;
            const lines = cronTasks.map(t => {
              const last = t.lastRun ? new Date(t.lastRun).toLocaleTimeString() : "never";
              return `  #${t.id} | ${formatSchedule(t)} | ${t.description} | last run: ${last}`;
            });
            sections.push(`**${label}:**\n${lines.join("\n")}`);
          }
        } catch (e: any) { console.debug("[cron] list-all scan failed:", e?.message || e); }
        if (sections.length === 0) {
          return { content: [{ type: "text", text: "No scheduled tasks in any session." }] };
        }
        return {
          content: [{ type: "text", text: `All sessions:\n\n${sections.join("\n\n")}` }],
        };
      }

      if (action === "remove") {
        const id = params.id as number;
        if (!id || !state.tasks.has(id)) {
          return { content: [{ type: "text", text: `Task #${id || "?"} not found.` }] };
        }
        const task = state.tasks.get(id)!;
        state.stopTask(id);
        state.tasks.delete(id);
        saveCrons([...state.tasks.values()]);
        state.updateCronStatus();
        return {
          content: [{ type: "text", text: `Cron #${id} removed: ${task.description}` }],
        };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
    },
  });
}

function listLocalCronViews(state: CronInternals) {
  const file = CRON_FILE || "";
  return [...state.tasks.values()].map((t) =>
    toCronStatusTaskView(t, {
      overlayId: String(t.id),
      isLocal: true,
      cronFile: file,
    }),
  );
}

function listAllCronViews(state: CronInternals) {
  const views: ReturnType<typeof toCronStatusTaskView>[] = [];
  if (!CRON_FILE) return views;
  try {
    const dir = path.dirname(CRON_FILE);
    const myBase = path.basename(CRON_FILE);
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(CRON_FILE_RE);
      if (!m) continue;
      const pid = +m[1];
      const isMe = f === myBase;
      let alive = isMe;
      if (!isMe) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          /* dead */
        }
      }
      if (!alive) continue;
      const filePath = path.join(dir, f);
      const cronTasks: CronTask[] = isMe
        ? [...state.tasks.values()]
        : (() => {
            try {
              const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
              if (!Array.isArray(parsed)) return [];
              return parsed;
            } catch {
              return [];
            }
          })();
      if (cronTasks.length === 0) continue;
      const label = isMe ? `PID ${pid} (this session)` : `PID ${pid}`;
      for (const t of cronTasks) {
        views.push(
          toCronStatusTaskView(t, {
            overlayId: `${f}:${t.id}`,
            sessionLabel: label,
            isLocal: isMe,
            cronFile: filePath,
          }),
        );
      }
    }
  } catch (e: any) {
    console.debug("[cron] list-all scan failed:", e?.message || e);
  }
  return views;
}

function removeCronByOverlayId(state: CronInternals, overlayId: string): boolean {
  const fromAll = listAllCronViews(state).find((v) => v.id === overlayId);
  const fromLocal = listLocalCronViews(state).find((v) => v.id === overlayId);
  const view = fromAll || fromLocal;
  if (!view) return false;

  if (view.isLocal || (view.cronFile && view.cronFile === CRON_FILE)) {
    if (!state.tasks.has(view.taskId)) return false;
    state.stopTask(view.taskId);
    state.tasks.delete(view.taskId);
    saveCrons([...state.tasks.values()]);
    state.updateCronStatus();
    return true;
  }

  // Other session — edit their JSON; their watcher (if running new code) resyncs timers.
  if (!view.cronFile) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(view.cronFile, "utf-8"));
    if (!Array.isArray(raw)) return false;
    const next = raw.filter((t: CronTask) => t.id !== view.taskId);
    if (next.length === raw.length) return false;
    fs.writeFileSync(view.cronFile, JSON.stringify(next), { mode: 0o600 });
    return true;
  } catch (e: any) {
    console.debug("[cron] remote remove failed:", e?.message || e);
    return false;
  }
}

function registerCronCommand(pi: ExtensionAPI, state: CronInternals): void {
  pi.registerCommand("cron", {
    description: "Schedule recurring tasks — /cron list|list-all|remove <id>|<natural language>",
    handler: async (args, ctx) => {
      state.lastCtx = ctx;
      state.lastCwd = ctx.cwd;
      const text = (args || "").trim();
      const parts = text.split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      // Direct handlers — no AI needed
      if (sub === "list" && parts.length === 1) {
        if (!ctx.hasUI) return;
        await openCronStatusOverlay(ctx, {
          listTasks: () => listLocalCronViews(state),
          removeTask: (id) => removeCronByOverlayId(state, id),
        });
        return;
      }

      if (sub === "list-all") {
        if (!ctx.hasUI) return;
        await openCronStatusOverlay(ctx, {
          title: "Cron tasks (all sessions)",
          emptyMessage: "No crons in any session.",
          borderTitle: (tasks) => {
            const sessions = new Set(
              tasks.map((t) => t.sessionLabel || "?").filter(Boolean),
            );
            return `all sessions · ${tasks.length} tasks · ${sessions.size} session${sessions.size === 1 ? "" : "s"}`;
          },
          listTasks: () => listAllCronViews(state),
          removeTask: (id) => removeCronByOverlayId(state, id),
        });
        return;
      }

      if ((sub === "remove" || sub === "rm" || sub === "delete" || sub === "kill") && parts.length > 1) {
        const ids = parts.slice(1).map(p => parseInt(p, 10)).filter(n => !isNaN(n));
        if (ids.length === 0) {
          if (ctx.hasUI) ctx.ui.notify("No valid task IDs. Use /cron list", "warning");
          return;
        }
        const removed: string[] = [];
        const notFound: string[] = [];
        for (const id of ids) {
          if (state.tasks.has(id)) {
            const task = state.tasks.get(id)!;
            state.stopTask(id);
            state.tasks.delete(id);
            removed.push(`#${id} (${task.description})`);
          } else {
            notFound.push(`#${id}`);
          }
        }
        saveCrons([...state.tasks.values()]);
        state.updateCronStatus();
        const lines: string[] = [];
        if (removed.length) lines.push(`Removed: ${removed.join(", ")}`);
        if (notFound.length) lines.push(`Not found: ${notFound.join(", ")}`);
        if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), removed.length ? "info" : "warning");
        return;
      }

      if (!text) {
        if (ctx.hasUI) ctx.ui.notify("Usage:\n/cron <natural language task>\n/cron list\n/cron list-all\n/cron remove <id>", "info");
        return;
      }

      // Only "add" goes through the AI for natural language parsing
      pi.sendUserMessage(
        `The user wants to schedule a cron task. Parse their request and use the cron_manage tool with action "add".\n\nUser request: "${text}"\n\nInterpret the schedule and task from the natural language. For interval-based schedules, convert to seconds. For time-based schedules, extract hour and minute.`,
        { deliverAs: "followUp" },
      );
    },
  });
}

// ── Registration ─────────────────────────────────────────────────────

export function registerCron(
  pi: ExtensionAPI,
  spawnAsyncAgent: (
    agentName: string,
    task: string,
    cwd: string,
    agents: any[],
    options?: {
      fireAndForget?: boolean;
      name?: string;
      parentModelId?: string;
      parentProvider?: string;
    },
  ) => { id: string; error?: string },
): { getCronTasks: () => CronTask[] } {
  if (process.env.PI_SUBAGENT_CHILD === "1") return { getCronTasks: () => [] };

  const tasks = new Map<number, CronTask>();
  const timers = new Map<number, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();

  const state: CronInternals = {
    tasks,
    nextId: 1,
    lastCwd: "",
    lastCtx: null,
    startTask,
    stopTask,
    updateCronStatus,
  };

  function updateCronStatus() {
    const count = tasks.size;
    saveCrons([...tasks.values()]);
    if (state.lastCtx?.hasUI) {
      if (count > 0) {
        state.lastCtx.ui.setStatus("3-crons", state.lastCtx.ui.theme.fg("muted", `⏰ ${count} cron${count > 1 ? "s" : ""}`));
      } else {
        state.lastCtx.ui.setStatus("3-crons", state.lastCtx.ui.theme.fg("muted", `⏰ 0 crons`));
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
      const cwd = state.lastCwd || process.cwd();
      const parentProvider = state.lastCtx?.model?.provider as string | undefined;
      const dispatch = decideAsyncLlmDispatch({
        parentProvider,
        cwd,
        mustAsync: true,
      });
      if (dispatch.action === "skip") {
        console.debug(`[cron] ${dispatch.note} (task #${task.id})`);
        try {
          state.lastCtx?.ui?.notify?.(
            `Cron #${task.id} skipped: set async_llm_provider/async_llm_model for acpx`,
            "warning",
          );
        } catch { /* stale UI */ }
        return;
      }
      const { agents } = discoverAgents(cwd, "user");
      const sidecarOpts =
        dispatch.action === "sidecar-async"
          ? {
              parentProvider: dispatch.sidecar.provider,
              parentModelId: dispatch.sidecar.model,
            }
          : {};
      spawnAsyncAgent("worker", cmd, cwd, agents, {
        name: `Cron: ${task.description.slice(0, 40)}`,
        ...sidecarOpts,
      });
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

  /** Resync in-memory tasks from CRON_FILE (external list-all remove / peer edit). */
  function syncTasksFromDisk(): void {
    if (!CRON_FILE) return;
    const onDisk = loadCrons();
    const diskIds = new Set(onDisk.map((t) => t.id));

    for (const id of [...tasks.keys()]) {
      if (!diskIds.has(id)) {
        stopTask(id);
        tasks.delete(id);
      }
    }

    for (const task of onDisk) {
      // Validate before starting — same rules as add path
      if (!task.task || typeof task.task !== "string" || !task.task.trim()) continue;
      if (task.intervalMs !== undefined && task.intervalMs < 10000) continue;

      const existing = tasks.get(task.id);
      if (!existing) {
        if (task.id >= state.nextId) state.nextId = task.id + 1;
        tasks.set(task.id, task);
        startTask(task);
        continue;
      }
      // Refresh mutable fields from disk without restarting timer unless schedule changed
      const scheduleChanged =
        existing.intervalMs !== task.intervalMs ||
        existing.atHour !== task.atHour ||
        existing.atMinute !== task.atMinute;
      Object.assign(existing, task);
      if (scheduleChanged) startTask(existing);
    }
    updateCronStatus();
  }

  let cronFileWatcher: fs.FSWatcher | null = null;

  // Restore persisted crons on session start
  pi.on("session_start", (_event, ctx) => {
    state.lastCwd = ctx.cwd;
    state.lastCtx = ctx;
    CRON_FILE = path.join(getProjectTmpDir(ctx.cwd), `cron-${SESSION_SUFFIX}.json`);
    cleanupOrphanedCronFiles();
    // Skip cron scheduling in one-shot modes
    if (ctx.mode === "print" || ctx.mode === "json") return;

    // Restore from persistence (after /reload or /new)
    const restored = loadCrons();
    for (const task of restored) {
      if (!tasks.has(task.id)) {
        if (task.id >= state.nextId) state.nextId = task.id + 1;
        tasks.set(task.id, task);
      }
    }
    // Restart all timers with fresh context
    for (const task of tasks.values()) {
      startTask(task);
    }
    updateCronStatus();

    // Ensure file exists so we can watch peer list-all removes
    if (!fs.existsSync(CRON_FILE)) saveCrons([...tasks.values()]);

    // Watch own file so /cron list-all remove from another session stops our timers
    try {
      cronFileWatcher?.close();
    } catch { /* ignore */ }
    cronFileWatcher = null;
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      cronFileWatcher = fs.watch(CRON_FILE, () => {
        if (Date.now() < CRON_IGNORE_WATCH_UNTIL) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (Date.now() < CRON_IGNORE_WATCH_UNTIL) return;
          try {
            syncTasksFromDisk();
          } catch (e: any) {
            console.debug("[cron] sync from disk failed:", e?.message || e);
          }
        }, 150);
      });
      cronFileWatcher.unref?.();
    } catch (e: any) {
      console.debug("[cron] watch setup failed:", e?.message || e);
    }
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
    try {
      cronFileWatcher?.close();
    } catch { /* ignore */ }
    cronFileWatcher = null;
    for (const id of timers.keys()) {
      stopTask(id);
    }
    saveCrons([...tasks.values()]);
  });

  // Register cron_manage tool — the AI calls this with structured params
  registerCronTool(pi, state);

  // /cron command
  registerCronCommand(pi, state);

  return {
    getCronTasks: () => [...tasks.values()],
  };
}
