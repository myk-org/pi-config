/**
 * Spawn CLI agent processes — buffered or live stream-json.
 */

import { spawn } from "node:child_process";
import type { CliAgentName } from "./providers.js";
import { buildCliCommand } from "./providers.js";
import {
  parseCliOutput,
  StreamJsonAccumulator,
  type CliParseResult,
  type CliStreamEvent,
} from "./parsers.js";

export interface CliRunOptions {
  agent: CliAgentName;
  model: string;
  cwd: string;
  prompt: string;
  sessionId?: string | null;
  continueSession?: boolean;
  signal?: AbortSignal;
  /** Optional only — no default. Omit for unlimited turn duration. */
  timeoutMs?: number;
  /** When set, stream NDJSON events as they arrive (stream-json agents). */
  onEvent?: (event: CliStreamEvent) => void;
}

export interface CliRunResult extends CliParseResult {
  exitCode: number | null;
  stderr: string;
}

/**
 * Resolve turn timeout for CLI agents.
 *
 * Intentional product policy (issue #647): **no default wall-clock timeout**.
 * Long turns (e.g. autoqodo) must not be SIGKILL'd after N minutes.
 * Cancellation: pass `AbortSignal`, or an explicit positive `timeoutMs`.
 */
export function resolveCliTimeoutMs(
  timeoutMs: number | undefined,
): number | undefined {
  return typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : undefined;
}

/** Env keys that cause nested-session / ACP re-entry in some CLIs. */
const STRIP_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
];

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  return env;
}

export function runCliAgent(opts: CliRunOptions): Promise<CliRunResult> {
  const { binary, args, promptOnStdin } = buildCliCommand({
    agent: opts.agent,
    model: opts.model,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    continueSession: opts.continueSession,
  });

  const argv = promptOnStdin ? args : [...args, opts.prompt];
  const timeoutMs = resolveCliTimeoutMs(opts.timeoutMs);
  const stream = typeof opts.onEvent === "function";

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("CLI call aborted"));
      return;
    }

    const child = spawn(binary, argv, {
      cwd: opts.cwd,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const acc = new StreamJsonAccumulator();
    const lineBuf = { value: "" };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }, 2000).unref?.();
        } catch {
          /* ignore */
        }
        if (!settled) {
          settled = true;
          reject(new Error(`CLI ${binary} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.();
    }
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (d: string) => {
      if (stream) {
        for (const ev of acc.feedChunk(d, lineBuf)) {
          opts.onEvent!(ev);
        }
      } else {
        stdout += d;
      }
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });

    // Attach before any write/end — child may exit immediately (EPIPE).
    child.stdin?.on("error", () => {
      /* ignore broken pipe */
    });

    if (promptOnStdin) {
      try {
        child.stdin?.write(opts.prompt);
        child.stdin?.end();
      } catch {
        /* EPIPE if child exits before stdin write */
      }
    } else {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;

      if (stream) {
        for (const ev of acc.flush(lineBuf)) {
          opts.onEvent!(ev);
        }
        if (code !== 0 && !acc.text.trim()) {
          reject(
            new Error(
              `CLI ${binary} exited ${code}: ${stderr.trim().slice(0, 500) || "no output"}`,
            ),
          );
          return;
        }
        resolve({
          text: acc.text,
          sessionId: acc.sessionId,
          thinking: acc.thinking || undefined,
          usage: acc.usage,
          exitCode: code,
          stderr,
        });
        return;
      }

      if (code !== 0 && !stdout.trim()) {
        reject(
          new Error(
            `CLI ${binary} exited ${code}: ${stderr.trim().slice(0, 500) || "no output"}`,
          ),
        );
        return;
      }
      try {
        const parsed = parseCliOutput(opts.agent, stdout);
        resolve({
          ...parsed,
          exitCode: code,
          stderr,
        });
      } catch (e: any) {
        reject(
          new Error(
            `Failed to parse ${opts.agent} CLI output: ${e?.message || e}\n` +
              `stdout head: ${stdout.slice(0, 200)}`,
          ),
        );
      }
    });
  });
}
