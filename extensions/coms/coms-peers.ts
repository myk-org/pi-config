/**
 * PC-wide peer inventory, from the coms registry that every peer writes.
 *
 * Listing must not depend on coms being active in the session you type in (the registry is just
 * files), and it must span projects: the same `--project` is deliberately shared across repos
 * (rootcoz ↔ pi-sidecar), so a project-scoped list would hide exactly the peers a user is
 * coordinating.
 */
import { formatWorkloadSuffix, type PeerWorkloadCounts } from "./coms-workload.js";
import { sanitizePeerText } from "./peer-text.js";
import { createLogger } from "../shared/logger.js";
import type { HistoryRecord } from "./coms-history.js";
import { buildPeerContainerName, isValidPeerContainerName } from "../../scripts/podman-peer-image.mjs";
import {
  formatActivityEventPlain,
  type ActivityCategory,
  type ActivityEvent,
} from "../orchestrator/overlay-activity-log.js";

const log = createLogger("coms-peers");

export interface RegistryRow {
  /** Project namespace (the registry directory name). */
  project: string;
  name: string;
  pid: number | null;
  cwd: string;
  purpose: string;
  endpoint: string;
  /** Heartbeat-refreshed live state — the closest thing to "watching" a headless peer. */
  busy: boolean;
  queueDepth: number | null;
  contextUsedPct: number | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  /** Who activated coms in this session: `user` (slash command) or `agent` (coms_start tool). */
  origin?: string | null;
  /** Who spawned this peer as a process, from the supervisor's record, which is the more
   *  authoritative answer when both exist. */
  createdBy?: string | null;
  /** Pi session id recorded in the registry or supervisor metadata (used by `r` revive to resume session). */
  piSessionId?: string | null;
  /** True for recently stopped supervised peers shown in `/coms` for `r` revive. */
  stopped?: boolean;
  /** ISO timestamp when a stopped supervised peer exited/stopped. */
  stoppedAt?: string | null;
  /** Exit code of a stopped supervised peer when known. */
  exitCode?: number | null;
  /** #1083: the peer's own active counts. `null`/absent = not reported = `unknown`, never 0. */
  workload?: PeerWorkloadCounts | null;
  /** #1512: rootless Podman container name when running inside a sandbox container. */
  container?: string | null;
  /** #1512: real host PID (`State.Pid`) for a containerized peer when known. */
  hostPid?: number | null;
  /** #1512: recorded sandbox runtime mode (`"off"` | `"podman"`) for stopped-peer revive fidelity. */
  sandbox?: "off" | "podman" | null;
}

/** Shape of a supervisor state JSON written to `~/.pi/coms/peers/<cname>@<project>.json`. */
export interface SupervisionRecord {
  cname?: string;
  project?: string;
  cwd?: string;
  purpose?: string;
  pid?: number;
  childPid?: number | null;
  container?: string | null;
  image?: string | null;
  sandbox?: string | null;
  session?: string | null;
  piSessionId?: string | null;
  createdBy?: string | null;
  startedAt?: string;
  stoppedAt?: string;
  exitedAt?: string;
  failedAt?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  failure?: string;
}

export interface PeerFilter {
  project?: string | null;
  name?: string | null;
}

/** Apply the optional `project` / `name` filters. No filter means every peer on the machine. */
export function filterRegistry(rows: RegistryRow[], filter: PeerFilter = {}): RegistryRow[] {
  return rows.filter((row) => {
    if (filter.project && row.project !== filter.project) return false;
    if (filter.name && row.name !== filter.name) return false;
    return true;
  });
}

/** A kill request resolved to concrete rows. Ambiguity (one name, several projects) is reported
 *  rather than guessed: killing the wrong peer is worse than asking for a qualifier. */
export interface KillSelection {
  targets: RegistryRow[];
  missing: string[];
  ambiguous: RegistryRow[];
}

export function selectKillTargets(
  rows: RegistryRow[],
  request: { name?: string | null; project?: string | null; all?: boolean | null },
  isAlive: (row: RegistryRow) => boolean,
): KillSelection {
  const live = rows.filter((row) => isAlive(row) && ((row.pid ?? 0) > 0 || Boolean(row.container)));
  if (request.all === true) {
    return { targets: live, missing: [], ambiguous: [] };
  }
  const name = (request.name ?? "").trim();
  if (!name) return { targets: [], missing: [], ambiguous: [] };
  const matches = live.filter((row) => row.name === name && (!request.project || row.project === request.project));
  if (matches.length === 0) return { targets: [], missing: [name], ambiguous: [] };
  if (matches.length > 1) return { targets: [], missing: [], ambiguous: matches };
  return { targets: matches, missing: [], ambiguous: [] };
}

