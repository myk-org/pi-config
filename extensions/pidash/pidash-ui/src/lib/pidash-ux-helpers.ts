import type { SessionInfo } from "@/types";
import { createLogger } from "./create-logger.ts";
import { groupAndSortSessions } from "./group-sessions.ts";

const log = createLogger("pidash-ux");

export const PINNED_SESSIONS_STORAGE_KEY = "pidash-pinned-sessions";
export const ARCHIVED_SESSIONS_STORAGE_KEY = "pidash-archived-sessions";
export const MAX_PERSISTED_SESSION_IDS = 200;

export interface SidebarFlags {
  pinned: Set<string>;
  archived: Set<string>;
}

function cwdBasename(cwd: string | undefined | null): string {
  const cleaned = (cwd ?? "").trim().replace(/[\\/]+$/, "");
  if (!cleaned) return "";
  return cleaned.split(/[\\/]/).pop() || cleaned;
}

/** Derive the default COMS project slug from a session's cwd (mirrors `ownProject()` in `coms-wrapper.ts`). */
export function deriveComsProjectFromCwd(cwd: string | undefined | null): string {
  const cleaned = (cwd ?? "").trim().replace(/[\\/]+$/, "");
  if (!cleaned) return "";
  return cleaned.replace(/^[\\/]+/, "").replace(/[\\/]+/g, "__");
}

/** True when a session's `comsProject` matches its own local folder (either full-path slug or basename). */
export function isSessionOwnComsProject(session: Pick<SessionInfo, "cwd" | "comsProject">): boolean {
  const comsProject = session.comsProject?.trim();
  if (!comsProject) return false;
  const derived = deriveComsProjectFromCwd(session.cwd);
  const base = cwdBasename(session.cwd);
  return comsProject === derived || comsProject === base;
}

function sessionSortLabel(
  session: Pick<SessionInfo, "sessionId" | "name" | "cwd" | "model" | "comsName" | "supervisedPeer">,
): string {
  if (session.supervisedPeer) {
    const label = sessionRowDisplayLabel(session);
    if (label && label !== "—") return label;
  }
  const name = session.name?.trim();
  if (name) return name;
  const project = cwdBasename(session.cwd);
  return project || session.model?.trim() || session.sessionId;
}

