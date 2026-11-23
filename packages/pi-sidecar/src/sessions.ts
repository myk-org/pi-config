import { randomUUID } from "node:crypto";

import { createLogger, logger } from "./logger.js";
import {
  DEFAULT_TOOLS,
  type CreateSessionOptions,
  type DiscoveredModel,
  type DiscoveredProvider,
  type HttpError,
  type KeyScopedModelsResult,
  type ProviderRuntime,
  type ProviderStatus,
  type StoredSession,
  PiProviderRuntime,
  createApiKeyRedactor,
  httpError,
  isValidApiKey,
  redactDiagnostic,
  redactorHoldback,
  redactorLiteralHoldback,
} from "./provider-runtime.js";
import {
  drainTranscriptWrites,
  maybeEnforceRetention,
  queueLazySessionHeader,
  queueTurn,
  transcriptUsage,
  transcriptsEnabled,
  writeSessionHeader,
  type TurnHeaderGuard,
} from "./transcripts.js";

// Re-export runtime/config helpers and types for backwards-compatible callers.
export {
  DEFAULT_TOOLS,
  HEADLESS_EXCLUDED_PROVIDERS,
  INTERNAL_AGENT_DIR,
  PiProviderRuntime,
  createApiKeyRedactor,
  createSessionSettingsManager,
  hasKnownPricing,
  isValidApiKey,
  logUnreportedRuntimeDiagnostics,
  readSettingsSeed,
  readTrustedKeyScopedProviders,
  redactApiKey,
  redactDiagnostic,
  redactorHoldback,
  redactorLiteralHoldback,
  resolveExt,
  resolveExtensionPath,
  resolveExtensionPathDetailed,
  resolveInternalAgentDir,
  snapshotLegacyAmbientProviders,
  type CreateRuntimeSessionInput,
  type CreateSessionOptions,
  type CreatedRuntimeSession,
  type CustomToolConfig,
  type DiscoveredModel,
  type DiscoveredProvider,
  type InternalRuntimeHandle,
  type KeyScopedModel,
  type KeyScopedModelsResult,
  type ManifestModelSnapshot,
  type PiProviderRuntimeOptions,
  type ProviderRuntime,
  type ProviderStatus,
  type ResolveResult,
  type StoredSession,
  type TrustedProviderSnapshot,
} from "./provider-runtime.js";

const sessionStoreLog = createLogger("session-store");
const sessionStoreInitLog = createLogger("session-store-init");
const sessionCreateLog = createLogger("session-create");
const streamLog = createLogger("session-streams");

/** Max bytes one subscriber may leave buffered before it is dropped (#1019). */
const MAX_PENDING_BYTES = 1_048_576;
const STREAM_KEEPALIVE_MS = 15_000;
const STREAM_IDLE_MS = 10 * 60 * 1000;
/** Per-session SSE feed ceiling (#1019). */
export const MAX_STREAMS_PER_SESSION = 8;
/** Process-wide SSE feed ceiling — POST /sessions is unauthenticated, so
 *  per-session caps alone let one client create N sessions × 8 streams. */
export const MAX_STREAMS_GLOBAL = 32;

/**
 * Transport sink for one `GET /sessions/:id/events` subscriber (#1019). The
 * hub owns framing, caps and timers; the route owns the HTTP response.
 */
export interface SessionStreamSink {
  write(frame: string): void;
  /** Bytes the transport still has buffered — the bounded-queue check. */
  bufferedBytes(): number;
  /** Close the stream from the server side. */
  end(): void;
}

/** One frame pushed to `GET /sessions/:id/events`; `type` is the event name. */
export type SessionStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "turn_start"; turnId: number }
  | { type: "text_delta"; turnId: number; delta: string }
  | { type: "turn_end"; turnId: number; text: string; aborted: boolean }
  | { type: "error"; turnId: number; message: string };

interface StreamSubscriber {
  sink: SessionStreamSink;
  keepalive?: ReturnType<typeof setInterval>;
  idle?: ReturnType<typeof setTimeout>;
}

/**
 * One SSE frame. Frames are JSON-serialized: raw model output contains
 * newlines, so an unescaped payload would let a delta forge its own `data:`
 * frames.
 */
function sseFrame(event: SessionStreamEvent): string {
  return "data: " + JSON.stringify(event) + "\n\n";
}

/**
 * Per-session SSE hub (#1019) — one instance per SessionEntry, so a feed can
 * never outlive or alias its session: every removal path closes it. Every
 * subscriber write is contained — a dead or slow client is dropped here and
 * never surfaces into the prompt path that produced the event.
 */
export class SessionEventStreams {
  private subscribers = new Set<StreamSubscriber>();
  private turnSeq = 0;
  private _attachGeneration = 0;

  get size(): number {
    return this.subscribers.size;
  }

  /** Incremented whenever subscribers transitions 0 -> 1 so active turns detect attach/re-attach. */
  get attachGeneration(): number {
    return this._attachGeneration;
  }

  /** Monotonic per-session turn id. */
  nextTurnId(): number {
    return ++this.turnSeq;
  }

  /**
   * Register a subscriber and return its detach function. `greeting` is written
   * to that subscriber only — broadcasting it would hand already-open feeds a
   * duplicate `session` frame and reset their idle timers.
   */
  add(sink: SessionStreamSink, greeting?: SessionStreamEvent): () => void {
    const sub: StreamSubscriber = { sink };
    // Keepalive comments stop proxies from closing an idle feed. They must NOT
    // reset the idle timer — otherwise a subscribe-only client is never reaped.
    sub.keepalive = setInterval(() => this.write(sub, ": keepalive\n\n"), STREAM_KEEPALIVE_MS);
    sub.idle = setTimeout(() => this.drop(sub, "idle_timeout"), STREAM_IDLE_MS);
    sub.keepalive.unref?.();
    sub.idle.unref?.();
    if (this.subscribers.size === 0) this._attachGeneration++;
    this.subscribers.add(sub);
    if (greeting) this.write(sub, sseFrame(greeting));
    return () => this.drop(sub, "detached");
  }