/** One row per peer: name, project, ids, and the live state that makes the list worth reading. */
export function formatPeerTable(rows: RegistryRow[]): string {
  if (rows.length === 0) return "No peers found in the coms registry (~/.pi/coms/projects).";
  const lines = rows
    .slice()
    .sort((a, b) => (a.project === b.project ? a.name.localeCompare(b.name) : a.project.localeCompare(b.project)))
    .map((row) => {
      const state = row.busy ? "busy" : "idle";
      const queue = row.queueDepth ? ` queue:${row.queueDepth}` : "";
      const ctx = row.contextUsedPct === null ? "" : ` ctx:${Math.round(row.contextUsedPct)}%`;
      const pid = row.hostPid ? ` pid:${row.hostPid}` : (row.pid ? ` pid:${row.pid}` : "");
      const ctr = row.container ? ` 🐳 ${sanitizePeerText(row.container, 48)}` : "";
      // #1084: peer-supplied text is sanitized before it reaches a terminal.
      return `● ${sanitizePeerText(row.name, 40)} · ${sanitizePeerText(row.project, 40)} (${state}${queue}${ctx}${pid}${ctr})${formatWorkloadSuffix(row.workload)} — ${sanitizePeerText(row.cwd, 120) || "?"}`;
    });
  // Counts only: how many peers could not report, never what they said.
  log.debug("peer_table_rendered", { rows: rows.length, unknown: rows.filter((row) => row.workload == null).length });
  return `${rows.length} peer(s):\n${lines.join("\n")}`;
}

export interface PeerDetailOptions {
  /** Age of the last keep-alive, from the caller's clock (`null` when it cannot be computed). */
  heartbeatAgeSeconds?: number | null;
  /** Transient overlay message (e.g. the result of a kill), rendered as-is by the caller. */
  status?: string | null;
}

/**
 * The peer detail pane body. Every peer-supplied field is sanitized at THIS boundary and capped,
 * because a purpose, cwd or socket carrying escape sequences would otherwise reach the terminal.
 * Identity is never touched here — only what is displayed.
 */
export function formatPeerDetailLines(row: RegistryRow, options: PeerDetailOptions = {}): string[] {
  const age = options.heartbeatAgeSeconds ?? null;
  const origin = describePeerOrigin(row);
  const lines = [
    `cwd       ${sanitizePeerText(row.cwd, 120) || "?"}`,
    `purpose   ${sanitizePeerText(row.purpose, 120) || "—"}`,
    `state     ${row.busy ? "busy" : "idle"}${row.queueDepth ? ` · queue ${row.queueDepth}` : ""}`,
    `created   ${origin.by === "unknown" ? "unknown (no record)" : sanitizePeerText(origin.by, 40)} · via ${sanitizePeerText(origin.via, 40)}`,
    ...(row.container ? [`container ${sanitizePeerText(row.container, 64)}`] : []),
    `pid       ${row.hostPid ?? row.pid ?? "?"}`,
    `socket    ${sanitizePeerText(row.endpoint, 80) || "?"}`,
    `heartbeat ${age === null || age === undefined ? "unknown" : `${age}s ago`} (last keep-alive)`,
    `context   ${row.contextUsedPct === null ? "?" : `${Math.round(row.contextUsedPct)}%`}`,
    // The registry rewrites started_at on every heartbeat, so it is not a real start time.
    "",
  ];
  if (options.status) lines.push(options.status);
  return lines;
}

/** A peer is live only while it keeps writing its heartbeat.
 *
 *  `kill -0` alone is not enough: a crashed peer's pid can be reused by an unrelated process, and a
 *  leftover record would then look alive forever. The heartbeat is refreshed while the peer runs,
 *  so an old one means the peer is gone even if the socket file was never unlinked. */
