/**
 * JSONL-backed synchronous state persistence.
 *
 * Replaces ad-hoc JSON read/write with an append-only JSONL file.
 * Each mutation appends a single JSON line — if the process crashes mid-write,
 * the previous state is still intact (worst case: a truncated last line that
 * gets skipped on read). Provides:
 *
 *   - **Append-only durability** — writes never corrupt existing data
 *   - **Crash recovery** — last valid JSON line wins
 *   - **State history** — the JSONL file is a log of all state transitions
 *   - **Compaction** — rewrites to a single line when the file grows too large
 *
 * All operations are synchronous to match the existing extension API surface
 * (enforcement hooks, status bar pollers, transition callbacks).
 *
 * Part of issue #724: migrate state persistence to JSONL.
 */

import { appendFileSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export interface JsonlStateStoreOptions {
  /** Maximum number of lines before automatic compaction (default: 100). */
  compactThreshold?: number;
}

const DEFAULT_COMPACT_THRESHOLD = 100;

/**
 * Synchronous JSONL state store.
 *
 * Usage:
 * ```ts
 * const store = new JsonlStateStore<MyState>(filePath);
 * const state = store.read();          // null if no state
 * store.write({ ...state, field: 1 }); // appends a line
 * ```
 */
export class JsonlStateStore<T> {
  private readonly filePath: string;
  private readonly compactThreshold: number;
  private lineCount: number;

  constructor(filePath: string, options?: JsonlStateStoreOptions) {
    this.filePath = filePath;
    this.compactThreshold = options?.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    // Initialize lineCount from existing file to ensure compaction triggers
    // correctly across process restarts and multi-process writers.
    this.lineCount = this.countExistingLines();
  }

  /** Count non-empty lines in the existing JSONL file. Returns 0 if file doesn't exist. */
  private countExistingLines(): number {
    if (!existsSync(this.filePath)) return 0;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      let count = 0;
      for (const line of raw.split("\n")) {
        if (line.trim()) count++;
      }
      return count;
    } catch {
      return 0;
    }
  }

  /** Read the latest state from the JSONL file. Returns null if no valid state exists. */
  read(): T | null {
    if (!existsSync(this.filePath)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return null;
    }
    return parseLastValidLine<T>(raw);
  }

  /** Append a new state snapshot as a JSON line. Auto-compacts when threshold is exceeded.
   *  Uses a cross-process lock to prevent concurrent write+compact races. */
  write(state: T): void {
    ensureDir(this.filePath);
    withFileLock(this.filePath, () => {
      const line = JSON.stringify(state) + "\n";
      appendFileSync(this.filePath, line);
      this.lineCount++;

      // Check if compaction is needed using in-memory counter (no file re-read)
      if (this.lineCount >= this.compactThreshold) {
        this.compactInner();
      }
    });
  }

  /** Compact the JSONL file to a single line containing the latest state.
   *  Always re-reads the file to get the latest state — prevents overwriting
   *  newer data from concurrent writers. Uses atomic rename + cross-process lock. */
  compact(currentState?: T): void {
    withFileLock(this.filePath, () => {
      this.compactInner(currentState);
    });
  }

  /** Internal compact — must be called within a lock. */
  private compactInner(currentState?: T): void {
    const state = currentState ?? this.read();
    if (state === null) return;
    const tmp = `${this.filePath}.${process.pid}.compact`;
    try {
      writeFileSync(tmp, JSON.stringify(state) + "\n");
      renameSync(tmp, this.filePath);
      this.lineCount = 1;
    } catch {
      // Compaction failure is non-fatal — the file still has valid data
    }
  }

  /** Check if the file exists. */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  /** Get the file path. */
  get path(): string {
    return this.filePath;
  }

}

/**
 * Parse the last valid JSON line from raw JSONL content.
 * Scans from the end for efficiency — the last line is what we want.
 * Handles truncated last lines (crash recovery) by falling back to the previous line.
 */
export function parseLastValidLine<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Fast path: line-by-line scan from end — efficient for well-formed JSONL
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      return JSON.parse(line) as T;
    } catch {
      // Truncated or corrupted line — skip and try previous
      continue;
    }
  }

  // Fallback: try parsing the entire content as a single multi-line JSON object.
  // Handles cases where an LLM agent pretty-prints JSON with newlines
  // (e.g., dream provenance sidecar). Only reached when NO individual line
  // parses as valid JSON — no performance cost for normal JSONL files.
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Not valid JSON either — truly empty/corrupt
  }
  return null;
}

// ── JsonlAppendLog ─────────────────────────────────────────────────────────

export interface JsonlAppendLogOptions {
  /** Maximum file size in bytes before truncation (default: 512KB). */
  maxSizeBytes?: number;
  /** Number of lines to keep when truncating (default: 200). */
  keepLines?: number;
}

