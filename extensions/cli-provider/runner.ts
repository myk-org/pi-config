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
  timeoutMs?: number;
  /** When set, stream NDJSON events as they arrive (stream-json agents). */
  onEvent?: (event: CliStreamEvent) => void;
}

export interface CliRunResult extends CliParseResult {
  exitCode: number | null;
  stderr: string;
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
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
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

    const timer = setTimeout(() => {
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

    if (promptOnStdin) {
      child.stdin?.write(opts.prompt);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
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
