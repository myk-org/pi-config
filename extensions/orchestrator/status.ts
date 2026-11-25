/**
 * /status command — unified session status snapshot.
 * Direct handler (no AI roundtrip).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatElapsedDuration, tryGetSystemPromptOptions } from "./utils.js";
import type { CronTask } from "./cron.js";
import { formatCronSchedule } from "./cron-status-format.js";
import { listWorktreesAsync, runGit } from "./git-helpers.js";
import { formatWorktreeStatusSummary } from "./worktree-helpers.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("status");

export interface StatusAsyncJob {
  id: string;
  agent: string;
  name?: string;
  task: string;
  status: string;
  startedAt: number;
}

export interface StatusSnapshotDeps {
  inContainer: boolean;
  getAsyncJobs: () => StatusAsyncJob[];
  getCronTasks: () => CronTask[];
}

/** Build the unified `/status` snapshot text shared by the slash command and `session_status` tool. */
export async function buildStatusSnapshot(
  ctx: any,
  deps: StatusSnapshotDeps,
): Promise<string> {
  const { inContainer, getAsyncJobs, getCronTasks } = deps;
  const cwd = ctx?.cwd || process.cwd();
  const lines: string[] = [];

  // ── Async agents ───────────────────────────────────────────────
  const jobs = getAsyncJobs();
  if (jobs.length > 0) {
    lines.push(`⏳ Async agents: ${jobs.length} running`);
    for (const j of jobs) {
      const dur = formatElapsedDuration(Date.now() - j.startedAt);
      const task = j.task.length > 50 ? j.task.slice(0, 50) + "..." : j.task;
      lines.push(`   • ${j.name || j.agent} — ${dur} — ${task}`);
    }
  } else {
    lines.push("⏳ Async agents: none");
  }

  // ── Cron tasks ─────────────────────────────────────────────────
  const crons = getCronTasks();
  if (crons.length > 0) {
    const pausedCount = crons.filter((t) => t.paused === true).length;
    const activeCount = crons.length - pausedCount;
    const summary =
      pausedCount === 0
        ? `${activeCount} active`
        : activeCount === 0
          ? `${pausedCount} paused`
          : `${activeCount} active, ${pausedCount} paused`;
    lines.push(`⏰ Cron tasks: ${summary}`);
    for (const t of crons) {
      const last = t.lastRun ? new Date(t.lastRun).toLocaleTimeString() : "never";
      const leader = t.scope !== "session" ? `, ${t.leader === false ? "non-leader" : "leader"}` : "";
      const paused = t.paused === true ? ", ⏸ paused" : "";
      lines.push(`   • ${t.scope === "project" ? "persist" : "session"}:${t.id} ${formatCronSchedule(t, { preciseIntervals: true, dailyPrefix: false })} — ${t.description} (last: ${last}${leader}${paused})`);
    }
  } else {
    lines.push("⏰ Cron tasks: none");
  }

  // ── Git ────────────────────────────────────────────────────────
  try {
    const headRef = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    let branch: string | null = null;
    let inRepo = false;
    if (headRef.code === 0) {
      inRepo = true;
      if (headRef.stdout && headRef.stdout !== "HEAD") {
        branch = headRef.stdout;
      }
    } else {
      const sym = runGit(["symbolic-ref", "HEAD"], cwd);
      if (sym.code === 0 && sym.stdout.startsWith("refs/heads/")) {
        inRepo = true;
        branch = sym.stdout.slice("refs/heads/".length);
      }
    }
    if (inRepo) {
      const status = runGit(["status", "--porcelain"], cwd);
      const dirtyLines = status.code === 0 ? status.stdout?.trim() : "";
      const dirtyCount = dirtyLines ? dirtyLines.split("\n").length : 0;
      const repoName = cwd.split("/").pop() || cwd;
      const stateIcon = dirtyCount > 0 ? "●" : "✓";
      const stateText = dirtyCount > 0 ? `${dirtyCount} changed file${dirtyCount > 1 ? "s" : ""}` : "clean";
      let branchLabel = branch;
      if (!branchLabel) {
        const head = runGit(["rev-parse", "--short", "HEAD"], cwd);
        branchLabel = head.code === 0 && head.stdout ? `(detached ${head.stdout.trim()})` : "(detached)";
      }
      lines.push(`🔀 Git: ${branchLabel} ${stateIcon} ${stateText} (${repoName})`);

      const worktrees = await listWorktreesAsync(cwd);
      const wtSummary = formatWorktreeStatusSummary(worktrees);
      if (wtSummary) lines.push(wtSummary);
    }
  } catch (e: any) { log.debug("status_git_failed", { code: e?.code }); }

  // ── Container ──────────────────────────────────────────────────
  if (inContainer) {
    lines.push("📦 Running in container");
  }

  // ── Context usage ──────────────────────────────────────────────
  try {
    const usage = ctx?.getContextUsage?.();
    if (usage && typeof usage.percent === "number" && Number.isFinite(usage.percent)) {
      lines.push(`🧠 Context: ${Math.round(usage.percent)}%`);
    }
  } catch (e: any) { log.debug("status_context_usage_failed", { error: e?.message || String(e) }); }

  // ── System prompt resources ────────────────────────────────────
  const opts = tryGetSystemPromptOptions(ctx);
  if (opts) {
    const contextFiles = opts.contextFiles?.length ?? 0;
    const skills = opts.skills?.length ?? 0;
    const tools = opts.selectedTools?.length ?? 0;
    const guidelines = opts.promptGuidelines?.length ?? 0;
    if (contextFiles + skills + tools + guidelines > 0) {
      lines.push(`📋 Loaded: ${contextFiles} context files, ${skills} skills, ${tools} tools, ${guidelines} guidelines`);
    }
  }

  log.debug("status_rendered", { jobs: jobs.length, crons: crons.length, lines: lines.length });
  return lines.join("\n");
}

export function registerStatus(
  pi: ExtensionAPI,
  inContainer: boolean,
  getAsyncJobs: () => StatusAsyncJob[],
  getCronTasks: () => CronTask[],
): void {
  const deps: StatusSnapshotDeps = { inContainer, getAsyncJobs, getCronTasks };

  pi.registerCommand("status", {
    description: "Show unified session status — async agents, crons, git, context",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const snapshot = await buildStatusSnapshot(ctx, deps);
      ctx.ui.notify(snapshot, "info");
    },
  });

  if (typeof pi.registerTool === "function") {
    pi.registerTool({
      name: "session_status",
      label: "Session Status",
      description:
        "Return the unified session status snapshot (async agents, cron tasks, git branch & dirty state, worktree summary, context usage, loaded resources) — equivalent to /status.",
      parameters: Type.Object({}),
      async execute(_callId, _params, _signal, _onUpdate, ctx) {
        log.debug("session_status_tool", { cwd: ctx?.cwd });
        const snapshot = await buildStatusSnapshot(ctx, deps);
        return {
          content: [{ type: "text" as const, text: snapshot }],
          details: undefined,
        };
      },
    });
  }
}
