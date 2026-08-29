/**
 * Queue recovery contracts shared by the P2P queue tools and optional RPC hosts.
 * Recovery is intentionally two-step: callers must retain a previewId from inspect
 * and pass it to a destructive operation. Message text never belongs in a preview.
 */
export type QueueRecoveryOutcome = "supported" | "unavailable" | "malformed" | "partial" | "failure" | "success";
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
  return {
    outcome: cleared.length === ids.length ? "success" : "partial",
    cleared,
    untouched,
    ...(cleared.length === ids.length ? {} : { reason: "Some previewed queue items no longer exist" }),
  };
}

export interface RpcQueueRecoveryProvider {
  /** Read-only host adapter. Pi RPC hosts may expose this alongside clear_queue. */
  previewQueue?(): Promise<unknown>;
  /** Host adapter for Pi RPC's clear_queue command. */
  clearQueue(): Promise<unknown>;
}

/** Classifies a host-supplied, read-only RPC queue preview without retaining text. */
export async function previewRpcQueue(provider: RpcQueueRecoveryProvider | undefined): Promise<QueueRecoveryPreview> {
  if (!provider?.previewQueue) return { outcome: "unavailable", provider: "rpc", previewId: "", items: [], reason: "RPC queue preview is unavailable" };
  try {
    const response = await provider.previewQueue();
    if (!response || typeof response !== "object" || !Array.isArray((response as any).steering) || !Array.isArray((response as any).followUp)
      || !(response as any).steering.every((item: unknown) => typeof item === "string")
      || !(response as any).followUp.every((item: unknown) => typeof item === "string")) {
      return { outcome: "malformed", provider: "rpc", previewId: "", items: [], reason: "Malformed RPC queue preview" };
    }
    return buildQueuePreview("rpc", [
      ...rpcItems("steering", (response as any).steering),
      ...rpcItems("follow_up", (response as any).followUp),
    ]);
  } catch (error) {
    return { outcome: "unavailable", provider: "rpc", previewId: "", items: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

export function buildQueuePreview(
  provider: "local" | "rpc",
  items: QueueRecoveryItem[],
  now = Date.now(),
  previewId = `queue-preview-${now}`,
): QueueRecoveryPreview {
  return {
    outcome: "supported",
    provider,
    previewId,
    items: items.map(item => ({ ...item, ageMs: Math.max(0, now - Date.parse(item.queuedAt)) })),
  };
}

function rpcItems(kind: "steering" | "follow_up", messages: string[]): QueueRecoveryItem[] {
  const queuedAt = new Date(0).toISOString();
  return messages.map((_message, index) => ({
    id: `${kind}-${index + 1}`,
    sender: "pi-rpc",
    target: "local",
    queuedAt,
    position: index + 1,
    deliveryState: "queued",
  }));
}

/** Classifies only a completed, explicit Pi RPC clear_queue response. */
export async function clearRpcQueue(provider: RpcQueueRecoveryProvider | undefined, _previewId: string): Promise<QueueRecoveryResult> {
  if (!provider) {
    return { outcome: "unavailable", cleared: [], untouched: [], reason: "RPC queue recovery is unavailable" };
  }
  try {
    const response = await provider.clearQueue();
    if (!response || typeof response !== "object" || !Array.isArray((response as any).steering) || !Array.isArray((response as any).followUp)
      || !(response as any).steering.every((item: unknown) => typeof item === "string")
      || !(response as any).followUp.every((item: unknown) => typeof item === "string")) {
      return { outcome: "malformed", cleared: [], untouched: [], reason: "Malformed clear_queue response" };
    }
    const cleared = [
      ...rpcItems("steering", (response as any).steering),
      ...rpcItems("follow_up", (response as any).followUp),
    ];
    return { outcome: "success", cleared, untouched: [] };
  } catch (error) {
    return { outcome: "failure", cleared: [], untouched: [], reason: error instanceof Error ? error.message : String(error) };
  }
}
