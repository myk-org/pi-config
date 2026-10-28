/**
 * Persistent per-user Discord state.
 *
 * The old file had no version, was written non-atomically, grew without bound,
 * and persisted `pendingAskUser` — which meant a prompt left unanswered survived
 * a restart and silently ate the user's next DM hours later. Pending prompts are
 * deliberately NOT persisted here: they belong to a live agent turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../logger.ts";

const log = createLogger("chat-state");

export const STATE_VERSION = 2;
/** Users with no activity for this long are pruned from the state file. */
export const STALE_USER_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_STATE_USERS = 200;

/** Exactly what is allowed on disk — anything else is dropped on load. */
export interface DiscordUserState {
  watchedSessionId: string | null;
  responseChannelId: string | null;
  /** Thread created for the watched session, when threads are in use. */
  threadId?: string | null;
  /**
   * sessionId -> threadId, so switching back to a session reuses its thread
   * instead of creating a second one and losing the history (Qodo f649327c).
   */
  threads?: Record<string, string>;
  /**
   * sessionId -> the last prompt sent for it, so a 🔁 reaction can resend it
   * without the user retyping (Discord reaction shortcut).
   *
   * The flags matter: a truncated prompt or one that carried images cannot be
   * replayed faithfully, and pretending otherwise sends a different request.
   */
  lastPrompts?: Record<string, LastPromptEntry>;
  /** Last interaction, used for pruning. */
  updatedAt: number;
}

/** A remembered prompt is for retrying, not for storage: keep it small. */
export const MAX_LAST_PROMPT_CHARS = 4000;

export interface LastPromptEntry {
  text: string;
  /** The original prompt carried images, which a retry cannot resend. */
  hadImages: boolean;
  /** The stored text is shorter than the original: a retry would differ. */
  truncated: boolean;
}

/** Threads remembered per user; older ones are dropped. */
export const MAX_THREADS_PER_USER = 20;

export interface PersistedDiscordState {
  version: number;
  users: Record<string, DiscordUserState>;
}

export function emptyState(): PersistedDiscordState {
  return { version: STATE_VERSION, users: {} };
}

function coerceUser(raw: unknown): DiscordUserState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const watched = typeof value.watchedSessionId === "string" ? value.watchedSessionId : null;
  const channel = typeof value.responseChannelId === "string" ? value.responseChannelId : null;
  const thread = typeof value.threadId === "string" ? value.threadId : null;
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
    ? value.updatedAt
    : 0;
  const threads: Record<string, string> = {};
  if (value.threads && typeof value.threads === "object") {
    for (const [sessionId, threadId] of Object.entries(value.threads as Record<string, unknown>)) {
      if (typeof threadId === "string" && threadId) threads[sessionId] = threadId;
    }
  }
  // A user with no binding at all carries no information.
  if (!watched && !channel) return null;
  const lastPrompts: Record<string, LastPromptEntry> = {};
  if (value.lastPrompts && typeof value.lastPrompts === "object") {
    for (const [sessionId, raw] of Object.entries(value.lastPrompts as Record<string, unknown>)) {
      // A bare string is the older shape: keep it working, flags default false.
      if (typeof raw === "string" && raw) {
        lastPrompts[sessionId] = { text: raw.slice(0, MAX_LAST_PROMPT_CHARS), hadImages: false, truncated: raw.length > MAX_LAST_PROMPT_CHARS };
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.text !== "string" || !entry.text) continue;
      lastPrompts[sessionId] = {
        text: entry.text.slice(0, MAX_LAST_PROMPT_CHARS),
        hadImages: entry.hadImages === true,
        truncated: entry.truncated === true || entry.text.length > MAX_LAST_PROMPT_CHARS,
      };
    }
  }
  return { watchedSessionId: watched, responseChannelId: channel, threadId: thread, threads, lastPrompts, updatedAt };
}

/**
 * Read any historical shape and return a current one.
 *
 * v1 was the bare per-user map with `pendingAskUser` in it; that field is
 * dropped here, which is what stops a stale prompt from surviving a restart.
 */
export function migrateState(raw: unknown, now: number = Date.now()): PersistedDiscordState {
  if (!raw || typeof raw !== "object") return emptyState();
  const record = raw as Record<string, unknown>;
  const usersSource = (record.users && typeof record.users === "object"
    ? record.users
    : // v1: the whole object was the user map
      record) as Record<string, unknown>;

  const users: Record<string, DiscordUserState> = {};
  for (const [userId, value] of Object.entries(usersSource)) {
    if (userId === "version" || userId === "users") continue;
    const coerced = coerceUser(value);
    if (!coerced) continue;
    users[userId] = coerced.updatedAt ? coerced : { ...coerced, updatedAt: now };
  }
  const migrated: PersistedDiscordState = { version: STATE_VERSION, users };
  if (record.version !== STATE_VERSION) {
    log.info("migrated discord state", { from: record.version ?? 1, to: STATE_VERSION, users: Object.keys(users).length });
  }
  return migrated;
}

/** Drop stale users and cap the map, keeping the most recently active. */
export function pruneState(
  state: PersistedDiscordState,
  now: number = Date.now(),
  options: { staleMs?: number; maxUsers?: number } = {},
): PersistedDiscordState {
  const staleMs = options.staleMs ?? STALE_USER_MS;
  const maxUsers = options.maxUsers ?? MAX_STATE_USERS;
  const entries = Object.entries(state.users)
    .filter(([, user]) => now - (user.updatedAt || 0) <= staleMs)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, maxUsers);
  const pruned = Object.fromEntries(entries);
  const removed = Object.keys(state.users).length - entries.length;
  if (removed > 0) log.debug("pruned discord users", { removed, kept: entries.length });
  return { version: STATE_VERSION, users: pruned };
}

/** Read + migrate + prune. Missing/corrupt file is an empty state, never a throw. */
export function readState(filePath: string, now: number = Date.now()): PersistedDiscordState {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return pruneState(migrateState(raw, now), now);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log.warn("discord state unreadable, starting empty", { error: String(error) });
    return emptyState();
  }
}

/** Write atomically (tmp + rename) with 0600 — this file holds user ids. */
export function writeState(filePath: string, state: PersistedDiscordState): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(pruneState(state)), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    log.warn("discord state write failed", { error: String(error) });
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** Best-effort 0600 on a file that may already exist (e.g. discord.env). */
export function hardenFilePermissions(filePath: string): void {
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode !== 0o600) {
      fs.chmodSync(filePath, 0o600);
      log.info("tightened file permissions", { file: path.basename(filePath), from: mode.toString(8) });
    }
  } catch {
    // Missing file is fine; it will be created with the right mode.
  }
}