  /** Push one turn-lifecycle event to every subscriber. */
  emit(event: SessionStreamEvent): void {
    if (this.subscribers.size === 0) return;
    const frame = sseFrame(event);
    for (const sub of [...this.subscribers]) {
      sub.idle?.refresh(); // lifecycle events only — see add()
      this.write(sub, frame);
    }
  }

  /** Close every subscriber (session removed, shutdown). */
  close(reason: string): void {
    for (const sub of [...this.subscribers]) this.drop(sub, reason);
  }

  private write(sub: StreamSubscriber, frame: string): void {
    try {
      sub.sink.write(frame);
      if (sub.sink.bufferedBytes() <= MAX_PENDING_BYTES) return;
    } catch {
      // A throwing sink must never fail the prompt that produced the event.
      this.drop(sub, "write_failed");
      return;
    }
    this.drop(sub, "slow_subscriber");
  }

  private drop(sub: StreamSubscriber, reason: string): void {
    if (!this.subscribers.delete(sub)) return;
    if (sub.keepalive) clearInterval(sub.keepalive);
    if (sub.idle) clearTimeout(sub.idle);
    let pending = 0;
    try {
      pending = sub.sink.bufferedBytes();
    } catch {
      // sink already dead — nothing to measure
    }
    try {
      sub.sink.end();
    } catch {
      // connection already gone
    }
    streamLog.info(`[sidecar] STREAM_CLOSED: reason=${reason}, subscribers=${this.subscribers.size}, pending_bytes=${pending}`);
  }
}

/**
 * Bounded per-turn delta redaction holdback (#1019 / #1161).
 *
 * A per-delta redact cannot see a key split across two deltas, so each turn
 * keeps the tail of its already-redacted text pending and emits only what is
 * at least `hold` characters behind it — while a key is still incomplete it
 * starts inside the pending window, so it is always whole when redacted.
 *
 * Skips holdback buffering and per-delta redaction when no SSE subscribers are
 * attached (`streams.size === 0`); on mid-turn attach/re-attach, seeds from
 * the pre-attach tail so a key spanning the attach boundary is redacted without
 * emitting pre-attach text.
 */
export class StreamDeltaHoldback {
  private readonly hold: number;
  private readonly literalHold: number;
  private heldText = "";
  private preAttachSafePrefix = "";
  private seenAttachGen: number;

  constructor(
    private readonly redact: (value: string) => string,
    private readonly streams: Pick<SessionEventStreams, "size" | "attachGeneration" | "emit">,
    private readonly turnId: number,
  ) {
    this.hold = redactorHoldback(redact);
    this.literalHold = redactorLiteralHoldback(redact);
    this.seenAttachGen = streams.attachGeneration;
  }

  pushDelta(delta: string, fullResponseText: string, prevLen: number): void {
    if (this.streams.size > 0) {
      if (this.streams.attachGeneration !== this.seenAttachGen) {
        this.seenAttachGen = this.streams.attachGeneration;
        if (prevLen > 0 && this.hold > 0) {
          const preTail = fullResponseText.slice(Math.max(0, prevLen - this.hold), prevLen);
          this.preAttachSafePrefix = this.redact(preTail);
          this.heldText = this.preAttachSafePrefix + delta;
        } else {
          this.preAttachSafePrefix = "";
          this.heldText = delta;
        }
      } else {
        this.heldText += delta;
      }
      this.emitHeldText(false);
    } else if (this.heldText !== "" || this.preAttachSafePrefix !== "") {
      this.heldText = "";
      this.preAttachSafePrefix = "";
    }
  }

  flush(): void {
    this.emitHeldText(true);
  }

  private emitHeldText(flush: boolean): void {
    if (this.streams.size === 0) {
      this.heldText = "";
      this.preAttachSafePrefix = "";
      return;
    }
    if (this.streams.attachGeneration !== this.seenAttachGen) {
      // Subscriber attached (or re-attached after detach) during a quiet gap:
      // discard any stale holdback left over from an earlier subscriber.
      this.seenAttachGen = this.streams.attachGeneration;
      this.heldText = "";
      this.preAttachSafePrefix = "";
      return;
    }
    if (this.heldText === "") return;
    const safe = this.redact(this.heldText);
    if (this.preAttachSafePrefix && !safe.startsWith(this.preAttachSafePrefix)) {
      // Post-attach text completed a key that started inside the pre-attach tail:
      // keep only the common prefix before the new [REDACTED] token as pre-attach skip.
      let lcp = 0;
      const minLen = Math.min(this.preAttachSafePrefix.length, safe.length);
      while (lcp < minLen && this.preAttachSafePrefix.charCodeAt(lcp) === safe.charCodeAt(lcp)) lcp++;
      const markerStart = Math.max(0, lcp - "[REDACTED]".length + 1);
      for (let k = markerStart; k <= lcp; k++) {
        if (safe.startsWith("[REDACTED]", k) && !this.preAttachSafePrefix.startsWith("[REDACTED]", k)) {
          lcp = k;
          break;
        }
      }
      this.preAttachSafePrefix = this.preAttachSafePrefix.slice(0, lcp);
    }
    const window = this.hold > this.literalHold && /[%\\]/.test(safe.slice(-this.hold)) ? this.hold : this.literalHold;
    const cut = flush ? safe.length : Math.max(0, safe.length - window);
    if (cut <= this.preAttachSafePrefix.length) {
      this.preAttachSafePrefix = this.preAttachSafePrefix.slice(cut);
      this.heldText = safe.slice(cut);
      return;
    }
    const deltaOut = safe.slice(this.preAttachSafePrefix.length, cut);
    this.preAttachSafePrefix = "";
    this.heldText = safe.slice(cut);
    if (deltaOut.length > 0) this.streams.emit({ type: "text_delta", turnId: this.turnId, delta: deltaOut });
  }
}

