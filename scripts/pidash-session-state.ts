import type {
  ChatMessage,
  MessageRole,
  PendingUiRequestPayload,
  SessionCommandInfo,
  SessionInfo,
  SessionSnapshotPayload,
  TokenUsage,
} from "../extensions/shared/types.ts";
import {
  appendAsyncAgentEventText,
  applyTranscriptEvent,
  ASYNC_AGENT_TEXT_MAX,
  extractToolContentText,
  type TranscriptAddOptions,
  type TranscriptRefs,
  type TranscriptSink,
} from "../extensions/shared/pidash-transcript-reducer.ts";
import { initialActivityState } from "../extensions/pidash/activity-state.ts";
import { createLogger } from "../extensions/shared/logger.ts";

const log = createLogger("pidash");

export const PENDING_UI_REQUESTS_MAX = 50;
export const VIEW_STATE_MESSAGES_MAX = 1000;
export const ASYNC_AGENTS_MAX = 100;
export const MAX_SYNC_AGENTS_PER_SESSION = 50;

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Detect actual test-runner failure summaries/statuses without false-positives on test names. */
function hasTestFailureSignal(text: string): boolean {
  if (!text) return false;
  // Numeric failure/error counts (ignores `0 failed` / `0 errors`)
  if (/\b[1-9]\d*\s+(?:failed|failing|errors?)\b/i.test(text)) return true;
  // node:test summary line (`ℹ fail 1`)
  if (/ℹ\s+fail\s+[1-9]\d*\b/i.test(text)) return true;
  // Explicit runner status tokens (pytest FAILED/ERROR, go FAIL, node ✖/✗)
  if (/(?:^|\s)(?:FAILED|ERROR)(?=\s|$|:)/m.test(text)) return true;
  if (/^\s*(?:[✖✗]\s|---\s+FAIL:|FAIL\b)/m.test(text)) return true;
  return false;
}

/**
 * Build a metadata-only `session_notification` frame for global browser broadcast.
 * Evaluates test-result signals server-side so raw tool output is never leaked to
 * browsers watching other sessions.
 */
export function buildSessionNotification(
  sessionId: string,
  cwd: string,
  parsed: any,
): {
  type: "session_notification";
  sessionId: string;
  cwd: string;
  toolName: string;
  isError: boolean;
  isSubagent: boolean;
  agentName: string;
  isTestEvent: boolean;
  testPassed: boolean;
} {
  const toolName = typeof parsed?.toolName === "string" ? parsed.toolName : "";
  const isSubagent = toolName === "subagent" || Boolean(parsed?.args?.agent);
  const isError = parsed?.isError === true;
  const fullText = extractToolContentText(parsed?.result?.content);
  const snippet = fullText.slice(0, 200).toLowerCase();
  const tl = toolName.toLowerCase();
  const isTestEvent = tl.includes("test") || snippet.includes("pytest") || snippet.includes("test_");
  const exitCode = parsed?.result?.details?.exitCode;
  const nonZeroExit = typeof exitCode === "number" && exitCode !== 0;
  const testPassed = isTestEvent && !isError && !nonZeroExit && !hasTestFailureSignal(fullText);
  return {
    type: "session_notification",
    sessionId,
    cwd,
    toolName,
    isError,
    isSubagent,
    agentName: parsed?.args?.name || parsed?.args?.agent || "",
    isTestEvent,
    testPassed,
  };
}

/**
 * Authorize browser watch or control actions targeting a Pi session.
 *
 * Supervised headless COMS RPC peers remain visible in the sidebar for all
 * browsers, but watching their snapshot or forwarding prompts, UI responses,
 * or commands is restricted to localhost clients because PiDash binds to
 * 0.0.0.0 without browser authentication.
 */
export function authorizeSupervisedPeerBrowserAccess(opts: {
  targetSession: Pick<SessionInfo, "supervisedPeer"> | null | undefined;
  remoteAddress: string | undefined | null;
}): { allowed: true } | { allowed: false; reason: string } {
  if (opts.targetSession?.supervisedPeer !== true) {
    return { allowed: true };
  }
  if (!isLoopbackAddress(opts.remoteAddress)) {
    return {
      allowed: false,
      reason: "Supervised headless peers can only be watched or controlled from localhost clients.",
    };
  }
  return { allowed: true };
}

/**
 * Predicate deciding whether a browser connection is authorized to receive
 * live events or broadcasts originating from `session`.
 */
export function shouldDeliverSupervisedPeerBroadcast(opts: {
  session: Pick<SessionInfo, "supervisedPeer"> | null | undefined;
  remoteAddress: string | undefined | null;
}): boolean {
  return authorizeSupervisedPeerBrowserAccess({
    targetSession: opts.session,
    remoteAddress: opts.remoteAddress,
  }).allowed;
}

/**
 * Build a `session_updated` wire payload that preserves explicit `null` clears
 * for COMS identity fields across JSON serialization while keeping the
 * server-side `SessionInfo` fields as `undefined`.
 */
export function buildSessionUpdatedBroadcast(
  session: SessionInfo,
  parsed?: { comsName?: unknown; comsPurpose?: unknown; comsProject?: unknown },
): { type: "session_updated"; session: Record<string, unknown> } {
  const wire: Record<string, unknown> = { ...session };
  if (session.supervisedPeer !== true) {
    if (parsed?.comsName === null) wire.comsName = null;
    if (parsed?.comsPurpose === null) wire.comsPurpose = null;
    if (parsed?.comsProject === null) wire.comsProject = null;
  }
  return { type: "session_updated", session: wire };
}

export function handlePidashBrowserWatch(opts: {
  ws: { send: (data: string) => void };
  watchId: string | null;
  client: PiClient | null;
  remoteAddress: string | undefined | null;
  onLog?: (msg: string) => void;
}): string | null {
  const { ws, watchId, client, remoteAddress, onLog } = opts;
  if (!client) return watchId;

  const auth = authorizeSupervisedPeerBrowserAccess({
    targetSession: client.session,
    remoteAddress,
  });
  if (!auth.allowed) {
    log.warn("supervised_peer_watch_rejected", {
      sessionId: watchId,
      remoteAddress: remoteAddress ?? "unknown",
      reason: auth.reason,
    });
    try {
      ws.send(JSON.stringify({
        type: "watch_denied",
        sessionId: watchId,
        reason: auth.reason,
        message: auth.reason,
      }));
    } catch {}
    return null;
  }

  const { messageCount, pendingCount } = sendSessionSnapshot(ws, client);
  if (pendingCount > 0) {
    onLog?.(`sent session_snapshot (${messageCount} messages + ${pendingCount} pending UI request(s)) for ${watchId}`);
  } else {
    onLog?.(`sent session_snapshot (${messageCount} messages) for ${watchId}`);
  }
  return watchId;
}