export function isFreshHeartbeat(
  heartbeatAt: string | null | undefined,
  now: number,
  maxAgeMs = 120_000,
): boolean {
  if (!heartbeatAt) return false;
  const parsed = Date.parse(heartbeatAt);
  if (Number.isNaN(parsed)) return false;
  return now - parsed <= maxAgeMs;
}

/** Keys (`project::name`) of peers a supervisor is running.
 *
 *  Kill operations are scoped to these: the registry lists EVERY peer, including the caller's own
 *  session and other human sessions, so "kill all" over the raw registry would terminate them. */
export function supervisedPeerKeys(
  records: Array<{ cname?: string; project?: string; pid?: number; childPid?: number | null }>,
): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    if (typeof record?.cname !== "string" || !record.cname) continue;
    // pid 0 is not a process: a record without a real supervisor pid is not killable.
    if (!Number.isInteger(record?.pid) || (record?.pid ?? 0) <= 0) continue;
    keys.add(`${record.project ?? "default"}::${record.cname}`);
  }
  return keys;
}

/** One entry per requested kill, with the process to signal and why that process is the right one. */
export interface KillPlanEntry {
  name: string;
  project: string;
  /** Supervisor pid when one owns this peer, else the peer pid. */
  signalPid: number | null;
  /** Rootless Podman container name when peer is containerized (#1512). */
  container?: string | null;
  reason: "supervisor" | "peer" | "not-supervised" | "stale-record" | "ambiguous";
}

/** Decide what a kill request may signal.
 *
 *  Scope decisions are the dangerous part, so they are pure and reported per peer: a peer with no
 *  live supervisor record is `not-supervised` (never signalled — that would hit a human session or a
 *  reused pid), and a retired record is `stale-record`. */
export function planPeerKills(args: {
  rows: RegistryRow[];
  supervisedKeys: Set<string>;
  records: Array<{ cname?: string; project?: string; pid?: number; childPid?: number | null; container?: string | null; stoppedAt?: string; exitedAt?: string; failedAt?: string }>;
  request: { name?: string | null; project?: string | null; all?: boolean | null };
  isAlive: (row: RegistryRow) => boolean;
  logger?: { debug: (msg: string, data?: unknown) => void };
}): KillPlanEntry[] {
  const requestedProject = (args.request.project ?? "").trim();
  // `*` is the "every project" view, not a project name. Anything else is a literal filter.
  const everyProject = !requestedProject || requestedProject === "*";
  const scope = everyProject
    ? args.rows
    : args.rows.filter((row) => row.project === requestedProject);
  args.logger?.debug("coms_kill_plan_scope", { project: requestedProject || "<none>", everyProject, rows: scope.length });
  const name = (args.request.name ?? "").trim();
  const candidates = args.request.all === true
    ? scope
    : name ? scope.filter((row) => row.name === name) : [];

  // Two peers sharing a name across projects: refusing beats stopping the wrong one.
  if (!args.request.all && name && everyProject && candidates.length > 1) {
    return candidates.map((row) => ({ name: row.name, project: row.project, signalPid: null, reason: "ambiguous" as const }));
  }

  return candidates.map((row) => {
    const key = `${row.project}::${row.name}`;
    if (!args.supervisedKeys.has(key)) return { name: row.name, project: row.project, signalPid: null, reason: "not-supervised" };
    if (!args.isAlive(row)) return { name: row.name, project: row.project, signalPid: null, reason: "stale-record" };
    const record = args.records.find(
      (r) => r?.cname === row.name && (r?.project ?? "default") === row.project,
    );
    if (!record) return { name: row.name, project: row.project, signalPid: null, reason: "stale-record" };
    // #1512: derive container kill target strictly from the host-owned supervision record
    // verified against the deterministic identity-hashed container name (never trust an
    // arbitrary peer-written registry container name or peer-written host_pid).
    const expectedContainer = buildPeerContainerName(row.project, row.name);
    const recordContainer =
      typeof record.container === "string" && isValidPeerContainerName(record.container.trim())
        ? record.container.trim()
        : null;
    const verifiedContainer = recordContainer === expectedContainer ? recordContainer : null;
    const isContainerized = Boolean(verifiedContainer);

    // A retired record is leftover bookkeeping, not a reason to leave a LIVE peer running.
    if (record.stoppedAt || record.exitedAt || record.failedAt) {
      return {
        name: row.name,
        project: row.project,
        signalPid: isContainerized ? null : (row.pid ?? null),
        ...(verifiedContainer ? { container: verifiedContainer } : {}),
        reason: "peer",
      };
    }
    // Signal the host supervisor when its recorded child matches or it owns the verified container.
    if (Number.isInteger(record.pid) && (record.childPid === row.pid || Boolean(verifiedContainer))) {
      return {
        name: row.name,
        project: row.project,
        signalPid: record.pid as number,
        ...(verifiedContainer ? { container: verifiedContainer } : {}),
        reason: "supervisor",
      };
    }
    return {
      name: row.name,
      project: row.project,
      signalPid: isContainerized ? null : (row.pid ?? null),
      ...(verifiedContainer ? { container: verifiedContainer } : {}),
      reason: "peer",
    };
  });
}

