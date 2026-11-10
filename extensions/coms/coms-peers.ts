/**
 * PC-wide peer inventory, from the coms registry that every peer writes.
 *
 * Listing must not depend on coms being active in the session you type in (the registry is just
 * files), and it must span projects: the same `--project` is deliberately shared across repos
 * (rootcoz ↔ pi-sidecar), so a project-scoped list would hide exactly the peers a user is
 * coordinating.
 */
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
  const live = rows.filter((row) => isAlive(row) && (row.pid ?? 0) > 0);
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
      const pid = row.pid ? ` pid:${row.pid}` : "";
      return `● ${row.name} · ${row.project} (${state}${queue}${ctx}${pid}) — ${row.cwd || "?"}`;
    });
  return `${rows.length} peer(s):\n${lines.join("\n")}`;
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
  records: Array<{ cname?: string; project?: string; pid?: number; childPid?: number | null; stoppedAt?: string; exitedAt?: string; failedAt?: string }>;
  request: { name?: string | null; project?: string | null; all?: boolean | null };
  isAlive: (row: RegistryRow) => boolean;
}): KillPlanEntry[] {
  const scope = args.request.project
    ? args.rows.filter((row) => row.project === args.request.project)
    : args.rows;
  const name = (args.request.name ?? "").trim();
  const candidates = args.request.all === true
    ? scope
    : name ? scope.filter((row) => row.name === name) : [];

  // Two peers sharing a name across projects: refusing beats stopping the wrong one.
  if (!args.request.all && name && !args.request.project && candidates.length > 1) {
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
    // A retired record is leftover bookkeeping, not a reason to leave a LIVE peer running.
    if (record.stoppedAt || record.exitedAt || record.failedAt) {
      return { name: row.name, project: row.project, signalPid: row.pid ?? null, reason: "peer" };
    }
    // Signal the supervisor only when its recorded child IS this peer.
    if (Number.isInteger(record.pid) && record.childPid === row.pid) {
      return { name: row.name, project: row.project, signalPid: record.pid as number, reason: "supervisor" };
    }
    return { name: row.name, project: row.project, signalPid: row.pid ?? null, reason: "peer" };
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

/** Validate a peer name and build the supervisor invocation.
 *
 *  Spawning a peer is a plain `node <supervisor> <name> …` call, which is exactly why a model could
 *  not discover it: no tool named it. The command is built here so it is testable, and the checks
 *  keep a name from becoming a shell/argv surprise in the supervisor. */
export function buildPeerSpawn(
  supervisorPath: string,
  args: { cname?: string | null; project?: string | null; cwd?: string | null; purpose?: string | null },
): { ok: true; command: string[] } | { ok: false; message: string } {
  const cname = (args.cname ?? "").trim();
  if (!cname) return { ok: false, message: "coms peer spawn: cname is required" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cname)) {
    return { ok: false, message: "coms peer spawn: cname must be 1-64 chars of letters, digits, dot, dash or underscore" };
  }
  if (!supervisorPath) return { ok: false, message: "coms peer spawn: supervisor script not found (is pi-orchestrator-config installed?)" };
  const command = ["node", supervisorPath, cname];
  const project = (args.project ?? "").trim();
  // A project namespace becomes a DIRECTORY NAME inside the coms root, so it is validated like a
  // filename: no separators, no `..`, nothing that could place registry files elsewhere.
  if (project) {
    // Only what could ESCAPE the coms root is refused. Spaces are legitimate: activation derives a
    // namespace from any real cwd, so `/work/My Projects` becomes `work__My Projects`.
    if (/[\/\\]/.test(project) || project.includes("..") || /[\x00-\x1f]/.test(project)) {
      return { ok: false, message: "coms peer spawn: project must not contain path separators, '..' or control characters" };
    }
    command.push("--project", project);
  }
  const cwd = (args.cwd ?? "").trim();
  if (cwd) command.push("--cwd", cwd);
  const purpose = (args.purpose ?? "").trim();
  if (purpose) command.push("--purpose", purpose);
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
): { name?: string; project?: string; all?: boolean; refused?: string } {
  if (request.all === true) {
    const project = (request.project ?? "").trim() || (ownProject ?? "").trim();
    // No scope means NO kill: falling open here stopped every project's peers.
    if (!project) {
      return { all: true, refused: "coms peer kill: cannot tell which project to scope all to — pass project explicitly" };
    }
    return { all: true, project };
  }
  const name = (request.name ?? "").trim();
  const project = (request.project ?? "").trim();
  return { name, project: project || undefined };
}

/** The `--all` / `--project` / default scope of `/coms list`. */
export function resolveListScope(parts: string[], ownProject: string): string | undefined {
  if (parts.includes("--all")) return undefined;
  const index = parts.indexOf("--project");
  const explicit = index >= 0 ? (parts[index + 1] ?? "").trim() : "";
  return explicit || ownProject || undefined;
}
