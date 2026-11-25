/**
 * Sync agent run registry — visibility for sync subagents.
 *
 * A sync subagent is a real child `pi` process (see `runSingleAgent`), and parallel mode
 * runs several at once, but it is invisible to the footer, `/async-status` and pidash
 * because those only read `asyncState.jobs`. This registry is process-local and holds
 * nothing but what those three surfaces render.
 *
 * Visibility only: a sync agent's result still arrives in the orchestrator's turn, not as
 * a follow-up message. Do not route delivery through here.
 */

import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../shared/logger.js";
import { getProjectTmpDir } from "./utils.js";

const log = createLogger("sync-agent-runs");

export interface SyncAgentRun {
  id: string;
  agent: string;
  task: string;
  cwd: string;
  startedAt: number;
  status: "running" | "complete" | "failed";
  currentTool?: string;
  endedAt?: number;
  exitCode?: number;
  /** Where this run's status.json lives, in the async layout the overlay already reads. */
  workerDir: string;
  pid?: number;
  /** Bounded recent assistant text output captured while the sync child runs. */
  outputTail?: string;
}

interface SyncAgentRunEntry extends SyncAgentRun {
  /** Terminates the child process: SIGTERM, then SIGKILL. Set once the spawn exists. */
  abort?: () => void;
  /** A stop asked for before the spawn existed; `setAbort` reports it so the caller kills at once. */
  pendingStop?: boolean;
  /** Who stopped it, kept so the final status.json still names it after `end()` rewrites. */
  killOrigin?: string;
}

/** Live runs — an entry leaves this map only in `end()`, i.e. once the child is gone. */
const runs = new Map<string, SyncAgentRunEntry>();
/**
 * Finished runs kept for a short grace window. A detail view opened while the run was running
 * must not keep saying "running" with a growing duration once the child is gone.
 */
const finished = new Map<string, SyncAgentRunEntry>();
const FINISHED_GRACE_MS = 60_000;
/** Bound on retained finished runs so a long session cannot grow the map. */
const FINISHED_LIMIT = 20;
const MAX_OUTPUT_TAIL_CHARS = 24_000;
const listeners = new Set<() => void>();
let counter = 0;

/** The worker dir is throwaway: drop it with the row it describes. */
function removeWorkerDir(workerDir: string): void {
  try {
    fs.rmSync(workerDir, { recursive: true, force: true });
  } catch (e: any) {
    log.warn("worker_dir_remove_failed", { workerDir, error: e?.message || String(e) });
  }
}

/**
 * Namespace for this session's run ids and worker dirs. Two sessions can share a cwd, so a
 * bare counter would hand both of them `sync-1`: they would overwrite each other's status and
 * one teardown would delete the other's live dir.
 */
