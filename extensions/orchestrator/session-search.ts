/**
 * Session Search — keyword search over past and recent conversation sessions.
 *
 * Combines persisted conversation summaries in `.pi/data/state.db`
 * (`kv_state` key `"session-search"`, issue #1399; legacy `session-search.jsonl`
 * and `session-search.json` auto-migrated once on first access) with
 * mtime-cached incremental lazy scanning of recent project session JSONL files
 * under `~/.pi/agent/sessions/<cwd-slug>/`. This makes active, uncompacted, and
 * abnormally terminated sessions searchable immediately at zero LLM cost.
 *
 * Inspired by Hermes Agent's session search layer.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  type Stats,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.js";
import { resolvePiAgentDir } from "../shared/pi-agent-dir.js";
import { getProjectDataDir } from "./utils.js";
import {
  createSqliteStateStore,
  getProjectStateDbPath,
  SKIP_MUTATE,
  type SqliteStateStore,
} from "./state-db.js";

const log = createLogger("memory");

// ── Constants ──────────────────────────────────────────────────────────────

const SESSION_SEARCH_STORE_KEY = "session-search";
const STORE_FILENAME_JSONL = "session-search.jsonl";
const LEGACY_STORE_FILENAME = "session-search.json";

/** Max recent project session JSONL files scanned lazily during searchSessions. */
const MAX_RECENT_SESSION_FILES = 20;
/** Max cached file scan entries kept in memory (LRU eviction). */
const MAX_SCAN_CACHE_ENTRIES = 200;
/** Max bytes read per file scan to keep latency and memory bounded on huge logs. */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
/** Header probe size when tail-slicing files larger than MAX_SCAN_BYTES. */
const HEADER_PROBE_BYTES = 4096;
/** Prefix window inspected on large JSONL lines to avoid parsing huge tool/assistant rows. */
const LINE_PREFIX_CHECK_CHARS = 512;
/** Max characters kept per cleaned user message. */
const MAX_USER_MESSAGE_CHARS = 300;
/** Max trailing user messages retained per scanned session. */
const MAX_TAIL_USER_MESSAGES = 200;
/** Max characters synthesized for an uncompacted/tail session summary. */
const MAX_TAIL_SUMMARY_CHARS = 6000;
/** Tolerance (ms) when comparing store timestamps against ISO entry activity timestamps. */
const SUPERSEDE_TOLERANCE_MS = 5;
/** Wider tolerance (ms) when falling back to filesystem mtime (coarse FS clock skew). */
const MTIME_SUPERSEDE_TOLERANCE_MS = 1000;

// ── Secret & Noise Sanitization ────────────────────────────────────────────

const CREDENTIAL_KEY_SRC =
  "(?:[A-Za-z0-9_-]{1,64}[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|secret[_-]?access[_-]?key|password|passwd|private[_-]?key)|[A-Za-z0-9_-]{1,64}[_-](?:token|secret)";

const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    re: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replacement: "[REDACTED]",
  },
  {
    re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: "[REDACTED]",
  },
  {
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED]",
  },
  {
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    re: /\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)\S+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi,
    replacement: "$1[REDACTED]",
  },
  {
    re: new RegExp(`\\b(${CREDENTIAL_KEY_SRC})(["']?\\s*[:=]\\s*")((?:\\\\[^\\r\\n]|[^"\\\\\\r\\n]){8,})("|$)`, "gi"),
    replacement: "$1$2[REDACTED]$4",
  },
  {
    re: new RegExp(`\\b(${CREDENTIAL_KEY_SRC})(["']?\\s*[:=]\\s*')((?:\\\\[^\\r\\n]|[^'\\\\\\r\\n]){8,})('|$)`, "gi"),
    replacement: "$1$2[REDACTED]$4",
  },
  {
    re: new RegExp(`\\b(${CREDENTIAL_KEY_SRC})(["']?\\s*[:=]\\s*)([^\\s"';}{]{8,})`, "gi"),
    replacement: "$1$2[REDACTED]",
  },
  {
    re: /(https?:\/\/[^/\s:@]{1,128}:)([^/\s@]{1,256})(@)/gi,
    replacement: "$1[REDACTED]$3",
  },
];

const NOISE_PREFIXES = [
  "/",
  "[IMPORTANT:",
  "[SYSTEM:",
  "📡 Connected to coms",
  "<system",
];

