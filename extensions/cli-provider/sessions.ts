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
import { createHash } from "node:crypto";
import type { CliSessionKey, CliSessionRecord } from "./types.js";

export type { CliSessionKey, CliSessionRecord } from "./types.js";

function sessionsDir(): string {
  return join(homedir(), ".pi", "cli-sessions");
}

function keyHash(key: CliSessionKey): string {
  const raw = [
    key.cwd,
    key.agent,
    key.model,
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

function writeRecord(key: CliSessionKey, record: CliSessionRecord): void {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile(key), JSON.stringify(record, null, 0), {
    mode: 0o600,
  });
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

export function saveCliSessionId(key: CliSessionKey, sessionId: string): void {
  if (!sessionId) return;
  const existing = readRecord(sessionFile(key));
  const ts = nowIso();
  writeRecord(key, {
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

/** Bump lastSeenAt after a successful turn (t3 lastSeenAt). */
export function touchCliSession(key: CliSessionKey): void {
  const existing = readRecord(sessionFile(key));
  if (!existing) return;
  writeRecord(key, {
    ...existing,
    status: "running",
    lastSeenAt: nowIso(),
  });
}

export function markCliSessionStopped(key: CliSessionKey): void {
  const existing = readRecord(sessionFile(key));
  if (!existing) return;
  writeRecord(key, {
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

/** List all persisted CLI session bindings (directory). */
export function listCliSessions(): ListedCliSession[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: ListedCliSession[] = [];
  for (const name of readdirSync(dir)) {
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