/** Explain who created a peer.
 *
 *  The supervisor record wins because it describes the process. Otherwise the activation entry point
 *  is used, and they are genuinely different: `pi --coms` is a CLI start, not somebody typing a
 *  slash command. `unknown` is honest for a peer that predates either field rather than guessing
 *  "user". */
export function describePeerOrigin(row: RegistryRow): { by: string; via: string } {
  const record = (row.createdBy ?? "").trim();
  if (record === "agent" || record === "user") {
    return { by: record, via: "supervisor" };
  }
  const entry = (row.origin ?? "").trim();
  if (entry === "tool") return { by: "agent", via: "coms_start tool" };
  if (entry === "slash") return { by: "user", via: "/coms start" };
  if (entry === "cli") return { by: "user", via: "pi --coms" };
  // Peers started before the entry-point vocabulary keep writing these two values.
  if (entry === "agent") return { by: "agent", via: "coms_start (legacy record)" };
  if (entry === "user") return { by: "user", via: "/coms start (legacy record)" };
  return { by: "unknown", via: "no record" };
}

/** The supervision record that belongs to THIS peer instance.
 *
 *  Records outlive the peer and accumulate per name+project, so "the first match" would label a new
 *  peer with an old creator. The live record whose child is this pid wins; otherwise the newest
 *  non-retired one; otherwise nothing — a retired record describes a peer that is gone. */
export function pickSupervisionRecord<T extends { cname?: string; project?: string; childPid?: number | null; startedAt?: string; stoppedAt?: string; exitedAt?: string; failedAt?: string }>(
  records: T[],
  row: Pick<RegistryRow, "name" | "project" | "pid">,
): T | null {
  const same = records.filter((r) => r?.cname === row.name && (r?.project ?? "default") === row.project);
  const live = same.filter((r) => !r.stoppedAt && !r.exitedAt && !r.failedAt);
  const exact = live.find((r) => typeof row.pid === "number" && r.childPid === row.pid);
  if (exact) return exact;
  if (live.length === 0) return null;
  return live.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")))[0];
}

/** Did activation actually produce a peer? The upstream start handler swallows socket-bind and
 *  registry failures, so a normal return is not proof. */
export function activationVerified(
  self: { endpoint?: string | null } | null | undefined,
  platform: string,
  exists: (path: string) => boolean,
): boolean {
  if (!self?.endpoint) return false;
  if (platform === "win32") return true; // named pipe: not on the filesystem
  return exists(self.endpoint);
}

/** What to do with a persisted "active" claim.
 *
 *  The flag is not proof: right after a reload the peer needs a couple of seconds to register, and a
 *  claim without a socket is a lie the caller acts on. A verified claim is reused; an unverified one
 *  is treated as stale and the caller STARTS a fresh peer, because "run /coms stop first" made a
 *  reload recovery manual for no reason. */
export function planActiveClaim(
  self: { endpoint?: string | null } | null | undefined,
  platform: string,
  exists: (path: string) => boolean,
  logger?: { warn: (msg: string, data?: unknown) => void },
): { action: "reuse" | "restart"; message: string } {
  if (activationVerified(self, platform, exists)) {
    return { action: "reuse", message: "📡 coms already active" };
  }
  logger?.warn("coms_active_claim_unverified", { endpoint: self?.endpoint ?? null });
  return {
    action: "restart",
    message: "📡 coms: the previous peer is gone (no socket) — starting a fresh one",
  };
}