/** Strip common credentials, tokens, private keys, and auth headers from text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Normalize a user message for session search indexing, rejecting slash
 * commands, system/harness banners, and very short fragments, and redacting
 * embedded secrets.
 */
function cleanUserMessageForIndex(raw: string): string | null {
  // Strip leading coms peer presence banners (e.g. "📡 Peer joined: ... [ts]")
  let text = raw.replace(/^(?:📡\s*Peer (?:joined|left):[^\n]*\n?)+/g, "").trim();
  if (text.length < 15) return null;
  for (const prefix of NOISE_PREFIXES) {
    if (text.startsWith(prefix)) return null;
  }
  text = redactSecrets(text).replace(/\s+/g, " ").trim();
  if (text.length < 15) return null;
  return text.slice(0, MAX_USER_MESSAGE_CHARS);
}

// ── Storage ────────────────────────────────────────────────────────────────

interface SessionEntry {
  sessionId: string;
  timestamp: string;
  summary: string;
}

interface SessionStore {
  entries: SessionEntry[];
}

function getStore(cwd: string): SqliteStateStore<SessionStore> {
  const dataDir = getProjectDataDir(cwd);
  return createSqliteStateStore<SessionStore>(
    getProjectStateDbPath(cwd),
    SESSION_SEARCH_STORE_KEY,
    {
      legacyFiles: [
        join(dataDir, STORE_FILENAME_JSONL),
        join(dataDir, LEGACY_STORE_FILENAME),
      ],
    },
  );
}

function loadStore(cwd: string): SessionStore {
  const data = getStore(cwd).read();
  if (data === null) return { entries: [] };
  if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
    log.warn("session-search: corrupt store shape, resetting");
    return { entries: [] };
  }
  // Filter to only valid entries
  const entries = data.entries.filter(
    (e: unknown): e is SessionEntry =>
      typeof e === "object" && e !== null &&
      typeof (e as any).sessionId === "string" &&
      typeof (e as any).timestamp === "string" &&
      typeof (e as any).summary === "string"
  );
  return { entries };
}

// ── Index a session summary ────────────────────────────────────────────────

export function indexSessionSummary(
  cwd: string,
  sessionId: string,
  summary: string,
): void {
  if (!summary || !summary.trim()) return;
  const cleaned = redactSecrets(summary).trim();
  if (!cleaned) return;

  getStore(cwd).mutate(
    (store) => {
      if (!store || typeof store !== "object" || !Array.isArray(store.entries)) {
        return {
          entries: [{ sessionId, timestamp: new Date().toISOString(), summary: cleaned }],
        };
      }
      // Avoid duplicate entries for the same session
      const exists = store.entries.some(
        (e) => e.sessionId === sessionId && e.summary === cleaned,
      );
      if (exists) return SKIP_MUTATE;

      store.entries.push({
        sessionId,
        timestamp: new Date().toISOString(),
        summary: cleaned,
      });

      // Keep max 500 entries (oldest dropped)
      if (store.entries.length > 500) {
        store.entries = store.entries.slice(-500);
      }
      return store;
    },
    { entries: [] },
  );
}

// ── Harvest pi session summaries ──────────────────────────────────────────

/**
 * Extract the LLM-written summaries pi persists in a session JSONL file
 * (issue #915): compaction summaries and branch summaries are real
 * summaries, far better input for session search than joined user messages.
 */
export function extractSessionSummaries(sessionFilePath: string): string[] {
  if (!existsSync(sessionFilePath)) return [];
  try {
    const raw = readFileSync(sessionFilePath, "utf-8");
    const summaries: string[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (
          (entry?.type === "compaction" || entry?.type === "branch_summary") &&
          typeof entry?.summary === "string" &&
          entry.summary.length >= 50
        ) {
          const cleaned = redactSecrets(entry.summary).trim();
          if (cleaned.length >= 50) summaries.push(cleaned);
        }
      } catch {
        continue; // skip corrupt/truncated lines
      }
    }
    return summaries;
  } catch {
    return [];
  }
}

// ── Lazy mtime-cached project session scanner ─────────────────────────────

interface ScannedSummary {
  summary: string;
  timestamp: string;
}

interface ScanMutableState {
  sessionId: string;
  isSubagent: boolean;
  sessionTimestamp: string;
  sessionName: string;
  summaries: ScannedSummary[];
  tailUserMessages: string[];
  sawEntryTimestamp: boolean;
  lastActivityMs: number;
  lastActivityIso: string;
}

