import type { SessionInfo } from "@/types";
import { createLogger } from "./create-logger.ts";
import { groupAndSortSessions, type SessionGroup } from "./group-sessions.ts";

const log = createLogger("pidash-ux");

export const PINNED_SESSIONS_STORAGE_KEY = "pidash-pinned-sessions";
export const ARCHIVED_SESSIONS_STORAGE_KEY = "pidash-archived-sessions";

function sessionSortLabel(session: Pick<SessionInfo, "sessionId" | "name" | "cwd" | "model">): string {
  const name = session.name?.trim();
  if (name) return name;
  const cwd = (session.cwd || "").replace(/\/+$/, "");
  const project = cwd.split("/").pop() || cwd;
  return project || session.model?.trim() || session.sessionId;
}

/** True when an active session is blocked on user input (ask_user / bridged prompt). */
export function isSessionWaitingForInput(
  session: Pick<SessionInfo, "sessionId" | "active" | "activity">,
  extraAttentionIds?: ReadonlySet<string>,
): boolean {
  if (!session.active) return false;
  return session.activity === "waiting_for_input" || Boolean(extraAttentionIds?.has(session.sessionId));
}

/** Format `document.title` for the active watched session (or `"pidash"` when none selected). */
export function formatDocumentTitle(
  session: Pick<SessionInfo, "sessionId" | "name" | "cwd" | "model" | "active" | "activity"> | null | undefined,
  hasPendingPrompt = false,
): string {
  if (!session) return "pidash";
  const label = session.name?.trim()
    || (session.cwd || "").replace(/\/+$/, "").split("/").pop()
    || session.cwd?.trim()
    || session.model?.trim()
    || "";
  if (!label) return "pidash";
  const waiting = Boolean(session.active && (session.activity === "waiting_for_input" || hasPendingPrompt));
  return `${waiting ? "[!] " : ""}${label} — pidash`;
}

export function loadSessionIdSet(key: string): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch (err) {
    log.debug("failed to load persisted session id set", { key, error: String(err) });
    return new Set();
  }
}

export function saveSessionIdSet(key: string, ids: ReadonlySet<string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch (err) {
    log.debug("failed to save persisted session id set", { key, error: String(err) });
  }
}

/** Toggle pin state; pinning an archived session also unarchives it. */
export function togglePinnedSession(
  pinned: ReadonlySet<string>,
  archived: ReadonlySet<string>,
  sessionId: string,
): { pinned: Set<string>; archived: Set<string>; isPinned: boolean } {
  const nextPinned = new Set(pinned);
  const nextArchived = new Set(archived);
  if (nextPinned.has(sessionId)) {
    nextPinned.delete(sessionId);
    return { pinned: nextPinned, archived: nextArchived, isPinned: false };
  }
  nextPinned.add(sessionId);
  nextArchived.delete(sessionId);
  return { pinned: nextPinned, archived: nextArchived, isPinned: true };
}

/** Toggle archive state; archiving a pinned session also unpins it. */
export function toggleArchivedSession(
  pinned: ReadonlySet<string>,
  archived: ReadonlySet<string>,
  sessionId: string,
): { pinned: Set<string>; archived: Set<string>; isArchived: boolean } {
  const nextPinned = new Set(pinned);
  const nextArchived = new Set(archived);
  if (nextArchived.has(sessionId)) {
    nextArchived.delete(sessionId);
    return { pinned: nextPinned, archived: nextArchived, isArchived: false };
  }
  nextArchived.add(sessionId);
  nextPinned.delete(sessionId);
  return { pinned: nextPinned, archived: nextArchived, isArchived: true };
}

/** Remove a session from the archived set (used when sending a message/command). */
export function unarchiveSessionId(
  archived: ReadonlySet<string>,
  sessionId: string,
): { archived: Set<string>; changed: boolean } {
  if (!archived.has(sessionId)) {
    return { archived: archived instanceof Set ? archived : new Set(archived), changed: false };
  }
  const next = new Set(archived);
  next.delete(sessionId);
  return { archived: next, changed: true };
}

export interface SidebarSessionPartitions {
  needsAttention: SessionInfo[];
  pinned: SessionInfo[];
  groups: SessionGroup[];
  archived: SessionInfo[];
}

/**
 * Partition sessions into sidebar buckets:
 * - `needsAttention`: active sessions waiting on user input (including archived ones).
 * - `pinned`: non-archived pinned sessions not already in `needsAttention`.
 * - `groups`: remaining non-archived sessions grouped by project directory.
 * - `archived`: all archived sessions (for the collapsible Archived footer section).
 */
