/**
 * Cursor CLI agent — flags, discovery, headless trust/force.
 *
 * Model ids from `agent --list-models` (CLI namespace, not acpx).
 */

import { spawnSync } from "node:child_process";
import type { CliProviderDef, DiscoveredCliModel } from "../types.js";
import { resolveBinary } from "../shared/discover-cache.js";

/** Parse `agent --list-models` text output. */
export function parseAgentListModels(stdout: string): DiscoveredCliModel[] {
  const models: DiscoveredCliModel[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
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
    env: { ...process.env },
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  const models = parseAgentListModels(out);
  if (models.length === 0) {
    console.debug(
      `[cli-provider] cursor: --list-models failed (status=${r.status}): ${out.slice(0, 200)}`,
    );
  }
  return models;
}

export const cursorProvider: CliProviderDef = {
  name: "cursor",
  binary: "agent",
  buildBaseArgs: (model, cwd) => {
    // --trust: workspace; --force: auto-approve; stream-partial-output: live tokens
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