export function handlePidashBrowserMessage(opts: {
  ws: { send: (data: string) => void };
  parsed: any;
  piClients: Map<string, PiClient>;
  watchedSessionId: string | null | undefined;
  remoteAddress: string | undefined | null;
  onLog?: (msg: string) => void;
}): boolean {
  const { ws, parsed, piClients, watchedSessionId, remoteAddress, onLog } = opts;

  if (parsed.type === "prompt" && (parsed.text || parsed.images) && parsed.sessionId) {
    const piClient = piClients.get(parsed.sessionId);
    const peerAuth = authorizeSupervisedPeerBrowserAccess({
      targetSession: piClient?.session,
      remoteAddress,
    });
    if (!peerAuth.allowed) {
      log.warn("supervised_peer_prompt_rejected", {
        sessionId: parsed.sessionId,
        remoteAddress: remoteAddress ?? "unknown",
        reason: peerAuth.reason,
      });
      try {
        ws.send(JSON.stringify({ type: "notification", level: "warning", message: peerAuth.reason }));
      } catch {}
      return false;
    }
    if (piClient && piClient.ws) {
      const fwd: any = { type: "prompt", text: parsed.text || "" };
      if (parsed.images && parsed.images.length > 0) fwd.images = parsed.images;
      piClient.ws.send(JSON.stringify(fwd));
      onLog?.(`prompt forwarded to ${parsed.sessionId}: ${(parsed.text || "").slice(0, 50)}${parsed.images ? ` [+${parsed.images.length} images]` : ""}`);
      return true;
    }
    return false;
  }

  // Forward extension UI responses (ask_user answers) to pi session
  if (parsed.type === "extension_ui_response" && parsed.id) {
    if (!parsed.sessionId) return false;
    const piClient = piClients.get(parsed.sessionId);
    const peerAuth = authorizeSupervisedPeerBrowserAccess({
      targetSession: piClient?.session,
      remoteAddress,
    });
    if (!peerAuth.allowed) {
      log.warn("supervised_peer_ui_response_rejected", {
        sessionId: parsed.sessionId,
        remoteAddress: remoteAddress ?? "unknown",
        reason: peerAuth.reason,
      });
      try {
        ws.send(JSON.stringify({ type: "notification", level: "warning", message: peerAuth.reason }));
      } catch {}
      return false;
    }
    const response = piClient ? forwardBrowserUiResponse(piClient, parsed) : null;
    if (response) {
      onLog?.(`UI response forwarded to ${parsed.sessionId}: ${JSON.stringify(response).slice(0, 100)}`);
      return true;
    }
    return false;
  }

  // Forward pidash commands to pi session
  if (parsed.type === "pidash-command") {
    if (!parsed.sessionId) return false;
    const piClient = piClients.get(parsed.sessionId);
    const peerAuth = authorizeSupervisedPeerBrowserAccess({
      targetSession: piClient?.session,
      remoteAddress,
    });
    if (!peerAuth.allowed) {
      log.warn("supervised_peer_command_rejected", {
        command: parsed.command,
        sessionId: parsed.sessionId,
        remoteAddress: remoteAddress ?? "unknown",
        reason: peerAuth.reason,
      });
      try {
        ws.send(
          JSON.stringify(
            isWorktreeCommand(parsed.command)
              ? buildWorktreeCommandErrorFrame(parsed, peerAuth.reason, piClient?.session.cwd ?? "")
              : { type: "notification", level: "warning", message: peerAuth.reason },
          ),
        );
      } catch {}
      return false;
    }
    if (isWorktreeCommand(parsed.command)) {
      const auth = authorizeWorktreeBrowserCommand({
        command: parsed.command,
        targetSessionId: parsed.sessionId,
        watchedSessionId,
        remoteAddress,
      });
      if (!auth.allowed) {
        log.warn("worktree_command_rejected", {
          command: parsed.command,
          sessionId: parsed.sessionId,
          remoteAddress: remoteAddress ?? "unknown",
          reason: auth.reason,
        });
        try {
          ws.send(JSON.stringify(buildWorktreeCommandErrorFrame(parsed, auth.reason, piClient?.session.cwd ?? "")));
        } catch {}
        return false;
      }
      if (!piClient || !piClient.ws || !piClient.session.active) {
        try {
          ws.send(JSON.stringify(buildWorktreeCommandErrorFrame(parsed, "Watched Pi session is disconnected.", piClient?.session.cwd ?? "")));
        } catch {}
        return false;
      }
    }
    if (piClient && piClient.ws) {
      piClient.ws.send(JSON.stringify(parsed));
      onLog?.(`command forwarded to ${parsed.sessionId}: ${parsed.command}`);
      return true;
    }
    return false;
  }

  return false;
}

export function isWorktreeCommand(command: unknown): boolean {
  return (
    command === "worktrees-list" ||
    command === "worktrees-detail" ||
    command === "worktrees-prune" ||
    command === "worktrees-remove"
  );
}

export function isWorktreeMutationCommand(command: unknown): boolean {
  return command === "worktrees-prune" || command === "worktrees-remove";
}

/**
 * Authorize a browser worktree command before forwarding it to a Pi session:
 * - Browser must currently be watching the target `sessionId` (prevents arbitrary cross-session targeting).
 * - Destructive mutations (`worktrees-prune`, `worktrees-remove`) are restricted to loopback clients
 *   because PiDash binds to 0.0.0.0 without browser authentication.
 */
