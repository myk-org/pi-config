/**
 * Queue recovery contracts shared by the P2P queue tools and optional RPC hosts.
 * Recovery is intentionally two-step: callers must retain a previewId from inspect
 * and pass it to a destructive operation. Message text never belongs in a preview.
 */
import { createLogger } from "../shared/logger.js";

const log = createLogger("coms");
const rpcPreviews = new WeakMap<RpcQueueRecoveryProvider, Map<string, string>>();
let rpcPreviewSequence = 0;

export type QueueRecoveryOutcome = "supported" | "unavailable" | "malformed" | "partial" | "failure" | "success" | "invalid_preview" | "stale_preview";
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

export interface QueueRecoveryResult {
  outcome: Exclude<QueueRecoveryOutcome, "supported">;
  cleared: QueueRecoveryItem[];
  untouched: QueueRecoveryItem[];
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
  /** Read-only host adapter. Pi RPC hosts may expose this alongside clear_queue. */
  previewQueue?(): Promise<unknown>;
  /** Host adapter for Pi RPC's clear_queue command. */
  clearQueue(): Promise<unknown>;
}

function rpcSnapshot(response: unknown): string | undefined {
  if (!response || typeof response !== "object" || !Array.isArray((response as any).steering) || !Array.isArray((response as any).followUp)
    || !(response as any).steering.every((item: unknown) => typeof item === "string")
    || !(response as any).followUp.every((item: unknown) => typeof item === "string")) {
    log.warn("recovery_rpc_malformed", { operation: "preview" });
    return undefined;
  }
  const snapshot = JSON.stringify({
    steering: (response as any).steering.map(messageFingerprint),
    followUp: (response as any).followUp.map(messageFingerprint),
  });
  log.debug("recovery_rpc_snapshot", { steering: (response as any).steering.length, followUp: (response as any).followUp.length });
  return snapshot;
}

function messageFingerprint(message: string): string {
  let hash = 2166136261;
  for (let index = 0; index < message.length; index++) hash = Math.imul(hash ^ message.charCodeAt(index), 16777619);
  const fingerprint = `${message.length}:${(hash >>> 0).toString(16)}`;
  log.debug("recovery_rpc_message_fingerprinted", { length: message.length });
  return fingerprint;
}

/** Classifies a host-supplied, read-only RPC queue preview without retaining text in its result. */
export async function previewRpcQueue(provider: RpcQueueRecoveryProvider | undefined): Promise<QueueRecoveryPreview> {
  if (!provider?.previewQueue) {
    log.warn("recovery_rpc_preview_unavailable", { operation: "preview" });
    return { outcome: "unavailable", provider: "rpc", previewId: "", items: [], reason: "RPC queue preview is unavailable" };
  }
  try {
    const response = await provider.previewQueue();
    const snapshot = rpcSnapshot(response);
    if (!snapshot) return { outcome: "malformed", provider: "rpc", previewId: "", items: [], reason: "Malformed RPC queue preview" };
    const preview = buildQueuePreview("rpc", [
      ...rpcItems("steering", (response as any).steering),
      ...rpcItems("follow_up", (response as any).followUp),
    ], Date.now(), `rpc-queue-preview-${Date.now()}-${++rpcPreviewSequence}`);
    const previews = rpcPreviews.get(provider) ?? new Map<string, string>();
    previews.set(preview.previewId, snapshot);
    rpcPreviews.set(provider, previews);
    log.info("recovery_rpc_preview", { operation: "preview", count: preview.items.length });
    return preview;
  } catch (error) {
    log.error("recovery_rpc_preview_failed", { operation: "preview", reason: error instanceof Error ? error.message : String(error) });
    return { outcome: "unavailable", provider: "rpc", previewId: "", items: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

export function buildQueuePreview(
  provider: "local" | "rpc",
  items: QueueRecoveryItem[],
  now = Date.now(),
  previewId = `queue-preview-${now}`,
): QueueRecoveryPreview {
  log.debug("recovery_preview_built", { provider, count: items.length });
  return {
    outcome: "supported",
    provider,
    previewId,
    items: items.map(item => ({ ...item, ageMs: Math.max(0, now - Date.parse(item.queuedAt)) })),
  };
}

function rpcItems(kind: "steering" | "follow_up", messages: string[]): QueueRecoveryItem[] {
  const queuedAt = new Date(0).toISOString();
  log.debug("recovery_rpc_items", { kind, count: messages.length });
  return messages.map((_message, index) => ({
    id: `${kind}-${index + 1}`,
    sender: "pi-rpc",
    target: "local",
    queuedAt,
    position: index + 1,
    deliveryState: "queued",
  }));
}

/** Clears only the exact RPC queue snapshot represented by a previously issued preview token. */
export async function clearRpcQueue(provider: RpcQueueRecoveryProvider | undefined, previewId: string): Promise<QueueRecoveryResult> {
  if (!provider) {
    log.warn("recovery_rpc_clear_unavailable", { operation: "clear" });
    return { outcome: "unavailable", cleared: [], untouched: [], reason: "RPC queue recovery is unavailable" };
  }
  const previews = rpcPreviews.get(provider);
  const expectedSnapshot = previewId ? previews?.get(previewId) : undefined;
  if (!expectedSnapshot) {
    log.warn("recovery_rpc_clear_denied", { operation: "clear", reason: "invalid_preview" });
    return { outcome: "invalid_preview", cleared: [], untouched: [], reason: "A valid RPC queue preview is required" };
  }
  try {
    const currentSnapshot = rpcSnapshot(await provider.previewQueue?.());
    if (currentSnapshot !== expectedSnapshot) {
      previews?.delete(previewId);
      log.warn("recovery_rpc_clear_denied", { operation: "clear", reason: "stale_preview" });
      return { outcome: "stale_preview", cleared: [], untouched: [], reason: "RPC queue changed after preview" };
    }
    previews?.delete(previewId);
    const response = await provider.clearQueue();
    const snapshot = rpcSnapshot(response);
    if (!snapshot) return { outcome: "malformed", cleared: [], untouched: [], reason: "Malformed clear_queue response" };
    const cleared = [
      ...rpcItems("steering", (response as any).steering),
      ...rpcItems("follow_up", (response as any).followUp),
    ];
    log.info("recovery_rpc_clear", { operation: "clear", outcome: "success", cleared: cleared.length });
    return { outcome: "success", cleared, untouched: [] };
  } catch (error) {
    log.error("recovery_rpc_clear_failed", { operation: "clear", reason: error instanceof Error ? error.message : String(error) });
    return { outcome: "failure", cleared: [], untouched: [], reason: error instanceof Error ? error.message : String(error) };
  }
}
