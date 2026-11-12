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
  workloadStateLabel,
  workloadUnknownLine,
  type DescribeAgent,
  type DescribeCron,
  type DescribeTask,
  type PeerWorkloadCounts,
  type WorkloadTruncation,
} from "./coms-workload.js";
import { describePeerOrigin } from "./coms-peers.js";
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
 *  (label, value) pairs the detail pane shows. Read-only: no action is attached to either.
 *
 *  `id` is the row IDENTITY (position-prefixed), not the reported id: the reported id is
 *  truncated for display, so two entries sharing a 40-char prefix — or reporting the same id —
 *  would otherwise collapse into one row and Enter could open either. The display keeps the
 *  truncated id, the identity stays unique and stable. */
export interface DrilldownItem {
  id: string;
  /** The peer-supplied id as DISPLAY: the composite `id` is bookkeeping and must never reach a
   *  pane. Absent for rows with nothing to name (`peer info`, a status row). */
  displayId?: string;
  row: string;
  detail: Array<[string, string]>;
}

/** Mappings already reported, so the answer is logged once instead of on every redraw. */
const SEEN_LABELS = new Set<string>();
const SEEN_LABELS_MAX = 1_000;

/** Test seam: the dedupe is process-wide by design, so a suite clears it between cases. */
export function clearItemIdLabelSeen(): void {
  SEEN_LABELS.clear();
}

/** What the row's id column shows. The composite identity is internal by contract (#1084).
 *
 *  Logged ONCE per distinct `id → label` mapping per process, and only when the two differ: this
 *  sits on the row renderer's hot path (twice per visible item, once a second per redraw), so a
 *  line per call would be two synchronous file writes per row per tick. The interesting case is
 *  exactly the one where display and identity disagree — that is what "which id did we display"
 *  means — and a trivial pair says nothing worth a write. */
export function itemIdLabel(item: { id?: string; displayId?: string }): string {
  const label = item.displayId ?? "";
  const rawId = String(item.id ?? "");
  const key = `${rawId}\u2192${label}`;
  if (rawId !== label && !SEEN_LABELS.has(key)) {
    if (SEEN_LABELS.size >= SEEN_LABELS_MAX) SEEN_LABELS.clear();
    SEEN_LABELS.add(key);
    // Ids only, truncated: the composite stays bookkeeping and no peer text is logged.
    log.debug("item_id_label", { id: rawId.slice(0, 40), label: label.slice(0, 40) });
  }
  return label;
}

/** Which path opened a detail pane: the one-item shortcut or a row of a section list. Logged at
 *  CONSTRUCTION only — a per-render line would be noise on every keypress. */
export type DetailOpenPath = "direct" | "list";

export function logDetailOpen(path: DetailOpenPath, item: DrilldownItem): void {
  log.debug("drilldown_detail_open", {
    path,
    id: String(item.id).slice(0, 40),
    pairs: item.detail.length,
  });
}

/** `0:texture` — position first, so the identity survives any truncation or duplication below. */
function rowId(index: number, reported: string): string {
  return `${index}:${reported}`;
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
    items: [{ id: rowId(0, "status"), row: label, detail: [["workload", label]] }],
  };
}

function agentItem(agent: DescribeAgent, index: number): DrilldownItem {
  const id = sanitizePeerText(agent.id, ID_MAX);
  const name = sanitizePeerText(agent.name, NAME_MAX);
  const state = sanitizePeerText(agent.state, STATE_MAX);
  const elapsed = sanitizePeerText(agent.elapsed, ELAPSED_MAX);
  const purpose = sanitizePeerText(agent.purpose, PURPOSE_MAX);
  return {
    id: rowId(index, id || "?"),
    displayId: id || "?",
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

function taskItem(task: DescribeTask, index: number): DrilldownItem {
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
  return { id: rowId(index, id || "?"), displayId: id || "?", row, detail };
}

function cronItem(cron: DescribeCron, index: number): DrilldownItem {
  const id = sanitizePeerText(cron.id, ID_MAX);
  const schedule = sanitizePeerText(cron.schedule, SCHEDULE_MAX);
  const next = sanitizePeerText(cron.next, NEXT_MAX);
  const description = sanitizePeerText(cron.description, DESCRIPTION_MAX);
  return {
    id: rowId(index, id || "?"),
    displayId: id || "?",
    // The peer already formatted these with the cron-status helpers it renders locally.
    row: [id, schedule, next, description].filter(Boolean).join("  "),
    detail: [
      ["Schedule", schedule || "?"],
      ["Next run", next || "?"],
      ["Description", description || "—"],
    ],
  };
}

function truncatedItem(more: number, index: number): DrilldownItem {
  const row = `… ${more} more`;
  return { id: rowId(index, `more:${more}`), row, detail: [["truncated", row]] };
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
      items: [
        ...agents.map(agentItem),
        ...(truncated.agents ? [truncatedItem(truncated.agents, agents.length)] : []),
      ],
    });
  }
  if (tasks.length > 0) {
    rows.push({
      id: "section:tasks",
      label: `tasks (${tasks.length})`,
      section: "tasks",
      items: [
        ...tasks.map(taskItem),
        ...(truncated.tasks ? [truncatedItem(truncated.tasks, tasks.length)] : []),
      ],
    });
  }
  if (crons.length > 0) {
    rows.push({
      id: "section:crons",
      label: `crons (${crons.length})`,
      section: "crons",
      items: [
        ...crons.map(cronItem),
        ...(truncated.crons ? [truncatedItem(truncated.crons, crons.length)] : []),
      ],
    });
  }
  if (rows.length === 0) {
    log.debug("drilldown_sections_empty", {});
    return [statusRow(WORKLOAD_NONE_LINE)];
  }
  log.debug("drilldown_sections", { rows: rows.length, agents: agents.length, tasks: tasks.length, crons: crons.length });
  return rows;
}

