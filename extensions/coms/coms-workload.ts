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
import { sanitizePeerText } from "./peer-text.js";
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
  /** Owner and description ride along for the drilldown's detail pane; absent on older peers. */
  owner?: string;
  description?: string;
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
  /** Optional: an older peer does not send them, and the detail pane says `—` rather than guessing. */
  owner?: string;
  description?: string;
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

/** Field caps: a peer can send a field of any length, the pane cannot show it. */
const ID_MAX = 40;
const NAME_MAX = 40;
const STATE_MAX = 40;
const ELAPSED_MAX = 16;
const PURPOSE_MAX = 120;
const SUBJECT_MAX = 120;
const SCHEDULE_MAX = 40;
const NEXT_MAX = 24;
const DESCRIPTION_MAX = 120;

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

/**
 * Only OPEN blockers hold a task: a completed (or vanished) blocker must not mark the row
 * `⛔ blocked`. `statusById` is the peer's own task statuses, so a deleted blocker is absent.
 */
export function openBlockers(
  blockedBy: readonly string[] | undefined,
  statusById: ReadonlyMap<string, string>,
): string[] {
  return (blockedBy ?? [])
    .map(String)
    .filter((id) => {
      const status = statusById.get(id);
      return status !== undefined && status !== "completed";
    });
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
      id: sanitizePeerText(agent.id, ID_MAX),
      name: sanitizePeerText(agent.name || agent.agent || "", NAME_MAX),
      state: sanitizePeerText(agent.status, STATE_MAX),
      elapsed: typeof agent.startedAt === "number" ? formatDuration(Math.max(0, now - agent.startedAt)) : "?",
      purpose: sanitizePeerText(agent.task, PURPOSE_MAX),
    })),
    tasks: active.tasks.map((task) => ({
      id: sanitizePeerText(task.id, ID_MAX),
      status: sanitizePeerText(task.status, STATE_MAX),
      subject: sanitizePeerText(task.subject, SUBJECT_MAX),
      blockedBy: (task.blockedBy ?? []).map((id) => sanitizePeerText(id, ID_MAX)),
      ...(task.owner !== undefined ? { owner: sanitizePeerText(task.owner, NAME_MAX) } : {}),
      ...(task.description !== undefined ? { description: sanitizePeerText(task.description, PURPOSE_MAX) } : {}),
    })),
    crons: active.crons.map((cron) => {
      const view = toCronStatusTaskView(cron, { overlayId: cron.id });
      return {
        id: sanitizePeerText(cron.id, ID_MAX),
        schedule: sanitizePeerText(formatCronSchedule(view), SCHEDULE_MAX),
        next: sanitizePeerText(formatNextRunLabel(view, now), NEXT_MAX),
        description: sanitizePeerText(cron.description || cron.task, DESCRIPTION_MAX),
      };
    }),
  };
  log.debug("workload_described", { agents: detail.agents.length, tasks: detail.tasks.length, crons: detail.crons.length });
  return detail;
}

/** `⏳2 ◻5 ⏰1` for non-zero counts, nothing when the peer reports none, `unknown` when it
 *  reports no workload at all — absence is never rendered as zero.
 *
 *  The task glyph is `◻` (open), the same one `formatTaskRowLine` uses for a pending row: this
 *  count is OPEN tasks, never a completed tally, so `✓` must not appear in the suffix at all. */
export function renderWorkloadPart(
  counts: PeerWorkloadCounts | null | undefined,
  theme?: { fg: (color: any, text: string) => string },
): string {
  const paint = (color: string, text: string): string => (theme ? theme.fg(color, text) : text);
  if (!counts) return " " + paint("dim", "unknown");
  const parts: string[] = [];
  if (counts.agents > 0) parts.push(paint("accent", `⏳${counts.agents}`));
  if (counts.tasks > 0) parts.push(paint("success", `◻${counts.tasks}`));
  if (counts.crons > 0) parts.push(paint("warning", `⏰${counts.crons}`));
  if (parts.length === 0) return "";
  return " " + parts.join(" ");
}

