/**
 * Pure helpers for worktree visibility: COMS peer matching, safe cleanup guards,
 * formatting (/worktree list, /status, detail pane), prune parsing, and clipboard copy.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isFreshHeartbeat } from "../coms/coms-peers.js";
import { sanitizePeerText } from "../coms/peer-text.js";
import { createLogger } from "../shared/logger.js";
import {
  countLinkedWorktrees,
  matchPathToWorktrees,
  type WorktreeDirtySummary,
  type WorktreeEntry,
} from "./git-helpers.js";
import { getSetting } from "./project-settings.js";

const log = createLogger("worktree-helpers");

export interface WorktreePeerInfo {
  name: string;
  project: string;
  cwd: string;
  busy: boolean;
  pid: number | null;
  purpose: string;
}

export interface WorktreeView extends WorktreeEntry {
  id: string;
  peers: WorktreePeerInfo[];
  headSubject?: string;
  statusLines?: string[];
}

export type RemoveGuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface ReadLivePeersOptions {
  comsDir?: string;
  now?: number;
  isPidAlive?: (pid: number) => boolean;
  endpointExists?: (endpoint: string) => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan the local COMS registry (`~/.pi/coms/projects/<project>/agents/<name>.json`) and return
 * live peers (fresh heartbeat, existing socket on POSIX, live pid).
 */