/** Which project a tool call should see.
 *
 *  A human running `/coms list` wants the whole machine, but an LLM must not be shown peers from a
 *  project it cannot address — it will try to message them, and "who is this peer?" costs a turn.
 *  Default scope is therefore the caller's own project; `*` (or `all`) asks for every project. */
export function resolvePeerScope(
  requested: string | null | undefined,
  ownProject: string,
): { project: string | null; everyProject: boolean } {
  const wanted = (requested ?? "").trim();
  if (wanted === "*" || wanted.toLowerCase() === "all") return { project: null, everyProject: true };
  if (wanted) return { project: wanted, everyProject: false };
  return { project: ownProject || null, everyProject: false };
}

/** Windows refuses these as directory names, so a project that reaches `projects/<name>` fails before
 *  the peer can register. Checked on every platform so a peer started here still works there. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Why a project namespace cannot be used, or null when it can. */
export function projectProblem(project: string): string | null {
  if (/[\/\\]/.test(project)) return "project must not contain path separators";
  if (project.includes("..")) return "project must not contain '..'";
  if (/[\x00-\x1f]/.test(project)) return "project must not contain control characters";
  // `.` alone (and any all-dots name) resolves to `projects/agents`, so the peer registers under the
  // scanner's own directory name instead of a project and disappears from listings.
  if (/^\.+$/.test(project)) return "project must not be dots only";
  if (WINDOWS_RESERVED.test(project)) return `"${project}" is reserved on Windows`;
  if (project.includes(":")) return "project must not contain ':'";
  return null;
}

/** Validate a peer name and build the supervisor invocation.
 *
 *  Spawning a peer is a plain `node <supervisor> <name> …` call, which is exactly why a model could
 *  not discover it: no tool named it. The command is built here so it is testable, and the checks
 *  keep a name from becoming a shell/argv surprise in the supervisor. */
export function buildPeerSpawn(
  supervisorPath: string,
  args: {
    cname?: string | null;
    project?: string | null;
    cwd?: string | null;
    purpose?: string | null;
    session?: string | null;
    sandbox?: "off" | "podman" | null;
    image?: string | null;
    cpus?: number | null;
    memory?: string | null;
  },
  logger?: { warn: (msg: string, data?: unknown) => void },
): { ok: true; command: string[] } | { ok: false; message: string } {
  const refuse = (reason: string, message: string) => {
    logger?.warn("coms_spawn_refused", { reason, cname: args.cname ?? null, project: args.project ?? null });
    return { ok: false as const, message };
  };
  const cname = (args.cname ?? "").trim();
  if (!cname) return refuse("missing_cname", "coms peer spawn: cname is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cname)) {
    return refuse("invalid_cname", "coms peer spawn: cname must be 1-64 chars of letters, digits, dot, dash or underscore");
  }
  if (!supervisorPath) return refuse("missing_supervisor", "coms peer spawn: supervisor script not found (is pi-orchestrator-config installed?)");
  const command = ["node", supervisorPath, cname];
  const project = (args.project ?? "").trim();
  // A project namespace becomes a DIRECTORY NAME inside the coms root, so it is validated like a
  // filename: no separators, no `..`, nothing that could place registry files elsewhere.
  if (project) {
    const problem = projectProblem(project);
    if (problem) return refuse("invalid_project", `coms peer spawn: ${problem}`);
    command.push("--project", project);
  }
  const cwd = (args.cwd ?? "").trim();
  if (cwd) command.push("--cwd", cwd);
  const purpose = (args.purpose ?? "").trim();
  if (purpose) command.push("--purpose", purpose);
  const session = (args.session ?? "").trim();
  if (session) {
    if (/[\x00-\x1f]/.test(session)) {
      return refuse("invalid_session", "coms peer spawn: session must not contain control characters");
    }
    command.push("--session", session);
  }
  if (args.sandbox === "podman") {
    const image = (args.image ?? "").trim();
    if (!image || /[\x00-\x1f\s]/.test(image)) {
      return refuse("invalid_image", "coms peer spawn: podman sandbox requires a valid image tag");
    }
    command.push("--sandbox", "podman", "--image", image);
    if (typeof args.cpus === "number" && Number.isInteger(args.cpus) && args.cpus > 0) {
      command.push("--cpus", String(args.cpus));
    }
    const memory = (args.memory ?? "").trim();
    if (memory && !/[\x00-\x1f\s]/.test(memory)) {
      command.push("--memory", memory);
    }
  }
  return { ok: true, command };
}