export function authorizeWorktreeBrowserCommand(opts: {
  command: unknown;
  targetSessionId: unknown;
  watchedSessionId: unknown;
  remoteAddress: string | undefined | null;
}): { allowed: true } | { allowed: false; reason: string } {
  const target = typeof opts.targetSessionId === "string" ? opts.targetSessionId : "";
  if (!target || opts.watchedSessionId !== target) {
    return { allowed: false, reason: "Worktree command rejected: browser is not watching this session." };
  }
  if (isWorktreeMutationCommand(opts.command) && !isLoopbackAddress(opts.remoteAddress)) {
    return { allowed: false, reason: "Worktree mutations are restricted to localhost clients." };
  }
  return { allowed: true };
}

/** Build an explicit error reply for a rejected or undeliverable browser worktree command. */
export function buildWorktreeCommandErrorFrame(parsed: any, reason: string, sessionCwd = ""): Record<string, unknown> {
  const requestId = parsed?.requestId;
  if (parsed?.command === "worktrees-list") {
    return {
      type: "worktrees-list",
      requestId,
      sourceSessionId: parsed?.sessionId,
      cwd: sessionCwd,
      linkedCount: 0,
      dirtyCount: 0,
      inLinkedWorktree: false,
      worktrees: [],
      error: reason,
    };
  }
  if (parsed?.command === "worktrees-detail") {
    return {
      type: "worktrees-detail",
      requestId,
      path: typeof parsed?.path === "string" ? parsed.path : "",
      headSubject: "",
      statusLines: [],
      truncatedCount: 0,
      statusOk: false,
      error: reason,
    };
  }
  return {
    type: "worktrees-op-result",
    requestId,
    op: parsed?.command === "worktrees-prune" ? "prune" : "remove",
    ok: false,
    message: reason,
  };
}

/**
 * Determine whether a browser watching `watchId` should receive a minimal
 * repository-scoped `worktrees-changed` invalidation notice.
 */
export function shouldNotifyWorktreeChange(opts: {
  watchId: string | null | undefined;
  sourceSessionId: string;
  repoRoot: string | undefined;
  watchedSessionRepoRoot: string | undefined;
  watchedSessionCwd: string | undefined;
}): boolean {
  if (!opts.watchId) return false;
  if (opts.watchId === opts.sourceSessionId) return true;
  if (!opts.repoRoot) return false;
  if (opts.watchedSessionRepoRoot) {
    return opts.watchedSessionRepoRoot === opts.repoRoot;
  }
  if (!opts.watchedSessionCwd) return false;
  const normRepo = opts.repoRoot.endsWith("/") ? opts.repoRoot : `${opts.repoRoot}/`;
  return opts.watchedSessionCwd === opts.repoRoot || opts.watchedSessionCwd.startsWith(normRepo);
}

export interface PendingUiRequestStore {
  pendingUiRequests: Map<string, string>;
  replaying?: boolean;
}

export interface SessionViewState extends TranscriptRefs {
  messages: ChatMessage[];
  indexById: Map<string, number>;
  nextSeq: number;
  model: string;
  tokens: TokenUsage | null;
  streaming: boolean;
  queuedCount: number;
  streamingBehavior: string | null;
  availableCommands: SessionCommandInfo[];
}

export interface ActiveAsyncAgentInfo {
  id: string;
  name?: string;
  agent: string;
  mode?: "async" | "sync";
  task: string;
  cwd: string;
  sessionId?: string;
  /** Original Pi session ID that spawned this worker (distinct from process-level PiDash sessionId) (#1509). */
  piSessionId?: string | null;
  taskId?: string | null;
  startedAt?: number;
  currentTool?: string | null;
  text: string;
  ws?: any;
}

export interface PiClient extends PendingUiRequestStore {
  ws: any;
  session: SessionInfo;
  viewState: SessionViewState;
  replaying: boolean;
  connectionGeneration: number;
  /** Currently selected Pi session ID inside this Pi process (updated on register / session_switch) (#1509). */
  currentPiSessionId?: string | null;
  /** Running or queued async job IDs last reported by Pi's `async-status` frames (#1509). */
  asyncStatusRunningIds?: Set<string>;
  /** Running or queued non-sync jobs in `async-status` lacking a string `id` (#1509). */
  asyncStatusAnonymousCount?: number;
}

export function createSessionViewState(
  session?: Partial<SessionInfo>,
  availableCommands: SessionCommandInfo[] = [],
): SessionViewState {
  return {
    messages: [],
    indexById: new Map(),
    nextSeq: 0,
    think: { id: "", text: "", startTs: 0 },
    assist: { id: "", text: "" },
    tool: { id: "", name: "", startTs: 0, callId: "" },
    asyncMsgs: new Map(),
    lastUserText: "",
    model: session?.model || "",
    tokens: null,
    streaming: session?.streaming === true,
    queuedCount: 0,
    streamingBehavior: null,
    availableCommands: availableCommands.map((c) => ({ ...c })),
  };
}

export function resetSessionViewState(client: PiClient): void {
  client.viewState = createSessionViewState(client.session);
  log.debug("viewState reset", { sessionId: client.session.sessionId });
}

function nextViewMessageId(state: SessionViewState): string {
  return `s-${++state.nextSeq}`;
}

function patchViewMessage(
  state: SessionViewState,
  id: string,
  fn: (msg: ChatMessage) => ChatMessage,
): void {
  const idx = state.indexById.get(id);
  if (idx !== undefined) {
    state.messages[idx] = fn(state.messages[idx]);
  }
}

function findLastViewMessage(
  state: SessionViewState,
  pred: (msg: ChatMessage) => boolean,
): ChatMessage | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (pred(state.messages[i])) return state.messages[i];
  }
  return undefined;
}

function dismissViewAsk(state: SessionViewState, askId: string): void {
  const prefix = `ask|${askId}|`;
  for (let i = 0; i < state.messages.length; i++) {
    if (state.messages[i].className?.startsWith(prefix)) {
      state.messages[i] = { ...state.messages[i], className: `ask-answered|${askId}` };
    }
  }
}

export function dismissAllViewAsks(state: SessionViewState): void {
  for (let i = 0; i < state.messages.length; i++) {
    const cls = state.messages[i].className;
    if (cls?.startsWith("ask|")) {
      const parts = cls.split("|");
      if (parts[1]) {
        state.messages[i] = { ...state.messages[i], className: `ask-answered|${parts[1]}` };
      }
    }
  }
}

