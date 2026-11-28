import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createLogger } from "./create-logger.ts";
import { useWebSocket } from "../hooks/useWebSocket.ts";
import type {
  DiffData,
  DiffMode,
  FileDiffData,
  GitCommit,
  OpenCommentForm,
  PiSession,
  ReviewComment,
  Worktree,
} from "../types.ts";

const log = createLogger("pidiff-ui");

const SESSION_STORAGE_KEY = "pidiff-session";
const COMMENTS_STORAGE_KEY = "pidiff-comments";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type RequestDiffsMessage = {
  type: "request-diffs";
  mode: DiffMode;
  fromRef?: string;
  toRef?: string;
};

export interface RefreshButtonState {
  disabled: boolean;
  spinning: boolean;
  unmountBody: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DiffSessionState {
  connected: boolean;
  sessions: PiSession[];
  activeSession: PiSession | null;
  activeWorktree: Worktree | null;
  diffData: DiffData;
  mode: DiffMode;
  loading: boolean;
  refreshing: boolean;
  commits: GitCommit[] | null;
  commitFrom: string;
  commitTo: string;
  stale: boolean;
  staleWorktrees: ReadonlySet<string>;
  comments: ReviewComment[];
  openForms: OpenCommentForm[];
  refreshButton: RefreshButtonState;
}

export interface DeepLinkParams {
  session?: string;
  worktree?: string;
  branch?: string;
}

export interface DeepLinkResolution {
  session: PiSession;
  worktree: Worktree | null;
}

export interface DiffSessionControllerOptions {
  send: (msg: object) => boolean;
  storage?: StorageLike;
  initialStale?: boolean;
  timeoutMs?: number;
  locationSearch?: string;
}

export interface DiffSessionController {
  getState: () => DiffSessionState;
  subscribe: (listener: () => void) => () => void;
  setConnected: (connected: boolean) => void;
  handleMessage: (ev: any) => void;
  switchSession: (session: PiSession) => void;
  switchWorktree: (worktree: Worktree) => void;
  switchMode: (mode: DiffMode) => void;
  setCommitFrom: (hash: string) => void;
  setCommitTo: (hash: string) => void;
  compareCommits: () => boolean;
  refresh: () => boolean;
  addCommentForm: (file: string, side: "deletions" | "additions", lineNumber: number) => void;
  submitComment: (file: string, side: "deletions" | "additions", lineNumber: number, body: string) => void;
  cancelCommentForm: (file: string, side: "deletions" | "additions", lineNumber: number) => void;
  editComment: (index: number) => void;
  deleteComment: (index: number) => void;
  resolveComment: (index: number) => void;
  replyToComment: (index: number, body: string) => void;
  publishReview: () => boolean;
  dispose: () => void;
}

/** Build the canonical WebSocket payload for every `request-diffs` send. */
export function buildRequestDiffsMessage(
  mode: DiffMode,
  commitFrom: string,
  commitTo: string,
): RequestDiffsMessage {
  if (mode === "commits" && commitFrom && commitTo) {
    const msg: RequestDiffsMessage = {
      type: "request-diffs",
      mode,
      fromRef: commitFrom,
      toRef: commitTo,
    };
    log.debug("request-diffs", { mode, fromRef: commitFrom, toRef: commitTo });
    return msg;
  }
  const msg: RequestDiffsMessage = { type: "request-diffs", mode };
  log.debug("request-diffs", { mode });
  return msg;
}

/** Derive Refresh button UI state; in-place refresh keeps the diff body mounted. */
export function getRefreshButtonState(
  refreshing: boolean,
  connected = true,
): RefreshButtonState {
  const disabled = refreshing || !connected;
  return { disabled, spinning: refreshing && connected, unmountBody: false };
}

function normalizePath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** Parse optional `?session=...&worktree=...&branch=...` deep-link query params. */
export function parseDeepLinkParams(search?: string): DeepLinkParams | null {
  if (!search) return null;
  try {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const session = params.get("session")?.trim() || undefined;
    const worktree = params.get("worktree")?.trim() || undefined;
    const branch = params.get("branch")?.trim() || undefined;
    if (!session && !worktree && !branch) return null;
    return { session, worktree, branch };
  } catch (err) {
    log.warn("failed to parse deep-link query params", { error: String(err) });
    return null;
  }
}

/**
 * Resolve a deep-link request against available pidiff sessions.
 * Priority: exact `sessionId` → session `cwd` matching `worktree` → session containing
 * a linked worktree matching `worktree` → session `branch` matching `branch` →
 * session containing a worktree matching `branch`.
 */
export function resolveDeepLinkTarget(
  sessions: readonly PiSession[],
  deepLink: DeepLinkParams | null,
): DeepLinkResolution | null {
  if (!deepLink || sessions.length === 0) return null;
  const normWorktree = deepLink.worktree ? normalizePath(deepLink.worktree) : "";
  const branch = deepLink.branch || "";

  let session: PiSession | undefined;
  if (deepLink.session) {
    session = sessions.find((s) => s.sessionId === deepLink.session);
  }
  if (!session && normWorktree) {
    session = sessions.find((s) => normalizePath(s.cwd) === normWorktree);
  }
  if (!session && normWorktree) {
    session = sessions.find((s) =>
      s.worktrees?.some((w) => normalizePath(w.path) === normWorktree),
    );
  }
  if (!session && branch) {
    session = sessions.find((s) => s.branch === branch);
  }
  if (!session && branch) {
    session = sessions.find((s) => s.worktrees?.some((w) => w.branch === branch));
  }
  if (!session) return null;

  let worktree: Worktree | null = null;
  if (session.worktrees?.length) {
    if (normWorktree) {
      worktree = session.worktrees.find((w) => normalizePath(w.path) === normWorktree) ?? null;
    }
    if (!worktree && branch) {
      worktree = session.worktrees.find((w) => w.branch === branch) ?? null;
    }
  }
  return { session, worktree };
}

function readStoredSession(storage: StorageLike | undefined): PiSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") {
      return parsed as PiSession;
    }
  } catch (err) {
    log.warn("failed to read stored session", { error: String(err) });
  }
  return null;
}