export function partitionSidebarSessions(
  sessions: readonly SessionInfo[],
  opts: {
    pinnedIds: ReadonlySet<string>;
    archivedIds: ReadonlySet<string>;
    extraAttentionIds?: ReadonlySet<string>;
  },
): SidebarSessionPartitions {
  const needsAttention: SessionInfo[] = [];
  const attentionIds = new Set<string>();
  const archived: SessionInfo[] = [];

  for (const s of sessions) {
    if (isSessionWaitingForInput(s, opts.extraAttentionIds)) {
      needsAttention.push(s);
      attentionIds.add(s.sessionId);
    }
    if (opts.archivedIds.has(s.sessionId)) {
      archived.push(s);
    }
  }

  needsAttention.sort((a, b) => {
    const pinDiff = (opts.pinnedIds.has(b.sessionId) ? 1 : 0) - (opts.pinnedIds.has(a.sessionId) ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    return sessionSortLabel(a).localeCompare(sessionSortLabel(b));
  });

  archived.sort((a, b) => {
    const activeDiff = (b.active ? 1 : 0) - (a.active ? 1 : 0);
    if (activeDiff !== 0) return activeDiff;
    return sessionSortLabel(a).localeCompare(sessionSortLabel(b));
  });

  const pinned: SessionInfo[] = [];
  const regular: SessionInfo[] = [];

  for (const s of sessions) {
    if (opts.archivedIds.has(s.sessionId) || attentionIds.has(s.sessionId)) continue;
    if (opts.pinnedIds.has(s.sessionId)) {
      pinned.push(s);
    } else {
      regular.push(s);
    }
  }

  pinned.sort((a, b) => {
    const activeDiff = (b.active ? 1 : 0) - (a.active ? 1 : 0);
    if (activeDiff !== 0) return activeDiff;
    return sessionSortLabel(a).localeCompare(sessionSortLabel(b));
  });

  return {
    needsAttention,
    pinned,
    groups: groupAndSortSessions(regular),
    archived,
  };
}

/** Deduplicated flat list matching the sidebar visual order (for switcher & Ctrl+1..9). */
export function flattenSidebarSessions(partitions: SidebarSessionPartitions): SessionInfo[] {
  const seen = new Set<string>();
  const out: SessionInfo[] = [];
  const pushUnique = (list: readonly SessionInfo[]) => {
    for (const s of list) {
      if (seen.has(s.sessionId)) continue;
      seen.add(s.sessionId);
      out.push(s);
    }
  };
  pushUnique(partitions.needsAttention);
  pushUnique(partitions.pinned);
  for (const g of partitions.groups) pushUnique(g.sessions);
  pushUnique(partitions.archived);
  return out;
}

function isEditableElement(el: unknown): boolean {
  if (!el || typeof el !== "object") return false;
  const node = el as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  const tag = node.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (node.isContentEditable === true) return true;
  const ce = node.getAttribute?.("contenteditable");
  if (ce === "" || ce === "true" || ce === "plaintext-only") return true;
  if (typeof node.closest === "function" && node.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) {
    return true;
  }
  return false;
}

/** True when keyboard focus or event target is inside an editable field. */
export function isEditableTarget(target: EventTarget | null, activeElement?: unknown): boolean {
  return isEditableElement(target) || isEditableElement(activeElement);
}

/** Map unmodified `1`–`9` keypresses to a 0-based option index (or `null` if ineligible). */
export function resolvePromptOptionIndex(
  e: {
    key?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    defaultPrevented?: boolean;
  },
  optionCount: number,
): number | null {
  if (optionCount <= 0) return null;
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (!e.key || !/^[1-9]$/.test(e.key)) return null;
  const idx = Number(e.key) - 1;
  return idx < Math.min(optionCount, 9) ? idx : null;
}

/** Enter submits a multi-line custom answer; Shift+Enter inserts a newline. */
export function shouldSubmitMultilineAnswer(
  e: { key?: string; shiftKey?: boolean; isComposing?: boolean },
): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing;
}

/** True for bash/shell tool cards that expose a one-click Copy output button. */
export function isBashToolRole(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === "bash" || normalized === "shell";
}

/** Strip the synthetic leading status icon (`✓ ` / `✗ `) prepended by the transcript reducer. */
export function stripToolResultPrefix(text: string): string {
  return text.replace(/^[✓✗] /, "");
}