/**
 * Trim oldest committed messages at message boundaries so bounded snapshots
 * never contain orphaned deltas, never evict active in-flight messages, and
 * always evict paired tool-call + tool-result entries atomically.
 */
export function trimViewStateMessages(
  state: SessionViewState,
  maxMessages = VIEW_STATE_MESSAGES_MAX,
  extraProtectedId?: string,
): number {
  if (maxMessages < 1 || state.messages.length <= maxMessages) return 0;

  const protectedIds = new Set<string>();
  if (extraProtectedId) protectedIds.add(extraProtectedId);
  if (state.think.id) protectedIds.add(state.think.id);
  if (state.assist.id) protectedIds.add(state.assist.id);
  if (state.tool.id) protectedIds.add(state.tool.id);
  for (const entry of state.asyncMsgs.values()) {
    if (entry.msgId) protectedIds.add(entry.msgId);
  }

  // Index tool-call <-> tool-result pairs by callId so eviction handles pairs atomically.
  const callIndexByCallId = new Map<string, number>();
  const resultIndexByCallId = new Map<string, number>();
  for (let i = 0; i < state.messages.length; i++) {
    const msg = state.messages[i];
    const callId = msg.meta?.callId;
    if (!callId) continue;
    if (msg.className === "tool-call") callIndexByCallId.set(callId, i);
    else if (msg.className === "tool-result") resultIndexByCallId.set(callId, i);
  }

  // Protect a tool-call whenever its paired tool-result is protected (e.g. active async card).
  for (const [callId, resIdx] of resultIndexByCallId.entries()) {
    if (protectedIds.has(state.messages[resIdx].id)) {
      const callIdx = callIndexByCallId.get(callId);
      if (callIdx !== undefined) protectedIds.add(state.messages[callIdx].id);
    }
  }

  let remaining = state.messages.length;
  const droppedIndices = new Set<number>();

  for (let i = 0; i < state.messages.length && remaining > maxMessages; i++) {
    if (droppedIndices.has(i)) continue;
    const msg = state.messages[i];
    if (protectedIds.has(msg.id)) continue;

    droppedIndices.add(i);
    remaining--;

    // Evict paired tool-result atomically alongside its tool-call (even if just appended).
    if (msg.className === "tool-call" && msg.meta?.callId) {
      const resIdx = resultIndexByCallId.get(msg.meta.callId);
      if (resIdx !== undefined && !droppedIndices.has(resIdx) && !protectedIds.has(state.messages[resIdx].id)) {
        droppedIndices.add(resIdx);
        remaining--;
      }
    }
  }

  if (droppedIndices.size === 0) return 0;

  const kept: ChatMessage[] = [];
  const nextIndex = new Map<string, number>();
  for (let i = 0; i < state.messages.length; i++) {
    if (droppedIndices.has(i)) continue;
    const msg = state.messages[i];
    nextIndex.set(msg.id, kept.length);
    kept.push(msg);
  }
  state.messages = kept;
  state.indexById = nextIndex;
  log.debug("viewState messages trimmed", {
    dropped: droppedIndices.size,
    remaining: kept.length,
    maxMessages,
  });
  return droppedIndices.size;
}

function addViewMessage(
  state: SessionViewState,
  role: MessageRole,
  text: string,
  className?: string,
  meta?: ChatMessage["meta"],
  options?: TranscriptAddOptions,
  maxMessages = VIEW_STATE_MESSAGES_MAX,
): string {
  const id = options?.explicitId ?? nextViewMessageId(state);
  const msg: ChatMessage = {
    id,
    role,
    text,
    ...(className !== undefined ? { className } : {}),
    ...(meta !== undefined ? { meta } : {}),
    timestamp: options?.timestamp ?? Date.now(),
  };
  state.indexById.set(id, state.messages.length);
  state.messages.push(msg);
  // Only protect active in-flight messages from eviction; committed messages
  // (including newly appended tool-results) participate in atomic pair trimming.
  trimViewStateMessages(state, maxMessages, options?.protect ? id : undefined);
  return id;
}

function shouldApplyStreamingTransition(client: PiClient, parsed: any): boolean {
  if (parsed?.activitySequence === undefined) return true;
  const seq = Number(parsed.activitySequence);
  const current = client.session.activitySequence ?? 0;
  return Number.isSafeInteger(seq) && seq >= 1 && seq >= current;
}

export function applyEventToViewState(
  client: PiClient,
  parsed: any,
  maxMessages = VIEW_STATE_MESSAGES_MAX,
): void {
  if (!parsed || typeof parsed.type !== "string") return;
  const state = client.viewState;

  if (parsed.type === "replay_start") {
    state.messages = [];
    state.indexById.clear();
    state.think = { id: "", text: "", startTs: 0 };
    state.assist = { id: "", text: "" };
    state.tool = { id: "", name: "", startTs: 0, callId: "" };
    state.asyncMsgs.clear();
    state.lastUserText = "";
    state.tokens = null;
    state.queuedCount = 0;
    state.streamingBehavior = null;
    state.model = client.session.model || "";
    state.streaming = client.session.streaming === true;
    return;
  }
  if (parsed.type === "replay_end") return;

  const sink: TranscriptSink = {
    add: (role, text, className, meta, options) =>
      addViewMessage(state, role, text, className, meta, options, maxMessages),
    patch: (id, fn) => patchViewMessage(state, id, fn),
    findLast: (pred) => findLastViewMessage(state, pred),
    dismissAsk: (askId) => dismissViewAsk(state, askId),
    nextId: () => nextViewMessageId(state),
  };

  applyTranscriptEvent(parsed, state, sink, {
    onStreamingChange: (streaming, ev) => {
      if (shouldApplyStreamingTransition(client, ev)) {
        state.streaming = streaming;
      }
    },
    onQueuedIncrement: () => { state.queuedCount += 1; },
    onQueuedReset: () => { state.queuedCount = 0; },
    onStreamingBehavior: (behavior) => { state.streamingBehavior = behavior; },
    onModel: (model) => { state.model = model; },
    onTokens: (tokens) => { state.tokens = tokens; },
    onCommandsList: (commands) => { state.availableCommands = commands; },
    shouldSkipUiRequest: (ev) => client.replaying || !isInteractiveUiRequest(ev),
    sessionId: () => client.session.sessionId,
  });
}