/** What a kill request may touch.
 *
 *  `all` is scoped to the caller's project — a tool must not wipe the machine — while a NAMED peer is
 *  looked up across projects (with ambiguity refused), because naming one is already specific and a
 *  peer in another project may legitimately be the one the caller means. */
export function resolveKillScope(
  request: { name?: string | null; project?: string | null; all?: boolean | null },
  ownProject: string,
  logger?: { debug: (msg: string, data?: unknown) => void; warn: (msg: string, data?: unknown) => void },
): { name?: string; project?: string; all?: boolean; refused?: string } {
  if (request.all === true) {
    const requested = (request.project ?? "").trim();
    // `*` is the "every project" view, not a project name: killing in it must cover what it shows.
    if (requested === "*") {
      logger?.debug("coms_kill_scope", { all: true, project: "*" });
      return { all: true, project: "*" };
    }
    const project = requested || (ownProject ?? "").trim();
    // No scope means NO kill: falling open here stopped every project's peers.
    if (!project) {
      const refused = "coms peer kill: cannot tell which project to scope all to — pass project explicitly";
      logger?.warn("coms_kill_refused", { reason: "no_project_scope", request: { all: true } });
      return { all: true, refused };
    }
    logger?.debug("coms_kill_scope", { all: true, project });
    return { all: true, project };
  }
  const name = (request.name ?? "").trim();
  const project = (request.project ?? "").trim();
  logger?.debug("coms_kill_scope", { name, project: project || "*" });
  return { name, project: project || undefined };
}

/** Why the user path may not send to `found` (#1077): null means exactly one candidate, so send
 *  it. A human aiming at one peer must never hit another, so two candidates is a refusal naming
 *  them — not the agent tools' "pick the freshest" shortcut. */
export function userTargetProblem(
  found: Array<{ name: string; project: string }>,
  asked: string,
  project?: string,
): string | null {
  if (found.length === 0) {
    return `no live peer "${asked}"${project ? ` in project "${project}"` : ""}`;
  }
  if (found.length === 1) return null;
  const where = found.map((row) => `${row.name}·${row.project}`).join(", ");
  return `"${asked}" is ambiguous (${where}) — pass --project to choose`;
}

/**
 * Derive recently stopped supervised peers from `~/.pi/coms/peers/*.json` records (#1417).
 * Excludes peers that currently have a matching live registry row (`project::name`),
 * deduplicates per `project::name` keeping the newest stop/exit timestamp, and returns
 * rows marked `stopped: true` so `/coms` can display them and revive them via `r`.
 */
export function listStoppedSupervisedPeers(
  records: readonly SupervisionRecord[],
  liveRows: readonly Pick<RegistryRow, "project" | "name">[],
  filter: PeerFilter = {},
  maxCount = 20,
): RegistryRow[] {
  const liveKeys = new Set(liveRows.map((row) => `${row.project}::${row.name}`));
  const latestByKey = new Map<string, { ts: number; row: RegistryRow }>();

  for (const record of records) {
    const cname = typeof record?.cname === "string" ? record.cname.trim() : "";
    if (!cname) continue;
    const project = typeof record.project === "string" && record.project.trim()
      ? record.project.trim()
      : "default";
    if (filter.project && project !== filter.project) continue;
    if (filter.name && cname !== filter.name) continue;

    const key = `${project}::${cname}`;
    if (liveKeys.has(key)) continue;

    const stoppedAt = record.exitedAt ?? record.stoppedAt ?? record.failedAt ?? null;
    if (!stoppedAt) continue;

    const ts = Date.parse(stoppedAt) || 0;
    const prev = latestByKey.get(key);
    if (prev && prev.ts >= ts) continue;

    const sessionId = (typeof record.piSessionId === "string" && record.piSessionId.trim())
      ? record.piSessionId.trim()
      : (typeof record.session === "string" && record.session.trim() ? record.session.trim() : null);

    latestByKey.set(key, {
      ts,
      row: {
        project,
        name: cname,
        pid: null,
        cwd: typeof record.cwd === "string" ? record.cwd : "",
        purpose: typeof record.purpose === "string" ? record.purpose : "",
        endpoint: "",
        busy: false,
        queueDepth: null,
        contextUsedPct: null,
        startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
        heartbeatAt: null,
        origin: null,
        createdBy: typeof record.createdBy === "string" ? record.createdBy : null,
        piSessionId: sessionId,
        stopped: true,
        stoppedAt,
        exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
        workload: null,
        container: typeof record.container === "string" && record.container.trim() ? record.container.trim() : null,
        sandbox: record.sandbox === "podman" || (typeof record.container === "string" && record.container.trim().length > 0) ? "podman" : "off",
      },
    });
  }

  const sorted = [...latestByKey.values()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(1, maxCount))
    .map((entry) => entry.row);
  log.debug("stopped_supervised_peers_listed", { total: records.length, stopped: sorted.length });
  return sorted;
}

