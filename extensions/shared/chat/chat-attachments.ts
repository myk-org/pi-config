/**
 * Attachment handling for the Discord bridge — pure classification, no I/O.
 *
 * The old code inlined text under 100KB but base64'd images of ANY size into
 * memory and pushed them over the socket, so a 25MB screenshot could take the
 * daemon down. Classification (and the caps) are decided here so tests can pin
 * the limits without a Discord connection or a network fetch.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.ts";

const log = createLogger("chat-attachments");

/** Text files are inlined into the prompt, so they stay small. */
export const MAX_INLINE_TEXT_BYTES = 100 * 1024;
/** Images are base64'd and shipped over the websocket — Discord's default cap. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Hard timeout for a Discord CDN fetch. */
export const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

const TEXT_EXTENSIONS = /\.(txt|log|md|markdown|json|jsonc|yaml|yml|toml|csv|tsv|xml|html|css|scss|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|go|java|kt|rs|rb|c|h|cpp|hpp|cs|php|sql|ini|cfg|conf|env|patch|diff|dockerfile|makefile)$/i;

export interface DiscordAttachmentMeta {
  url?: string;
  filename?: string;
  contentType?: string;
  size?: number;
}

export type AttachmentPlan =
  | { kind: "image"; filename: string; url: string; size: number }
  | { kind: "text"; filename: string; url: string; size: number }
  | { kind: "skipped-large"; filename: string; size: number; limit: number }
  | { kind: "skipped-binary"; filename: string; contentType: string; size: number }
  | { kind: "skipped-invalid"; reason: string };

function filenameOf(att: DiscordAttachmentMeta): string {
  return att.filename || "attachment";
}

/**
 * Decide what to do with one attachment.
 *
 * Order matters: an oversized image must NOT fall through to the "binary, not
 * included" branch, because the user needs to know it was too big rather than
 * that the type was unsupported.
 */
export function classifyAttachment(att: DiscordAttachmentMeta): AttachmentPlan {
  const filename = filenameOf(att);
  const contentType = att.contentType || "";
  const size = typeof att.size === "number" && Number.isFinite(att.size) ? att.size : 0;
  if (!att.url) return { kind: "skipped-invalid", reason: "missing url" };

  const isImage = contentType.startsWith("image/");
  if (isImage) {
    if (size > MAX_IMAGE_BYTES) {
      log.debug("image attachment too large", { filename, size, limit: MAX_IMAGE_BYTES });
      return { kind: "skipped-large", filename, size, limit: MAX_IMAGE_BYTES };
    }
    return { kind: "image", filename, url: att.url, size };
  }

  const isText = contentType.startsWith("text/") || TEXT_EXTENSIONS.test(filename);
  if (isText) {
    if (size > MAX_INLINE_TEXT_BYTES) {
      log.debug("text attachment too large", { filename, size, limit: MAX_INLINE_TEXT_BYTES });
      return { kind: "skipped-large", filename, size, limit: MAX_INLINE_TEXT_BYTES };
    }
    return { kind: "text", filename, url: att.url, size };
  }

  return { kind: "skipped-binary", filename, contentType: contentType || "unknown", size };
}

/** Human-readable note appended to the prompt for anything that is not inlined. */
export function describeSkippedAttachment(plan: AttachmentPlan): string | null {
  switch (plan.kind) {
    case "skipped-large":
      return `[Attached file: ${plan.filename} — ${formatKB(plan.size)} exceeds the ${formatKB(plan.limit)} limit and was not included]`;
    case "skipped-binary":
      return `[Attached file: ${plan.filename} (${plan.contentType}, ${formatKB(plan.size)}) — binary file, not included]`;
    case "skipped-invalid":
      return `[An attachment could not be read: ${plan.reason}]`;
    default:
      return null;
  }
}

export function formatKB(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Wrap a Discord CDN URL for a bounded fetch (no auth needed, but expiring). */
export async function fetchAttachment(
  url: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      log.warn("attachment fetch failed", { status: response.status });
      return null;
    }
    // The declared size is metadata the sender controls; the body is what
    // actually costs memory (Qodo e8310189).
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      log.warn("attachment body exceeds the cap", { declared, maxBytes });
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      log.warn("attachment body exceeded the cap after download", { size: buffer.length, maxBytes });
      return null;
    }
    return { buffer, contentType: response.headers.get("content-type") || "application/octet-stream" };
  } catch (error) {
    log.warn("attachment fetch error", { error: String(error) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What to tell the user when images arrive but the watched model cannot read
 * them.
 *
 * Without this the image was forwarded anyway and failed downstream, with the
 * prompt looking accepted. Returns `null` when images are fine.
 */
export function imageSupportNote(
  supportsImages: boolean | undefined,
  imageCount: number,
): string | null {
  if (imageCount <= 0) return null;
  if (supportsImages !== false) return null;
  return `[${imageCount} image${imageCount === 1 ? "" : "s"} not sent — the watched session's model does not accept image input]`;
}

/**
 * Keep a copy of an inbound attachment in the session workspace.
 *
 * An image sent from a phone is forwarded to the model as base64 and to nobody
 * else — the agent cannot open it with its own tools, re-read it later, or move
 * it into the repo. Writing a file fixes that: the prompt carries a real path.
 */
export function saveInboundAttachment(
  directory: string,
  filename: string,
  buffer: Buffer,
): string | null {
  try {
    const safe = filename
      .replace(/[\\/]+/g, "_")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 120) || "attachment";
    mkdirSync(directory, { recursive: true });
    const path = join(directory, safe);
    writeFileSync(path, buffer, { mode: 0o600 });
    log.debug("inbound attachment saved", { path, bytes: buffer.length });
    return path;
  } catch (error) {
    log.warn("could not save inbound attachment", { filename, error: String(error) });
    return null;
  }
}
