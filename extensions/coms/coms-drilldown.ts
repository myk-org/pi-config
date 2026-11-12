/**
 * The peer drilldown's structure (#1084): sections as rows, their items, and the Esc chain.
 *
 * Pure — no TUI, no theme, no clock, no filesystem. Input is the `coms_describe` reply the pane
 * already fetched, so this module can only ever show what the peer reported: no local store, no
 * scan of another process. Rows are built with the same formatters the local overlays use
 * (`formatTaskRowLine`, the cron status labels), never a second definition of them.
 *
 * Every peer-supplied field is sanitized here, at the render boundary: the answering peer
 * sanitizes its own fields, but a reply is untrusted input and this pane must not obey ANSI.
 */
import { formatTaskRowLine } from "../pitasks/tasks-view.js";
import type { DescribeResult } from "./coms-describe.js";
import {
  WORKLOAD_NONE_LINE,
  workloadUnknownLine,
  type DescribeAgent,
  type DescribeCron,
  type DescribeTask,
  type WorkloadTruncation,
} from "./coms-workload.js";
import { sanitizePeerText } from "./peer-text.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("coms-drilldown");

const ID_MAX = 40;
const NAME_MAX = 40;
const STATE_MAX = 40;
const ELAPSED_MAX = 16;
const PURPOSE_MAX = 120;
const SUBJECT_MAX = 120;
const SCHEDULE_MAX = 40;
const NEXT_MAX = 24;
const DESCRIPTION_MAX = 120;

/** One row inside a section, already reduced to text: `row` is the list line, `detail` the
 *  (label, value) pairs the detail pane shows. Read-only: no action is attached to either. */
export interface DrilldownItem {
  id: string;
  row: string;
  detail: Array<[string, string]>;
}

/** One level-2 row. A `section` row opens its items; a status row (unknown / nothing active)
 *  carries one item that is the reason itself, so Enter always lands somewhere readable. */
export interface DrilldownRow {
  id: string;
  label: string;
  section?: "agents" | "tasks" | "crons";
  items: DrilldownItem[];
}

/** Esc from a section returns to that peer's sections; Esc from the sections returns to the
 *  peer list; the peer list is the top. Data, so the contract is testable without a TUI. */
export type DrilldownLevel =
  | { level: "peers" }
  | { level: "sections"; peer: string }
  | { level: "items"; peer: string; section: string };

export function backTarget(level: DrilldownLevel): DrilldownLevel | null {
  switch (level.level) {
    case "items":
      return { level: "sections", peer: level.peer };
    case "sections":
      return { level: "peers" };
    default:
      return null;
  }
}

function statusRow(label: string): DrilldownRow {
  return {
    id: "section:status",
    label,
    items: [{ id: "status", row: label, detail: [["workload", label]] }],
  };
}

function agentItem(agent: DescribeAgent): DrilldownItem {
  const id = sanitizePeerText(agent.id, ID_MAX);
  const name = sanitizePeerText(agent.name, NAME_MAX);
  const state = sanitizePeerText(agent.state, STATE_MAX);
  const elapsed = sanitizePeerText(agent.elapsed, ELAPSED_MAX);
  const purpose = sanitizePeerText(agent.purpose, PURPOSE_MAX);
  return {
    id: id || "?",
    // Same columns as the async-status row: identity, state, elapsed, purpose.
    row: [name ? `${name} (${id})` : id, state, elapsed, purpose].filter(Boolean).join("  "),
    detail: [
      ["Agent", name ? `${name} (${id})` : id || "?"],
      ["State", state || "?"],
      ["Elapsed", elapsed || "?"],
      ["Purpose", purpose || "—"],
    ],
  };
}

function taskItem(task: DescribeTask): DrilldownItem {
  const id = sanitizePeerText(task.id, ID_MAX);
  const status = sanitizePeerText(task.status, STATE_MAX);
  const subject = sanitizePeerText(task.subject, SUBJECT_MAX);
  const blockedBy = (task.blockedBy ?? []).map((blocker) => sanitizePeerText(blocker, ID_MAX));
  const owner = sanitizePeerText(task.owner ?? "", NAME_MAX);
  const description = sanitizePeerText(task.description ?? "", DESCRIPTION_MAX);
  // The list line is THE task row definition, shared with `/tasks` and the workload pane.
  const row = formatTaskRowLine({ id: id || "?", status, subject, blockedBy });
  const detail: Array<[string, string]> = [
    ["Subject", subject || "—"],
    ["Status", status || "?"],
    ["Owner", owner || "—"],
    ["Blocked by", blockedBy.length > 0 ? blockedBy.map((b) => `#${b}`).join(", ") : "—"],
    ["Description", description || "—"],
  ];
  return { id: id || "?", row, detail };
}

function cronItem(cron: DescribeCron): DrilldownItem {
  const id = sanitizePeerText(cron.id, ID_MAX);
  const schedule = sanitizePeerText(cron.schedule, SCHEDULE_MAX);
  const next = sanitizePeerText(cron.next, NEXT_MAX);
  const description = sanitizePeerText(cron.description, DESCRIPTION_MAX);
  return {
    id: id || "?",
    // The peer already formatted these with the cron-status helpers it renders locally.
    row: [id, schedule, next, description].filter(Boolean).join("  "),
    detail: [
      ["Schedule", schedule || "?"],
      ["Next run", next || "?"],
      ["Description", description || "—"],
    ],
  };
}

function truncatedItem(more: number): DrilldownItem {
  const row = `… ${more} more`;
  return { id: `more:${more}`, row, detail: [["truncated", row]] };
}

/**
 * Level 2: one row per non-empty section, with its count. Empty sections are omitted; a peer that
 * answered with nothing active, or failed to answer at all, gets one status row carrying the
 * reason — never three empty sections and never a fabricated zero.
 */
export function buildDrilldownRows(result: DescribeResult): DrilldownRow[] {
  if (!result.ok) {
    const label = workloadUnknownLine(result.reason, result.code);
    log.debug("drilldown_sections_unknown", { reason: result.reason, code: result.code ?? null });
    return [statusRow(label)];
  }
  const { agents, tasks, crons } = result.detail;
  const truncated: WorkloadTruncation = result.truncated;
  const rows: DrilldownRow[] = [];
  if (agents.length > 0) {
    rows.push({
      id: "section:agents",
      label: `async agents (${agents.length})`,
      section: "agents",
      items: [...agents.map(agentItem), ...(truncated.agents ? [truncatedItem(truncated.agents)] : [])],
    });
  }
  if (tasks.length > 0) {
    rows.push({
      id: "section:tasks",
      label: `tasks (${tasks.length})`,
      section: "tasks",
      items: [...tasks.map(taskItem), ...(truncated.tasks ? [truncatedItem(truncated.tasks)] : [])],
    });
  }
  if (crons.length > 0) {
    rows.push({
      id: "section:crons",
      label: `crons (${crons.length})`,
      section: "crons",
      items: [...crons.map(cronItem), ...(truncated.crons ? [truncatedItem(truncated.crons)] : [])],
    });
  }
  if (rows.length === 0) {
    log.debug("drilldown_sections_empty", {});
    return [statusRow(WORKLOAD_NONE_LINE)];
  }
  log.debug("drilldown_sections", { rows: rows.length, agents: agents.length, tasks: tasks.length, crons: crons.length });
  return rows;
}