interface CachedSessionScan extends ScanMutableState {
  mtimeMs: number;
  size: number;
  ino: number;
  committedByteOffset: number;
  effectiveSummaries: ScannedSummary[];
  effectiveTailSummary: string;
  effectiveSawEntryTimestamp: boolean;
  effectiveLastActivityMs: number;
  effectiveLastActivityIso: string;
}

export interface SearchSessionsOptions {
  /** Override the project sessions directory (defaults to `~/.pi/agent/sessions/<cwd-slug>`). */
  sessionsDir?: string;
  /** Exclude a session ID (e.g. the active session during automatic past-session recall). */
  excludeSessionId?: string;
}

const fileScanCache = new Map<string, CachedSessionScan>();

/** Clear the in-memory session JSONL scan cache (for tests). */
export function clearSessionScanCache(): void {
  fileScanCache.clear();
}

/**
 * Compute pi's default session directory for a project cwd, matching
 * `@earendil-works/pi-coding-agent`'s `getDefaultSessionDirPath`.
 */
export function getProjectSessionsDir(cwd: string, agentDir?: string | null): string {
  const resolvedCwd = resolve(cwd);
  const resolvedAgentDir = resolve(resolvePiAgentDir(agentDir));
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvedAgentDir, "sessions", safePath);
}

function isSubagentSessionFilename(filename: string): boolean {
  return /(?:^|_)async-[^/]+\.jsonl$/.test(filename);
}

const CANONICAL_SESSION_FILE_RE = /^\d{4}-\d{2}-\d{2}T[^_]+_(.+)\.jsonl$/;

function extractCanonicalFilenameSessionId(filePath: string): string | null {
  const match = basename(filePath).match(CANONICAL_SESSION_FILE_RE);
  return match && match[1] ? match[1] : null;
}

function deriveSessionIdFromFilename(filePath: string): string {
  return extractCanonicalFilenameSessionId(filePath) ?? basename(filePath, ".jsonl");
}

function parseIsoTimestampMs(value: unknown): { ms: number; iso: string } | null {
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return { ms, iso: value.trim() };
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return { ms: value, iso: new Date(value).toISOString() };
  }
  return null;
}

function extractUserMessageText(entry: Record<string, unknown>): string | null {
  const msg = (
    entry.message && typeof entry.message === "object"
      ? entry.message
      : entry
  ) as Record<string, unknown>;
  if (msg.role !== "user") return null;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        parts.push((block as Record<string, unknown>).text as string);
      }
    }
    return parts.join(" ");
  }
  return null;
}

function updateLastActivity(state: ScanMutableState, ts: { ms: number; iso: string } | null): void {
  if (!ts) return;
  if (!state.sawEntryTimestamp || ts.ms >= state.lastActivityMs) {
    state.sawEntryTimestamp = true;
    state.lastActivityMs = ts.ms;
    state.lastActivityIso = ts.iso;
  }
}

function isInterestingJsonlLine(raw: string, start: number, end: number): boolean {
  const len = end - start;
  if (len === 0) return false;
  const head = len <= 1024 ? raw.slice(start, end) : raw.slice(start, start + LINE_PREFIX_CHECK_CHARS);
  if (
    head.includes('"compaction"') ||
    head.includes('"branch_summary"') ||
    head.includes('"session_info"') ||
    head.includes('"type":"session"') ||
    head.includes('"type": "session"')
  ) {
    return true;
  }
  return head.includes('"role":"user"') || head.includes('"role": "user"');
}

