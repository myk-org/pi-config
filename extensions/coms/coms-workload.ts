/**
 * Peer workload — what a peer is actually doing, counted and rendered (#1083).
 *
 * Pure: no filesystem, no sockets, no clock of its own. The ONLY inputs are the peer's own
 * in-memory state (its async agents, its task store, its cron map) — a peer reports itself, and
 * nothing here infers another process's state from files. `null` means "not reported": a peer
 * that reports no workload renders `unknown`, never `0` (same rule as `cost_usd`).
 */
import { formatCronSchedule, formatNextRunLabel, toCronStatusTaskView } from "../orchestrator/cron-status-format.js";
import { formatDuration } from "../orchestrator/async-agents.js";
import { formatTaskRowLine } from "../pitasks/tasks-view.js";
import type { WorkloadAgent, WorkloadCron } from "../shared/workload-bridge.js";

export interface PeerWorkloadCounts {
  agents: number;
  tasks: number;
  crons: number;
}

export interface WorkloadTask {
  id: string;
  status: string;
  subject: string;
}

export interface PeerWorkloadDetail {
  agents: WorkloadAgent[];
  tasks: WorkloadTask[];
  crons: WorkloadCron[];
}

/** Active only: a `complete`/`failed` agent is history, a queued one is still this peer's work. */
export function isActiveAgent(agent: Pick<WorkloadAgent, "status">): boolean {
  return agent.status !== "complete" && agent.status !== "failed";
}

/** Active only: anything not completed is still open. */
export function isActiveTask(task: Pick<WorkloadTask, "status">): boolean {
  return task.status !== "completed";
}

/** Active only: a scheduled cron this replica actually owns (a non-leader replica runs nothing). */
export function isActiveCron(cron: Pick<WorkloadCron, "leader">): boolean {
  return cron.leader !== false;
}

/** Filter each list to its active entries and count them. */
export function collectWorkload(
  agents: WorkloadAgent[],
  tasks: WorkloadTask[],
  crons: WorkloadCron[],
): { counts: PeerWorkloadCounts; detail: PeerWorkloadDetail } {
  const activeAgents = agents.filter(isActiveAgent);
  const activeTasks = tasks.filter(isActiveTask);
  const activeCrons = crons.filter(isActiveCron);
  return {
    counts: { agents: activeAgents.length, tasks: activeTasks.length, crons: activeCrons.length },
    detail: { agents: activeAgents, tasks: activeTasks, crons: activeCrons },
  };
}

/** `⏳2 ✓5 ⏰1` for non-zero counts, nothing when the peer reports none, `unknown` when it
 *  reports no workload at all — absence is never rendered as zero. */
export function renderWorkloadPart(
  counts: PeerWorkloadCounts | null | undefined,
  theme?: { fg: (color: any, text: string) => string },
): string {
  const paint = (color: string, text: string): string => (theme ? theme.fg(color, text) : text);
  if (!counts) return " " + paint("dim", "unknown");
  const parts: string[] = [];
  if (counts.agents > 0) parts.push(paint("accent", `⏳${counts.agents}`));
  if (counts.tasks > 0) parts.push(paint("success", `✓${counts.tasks}`));
  if (counts.crons > 0) parts.push(paint("warning", `⏰${counts.crons}`));
  if (parts.length === 0) return "";
  return " " + parts.join(" ");
}

export function formatWorkloadSuffix(counts: PeerWorkloadCounts | null | undefined): string {
  return renderWorkloadPart(counts);
}

/** The peer never answered (or was never asked): one honest line beats three invented ones. */
export const WORKLOAD_UNKNOWN_LINE = "workload  unknown (no reply within 2s)";

/** The drilldown body: three sections with the existing formatters, omitted when empty. */
export function workloadSectionLines(detail: PeerWorkloadDetail | null, now = Date.now()): string[] {
  if (!detail) return [WORKLOAD_UNKNOWN_LINE];
  const lines: string[] = [];
  if (detail.agents.length > 0) {
    lines.push(`agents (${detail.agents.length})`);
    for (const agent of detail.agents) {
      const label = agent.name || agent.agent || agent.id;
      const elapsed = typeof agent.startedAt === "number" ? formatDuration(Math.max(0, now - agent.startedAt)) : "?";
      lines.push(`  ${label}  ${agent.status}  ${elapsed}  ${oneLine(agent.task)}`);
    }
  }
  if (detail.tasks.length > 0) {
    lines.push(`tasks (${detail.tasks.length})`);
    for (const task of detail.tasks) lines.push(`  ${formatTaskRowLine(task)}`);
  }
  if (detail.crons.length > 0) {
    lines.push(`crons (${detail.crons.length})`);
    for (const cron of detail.crons) lines.push(`  ${cronRow(cron, now)}`);
  }
  if (lines.length === 0) lines.push("workload  none active");
  return lines;
}

function cronRow(cron: WorkloadCron, now: number): string {
  const view = toCronStatusTaskView(cron, { overlayId: cron.id });
  return `${cron.id}  ${formatCronSchedule(view)}  ${formatNextRunLabel(view, now)}  ${oneLine(cron.description || cron.task)}`;
}

function oneLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