/** The registry fields the peer list already holds — no new RPC, no filesystem read. */
export interface PeerInfoSource {
  name: string;
  project: string;
  cwd?: string | null;
  purpose?: string | null;
  pid?: number | null;
  endpoint?: string | null;
  busy: boolean;
  queueDepth?: number | null;
  contextUsedPct?: number | null;
  origin?: string | null;
  createdBy?: string | null;
  workload?: PeerWorkloadCounts | null;
  heartbeatAgeSeconds?: number | null;
}

/**
 * The first row of a peer's drilldown (#1084): identity and location, which the section list no
 * longer has a text pane for. One item, so Enter opens the same read-only detail view as any item;
 * an absent field renders `—` instead of being dropped or guessed.
 */
export function buildPeerInfoRow(peer: PeerInfoSource): DrilldownRow {
  const origin = describePeerOrigin(peer as any);
  const dash = (value: string): string => value || "—";
  const age = peer.heartbeatAgeSeconds;
  const detail: Array<[string, string]> = [
    ["Name", dash(sanitizePeerText(peer.name, 40))],
    ["Project", dash(sanitizePeerText(peer.project, 40))],
    ["cwd", dash(sanitizePeerText(peer.cwd ?? "", 120))],
    ["Purpose", dash(sanitizePeerText(peer.purpose ?? "", 120))],
    ["Created by", origin.by === "unknown" ? "unknown (no record)" : `${sanitizePeerText(origin.by, 40)} · via ${sanitizePeerText(origin.via, 40)}`],
    ["pid", peer.pid === null || peer.pid === undefined ? "—" : String(peer.pid)],
    ["Socket", dash(sanitizePeerText(peer.endpoint ?? "", 80))],
    ["Heartbeat", typeof age === "number" ? `${age}s ago` : "unknown"],
    ["State", `${peer.busy ? "busy" : "idle"}${peer.queueDepth ? ` · queue ${peer.queueDepth}` : ""}${peer.contextUsedPct === null || peer.contextUsedPct === undefined ? "" : ` · ctx ${Math.round(peer.contextUsedPct)}%`}`],
    // Three cases, decided once in coms-workload: not reported is `unknown`, reported-and-empty
    // is `none active`. Turning the second into the first would claim ignorance we do not have.
    ["Workload", workloadStateLabel(peer.workload)],
  ];
  const name = sanitizePeerText(peer.name, 40) || "?";
  const project = sanitizePeerText(peer.project, 40) || "?";
  log.debug("drilldown_peer_info", { fields: detail.length });
  return {
    id: "section:peer",
    label: "peer info",
    items: [{ id: rowId(0, "peer"), row: `${name} · ${project}`, detail }],
  };
}

/** The section list's count label. `peer info` is a row, not a section, so counting the rows
 *  would inflate the number (an idle peer would read `2 sections`). Zero workload sections
 *  returns an EMPTY label: the info row already fills the list and the status row already says
 *  why there is nothing else, so `0 sections` would add noise, not information. */
export function sectionCountLabel(rows: ReadonlyArray<{ section?: string }>): string {
  const sections = rows.filter((row) => row.section !== undefined).length;
  log.debug("section_count_label", { rows: rows.length, sections });
  return sections === 0 ? "" : `${sections} section${sections === 1 ? "" : "s"}`;
}

/** One item is one Enter step, not two: a section holding exactly one entry opens that entry's
 *  detail directly, because a one-row list exists only to be pressed again. Applied uniformly —
 *  `peer info` is just a section with one item, not a special case. */
export function sectionEnterMode(items: ReadonlyArray<unknown>): "detail" | "list" {
  const mode = items.length === 1 ? "detail" : "list";
  log.debug("section_enter_mode", { mode, items: items.length });
  return mode;
}