/**
 * Re-link active async agents into a session's rebuilt `viewState` after Pi
 * finishes replaying history on reconnect so subsequent progress and completion
 * events continue updating the same card.
 */
function normalizePiSessionId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Ownership check preventing retained jobs from an earlier `/resume` session
 * from marking the newly selected Pi session busy (#1509).
 */
function matchesCurrentPiSession(
  clientPiSessionId: string | null | undefined,
  jobPiSessionId: string | null | undefined,
): boolean {
  const active = normalizePiSessionId(clientPiSessionId);
  const owner = normalizePiSessionId(jobPiSessionId);
  if (active && owner) return active === owner;
  return true;
}

/**
 * Recompute `client.session.runningAsyncAgents` as the union of Pi's `async-status`
 * active (running or queued) async job IDs and live `/ws/async` registry workers
 * belonging to the client's current Pi session (#1509).
 *
 * Neither source can overwrite or erase the other: a worker disconnecting before Pi's
 * next `async-status` frame keeps the Pi-reported count intact, while headless RPC peers
 * that never emit `async-status` still reflect `/ws/async` workers accurately.
 */
export function syncSessionRunningAsyncAgents(
  client: PiClient,
  registryAgents: Iterable<ActiveAsyncAgentInfo>,
  broadcast?: (event: object) => void,
): boolean {
  const sid = client.session.sessionId;
  const ids = new Set<string>();
  if (client.asyncStatusRunningIds) {
    for (const id of client.asyncStatusRunningIds) ids.add(id);
  }
  for (const agent of registryAgents) {
    if (
      agent.sessionId === sid &&
      agent.mode !== "sync" &&
      agent.id &&
      matchesCurrentPiSession(client.currentPiSessionId, agent.piSessionId)
    ) {
      ids.add(agent.id);
    }
  }
  const nextCount = ids.size + (client.asyncStatusAnonymousCount ?? 0);
  if ((client.session.runningAsyncAgents ?? 0) === nextCount) return false;
  client.session.runningAsyncAgents = nextCount;
  broadcast?.({ type: "session_updated", session: client.session });
  return true;
}

/**
 * Process a Pi `async-status` frame for `client`: extract capped live running sync
 * subagents, record Pi's active (running or queued) async job IDs owned by the
 * current Pi session on `client`, and sync the merged `session.runningAsyncAgents`
 * count (broadcasting `session_updated` only on change).
 */
export function applyPiAsyncStatusFrame(
  client: PiClient,
  jobs: readonly any[],
  registryAgents: Iterable<ActiveAsyncAgentInfo>,
  broadcast?: (event: object) => void,
  maxSync = MAX_SYNC_AGENTS_PER_SESSION,
): ActiveAsyncAgentInfo[] {
  const sid = client.session.sessionId;
  const liveSync: ActiveAsyncAgentInfo[] = [];
  const statusIds = new Set<string>();
  let anonymousCount = 0;

  for (const job of jobs) {
    if (!job) continue;
    if (job.mode !== "sync" && (job.status === "running" || job.status === "queued")) {
      if (!matchesCurrentPiSession(client.currentPiSessionId, job.piSessionId)) continue;
      if (typeof job.id === "string" && job.id) statusIds.add(job.id);
      else anonymousCount++;
      continue;
    }
    if (liveSync.length >= maxSync) continue;
    if (job.mode !== "sync" || job.status !== "running" || typeof job.id !== "string") continue;
    const agentName = typeof job.agent === "string" ? job.agent : "agent";
    liveSync.push({
      id: job.id,
      name: typeof job.name === "string" && job.name ? job.name : agentName,
      agent: agentName,
      mode: "sync",
      task: typeof job.task === "string" ? job.task : "",
      cwd: typeof job.cwd === "string" ? job.cwd : client.session.cwd,
      sessionId: sid,
      taskId: typeof job.taskId === "string" && job.taskId ? job.taskId : null,
      startedAt: typeof job.startedAt === "number" && Number.isFinite(job.startedAt) ? job.startedAt : Date.now(),
      currentTool: typeof job.currentTool === "string" && job.currentTool ? job.currentTool : null,
      text: "",
    });
  }

  client.asyncStatusRunningIds = statusIds;
  client.asyncStatusAnonymousCount = anonymousCount;
  syncSessionRunningAsyncAgents(client, registryAgents, broadcast);
  return liveSync;
}

export function reconcileActiveAsyncAgents(
  client: PiClient,
  activeAgents: Iterable<ActiveAsyncAgentInfo>,
): number {
  const state = client.viewState;
  const sid = client.session.sessionId;
  const agentList = Array.isArray(activeAgents) ? activeAgents : Array.from(activeAgents);
  let reconciled = 0;

  for (const agent of agentList) {
    if (!agent.id || agent.sessionId !== sid) continue;
    if (state.asyncMsgs.has(agent.id)) continue;

    applyEventToViewState(client, {
      type: "async_agent_start",
      id: agent.id,
      agent: agent.agent,
      task: agent.task,
      cwd: agent.cwd,
      sessionId: sid,
    });

    const tracked = state.asyncMsgs.get(agent.id);
    if (tracked && agent.text) {
      tracked.text = agent.text;
      const body = tracked.text.trim();
      if (body) {
        patchViewMessage(state, tracked.msgId, (m) => {
          const header = m.text.split("\n")[0];
          return { ...m, text: `${header}\n${body}` };
        });
      }
    }
    reconciled++;
  }

  syncSessionRunningAsyncAgents(client, agentList);
  if (reconciled > 0) {
    log.debug("reconciled active async agents into viewState", { sessionId: sid, count: reconciled });
  }
  return reconciled;
}

/**
 * Finalize a running async agent card when its `/ws/async` socket drops before
 * sending `async_complete`, transitioning the snapshot card to failed and
 * notifying connected browsers.
 */
export function finalizeAsyncAgentDisconnect(
  client: PiClient | undefined,
  info: ActiveAsyncAgentInfo,
  broadcast: (event: object) => void,
): void {
  const completeEvent = {
    type: "async_agent_complete",
    id: info.id,
    success: false,
    sessionId: info.sessionId,
  };
  if (client) {
    applyEventToViewState(client, completeEvent);
  }
  broadcast(completeEvent);
  log.info("async agent disconnected before completion; finalized card as failed", {
    id: info.id,
    sessionId: info.sessionId,
  });
}

/**
 * Bounded, socket-owned registry for `/ws/async` worker connections.
 *
 * Validates that registrations target a known Pi session, caps total tracked
 * workers and per-worker progress text, and enforces socket ownership so an
 * older closing socket can never fail or delete a live replacement registration.
 */
export function createAsyncAgentRegistry(
  piClients: Map<string, PiClient>,
  broadcast: (event: object) => void,
  opts: { maxAgents?: number; maxTextChars?: number } = {},
) {
  const maxAgents = opts.maxAgents ?? ASYNC_AGENTS_MAX;
  const maxTextChars = opts.maxTextChars ?? ASYNC_AGENT_TEXT_MAX;
  const agents = new Map<string, ActiveAsyncAgentInfo>();

  const syncSessionAsyncCount = (sessionId: string): void => {
    const target = piClients.get(sessionId);
    if (!target) return;
    syncSessionRunningAsyncAgents(target, agents.values(), broadcast);
  };

  return {
    agents,

    register(ws: any, parsed: any): ActiveAsyncAgentInfo | null {
      const id = typeof parsed?.id === "string" ? parsed.id : "";
      const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : "";
      if (!id || !sessionId || !piClients.has(sessionId)) {
        log.warn("rejected async_register for invalid id or unknown session", { id, sessionId });
        return null;
      }
      if (!agents.has(id) && agents.size >= maxAgents) {
        log.warn("rejected async_register: registry capacity reached", { id, sessionId, maxAgents });
        return null;
      }
      const agentName = typeof parsed.agent === "string" ? parsed.agent : "agent";
      const info: ActiveAsyncAgentInfo = {
        id,
        name: typeof parsed.name === "string" && parsed.name ? parsed.name : agentName,
        agent: agentName,
        mode: parsed.mode === "sync" ? "sync" : "async",
        task: typeof parsed.task === "string" ? parsed.task : "",
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
        sessionId,
        piSessionId: normalizePiSessionId(parsed.piSessionId),
        taskId: typeof parsed.taskId === "string" && parsed.taskId ? parsed.taskId : null,
        startedAt: typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt) ? parsed.startedAt : Date.now(),
        currentTool: null,
        text: "",
        ws,
      };
      agents.set(id, info);
      const startEvent = {
        type: "async_agent_start",
        id: info.id,
        agent: info.agent,
        task: info.task,
        cwd: info.cwd,
        sessionId: info.sessionId,
      };
      const target = piClients.get(sessionId);
      if (target) applyEventToViewState(target, startEvent);
      broadcast(startEvent);
      syncSessionAsyncCount(sessionId);
      return info;
    },

    event(ws: any, parsed: any): boolean {
      const id = typeof parsed?.id === "string" ? parsed.id : "";
      if (!id) return false;
      const info = agents.get(id);
      if (!info || info.ws !== ws) {
        log.debug("ignored async_event from non-owning socket", { id });
        return false;
      }
      appendAsyncAgentEventText(info, parsed.event, maxTextChars);
      if (parsed.event?.type === "tool_execution_start" && typeof parsed.event.toolName === "string") {
        info.currentTool = parsed.event.toolName;
      } else if (parsed.event?.type === "tool_execution_end") {
        info.currentTool = null;
      }
      const progressEvent = {
        type: "async_agent_event",
        id,
        event: parsed.event,
        sessionId: info.sessionId,
      };
      const target = info.sessionId ? piClients.get(info.sessionId) : undefined;
      if (target) applyEventToViewState(target, progressEvent);
      broadcast(progressEvent);
      return true;
    },

    complete(ws: any, parsed: any): boolean {
      const id = typeof parsed?.id === "string" ? parsed.id : "";
      if (!id) return false;
      const info = agents.get(id);
      if (!info || info.ws !== ws) {
        log.debug("ignored async_complete from non-owning socket", { id });
        return false;
      }
      agents.delete(id);
      const completeEvent = {
        type: "async_agent_complete",
        id,
        success: parsed.success,
        sessionId: info.sessionId,
      };
      const target = info.sessionId ? piClients.get(info.sessionId) : undefined;
      if (target) applyEventToViewState(target, completeEvent);
      broadcast(completeEvent);
      if (info.sessionId) syncSessionAsyncCount(info.sessionId);
      return true;
    },

    disconnect(ws: any, id: string | null): boolean {
      if (!id) return false;
      const info = agents.get(id);
      if (!info || info.ws !== ws) {
        log.debug("ignored async disconnect for non-owning socket", { id });
        return false;
      }
      agents.delete(id);
      const target = info.sessionId ? piClients.get(info.sessionId) : undefined;
      finalizeAsyncAgentDisconnect(target, info, broadcast);
      if (info.sessionId) syncSessionAsyncCount(info.sessionId);
      return true;
    },
  };
}

