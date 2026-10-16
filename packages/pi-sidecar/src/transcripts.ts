/**
 * Session transcript recording (issue #922).
 *
 * Persists per-turn records — including full tool-call loops — as JSONL under
 * `{transcripts_dir}/{session_id}.jsonl`, so downstream analysis (rootcoz)
 * can mine repeated tool-call patterns and distill them into code.
 * Tool calls never leave the sidecar: every string in tool arguments and
 * results — including object property names — passes through the session's
 * API-key redactor before it is written.
 *
 * OFF by default (`RECORD_TRANSCRIPTS`): disabled means zero I/O — no
 * directory creation, no file handles, no retention scans. When enabled,
 * every write is fail-soft: a transcript failure is logged and swallowed,
 * never propagated into the prompt response path.
 *
 * Write ordering (#923 review): writes for a session are chained per session
 * in turn order (`queueTurn`), so a header always precedes its turns and
 * turn N+1 is never interleaved ahead of turn N. Heavy work (redaction walk
 * + serialization) is deferred off the response-critical `agent_end`
 * callback via `setImmediate`, and `drainTranscriptWrites()` lets shutdown
 * await outstanding records instead of losing them.
 */

import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("transcripts");

/** Truthy values accepted for env toggles (matches PI_SIDECAR_LOG_LEVEL style). */
function isEnvTruthy(raw: string | undefined): boolean {
  const v = raw?.toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Recording is enabled only when RECORD_TRANSCRIPTS is explicitly truthy. */
export function transcriptsEnabled(): boolean {
  return isEnvTruthy(process.env.RECORD_TRANSCRIPTS);
}

/**
 * Directory holding one `{session_id}.jsonl` per recorded session. Default
 * `~/.pi/sidecar/transcripts` — durable, per-user (NOT the agent dir, whose
 * default lives under /tmp). Override with PI_SIDECAR_TRANSCRIPTS_DIR.
 * Container deployments (e.g. RootCoz) MUST point this at a persisted volume
 * (RootCoz: a writable subdirectory of /data) — see the README section
 * "Session Transcripts".
 */
export function transcriptsDir(): string {
  return process.env.PI_SIDECAR_TRANSCRIPTS_DIR?.trim() || join(homedir(), ".pi", "sidecar", "transcripts");
}

/** Per-record byte cap: transcripts want full payloads, but a runaway tool
 *  result (a binary blob, a huge diff) must not fill the disk. Measured in
 *  UTF-8 bytes, not characters — multibyte content must not slip past. */
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

/**
 * Recursively redact every string in a structured value through the session
 * redactor (tool arguments, tool result content, nested objects). Property
 * NAMES are redacted too — a tool result whose property is named after the
 * credential itself must not persist that name. Binary-ish
 * values (Uint8Array/Buffer), functions, and symbols are replaced with
 * placeholders; circular references are cut at depth. NOT redactDiagnostic —
 * that helper omits oversized diagnostics, while transcripts intentionally
 * keep full (redacted) payloads, bounded by MAX_RECORD_BYTES instead.
 */
export function redactStructured(value: unknown, redact: (value: string) => string, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value; // numbers, booleans, undefined
  if (seen.has(value)) return "[circular]";
  if (value instanceof Uint8Array || typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return "[binary omitted]";
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      return value.map((item) => redactStructured(item, redact, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    // Date and friends — serialize via toJSON, then redact the result if string
    try {
      const json = (value as { toJSON: () => unknown }).toJSON();
      return typeof json === "string" ? redact(json) : redactStructured(json, redact, seen);
    } catch {
      return "[toJSON failed]";
    }
  }
  seen.add(value);
  const out: Record<string, unknown> = {};
  try {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[redact(key)] = redactStructured(item, redact, seen);
    }
  } finally {
    seen.delete(value);
  }
  return out;
}

/**
 * Fail-soft JSON line: never throws, bounds the record size in UTF-8 bytes.
 * An oversized record (header or turn alike) is replaced by a small bounded
 * placeholder that keeps its type and identifiers — the full payload is
 * dropped, never written in full past the cap.
 */
function serializeRecord(record: Record<string, unknown>): string | null {
  try {
    const line = JSON.stringify(record);
    if (typeof line !== "string") return null;
    if (Buffer.byteLength(line, "utf-8") <= MAX_RECORD_BYTES) return `${line}\n`;
    return `${JSON.stringify({
      type: record.type,
      session_id: record.session_id,
      turn_number: record.turn_number,
      note: "record over size cap omitted",
    })}\n`;
  } catch (error) {
    log.warn(`serialize failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function appendLine(filePath: string, line: string): Promise<void> {
  await appendFile(filePath, line, "utf-8");
}

/** Yield to the event loop so heavy synchronous work (redaction walk,
 *  serialization) never runs inside the response-critical agent_end callback. */
function deferToNextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Per-session chained writes: each session's records append strictly in call
 * order (header → turn 1 → turn 2 → …), failures never break the chain, and
 * the map entry is dropped once the tail settles so it cannot leak.
 */
const transcriptChains = new Map<string, Promise<void>>();

function chainWrite(sessionId: string, write: () => Promise<void>): Promise<void> {
  const chained = (transcriptChains.get(sessionId) ?? Promise.resolve())
    .then(write)
    .then(() => undefined, () => undefined); // appendTurn/writeSessionHeader are fail-soft; belt and braces
  const settled = chained.then(() => {
    if (transcriptChains.get(sessionId) === settled) transcriptChains.delete(sessionId);
  }, () => {
    if (transcriptChains.get(sessionId) === settled) transcriptChains.delete(sessionId);
  });
  transcriptChains.set(sessionId, settled);
  return chained;
}

/**
 * Await all outstanding transcript writes (bounded: 10s). Called from
 * disposeAll() so shutdown does not lose already-completed turns.
 */
export async function drainTranscriptWrites(): Promise<void> {
  const pending = [...transcriptChains.values()];
  if (pending.length === 0) return;
  const bounded = Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref?.()),
  ]);
  await bounded;
  log.debug(`drained ${pending.length} transcript write chain(s)`);
}

/**
 * Write the one-time session header record. Called on session creation when
 * recording is enabled; any failure is logged and swallowed. Every
 * string-valued field — provider, model, system prompt, cwd, tool names —
 * passes through the session redactor: caller-supplied metadata must never
 * persist a credential in cleartext.
 */
export async function writeSessionHeader(
  header: {
    sessionId: string;
    provider: string;
    model: string;
    systemPrompt?: string;
    cwd?: string;
    customTools?: string[];
    redact: (value: string) => string;
  },
): Promise<void> {
  return chainWrite(header.sessionId, async () => {
    try {
      const dir = transcriptsDir();
      await mkdir(dir, { recursive: true });
      const now = new Date().toISOString();
      const line = serializeRecord({
        type: "session_header",
        timestamp: now,
        created_at: now,
        session_id: header.sessionId,
        provider: header.redact(header.provider),
        model: header.redact(header.model),
        system_prompt: header.systemPrompt ? header.redact(header.systemPrompt) : undefined,
        cwd: header.cwd ? header.redact(header.cwd) : undefined,
        custom_tools: (header.customTools ?? []).map((name) => header.redact(name)),
      });
      if (line) {
        await appendLine(join(dir, `${header.sessionId}.jsonl`), line);
        log.info(`session header written: session=${header.sessionId}`);
      }
    } catch (error) {
      log.warn(`session header write failed (swallowed): ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * Append one turn record: the full redacted `agent_end` message array (user
 * prompt, assistant text, tool calls with arguments, tool results), the
 * final response text, the aggregated usage, and the final stop reason.
 * Fail-soft by contract — the prompt response path must never fail over a
 * transcript write. Heavy work is deferred past the response callback.
 */
export async function appendTurn(
  turn: {
    sessionId: string;
    turnNumber: number;
    messages: unknown[];
    usage: Record<string, unknown>;
    stopReason?: string;
    /** Final assembled response text (already extracted by the prompt path). */
    finalText?: string;
    /** Error summaries when the prompt rejected without an agent_end event. */
    errors?: string[];
    redact: (value: string) => string;
  },
): Promise<void> {
  // Defer BEFORE the redaction walk and serialization: the agent_end callback
  // returns immediately; unbounded CPU work happens on a later tick.
  await deferToNextTick();
  try {
    const line = serializeRecord({
      type: "turn",
      timestamp: new Date().toISOString(),
      session_id: turn.sessionId,
      turn_number: turn.turnNumber,
      messages: redactStructured(turn.messages, turn.redact),
      final_text: turn.finalText !== undefined ? turn.redact(turn.finalText) : undefined,
      usage: turn.usage,
      stop_reason: turn.stopReason,
      ...(turn.errors ? { errors: turn.errors.map((e) => turn.redact(e)) } : {}),
    });
    if (line) {
      const dir = transcriptsDir();
      // Idempotent: a turn can arrive without a preceding header write
      // (e.g. the directory was rotated away mid-session).
      await mkdir(dir, { recursive: true });
      await appendLine(join(dir, `${turn.sessionId}.jsonl`), line);
      log.debug(`turn recorded: session=${turn.sessionId}, turn=${turn.turnNumber}`);
    }
  } catch (error) {
    log.warn(`turn write failed (swallowed): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Queue a turn write on the session's ordered chain. Fire-and-forget from
 * the prompt path; ordering with the session header and earlier turns is
 * preserved by `chainWrite`.
 */
export function queueTurn(
  turn: {
    sessionId: string;
    turnNumber: number;
    messages: unknown[];
    usage: Record<string, unknown>;
    stopReason?: string;
    finalText?: string;
    errors?: string[];
    redact: (value: string) => string;
  },
): void {
  void chainWrite(turn.sessionId, () => appendTurn(turn));
}

/** Retention scan throttle: at most one scan per minute from the turn path. */
const RETENTION_INTERVAL_MS = 60_000;
let lastRetentionRun = 0;

/**
 * Opportunistic retention cleanup: deletes the oldest transcript files when
 * the directory exceeds the age or size budget. PI_SIDECAR_TRANSCRIPTS_MAX_AGE_DAYS
 * (0 disables age pruning) and PI_SIDECAR_TRANSCRIPTS_MAX_SIZE_MB (0 disables
 * size pruning). Files belonging to ACTIVE sessions (`activeSessions`) are
 * never deleted — an in-flight session must not lose its header and turn
 * history to its own size. Bounded work, fail-soft.
 */
export async function enforceRetention(activeSessions?: Set<string>): Promise<void> {
  try {
    const dir = transcriptsDir();
    const maxAgeDays = Number(process.env.PI_SIDECAR_TRANSCRIPTS_MAX_AGE_DAYS ?? "0");
    const maxSizeMb = Number(process.env.PI_SIDECAR_TRANSCRIPTS_MAX_SIZE_MB ?? "0");
    if (!maxAgeDays && !maxSizeMb) return;
    const entries = await readdir(dir).catch(() => [] as string[]);
    const files: Array<{ name: string; stem: string; path: string; mtimeMs: number; size: number }> = [];
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const stem = name.slice(0, -".jsonl".length);
      if (activeSessions?.has(stem)) continue; // never prune a live session's transcript
      const filePath = join(dir, name);
      try {
        const st = await stat(filePath);
        if (st.isFile()) files.push({ name, stem, path: filePath, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // raced away — skip
      }
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    const ageCutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : 0;
    let totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const sizeBudget = maxSizeMb > 0 ? maxSizeMb * 1024 * 1024 : Infinity;
    let removed = 0;
    for (const file of files) {
      const tooOld = ageCutoff > 0 && file.mtimeMs < ageCutoff;
      const tooBig = totalSize > sizeBudget;
      if (!tooOld && !tooBig) break;
      await unlink(file.path).catch(() => {});
      totalSize -= file.size;
      removed++;
    }
    if (removed > 0) log.info(`retention removed ${removed} transcript file(s)`);
  } catch (error) {
    log.warn(`retention cleanup failed (swallowed): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Throttled retention trigger for the turn-write path: ongoing sessions
 * produce turns without new headers, so budgets must be re-checked while
 * writing, not only at creation. At most one scan per RETENTION_INTERVAL_MS;
 * active sessions are excluded by the caller-supplied set.
 */
export function maybeEnforceRetention(activeSessions?: Set<string>): void {
  const now = Date.now();
  if (now - lastRetentionRun < RETENTION_INTERVAL_MS) return;
  lastRetentionRun = now;
  void enforceRetention(activeSessions);
}
