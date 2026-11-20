/**
 * Git diff and worktree helpers for pidiff-server.
 *
 * Uses `git cat-file --batch` to read all object blobs for a diff pass in a
 * single subprocess instead of spawning `git show` up to twice per file.
 */

import { execFileSync } from "node:child_process";
import { createLogger } from "../extensions/shared/logger.ts";

const log = createLogger("pidiff");

export interface FileContentsData {
  name: string;
  oldContents: string;
  newContents: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface ParsedDiffEntry {
  name: string;
  oldName: string;
  status: FileContentsData["status"];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

/** Parse `git diff --name-status` stdout into structured entries. */
export function parseDiffEntries(raw: string): ParsedDiffEntry[] {
  const entries: ParsedDiffEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2 || !parts[0]) continue;
    const statusChar = parts[0][0];
    const name = parts.length > 2 ? parts[2] : parts[1];
    const oldName = parts.length > 2 ? parts[1] : name;
    let status: FileContentsData["status"] = "modified";
    if (statusChar === "A") status = "added";
    else if (statusChar === "D") status = "deleted";
    else if (statusChar === "R") status = "renamed";
    entries.push({ name, oldName, status });
  }
  return entries;
}

/**
 * Parse raw Buffer stdout from `git cat-file --batch`.
 *
 * Git emits byte lengths (not UTF-16 code units), so parsing MUST slice the
 * Buffer by byte offsets before decoding UTF-8.
 */
export function parseCatFileBatch(specs: readonly string[], output: Buffer): Map<string, string> {
  const results = new Map<string, string>();
  let offset = 0;

  for (const spec of specs) {
    if (offset >= output.length) break;
    const nl = output.indexOf(0x0a, offset);
    if (nl === -1) break;
    const header = output.toString("utf-8", offset, nl);
    offset = nl + 1;

    // Found object header is "<oid> <type> <size>"; missing/ambiguous lines have no body.
    const parts = header.split(" ");
    if (parts.length !== 3 || !/^\d+$/.test(parts[2])) {
      continue;
    }

    const type = parts[1];
    const size = parseInt(parts[2], 10);
    if (offset + size > output.length) {
      log.warn("cat-file batch truncated", { spec, size, remaining: output.length - offset });
      break;
    }

    if (type === "blob") {
      results.set(spec, output.toString("utf-8", offset, offset + size));
    }
    // Skip payload bytes plus the trailing LF emitted by `git cat-file --batch`.
    offset += size + 1;
  }

  return results;
}

const CAT_FILE_BATCH_MAX_BUFFER = 64 * 1024 * 1024;
const CAT_FILE_BATCH_TIMEOUT_MS = 15000;
const FALLBACK_SHOW_MAX_BUFFER = 5 * 1024 * 1024;
const FALLBACK_SHOW_TIMEOUT_MS = 5000;

/**
 * Read multiple `<ref>:<path>` git objects in one `git cat-file --batch` call.
 * Falls back to individual `git show` calls if a spec contains line breaks or
 * if the batch call fails (e.g. ENOBUFS on very large repos).
 */
export function batchReadGitObjects(
  gitBin: string,
  cwd: string,
  specs: readonly string[],
  onEnoent?: () => string,
): Map<string, string> {
  if (specs.length === 0) return new Map();

  const batchable: string[] = [];
  const fallbackSpecs: string[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    if (spec.includes("\n") || spec.includes("\r")) fallbackSpecs.push(spec);
    else batchable.push(spec);
  }

  const results = new Map<string, string>();
  let bin = gitBin;

  const runShowFallback = (targetSpecs: readonly string[]) => {
    for (const spec of targetSpecs) {
      try {
        const content = execFileSync(bin, ["show", spec], {
          cwd,
          encoding: "utf-8",
          timeout: FALLBACK_SHOW_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: FALLBACK_SHOW_MAX_BUFFER,
        });
        results.set(spec, content);
      } catch {
        // Missing or unreadable object maps to empty string at caller.
      }
    }
  };

  if (batchable.length > 0) {
    const input = `${batchable.join("\n")}\n`;
    const runBatch = () =>
      execFileSync(bin, ["cat-file", "--batch"], {
        cwd,
        input,
        timeout: CAT_FILE_BATCH_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: CAT_FILE_BATCH_MAX_BUFFER,
      });

    try {
      const output = runBatch();
      for (const [k, v] of parseCatFileBatch(batchable, output)) {
        results.set(k, v);
      }
      if (log.isDebugEnabled()) {
        log.debug("batchReadGitObjects", { cwd, requested: batchable.length, resolved: results.size });
      }
    } catch (e: any) {
      if (e?.code === "ENOENT" && onEnoent) {
        bin = onEnoent();
        try {
          const output = runBatch();
          for (const [k, v] of parseCatFileBatch(batchable, output)) {
            results.set(k, v);
          }
        } catch (retryErr: any) {
          log.warn("batchReadGitObjects retry failed, falling back to git show", { err: retryErr?.message });
          runShowFallback(batchable);
        }
      } else {
        log.warn("batchReadGitObjects failed, falling back to git show", { count: batchable.length, err: e?.message });
        runShowFallback(batchable);
      }
    }
  }

  if (fallbackSpecs.length > 0) {
    runShowFallback(fallbackSpecs);
  }

  return results;
}

/** Parse `git worktree list --porcelain` stdout into WorktreeInfo records. */
export function parseWorktreeList(raw: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  const pushIfValid = () => {
    if (current.path) {
      worktrees.push({
        path: current.path,
        branch: current.branch || "(unknown)",
        head: current.head || "",
        isMain: current.isMain || false,
      });
    }
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      pushIfValid();
      current = { path: line.slice(9), isMain: worktrees.length === 0 };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      // "branch refs/heads/main" → "main"
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "detached") {
      current.branch = "(detached)";
    } else if (line === "") {
      pushIfValid();
      current = {};
    }
  }
  pushIfValid();
  return worktrees;
}