export function buildSessionSnapshot(client: PiClient): SessionSnapshotPayload {
  const state = client.viewState;
  const asyncMsgs: Record<string, { msgId: string; text: string }> = {};
  for (const [id, entry] of state.asyncMsgs.entries()) {
    asyncMsgs[id] = { ...entry };
  }

  const pendingUiRequests: PendingUiRequestPayload[] = [];
  for (const raw of snapshotPendingUiRequests(client)) {
    try {
      const parsed = JSON.parse(raw);
      if (isInteractiveUiRequest(parsed)) {
        pendingUiRequests.push(parsed as PendingUiRequestPayload);
      }
    } catch (err) {
      log.warn("skipping malformed pending UI request in snapshot", err);
    }
  }

  return {
    type: "session_snapshot",
    sessionId: client.session.sessionId,
    messages: state.messages.map((m) => (m.meta ? { ...m, meta: { ...m.meta } } : { ...m })),
    live: {
      think: { ...state.think },
      assist: { ...state.assist },
      tool: { ...state.tool },
      asyncMsgs,
      lastUserText: state.lastUserText,
    },
    model: state.model || client.session.model || "",
    tokens: state.tokens ? { ...state.tokens } : null,
    streaming: state.streaming,
    queuedCount: state.queuedCount,
    streamingBehavior: state.streamingBehavior,
    availableCommands: state.availableCommands.map((c) => ({ ...c })),
    pendingUiRequests,
  };
}

