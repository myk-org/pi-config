/**
 * Cursor CLI agent — flags, discovery, headless trust/force.
 *
 * Model ids from `agent --list-models` (CLI namespace, not acpx).
 */

import { spawnSync } from "node:child_process";
import { createLogger } from "../../shared/logger.js";
const log = createLogger("cli_provider");
import type { CliProviderDef, DiscoveredCliModel } from "../types.js";
import { resolveBinary } from "../shared/discover-cache.js";

/** Strip CSI / OSC ANSI sequences so colored CLI output still parses (#666). */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}

/** Parse `agent --list-models` text output. */
export function parseAgentListModels(stdout: string): DiscoveredCliModel[] {
  const models: DiscoveredCliModel[] = [];
  const seen = new Set<string>();
  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    const m = line.match(
      /^([a-zA-Z0-9][a-zA-Z0-9._\[\]=,:-]*)\s+-\s+(.+?)\s*$/,
    );
    if (!m) continue;
    const id = m[1];
    const name = m[2].replace(/\s*\(default\)\s*$/i, "").trim();
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name });
  }
  return models;
}

function discoverCursorModels(): DiscoveredCliModel[] {
  const binary = resolveBinary("agent");
  if (!binary) return [];

  const r = spawnSync(binary, ["--list-models"], {
    encoding: "utf-8",
    timeout: 25_000,
    // Prefer plain text; still strip ANSI in parser if CLI ignores NO_COLOR.
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const models = parseAgentListModels(out);
  if (models.length === 0) {
    log.warn(`cursor: --list-models failed (status=${r.status}): ${out.slice(0, 200)}`);
  }
  return models;
}

/**
 * Headless Cursor MCP: `--approve-mcps` is opt-in, not unconditional.
 * `CLI_APPROVE_MCPS` wins; otherwise sidecar processes (`SIDECAR_PORT`, stamped
 * by `startSidecar()` while running) get it because they have no TTY.
 * Interactive pi omits the flag.
 */
export function shouldApproveCursorMcps(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicit = env.CLI_APPROVE_MCPS;
  if (typeof explicit === "string" && explicit.length > 0) {
    const on = ["1", "true", "yes", "on"].includes(explicit.toLowerCase());
    log.debug(`cursor --approve-mcps CLI_APPROVE_MCPS=${explicit} -> ${on}`);
    return on;
  }
  const sidecar = typeof env.SIDECAR_PORT === "string" && env.SIDECAR_PORT.length > 0;
  log.debug(`cursor --approve-mcps SIDECAR_PORT set=${sidecar}`);
  return sidecar;
}

export const cursorProvider: CliProviderDef = {
  name: "cursor",
  binary: "agent",
  buildBaseArgs: (model, cwd) => {
    // --trust: workspace; --force: auto-approve tools
    const approveMcps = shouldApproveCursorMcps();
    log.debug(
      `cursor buildBaseArgs approveMcps=${approveMcps} modelOverride=${Boolean(model && model !== "default")}`,
    );
    const args = [
      "--print",
      "--trust",
      "--force",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--workspace",
      cwd,
    ];
    if (approveMcps) {
      args.push("--approve-mcps");
    }
    if (model && model !== "default") {
      args.unshift("--model", model);
    }
    return args;
  },
  resumeFlag: "--resume",
  continueFlags: ["--continue"],
  outputFormat: "stream-json",
  promptOnStdin: true,
  discoverModels: discoverCursorModels,
};