/** Deterministic overlay row ID for a live or stopped peer. */
export function peerOverlayRowId(row: Pick<RegistryRow, "project" | "name" | "endpoint" | "stopped">): string {
  if (row.stopped) return `stopped:${row.project}:${row.name}`;
  return `${row.project}:${row.name}\0${row.endpoint}`;
}

function historyDirectionPrefix(direction: HistoryRecord["direction"]): string {
  switch (direction) {
    case "out":
      return "→ sent";
    case "in":
      return "← recv";
    case "steer":
      return "⚡ steer";
    case "response_out":
      return "↩ reply sent";
    case "response_in":
      return "↩ reply recv";
    default:
      return "msg";
  }
}

/**
 * Aggregate chronological COMS lifecycle, message, and error events for the `/coms`
 * `[2] Activity` tab (#1417). All peer-supplied strings are sanitized before display.
 */
export function collectComsActivityEvents(args: {
  historyRecords: readonly HistoryRecord[];
  livePeers: readonly RegistryRow[];
  stoppedPeers?: readonly RegistryRow[];
  allKnownPeers?: readonly Pick<RegistryRow, "project" | "name" | "endpoint" | "stopped">[];
  projectFilter?: string | null;
  maxTotal?: number;
  now?: number;
}): ActivityEvent[] {
  const maxTotal = args.maxTotal ?? 400;
  const now = args.now ?? Date.now();
  const stoppedPeers = args.stoppedPeers ?? [];
  const events: ActivityEvent[] = [];

  // Project-qualified lookup prevents same-named peers in different projects from colliding.
  const rowIdByQualified = new Map<string, string>();
  const rowIdsByName = new Map<string, string[]>();

  const registerRosterLookup = (
    row: Pick<RegistryRow, "project" | "name" | "endpoint" | "stopped">,
    id: string,
  ): void => {
    const qKey = `${row.project}::${row.name}`;
    if (!rowIdByQualified.has(qKey)) rowIdByQualified.set(qKey, id);
    const list = rowIdsByName.get(row.name) ?? [];
    if (!list.includes(id)) list.push(id);
    rowIdsByName.set(row.name, list);
  };

  for (const row of args.livePeers) {
    const id = peerOverlayRowId(row);
    registerRosterLookup(row, id);
    const ts = row.startedAt ? (Date.parse(row.startedAt) || now) : now;
    const stateDesc = row.busy
      ? `peer busy${row.queueDepth ? ` (queue ${row.queueDepth})` : ""}`
      : "peer online";
    events.push({
      id: `live:${id}`,
      timestamp: ts,
      sourceId: id,
      sourceLabel: sanitizePeerText(row.name, 36) || "peer",
      category: "lifecycle",
      summary: `${stateDesc} · ${sanitizePeerText(row.project, 32)}`,
    });
  }

  for (const row of stoppedPeers) {
    const id = peerOverlayRowId(row);
    registerRosterLookup(row, id);
    const ts = row.stoppedAt ? (Date.parse(row.stoppedAt) || now) : now;
    const isErr = typeof row.exitCode === "number" && row.exitCode !== 0;
    const codePart = typeof row.exitCode === "number" ? ` (exit ${row.exitCode})` : "";
    events.push({
      id: `stopped:${id}`,
      timestamp: ts,
      sourceId: id,
      sourceLabel: sanitizePeerText(row.name, 36) || "peer",
      category: isErr ? "error" : "lifecycle",
      summary: `peer stopped${codePart} · ${sanitizePeerText(row.project, 32)}`,
    });
  }

  // Also index any additional known peers across all projects by verified project::name so
  // project-scoped Activity messages to verified remote recipients resolve cleanly on Enter.
  if (args.allKnownPeers) {
    for (const row of args.allKnownPeers) {
      const qKey = `${row.project}::${row.name}`;
      if (!rowIdByQualified.has(qKey)) {
        rowIdByQualified.set(qKey, peerOverlayRowId(row));
      }
    }
  }

  for (let i = 0; i < args.historyRecords.length; i++) {
    const rec = args.historyRecords[i];
    const ownerProject = typeof rec.project === "string" && rec.project.trim() ? rec.project.trim() : null;
    // In project-scoped views, require a proven matching owner project — never leak
    // other-project records or legacy untagged records merely because a peer name matches.
    if (args.projectFilter && ownerProject !== args.projectFilter) continue;

    const ts = Date.parse(rec.ts) || now;
    const hasErr = Boolean(rec.error) || /fail|error|reject|timeout|refus/i.test(rec.status ?? "");
    const category: ActivityCategory = hasErr ? "error" : "message";
    const prefix = historyDirectionPrefix(rec.direction);
    const preview = sanitizePeerText(rec.preview || "", 110);
    const errPart = rec.error ? ` — ${sanitizePeerText(rec.error, 60)}` : "";
    const statusPart = !rec.error && rec.status ? ` [${sanitizePeerText(rec.status, 24)}]` : "";

    // Route Enter ONLY using the verified remote `peer_project` — never assume the record
    // owner's project equals a remote sender's project (a cross-project sender can share a
    // name with a local namesake).
    const verifiedPeerProject = typeof rec.peer_project === "string" && rec.peer_project.trim()
      ? rec.peer_project.trim()
      : null;
    let sourceId: string;
    if (verifiedPeerProject) {
      sourceId = rowIdByQualified.get(`${verifiedPeerProject}::${rec.peer}`) ?? `peer:${verifiedPeerProject}:${rec.peer}`;
    } else {
      const candidates = rowIdsByName.get(rec.peer) ?? [];
      if (candidates.length > 1) {
        sourceId = `peer:ambiguous:${rec.peer}`;
      } else if (!ownerProject && candidates.length === 1) {
        // Legacy record (predating project/peer_project) in all-projects view with a unique match.
        sourceId = candidates[0];
      } else {
        // Unverified remote sender project: leave unlinked so Enter never opens a local namesake.
        sourceId = `peer:unverified:${rec.peer}`;
      }
    }

    events.push({
      id: `hist:${rec.msg_id}:${rec.direction}:${i}`,
      timestamp: ts,
      sourceId,
      sourceLabel: sanitizePeerText(rec.peer, 36) || "peer",
      category,
      summary: `${prefix}${statusPart}: ${preview}${errPart}`,
    });
  }

  events.sort((a, b) => (a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.id.localeCompare(b.id)));
  if (events.length > maxTotal) return events.slice(-maxTotal);
  return events;
}

/** Safe plain-text fallback for headless / non-UI `/coms` invocations. */
export function formatComsPeersPlainText(
  livePeers: readonly RegistryRow[],
  stoppedPeers: readonly RegistryRow[] = [],
  events: readonly ActivityEvent[] = [],
  emptyMessage = "No peers in the coms registry.",
): string {
  if (livePeers.length === 0 && stoppedPeers.length === 0 && events.length === 0) {
    return emptyMessage;
  }
  const lines: string[] = [];
  if (livePeers.length > 0) {
    lines.push(formatPeerTable([...livePeers]));
  }
  if (stoppedPeers.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Recently stopped supervised peer(s) (${stoppedPeers.length}):`);
    for (const row of stoppedPeers) {
      const sessionHint = row.piSessionId ? " [session]" : "";
      lines.push(
        `○ ${sanitizePeerText(row.name, 40)} · ${sanitizePeerText(row.project, 40)} (stopped${sessionHint}) — ${sanitizePeerText(row.cwd, 120) || "?"}`,
      );
    }
  }
  if (events.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Recent COMS activity:");
    for (const ev of events.slice(-10)) {
      lines.push(`  ${formatActivityEventPlain(ev)}`);
    }
  }
  return lines.join("\n");
}