function applyJsonlLine(state: ScanMutableState, rawLine: string, forceParse: boolean): void {
  const trimmed = rawLine.trim();
  if (!trimmed) return;
  if (!forceParse && !isInterestingJsonlLine(trimmed, 0, trimmed.length)) return;

  let entry: unknown;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return; // skip corrupt or partially written lines
  }
  if (!entry || typeof entry !== "object") return;
  const rec = entry as Record<string, unknown>;
  const type = rec.type;

  if (type === "session") {
    if (typeof rec.id === "string" && rec.id.trim()) {
      state.sessionId = rec.id.trim();
      if (state.sessionId.startsWith("async-")) state.isSubagent = true;
    }
    const ts = parseIsoTimestampMs(rec.timestamp);
    if (ts) {
      state.sessionTimestamp = ts.iso;
      updateLastActivity(state, ts);
    }
    return;
  }

  if (type === "session_info") {
    if (typeof rec.name === "string" && rec.name.trim()) {
      state.sessionName = redactSecrets(rec.name).replace(/\s+/g, " ").trim().slice(0, 120);
    }
    updateLastActivity(state, parseIsoTimestampMs(rec.timestamp));
    return;
  }

  if (type === "compaction" || type === "branch_summary") {
    if (typeof rec.summary === "string" && rec.summary.length >= 50) {
      const cleaned = redactSecrets(rec.summary).trim();
      if (cleaned.length >= 50) {
        const ts = parseIsoTimestampMs(rec.timestamp);
        state.summaries.push({
          summary: cleaned,
          timestamp: ts ? ts.iso : state.sessionTimestamp,
        });
        if (type === "compaction") {
          // Compaction covers all prior conversation; retain only subsequent uncompacted turns.
          state.tailUserMessages = [];
        }
        updateLastActivity(state, ts);
      }
    }
    return;
  }

  if (type === "message") {
    const rawText = extractUserMessageText(rec);
    if (rawText === null) return;
    const cleaned = cleanUserMessageForIndex(rawText);
    if (!cleaned) return;
    if (state.tailUserMessages[state.tailUserMessages.length - 1] !== cleaned) {
      state.tailUserMessages.push(cleaned);
      if (state.tailUserMessages.length > MAX_TAIL_USER_MESSAGES) {
        // Keep opening prompt (topic anchor) + most recent messages
        state.tailUserMessages = [
          state.tailUserMessages[0]!,
          ...state.tailUserMessages.slice(-(MAX_TAIL_USER_MESSAGES - 1)),
        ];
      }
    }
    const msgObj = rec.message && typeof rec.message === "object"
      ? (rec.message as Record<string, unknown>)
      : null;
    updateLastActivity(
      state,
      parseIsoTimestampMs(rec.timestamp) ?? parseIsoTimestampMs(msgObj?.timestamp),
    );
  }
}

function buildTailSummary(sessionName: string, messages: string[]): string {
  const prefix = sessionName ? `[${sessionName}] ` : "";
  if (messages.length === 0) return "";
  const full = prefix + messages.join(" | ");
  if (full.length <= MAX_TAIL_SUMMARY_CHARS) return full;

  // Keep opening message + as many most-recent messages as fit within budget
  const first = messages[0]!;
  const sep = " | ";
  const remaining: string[] = [];
  let budget = MAX_TAIL_SUMMARY_CHARS - prefix.length - first.length;
  for (let i = messages.length - 1; i >= 1; i--) {
    const msg = messages[i]!;
    if (budget - sep.length - msg.length < 0) break;
    remaining.push(msg);
    budget -= sep.length + msg.length;
  }
  remaining.reverse();
  const kept = remaining.length > 0 ? [first, ...remaining] : [first];
  return (prefix + kept.join(sep)).slice(0, MAX_TAIL_SUMMARY_CHARS);
}

function readRange(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const n = readSync(fd, buf, totalRead, length - totalRead, offset + totalRead);
    if (n <= 0) break;
    totalRead += n;
  }
  return totalRead === length ? buf : buf.subarray(0, totalRead);
}

function applyBufferLines(state: ScanMutableState, text: string, parseFirstLineUnconditionally: boolean): void {
  let pos = 0;
  let first = parseFirstLineUnconditionally;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = text.length;
    if (first || isInterestingJsonlLine(text, pos, nl)) {
      applyJsonlLine(state, text.slice(pos, nl), first);
    }
    first = false;
    pos = nl + 1;
  }
}

function finalizeEffectiveView(
  committed: ScanMutableState,
  pendingFragment: string,
  st: Stats,
  committedByteOffset: number,
): CachedSessionScan {
  let effective: ScanMutableState = committed;
  if (pendingFragment.trim()) {
    // Apply uncommitted trailing line onto a shallow copy so re-reading from
    // committedByteOffset after an append never duplicates the line.
    effective = {
      ...committed,
      summaries: [...committed.summaries],
      tailUserMessages: [...committed.tailUserMessages],
    };
    applyJsonlLine(effective, pendingFragment, committedByteOffset === 0);
  }
  return {
    ...committed,
    mtimeMs: st.mtimeMs,
    size: st.size,
    ino: st.ino,
    committedByteOffset,
    effectiveSummaries: effective.summaries,
    effectiveTailSummary: buildTailSummary(effective.sessionName, effective.tailUserMessages),
    effectiveSawEntryTimestamp: effective.sawEntryTimestamp,
    effectiveLastActivityMs: effective.lastActivityMs,
    effectiveLastActivityIso: effective.lastActivityIso,
  };
}

