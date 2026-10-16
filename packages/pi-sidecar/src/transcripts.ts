/**
 * Session transcript recording (issue #922).
 *
 * Persists per-turn records — including full tool-call loops — as JSONL under
 * `{data_dir}/transcripts/{session_id}.jsonl`, so downstream analysis
 * (rootcoz) can mine repeated tool-call patterns and distill them into code.
 * Tool calls never leave the sidecar: every string in tool arguments and
 * results passes through the session's API-key redactor before it is written.
 *
 * OFF by default (`RECORD_TRANSCRIPTS`): disabled means zero I/O — no
 * directory creation, no file handles, no retention scans. When enabled,
 * every write is fail-soft: a transcript failure is logged and swallowed,
 * never propagated into the prompt response path.
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
 */
export function transcriptsDir(): string {
  return process.env.PI_SIDECAR_TRANSCRIPTS_DIR?.trim() || join(homedir(), ".pi", "sidecar", "transcripts");
}

/** Per-record byte cap: transcripts want full payloads, but a runaway tool
 *  result (a binary blob, a huge diff) must not fill the disk. */
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

/**
 * Recursively redact every string in a structured value through the session
 * redactor (tool arguments, tool result content, nested objects). Binary-ish
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
      out[key] = redactStructured(item, redact, seen);
    }
  } finally {
    seen.delete(value);
  }
  return out;
}

/** Fail-soft JSON line: never throws, bounds the record size. */
function serializeRecord(record: Record<string, unknown>): string | null {
  try {
    const line = JSON.stringify(record);
    if (typeof line !== "string") return null;
    return line.length > MAX_RECORD_BYTES
      ? `${JSON.stringify({ ...record, messages: "[record over size cap omitted]" })}\n`
      : `${line}\n`;
  } catch (error) {
    log.warn(`serialize failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function appendLine(filePath: string, line: string): Promise<void> {
  await appendFile(filePath, line, "utf-8");
}

/**
 * Write the one-time session header record. Called on session creation when
 * recording is enabled; any failure is logged and swallowed.
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
  try {
    const dir = transcriptsDir();
    await mkdir(dir, { recursive: true });
    const line = serializeRecord({
      type: "session_header",
      timestamp: new Date().toISOString(),
      session_id: header.sessionId,
      provider: header.provider,
      model: header.model,
      system_prompt: header.systemPrompt ? header.redact(header.systemPrompt) : undefined,
      cwd: header.cwd,
      custom_tools: header.customTools,
    });
    if (line) {
      await appendLine(join(dir, `${header.sessionId}.jsonl`), line);
      log.info(`session header written: session=${header.sessionId}`);
    }
  } catch (error) {
    log.warn(`session header write failed (swallowed): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Append one turn record: the full redacted `agent_end` message array (user
 * prompt, assistant text, tool calls with arguments, tool results), the
 * aggregated usage, and the final stop reason. Fail-soft by contract — the
 * prompt response path must never fail over a transcript write.
 */
export async function appendTurn(
  turn: {
    sessionId: string;
    turnNumber: number;
    messages: unknown[];
    usage: Record<string, unknown>;
    stopReason?: string;
    redact: (value: string) => string;
  },
): Promise<void> {
  try {
    const line = serializeRecord({
      type: "turn",
      timestamp: new Date().toISOString(),
      session_id: turn.sessionId,
      turn_number: turn.turnNumber,
      messages: redactStructured(turn.messages, turn.redact),
      usage: turn.usage,
      stop_reason: turn.stopReason,
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
 * Opportunistic retention cleanup, run (at most) on header writes: deletes
 * the oldest transcript files when the directory exceeds the age or size
 * budget. PI_SIDECAR_TRANSCRIPTS_MAX_AGE_DAYS (0 disables age pruning) and
 * PI_SIDECAR_TRANSCRIPTS_MAX_SIZE_MB (0 disables size pruning). Bounded work,
 * fail-soft.
 */
export async function enforceRetention(): Promise<void> {
  try {
    const dir = transcriptsDir();
    const maxAgeDays = Number(process.env.PI_SIDECAR_TRANSCRIPTS_MAX_AGE_DAYS ?? "0");
    const maxSizeMb = Number(process.env.PI_SIDECAR_TRANSCRIPTS_MAX_SIZE_MB ?? "0");
    if (!maxAgeDays && !maxSizeMb) return;
    const entries = await readdir(dir).catch(() => []);
    const files: Array<{ name: string; path: string; mtimeMs: number; size: number }> = [];
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = join(dir, name);
      try {
        const st = await stat(filePath);
        if (st.isFile()) files.push({ name, path: filePath, mtimeMs: st.mtimeMs, size: st.size });
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
