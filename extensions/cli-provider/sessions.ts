/**
 * CLI session directory — persist resume ids with lastSeen / status.
 * Pattern aligned with t3code ProviderSessionDirectory (lighter, file-backed).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { CliSessionKey, CliSessionRecord } from "./types.js";

export type { CliSessionKey, CliSessionRecord } from "./types.js";

/** Prefix for per-process ids used before the real pi session UUID is known. */
export const PROVISIONAL_PI_SESSION_PREFIX = "tmp-";

/** Unique per process/extension load — never shared across concurrent pi sessions. */
export function createProvisionalPiSessionId(): string {
  return `${PROVISIONAL_PI_SESSION_PREFIX}${randomUUID()}`;
}

export function isProvisionalPiSessionId(
  id: string | null | undefined,
): boolean {
  return typeof id === "string" && id.startsWith(PROVISIONAL_PI_SESSION_PREFIX);
}
function sessionsDir(): string {
  return join(homedir(), ".pi", "cli-sessions");
}

function keyHash(key: CliSessionKey): string {
  const raw = [
    key.cwd,
    key.agent,
    key.model,
    // Never coalesce unbound keys to a shared "default" here — callers must
    // pass a real UUID or per-process provisional id (tmp-…).
    key.piSessionId || "default",
  ].join("\0");
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function sessionFile(key: CliSessionKey): string {
  return join(sessionsDir(), `${keyHash(key)}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function readRecord(path: string): CliSessionRecord | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof data?.sessionId !== "string" || !data.sessionId) return null;
    return {
      sessionId: data.sessionId,
      agent: typeof data.agent === "string" ? data.agent : "",
      model: typeof data.model === "string" ? data.model : "",
      cwd: typeof data.cwd === "string" ? data.cwd : "",
      piSessionId:
        typeof data.piSessionId === "string" ? data.piSessionId : "default",
      status: data.status === "stopped" ? "stopped" : "running",
      createdAt:
        typeof data.createdAt === "string" ? data.createdAt : nowIso(),
      lastSeenAt:
        typeof data.lastSeenAt === "string"
          ? data.lastSeenAt
          : typeof data.updatedAt === "string"
            ? data.updatedAt
            : nowIso(),
      resumeFailures:
        typeof data.resumeFailures === "number" ? data.resumeFailures : 0,
    };
  } catch {
    return null;
  }
}

/** Best-effort marker write. FS errors (e.g. cli-sessions is a file) → false. */
function writeRecord(key: CliSessionKey, record: CliSessionRecord): boolean {
  try {
    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile(key), JSON.stringify(record, null, 0), {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

export function loadCliSessionId(key: CliSessionKey): string | null {
  const record = readRecord(sessionFile(key));
  if (!record || record.status === "stopped") return null;
  return record.sessionId;
}

export function loadCliSessionRecord(
  key: CliSessionKey,
): CliSessionRecord | null {
  return readRecord(sessionFile(key));
}

/** Persist a running marker. Best-effort — returns false on FS errors. */
export function saveCliSessionId(key: CliSessionKey, sessionId: string): boolean {
  if (!sessionId) return false;
  const existing = readRecord(sessionFile(key));
  const ts = nowIso();
  return writeRecord(key, {
    sessionId,
    agent: key.agent,
    model: key.model,
    cwd: key.cwd,
    piSessionId: key.piSessionId || "default",
    status: "running",
    createdAt: existing?.createdAt || ts,
    lastSeenAt: ts,
    resumeFailures: 0,
  });
}

/** Bump lastSeenAt after a successful turn (t3 lastSeenAt). Best-effort. */
export function touchCliSession(key: CliSessionKey): boolean {
  const existing = readRecord(sessionFile(key));
  if (!existing) return false;
  return writeRecord(key, {
    ...existing,
    status: "running",
    lastSeenAt: nowIso(),
  });
}

/**
 * Update status / lastSeenAt on an existing marker without touching sessionId.
 * Used by tests (and callers) that need idle/running fixtures without rewriting
 * marker files by path.
 */
export function setCliSessionMarkerMeta(
  key: CliSessionKey,
  opts: {
    status?: "running" | "stopped";
    /** Absolute ISO timestamp, or milliseconds ago from now when `idleMs` set. */
    lastSeenAt?: string;
    idleMs?: number;
  },
): boolean {
  const existing = readRecord(sessionFile(key));
  if (!existing) return false;
  let lastSeenAt = opts.lastSeenAt ?? existing.lastSeenAt;
  if (typeof opts.idleMs === "number") {
    lastSeenAt = new Date(Date.now() - opts.idleMs).toISOString();
  }
  return writeRecord(key, {
    ...existing,
    status: opts.status ?? existing.status,
    lastSeenAt,
  });
}

export function markCliSessionStopped(key: CliSessionKey): boolean {
  const existing = readRecord(sessionFile(key));
  if (!existing) return false;
  return writeRecord(key, {
    ...existing,
    status: "stopped",
    lastSeenAt: nowIso(),
  });
}

export function clearCliSessionId(key: CliSessionKey): void {
  const path = sessionFile(key);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

/**
 * Prefer source when dest is missing/invalid or source lastSeenAt is >= dest.
 * Tie / newer source wins so a pre-bind first-turn provisional is not discarded
 * in favor of an older real-sid marker.
 */
export function preferCliSessionRecord(
  source: CliSessionRecord,
  dest: CliSessionRecord | null,
): "source" | "dest" {
  if (!dest) return "source";
  const s = Date.parse(source.lastSeenAt);
  const d = Date.parse(dest.lastSeenAt);
  if (Number.isNaN(d)) return "source";
  if (Number.isNaN(s)) return "dest";
  return s >= d ? "source" : "dest";
}

/**
 * Move a CLI resume marker from one piSessionId bucket onto `toKey`.
 * Used when this process binds a real UUID after writing under provisional/tmp
 * (or legacy `default`). On conflict, keeps the newer marker by lastSeenAt
 * (provisional first-turn must not lose to a stale real-sid marker).
 */
export function migrateCliSessionMarker(
  toKey: CliSessionKey,
  fromPiSessionId: string,
): boolean {
  if (!toKey.piSessionId || toKey.piSessionId === "" || !fromPiSessionId) {
    return false;
  }
  if (toKey.piSessionId === fromPiSessionId) return false;
  const fromKey: CliSessionKey = { ...toKey, piSessionId: fromPiSessionId };
  const fromRec = loadCliSessionRecord(fromKey);
  if (!fromRec) return false;
  const toRec = loadCliSessionRecord(toKey);
  if (preferCliSessionRecord(fromRec, toRec) === "source") {
    const ok = saveCliSessionId(toKey, fromRec.sessionId);
    if (!ok) return false;
    clearCliSessionId(fromKey);
    return true;
  }
  // Destination is newer — drop stale provisional/source only.
  clearCliSessionId(fromKey);
  return false;
}

/**
 * Migrate every marker for `fromPiSessionId` in `cwd` onto `toPiSessionId`.
 * On conflict, prefer the newer lastSeenAt (keeps pre-bind first-turn session).
 */
export function migrateAllCliSessionMarkers(
  cwd: string,
  fromPiSessionId: string,
  toPiSessionId: string,
): number {
  if (
    !fromPiSessionId ||
    !toPiSessionId ||
    fromPiSessionId === toPiSessionId
  ) {
    return 0;
  }
  let n = 0;
  for (const { path, record } of listCliSessions()) {
    if (record.cwd !== cwd) continue;
    if (record.piSessionId !== fromPiSessionId) continue;
    const toKey: CliSessionKey = {
      cwd: record.cwd,
      agent: record.agent,
      model: record.model,
      piSessionId: toPiSessionId,
    };
    const toRec = loadCliSessionRecord(toKey);
    if (preferCliSessionRecord(record, toRec) === "source") {
      const ok = saveCliSessionId(toKey, record.sessionId);
      if (!ok) continue;
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
      n += 1;
    } else {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  }
  return n;
}

/**
 * If a real piSessionId key has no marker but the legacy `default` bucket does,
 * move the CLI resume id onto the real key (avoids mid-session fork when
 * activePiSessionId becomes available after the first turn).
 * @deprecated Prefer migrateCliSessionMarker / migrateAllCliSessionMarkers.
 */
export function adoptLegacyCliSessionMarker(key: CliSessionKey): boolean {
  return migrateCliSessionMarker(key, "default");
}

/**
 * Only migrate when *this process* previously keyed under provisional/tmp or
 * legacy default. Never adopt a stale on-disk default from another session.
 */
export function shouldAdoptLegacyCliMarker(
  prevKey: CliSessionKey | null | undefined,
  nextKey: CliSessionKey,
): boolean {
  if (!nextKey.piSessionId || nextKey.piSessionId === "default") return false;
  if (isProvisionalPiSessionId(nextKey.piSessionId)) return false;
  if (!prevKey?.piSessionId) return false;
  const prev = prevKey.piSessionId;
  return prev === "default" || isProvisionalPiSessionId(prev);
}

export function incrementResumeFailure(key: CliSessionKey): number {
  const existing = readRecord(sessionFile(key));
  if (!existing) return 1;
  const n = (existing.resumeFailures || 0) + 1;
  writeRecord(key, { ...existing, resumeFailures: n, lastSeenAt: nowIso() });
  return n;
}

export interface ListedCliSession {
  keyHash: string;
  path: string;
  record: CliSessionRecord;
}

/** List all persisted CLI session bindings (directory). Best-effort: FS errors → []. */
export function listCliSessions(): ListedCliSession[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: ListedCliSession[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const record = readRecord(path);
    if (!record) continue;
    out.push({ keyHash: name.replace(/\.json$/, ""), path, record });
  }
  return out;
}

/**
 * True when stderr/message indicates a dead/invalid resume id.
 * Used to clear the marker and retry without --resume.
 */
export function isCliResumeFailure(message: string): boolean {
  const s = message.toLowerCase();
  return (
    /session.*(not found|expired|invalid|unknown|missing)/i.test(s) ||
    /unknown session/i.test(s) ||
    /no such session/i.test(s) ||
    /cannot resume/i.test(s) ||
    /failed to (load|resume|restore)/i.test(s) ||
    /resume.*(fail|error|invalid)/i.test(s) ||
    /invalid session (id|uuid)/i.test(s)
  );
}

/** Exit codes that mean abort/kill — not a dead resume id (issue #661). */
const ABORT_EXIT_RE = /exited (130|137|143)\b/i;

/**
 * Whether a failed turn that used --resume should clear the marker and retry.
 * Explicit resume errors and empty non-zero exits (dead ids) retry.
 * SIGINT(130) / SIGKILL(137) / SIGTERM(143) keep the marker — abort ≠ invalid id.
 */
export function shouldRetryWithoutResume(message: string): boolean {
  if (isCliResumeFailure(message)) return true;
  if (ABORT_EXIT_RE.test(message)) return false;
  if (/\b(aborted|sigterm|sigint|sigkill|cancelled|canceled)\b/i.test(message)) {
    return false;
  }
  return /exited [1-9]\d*(?::\s*(?:no output)?\s*)?$/i.test(message.trim());
}

/**
 * Decide whether this turn must seed pi history into a fresh CLI session.
 */
export function resolveCliHistorySeed(opts: {
  hasCliSession: boolean;
  forceHistorySeed: boolean;
}): { useCliSession: boolean; seedHistory: boolean } {
  if (opts.forceHistorySeed) {
    return { useCliSession: false, seedHistory: true };
  }
  return {
    useCliSession: opts.hasCliSession,
    seedHistory: !opts.hasCliSession,
  };
}

/**
 * Prepend the once-per-CLI-session system prompt when starting a fresh chat
 * (first turn or retry after failed --resume).
 */
export function applySystemPromptToCliPrompt(
  prompt: string,
  systemPrompt?: string,
): string {
  if (!systemPrompt) return prompt;
  return `${systemPrompt}\n\n---\n\n${prompt}`;
}

/**
 * Decide CLI marker / history-seed action on pi `session_start` (issue #661).
 * - reload → keep markers (CLI `--resume` continues)
 * - resume / new / pi session id change → clear this session's markers + force re-seed
 * - otherwise → bind id only
 */
export function decideCliSessionStartReseed(opts: {
  reason: string;
  prevPiSessionId: string | null;
  nextPiSessionId: string | null;
}): {
  action: "keep" | "reseed" | "bind-only";
  forceHistorySeed: boolean;
} {
  if (opts.reason === "reload") {
    return { action: "keep", forceHistorySeed: false };
  }
  const mustReseed =
    opts.reason === "resume" ||
    opts.reason === "new" ||
    (Boolean(opts.prevPiSessionId) &&
      Boolean(opts.nextPiSessionId) &&
      opts.prevPiSessionId !== opts.nextPiSessionId);
  if (mustReseed) {
    return { action: "reseed", forceHistorySeed: true };
  }
  return { action: "bind-only", forceHistorySeed: false };
}

/**
 * Resolve active pi session id on `session_start`.
 * Unknown (no getter) must not null a previously bound UUID — that would flip
 * marker keys back to the provisional tmp-* bucket and break `--resume`.
 * Known empty from the getter still clears the binding (stale UUID avoid).
 */
export function resolveActivePiSessionIdOnSessionStart(opts: {
  prevPiSessionId: string | null;
  hasSessionIdGetter: boolean;
  readPiSessionId: string | null;
}): {
  nextActivePiSessionId: string | null;
  /** Sid for reseed decision / migrate / cleanup (prev when unknown). */
  resolvedReadSid: string | null;
  sidKnown: boolean;
} {
  if (!opts.hasSessionIdGetter) {
    return {
      nextActivePiSessionId: opts.prevPiSessionId,
      resolvedReadSid: opts.prevPiSessionId,
      sidKnown: false,
    };
  }
  return {
    nextActivePiSessionId: opts.readPiSessionId,
    resolvedReadSid: opts.readPiSessionId,
    sidKnown: true,
  };
}

/**
 * Read pi session id from sessionManager.
 * MUST call getSessionId on the manager object (not as an unbound method) —
 * pi's impl reads `this.sessionId` and throws if `this` is lost (#664).
 * Throws → treat as unknown (hasGetter false) and set readError for logging.
 */
export function readPiSessionIdFromManager(sessionManager?: {
  getSessionId?: () => string;
}): {
  hasGetter: boolean;
  readPiSessionId: string | null;
  /** True when getSessionId existed but threw — callers should log. */
  readError: boolean;
} {
  if (typeof sessionManager?.getSessionId !== "function") {
    return { hasGetter: false, readPiSessionId: null, readError: false };
  }
  try {
    return {
      hasGetter: true,
      readPiSessionId: sessionManager.getSessionId() || null,
      readError: false,
    };
  } catch {
    return { hasGetter: false, readPiSessionId: null, readError: true };
  }
}

/**
 * Unlink CLI session markers for a cwd scoped to a pi session id.
 * By default also clears legacy `default` markers for that cwd (migration).
 * Does not touch other concurrent pi sessions sharing the same project.
 */
export function clearCliSessionsForPiSession(
  cwd: string,
  piSessionId: string | null,
  opts?: { includeLegacyDefault?: boolean },
): number {
  const includeLegacy = opts?.includeLegacyDefault ?? true;
  const matchIds = new Set<string>();
  if (piSessionId && piSessionId !== "") matchIds.add(piSessionId);
  if (includeLegacy) matchIds.add("default");
  if (matchIds.size === 0) return 0;

  let n = 0;
  for (const { path, record } of listCliSessions()) {
    if (record.cwd !== cwd) continue;
    if (!matchIds.has(record.piSessionId)) continue;
    try {
      unlinkSync(path);
      n += 1;
    } catch {
      /* ignore */
    }
  }
  return n;
}

/** @deprecated Prefer clearCliSessionsForPiSession — cwd-wide wipe hurts concurrent sessions. */
export function clearCliSessionsForCwd(cwd: string): number {
  let n = 0;
  for (const { path, record } of listCliSessions()) {
    if (record.cwd !== cwd) continue;
    try {
      unlinkSync(path);
      n += 1;
    } catch {
      /* ignore */
    }
  }
  return n;
}