function setCachedScan(filePath: string, entry: CachedSessionScan): void {
  // Refresh insertion order for simple LRU eviction
  fileScanCache.delete(filePath);
  fileScanCache.set(filePath, entry);
  if (fileScanCache.size > MAX_SCAN_CACHE_ENTRIES) {
    const oldestKey = fileScanCache.keys().next().value;
    if (oldestKey !== undefined) fileScanCache.delete(oldestKey);
  }
}

function scanSessionJsonlFile(filePath: string, st: Stats): CachedSessionScan | null {
  const cached = fileScanCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size &&
    cached.ino === st.ino
  ) {
    setCachedScan(filePath, cached);
    return cached;
  }

  // Incremental append path: same inode, file strictly grew, delta within cap
  if (
    cached &&
    cached.ino === st.ino &&
    st.size > cached.size &&
    cached.committedByteOffset > 0 &&
    cached.committedByteOffset <= st.size &&
    st.size - cached.committedByteOffset <= MAX_SCAN_BYTES
  ) {
    let fd: number | null = null;
    try {
      fd = openSync(filePath, "r");
      const deltaLen = st.size - cached.committedByteOffset;
      const buf = deltaLen > 0 ? readRange(fd, cached.committedByteOffset, deltaLen) : Buffer.alloc(0);

      const state: ScanMutableState = {
        sessionId: cached.sessionId,
        isSubagent: cached.isSubagent,
        sessionTimestamp: cached.sessionTimestamp,
        sessionName: cached.sessionName,
        summaries: [...cached.summaries],
        tailUserMessages: [...cached.tailUserMessages],
        sawEntryTimestamp: cached.sawEntryTimestamp,
        lastActivityMs: cached.lastActivityMs,
        lastActivityIso: cached.lastActivityIso,
      };

      const lastNl = buf.lastIndexOf(0x0a);
      let nextOffset = cached.committedByteOffset;
      let pending = "";
      if (lastNl !== -1) {
        applyBufferLines(state, buf.subarray(0, lastNl + 1).toString("utf-8"), false);
        nextOffset += lastNl + 1;
        if (lastNl + 1 < buf.length) {
          pending = buf.subarray(lastNl + 1).toString("utf-8");
        }
      } else if (buf.length > 0) {
        pending = buf.toString("utf-8");
      }

      const updated = finalizeEffectiveView(state, pending, st, nextOffset);
      setCachedScan(filePath, updated);
      return updated;
    } catch (err) {
      log.warn("session-search: incremental session scan failed", { filePath, err });
      return null;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  // Full scan (fresh, truncated, replaced, or oversized delta)
  let fd: number | null = null;
  try {
    const mtimeIso = new Date(st.mtimeMs).toISOString();
    const state: ScanMutableState = {
      sessionId: deriveSessionIdFromFilename(filePath),
      isSubagent: isSubagentSessionFilename(basename(filePath)),
      sessionTimestamp: mtimeIso,
      sessionName: "",
      summaries: [],
      tailUserMessages: [],
      sawEntryTimestamp: false,
      lastActivityMs: st.mtimeMs,
      lastActivityIso: mtimeIso,
    };

    if (st.size === 0) {
      const empty = finalizeEffectiveView(state, "", st, 0);
      setCachedScan(filePath, empty);
      return empty;
    }

    fd = openSync(filePath, "r");
    let committedByteOffset = 0;
    let pending = "";

    if (st.size <= MAX_SCAN_BYTES) {
      const buf = readRange(fd, 0, st.size);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl !== -1) {
        applyBufferLines(state, buf.subarray(0, lastNl + 1).toString("utf-8"), true);
        committedByteOffset = lastNl + 1;
        if (lastNl + 1 < buf.length) {
          pending = buf.subarray(lastNl + 1).toString("utf-8");
        }
      } else if (buf.length > 0) {
        pending = buf.toString("utf-8");
      }
    } else {
      // Oversized file: probe header line for authoritative sessionId, then scan tail window
      const headerBuf = readRange(fd, 0, Math.min(HEADER_PROBE_BYTES, st.size));
      const firstNl = headerBuf.indexOf(0x0a);
      const headerLine = (firstNl === -1 ? headerBuf : headerBuf.subarray(0, firstNl)).toString("utf-8");
      applyJsonlLine(state, headerLine, true);

      const startOffset = st.size - MAX_SCAN_BYTES;
      // Read 1 preceding byte so a record starting right at startOffset (after \n) is preserved
      const probeBuf = readRange(fd, startOffset - 1, MAX_SCAN_BYTES + 1);
      const startsAtBoundary = probeBuf.length > 0 && probeBuf[0] === 0x0a;
      const tailBuf = probeBuf.subarray(1);
      let bodyStart = -1;
      if (startsAtBoundary) {
        bodyStart = 0;
      } else {
        const skipPartial = tailBuf.indexOf(0x0a);
        if (skipPartial !== -1) bodyStart = skipPartial + 1;
      }

      if (bodyStart !== -1) {
        const bodyBuf = tailBuf.subarray(bodyStart);
        const lastNl = bodyBuf.lastIndexOf(0x0a);
        if (lastNl !== -1) {
          applyBufferLines(state, bodyBuf.subarray(0, lastNl + 1).toString("utf-8"), false);
          committedByteOffset = startOffset + bodyStart + lastNl + 1;
          if (lastNl + 1 < bodyBuf.length) {
            pending = bodyBuf.subarray(lastNl + 1).toString("utf-8");
          }
        } else {
          committedByteOffset = startOffset + bodyStart;
          if (bodyBuf.length > 0) {
            pending = bodyBuf.toString("utf-8");
          }
        }
      }
      // If tailBuf has no newline at all (a single line larger than MAX_SCAN_BYTES),
      // leave committedByteOffset at 0 and pending empty so we neither parse a
      // mid-line fragment nor lock incremental scanning to a non-newline boundary.
    }

    const scanned = finalizeEffectiveView(state, pending, st, committedByteOffset);
    setCachedScan(filePath, scanned);
    return scanned;
  } catch (err) {
    log.warn("session-search: session JSONL scan failed", { filePath, err });
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function scanRecentProjectSessions(
  cwd: string,
  latestStoreTsBySession: Map<string, number>,
  sessionsDir?: string,
  excludeSessionId?: string,
): CachedSessionScan[] {
  const dir = sessionsDir ? resolve(sessionsDir) : getProjectSessionsDir(cwd);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log.warn("session-search: unable to read project sessions dir", { dir, err });
    }
    return [];
  }

  const candidates: Array<{ filePath: string; st: Stats; canonicalId: string | null }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl") || isSubagentSessionFilename(name)) continue;
    const filePath = join(dir, name);
    const canonicalId = extractCanonicalFilenameSessionId(filePath);
    if (excludeSessionId && canonicalId === excludeSessionId) continue;
    try {
      const st = statSync(filePath);
      if (!st.isFile()) continue;
      candidates.push({ filePath, st, canonicalId });
    } catch {
      continue; // file removed concurrently
    }
  }

  candidates.sort((a, b) => {
    if (b.st.mtimeMs !== a.st.mtimeMs) return b.st.mtimeMs - a.st.mtimeMs;
    return b.filePath.localeCompare(a.filePath);
  });

  // Prioritize unindexed or modified-since-store sessions ahead of already-indexed
  // sessions so newer cleanly-closed sessions never crowd out older crashed/unclosed
  // sessions, while still scanning recent indexed files (via mtime cache) for
  // unindexed branch summaries or post-compaction turns.
  const priorityCandidates: typeof candidates = [];
  const indexedCandidates: typeof candidates = [];
  for (const item of candidates) {
    const storeMs = item.canonicalId ? latestStoreTsBySession.get(item.canonicalId) : undefined;
    if (storeMs !== undefined && item.st.mtimeMs <= storeMs + MTIME_SUPERSEDE_TOLERANCE_MS) {
      indexedCandidates.push(item);
    } else {
      priorityCandidates.push(item);
    }
  }

  const prioritySelected = priorityCandidates.slice(0, MAX_RECENT_SESSION_FILES);
  const remainingSlots = MAX_RECENT_SESSION_FILES - prioritySelected.length;
  const selected = remainingSlots > 0
    ? [...prioritySelected, ...indexedCandidates.slice(0, remainingSlots)]
    : prioritySelected;

  const scanned: CachedSessionScan[] = [];
  for (const { filePath, st } of selected) {
    const entry = scanSessionJsonlFile(filePath, st);
    if (entry && !entry.isSubagent && (!excludeSessionId || entry.sessionId !== excludeSessionId)) {
      scanned.push(entry);
    }
  }

  log.debug("session-search: scanned recent project sessions", {
    dir,
    candidates: candidates.length,
    priority: priorityCandidates.length,
    selected: selected.length,
    scanned: scanned.length,
  });

  return scanned;
}

