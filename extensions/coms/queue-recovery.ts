/**
 * Queue recovery contracts shared by the P2P queue tools and optional RPC hosts.
 * Recovery is intentionally two-step: callers must retain a previewId from inspect
 * and pass it to a destructive operation. Message text never belongs in a preview.
 */
import { createHash } from "node:crypto";
import { createLogger } from "../shared/logger.js";

const log = createLogger("coms");
export const RPC_RECOVERY_PREVIEW_TTL_MS = 5 * 60 * 1000;
export const MAX_RPC_RECOVERY_PREVIEWS_PER_PROVIDER = 20;

interface RpcPreviewRecord {
  snapshot: string;
  items: QueueRecoveryItem[];
  expiresAt: number;
}

const rpcPreviews = new WeakMap<RpcQueueRecoveryProvider, Map<string, RpcPreviewRecord>>();
let rpcPreviewSequence = 0;

export type QueueRecoveryOutcome = "supported" | "unavailable" | "malformed" | "partial" | "failure" | "success" | "invalid_preview" | "stale_preview" | "indeterminate";
export type QueueDeliveryState = "queued" | "processing" | "pending_reply" | "timed_out";

export interface QueueRecoveryItem {
  id: string;
  sender: string;
  target: string;
  queuedAt: string;
  position: number;
  deliveryState: QueueDeliveryState;
}

export interface QueuePreviewItem extends QueueRecoveryItem {
  ageMs: number;
}

export interface QueueRecoveryPreview {
  outcome: "supported" | "unavailable" | "malformed";
  provider: "local" | "rpc";
  previewId: string;
  items: QueuePreviewItem[];
  reason?: string;
}

/** Body-free audit record returned when a host may have cleared before returning malformed data. */
export interface QueueRecoveryAttempt {
  snapshot: string;
  items: QueueRecoveryItem[];
}

export interface QueueRecoveryResult {
  outcome: Exclude<QueueRecoveryOutcome, "supported">;
  cleared: QueueRecoveryItem[];
  untouched: QueueRecoveryItem[];
  attempted?: QueueRecoveryAttempt;
  reason?: string;
}

export function clearLocalQueue(items: QueueRecoveryItem[], ids: readonly string[]): QueueRecoveryResult {
  const selected = new Set(ids);
  const cleared = items.filter(item => selected.has(item.id));
  const untouched = items.filter(item => !selected.has(item.id));
  const outcome = cleared.length === ids.length ? "success" : "partial";
  log.debug("recovery_local_classified", { requested: ids.length, cleared: cleared.length, outcome });
  return {
    outcome,
    cleared,
    untouched,
    ...(outcome === "success" ? {} : { reason: "Some previewed queue items no longer exist" }),
  };
}

export interface RpcQueueRecoveryProvider {
  /** Read-only host adapter. Pi RPC hosts may expose this alongside conditional clearing. */
  previewQueue?(): Promise<unknown>;
  /**
   * Atomically compare the supplied body-free snapshot with the host queue and clear only on a match.
   * Return `{ outcome: "stale_preview" }` on mismatch; otherwise return the cleared queue response.
   */
  clearQueueIfSnapshot(expectedSnapshot: string): Promise<unknown>;
}

function validRpcQueue(response: unknown): response is { steering: string[]; followUp: string[] } {
  return !!response && typeof response === "object" && Array.isArray((response as any).steering) && Array.isArray((response as any).followUp)
    && (response as any).steering.every((item: unknown) => typeof item === "string")
    && (response as any).followUp.every((item: unknown) => typeof item === "string");
}

function writeFrame(hash: ReturnType<typeof createHash>, value: string | number): void {
  const bytes = Buffer.from(typeof value === "number" ? String(value) : value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length).update(bytes);
}

/** Returns a SHA-256 digest of explicit UTF-8 length-framed queue fields, never message text. */
export function rpcQueueSnapshot(response: unknown): string | undefined {
  if (!validRpcQueue(response)) {
    log.warn("recovery_rpc_malformed", { operation: "snapshot" });
    return undefined;
  }
  const hash = createHash("sha256");
  writeFrame(hash, "pi-config.rpc-queue.v1");
  for (const [kind, messages] of [["steering", response.steering], ["follow_up", response.followUp]] as const) {
    writeFrame(hash, kind);
    writeFrame(hash, messages.length);
    for (const message of messages) writeFrame(hash, message);
  }
  const snapshot = `sha256:${hash.digest("hex")}`;
  log.debug("recovery_rpc_snapshot", { steering: response.steering.length, followUp: response.followUp.length });
  return snapshot;
}

function pruneRpcPreviews(previews: Map<string, RpcPreviewRecord>, now: number): void {
  for (const [previewId, preview] of previews) if (preview.expiresAt <= now) previews.delete(previewId);
}

