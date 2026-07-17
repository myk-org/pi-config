/**
 * Spawn CLI agent processes and capture output.
 */

import { spawn } from "node:child_process";
import type { CliAgentName } from "./providers.js";
import { buildCliCommand } from "./providers.js";
import { parseCliOutput, type CliParseResult } from "./parsers.js";

export interface CliRunOptions {
  agent: CliAgentName;
  model: string;
  cwd: string;
  prompt: string;
  sessionId?: string | null;
  continueSession?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
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
    child.stdout?.on("data", (d) => {
      stdout += d;
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
