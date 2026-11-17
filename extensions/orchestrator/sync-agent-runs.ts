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

import { createLogger } from "../shared/logger.js";

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
  taskId?: string;
}

interface SyncAgentRunEntry extends SyncAgentRun {
  /** Terminates the child process: SIGTERM, then SIGKILL. Set once the spawn exists. */
  abort?: () => void;
}

/** Running runs only — an entry is deleted when it ends, so the map stays bounded. */
const runs = new Map<string, SyncAgentRunEntry>();
const listeners = new Set<() => void>();
let counter = 0;

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
  taskId?: string;
}): {
  id: string;
  setTool: (tool?: string) => void;
  setAbort: (fn: () => void) => void;
  end: (ok: boolean) => void;
} {
  const id = `sync-${++counter}`;
  const entry: SyncAgentRunEntry = {
    id,
    agent: args.agent,
    task: args.task,
    cwd: args.cwd,
    startedAt: Date.now(),
    status: "running",
    ...(args.taskId ? { taskId: args.taskId } : {}),
  };
  runs.set(id, entry);
  log.debug("begin", { id, agent: entry.agent, cwd: entry.cwd });
  notify();

  return {
    id,
    setTool: (tool?: string) => {
      const run = runs.get(id);
      if (!run || run.status !== "running") return;
      if (run.currentTool === tool) return;
      run.currentTool = tool;
      log.debug("tool", { id, tool: tool ?? null });
      notify();
    },
    setAbort: (fn: () => void) => {
      const run = runs.get(id);
      if (!run || run.status !== "running") {
        log.warn("set_abort: run already finished", { id });
        return;
      }
      run.abort = fn;
      log.debug("abort_registered", { id });
    },
    end: (ok: boolean) => {
      const run = runs.get(id);
      if (run) {
        run.status = ok ? "complete" : "failed";
        run.endedAt = Date.now();
        runs.delete(id);
        log.debug("end", { id, agent: run.agent, status: run.status });
      }
      // Idempotent, but subscribers still hear about it: they re-read the registry, so a
      // repeat notify is harmless while a missed one would strand the footer.
      notify();
    },
  };
}

/**
 * Abort a running sync agent by run id or agent name.
 * Returns false when nothing matches (unknown or already finished).
 */
export function abortSyncAgentRun(target: string): boolean {
  const want = target.toLowerCase();
  let match: SyncAgentRunEntry | undefined;
  for (const run of runs.values()) {
    if (run.id.toLowerCase() === want || run.agent.toLowerCase() === want) {
      match = run;
      break;
    }
  }
  if (!match) {
    log.warn("abort: unknown or finished run", { target });
    return false;
  }
  if (!match.abort) {
    log.warn("abort: no abort handle yet", { id: match.id, agent: match.agent });
    return false;
  }
  log.debug("abort", { id: match.id, agent: match.agent });
  match.status = "failed";
  match.endedAt = Date.now();
  const abort = match.abort;
  // Delete before invoking: the abort fn also resolves the spawn, whose `end` would
  // otherwise log a second, confusing end for the same run.
  runs.delete(match.id);
  try {
    abort();
  } catch (e: any) {
    log.warn("abort: signal failed", { id: match.id, error: e?.message || String(e) });
  }
  notify();
  return true;
}

/** Running runs only, oldest first. */
export function listSyncAgentRuns(): SyncAgentRun[] {
  return Array.from(runs.values()).map(({ abort: _abort, ...run }) => run);
}

export function syncAgentRunCount(): number {
  return runs.size;
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

/** Drop every run — teardown only; a still-spawning child is left to its own exit path. */
export function clearSyncAgentRuns(): void {
  if (runs.size === 0) return;
  log.debug("clear", { count: runs.size });
  runs.clear();
  notify();
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
