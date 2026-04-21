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
  tools?: string[];
  systemPrompt?: string;
  resultPath: string;
  asyncDir: string;
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
  const statusPath = path.join(config.asyncDir, "status.json");
  const outputPath = path.join(config.asyncDir, "output.log");
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

  const outputStream = fs.createWriteStream(outputPath, { flags: "w" });

  // Connect to pidash server to stream events
  const pidashPort = parseInt(process.env.PI_PIDASH_PORT || "", 10) || 19190;
  let pidashWs: any = null;
  const pidashLog = path.join(config.asyncDir, "pidash-ws.log");
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

  let stdout = "";
  let lineCount = 0;

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
      stdout += text;
      outputStream.write(text);
      lineCount += text.split("\n").length - 1;

      // Forward events to pidash
      if (pidashWs?.readyState === 1) {
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            pidashWs.send(JSON.stringify({ type: "async_event", id: config.id, event: ev }));
          } catch {}
        }
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
      outputStream.end();
      resolve(code);
    });

    proc.on("error", (err) => {
      outputStream.end();
      status.error = err.message;
      resolve(1);
    });
  });

  const endedAt = Date.now();

  // Extract final output from JSON mode messages
  let finalOutput = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        for (const p of ev.message.content || []) {
          if (p.type === "text") finalOutput = p.text;
        }
      }
    } catch {}
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

  // Write result for the watcher to pick up
  writeJson(config.resultPath, {
    id: config.id,
    agent: config.agent,
    task: config.task,
    success: exitCode === 0,
    output: finalOutput || stdout.slice(-2000),
    exitCode,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    cwd: config.cwd,
    sessionId: config.sessionId,
    asyncDir: config.asyncDir,
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