export function sendSessionSnapshot(
  ws: { send: (data: string) => void },
  client: PiClient,
): { messageCount: number; pendingCount: number } {
  const snapshot = buildSessionSnapshot(client);
  try {
    ws.send(JSON.stringify(snapshot));
    log.debug("session_snapshot sent", {
      sessionId: client.session.sessionId,
      messageCount: snapshot.messages.length,
      pendingCount: snapshot.pendingUiRequests.length,
    });
  } catch (err) {
    log.warn("failed to send session_snapshot", err);
  }
  return {
    messageCount: snapshot.messages.length,
    pendingCount: snapshot.pendingUiRequests.length,
  };
}

export function isInteractiveUiRequest(parsed: any): boolean {
  return (
    parsed?.type === "extension_ui_request" &&
    typeof parsed.id === "string" &&
    parsed.id.length > 0 &&
    (parsed.method === "select" || parsed.method === "confirm" || parsed.method === "input")
  );
}

export function recordPendingUiRequest(
  store: PendingUiRequestStore,
  parsed: any,
  raw: string,
  max = PENDING_UI_REQUESTS_MAX,
): boolean {
  if (store.replaying || !isInteractiveUiRequest(parsed)) return false;
  const id = parsed.id as string;
  if (store.pendingUiRequests.has(id)) {
    store.pendingUiRequests.delete(id);
  } else if (store.pendingUiRequests.size >= max) {
    const oldest = store.pendingUiRequests.keys().next().value;
    if (oldest !== undefined) store.pendingUiRequests.delete(oldest);
  }
  store.pendingUiRequests.set(id, raw);
  return true;
}

export function dismissPendingUiRequest(store: PendingUiRequestStore, id: unknown): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  return store.pendingUiRequests.delete(id);
}

export function clearPendingUiRequests(store: PendingUiRequestStore): number {
  const count = store.pendingUiRequests.size;
  store.pendingUiRequests.clear();
  return count;
}

export function snapshotPendingUiRequests(store: PendingUiRequestStore): string[] {
  return Array.from(store.pendingUiRequests.values());
}

export function processPiPendingUiEvent(
  client: PiClient,
  parsed: any,
  raw: string,
  sendToWatchers: (sessionId: string, eventOrRaw: object | string) => void,
): "recorded" | "dismissed" | null {
  let action: "recorded" | "dismissed" | null = null;
  if (recordPendingUiRequest(client, parsed, raw)) {
    action = "recorded";
  } else if (parsed?.type === "ui-dismiss" && dismissPendingUiRequest(client, parsed.id)) {
    action = "dismissed";
  }

  applyEventToViewState(client, parsed);

  sendToWatchers(client.session.sessionId, raw);
  return action;
}

export function forwardBrowserUiResponse(
  client: PiClient,
  parsed: any,
): Record<string, unknown> | null {
  if (parsed?.type !== "extension_ui_response" || !parsed.id || !client.ws) return null;
  const response: Record<string, unknown> = { type: "extension_ui_response", id: parsed.id };
  if (parsed.value !== undefined) response.value = parsed.value;
  if (parsed.confirmed !== undefined) response.confirmed = parsed.confirmed;
  if (parsed.cancelled) response.cancelled = true;
  client.ws.send(JSON.stringify(response));
  return response;
}

function registeredSession(parsed: any): SessionInfo {
  const activity = parsed.activity === "working" || parsed.activity === "waiting_for_input" ? parsed.activity : "idle";
  const streaming = typeof parsed.streaming === "boolean" ? parsed.streaming : false;
  return {
    sessionId: parsed.sessionId || `${parsed.pid}:${parsed.cwd}`,
    pid: parsed.pid,
    cwd: parsed.cwd || "",
    branch: parsed.branch || "",
    model: parsed.model || "",
    reasoning: typeof parsed.reasoning === "boolean" ? parsed.reasoning : undefined,
    // Explicit boolean: a model change to a text-only model must clear the flag,
    // not leave the previous model's capability behind (Qodo 3e547c6d).
    supportsImages: typeof parsed.supportsImages === "boolean" ? parsed.supportsImages : undefined,
    startedAt: parsed.startedAt || new Date().toISOString(),
    lastActivity: Date.now(),
    active: true,
    sessionFile: parsed.sessionFile || "",
    gitDirty: parsed.gitDirty || false,
    gitChanges: parsed.gitChanges || 0,
    container: parsed.container || false,
    ...(typeof parsed.containerName === "string" && parsed.containerName.trim() ? { containerName: parsed.containerName.trim() } : {}),
    contextWindow: parsed.contextWindow || 0,
    diffPort: parsed.diffPort || null,
    thinkingLevel: parsed.thinkingLevel || "medium",
    name: parsed.name || undefined,
    comsName: parsed.comsName || undefined,
    comsPurpose: parsed.comsPurpose || undefined,
    comsProject: parsed.comsProject || undefined,
    ...(parsed.supervisedPeer === true ? { supervisedPeer: true } : {}),
    ...(typeof parsed.parentSessionId === "string" && parsed.parentSessionId.trim()
      ? { parentSessionId: parsed.parentSessionId.trim() }
      : {}),
    trailTokenSavings: Number.isSafeInteger(parsed.trailTokenSavings) && parsed.trailTokenSavings >= 0 ? parsed.trailTokenSavings : undefined,
    worktreeCount: Number.isSafeInteger(parsed.worktreeCount) && parsed.worktreeCount >= 0 ? parsed.worktreeCount : undefined,
    worktreeDirtyCount: Number.isSafeInteger(parsed.worktreeDirtyCount) && parsed.worktreeDirtyCount >= 0 ? parsed.worktreeDirtyCount : undefined,
    inLinkedWorktree: typeof parsed.inLinkedWorktree === "boolean" ? parsed.inLinkedWorktree : undefined,
    ...initialActivityState(),
    activity,
    activitySequence: Number.isSafeInteger(parsed.activitySequence) ? parsed.activitySequence : 0,
    activityBeforePrompt: parsed.activityBeforePrompt === "working" || parsed.activityBeforePrompt === "waiting_for_input" || parsed.activityBeforePrompt === "idle" ? parsed.activityBeforePrompt : undefined,
    streaming,
    working: activity === "working",
  };
}

