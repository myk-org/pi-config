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
import { acquireDirLock } from "../shared/file-lock.js";
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
const FALLBACK_LOCK_STALE_MS = 10_000;
const FALLBACK_LOCK_ATTEMPTS = 25;
const FALLBACK_LOCK_SLEEP_MS = 20;

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

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

export interface SpillFsOps {
  mkdirSync: typeof fs.mkdirSync;
  chmodSync: typeof fs.chmodSync;
  readdirSync: typeof fs.readdirSync;
  writeFileSync: typeof fs.writeFileSync;
  linkSync: typeof fs.linkSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
  existsSync: typeof fs.existsSync;
  statSync: typeof fs.statSync;
  rmSync: typeof fs.rmSync;
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

export interface TrustedSpillRecord {
  path: string;
  spillDir: string;
  previewSha256: string;
  originalChars: number;
  originalLines: number;
}

export interface VerifiedSpillReference {
  path: string;
  originalChars: number;
  originalLines: number;
}

export interface ProcessToolResultSpillOptions {
  sessionKey?: string;
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
const trustedSpillsBySession = new Map<string, Map<string, TrustedSpillRecord>>();

const defaultFsOps: SpillFsOps = {
  mkdirSync: fs.mkdirSync,
  chmodSync: fs.chmodSync,
  readdirSync: fs.readdirSync,
  writeFileSync: fs.writeFileSync,
  linkSync: fs.linkSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
  existsSync: fs.existsSync,
  statSync: fs.statSync,
  rmSync: fs.rmSync,
};

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function makeTrustedSpillKey(toolCallId: string, blockIndex: number): string {
  return `${toolCallId}:${blockIndex}`;
}

/** Record a spill file legitimately created by this session for `(toolCallId, blockIndex)`. */
export function recordTrustedSpill(
  sessionKey: string,
  toolCallId: string,
  blockIndex: number,
  record: TrustedSpillRecord,
): void {
  if (!toolCallId) return;
  let sessionMap = trustedSpillsBySession.get(sessionKey);
  if (!sessionMap) {
    sessionMap = new Map<string, TrustedSpillRecord>();
    trustedSpillsBySession.set(sessionKey, sessionMap);
  }
  sessionMap.set(makeTrustedSpillKey(toolCallId, blockIndex), record);
}

/**
 * Verify and return a reusable spill reference ONLY when:
 * 1. A spill record was registered in-process for this exact `(sessionKey, toolCallId, blockIndex)`,
 * 2. The current block text matches the exact SHA-256 of the generated preview (content identity),
 * 3. The target path is a regular non-symlink file residing strictly inside `expectedSpillDir`.
 */
export function lookupTrustedSpill(
  sessionKey: string,
  toolCallId: string | undefined,
  blockIndex: number,
  currentText: string,
  expectedSpillDir: string,
): VerifiedSpillReference | null {
  if (!toolCallId) return null;
  const record = trustedSpillsBySession.get(sessionKey)?.get(makeTrustedSpillKey(toolCallId, blockIndex));
  if (!record) return null;
  if (sha256Text(currentText) !== record.previewSha256) return null;

  try {
    const stat = fs.lstatSync(record.path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const realDir = fs.realpathSync(expectedSpillDir);
    const realFile = fs.realpathSync(record.path);
    const prefix = realDir.endsWith(path.sep) ? realDir : `${realDir}${path.sep}`;
    if (!realFile.startsWith(prefix)) return null;
  } catch {
    return null;
  }

  return {
    path: record.path,
    originalChars: record.originalChars,
    originalLines: record.originalLines,
  };
}

/** Clear tracked trusted spills for one session (or all sessions when omitted). */
export function clearTrustedSpills(sessionKey?: string): void {
  if (sessionKey === undefined) {
    trustedSpillsBySession.clear();
  } else {
    trustedSpillsBySession.delete(sessionKey);
  }
}

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

function ensurePrivateDir(dir: string, ops: SpillFsOps): void {
  ops.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // Explicitly chmod so permissive umasks or pre-existing directories are tightened to owner-only.
  ops.chmodSync(dir, PRIVATE_DIR_MODE);
  const parentDir = path.dirname(dir);
  if (path.basename(parentDir) === "session-local") {
    try {
      ops.chmodSync(parentDir, PRIVATE_DIR_MODE);
    } catch {
      // Best-effort on parent container.
    }
  }
}

function scanNextSpillId(dir: string, ops: SpillFsOps): number {
  let maxId = 0;
  try {
    for (const entry of ops.readdirSync(dir)) {
      const name = String(entry);
      const match = /^(\d+)\.log$/.exec(name);
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

function unlinkBestEffort(filePath: string, ops: SpillFsOps = defaultFsOps): void {
  try {
    ops.unlinkSync(filePath);
  } catch {
    // Ignore ENOENT or already-cleaned temp files.
  }
}

function isHardlinkUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EXDEV" || code === "EPERM" || code === "ENOSYS" || code === "EOPNOTSUPP";
}

function acquireFallbackLock(dir: string, ops: SpillFsOps): string {
  const lockDir = path.join(dir, ".spill.lock");
  if (acquireDirLock(lockDir, FALLBACK_LOCK_ATTEMPTS, FALLBACK_LOCK_SLEEP_MS)) {
    return lockDir;
  }
  // Reclaim stale lock if its owner crashed without releasing.
  try {
    const stat = ops.statSync(lockDir);
    if (Date.now() - stat.mtimeMs > FALLBACK_LOCK_STALE_MS) {
      ops.rmSync(lockDir, { recursive: true, force: true });
      if (acquireDirLock(lockDir, 3, FALLBACK_LOCK_SLEEP_MS)) {
        return lockDir;
      }
    }
  } catch {
    // Lock disappeared concurrently; retry once.
    if (acquireDirLock(lockDir, 3, FALLBACK_LOCK_SLEEP_MS)) {
      return lockDir;
    }
  }
  throw new Error(`Timed out acquiring spill fallback lock in ${dir}`);
}

function publishWithAtomicRenameFallback(
  dir: string,
  tmpPath: string,
  startSeq: number,
  ops: SpillFsOps,
): { path: string; seq: number } {
  const lockDir = acquireFallbackLock(dir, ops);
  try {
    let seq = Math.max(startSeq, scanNextSpillId(dir, ops));
    for (let attempt = 0; attempt < MAX_SPILL_ALLOC_ATTEMPTS; attempt++) {
      const candidate = path.join(dir, `${seq}.log`);
      if (ops.existsSync(candidate)) {
        seq++;
        continue;
      }
      // tmpPath is already completely written, chmodded 0o600, and closed,
      // so same-directory renameSync publishes atomically with zero partial reads.
      ops.renameSync(tmpPath, candidate);
      return { path: candidate, seq };
    }
    throw new Error(`Exhausted ${MAX_SPILL_ALLOC_ATTEMPTS} numeric spill IDs in ${dir}`);
  } finally {
    try {
      ops.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Lock already removed.
    }
  }
}

/**
 * Atomically persist full text to `<dir>/<N>.log` with owner-only permissions (`0o700` dir,
 * `0o600` files) using a private temp file + `linkSync` (or lock-serialized atomic `renameSync`
 * fallback when hardlinks are unsupported) so readers never see partial writes and concurrent
 * tool completions never collide.
 */
export function writeSessionSpill(
  content: string,
  dir: string,
  fsOverrides?: Partial<SpillFsOps>,
): SpillWriteResult {
  const ops: SpillFsOps = fsOverrides ? { ...defaultFsOps, ...fsOverrides } : defaultFsOps;
  ensurePrivateDir(dir, ops);
  let seq = nextSeqByDir.get(dir) ?? scanNextSpillId(dir, ops);

  const bytes = Buffer.byteLength(content, "utf-8");
  const chars = content.length;
  const lines = countLines(content);

  const tmpPath = path.join(dir, `.spill-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);

  try {
    ops.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
    ops.chmodSync(tmpPath, PRIVATE_FILE_MODE);

    for (let attempt = 0; attempt < MAX_SPILL_ALLOC_ATTEMPTS; attempt++) {
      const candidate = path.join(dir, `${seq}.log`);
      try {
        ops.linkSync(tmpPath, candidate);
        rememberNextSeq(dir, seq + 1);
        return { path: candidate, bytes, chars, lines };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EEXIST") {
          seq++;
          continue;
        }
        if (isHardlinkUnsupported(err)) {
          const published = publishWithAtomicRenameFallback(dir, tmpPath, seq, ops);
          rememberNextSeq(dir, published.seq + 1);
          return { path: published.path, bytes, chars, lines };
        }
        throw err;
      }
    }
    throw new Error(`Exhausted ${MAX_SPILL_ALLOC_ATTEMPTS} numeric spill IDs in ${dir}`);
  } finally {
    unlinkBestEffort(tmpPath, ops);
  }
}

/**
 * Atomically write raw binary bytes to `<blobDir>/<sha256>` (deduplicating if already present)
 * with owner-only permissions and create a typed `<blobDir>/<sha256>.<ext>` sidecar when
 * `mimeType` is recognized.
 */
export function writeContentBlob(
  bytes: Buffer,
  mimeType?: string | null,
  blobDir?: string,
): BlobWriteResult {
  const dir = resolveBlobStoreDir(blobDir);
  ensurePrivateDir(dir, defaultFsOps);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blobPath = path.join(dir, sha256);

  let deduplicated = false;
  if (fs.existsSync(blobPath)) {
    deduplicated = true;
  } else {
    const tmpPath = path.join(dir, `.blob-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmpPath, bytes, { mode: PRIVATE_FILE_MODE });
      fs.chmodSync(tmpPath, PRIVATE_FILE_MODE);
      fs.renameSync(tmpPath, blobPath);
    } finally {
      unlinkBestEffort(tmpPath);
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
            fs.writeFileSync(tmpSidecar, bytes, { mode: PRIVATE_FILE_MODE });
            fs.chmodSync(tmpSidecar, PRIVATE_FILE_MODE);
            fs.renameSync(tmpSidecar, sidecarPath);
          } finally {
            unlinkBestEffort(tmpSidecar);
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

/** Parse a spill file path from a formatted spill preview string (display/testing helper; never trusted as authority). */
export function extractSpillPathFromText(text: string): string | null {
  const match = SPILL_MARKER_RE.exec(text);
  return match?.[3]?.trim() || null;
}

/** Parse original char/line counts from a formatted spill preview string. */
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
  const sessionKey = opts.sessionKey ?? "__default__";
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
      !lookupTrustedSpill(sessionKey, event.toolCallId, i, block.text, opts.spillDir)
    ) {
      try {
        const written = writeSessionSpill(block.text, opts.spillDir);
        const preview = formatSpillPreview(block.text, written.path, opts.thresholdChars);
        if (preview.length < block.text.length) {
          recordTrustedSpill(sessionKey, event.toolCallId, i, {
            path: written.path,
            spillDir: opts.spillDir,
            previewSha256: sha256Text(preview),
            originalChars: written.chars,
            originalLines: written.lines,
          });
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
    clearTrustedSpills(key);
    log.debug("session_spill_session_reset", { sessionKey: key });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKey(ctx);
    seenImagesBySession.delete(key);
    clearTrustedSpills(key);
  });

  pi.on("tool_result", (event, ctx) => {
    const cwd = ctx?.cwd || process.cwd();
    const spillEnabled = getSetting(cwd, "session_spill_enabled");
    const blobExternalize = getSetting(cwd, "session_blob_externalize");
    if (!spillEnabled && !blobExternalize) return undefined;

    const key = sessionKey(ctx);
    const thresholdChars = getSetting(cwd, "session_spill_threshold_chars");
    const spillLoc = resolveSessionSpillDir({
      sessionFile: ctx?.sessionManager?.getSessionFile?.(),
      sessionId: ctx?.sessionManager?.getSessionId?.(),
      cwd,
    });

    return processToolResultSpill(event, {
      sessionKey: key,
      spillEnabled,
      thresholdChars,
      blobExternalize,
      spillDir: spillLoc.dir,
      blobDir: options.blobDir,
      imageThresholdBytes: options.imageThresholdBytes,
      seenImageHashes: getSeenImages(key),
      log,
    });
  });
}
