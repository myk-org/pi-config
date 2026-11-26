/**
 * Session JSONL spill & content-addressed blob externalization (issue #1420).
 *
 * Keeps session `.jsonl` files lean by:
 * 1. Writing oversized text tool results to `<sessionFile-without-.jsonl>/local/<N>.log`
 *    (falling back to `${PROJECT_TMP_DIR}/session-local/<sessionId>/` when `--no-session`),
 *    replacing the inline text with a bounded head/tail preview + exact spill path.
 * 2. Externalizing oversized or duplicate binary image payloads in tool results into
 *    a content-addressed global blob store (`~/.pi/blobs/<sha256>` plus a typed `.ext`
 *    sidecar when the MIME type is known).
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createLogger, type Logger } from "../shared/logger.js";
import { getSetting } from "./project-settings.js";
import { getProjectTmpDir } from "./utils.js";

const defaultLog = createLogger("orchestrator");

/** Default raw decoded byte threshold above which a first-time image is externalized (512 KiB). */
export const DEFAULT_IMAGE_BLOB_THRESHOLD_BYTES = 512 * 1024;

const DEFAULT_PREVIEW_HEAD_CHARS = 4000;
const DEFAULT_PREVIEW_TAIL_CHARS = 2000;
const MAX_SPILL_ALLOC_ATTEMPTS = 10_000;
const MAX_TRACKED_SPILL_DIRS = 128;

const SPILL_MARKER_RE = /\[output truncated: (\d+) chars \((\d+) lines\) — full output saved to: ([^\n\]]+?) — use read\(path, offset, limit\) to inspect\]/;

const MIME_TO_EXT: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/avif": ".avif",
  "application/pdf": ".pdf",
};

export interface SessionSpillLocation {
  dir: string;
  persistent: boolean;
}

export interface SpillWriteResult {
  path: string;
  bytes: number;
  chars: number;
  lines: number;
}

export interface BlobWriteResult {
  sha256: string;
  bytes: number;
  mimeType: string | null;
  blobPath: string;
  sidecarPath: string | null;
  deduplicated: boolean;
}

export interface SpillMetadataEntry {
  blockIndex: number;
  path: string;
  originalChars: number;
  originalBytes: number;
  originalLines: number;
}

export interface ExternalizedBlobEntry {
  blockIndex: number;
  sha256: string;
  bytes: number;
  mimeType: string | null;
  blobPath: string;
  sidecarPath: string | null;
  reason: "oversized" | "duplicate";
}

export interface ProcessToolResultSpillOptions {
  spillEnabled: boolean;
  thresholdChars: number;
  blobExternalize: boolean;
  spillDir: string;
  blobDir?: string;
  imageThresholdBytes?: number;
  seenImageHashes: Set<string>;
  log?: Logger;
}

export interface RegisterSessionSpillOptions {
  blobDir?: string;
  imageThresholdBytes?: number;
  log?: Logger;
}

const nextSeqByDir = new Map<string, number>();

/** Count newline-delimited lines (at least 1 for non-empty text, 0 for empty). */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function sanitizePathSegment(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.\./g, "__").replace(/^\.+$/, "_");
  return cleaned || "ephemeral";
}

/** Resolve the session-scoped spill directory (`<sessionFile-without-.jsonl>/local` or temp fallback). */
export function resolveSessionSpillDir(opts: {
  sessionFile?: string | null;
  sessionId?: string | null;
  cwd?: string;
}): SessionSpillLocation {
  const sessionFile = typeof opts.sessionFile === "string" ? opts.sessionFile.trim() : "";
  if (sessionFile) {
    const base = sessionFile.endsWith(".jsonl")
      ? sessionFile.slice(0, -".jsonl".length)
      : `${sessionFile}-artifacts`;
    return { dir: path.join(base, "local"), persistent: true };
  }
  const cwd = opts.cwd || process.cwd();
  const sid = sanitizePathSegment(opts.sessionId || "ephemeral");
  return {
    dir: path.join(getProjectTmpDir(cwd), "session-local", sid),
    persistent: false,
  };
}

/** Resolve the global content-addressed blob directory (`~/.pi/blobs` unless overridden). */
export function resolveBlobStoreDir(overrideDir?: string): string {
  return overrideDir || path.join(os.homedir(), ".pi", "blobs");
}

/** Map a MIME type to a canonical file extension for typed blob sidecars, or null if unknown. */
export function mimeToExt(mimeType?: string | null): string | null {
  if (!mimeType || typeof mimeType !== "string") return null;
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  if (!normalized) return null;
  return MIME_TO_EXT[normalized] ?? null;
}