/**
 * Whether a model accepts image input.
 *
 * One helper for every payload that names a model (registration, update_info,
 * set-model, session switch) so the producer side is a single tested function
 * instead of four inline expressions (Qodo 24f50129).
 */
export function supportsImagesFor(model: { input?: unknown } | null | undefined): boolean {
  const supported = Array.isArray(model?.input) && model.input.includes("image");
  log.debug("model image support", { model: (model as { name?: string } | null)?.name ?? null, supported });
  return supported;
}

/**
 * The model fields every payload that names a model must carry.
 *
 * Extracted so the SESSION SWITCH producer — not just the consumer — is covered
 * by a test: a switch that omits the capability left the daemon holding the
 * previous model's value (Qodo 24f50129).
 */
export function modelInfoPayload(
  model: { name?: string; id?: string; input?: unknown; reasoning?: boolean; contextWindow?: number } | null | undefined,
): { model: string; supportsImages: boolean; reasoning: boolean; contextWindow: number } {
  return {
    model: model?.name || model?.id || "",
    supportsImages: supportsImagesFor(model),
    reasoning: model?.reasoning === true,
    contextWindow: model?.contextWindow || 0,
  };
}

export function registerPidashSession(
  sessions: Map<string, PiClient>,
  ws: any,
  parsed: any,
  broadcast: (event: object) => void,
): PiClient {
  const session = registeredSession(parsed);
  const currentPiSessionId = normalizePiSessionId(parsed?.piSessionId);
  const existing = sessions.get(session.sessionId);
  let client: PiClient;
  if (existing) {
    if (!session.supervisedPeer && existing.session.supervisedPeer && parsed.supervisedPeer !== false) {
      session.supervisedPeer = true;
    }
    const preserveSupervisedComs = session.supervisedPeer === true;
    if (!session.name && existing.session.name) session.name = existing.session.name;
    if (!session.comsName && (preserveSupervisedComs || parsed.comsName !== null) && existing.session.comsName) {
      session.comsName = existing.session.comsName;
    }
    if (!session.comsPurpose && (preserveSupervisedComs || parsed.comsPurpose !== null) && existing.session.comsPurpose) {
      session.comsPurpose = existing.session.comsPurpose;
    }
    if (!session.comsProject && (preserveSupervisedComs || parsed.comsProject !== null) && existing.session.comsProject) {
      session.comsProject = existing.session.comsProject;
    }
    if (!session.parentSessionId && existing.session.parentSessionId) {
      session.parentSessionId = existing.session.parentSessionId;
    }
    const preservedCommands = existing.viewState.availableCommands;
    existing.ws = ws;
    existing.session = session;
    existing.currentPiSessionId = currentPiSessionId;
    existing.viewState = createSessionViewState(session, preservedCommands);
    existing.pendingUiRequests.clear();
    existing.asyncStatusRunningIds = undefined;
    existing.asyncStatusAnonymousCount = 0;
    existing.replaying = true;
    existing.connectionGeneration++;
    client = existing;
  } else {
    client = {
      ws,
      session,
      currentPiSessionId,
      viewState: createSessionViewState(session),
      pendingUiRequests: new Map(),
      replaying: true,
      connectionGeneration: 1,
    };
  }
  sessions.set(session.sessionId, client);
  log.info(`session registered: session=${session.sessionId} streaming=${session.streaming}`);
  broadcast({ type: "session_added", session });
  return client;
}

export function updatePidashSession(session: SessionInfo, parsed: any): void {
  if (typeof parsed.reasoning === "boolean") session.reasoning = parsed.reasoning;
  if (typeof parsed.supportsImages === "boolean") session.supportsImages = parsed.supportsImages;
  if (parsed.trailTokenSavings !== undefined && Number.isSafeInteger(parsed.trailTokenSavings) && parsed.trailTokenSavings >= 0) {
    session.trailTokenSavings = parsed.trailTokenSavings;
  }
  if (parsed.worktreeCount !== undefined && Number.isSafeInteger(parsed.worktreeCount) && parsed.worktreeCount >= 0) {
    session.worktreeCount = parsed.worktreeCount;
  }
  if (parsed.worktreeDirtyCount !== undefined && Number.isSafeInteger(parsed.worktreeDirtyCount) && parsed.worktreeDirtyCount >= 0) {
    session.worktreeDirtyCount = parsed.worktreeDirtyCount;
  }
  if (typeof parsed.inLinkedWorktree === "boolean") {
    session.inLinkedWorktree = parsed.inLinkedWorktree;
  }
  session.lastActivity = Date.now();
}

export function disconnectPidashSession(
  client: PiClient,
  ws: any,
  source: "close" | "error",
  broadcast: (event: object) => void,
): void {
  if (client.ws !== ws) {
    log.debug(`stale connection ${source} ignored: session=${client.session.sessionId}`);
    return;
  }
  client.session.active = false;
  client.session.activity = "idle";
  client.session.activityBeforePrompt = undefined;
  client.session.streaming = false;
  client.session.working = false;
  client.session.runningAsyncAgents = 0;
  client.asyncStatusRunningIds = undefined;
  client.asyncStatusAnonymousCount = 0;
  client.viewState.streaming = false;
  dismissAllViewAsks(client.viewState);
  clearPendingUiRequests(client);
  client.ws = null;
  log.info(`session disconnected: session=${client.session.sessionId} source=${source}`);
  broadcast({ type: "session_updated", session: client.session });
}

export function createPidashSessionState(
  broadcast: (event: object) => void,
  sessions = new Map<string, PiClient>(),
) {
  log.debug(`session state created: sessions=${sessions.size}`);
  return {
    sessions,
    register: (ws: any, parsed: any) => registerPidashSession(sessions, ws, parsed, broadcast),
    disconnect: (client: PiClient, ws: any, source: "close" | "error") => disconnectPidashSession(client, ws, source, broadcast),
  };
}
