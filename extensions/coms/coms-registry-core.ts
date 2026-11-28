/**
 * coms-registry-core.ts — Pure, zero-TUI types and helpers shared between
 * `coms-registry.ts`, `coms-peers.ts`, and standalone daemons (`scripts/pidash-server.ts`).
 *
 * MUST NOT import any TUI, overlay, or `@earendil-works/pi-*` runtime module so
 * standalone daemons launched via `jiti-cli.mjs` from npm-installed packages
 * never fail with missing `@earendil-works/pi-tui`.
 */

import type { PeerWorkloadCounts } from "./coms-workload.js";

export interface RegistryRow {
  /** Project namespace (the registry directory name). */
  project: string;
  name: string;
  pid: number | null;
  cwd: string;
  purpose: string;
  model?: string;
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
  containerId?: string | null;
  image?: string | null;
  sandbox?: string | null;
  session?: string | null;
  piSessionId?: string | null;
  createdBy?: string | null;
  /** PiDash sessionId of the parent LLM session that spawned this peer (#1527). */
  parentSessionId?: string | null;
  startedAt?: string;
  stoppedAt?: string;
  exitedAt?: string;
  failedAt?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  failure?: string;
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

/** The supervision record that belongs to THIS peer instance.
 *
 *  Records outlive the peer and accumulate per name+project, so "the first match" would label a new
 *  peer with an old creator. The live record whose child is this pid wins; otherwise the newest
 *  non-retired one; otherwise nothing — a retired record describes a peer that is gone. */
export function pickSupervisionRecord<
  T extends {
    cname?: string;
    project?: string;
    childPid?: number | null;
    startedAt?: string;
    stoppedAt?: string;
    exitedAt?: string;
    failedAt?: string;
  },
>(
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