const DEFAULT_MAX_SIZE = 512_000; // 512KB
const DEFAULT_KEEP_LINES = 200;

/**
 * Synchronous append-only JSONL log.
 *
 * Unlike JsonlStateStore (which reads the latest state), this is for
 * append-only event logs like telemetry. Each append adds a JSON line
 * with an auto-incremented sequence number. Size-based truncation
 * prevents unbounded growth.
 *
 * Usage:
 * ```ts
 * const log = new JsonlAppendLog<TelemetryEvent>(filePath);
 * log.append({ event: "inject", count: 3 }); // adds { seq: 1, ts: "...", ...data }
 * ```
 */
export class JsonlAppendLog<T extends object> {
  private readonly filePath: string;
  private readonly maxSizeBytes: number;
  private readonly keepLines: number;
  private seq: number;

  constructor(filePath: string, options?: JsonlAppendLogOptions) {
    this.filePath = filePath;
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE;
    this.keepLines = options?.keepLines ?? DEFAULT_KEEP_LINES;
    // Initialize seq from existing log to prevent reset on restart
    this.seq = this.readLastSeq();
  }

  /** Read the last seq number from the existing log file. Returns 0 if no log exists. */
  private readLastSeq(): number {
    if (!existsSync(this.filePath)) return 0;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry.seq === "number") return entry.seq;
        } catch { continue; }
      }
    } catch { /* ignore */ }
    return 0;
  }

  /** Append a log entry. Adds `seq` (auto-incremented) and `ts` (ISO timestamp) fields.
   *  Auto-truncates when file exceeds size limit.
   *  Uses cross-process lock to prevent seq duplicates and protect truncation. */
  append(data: T): void {
    ensureDir(this.filePath);
    withFileLock(this.filePath, () => {
      this.seq++;
      const entry = { seq: this.seq, ts: new Date().toISOString(), ...data };
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n");

      // Size-based truncation inside lock to prevent overwriting concurrent appends
      this.truncateIfNeeded();
    });
  }

  /** Read all valid log entries. Returns empty array if file doesn't exist. */
  readAll(): Array<T & { seq: number; ts: string }> {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const entries: Array<T & { seq: number; ts: string }> = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Skip corrupt/truncated lines
        continue;
      }
    }
    return entries;
  }

  /** Check if the log file exists. */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  /** Get the file path. */
  get path(): string {
    return this.filePath;
  }

  /** Truncate file to keepLines if it exceeds maxSizeBytes. */
  private truncateIfNeeded(): void {
    try {
      const stat = statSync(this.filePath);
      if (stat.size <= this.maxSizeBytes) return;

      const raw = readFileSync(this.filePath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const kept = lines.slice(-this.keepLines);
      const tmp = `${this.filePath}.${process.pid}.truncate`;
      writeFileSync(tmp, kept.join("\n") + "\n");
      renameSync(tmp, this.filePath);
    } catch {
      // Truncation failure is non-fatal
    }
  }
}

// ── Cross-process file lock ────────────────────────────────────────────────
// Prevents concurrent write+compact races between orchestrator and subagents.
// Same pattern as pi-config-review-state.ts lock mechanism.

const fileLockDepth = new Map<string, number>();

/** Execute fn while holding a cross-process lock on the JSONL file.
 *  Lock file: <path>.wlock with PID. Uses ".wlock" suffix to avoid collision
 *  with pi-config-review-state's ".lock" suffix (separate depth maps). */
function withFileLock(filePath: string, fn: () => void): void {
  const lockFile = filePath + ".wlock";
  const depth = fileLockDepth.get(lockFile) || 0;
  if (depth === 0) {
    if (!acquireFileLock(lockFile)) {
      // Lock acquisition failed — proceed without lock (non-fatal, same as before)
      fn();
      return;
    }
  }
  fileLockDepth.set(lockFile, depth + 1);
  try {
    fn();
  } finally {
    const newDepth = (fileLockDepth.get(lockFile) || 1) - 1;
    if (newDepth <= 0) {
      fileLockDepth.delete(lockFile);
      releaseFileLock(lockFile);
    } else {
      fileLockDepth.set(lockFile, newDepth);
    }
  }
}

function acquireFileLock(lockFile: string): boolean {
  const maxRetries = 50;
  for (let i = 0; i < maxRetries; i++) {
    try {
      ensureDir(lockFile);
      writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const pid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
        if (pid === process.pid) return true; // Reentrant
        if (pid) {
          try { process.kill(pid, 0); } catch {
            try { unlinkSync(lockFile); } catch { /* race */ }
            continue;
          }
        }
      } catch {
        try { unlinkSync(lockFile); } catch { /* race */ }
        continue;
      }
    }
  }
  return false;
}

function releaseFileLock(lockFile: string): void {
  try { unlinkSync(lockFile); } catch { /* ignore */ }
}

/** Ensure the parent directory exists. */
function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