interface SessionEntry {
  session: StoredSession;
  lastActivity: number;
  inFlight: boolean;
  cwd: string;
  redact: (value: string) => string;
  /** 1-based count of prompts sent to this session — the transcript turn number. */
  turnCount: number;
  /**
   * Transcript header state (#935): the create-time header payload (kept so
   * the header can be written lazily when recording is enabled mid-session)
   * and whether it has been written yet. The disabled path stays zero-cost —
   * one object reference and a boolean per session.
   */
  transcriptHeader: {
    sessionId: string;
    provider: string;
    model: string;
    systemPrompt?: string;
    cwd?: string;
    customTools?: string[];
    /** Session open time — a lazily written header must not report the first
     *  recorded turn's time as the session's creation time (Qodo 8597d8f7). */
    createdAt: string;
    redact: (value: string) => string;
  };
  headerWritten: boolean;
  /**
   * Synchronous in-flight marker for the lazy header write: set the moment
   * the fire-and-forget write is queued, so a fast-failing prompt followed
   * by another prompt cannot queue a second header while the first append
   * is still pending (Qodo 14c6e560).
   */
  headerPending: boolean;
  /**
   * Whether the session's model carries real prices. Pi requires numeric prices,
   * so a model whose source published none (key-scoped listing, openai-compatible
   * discovery without a catalog price) uses zeros for "unknown pricing", not
   * "free"; those models carry the PRICING_UNKNOWN marker. Reporting that as $0
   * makes unknown spend look free to consumers (e.g. rootcoz), so usage cost
   * stays null instead. A catalog zero is authoritative and reported as free.
   */
  pricingKnown: boolean;
  /** SSE feed hub for this entry (#1019) — dies with the session. */
  streams: SessionEventStreams;
  /**
   * Abort bookkeeping for the turn in flight (#1019). `requested` is set by
   * abort() before it awaits session.abort() and consumed by the prompt path's
   * finally, which is the only place a turn ends on abort — emitting from
   * abort() itself would double-emit the terminal event. `pending` counts the
   * aborts still awaiting the SDK and `succeeded` records that one of them
   * cancelled the turn, so a concurrent abort's rejection cannot clear
   * `requested` while another abort is still in flight.
   */
  abortState: { requested: boolean; pending: number; succeeded: boolean };
}

export interface SessionStoreOptions {
  agentDir?: string;
  /**
   * Provider-runtime adapter owning SDK lifecycle, model discovery, and session
   * instantiation. Defaults to `PiProviderRuntime`.
   */
  runtime?: ProviderRuntime;
}