function retainRpcPreview(provider: RpcQueueRecoveryProvider, previewId: string, snapshot: string, items: QueueRecoveryItem[], now: number): void {
  const previews = rpcPreviews.get(provider) ?? new Map<string, RpcPreviewRecord>();
  pruneRpcPreviews(previews, now);
  while (previews.size >= MAX_RPC_RECOVERY_PREVIEWS_PER_PROVIDER) previews.delete(previews.keys().next().value!);
  previews.set(previewId, { snapshot, items, expiresAt: now + RPC_RECOVERY_PREVIEW_TTL_MS });
  rpcPreviews.set(provider, previews);
  log.debug("recovery_rpc_preview_retained", { active: previews.size, count: items.length });
}

/** Classifies a host-supplied, read-only RPC queue preview without retaining text in its result. */
export async function previewRpcQueue(provider: RpcQueueRecoveryProvider | undefined, now = Date.now()): Promise<QueueRecoveryPreview> {
  if (!provider?.previewQueue) {
    log.warn("recovery_rpc_preview_unavailable", { operation: "preview" });
    return { outcome: "unavailable", provider: "rpc", previewId: "", items: [], reason: "RPC queue preview is unavailable" };
  }
  try {
    const response = await provider.previewQueue();
    const snapshot = rpcQueueSnapshot(response);
    if (!snapshot || !validRpcQueue(response)) return { outcome: "malformed", provider: "rpc", previewId: "", items: [], reason: "Malformed RPC queue preview" };
    const queueItems = [...rpcItems("steering", response.steering), ...rpcItems("follow_up", response.followUp)];
    const preview = buildQueuePreview("rpc", queueItems, now, `rpc-queue-preview-${now}-${++rpcPreviewSequence}`);
    retainRpcPreview(provider, preview.previewId, snapshot, queueItems, now);
    log.info("recovery_rpc_preview", { operation: "preview", count: preview.items.length });
    return preview;
  } catch (error) {
    log.error("recovery_rpc_preview_failed", { operation: "preview", reason: error instanceof Error ? error.message : String(error) });
    return { outcome: "unavailable", provider: "rpc", previewId: "", items: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

export function buildQueuePreview(provider: "local" | "rpc", items: QueueRecoveryItem[], now = Date.now(), previewId = `queue-preview-${now}`): QueueRecoveryPreview {
  log.debug("recovery_preview_built", { provider, count: items.length });
  return { outcome: "supported", provider, previewId, items: items.map(item => ({ ...item, ageMs: Math.max(0, now - Date.parse(item.queuedAt)) })) };
}

function rpcItems(kind: "steering" | "follow_up", messages: string[]): QueueRecoveryItem[] {
  const queuedAt = new Date(0).toISOString();
  log.debug("recovery_rpc_items", { kind, count: messages.length });
  return messages.map((_message, index) => ({ id: `${kind}-${index + 1}`, sender: "pi-rpc", target: "local", queuedAt, position: index + 1, deliveryState: "queued" }));
}

/** Clears only the exact RPC queue snapshot represented by a live preview token. */
export async function clearRpcQueue(provider: RpcQueueRecoveryProvider | undefined, previewId: string, now = Date.now()): Promise<QueueRecoveryResult> {
  if (!provider) {
    log.warn("recovery_rpc_clear_unavailable", { operation: "clear" });
    return { outcome: "unavailable", cleared: [], untouched: [], reason: "RPC queue recovery is unavailable" };
  }
  const previews = rpcPreviews.get(provider);
  if (previews) pruneRpcPreviews(previews, now);
  const preview = previewId ? previews?.get(previewId) : undefined;
  if (!preview) {
    log.warn("recovery_rpc_clear_denied", { operation: "clear", reason: "invalid_preview" });
    return { outcome: "invalid_preview", cleared: [], untouched: [], reason: "A valid RPC queue preview is required" };
  }
  previews?.delete(previewId);
  try {
    const response = await provider.clearQueueIfSnapshot(preview.snapshot);
    if (response && typeof response === "object" && (response as any).outcome === "stale_preview") {
      log.warn("recovery_rpc_clear_denied", { operation: "clear", reason: "stale_preview" });
      return { outcome: "stale_preview", cleared: [], untouched: [], reason: "RPC queue changed after preview" };
    }
    if (!validRpcQueue(response)) {
      log.warn("recovery_rpc_clear_indeterminate", { operation: "clear", attempted: preview.items.length });
      return { outcome: "indeterminate", cleared: [], untouched: [], attempted: { snapshot: preview.snapshot, items: preview.items }, reason: "Host clear response was malformed after an attempted clear" };
    }
    log.info("recovery_rpc_clear", { operation: "clear", outcome: "success", cleared: preview.items.length });
    return { outcome: "success", cleared: preview.items, untouched: [] };
  } catch (error) {
    log.error("recovery_rpc_clear_failed", { operation: "clear", reason: error instanceof Error ? error.message : String(error) });
    return { outcome: "failure", cleared: [], untouched: [], reason: error instanceof Error ? error.message : String(error) };
  }
}