function normalizeLabelToken(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Primary sidebar row label for a session.
 * Prefers `comsName` whenever `preferComsName` is true OR `session.supervisedPeer` is true
 * (unless explicitly overridden with `preferComsName: false`) and the session title is empty
 * or merely repeats the model name (e.g. "Gemini 4 Neon"), so supervised peers remain
 * distinguishable across nested rows, Pinned, Archived, and cross-project Coms (#1481, #1527).
 */
export function sessionRowDisplayLabel(
  session: Pick<SessionInfo, "name" | "model" | "comsName" | "supervisedPeer">,
  opts: { preferComsName?: boolean } = {},
): string {
  const name = session.name?.trim() || "";
  const model = session.model?.trim() || "";
  const comsName = session.comsName?.trim() || "";
  const shouldPreferComsName = opts.preferComsName ?? Boolean(session.supervisedPeer);
  if (shouldPreferComsName && comsName) {
    if (!name || (model && normalizeLabelToken(name) === normalizeLabelToken(model))) {
      return comsName;
    }
  }
  return name || model || "—";
}

/** Keep at most the most recent `max` entries in insertion order. */
export function capSessionIdSet(ids: ReadonlySet<string>, max = MAX_PERSISTED_SESSION_IDS): Set<string> {
  if (max <= 0) return new Set();
  const list = [...ids];
  return new Set(list.length > max ? list.slice(-max) : list);
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

function readSessionIdSet(key: string, max = MAX_PERSISTED_SESSION_IDS): { ids: Set<string>; ok: boolean } {
  if (typeof localStorage === "undefined") return { ids: new Set(), ok: false };
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { ids: new Set(), ok: true };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log.warn("persisted session id set is not an array", { key });
      return { ids: new Set(), ok: false };
    }
    const valid = parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
    return { ids: capSessionIdSet(new Set(valid), max), ok: true };
  } catch (err) {
    log.warn("failed to load persisted session id set", { key, error: String(err) });
    return { ids: new Set(), ok: false };
  }
}

function writeSessionIdSet(
  key: string,
  ids: ReadonlySet<string>,
  max = MAX_PERSISTED_SESSION_IDS,
): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const capped = capSessionIdSet(ids, max);
    localStorage.setItem(key, JSON.stringify([...capped]));
    return true;
  } catch (err) {
    log.warn("failed to save persisted session id set", { key, error: String(err) });
    return false;
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function persistSidebarFlagsAtomic(base: SidebarFlags, next: SidebarFlags): boolean {
  const pinnedChanged = !setsEqual(base.pinned, next.pinned);
  const archivedChanged = !setsEqual(base.archived, next.archived);
  if (!pinnedChanged && !archivedChanged) return true;
  if (pinnedChanged && !writeSessionIdSet(PINNED_SESSIONS_STORAGE_KEY, next.pinned)) {
    return false;
  }
  if (archivedChanged && !writeSessionIdSet(ARCHIVED_SESSIONS_STORAGE_KEY, next.archived)) {
    if (pinnedChanged) {
      // Roll back the first write so storage is not left half-persisted.
      writeSessionIdSet(PINNED_SESSIONS_STORAGE_KEY, base.pinned);
    }
    return false;
  }
  return true;
}

export function loadSessionIdSet(key: string, max = MAX_PERSISTED_SESSION_IDS): Set<string> {
  return readSessionIdSet(key, max).ids;
}

export function saveSessionIdSet(
  key: string,
  ids: ReadonlySet<string>,
  max = MAX_PERSISTED_SESSION_IDS,
): boolean {
  return writeSessionIdSet(key, ids, max);
}

export function loadPersistedSidebarFlagsDetailed(): { flags: SidebarFlags; ok: boolean } {
  const pinned = readSessionIdSet(PINNED_SESSIONS_STORAGE_KEY);
  const archived = readSessionIdSet(ARCHIVED_SESSIONS_STORAGE_KEY);
  return {
    flags: { pinned: pinned.ids, archived: archived.ids },
    ok: pinned.ok && archived.ok,
  };
}

export function loadPersistedSidebarFlags(): SidebarFlags {
  return loadPersistedSidebarFlagsDetailed().flags;
}

/** Toggle pin state; pinning an archived session also unarchives it. */
export function togglePinnedSession(
  pinned: ReadonlySet<string>,
  archived: ReadonlySet<string>,
  sessionId: string,
  max = MAX_PERSISTED_SESSION_IDS,
): { pinned: Set<string>; archived: Set<string>; isPinned: boolean } {
  const nextPinned = new Set(pinned);
  const nextArchived = new Set(archived);
  if (nextPinned.has(sessionId)) {
    nextPinned.delete(sessionId);
    return { pinned: capSessionIdSet(nextPinned, max), archived: capSessionIdSet(nextArchived, max), isPinned: false };
  }
  nextPinned.delete(sessionId);
  nextPinned.add(sessionId);
  nextArchived.delete(sessionId);
  return { pinned: capSessionIdSet(nextPinned, max), archived: capSessionIdSet(nextArchived, max), isPinned: true };
}

/** Toggle archive state; archiving a pinned session also unpins it. */
export function toggleArchivedSession(
  pinned: ReadonlySet<string>,
  archived: ReadonlySet<string>,
  sessionId: string,
  max = MAX_PERSISTED_SESSION_IDS,
): { pinned: Set<string>; archived: Set<string>; isArchived: boolean } {
  const nextPinned = new Set(pinned);
  const nextArchived = new Set(archived);
  if (nextArchived.has(sessionId)) {
    nextArchived.delete(sessionId);
    return { pinned: capSessionIdSet(nextPinned, max), archived: capSessionIdSet(nextArchived, max), isArchived: false };
  }
  nextArchived.delete(sessionId);
  nextArchived.add(sessionId);
  nextPinned.delete(sessionId);
  return { pinned: capSessionIdSet(nextPinned, max), archived: capSessionIdSet(nextArchived, max), isArchived: true };
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

/** Read latest storage before toggling pin so concurrent tabs do not clobber each other. */
export function reconcileAndTogglePin(
  fallback: SidebarFlags,
  sessionId: string,
  useStorage = true,
): { pinned: Set<string>; archived: Set<string>; isPinned: boolean; persisted: boolean } {
  const loaded = useStorage ? loadPersistedSidebarFlagsDetailed() : { flags: fallback, ok: false };
  const base = loaded.ok ? loaded.flags : fallback;
  const next = togglePinnedSession(base.pinned, base.archived, sessionId);
  const persisted = useStorage && loaded.ok
    ? persistSidebarFlagsAtomic(base, { pinned: next.pinned, archived: next.archived })
    : false;
  return { ...next, persisted };
}

/** Read latest storage before toggling archive so concurrent tabs do not clobber each other. */
export function reconcileAndToggleArchive(
  fallback: SidebarFlags,
  sessionId: string,
  useStorage = true,
): { pinned: Set<string>; archived: Set<string>; isArchived: boolean; persisted: boolean } {
  const loaded = useStorage ? loadPersistedSidebarFlagsDetailed() : { flags: fallback, ok: false };
  const base = loaded.ok ? loaded.flags : fallback;
  const next = toggleArchivedSession(base.pinned, base.archived, sessionId);
  const persisted = useStorage && loaded.ok
    ? persistSidebarFlagsAtomic(base, { pinned: next.pinned, archived: next.archived })
    : false;
  return { ...next, persisted };
}

/** Read latest storage before auto-unarchiving on send; writes only if the session was archived. */
export function reconcileAndUnarchive(
  fallback: SidebarFlags,
  sessionId: string,
  useStorage = true,
): { pinned: Set<string>; archived: Set<string>; changed: boolean; persisted: boolean } {
  const loaded = useStorage ? loadPersistedSidebarFlagsDetailed() : { flags: fallback, ok: false };
  const base = loaded.ok ? loaded.flags : fallback;
  const { archived, changed } = unarchiveSessionId(base.archived, sessionId);
  const persisted = !changed
    ? loaded.ok
    : (useStorage && loaded.ok ? writeSessionIdSet(ARCHIVED_SESSIONS_STORAGE_KEY, archived) : false);
  return { pinned: base.pinned, archived, changed, persisted };
}

export interface SidebarSessionNode {
  session: SessionInfo;
  children: SessionInfo[];
}

export interface SidebarProjectGroup {
  name: string;
  cwd: string;
  /** Interactive sessions in this project folder, each with directly nested same-project supervised peers. */
  nodes: SidebarSessionNode[];
  /** Same-project supervised peers matched by `comsProject` when no spawning parent session is present. */
  projectPeers: SessionInfo[];
  /** Flat visual order of all sessions in this group (each parent followed by its children, then `projectPeers`). */
  sessions: SessionInfo[];
}

export interface SidebarComsGroup {
  project: string;
  sessions: SessionInfo[];
}

export interface SidebarSessionPartitions {
  pinned: SessionInfo[];
  groups: SidebarProjectGroup[];
  /** Strictly cross-project or unattached COMS peers (empty when all sessions belong to local projects). */
  coms: SidebarComsGroup[];
  archived: SessionInfo[];
}

function peerBelongsToParentProject(
  peer: Pick<SessionInfo, "comsProject">,
  parent: Pick<SessionInfo, "cwd" | "comsProject">,
): boolean {
  const peerProject = peer.comsProject?.trim();
  if (!peerProject) return true;
  if (peerProject === deriveComsProjectFromCwd(parent.cwd)) return true;
  if (peerProject === cwdBasename(parent.cwd)) return true;
  const parentComsProject = parent.comsProject?.trim();
  if (parentComsProject && peerProject === parentComsProject) return true;
  return false;
}

/**
 * Partition sessions into sidebar buckets without duplicating local peers or waiting-for-input sessions (#1527):
 * - `pinned`: non-archived pinned sessions.
 * - `groups`: local project folders containing interactive sessions, with same-project supervised peers
 *   nested directly under their spawning `parentSessionId` (or under the owning project folder via `comsProject`
 *   fallback when the parent is absent/restarted).
 * - `coms`: strictly cross-project or unattached peers (supervised peers whose `comsProject` matches no local
 *   project group, plus interactive sessions participating in a different COMS namespace than their local folder).
 * - `archived`: all archived sessions (for the collapsible Archived footer section).
 */
export function partitionSidebarSessions(
  sessions: readonly SessionInfo[],
  opts: {
    pinnedIds: ReadonlySet<string>;
    archivedIds: ReadonlySet<string>;
  },
): SidebarSessionPartitions {
  const pinned: SessionInfo[] = [];
  const regularInteractive: SessionInfo[] = [];
  const regularSupervised: SessionInfo[] = [];
  const archived: SessionInfo[] = [];

  for (const s of sessions) {
    if (opts.archivedIds.has(s.sessionId)) {
      archived.push(s);
    } else if (opts.pinnedIds.has(s.sessionId)) {
      pinned.push(s);
    } else if (s.supervisedPeer === true) {
      regularSupervised.push(s);
    } else {
      regularInteractive.push(s);
    }
  }

  const sortByActiveThenLabel = (a: SessionInfo, b: SessionInfo) => {
    const activeDiff = (b.active ? 1 : 0) - (a.active ? 1 : 0);
    if (activeDiff !== 0) return activeDiff;
    return sessionSortLabel(a).localeCompare(sessionSortLabel(b));
  };

  pinned.sort(sortByActiveThenLabel);
  archived.sort(sortByActiveThenLabel);

  const baseGroups = groupAndSortSessions(regularInteractive);
  const groups: SidebarProjectGroup[] = baseGroups.map((g) => ({
    name: g.name,
    cwd: g.cwd,
    nodes: g.sessions.map((s) => ({ session: s, children: [] })),
    projectPeers: [],
    sessions: [],
  }));

  // Index local interactive nodes and owning project groups for parent & comsProject matching.
  const nodeBySessionId = new Map<string, { group: SidebarProjectGroup; node: SidebarSessionNode }>();
  const groupByDerivedProject = new Map<string, SidebarProjectGroup>();
  const groupByName = new Map<string, SidebarProjectGroup>();
  const groupsByInteractiveComsProject = new Map<string, Set<SidebarProjectGroup>>();

  for (const group of groups) {
    if (!groupByName.has(group.name)) groupByName.set(group.name, group);
    for (const node of group.nodes) {
      nodeBySessionId.set(node.session.sessionId, { group, node });
      const derived = deriveComsProjectFromCwd(node.session.cwd);
      if (derived && !groupByDerivedProject.has(derived)) {
        groupByDerivedProject.set(derived, group);
      }
      const base = cwdBasename(node.session.cwd);
      if (base && !groupByName.has(base)) {
        groupByName.set(base, group);
      }
      const icp = node.session.comsProject?.trim();
      if (icp) {
        let set = groupsByInteractiveComsProject.get(icp);
        if (!set) {
          set = new Set();
          groupsByInteractiveComsProject.set(icp, set);
        }
        set.add(group);
      }
    }
  }

  const supervisedById = new Map<string, SessionInfo>();
  for (const peer of regularSupervised) {
    supervisedById.set(peer.sessionId, peer);
  }

  const resolveOwningInteractiveNode = (peer: SessionInfo): { group: SidebarProjectGroup; node: SidebarSessionNode } | null => {
    const visited = new Set<string>([peer.sessionId]);
    let parentId = peer.parentSessionId?.trim();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const direct = nodeBySessionId.get(parentId);
      if (direct) return direct;
      const parentPeer = supervisedById.get(parentId);
      parentId = parentPeer?.parentSessionId?.trim();
    }
    return null;
  };

  const resolveOwningProjectGroup = (comsProject: string | undefined): SidebarProjectGroup | null => {
    const project = comsProject?.trim();
    if (!project) return null;
    const byDerived = groupByDerivedProject.get(project);
    if (byDerived) return byDerived;
    const byName = groupByName.get(project);
    if (byName) return byName;
    const byInteractive = groupsByInteractiveComsProject.get(project);
    if (byInteractive && byInteractive.size === 1) {
      return byInteractive.values().next().value ?? null;
    }
    return null;
  };

  const comsMap = new Map<string, SessionInfo[]>();
  const addToComs = (projectKey: string, session: SessionInfo) => {
    const bucket = comsMap.get(projectKey) ?? [];
    bucket.push(session);
    comsMap.set(projectKey, bucket);
  };

  for (const peer of regularSupervised) {
    const parentMatch = resolveOwningInteractiveNode(peer);
    if (parentMatch && peerBelongsToParentProject(peer, parentMatch.node.session)) {
      parentMatch.node.children.push(peer);
      continue;
    }
    const projectMatch = resolveOwningProjectGroup(peer.comsProject);
    if (projectMatch) {
      projectMatch.projectPeers.push(peer);
      continue;
    }
    addToComs(peer.comsProject?.trim() || "unattached", peer);
  }

  for (const group of groups) {
    const flat: SessionInfo[] = [];
    for (const node of group.nodes) {
      node.children.sort(sortByActiveThenLabel);
      flat.push(node.session, ...node.children);
    }
    group.projectPeers.sort(sortByActiveThenLabel);
    flat.push(...group.projectPeers);
    group.sessions = flat;
  }

  // Re-sort project groups so a group with an active nested peer sorts with active groups.
  groups.sort((a, b) => {
    const aActive = a.sessions.some((s) => s.active);
    const bActive = b.sessions.some((s) => s.active);
    if (aActive !== bActive) return bActive ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  // Include non-pinned, non-archived interactive sessions only when genuinely cross-project.
  for (const s of regularInteractive) {
    const comsProject = s.comsProject?.trim();
    if (!comsProject) continue;
    if (isSessionOwnComsProject(s)) continue;
    addToComs(comsProject, s);
  }

  const coms: SidebarComsGroup[] = [...comsMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, list]) => {
      list.sort(sortByActiveThenLabel);
      return { project, sessions: list };
    });

  return {
    pinned,
    groups,
    coms,
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
  pushUnique(partitions.pinned);
  for (const g of partitions.groups) pushUnique(g.sessions);
  for (const c of partitions.coms) pushUnique(c.sessions);
  pushUnique(partitions.archived);
  return out;
}

/** Pause document-level prompt number hotkeys when a modal or mobile overlay covers the chat. */
export function shouldPausePromptHotkeys(opts: {
  showSwitcher: boolean;
  showSettings: boolean;
  showNewSession: boolean;
  hasActivePanel: boolean;
  sidebarOpen: boolean;
  isMobileViewport: boolean;
}): boolean {
  if (opts.showSwitcher || opts.showSettings || opts.showNewSession) return true;
  if (opts.isMobileViewport && (opts.hasActivePanel || opts.sidebarOpen)) return true;
  return false;
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

/** Map unmodified non-repeating `1`–`9` keypresses to a 0-based option index (or `null` if ineligible). */
export function resolvePromptOptionIndex(
  e: {
    key?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    repeat?: boolean;
    defaultPrevented?: boolean;
  },
  optionCount: number,
): number | null {
  if (optionCount <= 0) return null;
  if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (!e.key || !/^[1-9]$/.test(e.key)) return null;
  const idx = Number(e.key) - 1;
  return idx < Math.min(optionCount, 9) ? idx : null;
}

/** Enter submits a multi-line custom answer; Shift+Enter inserts a newline and IME composition is ignored. */
export function shouldSubmitMultilineAnswer(
  e: { key?: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number },
): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
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

export { formatToolCallSummary } from "../../../../shared/pidash-transcript-reducer.ts";

/**
 * Resolve which prompt message owns global 1-9 hotkeys:
 * inspects only the newest unanswered prompt in the unfiltered transcript
 * (excluding locally answered IDs) and enables hotkeys only when that same
 * prompt is a visible `select` card.
 */
export function findActiveSelectHotkeyId(
  messages: ReadonlyArray<{ id: string; className?: string }>,
  visibleIds: ReadonlySet<string>,
  locallyAnsweredIds: ReadonlySet<string>,
  paused: boolean,
): string | null {
  if (paused) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.className?.startsWith("ask|")) continue;
    if (locallyAnsweredIds.has(msg.id)) continue;
    if (!visibleIds.has(msg.id)) return null;
    const method = msg.className.split("|")[2] || "select";
    return method === "select" ? msg.id : null;
  }
  return null;
}