export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private readonly runtime: ProviderRuntime;

  /**
   * Runtime recording override (#935) — INSTANCE state, not module state:
   * two sidecar servers in one process must not share the toggle, and a
   * closed server must not leave its override behind for a later instance.
   * `undefined` means no override; the boot-time env value governs. Set via
   * POST /transcripts/recording, cleared via /transcripts/recording/reset.
   * In-memory only: a restart restores the env default by design.
   */
  private recordingOverride: boolean | undefined;

  /**
   * Set at the very start of disposeAll(), before any session or the runtime
   * adapter is torn down. Once true, create()/prompt()/abort()/openStream()/
   * getProviders()/getModels()/refreshModels()/getProviderStatus()/
   * getModelsForApiKey() reject immediately instead of racing teardown.
   */
  private _disposed = false;

  constructor(options?: SessionStoreOptions) {
    this.runtime = options?.runtime ?? new PiProviderRuntime({ agentDir: options?.agentDir });
    sessionStoreInitLog.debug("SessionStore constructed", {
      customRuntime: Boolean(options?.runtime),
    });
  }

  /** Set the runtime override; takes effect for subsequent turns. */
  setRecordingOverride(enabled: boolean): void {
    this.recordingOverride = enabled;
    sessionStoreLog.info(`transcript recording override set: enabled=${enabled}`);
  }

  /** Drop the runtime override; the env default governs again. */
  clearRecordingOverride(): void {
    if (this.recordingOverride === undefined) {
      sessionStoreLog.debug("transcript recording override cleared: no override was set");
      return;
    }
    this.recordingOverride = undefined;
    sessionStoreLog.info("transcript recording override cleared; env default restored");
  }

  /** Effective recording state, with whether it comes from env or override. */
  recordingState(): { enabled: boolean; source: "env" | "override" } {
    return {
      enabled: this.isRecordingEnabled(),
      source: this.recordingOverride === undefined ? "env" : "override",
    };
  }

  /** Env default OR this store's runtime override. */
  isRecordingEnabled(): boolean {
    const enabled = this.recordingOverride ?? transcriptsEnabled();
    sessionStoreLog.debug(`recording decision: enabled=${enabled}, source=${this.recordingOverride === undefined ? "env" : "override"}`);
    return enabled;
  }

  /** Redact only the credential owned by this session. Never expose it to the registrar or other sessions. */
  redactSessionValue(id: string, value: string): string {
    const redact = this.sessions.get(id)?.redact ?? ((text: string) => text);
    return redactDiagnostic(value, redact);
  }

  get disposed(): boolean {
    return this._disposed;
  }

  private assertNotDisposed(action: string): void {
    if (this._disposed) {
      throw httpError(`SessionStore is shutting down; ${action} is no longer available`, 503);
    }
  }

  get ready(): boolean {
    return this.runtime.ready;
  }

  get discoveryError(): string | null {
    return this.runtime.discoveryError;
  }

  count(): number {
    return this.sessions.size;
  }

  /** Active SSE subscriber count for one session, or process-wide when `id` is omitted. */
  streamCount(id?: string): number {
    if (id !== undefined) return this.sessions.get(id)?.streams.size ?? 0;
    let total = 0;
    for (const entry of this.sessions.values()) total += entry.streams.size;
    return total;
  }

  /**
   * Open an SSE feed for a session (#1019). Rejections throw before the caller
   * writes any header, so they stay plain JSON: unknown session → 404, stream
   * ceilings → 429.
   */
  assertStreamAllowed(id: string): void {
    this.assertNotDisposed("openStream");
    const entry = this.sessions.get(id);
    if (!entry) throw httpError(`Session ${id} not found`, 404);
    if (entry.streams.size >= MAX_STREAMS_PER_SESSION) {
      throw httpError(`Too many event streams for this session (max ${MAX_STREAMS_PER_SESSION})`, 429);
    }
    if (this.streamCount() >= MAX_STREAMS_GLOBAL) {
      throw httpError(`Too many event streams (max ${MAX_STREAMS_GLOBAL})`, 429);
    }
  }

  /**
   * Register the subscriber and send the opening `session` frame. Call only
   * AFTER the SSE headers are written (a body write before `writeHead` commits
   * implicit headers). The caller has already run assertStreamAllowed, and
   * there is no await in between, so its ceilings still hold.
   */
  openStream(id: string, sink: SessionStreamSink): () => void {
    this.assertStreamAllowed(id);
    const entry = this.sessions.get(id)!;
    const detach = entry.streams.add(sink, { type: "session", sessionId: id });
    streamLog.info(`[sidecar] STREAM_OPEN: subscribers=${entry.streams.size}`);
    return detach;
  }

  /**
   * Close every open SSE feed without touching sessions (#1019). Shutdown
   * calls this before it waits for connections to drain — an open stream would
   * otherwise stall the drain to its timeout.
   */
  closeAllStreams(): void {
    let count = 0;
    for (const entry of this.sessions.values()) {
      count += entry.streams.size;
      entry.streams.close("shutdown");
    }
    if (count > 0) streamLog.info(`[sidecar] STREAMS_CLOSED: reason=shutdown, count=${count}`);
  }

  /** List registered runtime provider IDs without model discovery or auth checks. */
  async getProviders(): Promise<DiscoveredProvider[]> {
    this.assertNotDisposed("getProviders");
    return this.runtime.getProviders();
  }

  /** List models from all configured providers. */
  async getModels(): Promise<DiscoveredModel[]> {
    this.assertNotDisposed("getModels");
    return this.runtime.getModels();
  }

  /** Discover models from all configured providers. Blocks until complete. */
  async refreshModels(): Promise<DiscoveredModel[]> {
    this.assertNotDisposed("refreshModels");
    return this.runtime.refreshModels();
  }

  /** Auth/registration/model-count snapshot for one provider (GET /models/:provider/status). */
  async getProviderStatus(provider: string): Promise<ProviderStatus> {
    this.assertNotDisposed("getProviderStatus");
    return this.runtime.getProviderStatus(provider);
  }

  /** Query the provider with this request's key, never the shared model registry. */
  async getModelsForApiKey(providerId: string, apiKey: string): Promise<KeyScopedModelsResult> {
    if (!isValidApiKey(apiKey) || typeof providerId !== "string" || !providerId.trim()) {
      throw httpError("Invalid provider or api_key", 400);
    }
    this.assertNotDisposed("getModelsForApiKey");
    return this.runtime.getModelsForApiKey(providerId, apiKey);
  }

  async create(options: CreateSessionOptions): Promise<string> {
    const apiKey = options.apiKey;
    if (apiKey !== undefined && !isValidApiKey(apiKey)) { // pragma: allowlist secret — field validation, not a credential
      throw httpError("api_key must be a non-empty string with well-formed Unicode and at most 1024 characters", 400);
    }
    const redact = createApiKeyRedactor(apiKey);
    const id = randomUUID();
    try {
      this.assertNotDisposed("create");
      const created = await this.runtime.createSession({ sessionId: id, options, redact });

      // Re-check after awaits: disposeAll() may have run while we were creating.
      // Discard the orphan session instead of leaking it past shutdown.
      if (this._disposed) {
        try {
          created.session.dispose();
        } catch (err) {
          sessionCreateLog.warn(`[sidecar] SESSION_ORPHAN_DISPOSE_FAILED: session=${id}, error=${redactDiagnostic(err instanceof Error ? err.message : String(err), redact)}`);
        }
        throw httpError("Sidecar is shutting down", 503);
      }

      const tools = options.tools ?? [...DEFAULT_TOOLS];
      const transcriptHeader = {
        sessionId: id,
        provider: options.provider,
        model: options.model,
        systemPrompt: options.systemPrompt,
        cwd: options.cwd,
        customTools: created.customToolNames,
        createdAt: new Date().toISOString(),
        redact,
      };
      const newEntry: SessionEntry = {
        session: created.session,
        lastActivity: Date.now(),
        inFlight: false,
        cwd: options.cwd,
        redact,
        pricingKnown: created.pricingKnown,
        turnCount: 0,
        transcriptHeader,
        headerWritten: false,
        headerPending: false,
        streams: new SessionEventStreams(),
        abortState: { requested: false, pending: 0, succeeded: false },
      };
      this.sessions.set(id, newEntry);
      sessionCreateLog.info(`[sidecar] Session created: ${id} (provider=${redactDiagnostic(options.provider, redact)}, model=${redactDiagnostic(options.model, redact)}, tools=${tools.length}, customTools=${created.customToolNames.length})`);
      // Transcript recording (issue #922) — OFF unless RECORD_TRANSCRIPTS is
      // truthy (or the #935 runtime override is set); the header write is
      // fail-soft and awaited so it precedes any turn record for this session.
      // When recording is disabled at creation, the header is written lazily on
      // the first recorded turn (prompt()) so enabling mid-session still
      // produces a well-formed file. The active-session snapshot is taken
      // BEFORE the awaited write so a concurrent delete cannot make this
      // session's fresh file retention-eligible mid-write; headerWritten is
      // set only when the line actually appended (a swallowed failure retries
      // on the next recorded turn). The entry is held by reference, not
      // re-fetched from the map — disposeAll() during the await must not turn
      // this into a TypeError (Qodo 7a9c1405).
      if (this.isRecordingEnabled()) {
        const activeIds = new Set(this.sessions.keys());
        newEntry.headerWritten = await writeSessionHeader(transcriptHeader);
        maybeEnforceRetention(activeIds);
      }
      return id;
    } catch (err) {
      const message = redactDiagnostic(err instanceof Error ? err.message : String(err), redact);
      sessionCreateLog.error(`[sidecar] Session creation rejected: session=${id}, error=${message}, stack=${redactDiagnostic(err instanceof Error ? err.stack ?? err.message : String(err), redact)}`);
      throw httpError(message, (err as HttpError)?.statusCode ?? 500, err);
    }
  }

  async prompt(id: string, message: string): Promise<{ text: string; usage: any; error?: string; stop_reason: string | null }> {
    this.assertNotDisposed("prompt");
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`Session ${id} not found`);

    if (entry.inFlight) {
      throw new Error(`Session ${id} is busy — concurrent prompts are not supported`);
    }

    entry.lastActivity = Date.now();
    entry.inFlight = true;
    // #1019: one monotonic turn id per prompt. The single terminal event for
    // it is emitted from this turn's finally (rejected prompt) or from the
    // post-redaction tail below — never from the recordTurn-gated sites.
    // Reset here, not at turn end, so an abort still settling from the previous
    // turn cannot clear a request made for this one.
    entry.abortState = { requested: false, pending: 0, succeeded: false };
    const turnId = entry.streams.nextTurnId();
    entry.streams.emit({ type: "turn_start", turnId });
    // Transcript turn state is mutated only when recording is enabled — the
    // disabled path stays zero-overhead (#923 review).
    const recordTurn = this.isRecordingEnabled();
    let turnNumber = 0;
    // Shared header guard (#935): used by the lazy fire below and by both
    // queueTurn sites, so header bookkeeping is identical everywhere. The
    // markWritten callback also clears headerPending — safe from the turn
    // slot's inline retry, where it is already false.
    const headerGuard: TurnHeaderGuard = {
      header: entry.transcriptHeader,
      isWritten: () => entry.headerWritten,
      markWritten: (appended) => {
        entry.headerWritten = appended;
        entry.headerPending = false;
      },
    };
    if (recordTurn) {
      entry.turnCount += 1;
      turnNumber = entry.turnCount;
      // Lazy header (#935): recording was enabled after this session was
      // created, so its header was never written — queue it now. FIRE-AND-
      // FORGET with in-slot bookkeeping: the chain orders header-before-turn
      // and updates the guard state inside the slot (no microtask lag for
      // the turn slot's inline check), and NOT awaiting removes the window
      // where abort()/delete()/disposeAll() could land between inFlight =
      // true and session.prompt (Qodo ed714b22). A failed write leaves
      // headerWritten false — the turn slot retries inline and skips the
      // turn if the retry fails, keeping the file header-first (Qodo
      // 7dad2203); the next recorded turn retries again (Qodo 5ab0db39).
      // Retention uses the synchronous pre-write active-session snapshot so
      // a concurrent delete cannot prune this session's fresh header
      // mid-flight (Qodo 4d913b74).
      if (!entry.headerWritten && !entry.headerPending) {
        entry.headerPending = true;
        queueLazySessionHeader(headerGuard, new Set(this.sessions.keys()));
      }
    }
    let turnWasRecorded = false;
    // Captured at agent_end; the turn record is QUEUED only after the response
    // is fully assembled (boundary separators applied, redaction, final
    // duration) so the transcript's final_text matches the returned text.
    let turnMessages: unknown[] | null = null;
    let turnStopReason: string | undefined;
    // Set when the prompt rejected but partial state was still returned. The
    // turn is recorded as `error` (see the catch below), so the response body
    // must report the same value instead of `null`.
    let turnRejected = false;

    logger.log(`[sidecar] Prompt started: session=${id}, message_length=${message.length}, cwd=${redactDiagnostic(entry.cwd, entry.redact)}`);

    const MAX_CAPTURED_ERRORS = 10;
    const errors: string[] = [];
    let errorsDropped = 0;
    const pushError = (rawMessage: string): string => {
      const redacted = redactDiagnostic(rawMessage, entry.redact);
      if (errors.length < MAX_CAPTURED_ERRORS) {
        errors.push(redacted);
      } else {
        errorsDropped++;
      }
      return redacted;
    };
    const formatErrors = (): string => errors.join("; ") + (errorsDropped > 0 ? ` [+${errorsDropped} more]` : "");
    let responseText = "";
    let textDeltaCount = 0;
    let assistantMessageCount = 0;
    const messageBoundaries: number[] = [];
    // cost_partial marks a total that is a floor, not a sum: at least one turn's
    // cost was withheld as unknown while another turn contributed a real amount.
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null as number | null, cost_partial: false, duration_ms: 0 };
    const startTime = Date.now();

    // #1019: terminal-event state. `turnAborted` is captured outside the
    // recordTurn gate so abort works on a default (recording-off) config.
    let turnAborted = false;
    // Set when the prompt rejects with nothing to return: that throw skips the
    // post-redaction tail, so the finally ends the turn instead.
    let promptRejected: string | undefined;
    let turnEnded = false;
    const holdback = new StreamDeltaHoldback(entry.redact, entry.streams, turnId);
    const emitTurnEnd = (aborted: boolean) => {
      if (turnEnded) return;
      turnEnded = true;
      // Nothing may be lost to the holdback: the withheld tail goes out as the
      // last text_delta(s) before the terminal event, so the client still ends
      // with the whole text.
      holdback.flush();
      // Abort wins over collected errors: a cancelled turn must end as
      // turn_end{aborted:true}, never as an error. Text is redacted here too so
      // the abort path (pre-tail) cannot leak what the final redaction would strip.
      let terminal: SessionStreamEvent;
      if (aborted) {
        terminal = { type: "turn_end", turnId, text: entry.redact(responseText), aborted: true };
      } else if (promptRejected !== undefined || errors.length > 0) {
        terminal = {
          type: "error",
          turnId,
          message: promptRejected ?? formatErrors(),
        };
      } else {
        terminal = { type: "turn_end", turnId, text: responseText, aborted: false };
      }
      // The one place a turn ends, so it is also the only way to tell from the
      // logs which terminal branch a turnId took.
      streamLog.info(`[sidecar] STREAM_TURN_END: session=${id}, turn=${turnId}, event=${terminal.type}, aborted=${aborted}, subscribers=${entry.streams.size}`);
      entry.streams.emit(terminal);
    };

    const unsubscribe = entry.session.subscribe((event) => {
      // Pi SDK event types don't export the error variant — cast is necessary
      if ((event as any).type === "error") {
        const errPayload = (event as any).error;
        let errorMsg: string;
        if (typeof errPayload === "string") {
          errorMsg = errPayload;
        } else if (errPayload?.message) {
          errorMsg = errPayload.message;
        } else {
          try {
            errorMsg = JSON.stringify(errPayload);
          } catch {
            errorMsg = "[unstringifiable error]";
          }
        }
        const redactedError = pushError(errorMsg);
        logger.error(`[sidecar] Prompt error event: session=${id}, error=${redactedError}`);
      }
      // Track assistant message boundaries via message_start events.
      // Using message_start instead of object reference comparison because some
      // providers (e.g., Vertex Claude) create new message objects per streaming chunk.
      if (event.type === "message_start" && (event as any).message?.role === "assistant") {
        assistantMessageCount++;
        if (assistantMessageCount > 1 && responseText.length > 0) {
          // Deduplicate: skip if same offset as last boundary (tool-only messages produce no text)
          const lastBoundary = messageBoundaries.length > 0 ? messageBoundaries[messageBoundaries.length - 1] : -1;
          if (responseText.length !== lastBoundary) {
            messageBoundaries.push(responseText.length);
            logger.debug(`[sidecar] MSG_BOUNDARY: session=${id}, deltas=${textDeltaCount}`);
          }
        }
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const prevLen = responseText.length;
        responseText += event.assistantMessageEvent.delta;
        textDeltaCount++;
        holdback.pushDelta(event.assistantMessageEvent.delta, responseText, prevLen);
      }
      if (event.type === "agent_end" && event.messages) {
        for (const msg of event.messages) {
          if (msg.role === "assistant" && msg.usage) {
            usage.input_tokens += msg.usage.input || 0;
            usage.output_tokens += msg.usage.output || 0;
            usage.cache_read_tokens += msg.usage.cacheRead || 0;
            usage.cache_write_tokens += msg.usage.cacheWrite || 0;
            const reported = msg.usage.cost?.total;
            // pi 1.5.0 marks a provider-billed total: the driver knows what it
            // charged, so even a billed zero is authoritative and an unknown
            // catalog price cannot turn it into unknown spend.
            const billed = msg.usage.cost?.totalFromProvider === true;
            // A model with unknown pricing reports zeros, but a provider can still
            // know the real turn cost.
            // Only discard a reported *zero*; never discard a positive total.
            if (reported != null && (billed || entry.pricingKnown || reported > 0)) {
              usage.cost_usd = (usage.cost_usd ?? 0) + reported;
              if (billed && !entry.pricingKnown) {
                logger.debug(
                  `[sidecar] COST_BILLED: session=${id}, reportedTotal=${reported}, pricingKnown=false`,
                );
              }
            } else {
              // Either the turn reported a zero we cannot price, or it reported no
              // cost at all. Both leave this turn's spend unknown, so any total
              // accumulated from the other turns is a lower bound, not a sum.
              usage.cost_partial = true;
              logger.debug(
                `[sidecar] COST_UNKNOWN: session=${id}, reportedTotal=${reported}, fromProvider=${billed}, pricingKnown=${entry.pricingKnown}`,
              );
            }
          }
        }

        let finalAssistant: Extract<(typeof event.messages)[number], { role: "assistant" }> | undefined;
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const msg = event.messages[i];
          if (msg.role === "assistant") {
            finalAssistant = msg;
            break;
          }
        }
        if (finalAssistant?.stopReason === "error" && finalAssistant.errorMessage) {
          pushError(finalAssistant.errorMessage);
        }

        // Fallback: if no text_delta was captured, extract from final assistant message
        if (!responseText) {
          const msgSummary = event.messages.map((m: any) => {
            const contentTypes = Array.isArray(m.content)
              ? m.content.map((c: any) => c.type).join(",")
              : typeof m.content;
            return `${m.role}(${contentTypes})`;
          }).join(" → ");
          logger.warn(`[sidecar] No text_delta events captured (${textDeltaCount} deltas). Messages: ${msgSummary}. Extracting from agent_end messages`);
          for (let i = event.messages.length - 1; i >= 0; i--) {
            const msg = event.messages[i];
            if (msg.role === "assistant" && msg.content) {
              const textContent = Array.isArray(msg.content)
                ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
                : typeof msg.content === "string" ? msg.content : "";
              if (textContent) {
                responseText = textContent;
                break;
              }
            }
          }
        }

        // Transcript recording (issue #922): capture the turn payload here;
        // the record itself is queued after the response is fully assembled
        // (see below — boundary processing must not diverge from final_text).
        // #1019: captured outside the recordTurn gate so an SDK-initiated
        // abort still ends the turn as `aborted` with recording disabled.
        turnStopReason = finalAssistant?.stopReason;
        if (recordTurn) {
          turnWasRecorded = true;
          turnMessages = event.messages;
        }
      }
    });

    try {
      await entry.session.prompt(message);
    } catch (err: any) {
      logger.error(`[sidecar] Prompt failed: session=${id}, error=${redactDiagnostic(err?.message || String(err), entry.redact)}, stack=${redactDiagnostic(err instanceof Error ? err.stack ?? err.message : String(err), entry.redact)}`);
      // Transcript fallback (#923 review): a prompt that rejects without an
      // agent_end event must still leave a record of the attempt — the
      // submitted user prompt, partial output, collected errors plus the
      // rejection error, usage, and the assigned turn number — so offline
      // analysis sees failed turns too. Fail-soft like every transcript write.
      if (recordTurn && !turnWasRecorded) {
        const rejectionError = redactDiagnostic(err?.message || "Prompt rejected", entry.redact);
        queueTurn({
          sessionId: id,
          turnNumber,
          messages: [{ role: "user", content: [{ type: "text", text: message }] }],
          usage: transcriptUsage({ ...usage, duration_ms: Date.now() - startTime }),
          stopReason: "error",
          finalText: responseText || undefined,
          errors: [rejectionError, ...errors].slice(0, 10),
          redact: entry.redact,
          ensureHeader: headerGuard,
        });
        maybeEnforceRetention(new Set(this.sessions.keys()));
      }
      // If we captured partial text or error events before the rejection,
      // return structured data instead of throwing — preserves partial state for callers
      if (responseText || errors.length > 0) {
        pushError(err?.message || "Prompt rejected");
        turnRejected = true;
        // fall through to structured return below
      } else {
        promptRejected = redactDiagnostic(err?.message || String(err), entry.redact);
        throw httpError(promptRejected, err?.statusCode ?? 500, err);
      }
    } finally {
      unsubscribe();
      entry.inFlight = false;
      entry.lastActivity = Date.now();
      // #1019: clear into `aborted` here — abort() itself never emits. A
      // rejected prompt never reaches the post-redaction tail, so its terminal
      // event is emitted here; the success/fall-through path emits below with
      // the final text. emitTurnEnd's guard keeps it to exactly one.
      turnAborted = entry.abortState.requested;
      entry.abortState.requested = false;
      if (promptRejected !== undefined) emitTurnEnd(turnAborted);
    }

    // Insert \n\n at message boundaries for text responses only.
    // JSON responses must not be modified — the separator would corrupt structured data.
    if (messageBoundaries.length > 0 && responseText.length > 0) {
      // Cheap pre-check: only attempt JSON.parse if response looks like JSON
      const trimmed = responseText.trim();
      const looksLikeJson = (trimmed.charCodeAt(0) === 123 /* { */ && trimmed.charCodeAt(trimmed.length - 1) === 125 /* } */) ||
                            (trimmed.charCodeAt(0) === 91  /* [ */ && trimmed.charCodeAt(trimmed.length - 1) === 93  /* ] */);
      let isJson = false;
      if (looksLikeJson) {
        try {
          JSON.parse(responseText);
          isJson = true;
        } catch {
          // Looks like JSON but isn't — treat as text
        }
      }
      if (!isJson) {
        // Find balanced `{...}` / `[...]` spans in a single O(N) pass, stopping once
        // past the last boundary with no open spans left to close.
        const lastBoundary = messageBoundaries[messageBoundaries.length - 1];
        const openers: number[] = [];
        const matchEnd = new Map<number, number>();
        const curlyStack: number[] = [];
        const bracketStack: number[] = [];
        let inStr = false;
        let esc = false;
        for (let i = 0; i < responseText.length; i++) {
          if (i >= lastBoundary && curlyStack.length === 0 && bracketStack.length === 0) break;
          const ch = responseText.charCodeAt(i);
          if (esc) { esc = false; continue; }
          if (ch === 92 /* \ */) { esc = true; continue; }
          if (ch === 34 /* " */) { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === 123 /* { */) {
            if (i < lastBoundary) openers.push(i);
            curlyStack.push(i);
          } else if (ch === 125 /* } */) {
            const open = curlyStack.pop();
            if (open !== undefined && open < lastBoundary) matchEnd.set(open, i + 1);
          } else if (ch === 91 /* [ */) {
            if (i < lastBoundary) openers.push(i);
            bracketStack.push(i);
          } else if (ch === 93 /* ] */) {
            const open = bracketStack.pop();
            if (open !== undefined && open < lastBoundary) matchEnd.set(open, i + 1);
          }
        }

        const jsonRegions: Array<[number, number]> = [];
        let skipUntil = 0;
        for (const si of openers) {
          if (si < skipUntil) continue;
          const ei = matchEnd.get(si);
          if (ei === undefined) continue;
          // Only protect if a boundary actually falls inside this region
          const hasRelevantBoundary = messageBoundaries.some((b) => b > si && b < ei);
          if (hasRelevantBoundary) {
            try {
              JSON.parse(responseText.slice(si, ei));
              jsonRegions.push([si, ei]);
              skipUntil = ei; // skip past valid JSON region only
            } catch {
              // Balanced but not valid JSON — don't skip, inner regions may be valid
            }
          } else {
            skipUntil = ei; // no boundaries inside, safe to skip
          }
        }

        // Insert \n\n at boundaries that don't fall inside JSON regions
        const parts: string[] = [];
        let prev = 0;
        let applied = 0;
        for (const pos of messageBoundaries) {
          const insideJson = jsonRegions.some(([start, end]) => pos > start && pos < end);
          if (!insideJson) {
            parts.push(responseText.slice(prev, pos));
            prev = pos;
            applied++;
          }
        }
        parts.push(responseText.slice(prev));
        responseText = parts.join("\n\n");
        logger.debug(`[sidecar] MSG_BOUNDARIES_APPLIED: session=${id}, applied=${applied}, skipped=${messageBoundaries.length - applied}`);
      } else {
        logger.debug(`[sidecar] MSG_BOUNDARIES_SKIPPED: session=${id}, count=${messageBoundaries.length}, reason=json_response`);
      }
    }

    responseText = entry.redact(responseText);
    // #1019: turn_end carries the final text — read after the boundary splice
    // and redaction, so it is authoritative and not concat(deltas).
    emitTurnEnd(turnAborted || turnStopReason === "aborted");
    usage.duration_ms = Date.now() - startTime;
    logger.log(`[sidecar] PROMPT_COMPLETED: session=${id}, text_length=${responseText.length}, deltas=${textDeltaCount}, tokens_in=${usage.input_tokens}, tokens_out=${usage.output_tokens}, duration_ms=${usage.duration_ms}`);

    // Transcript recording (issue #922): queue the turn NOW — after boundary
    // separators, redaction, and the final duration — so the record's
    // final_text is exactly the text returned to the caller. Queued on the
    // session's ordered write chain; heavy work is deferred off this path
    // inside appendTurn. Usage is mapped to the documented schema names;
    // collected SDK errors are included alongside the response.
    if (recordTurn && turnMessages) {
      queueTurn({
        sessionId: id,
        turnNumber,
        messages: turnMessages,
        usage: transcriptUsage(usage),
        stopReason: turnStopReason,
        finalText: responseText,
        errors: errors.length > 0 ? [...errors] : undefined,
        redact: entry.redact,
        ensureHeader: headerGuard,
      });
      maybeEnforceRetention(new Set(this.sessions.keys()));
    }

    // A rejected turn was recorded as `error`; null would make the body
    // contradict its own transcript.
    const stopReason = turnRejected ? "error" : turnStopReason ?? null;

    // If we got errors from the AI, surface them
    if (errors.length > 0) {
      const errorText = formatErrors();
      logger.error(`[sidecar] Prompt completed with errors: session=${id}, errors=${errorText}`);
      return { text: responseText, usage, error: errorText, stop_reason: stopReason };
    }

    // Empty text is valid for tool-only responses — warn but don't error
    if (!responseText) {
      logger.warn(`[sidecar] AI returned empty text: session=${id}, tokens_in=${usage.input_tokens}, tokens_out=${usage.output_tokens}`);
    }

    return { text: responseText, usage, stop_reason: stopReason };
  }

  async abort(id: string): Promise<void> {
    this.assertNotDisposed("abort");
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`Session ${id} not found`);
    // #1019: nothing to abort — marking an idle session aborted would flag the
    // NEXT turn as aborted.
    if (!entry.inFlight) return;
    logger.debug(`[sidecar] Aborting session: ${id}, inFlight=${entry.inFlight}`);
    // Set before awaiting: the prompt path's finally reads it after
    // session.abort() settles. Emitting here would duplicate the terminal event.
    // The state is held by reference, not re-read from entry.abortState after
    // the await: prompt() replaces that object when the next turn starts, so a
    // late settle from an earlier turn would otherwise clear the NEW turn's
    // flag and report a real cancellation as `aborted: false` (Qodo). A stale
    // object is simply discarded at the turn boundary — the new turn always
    // starts with a fresh state.
    const state = entry.abortState;
    state.requested = true;
    state.pending++;
    try {
      await entry.session.abort();
      // A cancel that landed keeps the turn flagged, whatever another
      // in-flight abort does later.
      state.succeeded = true;
    } catch (err) {
      // The turn is still running — but only if no other abort is pending and
      // none already cancelled it: clearing the flag here is what let a
      // concurrent rejection hide a real cancellation.
      state.pending = Math.max(0, state.pending - 1);
      if (state.pending === 0 && !state.succeeded) state.requested = false;
      throw err;
    }
    state.pending = Math.max(0, state.pending - 1);
    logger.info(`[sidecar] Session aborted: ${id}`);
  }

  /** Disposes only the user AgentSession — never the provider runtime adapter. */
  delete(id: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry) {
      logger.debug(`[sidecar] SESSION_DELETE: result=no-op, session=${id}, reason=not_found`);
      return false;
    }
    entry.streams.close("session_deleted");
    entry.session.dispose();
    this.sessions.delete(id);
    logger.log(`[sidecar] SESSION_DELETE: result=disposed, session=${id}`);
    return true;
  }

  /**
   * Dispose all user sessions, then the provider runtime adapter — in that order.
   * User sessions' `AgentSession.dispose()` does not emit `session_shutdown`
   * and is safe at any time. The runtime adapter's `dispose()` tears down the
   * internal registrar runtime (which emits `session_shutdown`), so it must run
   * after user sessions are gone.
   *
   * Sets `_disposed = true` as the very first step, before any teardown work
   * runs, so concurrent/in-flight callers start rejecting immediately instead
   * of racing teardown. Idempotent — safe to call more than once.
   */
  async disposeAll(): Promise<void> {
    this._disposed = true;

    let count = 0;
    for (const [id, entry] of this.sessions) {
      logger.log(`[sidecar] SESSION_DISPOSE: session=${id}`);
      try {
        entry.streams.close("disposed");
        entry.session.dispose();
      } catch (err) {
        logger.warn(`[sidecar] SESSION_DISPOSE_FAILED: session=${id}`, err);
      }
      count++;
    }
    this.sessions.clear();
    logger.info(`[sidecar] SESSIONS_DISPOSED: count=${count}`);

    await this.runtime.dispose();

    // Drain outstanding transcript writes LAST (#923 review): sessions are
    // disposed above, so fallback records queued by disposal-rejected prompts
    // are already in flight; the drain re-snapshots until the chains settle
    // (bounded at 10s, warn-logged on timeout — never reported as success).
    await drainTranscriptWrites();
  }

  cleanupStale(maxAge: number): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, entry] of this.sessions) {
      if (entry.inFlight) continue;
      if (now - entry.lastActivity > maxAge) {
        logger.log(`[sidecar] Cleaning up stale session: ${id}`);
        entry.streams.close("session_stale");
        entry.session.dispose();
        this.sessions.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info(`[sidecar] Stale session cleanup: removed ${cleaned} session(s), ${this.sessions.size} remaining`);
    } else {
      logger.debug(`[sidecar] Stale session cleanup: none stale, ${this.sessions.size} active`);
    }
    return cleaned;
  }
}
