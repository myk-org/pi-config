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
