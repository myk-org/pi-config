/**
 * Peer workload — what a peer is actually doing, counted and rendered (#1083).
 *
 * Pure: no filesystem, no sockets, no clock of its own. The ONLY inputs are the peer's own
 * in-memory state (its async agents, its task store, its cron map) — a peer reports itself, and
 * nothing here infers another process's state from files.
 *
 * The drilldown payload is PROJECTED here before it leaves the peer: agents ship
 * `id/name/state/elapsed/purpose`, tasks `id/status/subject/blockedBy`, crons
 * `id/schedule/next/description`. Job output, worker dirs and other internals never cross the
 * socket. `null` counts mean "not reported": a peer that reports no workload renders `unknown`,
 * never `0`.
 */
import { formatCronSchedule, formatNextRunLabel, toCronStatusTaskView } from "../orchestrator/cron-status-format.js";
import { formatDuration } from "../orchestrator/async-agents.js";
import { formatTaskRowLine } from "../pitasks/tasks-view.js";
import { createLogger } from "../shared/logger.js";
import type { WorkloadAgent, WorkloadCron } from "../shared/workload-bridge.js";

const log = createLogger("coms-workload");

export interface PeerWorkloadCounts {
  agents: number;
  tasks: number;
  crons: number;
}

/** One open task, as the peer's own store holds it. */
export interface WorkloadTask {
  id: string;
  status: string;
  subject: string;
  blockedBy?: string[];
}

/** Raw active entries on the answering peer. */
export interface ActiveWorkload {
  agents: WorkloadAgent[];
  tasks: WorkloadTask[];
  crons: WorkloadCron[];
}

/** ━━ The wire payload ━━ Projected by the answering peer, rendered by the requester. */

export interface DescribeAgent {
  id: string;
  /** Friendly agent name; empty when the job has none. Rendered as `name (id)`. */
  name: string;
  state: string;
  /** Pre-formatted duration, measured by the answering peer. */
  elapsed: string;
  purpose: string;
}

export interface DescribeTask {
  id: string;
  status: string;
  subject: string;
  blockedBy: string[];
}

export interface DescribeCron {
  id: string;
  schedule: string;
  /** Pre-formatted next-run label, measured by the answering peer. */
  next: string;
  description: string;
}

export interface PeerWorkloadDetail {
  agents: DescribeAgent[];
  tasks: DescribeTask[];
  crons: DescribeCron[];
}

/** Active only: a `complete`/`failed` agent is history, and a queued one is waiting, not running. */
export function isActiveAgent(agent: Pick<WorkloadAgent, "status">): boolean {
  return agent.status === "running";
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
): { counts: PeerWorkloadCounts; active: ActiveWorkload } {
  const active: ActiveWorkload = {
    agents: agents.filter(isActiveAgent),
    tasks: tasks.filter(isActiveTask),
    crons: crons.filter(isActiveCron),
  };
  const counts: PeerWorkloadCounts = {
    agents: active.agents.length,
    tasks: active.tasks.length,
    crons: active.crons.length,
  };
  log.debug("workload_collected", counts);
  return { counts, active };
}

/** Project active entries into the drilldown payload — no output, no paths, no internals. */
export function toDescribeDetail(active: ActiveWorkload, now = Date.now()): PeerWorkloadDetail {
  const detail: PeerWorkloadDetail = {
    agents: active.agents.map((agent) => ({
      id: agent.id,
      name: agent.name || agent.agent || "",
      state: agent.status,
      elapsed: typeof agent.startedAt === "number" ? formatDuration(Math.max(0, now - agent.startedAt)) : "?",
      purpose: oneLine(agent.task),
    })),
    tasks: active.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      subject: oneLine(task.subject),
      blockedBy: (task.blockedBy ?? []).map(String),
    })),
    crons: active.crons.map((cron) => {
      const view = toCronStatusTaskView(cron, { overlayId: cron.id });
      return {
        id: cron.id,
        schedule: formatCronSchedule(view),
        next: formatNextRunLabel(view, now),
        description: oneLine(cron.description || cron.task),
      };
    }),
  };
  log.debug("workload_described", { agents: detail.agents.length, tasks: detail.tasks.length, crons: detail.crons.length });
  return detail;
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

/** Why a drilldown has no payload. An ANSWERED peer with no active work is not one of these. */
export type DescribeFailure = "timeout" | "oversize" | "malformed" | "no-sources";

export const WORKLOAD_UNKNOWN_LINE = "workload  unknown (no reply within 2s)";
export const WORKLOAD_NONE_LINE = "workload  none active";

/** One honest line per failure — never three invented ones. */
export function workloadUnknownLine(reason: DescribeFailure): string {
  switch (reason) {
    case "malformed":
      return "workload  unknown (malformed reply)";
    case "oversize":
      return "workload  unknown (reply too large)";
    case "no-sources":
      return "workload  unknown (peer cannot report its own workload)";
    default:
      return WORKLOAD_UNKNOWN_LINE;
  }
}

/** The drilldown body: three sections with the existing formatters, omitted when empty. */
export function workloadSectionLines(detail: PeerWorkloadDetail): string[] {
  const lines: string[] = [];
  if (detail.agents.length > 0) {
    lines.push(`agents (${detail.agents.length})`);
    for (const agent of detail.agents) {
      // An agent without a purpose keeps its identity columns, without trailing blanks.
      lines.push(`  ${agentLabel(agent)}  ${agent.state}  ${agent.elapsed}  ${agent.purpose}`.trimEnd());
    }
  }
  if (detail.tasks.length > 0) {
    lines.push(`tasks (${detail.tasks.length})`);
    for (const task of detail.tasks) lines.push(`  ${formatTaskRowLine(task)}`);
  }
  if (detail.crons.length > 0) {
    lines.push(`crons (${detail.crons.length})`);
    for (const cron of detail.crons) {
      lines.push(`  ${cron.id}  ${cron.schedule}  ${cron.next}  ${cron.description}`);
    }
  }
  if (lines.length === 0) lines.push(WORKLOAD_NONE_LINE);
  return lines;
}

/** Identity first: `name (id)` when the peer reported both, the id alone otherwise. */
function agentLabel(agent: DescribeAgent): string {
  return agent.name ? `${agent.name} (${agent.id})` : agent.id;
}

function oneLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
