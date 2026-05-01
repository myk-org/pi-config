/**
 * /status command — unified session status snapshot.
 * Direct handler (no AI roundtrip).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AsyncJob } from "./async-agents.js";
import type { CronTask } from "./cron.js";
import { getCurrentBranch, runGit } from "./git-helpers.js";

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function formatSchedule(t: CronTask): string {
  if (t.intervalMs) {
    const totalSec = Math.floor(t.intervalMs / 1000);
    if (totalSec < 60) return `every ${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m < 60) return s > 0 ? `every ${m}m${s}s` : `every ${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm > 0 ? `every ${h}h${rm}m` : `every ${h}h`;
  }
  if (t.atHour != null && t.atMinute != null) {
    return `at ${String(t.atHour).padStart(2, "0")}:${String(t.atMinute).padStart(2, "0")}`;
  }
  return "unknown";
}

export function registerStatus(
  pi: ExtensionAPI,
  inContainer: boolean,
  getAsyncJobs: () => AsyncJob[],
  getCronTasks: () => CronTask[],
): void {
  pi.registerCommand("status", {
    description: "Show unified session status — async agents, crons, git, context",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const lines: string[] = [];

      // ── Async agents ───────────────────────────────────────────────
      const jobs = getAsyncJobs();
      if (jobs.length > 0) {
        lines.push(`⏳ Async agents: ${jobs.length} running`);
        for (const j of jobs) {
          const dur = formatDuration(Date.now() - j.startedAt);
          const task = j.task.length > 50 ? j.task.slice(0, 50) + "..." : j.task;
          lines.push(`   • ${j.name || j.agent} — ${dur} — ${task}`);
        }
      } else {
        lines.push("⏳ Async agents: none");
      }

      // ── Cron tasks ─────────────────────────────────────────────────
      const crons = getCronTasks();
      if (crons.length > 0) {
        lines.push(`⏰ Cron tasks: ${crons.length} active`);
        for (const t of crons) {
          const last = t.lastRun ? new Date(t.lastRun).toLocaleTimeString() : "never";
          lines.push(`   • #${t.id} ${formatSchedule(t)} — ${t.description} (last: ${last})`);
        }
      } else {
        lines.push("⏰ Cron tasks: none");
      }

      // ── Git ────────────────────────────────────────────────────────
      try {
        const branch = getCurrentBranch(ctx.cwd);
        if (branch) {
          const status = runGit(["status", "--porcelain"], ctx.cwd);
          const dirtyLines = status.code === 0 ? status.stdout?.trim() : "";
          const dirtyCount = dirtyLines ? dirtyLines.split("\n").length : 0;
          const repoName = ctx.cwd.split("/").pop() || ctx.cwd;
          const stateIcon = dirtyCount > 0 ? "●" : "✓";
          const stateText = dirtyCount > 0 ? `${dirtyCount} changed file${dirtyCount > 1 ? "s" : ""}` : "clean";
          lines.push(`🔀 Git: ${branch} ${stateIcon} ${stateText} (${repoName})`);
        }
      } catch {}

      // ── Container ──────────────────────────────────────────────────
      if (inContainer) {
        lines.push("📦 Running in container");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
