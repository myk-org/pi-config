/**
 * Async subagent runner — spawned as a detached process.
 * Reads config from a JSON file, runs pi in print mode,
 * writes status + result files for the parent to poll.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

interface RunConfig {
  id: string;
  agent: string;
  task: string;
  cwd: string;
  model?: string;
  contextWindow?: number;
  tools?: string[];
  systemPrompt?: string;
  resultPath: string;
  workerDir: string;
  sessionId?: string;
  piCommand: string;
  piArgs: string[];
}

interface StatusPayload {
  runId: string;
  state: "queued" | "running" | "complete" | "failed";
  agent: string;
  task: string;
  startedAt: number;
  endedAt?: number;
  lastUpdate: number;
  pid: number;
  childPid?: number;
  cwd: string;
  exitCode?: number | null;
  error?: string;
  outputLines: number;
}

function writeJson(filePath: string, data: object): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function run(config: RunConfig): Promise<void> {
  const statusPath = path.join(config.workerDir, "status.json");
  const outputPath = path.join(config.workerDir, "output.log");
  const startedAt = Date.now();

  const status: StatusPayload = {
    runId: config.id,
    state: "running",
    agent: config.agent,
    task: config.task.slice(0, 200),
    startedAt,
    lastUpdate: startedAt,
    pid: process.pid,
    cwd: config.cwd,
    outputLines: 0,
  };
  writeJson(statusPath, status);
  let lastUsage: any = null;

  const outputStream = fs.createWriteStream(outputPath, { flags: "w" });

  // Connect to pidash server to stream events
  const pidashPort = parseInt(process.env.PI_PIDASH_PORT || "", 10) || 19190;
  let pidashWs: any = null;
  const pidashLog = path.join(config.workerDir, "pidash-ws.log");
  fs.writeFileSync(pidashLog, `START port=${pidashPort} id=${config.id}\n`);
  try {
    const _require = createRequire(import.meta.url);
    fs.appendFileSync(pidashLog, `require ok, importing ws\n`);
    const WebSocket = _require("ws");
    fs.appendFileSync(pidashLog, `ws loaded, connecting...\n`);
    pidashWs = new WebSocket(`ws://127.0.0.1:${pidashPort}/ws/async`);
    pidashWs.on("open", () => {
      fs.appendFileSync(pidashLog, `connected!\n`);
      pidashWs.send(JSON.stringify({
        type: "async_register",
        id: config.id,
        agent: config.agent,
        task: config.task.slice(0, 200),
        cwd: config.cwd,
        sessionId: config.sessionId,
      }));
    });
    pidashWs.on("error", (e: any) => { fs.appendFileSync(pidashLog, `error: ${e.message}\n`); });
  } catch (e: any) {
    fs.appendFileSync(pidashLog, `CATCH: ${e.message}\n${e.stack}\n`);
  }

  let lineCount = 0;
  let finalOutput = "";
  // Keep a small tail for fallback when no message_end is found
  const MAX_TAIL = 4000;
  let stdoutTail = "";
  // Buffer for incomplete lines across chunk boundaries
  let lineBuf = "";

  const exitCode = await new Promise<number | null>((resolve) => {
    const proc = spawn(config.piCommand, config.piArgs, {
      cwd: config.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Store child PID in status file so /async-kill can find it
    if (proc.pid) {
      status.childPid = proc.pid;
      writeJson(statusPath, status);
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      outputStream.write(text);

      // Keep only the last MAX_TAIL chars for fallback
      stdoutTail += text;
      if (stdoutTail.length > MAX_TAIL * 2) {
        stdoutTail = stdoutTail.slice(-MAX_TAIL);
      }

      // Buffer partial lines across chunk boundaries
      lineBuf += text;
      const lines = lineBuf.split("\n");
      // Last element is incomplete (no trailing newline) — keep in buffer
      lineBuf = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lineCount++;

        try {
          const ev = JSON.parse(trimmed);

          // Extract final output and usage from message_end events inline
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            for (const p of ev.message.content || []) {
              if (p.type === "text") finalOutput = p.text;
            }
            if (ev.message.usage) lastUsage = ev.message.usage;
          }

          // Forward events to pidash
          if (pidashWs?.readyState === 1) {
            pidashWs.send(JSON.stringify({ type: "async_event", id: config.id, event: ev }));
          }
        } catch (e: any) { console.debug("[async-runner] event processing failed:", e?.message || e); }
      }

      // Update status periodically (every ~10 lines)
      if (lineCount % 10 === 0) {
        status.lastUpdate = Date.now();
        status.outputLines = lineCount;
        writeJson(statusPath, status);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      outputStream.write(chunk.toString());
    });

    proc.on("close", (code) => {
      resolve(code);
    });

    proc.on("error", (err) => {
      status.error = err.message;
      resolve(1);
    });
  });

  const endedAt = Date.now();

  // Process any remaining buffered line
  if (lineBuf.trim()) {
    try {
      const ev = JSON.parse(lineBuf.trim());
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        for (const p of ev.message.content || []) {
          if (p.type === "text") finalOutput = p.text;
        }
      }
    } catch (e: any) { console.debug("[async-runner] final line parse failed:", e?.message || e); }
  }

  // Write final status
  status.state = exitCode === 0 ? "complete" : "failed";
  status.endedAt = endedAt;
  status.lastUpdate = endedAt;
  status.exitCode = exitCode;
  status.outputLines = lineCount;
  writeJson(statusPath, status);

  // Notify pidash of completion and close
  if (pidashWs?.readyState === 1) {
    pidashWs.send(JSON.stringify({ type: "async_complete", id: config.id, success: exitCode === 0 }));
    pidashWs.close();
  }

  // For code reviewers: validate output is JSON, retry if not
  if (config.agent.startsWith("code-reviewer-") && exitCode === 0) {
    let validJson = false;
    let retryOutput = finalOutput || stdoutTail.slice(-2000);
    let jsonRetryCount = 0;
    while (!validJson) {
      jsonRetryCount++;
      try {
        let cleaned = retryOutput.trim();
        if (cleaned.startsWith("```")) {
          cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
        }
        const parsed = JSON.parse(cleaned);
        if (parsed && Array.isArray(parsed.findings)) {
          validJson = true;
          finalOutput = cleaned; // Use the cleaned JSON as final output
        }
      } catch { /* not valid JSON */ }

      if (!validJson) {
        // After 3 retries, stop and let the user decide
        if (jsonRetryCount >= 3) {
          finalOutput = JSON.stringify({
            findings: [{
              severity: "CRITICAL",
              file: "<reviewer-output>",
              line: 0,
              description: `Reviewer ${config.agent} failed to return valid JSON after ${jsonRetryCount} attempts. Raw output included in this result. User action required.`,
              suggestion: "Re-run the reviewer or check the agent prompt.",
            }],
            _jsonRetryExhausted: true,
            _rawOutput: retryOutput.slice(0, 1000),
          });
          break;
        }
        // Re-run with same session, asking for JSON
        const retryArgs = config.piArgs.slice(0, -1); // Remove the last arg (the task)
        retryArgs.push("Your output is not valid JSON. Return ONLY a raw JSON object: {\"findings\": [...]}. No markdown fences, no text before or after.");
        const retryCode = await new Promise<number | null>((resolve) => {
          const retryProc = spawn(config.piCommand, retryArgs, {
            cwd: config.cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let retryBuf = "";
          retryProc.stdout.on("data", (chunk: Buffer) => {
            retryBuf += chunk.toString();
            outputStream.write(chunk.toString());
          });
          retryProc.stderr.on("data", (chunk: Buffer) => {
            outputStream.write(chunk.toString());
          });
          retryProc.on("close", (code) => {
            // Extract final output from the retry
            for (const line of retryBuf.split("\n")) {
              try {
                const ev = JSON.parse(line.trim());
                if (ev.type === "message_end" && ev.message?.role === "assistant") {
                  for (const p of ev.message.content || []) {
                    if (p.type === "text") retryOutput = p.text;
                  }
                }
              } catch { /* skip */ }
            }
            resolve(code);
          });
          retryProc.on("error", () => resolve(1));
        });
        if (retryCode !== 0) break; // pi itself failed, stop retrying
      }
    }
  }

  // End the output stream after all retries are done
  outputStream.end();

  // Write result for the watcher to pick up
  writeJson(config.resultPath, {
    id: config.id,
    agent: config.agent,
    task: config.task,
    success: exitCode === 0,
    output: finalOutput || stdoutTail.slice(-2000),
    exitCode,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    cwd: config.cwd,
    sessionId: config.sessionId,
    workerDir: config.workerDir,
    lastUsage: lastUsage || null,
    contextWindow: config.contextWindow || 0,
  });
}

// Entry point
const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: async-runner.ts <config.json>");
  process.exit(1);
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as RunConfig;
  try { fs.unlinkSync(configPath); } catch {}
  run(config).catch((err) => {
    console.error("Async runner error:", err);
    process.exit(1);
  });
} catch (err) {
  console.error("Failed to read config:", err);
  process.exit(1);
}