function writeStoredSession(storage: StorageLike | undefined, session: PiSession | null): void {
  if (!storage) return;
  try {
    if (session) storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else storage.removeItem(SESSION_STORAGE_KEY);
  } catch (err) {
    log.warn("failed to persist session", { error: String(err) });
  }
}

function readStoredComments(storage: StorageLike | undefined): ReviewComment[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(COMMENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ReviewComment[];
  } catch (err) {
    log.warn("failed to read stored comments", { error: String(err) });
  }
  return [];
}

function writeStoredComments(storage: StorageLike | undefined, comments: ReviewComment[]): void {
  if (!storage) return;
  try {
    if (comments.length > 0) storage.setItem(COMMENTS_STORAGE_KEY, JSON.stringify(comments));
    else storage.removeItem(COMMENTS_STORAGE_KEY);
  } catch (err) {
    log.warn("failed to persist comments", { error: String(err) });
  }
}

function deduplicateDiffFiles(ev: {
  committed?: any[];
  staged?: any[];
  unstaged?: any[];
}): FileDiffData[] {
  const committed: FileDiffData[] = (ev.committed || []).map((f: any) => ({ ...f, area: "committed" as const }));
  const staged: FileDiffData[] = (ev.staged || []).map((f: any) => ({ ...f, area: "staged" as const }));
  const unstaged: FileDiffData[] = (ev.unstaged || []).map((f: any) => ({ ...f, area: "unstaged" as const }));
  // Deduplicate: unstaged > staged > committed
  const seen = new Set<string>();
  const allFiles: FileDiffData[] = [];
  for (const f of unstaged) { seen.add(f.name); allFiles.push(f); }
  for (const f of staged) { if (!seen.has(f.name)) { seen.add(f.name); allFiles.push(f); } }
  for (const f of committed) { if (!seen.has(f.name)) { seen.add(f.name); allFiles.push(f); } }
  return allFiles;
}

