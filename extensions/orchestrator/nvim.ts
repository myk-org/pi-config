/**
 * Neovim integration — communicate with the parent nvim instance via RPC.
 * Only registers when running inside nvim (NVIM env var is set).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runGit } from "./git-helpers.js";

const NVIM_SOCKET = process.env.NVIM;

/**
 * Check if we're running inside a neovim terminal.
 */
export function isInsideNvim(): boolean {
  return !!NVIM_SOCKET;
}

/**
 * Execute a lua file in the parent nvim instance via --remote-expr.
 * Returns the JSON-parsed result, or null on failure.
 */
function nvimExecLua(luaCode: string): any | null {
  if (!NVIM_SOCKET) return null;

  const tmpFile = path.join(os.tmpdir(), `pi-nvim-${process.pid}-${Date.now()}.lua`);
  try {
    fs.writeFileSync(tmpFile, luaCode, "utf-8");
    const result = execFileSync(
      "nvim",
      ["--server", NVIM_SOCKET, "--remote-expr", `luaeval("dofile('${tmpFile.replace(/'/g, "\\'")}')")` ],
      { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    ).toString().trim();

    if (!result) return null;
    return JSON.parse(result);
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Send a quickfix list to nvim and open the quickfix window.
 * Each entry: { filename, lnum?, col?, text }
 */
function nvimSetQuickfix(entries: Array<{ filename: string; lnum?: number; col?: number; text?: string }>, title?: string): boolean {
  if (!NVIM_SOCKET || entries.length === 0) return false;

  const dataFile = path.join(os.tmpdir(), `pi-nvim-qf-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(dataFile, JSON.stringify(entries), "utf-8");

    const titleLine = title ? `vim.fn.setqflist({}, "a", {title = "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"})` : "";
    const safeDataFile = dataFile.replace(/"/g, '\\"');
    const lua = `
local f = io.open("${safeDataFile}", "r")
if not f then return vim.fn.json_encode({status = "error", message = "no data file"}) end
local raw = f:read("*a")
f:close()
os.remove("${safeDataFile}")
local entries = vim.fn.json_decode(raw)
local items = {}
for _, e in ipairs(entries) do
  table.insert(items, {
    filename = e.filename,
    lnum = e.lnum or 1,
    col = e.col or 1,
    text = e.text or "",
  })
end
vim.fn.setqflist(items)
${titleLine}
vim.cmd("copen")
return vim.fn.json_encode({status = "ok", count = #items})
`;

    const result = nvimExecLua(lua);
    // Clean up data file if lua didn't remove it (nvim unreachable)
    if (result?.status !== "ok") {
      try { fs.unlinkSync(dataFile); } catch {}
    }
    return result?.status === "ok";
  } catch {
    try { fs.unlinkSync(dataFile); } catch {}
    return false;
  }
}

/**
 * Get git changed files relative to origin/main (or HEAD if on main).
 */
function getChangedFiles(cwd: string): Array<{ filename: string; status: string }> {
  const branchResult = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branchResult.code !== 0) return [];
  const branch = branchResult.stdout?.trim() || "";

  const seen = new Set<string>();
  const files: Array<{ filename: string; status: string }> = [];

  const parseDiffOutput = (output: string) => {
    for (const line of output.trim().split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const statusCode = parts[0].charAt(0);
        const filename = parts[parts.length - 1];
        if (seen.has(filename)) continue;
        seen.add(filename);
        const statusMap: Record<string, string> = {
          M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied",
        };
        files.push({ filename, status: statusMap[statusCode] || statusCode });
      }
    }
  };

  if (branch === "main" || branch === "master") {
    const result = runGit(["diff", "--name-status", "HEAD"], cwd);
    if (result.code === 0 && result.stdout?.trim()) parseDiffOutput(result.stdout);
  } else {
    // Committed changes vs default branch
    const hasMain = runGit(["rev-parse", "--verify", "origin/main"], cwd).code === 0;
    const base = hasMain ? "origin/main" : "origin/master";
    const committed = runGit(["diff", "--name-status", `${base}...HEAD`], cwd);
    if (committed.code === 0 && committed.stdout?.trim()) parseDiffOutput(committed.stdout);
    // Uncommitted changes (working tree + staged)
    const uncommitted = runGit(["diff", "--name-status", "HEAD"], cwd);
    if (uncommitted.code === 0 && uncommitted.stdout?.trim()) parseDiffOutput(uncommitted.stdout);
  }

  return files;
}

export function registerNvim(pi: ExtensionAPI): void {
  if (!isInsideNvim()) return;
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  pi.registerCommand("nvim-changed-files", {
    description: "Open git changed files in nvim's quickfix list",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const files = getChangedFiles(ctx.cwd);
      if (files.length === 0) {
        ctx.ui.notify("No changed files found.", "info");
        return;
      }

      const entries = files.map(f => ({
        filename: path.resolve(ctx.cwd, f.filename),
        lnum: 1,
        text: f.status,
      }));

      const ok = nvimSetQuickfix(entries, "pi: changed files");
      if (ok) {
        ctx.ui.notify(`Sent ${entries.length} changed file(s) to nvim quickfix.`, "info");
      } else {
        ctx.ui.notify("Failed to send quickfix to nvim.", "warning");
      }
    },
  });

}
