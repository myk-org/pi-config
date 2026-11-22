import type { SessionInfo } from "../extensions/shared/types.ts";
import { initialActivityState } from "../extensions/pidash/activity-state.ts";
import { createLogger } from "../extensions/shared/logger.ts";

const log = createLogger("pidash");

export const EVENT_BUFFER_MAX = 10000;
export const EVENT_BUFFER_TRIM_AT = 12000;
export const PENDING_UI_REQUESTS_MAX = 50;

/**
 * Append a serialized event to a bounded buffer using amortized trimming
 * (O(1) amortized instead of O(N) Array.shift() on every delta once full).
 */
export function appendEventBuffer(
  buffer: string[],
  raw: string,
  max = EVENT_BUFFER_MAX,
  trimAt = EVENT_BUFFER_TRIM_AT,
): void {
  buffer.push(raw);
  if (buffer.length >= trimAt) {
    buffer.splice(0, buffer.length - max);
  }
}

export interface PiClient {
  ws: any;
  session: SessionInfo;
  eventBuffer: string[];
  pendingUiRequests: Map<string, string>;
  replaying: boolean;
  connectionGeneration: number;
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
  client: PiClient,
  parsed: any,
  raw: string,
  max = PENDING_UI_REQUESTS_MAX,
): boolean {
  if (client.replaying || !isInteractiveUiRequest(parsed)) return false;
  const id = parsed.id as string;
  if (client.pendingUiRequests.has(id)) {
    client.pendingUiRequests.delete(id);
  } else if (client.pendingUiRequests.size >= max) {
    const oldest = client.pendingUiRequests.keys().next().value;
    if (oldest !== undefined) client.pendingUiRequests.delete(oldest);
  }
  client.pendingUiRequests.set(id, raw);
  return true;
}

export function dismissPendingUiRequest(client: PiClient, id: unknown): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  return client.pendingUiRequests.delete(id);
}

export function clearPendingUiRequests(client: PiClient): number {
  const count = client.pendingUiRequests.size;
  client.pendingUiRequests.clear();
  return count;
}

export function snapshotPendingUiRequests(client: PiClient): string[] {
  return Array.from(client.pendingUiRequests.values());
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
    contextWindow: parsed.contextWindow || 0,
    diffPort: parsed.diffPort || null,
    thinkingLevel: parsed.thinkingLevel || "medium",
    name: parsed.name || undefined,
    comsName: parsed.comsName || undefined,
    comsPurpose: parsed.comsPurpose || undefined,
    comsProject: parsed.comsProject || undefined,
    trailTokenSavings: Number.isSafeInteger(parsed.trailTokenSavings) && parsed.trailTokenSavings >= 0 ? parsed.trailTokenSavings : undefined,
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
  const existing = sessions.get(session.sessionId);
  let client: PiClient;
  if (existing) {
    if (!session.name && existing.session.name) session.name = existing.session.name;
    if (!session.comsName && existing.session.comsName) session.comsName = existing.session.comsName;
    if (!session.comsPurpose && existing.session.comsPurpose) session.comsPurpose = existing.session.comsPurpose;
    if (!session.comsProject && existing.session.comsProject) session.comsProject = existing.session.comsProject;
    existing.ws = ws;
    existing.session = session;
    existing.eventBuffer = [];
    existing.pendingUiRequests.clear();
    existing.replaying = true;
    existing.connectionGeneration++;
    client = existing;
  } else {
    client = { ws, session, eventBuffer: [], pendingUiRequests: new Map(), replaying: true, connectionGeneration: 1 };
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