/**
 * In-process controller owning the entire pidiff browser↔daemon protocol:
 * WebSocket dispatch, reconnect watch restoration, canonical request-diffs sends,
 * session/worktree/mode/commit/refresh state, safety timers, and review comments.
 */
export function createDiffSessionController(
  options: DiffSessionControllerOptions,
): DiffSessionController {
  const { send, storage, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = options;
  const initialStale = Boolean(options.initialStale);
  let pendingDeepLink = parseDeepLinkParams(options.locationSearch);

  const listeners = new Set<() => void>();
  let sessionBound = false;
  let commitsRequested = false;
  let loadingTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const initialSession = pendingDeepLink ? null : readStoredSession(storage);
  const initialComments = readStoredComments(storage);

  let state: DiffSessionState = {
    connected: false,
    sessions: [],
    activeSession: initialSession,
    activeWorktree: null,
    diffData: { mode: "branch", files: [], branch: "" },
    mode: "branch",
    loading: false,
    refreshing: false,
    commits: null,
    commitFrom: "",
    commitTo: "",
    stale: initialStale,
    staleWorktrees: new Set<string>(),
    comments: initialComments,
    openForms: [],
    refreshButton: getRefreshButtonState(false, false),
  };

  log.debug("controller init", {
    hasStoredSession: Boolean(initialSession),
    initialStale,
    storedComments: initialComments.length,
  });

  function clearLoadingTimer(): void {
    if (loadingTimer !== null) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
  }

  function clearRefreshTimer(): void {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  function armLoadingTimer(): void {
    clearLoadingTimer();
    loadingTimer = setTimeout(() => {
      loadingTimer = null;
      if (!state.loading) return;
      log.warn("loading timeout expired");
      commitState({ loading: false });
    }, timeoutMs);
  }

  function armRefreshTimer(): void {
    clearRefreshTimer();
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!state.refreshing) return;
      log.warn("refresh timeout expired");
      commitState({ refreshing: false });
    }, timeoutMs);
  }

  function commitState(patch: Partial<Omit<DiffSessionState, "refreshButton">>): void {
    const nextConnected = patch.connected ?? state.connected;
    const nextRefreshing = patch.refreshing ?? state.refreshing;
    state = {
      ...state,
      ...patch,
      refreshButton: getRefreshButtonState(nextRefreshing, nextConnected),
    };
    for (const listener of listeners) listener();
  }

  /** Single canonical outgoing path for every `{ type: "request-diffs" }` payload. */
  function sendRequestDiffs(mode: DiffMode, commitFrom: string, commitTo: string): boolean {
    const payload = buildRequestDiffsMessage(mode, commitFrom, commitTo);
    const sent = Boolean(send(payload));
    if (!sent) {
      log.error("request-diffs dropped", { mode, connected: state.connected });
    }
    return sent;
  }

  function getActivePath(): string | undefined {
    return state.activeWorktree?.path || (sessionBound ? state.activeSession?.cwd : undefined);
  }

  function bindSession(
    session: PiSession,
    opts?: {
      resetWorktree?: boolean;
      clearStaleWorktrees?: boolean;
      sessions?: PiSession[];
    },
  ): void {
    const resetWorktree = opts?.resetWorktree ?? false;
    const clearStaleWorktrees = opts?.clearStaleWorktrees ?? false;
    sessionBound = true;
    commitsRequested = false;
    clearRefreshTimer();
    writeStoredSession(storage, session);

    const sent = Boolean(send({ type: "watch", sessionId: session.sessionId }));
    if (sent) armLoadingTimer();
    else clearLoadingTimer();

    commitState({
      ...(opts?.sessions ? { sessions: opts.sessions } : {}),
      activeSession: session,
      ...(resetWorktree ? { activeWorktree: null } : {}),
      mode: "branch",
      diffData: { mode: "branch", files: [], branch: session.branch },
      commits: null,
      commitFrom: "",
      commitTo: "",
      stale: false,
      ...(clearStaleWorktrees ? { staleWorktrees: new Set<string>() } : {}),
      refreshing: false,
      loading: sent,
    });
  }

  function setConnected(nextConnected: boolean): void {
    if (nextConnected === state.connected) return;
    const reconnected = nextConnected && !state.connected;
    log.info("connection state changed", {
      connected: nextConnected,
      reconnected,
      sessionId: sessionBound ? state.activeSession?.sessionId || "" : "",
      hasWorktree: Boolean(state.activeWorktree?.path),
    });

    if (!nextConnected) {
      clearRefreshTimer();
      commitState({ connected: false, refreshing: false });
      return;
    }

    commitState({ connected: true });

    // Restore watches only on a disconnected -> connected transition.
    // Bind session first, then active worktree (server requires session watch first).
    if (reconnected) {
      if (sessionBound && state.activeSession?.sessionId) {
        log.debug("restore watch session", { sessionId: state.activeSession.sessionId });
        send({ type: "watch", sessionId: state.activeSession.sessionId });
      }
      if (state.activeWorktree?.path) {
        log.debug("restore watch worktree", { worktreePath: state.activeWorktree.path });
        send({ type: "watch-worktree", worktreePath: state.activeWorktree.path });
      }
    }
  }

  function applyDeepLinkResolution(
    resolved: DeepLinkResolution,
    sessions?: PiSession[],
  ): void {
    pendingDeepLink = null;
    log.info("deep-link selected session", {
      sessionId: resolved.session.sessionId,
      worktreePath: resolved.worktree?.path || "",
      branch: resolved.worktree?.branch || resolved.session.branch,
    });
    bindSession(resolved.session, { resetWorktree: true, sessions });
    const wt = resolved.worktree;
    if (wt && (!wt.isMain || normalizePath(wt.path) !== normalizePath(resolved.session.cwd))) {
      switchWorktree(wt);
    }
  }

  function handleMessage(ev: any): void {
    if (!ev || typeof ev !== "object") return;

    switch (ev.type) {
      case "diff_update": {
        if (ev.mode && ev.mode !== state.mode) {
          log.debug("ignoring diff_update for inactive mode", { incoming: ev.mode, active: state.mode });
          return;
        }
        const activePath = getActivePath();
        if (typeof ev.cwd === "string" && ev.cwd && activePath && normalizePath(ev.cwd) !== normalizePath(activePath)) {
          log.debug("ignoring diff_update for inactive path", { incoming: ev.cwd, active: activePath });
          return;
        }
        const allFiles = deduplicateDiffFiles(ev);
        clearLoadingTimer();
        clearRefreshTimer();
        // Don't clear stale here — only explicit Refresh clears it.
        commitState({
          diffData: {
            mode: ev.mode || "branch",
            files: allFiles,
            branch: ev.branch || "",
            fromRef: ev.fromRef,
            toRef: ev.toRef,
          },
          loading: false,
          refreshing: false,
        });
        return;
      }

      case "commits-list": {
        if (ev.commits) {
          commitState({ commits: ev.commits });
        }
        return;
      }

      case "status_changed": {
        if (Array.isArray(ev.changedWorktrees)) {
          const nextStaleWorktrees = new Set(state.staleWorktrees);
          for (const p of ev.changedWorktrees) nextStaleWorktrees.add(p);
          const activePath = getActivePath();
          const nextStale = activePath && ev.changedWorktrees.includes(activePath)
            ? true
            : state.stale;
          commitState({ staleWorktrees: nextStaleWorktrees, stale: nextStale });
        } else {
          commitState({ stale: true });
        }
        return;
      }

      case "sessions-list": {
        if (!Array.isArray(ev.sessions)) return;
        const sessions: PiSession[] = ev.sessions;
        if (!sessionBound && sessions.length > 0) {
          const deepLinked = resolveDeepLinkTarget(sessions, pendingDeepLink);
          if (deepLinked) {
            applyDeepLinkResolution(deepLinked, sessions);
            return;
          }
          pendingDeepLink = null;
          const saved = state.activeSession ?? readStoredSession(storage);
          const target = saved
            ? sessions.find((s) => s.sessionId === saved.sessionId) || sessions[0]
            : sessions[0];
          log.info("auto-selected session from sessions-list", { sessionId: target.sessionId });
          bindSession(target, { resetWorktree: true, sessions });
          return;
        }
        if (!sessionBound && sessions.length === 0 && state.activeSession) {
          writeStoredSession(storage, null);
          commitState({ sessions, activeSession: null });
          return;
        }
        if (sessionBound && state.activeSession) {
          const updated = sessions.find((s) => s.sessionId === state.activeSession!.sessionId);
          if (updated) {
            writeStoredSession(storage, updated);
            commitState({ sessions, activeSession: updated });
            return;
          }
        }
        commitState({ sessions });
        return;
      }

      case "session_added": {
        if (!ev.session) return;
        if (state.sessions.some((s) => s.sessionId === ev.session.sessionId)) return;
        const nextSessions = [...state.sessions, ev.session];
        if (!sessionBound) {
          const deepLinked = resolveDeepLinkTarget(nextSessions, pendingDeepLink);
          if (deepLinked) {
            applyDeepLinkResolution(deepLinked, nextSessions);
            return;
          }
          log.info("auto-selected added session", { sessionId: ev.session.sessionId });
          bindSession(ev.session, { resetWorktree: true, sessions: nextSessions });
          return;
        }
        commitState({ sessions: nextSessions });
        return;
      }

      case "session_removed": {
        if (!ev.sessionId) return;
        const nextSessions = state.sessions.filter((s) => s.sessionId !== ev.sessionId);
        if (state.activeSession?.sessionId === ev.sessionId) {
          log.info("active session removed", { sessionId: ev.sessionId });
          sessionBound = false;
          commitsRequested = false;
          clearLoadingTimer();
          clearRefreshTimer();
          writeStoredSession(storage, null);
          commitState({
            sessions: nextSessions,
            activeSession: null,
            activeWorktree: null,
            stale: false,
            refreshing: false,
            loading: false,
            staleWorktrees: new Set<string>(),
            diffData: { mode: "branch", files: [], branch: "" },
          });
          return;
        }
        commitState({ sessions: nextSessions });
        return;
      }

      case "session_updated": {
        if (!ev.session) return;
        const nextSessions = state.sessions.map((s) =>
          s.sessionId === ev.session.sessionId ? { ...s, ...ev.session } : s,
        );
        if (state.activeSession?.sessionId === ev.session.sessionId) {
          const nextActive = { ...state.activeSession, ...ev.session };
          writeStoredSession(storage, nextActive);
          commitState({ sessions: nextSessions, activeSession: nextActive });
          return;
        }
        commitState({ sessions: nextSessions });
        return;
      }

      default:
        return;
    }
  }

  function switchSession(session: PiSession): void {
    log.info("switchSession", { sessionId: session.sessionId, branch: session.branch });
    bindSession(session, { resetWorktree: true, clearStaleWorktrees: true });
  }

  function switchWorktree(worktree: Worktree): void {
    log.info("switchWorktree", { worktreePath: worktree.path, branch: worktree.branch });
    commitsRequested = false;
    clearRefreshTimer();
    const sent = Boolean(send({ type: "watch-worktree", worktreePath: worktree.path }));
    if (sent) armLoadingTimer();
    else clearLoadingTimer();

    commitState({
      activeWorktree: worktree,
      mode: "branch",
      commits: null,
      commitFrom: "",
      commitTo: "",
      stale: state.staleWorktrees.has(worktree.path),
      diffData: { mode: "branch", files: [], branch: worktree.branch },
      refreshing: false,
      loading: sent,
    });
  }

  function switchMode(nextMode: DiffMode): void {
    log.info("switchMode", { mode: nextMode });
    clearRefreshTimer();
    if (nextMode === "commits") {
      commitState({
        mode: nextMode,
        refreshing: false,
        diffData: { ...state.diffData, files: [], fromRef: undefined, toRef: undefined },
      });
      if (!commitsRequested) {
        const sent = Boolean(send({ type: "request-commits" }));
        if (sent) commitsRequested = true;
      }
      return;
    }

    const sent = sendRequestDiffs(nextMode, "", "");
    if (sent) armLoadingTimer();
    else clearLoadingTimer();
    commitState({ mode: nextMode, refreshing: false, loading: sent });
  }

  function setCommitFrom(hash: string): void {
    if (hash === state.commitFrom) return;
    commitState({ commitFrom: hash });
  }

  function setCommitTo(hash: string): void {
    if (hash === state.commitTo) return;
    commitState({ commitTo: hash });
  }

  function compareCommits(): boolean {
    if (!state.commitFrom || !state.commitTo) return false;
    clearRefreshTimer();
    const sent = sendRequestDiffs("commits", state.commitFrom, state.commitTo);
    if (sent) {
      armLoadingTimer();
      commitState({ loading: true, refreshing: false });
    }
    return sent;
  }

  function refresh(): boolean {
    if (!state.connected || state.refreshing) {
      log.debug("refresh skipped", { connected: state.connected, refreshing: state.refreshing });
      return false;
    }

    // Commits-mode refresh re-fetches the currently displayed comparison rather than leftover picker state.
    const fromRef = state.mode === "commits" ? (state.diffData.fromRef || state.commitFrom) : "";
    const toRef = state.mode === "commits" ? (state.diffData.toRef || state.commitTo) : "";

    const sent = sendRequestDiffs(state.mode, fromRef, toRef);
    if (!sent) return false;

    const activePath = getActivePath();
    let nextStaleWorktrees = state.staleWorktrees;
    if (activePath && state.staleWorktrees.has(activePath)) {
      const copy = new Set(state.staleWorktrees);
      copy.delete(activePath);
      nextStaleWorktrees = copy;
    }

    armRefreshTimer();
    log.info("refresh", { mode: state.mode, path: activePath || "" });
    commitState({
      stale: false,
      staleWorktrees: nextStaleWorktrees,
      refreshing: true,
    });
    return true;
  }

  function addCommentForm(file: string, side: "deletions" | "additions", lineNumber: number): void {
    if (state.openForms.some((f) => f.file === file && f.side === side && f.lineNumber === lineNumber)) {
      return;
    }
    commitState({ openForms: [...state.openForms, { file, side, lineNumber }] });
  }

  function cancelCommentForm(file: string, side: "deletions" | "additions", lineNumber: number): void {
    const nextForms = state.openForms.filter(
      (f) => !(f.file === file && f.side === side && f.lineNumber === lineNumber),
    );
    if (nextForms.length === state.openForms.length) return;
    commitState({ openForms: nextForms });
  }

  function submitComment(file: string, side: "deletions" | "additions", lineNumber: number, body: string): void {
    const trimmed = body.trim();
    if (!trimmed) return;
    const wt = state.activeWorktree;
    const branch = wt?.branch || state.diffData.branch;
    const worktreePath = wt?.path;
    const nextComments: ReviewComment[] = [
      ...state.comments,
      {
        file,
        line: lineNumber,
        side: side === "deletions" ? "old" : "new",
        body: trimmed,
        branch,
        worktreePath,
      },
    ];
    const nextForms = state.openForms.filter(
      (f) => !(f.file === file && f.side === side && f.lineNumber === lineNumber),
    );
    writeStoredComments(storage, nextComments);
    commitState({ comments: nextComments, openForms: nextForms });
  }

  function editComment(index: number): void {
    const target = state.comments[index];
    if (!target) return;
    const nextComments = state.comments.filter((_, i) => i !== index);
    const side: "deletions" | "additions" = target.side === "old" ? "deletions" : "additions";
    const alreadyOpen = state.openForms.some(
      (f) => f.file === target.file && f.side === side && f.lineNumber === target.line,
    );
    const nextForms = alreadyOpen
      ? state.openForms
      : [...state.openForms, { file: target.file, side, lineNumber: target.line }];
    writeStoredComments(storage, nextComments);
    commitState({ comments: nextComments, openForms: nextForms });
  }

  function deleteComment(index: number): void {
    if (index < 0 || index >= state.comments.length) return;
    const nextComments = state.comments.filter((_, i) => i !== index);
    writeStoredComments(storage, nextComments);
    commitState({ comments: nextComments });
  }

  function resolveComment(index: number): void {
    if (index < 0 || index >= state.comments.length) return;
    const nextComments = state.comments.map((c, i) => (i === index ? { ...c, resolved: true } : c));
    writeStoredComments(storage, nextComments);
    commitState({ comments: nextComments });
  }

  function replyToComment(index: number, body: string): void {
    if (index < 0 || index >= state.comments.length) return;
    const nextComments = state.comments.map((c, i) => {
      if (i !== index) return c;
      const replies = [...(c.replies || []), { author: "You", body, timestamp: "now" }];
      return { ...c, replies };
    });
    writeStoredComments(storage, nextComments);
    commitState({ comments: nextComments });
  }

  function publishReview(): boolean {
    if (state.comments.length === 0) return false;
    const sent = Boolean(send({ type: "publish-review", comments: state.comments }));
    if (!sent) {
      log.warn("publish-review dropped while disconnected", { count: state.comments.length });
      return false;
    }
    log.info("publish-review sent", { count: state.comments.length });
    writeStoredComments(storage, []);
    commitState({ comments: [] });
    return true;
  }

  function dispose(): void {
    clearLoadingTimer();
    clearRefreshTimer();
    listeners.clear();
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setConnected,
    handleMessage,
    switchSession,
    switchWorktree,
    switchMode,
    setCommitFrom,
    setCommitTo,
    compareCommits,
    refresh,
    addCommentForm,
    submitComment,
    cancelCommentForm,
    editComment,
    deleteComment,
    resolveComment,
    replyToComment,
    publishReview,
    dispose,
  };
}

function getBrowserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch (err) {
    log.warn("browser localStorage unavailable", { error: String(err) });
    return undefined;
  }
}

function getBrowserSearch(): string | undefined {
  try {
    return typeof window !== "undefined" && typeof window.location?.search === "string"
      ? window.location.search
      : undefined;
  } catch {
    return undefined;
  }
}

/** React hook binding the in-process DiffSessionController to useWebSocket. */
export function useDiffSessionController(options?: {
  testWs?: WebSocket | null;
  reconnectMs?: number;
}) {
  const { connected, send, onMessage } = useWebSocket(options);
  const sendRef = useRef(send);
  sendRef.current = send;

  const controller = useMemo(
    () =>
      createDiffSessionController({
        send: (msg) => sendRef.current(msg),
        storage: getBrowserStorage(),
        initialStale: Boolean((globalThis as { __pidiffTestStale?: boolean }).__pidiffTestStale),
        locationSearch: getBrowserSearch(),
      }),
    [],
  );

  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    return onMessage((ev) => controller.handleMessage(ev));
  }, [onMessage, controller]);

  useEffect(() => {
    controller.setConnected(connected);
  }, [connected, controller]);

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  return { state, controller };
}