function scanNextSpillId(dir: string): number {
  let maxId = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const match = /^(\d+)\.log$/.exec(entry);
      if (!match) continue;
      const num = Number(match[1]);
      if (Number.isSafeInteger(num) && num > maxId) maxId = num;
    }
  } catch {
    // Directory may not exist yet; start at 1.
  }
  return maxId + 1;
}

function rememberNextSeq(dir: string, nextSeq: number): void {
  if (!nextSeqByDir.has(dir) && nextSeqByDir.size >= MAX_TRACKED_SPILL_DIRS) {
    const oldest = nextSeqByDir.keys().next().value;
    if (oldest !== undefined) nextSeqByDir.delete(oldest);
  }
  nextSeqByDir.set(dir, nextSeq);
}

function unlinkBestEffort(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore ENOENT or already-cleaned temp files.
  }
}

function isHardlinkUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EXDEV" || code === "EPERM" || code === "ENOSYS" || code === "EOPNOTSUPP";
}

/**
 * Atomically persist full text to `<dir>/<N>.log` using a unique temp file + `linkSync`
 * so readers never see partial writes and concurrent tool completions never collide.
 */
export function writeSessionSpill(content: string, dir: string): SpillWriteResult {
  fs.mkdirSync(dir, { recursive: true });
  let seq = nextSeqByDir.get(dir) ?? scanNextSpillId(dir);

  const bytes = Buffer.byteLength(content, "utf-8");
  const chars = content.length;
  const lines = countLines(content);

  const tmpPath = path.join(dir, `.spill-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmpPath, content, "utf-8");

  let useWxFallback = false;
  try {
    for (let attempt = 0; attempt < MAX_SPILL_ALLOC_ATTEMPTS; attempt++) {
      const candidate = path.join(dir, `${seq}.log`);
      if (!useWxFallback) {
        try {
          fs.linkSync(tmpPath, candidate);
          rememberNextSeq(dir, seq + 1);
          return { path: candidate, bytes, chars, lines };
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "EEXIST") {
            seq++;
            continue;
          }
          if (isHardlinkUnsupported(err)) {
            useWxFallback = true;
            // Retry same seq with exclusive-create fallback.
            attempt--;
            continue;
          }
          throw err;
        }
      } else {
        try {
          const fd = fs.openSync(candidate, "wx");
          try {
            fs.writeFileSync(fd, content, "utf-8");
          } finally {
            fs.closeSync(fd);
          }
          rememberNextSeq(dir, seq + 1);
          return { path: candidate, bytes, chars, lines };
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
            seq++;
            continue;
          }
          throw err;
        }
      }
    }
    throw new Error(`Exhausted ${MAX_SPILL_ALLOC_ATTEMPTS} numeric spill IDs in ${dir}`);
  } finally {
    unlinkBestEffort(tmpPath);
  }
}

/**
 * Atomically write raw binary bytes to `<blobDir>/<sha256>` (deduplicating if already present)
 * and create a typed `<blobDir>/<sha256>.<ext>` sidecar when `mimeType` is recognized.
 */
export function writeContentBlob(
  bytes: Buffer,
  mimeType?: string | null,
  blobDir?: string,
): BlobWriteResult {
  const dir = resolveBlobStoreDir(blobDir);
  fs.mkdirSync(dir, { recursive: true });

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blobPath = path.join(dir, sha256);

  let deduplicated = false;
  if (fs.existsSync(blobPath)) {
    deduplicated = true;
  } else {
    const tmpPath = path.join(dir, `.blob-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmpPath, bytes);
      fs.renameSync(tmpPath, blobPath);
    } catch (err) {
      unlinkBestEffort(tmpPath);
      throw err;
    }
  }

  const ext = mimeToExt(mimeType);
  let sidecarPath: string | null = null;
  if (ext) {
    sidecarPath = `${blobPath}${ext}`;
    if (!fs.existsSync(sidecarPath)) {
      try {
        fs.linkSync(blobPath, sidecarPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") {
          const tmpSidecar = path.join(dir, `.sidecar-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
          try {
            fs.writeFileSync(tmpSidecar, bytes);
            fs.renameSync(tmpSidecar, sidecarPath);
          } catch (copyErr) {
            unlinkBestEffort(tmpSidecar);
            throw copyErr;
          }
        }
      }
    }
  }

  return {
    sha256,
    bytes: bytes.length,
    mimeType: mimeType || null,
    blobPath,
    sidecarPath,
    deduplicated,
  };
}

function sliceHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const raw = text.slice(0, maxChars);
  const lastNl = raw.lastIndexOf("\n");
  return lastNl >= Math.floor(maxChars * 0.75) ? raw.slice(0, lastNl) : raw;
}

function sliceTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const raw = text.slice(text.length - maxChars);
  const firstNl = raw.indexOf("\n");
  return firstNl >= 0 && firstNl <= Math.floor(maxChars * 0.25) ? raw.slice(firstNl + 1) : raw;
}

/** Format a bounded head/tail preview referencing the persisted spill path. */
export function formatSpillPreview(text: string, spillPath: string, thresholdChars: number): string {
  const chars = text.length;
  const lines = countLines(text);
  const marker = `[output truncated: ${chars} chars (${lines} lines) — full output saved to: ${spillPath} — use read(path, offset, limit) to inspect]`;
  const divider = `\n\n... ${marker} ...\n\n`;

  const maxHead = Math.max(100, Math.min(DEFAULT_PREVIEW_HEAD_CHARS, Math.floor(thresholdChars * 0.4)));
  const maxTail = Math.max(100, Math.min(DEFAULT_PREVIEW_TAIL_CHARS, Math.floor(thresholdChars * 0.2)));

  let headBudget = maxHead;
  let tailBudget = maxTail;

  // Guarantee preview stays strictly shorter than the original payload even for small thresholds / long paths.
  const available = text.length - divider.length - 1;
  if (available <= 0) return marker;
  if (headBudget + tailBudget > available) {
    headBudget = Math.floor(available * 0.65);
    tailBudget = Math.max(0, available - headBudget);
  }

  const head = sliceHead(text, headBudget);
  const tail = sliceTail(text, tailBudget);
  if (!tail) return `${head}\n\n... ${marker} ...`;
  return `${head}${divider}${tail}`;
}

/** Extract a previously written spill file path from a spill preview text. */
export function extractSpillPathFromText(text: string): string | null {
  const match = SPILL_MARKER_RE.exec(text);
  return match?.[3]?.trim() || null;
}

/** Extract original char/line counts from a spill preview text, if present. */
export function extractSpillCountsFromText(text: string): { chars: number; lines: number } | null {
  const match = SPILL_MARKER_RE.exec(text);
  if (!match) return null;
  const chars = Number(match[1]);
  const lines = Number(match[2]);
  if (!Number.isSafeInteger(chars) || !Number.isSafeInteger(lines)) return null;
  return { chars, lines };
}

/** Extract a recorded spill path for a given content block index from `toolResult.details`. */
export function extractSpillPathFromDetails(details: unknown, blockIndex: number): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const spills = (details as { __piSpills?: unknown }).__piSpills;
  if (!Array.isArray(spills)) return null;
  for (const entry of spills) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as SpillMetadataEntry).blockIndex === blockIndex &&
      typeof (entry as SpillMetadataEntry).path === "string"
    ) {
      return (entry as SpillMetadataEntry).path;
    }
  }
  return null;
}

function mergeDetailsMetadata(
  existingDetails: unknown,
  spills: SpillMetadataEntry[],
  blobs: ExternalizedBlobEntry[],
): unknown {
  if (existingDetails !== undefined && (typeof existingDetails !== "object" || existingDetails === null || Array.isArray(existingDetails))) {
    // Preserve non-object details verbatim without corrupting their shape.
    return existingDetails;
  }
  const base = existingDetails ? { ...(existingDetails as Record<string, unknown>) } : {};
  if (spills.length > 0) base.__piSpills = spills;
  if (blobs.length > 0) base.__piExternalizedBlobs = blobs;
  return base;
}

/**
 * Pure-ish core processor for `tool_result` events.
 * Returns `undefined` when no content was modified (leaving `structuredContent` untouched),
 * or `{ content, details }` (omitting `structuredContent` per Pi's middleware contract).
 */
export function processToolResultSpill(
  event: Pick<ToolResultEvent, "toolName" | "toolCallId" | "content" | "details" | "structuredContent">,
  opts: ProcessToolResultSpillOptions,
): ToolResultEventResult | undefined {
  if (!Array.isArray(event.content) || event.content.length === 0) return undefined;
  if (!opts.spillEnabled && !opts.blobExternalize) return undefined;

  const log = opts.log ?? defaultLog;
  const imageThresholdBytes = opts.imageThresholdBytes ?? DEFAULT_IMAGE_BLOB_THRESHOLD_BYTES;

  let modified = false;
  const nextContent: (TextContent | ImageContent)[] = [];
  const spills: SpillMetadataEntry[] = [];
  const blobs: ExternalizedBlobEntry[] = [];

  for (let i = 0; i < event.content.length; i++) {
    const block = event.content[i];
    if (!block) continue;

    if (
      opts.spillEnabled &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.length > opts.thresholdChars &&
      !extractSpillPathFromText(block.text)
    ) {
      try {
        const written = writeSessionSpill(block.text, opts.spillDir);
        const preview = formatSpillPreview(block.text, written.path, opts.thresholdChars);
        if (preview.length < block.text.length) {
          nextContent.push({ type: "text", text: preview });
          spills.push({
            blockIndex: i,
            path: written.path,
            originalChars: written.chars,
            originalBytes: written.bytes,
            originalLines: written.lines,
          });
          modified = true;
          log.info("session_spill_externalized", {
            tool: event.toolName,
            toolCallId: event.toolCallId,
            originalChars: written.chars,
            previewChars: preview.length,
            path: written.path,
          });
          continue;
        }
      } catch (err) {
        log.warn("session_spill_write_failed", {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (
      opts.blobExternalize &&
      block.type === "image" &&
      typeof block.data === "string" &&
      block.data.length > 0
    ) {
      try {
        const bytes = Buffer.from(block.data, "base64");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const isDuplicate = opts.seenImageHashes.has(sha256);
        const isOversized = bytes.length > imageThresholdBytes;
        opts.seenImageHashes.add(sha256);

        if (isDuplicate || isOversized) {
          const written = writeContentBlob(bytes, block.mimeType, opts.blobDir);
          const reason: "duplicate" | "oversized" = isDuplicate ? "duplicate" : "oversized";
          const displayPath = written.sidecarPath ?? written.blobPath;
          const mimeLabel = block.mimeType || "application/octet-stream";
          nextContent.push({
            type: "text",
            text: `[image externalized (${reason}): sha256=${written.sha256} (${written.bytes} bytes, ${mimeLabel}) — saved at ${displayPath}]`,
          });
          blobs.push({
            blockIndex: i,
            sha256: written.sha256,
            bytes: written.bytes,
            mimeType: written.mimeType,
            blobPath: written.blobPath,
            sidecarPath: written.sidecarPath,
            reason,
          });
          modified = true;
          log.info("session_blob_externalized", {
            tool: event.toolName,
            toolCallId: event.toolCallId,
            reason,
            sha256: written.sha256.slice(0, 12),
            bytes: written.bytes,
            deduplicated: written.deduplicated,
            path: displayPath,
          });
          continue;
        }
      } catch (err) {
        log.warn("session_blob_write_failed", {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    nextContent.push(block);
  }

  if (!modified) return undefined;

  // Omit `structuredContent` when modifying `content` so Pi drops any now-stale structured payload.
  const nextDetails = mergeDetailsMetadata(event.details, spills, blobs);
  return {
    content: nextContent,
    details: nextDetails,
  };
}

/** Register the `tool_result` spill & blob externalization middleware on the Pi extension API. */
export function registerSessionSpill(pi: ExtensionAPI, options: RegisterSessionSpillOptions = {}): void {
  const log = options.log ?? defaultLog;
  const seenImagesBySession = new Map<string, Set<string>>();

  const sessionKey = (ctx: any): string =>
    ctx?.sessionManager?.getSessionId?.() || "__default__";

  const getSeenImages = (key: string): Set<string> => {
    let set = seenImagesBySession.get(key);
    if (!set) {
      set = new Set<string>();
      seenImagesBySession.set(key, set);
    }
    return set;
  };

  pi.on("session_start", (_event, ctx) => {
    const key = sessionKey(ctx);
    seenImagesBySession.set(key, new Set<string>());
    log.debug("session_spill_session_reset", { sessionKey: key });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    seenImagesBySession.delete(sessionKey(ctx));
  });

  pi.on("tool_result", (event, ctx) => {
    const cwd = ctx?.cwd || process.cwd();
    const spillEnabled = getSetting(cwd, "session_spill_enabled");
    const blobExternalize = getSetting(cwd, "session_blob_externalize");
    if (!spillEnabled && !blobExternalize) return undefined;

    const thresholdChars = getSetting(cwd, "session_spill_threshold_chars");
    const spillLoc = resolveSessionSpillDir({
      sessionFile: ctx?.sessionManager?.getSessionFile?.(),
      sessionId: ctx?.sessionManager?.getSessionId?.(),
      cwd,
    });

    return processToolResultSpill(event, {
      spillEnabled,
      thresholdChars,
      blobExternalize,
      spillDir: spillLoc.dir,
      blobDir: options.blobDir,
      imageThresholdBytes: options.imageThresholdBytes,
      seenImageHashes: getSeenImages(sessionKey(ctx)),
      log,
    });
  });
}