export function formatWorkloadSuffix(counts: PeerWorkloadCounts | null | undefined): string {
  return renderWorkloadPart(counts);
}

/** Why a drilldown has no payload. An ANSWERED peer with no active work is not one of these. */
export type DescribeFailure = "not-reported" | "timeout" | "unreachable" | "malformed" | "oversize" | "peer-error";

export const WORKLOAD_UNKNOWN_LINE = "workload  unknown (no reply within 2s)";
export const WORKLOAD_NONE_LINE = "workload  none active";

/**
 * One honest line per failure — never three invented ones. An older peer that has no workload
 * support at all is `not reported`, which is not the same claim as "did not answer".
 */
export function workloadUnknownLine(reason: DescribeFailure, code?: string): string {
  switch (reason) {
    case "not-reported":
      return "workload  unknown (not reported)";
    case "malformed":
      return "workload  unknown (malformed reply)";
    case "oversize":
      return "workload  unknown (reply too large)";
    case "peer-error":
      // A local code, capped and sanitized: never the peer's own error text.
      return `workload  unknown (error: ${sanitizePeerText(code, 40) || "peer-error"})`;
    default:
      return WORKLOAD_UNKNOWN_LINE;
  }
}

/** Rows trimmed by the 50-entry cap, per section. Truncation must never look like the whole list. */
export interface WorkloadTruncation {
  agents?: number;
  tasks?: number;
  crons?: number;
}

/** The drilldown body: three sections with the existing formatters, omitted when empty.
 *  Every peer-supplied field is sanitized here — a reply can carry ANSI a pane must not obey. */
export function workloadSectionLines(
  detail: PeerWorkloadDetail,
  truncated: WorkloadTruncation = {},
): string[] {
  const lines: string[] = [];
  if (detail.agents.length > 0) {
    lines.push(`agents (${detail.agents.length})`);
    for (const agent of detail.agents) {
      // An agent without a purpose keeps its identity columns, without trailing blanks.
      lines.push(
        `  ${agentLabel(agent)}  ${sanitizePeerText(agent.state, STATE_MAX)}  ${sanitizePeerText(agent.elapsed, ELAPSED_MAX)}  ${sanitizePeerText(agent.purpose, PURPOSE_MAX)}`.trimEnd(),
      );
    }
    pushTruncated(lines, truncated.agents);
  }
  if (detail.tasks.length > 0) {
    lines.push(`tasks (${detail.tasks.length})`);
    for (const task of detail.tasks) {
      lines.push(
        `  ${formatTaskRowLine({
          id: sanitizePeerText(task.id, ID_MAX),
          status: sanitizePeerText(task.status, STATE_MAX),
          subject: sanitizePeerText(task.subject, SUBJECT_MAX),
          blockedBy: (task.blockedBy ?? []).map((id) => sanitizePeerText(id, ID_MAX)),
        })}`,
      );
    }
    pushTruncated(lines, truncated.tasks);
  }
  if (detail.crons.length > 0) {
    lines.push(`crons (${detail.crons.length})`);
    for (const cron of detail.crons) {
      lines.push(
        `  ${sanitizePeerText(cron.id, ID_MAX)}  ${sanitizePeerText(cron.schedule, SCHEDULE_MAX)}  ${sanitizePeerText(cron.next, NEXT_MAX)}  ${sanitizePeerText(cron.description, DESCRIPTION_MAX)}`.trimEnd(),
      );
    }
    pushTruncated(lines, truncated.crons);
  }
  if (lines.length === 0) lines.push(WORKLOAD_NONE_LINE);
  return lines;
}

function pushTruncated(lines: string[], more: number | undefined): void {
  if (typeof more === "number" && more > 0) lines.push(`  … ${more} more`);
}

/** Identity first: `name (id)` when the peer reported both, the id alone otherwise. */
function agentLabel(agent: DescribeAgent): string {
  const id = sanitizePeerText(agent.id, ID_MAX);
  const name = sanitizePeerText(agent.name, NAME_MAX);
  return name ? `${name} (${id})` : id;
}