export function readLiveComsPeers(
  cwd: string,
  opts: ReadLivePeersOptions = {},
): WorktreePeerInfo[] {
  const baseDir = opts.comsDir || getSetting(cwd, "coms_dir") || path.join(os.homedir(), ".pi", "coms");
  const projectsRoot = path.join(baseDir, "projects");
  const now = opts.now ?? Date.now();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const endpointExists = opts.endpointExists ?? existsSync;

  let projects: string[];
  try {
    projects = readdirSync(projectsRoot);
  } catch {
    return [];
  }

  const peers: WorktreePeerInfo[] = [];
  for (const project of projects) {
    const agentsDir = path.join(projectsRoot, project, "agents");
    let files: string[];
    try {
      files = readdirSync(agentsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(agentsDir, file);
      try {
        const entry = JSON.parse(readFileSync(filePath, "utf-8"));
        if (!entry || typeof entry.name !== "string") continue;
        const heartbeatAt = typeof entry.heartbeat_at === "string" ? entry.heartbeat_at : null;
        const startedAt = typeof entry.started_at === "string" ? entry.started_at : null;
        const fresh =
          isFreshHeartbeat(heartbeatAt, now) ||
          (!heartbeatAt && isFreshHeartbeat(startedAt, now));
        if (!fresh) continue;

        const endpoint = typeof entry.endpoint === "string" ? entry.endpoint : "";
        if (process.platform !== "win32" && endpoint && !endpointExists(endpoint)) continue;

        const pid = Number.isInteger(entry.pid) ? (entry.pid as number) : null;
        if (pid !== null && !isPidAlive(pid)) continue;

        peers.push({
          name: sanitizePeerText(entry.name, 40),
          project: sanitizePeerText(project, 60),
          cwd: typeof entry.cwd === "string" ? entry.cwd : "",
          busy: entry.busy === true,
          pid,
          purpose: sanitizePeerText(typeof entry.purpose === "string" ? entry.purpose : "", 120),
        });
      } catch (e: any) {
        log.debug("coms_peer_entry_unreadable", { file: filePath, error: e?.message || String(e) });
      }
    }
  }
  return peers;
}

/** Match live COMS peers to worktrees using longest-prefix path resolution. */
export function attachPeersToWorktrees(
  worktrees: readonly WorktreeEntry[],
  peers: readonly WorktreePeerInfo[],
): WorktreeView[] {
  const views: WorktreeView[] = worktrees.map((wt) => ({
    ...wt,
    id: wt.path,
    peers: [],
  }));
  for (const peer of peers) {
    if (!peer.cwd) continue;
    const matched = matchPathToWorktrees(peer.cwd, views);
    if (matched) matched.peers.push(peer);
  }
  for (const view of views) {
    view.peers.sort((a, b) => a.name.localeCompare(b.name));
  }
  return views;
}

/**
 * Guard `git worktree remove`: fails closed on main, current, live COMS peer,
 * locked, dirty, or unverifiable (unknown dirty state on a live checkout) worktrees.
 */
export function canRemoveWorktree(wt: WorktreeView): RemoveGuardResult {
  if (wt.isMain) {
    return { allowed: false, reason: "Cannot remove the main worktree." };
  }
  if (wt.isCurrent) {
    return { allowed: false, reason: "Cannot remove the current session's worktree." };
  }
  if (wt.peers.length > 0) {
    const names = wt.peers.map((p) => p.name).join(", ");
    return {
      allowed: false,
      reason: `Cannot remove worktree with active COMS peer${wt.peers.length > 1 ? "s" : ""}: ${names}.`,
    };
  }
  if (wt.locked) {
    const detail = wt.lockedReason ? ` (${wt.lockedReason})` : "";
    return {
      allowed: false,
      reason: `Worktree is locked${detail} — unlock it first.`,
    };
  }
  if (!wt.prunable && !wt.bare) {
    if (wt.dirty === undefined) {
      return {
        allowed: false,
        reason: "Cannot verify clean working tree — refusing to remove worktree.",
      };
    }
    if (wt.dirty.total > 0) {
      return {
        allowed: false,
        reason: `Worktree has ${wt.dirty.total} uncommitted change${wt.dirty.total === 1 ? "" : "s"} — commit or discard them first.`,
      };
    }
  }
  return { allowed: true };
}

/** Primary display label: branch name, detached short SHA, or (bare). */
export function formatWorktreeLabel(wt: Pick<WorktreeEntry, "branch" | "detached" | "bare" | "head">): string {
  if (wt.bare) return "(bare)";
  if (wt.branch) return wt.branch;
  const shortSha = wt.head ? wt.head.slice(0, 7) : "HEAD";
  return wt.detached ? `(detached ${shortSha})` : `(${shortSha})`;
}

/** Status tags for a worktree row. */
export function formatWorktreeTags(
  wt: Pick<WorktreeEntry, "isCurrent" | "isMain" | "locked" | "prunable">,
): string[] {
  const tags: string[] = [];
  if (wt.isCurrent) tags.push("[current]");
  if (wt.isMain) tags.push("[main]");
  if (wt.locked) tags.push("[locked]");
  if (wt.prunable) tags.push("[prunable]");
  return tags;
}

/** Compact dirty summary text (e.g. "clean", "~2 +1 ?3", "prunable", "unknown"). */
export function formatDirtyText(
  wt: Pick<WorktreeEntry, "dirty" | "prunable" | "bare">,
): string {
  if (wt.prunable) return "prunable";
  if (wt.bare) return "bare";
  if (!wt.dirty) return "unknown";
  if (wt.dirty.total === 0) return "clean";
  const parts: string[] = [];
  if (wt.dirty.modified > 0) parts.push(`~${wt.dirty.modified}`);
  if (wt.dirty.added > 0) parts.push(`+${wt.dirty.added}`);
  if (wt.dirty.deleted > 0) parts.push(`-${wt.dirty.deleted}`);
  if (wt.dirty.untracked > 0) parts.push(`?${wt.dirty.untracked}`);
  return parts.length > 0 ? parts.join(" ") : `${wt.dirty.total} dirty`;
}

/** Relative path from `cwd` when shorter/cleaner, else full path. */
export function displayWorktreePath(wtPath: string, cwd: string): string {
  if (!cwd) return wtPath;
  const rel = path.relative(cwd, wtPath);
  if (!rel) return ".";
  if (!rel.startsWith("..") || rel.split(path.sep).length <= 3) return rel;
  return wtPath;
}

/** Format compact plain-text table for `/worktree list` and headless output. */
export function formatWorktreeTable(
  worktrees: readonly WorktreeView[],
  cwd: string,
): string {
  if (worktrees.length === 0) return "Not in a git repository (no worktrees found).";
  const linked = countLinkedWorktrees(worktrees);
  const header = `⊞ Worktrees (${worktrees.length} total, ${linked} linked):`;

  const rows = worktrees.map((wt) => {
    const tags = formatWorktreeTags(wt).join(" ");
    const branch = formatWorktreeLabel(wt);
    const state = formatDirtyText(wt);
    const peer =
      wt.peers.length === 0
        ? ""
        : wt.peers.length === 1
          ? `@${wt.peers[0].name}`
          : `@${wt.peers[0].name} +${wt.peers.length - 1}`;
    const relPath = displayWorktreePath(wt.path, cwd);
    return { branch, tags, state, peer, relPath };
  });

  const wBranch = Math.max(...rows.map((r) => r.branch.length));
  const wTags = Math.max(0, ...rows.map((r) => r.tags.length));
  const wState = Math.max(...rows.map((r) => r.state.length));
  const wPeer = Math.max(0, ...rows.map((r) => r.peer.length));

  const lines = rows.map((r) => {
    const cols = [
      r.branch.padEnd(wBranch),
      ...(wTags > 0 ? [r.tags.padEnd(wTags)] : []),
      r.state.padEnd(wState),
      ...(wPeer > 0 ? [r.peer.padEnd(wPeer)] : []),
      r.relPath,
    ];
    return `  ${cols.join("  ").trimEnd()}`;
  });

  return [header, ...lines].join("\n");
}

/** 1-line `Worktrees:` summary for `/status`; returns null when no linked worktrees exist. */
export function formatWorktreeStatusSummary(
  worktrees: readonly WorktreeEntry[],
): string | null {
  const linked = countLinkedWorktrees(worktrees);
  if (linked === 0) return null;
  const current = worktrees.find((wt) => wt.isCurrent);
  const where = current
    ? current.isMain
      ? "main checkout"
      : `current: ${formatWorktreeLabel(current)} [wt]`
    : `${worktrees.length} total`;
  return `⊞ Worktrees: ${linked} linked (${where})`;
}

/** Parse `git worktree prune -v` output (stdout + stderr). */
export function formatPruneResult(
  stdout: string,
  stderr: string,
  code: number,
): { ok: boolean; pruned: string[]; message: string } {
  if (code !== 0) {
    const detail = (stderr || stdout || "git worktree prune failed").trim();
    return { ok: false, pruned: [], message: `Worktree prune failed: ${detail}` };
  }
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const pruned = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (pruned.length === 0) {
    return { ok: true, pruned: [], message: "No stale worktrees to prune." };
  }
  return {
    ok: true,
    pruned,
    message: `Pruned ${pruned.length} stale worktree${pruned.length === 1 ? "" : "s"}:\n${pruned.map((l) => `  • ${l}`).join("\n")}`,
  };
}

function runClipboardCommand(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        done(false);
      }, 2000);
      if (timer.unref) timer.unref();
      child.on("error", () => { clearTimeout(timer); done(false); });
      child.on("close", (code) => { clearTimeout(timer); done(code === 0); });
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/** Copy text to the system clipboard (pbcopy / clip / wl-copy / xclip / xsel / OSC 52 fallback). */
export async function copyTextToClipboard(
  text: string,
): Promise<{ ok: boolean; method?: string; error?: string }> {
  const candidates: Array<{ cmd: string; args: string[]; label: string }> =
    process.platform === "darwin"
      ? [{ cmd: "pbcopy", args: [], label: "pbcopy" }]
      : process.platform === "win32"
        ? [{ cmd: "clip", args: [], label: "clip" }]
        : [
            ...(process.env.WAYLAND_DISPLAY ? [{ cmd: "wl-copy", args: [], label: "wl-copy" }] : []),
            { cmd: "xclip", args: ["-selection", "clipboard"], label: "xclip" },
            { cmd: "xsel", args: ["--clipboard", "--input"], label: "xsel" },
          ];

  for (const c of candidates) {
    if (await runClipboardCommand(c.cmd, c.args, text)) {
      log.debug("clipboard_copied", { method: c.label });
      return { ok: true, method: c.label };
    }
  }

  if (process.stdout.isTTY) {
    try {
      const encoded = Buffer.from(text, "utf-8").toString("base64");
      process.stdout.write(`\x1b]52;c;${encoded}\x07`);
      log.debug("clipboard_copied", { method: "osc52" });
      return { ok: true, method: "osc52" };
    } catch (e: any) {
      log.debug("clipboard_osc52_failed", { error: e?.message || String(e) });
    }
  }

  return { ok: false, error: "No clipboard utility found (pbcopy/wl-copy/xclip/xsel)." };
}