// ── Search sessions ────────────────────────────────────────────────────────

export interface SearchResult {
  sessionId: string;
  timestamp: string;
  snippet: string;
  score: number;
}

export function searchSessions(
  cwd: string,
  query: string,
  limit: number = 10,
  options?: SearchSessionsOptions,
): SearchResult[] {
  if (limit <= 0) return [];
  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryWords.length === 0) return [];

  const excludeSessionId = options?.excludeSessionId?.trim() || undefined;
  const store = loadStore(cwd);
  const candidates: SessionEntry[] = [];

  const seenExact = new Set<string>();
  const latestStoreTsBySession = new Map<string, number>();
  for (const entry of store.entries) {
    seenExact.add(`${entry.sessionId}\0${entry.summary.trim()}`);
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) {
      const prev = latestStoreTsBySession.get(entry.sessionId);
      if (prev === undefined || parsed > prev) {
        latestStoreTsBySession.set(entry.sessionId, parsed);
      }
    }
    if (!excludeSessionId || entry.sessionId !== excludeSessionId) {
      candidates.push(entry);
    }
  }

  // Merge recent project session JSONLs (active, uncompacted, or abnormally terminated)
  const scannedSessions = scanRecentProjectSessions(
    cwd,
    latestStoreTsBySession,
    options?.sessionsDir,
    excludeSessionId,
  );
  for (const scanned of scannedSessions) {
    for (const s of scanned.effectiveSummaries) {
      const key = `${scanned.sessionId}\0${s.summary}`;
      if (seenExact.has(key)) continue;
      seenExact.add(key);
      candidates.push({
        sessionId: scanned.sessionId,
        timestamp: s.timestamp,
        summary: s.summary,
      });
    }

    if (scanned.effectiveTailSummary) {
      // If no compaction occurred on disk and a persisted store summary is at least
      // as recent as the session's last activity, the store entry supersedes raw messages.
      const storeMs = latestStoreTsBySession.get(scanned.sessionId);
      const supersedeToleranceMs = scanned.effectiveSawEntryTimestamp
        ? SUPERSEDE_TOLERANCE_MS
        : MTIME_SUPERSEDE_TOLERANCE_MS;
      const supersededByStore =
        scanned.effectiveSummaries.length === 0 &&
        storeMs !== undefined &&
        storeMs >= scanned.effectiveLastActivityMs - supersedeToleranceMs;

      if (!supersededByStore) {
        const key = `${scanned.sessionId}\0${scanned.effectiveTailSummary}`;
        if (!seenExact.has(key)) {
          seenExact.add(key);
          candidates.push({
            sessionId: scanned.sessionId,
            timestamp: scanned.effectiveLastActivityIso,
            summary: scanned.effectiveTailSummary,
          });
        }
      }
    }
  }

  if (candidates.length === 0) return [];

  // Keep highest-scoring (then most recent) match per sessionId to avoid duplicate session hits
  const bestBySession = new Map<string, SearchResult>();

  for (const entry of candidates) {
    const summaryLower = entry.summary.toLowerCase();

    // Score: count how many query words match
    let matchCount = 0;
    for (const word of queryWords) {
      if (summaryLower.includes(word)) matchCount++;
    }

    if (matchCount === 0) continue;

    // Extract snippet around first match
    const firstWord = queryWords.find((w) => summaryLower.includes(w))!;
    const matchIdx = summaryLower.indexOf(firstWord);
    const snippetStart = Math.max(0, matchIdx - 80);
    const snippetEnd = Math.min(entry.summary.length, matchIdx + 120);
    let snippet = entry.summary.slice(snippetStart, snippetEnd).trim();
    if (snippetStart > 0) snippet = "..." + snippet;
    if (snippetEnd < entry.summary.length) snippet = snippet + "...";

    const candidate: SearchResult = {
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      snippet,
      score: matchCount / queryWords.length,
    };

    const existing = bestBySession.get(entry.sessionId);
    if (
      !existing ||
      candidate.score > existing.score ||
      (candidate.score === existing.score && candidate.timestamp.localeCompare(existing.timestamp) > 0)
    ) {
      bestBySession.set(entry.sessionId, candidate);
    }
  }

  const results = Array.from(bestBySession.values());

  // Sort by score (desc), then recency (desc)
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.timestamp.localeCompare(a.timestamp);
  });

  return results.slice(0, limit);
}



