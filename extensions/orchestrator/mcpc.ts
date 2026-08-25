/**
 * mcpc — connect MCP servers from ~/.pi/pi-config/mcp.json.
 *
 * Auto-connect on pi process start (session_start reason "startup").
 * /mcpc connect reconnects after the user edits that file.
 * Connect failure is logged; it never fails the pi session.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPiOneshotInvocation } from "../shared/oneshot.js";
import { createLogger } from "../shared/logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger("orchestrator", "mcpc");

const CONNECT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export type McpcExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

let execMcpcConnect: McpcExecFile = execFileAsync as McpcExecFile;

/** Replace the mcpc subprocess (tests). Pass undefined to restore. */
export function setMcpcExecFile(fn: McpcExecFile | undefined): void {
  execMcpcConnect = fn ?? (execFileAsync as McpcExecFile);
  log.debug("setMcpcExecFile", fn ? "override" : "restore");
}

export function mcpcConfigPath(): string {
  const home = process.env.HOME || os.homedir();
  const configPath = path.join(home, ".pi", "pi-config", "mcp.json");
  log.debug("mcpcConfigPath", configPath);
  return configPath;
}

export type McpcConnectResult = {
  ok: boolean;
  skipped: boolean;
  message: string;
};

export type McpcCompletionItem = {
  value: string;
  label: string;
  description: string;
};

const MCPC_CONNECT_COMPLETION: McpcCompletionItem = {
  value: "connect",
  label: "connect",
  description: "Connect ~/.pi/pi-config/mcp.json (--stdio)",
};

export function mcpcArgumentCompletions(prefix: string): McpcCompletionItem[] | null {
  log.debug("mcpc argument completions", prefix);
  const needle = prefix.trim().toLowerCase();
  const haystack = `${MCPC_CONNECT_COMPLETION.label} ${MCPC_CONNECT_COMPLETION.description}`.toLowerCase();
  if (!needle || haystack.includes(needle) || MCPC_CONNECT_COMPLETION.value.startsWith(needle)) {
    return [MCPC_CONNECT_COMPLETION];
  }
  return null;
}

function formatExecError(err: unknown): string {
  if (!err || typeof err !== "object") {
    log.debug("formatExecError non-object", String(err));
    return String(err);
  }
  const e = err as {
    code?: string;
    killed?: boolean;
    message?: string;
    stdout?: string;
    stderr?: string;
  };
  log.debug("formatExecError", { code: e.code ?? "none", killed: Boolean(e.killed) });
  const parts: string[] = [];
  if (e.code === "ENOENT") {
    parts.push("mcpc not on PATH. Install: npm install -g @apify/mcpc");
  } else if (e.killed) {
    parts.push(`mcpc connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s`);
  } else if (e.message) {
    parts.push(e.message);
  }
  const out = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
  if (out) parts.push(out);
  return parts.join("\n") || "mcpc connect failed";
}

/** Run `mcpc connect <mcp.json> --stdio`. Never throws. */
export async function connectMcpc(): Promise<McpcConnectResult> {
  const configPath = mcpcConfigPath();
  log.debug("connectMcpc entry", configPath);

  if (!fs.existsSync(configPath)) {
    log.debug("skip: mcp.json missing", configPath);
    return {
      ok: true,
      skipped: true,
      message: `No MCP config at ${configPath} — skip connect (create that file to use mcpc).`,
    };
  }

  log.info("mcpc connect start", configPath);
  try {
    const { stdout, stderr } = await execMcpcConnect(
      "mcpc",
      ["connect", configPath, "--stdio"],
      {
        timeout: CONNECT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: process.env,
      },
    );
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    log.info("mcpc connect finished", configPath);
    log.debug("mcpc connect output", out);
    return {
      ok: true,
      skipped: false,
      message: out || `mcpc connect finished (${configPath} --stdio)`,
    };
  } catch (err) {
    const message = formatExecError(err);
    log.warn("mcpc connect failed; continuing", message);
    return { ok: false, skipped: false, message };
  }
}

export function registerMcpc(pi: ExtensionAPI): void {
  log.info("registerMcpc");
  pi.registerCommand("mcpc", {
    description:
      "Reconnect MCP servers from ~/.pi/pi-config/mcp.json (mcpc connect --stdio). Run after editing that file.",
    handler: async (args, ctx) => {
      const sub = (args || "").trim();
      if (sub && sub !== "connect") {
        log.debug("/mcpc ignored unknown args", sub);
        if (ctx.hasUI) ctx.ui.notify("Usage: /mcpc connect", "warning");
        return;
      }
      log.info("/mcpc connect");
      const result = await connectMcpc();
      if (!ctx.hasUI) return;
      if (result.skipped) ctx.ui.notify(result.message, "info");
      else if (result.ok) ctx.ui.notify(result.message, "info");
      else ctx.ui.notify(result.message, "warning");
    },
  });

  pi.on("session_start", async (event, _ctx) => {
    const reason = (event as { reason?: string })?.reason ?? "unknown";
    if (reason !== "startup") {
      log.debug("skip auto-connect: session_start reason", reason);
      return;
    }
    if (isPiOneshotInvocation()) {
      log.debug("skip auto-connect: oneshot");
      return;
    }
    await connectMcpc();
  });
}