function sessionScope(): string {
  const sid = (globalThis as any).__piConfigSessionId;
  const safe = String(sid ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  return safe || String(process.pid);
}

/**
 * Write the run's status.json. Same shape an async job writes, so the overlay's
 * `readLiveStatus(workerDir)` renders a sync row without a second code path.
 * Best-effort: visibility must never break the run itself.
 */
function writeStatus(run: SyncAgentRunEntry): void {
  const target = path.join(run.workerDir, "status.json");
  try {
    fs.mkdirSync(run.workerDir, { recursive: true });
    // The dir and file names are predictable, so a hostile checkout can pre-place either as a
    // symlink and we would write run metadata through it. Refuse the dir, replace the file.
    if (fs.lstatSync(run.workerDir).isSymbolicLink()) {
      log.warn("status_write_refused_symlinked_dir", { id: run.id, workerDir: run.workerDir });
      return;
    }
    // Removes a link, never its target. `wx` then fails on anything re-created in between
    // instead of following it.
    try {
      fs.rmSync(target, { force: true });
    } catch (e: any) {
      log.warn("status_unlink_failed", { id: run.id, target, error: e?.message || String(e) });
      return;
    }
    fs.writeFileSync(
      target,
      JSON.stringify({
        runId: run.id,
        agent: run.agent,
        task: run.task,
        state: run.status,
        startedAt: run.startedAt,
        ...(run.pid != null ? { pid: run.pid } : {}),
        ...(run.currentTool ? { tool: run.currentTool } : {}),
        ...(run.endedAt != null ? { endedAt: run.endedAt } : {}),
        ...(run.killOrigin ? { killOrigin: run.killOrigin } : {}),
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (e: any) {
    log.warn("status_write_failed", { id: run.id, workerDir: run.workerDir, error: e?.message || String(e) });
  }
}

/** Drop expired finished runs, then the oldest beyond the cap. */
function pruneFinished(now = Date.now()): void {
  for (const [id, run] of finished) {
    if (now - (run.endedAt ?? now) >= FINISHED_GRACE_MS) {
      finished.delete(id);
      removeWorkerDir(run.workerDir);
    }
  }
  while (finished.size > FINISHED_LIMIT) {
    const oldest = finished.keys().next();
    if (oldest.done) break;
    removeWorkerDir(finished.get(oldest.value)!.workerDir);
    finished.delete(oldest.value);
  }
}

function strip({ abort: _abort, pendingStop: _pendingStop, killOrigin: _killOrigin, ...run }: SyncAgentRunEntry): SyncAgentRun {
  return run;
}

function notify(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (e: any) {
      log.warn("listener_failed", { error: e?.message || String(e) });
    }
  }
}

/** Register a sync run that is about to spawn; call `end` from a finally so it never leaks. */
export function beginSyncAgentRun(args: {
  agent: string;
  task: string;
  cwd: string;
}): {
  id: string;
  setTool: (tool?: string) => void;
  /** The child's pid, once the spawn exists, so a stuck child is findable on disk. */
  setPid: (pid: number) => void;
  /** Returns true when a stop was requested before the child existed — kill it right away. */
  setAbort: (fn: () => void) => boolean;
  /** Append streamed assistant text to the bounded in-memory tail for `async_status`. */
  appendOutput: (chunk: string) => void;
  end: (ok: boolean) => void;
} {
  const id = `sync-${sessionScope()}-${++counter}`;
  const entry: SyncAgentRunEntry = {
    id,
    agent: args.agent,
    task: args.task,
    cwd: args.cwd,
    // Same project temp dir as async jobs, in its own subtree so the async recovery and
    // zombie scans (which look for status.json/session.json directly under it) skip it.
    workerDir: path.join(getProjectTmpDir(args.cwd), "sync-runs", id),
    startedAt: Date.now(),
    status: "running",
  };
  runs.set(id, entry);
  writeStatus(entry);
  log.debug("begin", { id, agent: entry.agent, cwd: entry.cwd, workerDir: entry.workerDir });
  notify();

  return {
    id,
    setTool: (tool?: string) => {
      const run = runs.get(id);
      if (!run || run.status !== "running") return;
      if (run.currentTool === tool) return;
      run.currentTool = tool;
      writeStatus(run);
      log.debug("tool", { id, tool: tool ?? null });
      notify();
    },
    setPid: (pid: number) => {
      const run = runs.get(id);
      if (!run || run.status !== "running") return;
      run.pid = pid;
      writeStatus(run);
      log.debug("pid", { id, pid });
      notify();
    },
    setAbort: (fn: () => void): boolean => {
      const run = runs.get(id);
      if (!run) {
        log.warn("set_abort: run already ended", { id });
        return false;
      }
      run.abort = fn;
      log.debug("abort_registered", { id, pendingStop: Boolean(run.pendingStop) });
      return Boolean(run.pendingStop);
    },
    appendOutput: (chunk: string) => {
      if (!chunk) return;
      const run = runs.get(id);
      if (!run) return;
      const combined = (run.outputTail ?? "") + chunk;
      run.outputTail = combined.length > MAX_OUTPUT_TAIL_CHARS
        ? combined.slice(-MAX_OUTPUT_TAIL_CHARS)
        : combined;
    },
    end: (ok: boolean) => {
      const run = runs.get(id);
      if (run) {
        // A run that was stopped stays failed even if its child exited cleanly.
        run.status = ok && run.status === "running" ? "complete" : "failed";
        run.endedAt = Date.now();
        run.abort = undefined;
        run.pendingStop = false;
        runs.delete(id);
        finished.set(id, run);
        writeStatus(run);
        pruneFinished();
        log.debug("end", { id, agent: run.agent, status: run.status });
      }
      // Idempotent, but subscribers still hear about it: they re-read the registry, so a
      // repeat notify is harmless while a missed one would strand the footer.
      notify();
    },
  };
}

/**
 * Abort a running sync agent by run id. Never by agent name: two runs of one agent are two
 * children, and a name match would stop the wrong one.
 * Returns false when nothing matches (unknown, already stopped or already ended).
 */
export function abortSyncAgentRun(id: string): boolean {
  const run = runs.get(id);
  if (!run) {
    log.warn("abort: unknown or finished run", { id });
    return false;
  }
  if (run.status !== "running") {
    log.warn("abort: run already stopped", { id, agent: run.agent });
    return false;
  }
  run.status = "failed";
  run.endedAt = Date.now();
  // A registry stop is a human action; the detail header reads this from disk.
  run.killOrigin = "user";
  writeStatus(run);
  if (!run.abort) {
    // The spawn does not exist yet: record the stop, `setAbort` reports it to the spawner.
    run.pendingStop = true;
    log.info("abort: queued before spawn", { id, agent: run.agent });
    notify();
    return true;
  }
  log.debug("abort", { id, agent: run.agent });
  const abort = run.abort;
  // The row stays until `end()` sees the child exit: deleting here would hide a live process
  // that nobody can stop again.
  try {
    abort();
  } catch (e: any) {
    log.warn("abort: signal failed", { id: run.id, error: e?.message || String(e) });
  }
  notify();
  return true;
}

/** Live runs, oldest first — an entry stays here after a stop until its child exits. */
export function listSyncAgentRuns(): SyncAgentRun[] {
  return Array.from(runs.values()).map(strip);
}

/** Live runs plus the finished ones still in the grace window, so a finished row can show
 *  its final status instead of a stale "running". */
export function listSyncAgentRunsWithFinished(): SyncAgentRun[] {
  pruneFinished();
  return [...Array.from(runs.values()), ...Array.from(finished.values())].map(strip);
}

/** Running runs only — a stopped child awaiting its exit is no longer running. */
export function syncAgentRunCount(): number {
  let count = 0;
  for (const run of runs.values()) if (run.status === "running") count++;
  return count;
}

/** Subscribe to any run begin/end/tool/abort change. Returns an unsubscribe. */
export function onSyncAgentRunsChanged(cb: () => void): () => void {
  listeners.add(cb);
  log.debug("listener_added", { listeners: listeners.size });
  return () => {
    listeners.delete(cb);
    log.debug("listener_removed", { listeners: listeners.size });
  };
}

/** Drop every run, live and finished. Internal teardown — use `abortAllSyncAgentRuns` from a
 *  session path, so a live child is never silently forgotten. */
function clearSyncAgentRuns(): void {
  if (runs.size === 0 && finished.size === 0) return;
  log.debug("clear", { count: runs.size, finished: finished.size });
  for (const run of [...runs.values(), ...finished.values()]) removeWorkerDir(run.workerDir);
  runs.clear();
  finished.clear();
  notify();
}

/**
 * Stop every still-running sync run, then clear. Called on session shutdown: these children
 * belong to this process, so none may outlive the session. Exported rather than reached for
 * directly so the clearing path cannot drop a live handle without killing it first.
 * Returns the number of runs stopped.
 */
export function abortAllSyncAgentRuns(): number {
  let stopped = 0;
  for (const run of [...runs.values()]) {
    if (run.status !== "running") continue;
    if (abortSyncAgentRun(run.id)) stopped++;
  }
  clearSyncAgentRuns();
  log.info("abort_all", { stopped });
  return stopped;
}

/**
 * Footer label. Pure: the caller applies the colour.
 * Async-only keeps the old `⏳ async: N` look; mixing adds the breakdown.
 */
export function formatAgentsStatus(asyncRunning: number, syncRunning: number): string {
  const total = asyncRunning + syncRunning;
  if (total === 0) return "💤 agents: 0";
  if (syncRunning === 0) return `⏳ async: ${asyncRunning}`;
  const parts: string[] = [];
  if (asyncRunning > 0) parts.push(`${asyncRunning} async`);
  parts.push(`${syncRunning} sync`);
  return `⏳ agents: ${total} (${parts.join(", ")})`;
}