// ── Tool Registration ──────────────────────────────────────────────────────

export function registerSessionSearch(pi: ExtensionAPI): void {
  // Only register in the orchestrator, not subagents
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: "Search past conversation summaries by keyword; returns matching snippets at zero LLM cost.",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords or phrase" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default: 10)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = searchSessions(ctx.cwd, params.query, params.limit ?? 10);

      if (results.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No past sessions found matching "${params.query}".`,
          }],
          details: undefined,
        };
      }

      const lines = results.map((r) =>
        `**${r.timestamp.split("T")[0]}** (${r.sessionId.slice(0, 8)})\n${r.snippet}`
      );

      return {
        content: [{
          type: "text",
          text: `Found ${results.length} past session(s) matching "${params.query}":\n\n${lines.join("\n\n---\n\n")}`,
        }],
        details: undefined,
      };
    },
  });

  // Accumulate user messages for session-end indexing
  let sessionMessages: string[] = [];
  let sessionCwd = "";
  let sessionId = "";
  let sessionFile = "";

  pi.on("session_start", (_event, ctx) => {
    sessionMessages = [];
    sessionCwd = ctx.cwd;
    sessionId = ctx.sessionManager?.getSessionId?.() || `session-${Date.now()}`;
    sessionFile = (ctx as any).sessionManager?.getSessionFile?.() || "";
  });

  pi.on("input", (event, _ctx) => {
    const text = event?.text;
    if (typeof text !== "string") return;
    const cleaned = cleanUserMessageForIndex(text);
    if (!cleaned) return;
    sessionMessages.push(cleaned.slice(0, 200));
  });

  // Index compaction summaries when context is compacted
  pi.on("session_compact", (event, ctx) => {
    try {
      // Overflow retries produce the real summary on the next attempt —
      // indexing the aborted attempt would duplicate content (issue #915).
      if ((event as any)?.willRetry) {
        log.debug("session-search: skipping willRetry compaction summary");
        return;
      }
      const summary = event?.compactionEntry?.summary;
      if (!summary || summary.length < 50) return;
      const cwd = sessionCwd || ctx.cwd;
      const sid = sessionId || ctx.sessionManager?.getSessionId?.() || `session-${Date.now()}`;
      indexSessionSummary(cwd, sid, summary);
      // Compaction covers all prior turns; clear buffered raw messages so a later
      // session_shutdown fallback does not re-index stale pre-compaction prompts.
      sessionMessages = [];
      log.debug("session-search: indexed compaction summary", { reason: (event as any)?.reason });
    } catch (err) {
      log.warn("session-search: indexing failed on compact:", err);
    }
  });

  // Index summaries on session shutdown — prefer pi's own LLM-written
  // compaction and branch summaries from the session file (issue #915);
  // fall back to joined user messages when none exist.
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      if (!sessionCwd) return;
      const file = sessionFile || (ctx ? (ctx as any).sessionManager?.getSessionFile?.() || "" : "");
      const summaries = file ? extractSessionSummaries(file) : [];

      if (summaries.length > 0) {
        for (const summary of summaries) {
          indexSessionSummary(sessionCwd, sessionId, summary);
        }
        log.info("session-search: harvested session summaries", summaries.length);
        // Preserve any post-compaction user turns buffered after the last compaction
        if (sessionMessages.length > 0) {
          const tailSummary = sessionMessages.join(" | ").slice(0, 1000);
          indexSessionSummary(sessionCwd, sessionId, tailSummary);
        }
        return;
      }

      // Fallback: join cleaned user messages when no compaction occurred
      if (sessionMessages.length === 0) return;
      const summary = sessionMessages.join(" | ").slice(0, 1000);
      indexSessionSummary(sessionCwd, sessionId, summary);
    } catch (err) {
      log.warn("session-search: indexing failed on shutdown:", err);
    }
  });
}
