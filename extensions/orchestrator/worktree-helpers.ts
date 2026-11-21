/**
 * Pure helpers for worktree visibility: COMS peer matching, safe cleanup guards,
 * formatting (/worktree list, /status, detail pane), prune parsing, and clipboard copy.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hyperlink } from "@earendil-works/pi-tui";
import { isFreshHeartbeat } from "../coms/coms-peers.js";
import { sanitizePeerText } from "../coms/peer-text.js";
import { createLogger } from "../shared/logger.js";
import {
  countLinkedWorktrees,
  matchPathToWorktrees,
  type OpenPr,
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
  peersUnverifiedReason?: string;
  pr?: OpenPr;
  headSubject?: string;
  statusLines?: string[];
}

export type GhPrListRunner = (cwd: string) => Promise<string>;

export interface FetchOpenPrsOptions {
  runner?: GhPrListRunner;
  ttlMs?: number;
  forceRefresh?: boolean;
}

const SAFE_PR_URL = /^https:\/\/[^\x00-\x1f\x7f\s]+$/;
const OPEN_PRS_TTL_MS = 15_000;
const OPEN_PRS_CACHE_MAX = 32;

const defaultGhPrListRunner: GhPrListRunner = (cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,url,headRefName"],
      { cwd, timeout: 5000, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(typeof stdout === "string" ? stdout : String(stdout));
      },
    );
  });

type OpenPrsStore = {
  cache: Map<string, { at: number; prs: Map<string, OpenPr> }>;
  inFlight: Map<string, Promise<Map<string, OpenPr>>>;
  gen: Map<string, number>;
};

const openPrsStoreByRunner = new WeakMap<GhPrListRunner, OpenPrsStore>();

function getOpenPrsStore(runner: GhPrListRunner): OpenPrsStore {
  let store = openPrsStoreByRunner.get(runner);
  if (!store) {
    store = { cache: new Map(), inFlight: new Map(), gen: new Map() };
    openPrsStoreByRunner.set(runner, store);
  }
  return store;
}

/** Clear cached open PRs (tests / manual invalidation). */
export function invalidateOpenPrsCache(cwd?: string, runner: GhPrListRunner = defaultGhPrListRunner): void {
  const store = openPrsStoreByRunner.get(runner);
  if (!store) return;
  if (cwd) {
    const key = path.resolve(cwd);
    store.gen.set(key, (store.gen.get(key) ?? 0) + 1);
    store.cache.delete(key);
    store.inFlight.delete(key);
  } else {
    for (const k of store.cache.keys()) store.gen.set(k, (store.gen.get(k) ?? 0) + 1);
    for (const k of store.inFlight.keys()) store.gen.set(k, (store.gen.get(k) ?? 0) + 1);
    store.cache.clear();
    store.inFlight.clear();
  }
}

/** Parse `gh pr list --json number,url,headRefName` output into a branch -> OpenPr map. */
export function parseOpenPrsByBranch(raw: string): Map<string, OpenPr> {
  const result = new Map<string, OpenPr>();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return result;
  for (const item of parsed) {
    if (
      item &&
      typeof item.headRefName === "string" &&
      item.headRefName.length > 0 &&
      Number.isInteger(item.number) &&
      item.number > 0 &&
      typeof item.url === "string" &&
      SAFE_PR_URL.test(item.url) &&
      !result.has(item.headRefName)
    ) {
      result.set(item.headRefName, { number: item.number, url: item.url });
    }
  }
  return result;
}

/**
 * Fetch open GitHub PRs keyed by head branch name in one batched `gh pr list` call.
 * Short-TTL cached per runner+cwd with generation ordering; fails open to an empty Map on any error.
 */
export async function fetchOpenPrsByBranchAsync(
  cwd: string,
  opts: FetchOpenPrsOptions = {},
): Promise<Map<string, OpenPr>> {
  const runner = opts.runner ?? defaultGhPrListRunner;
  const ttlMs = opts.ttlMs ?? OPEN_PRS_TTL_MS;
  const effectiveCwd = cwd || process.cwd();
  const key = path.resolve(effectiveCwd);
  const { cache, inFlight, gen } = getOpenPrsStore(runner);

  if (!opts.forceRefresh) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < ttlMs) {
      return new Map(cached.prs);
    }
    const pending = inFlight.get(key);
    if (pending) {
      return new Map(await pending);
    }
  }

  const myGen = (gen.get(key) ?? 0) + 1;
  gen.set(key, myGen);

  let promise!: Promise<Map<string, OpenPr>>;
  promise = (async (): Promise<Map<string, OpenPr>> => {
    try {
      const raw = await runner(effectiveCwd);
      const prs = parseOpenPrsByBranch(raw);
      if (gen.get(key) === myGen) {
        cache.delete(key);
        cache.set(key, { at: Date.now(), prs });
        while (cache.size > OPEN_PRS_CACHE_MAX) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      return prs;
    } catch (e: any) {
      log.debug("open_prs_fetch_failed", { cwd: effectiveCwd, error: e?.message || String(e) });
      return new Map();
    }
  })().finally(() => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  });

  inFlight.set(key, promise);
  return new Map(await promise);
}

export type RemoveGuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface ReadLivePeersOptions {
  comsDir?: string;
  now?: number;
  isPidAlive?: (pid: number) => boolean;
  endpointExists?: (endpoint: string) => boolean;
  /** When true (destructive removal guard), verify registry readability and keep stale-heartbeat entries whose PID/endpoint still look alive. */
  strict?: boolean;
}

export interface PeerInspectionResult {
  peers: WorktreePeerInfo[];
  verified: boolean;
  error?: string;
}

/** Check whether a PID exists; treats EPERM (alive, owned by another user) as alive. */
export function defaultIsPidAlive(
  pid: number,
  killFn: (p: number, sig: number) => boolean | void = process.kill,
): boolean {
  try {
    killFn(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/**
 * Inspect the local COMS registry (`~/.pi/coms/projects/<project>/agents/<name>.json`).
 * Distinguishes a genuinely absent registry (ENOENT -> verified: true) from unreadable/corrupt
 * registry state (verified: false) so destructive removal guards fail closed.
 */
export function inspectLiveComsPeers(
  cwd: string,
  opts: ReadLivePeersOptions = {},
): PeerInspectionResult {
  const baseDir = opts.comsDir || getSetting(cwd, "coms_dir") || path.join(os.homedir(), ".pi", "coms");
  const projectsRoot = path.join(baseDir, "projects");
  const now = opts.now ?? Date.now();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const endpointExists = opts.endpointExists ?? existsSync;
  const strict = opts.strict === true;

  let projects: string[];
  try {
    projects = readdirSync(projectsRoot);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return { peers: [], verified: true };
    }
    const reason = `unreadable COMS registry (${e?.code || e?.message || "error"})`;
    log.debug("coms_registry_unreadable", { projectsRoot, error: e?.message || String(e), code: e?.code });
    return { peers: [], verified: false, error: reason };
  }

  let verified = true;
  let error: string | undefined;
  const markUnverified = (reason: string) => {
    verified = false;
    if (!error) error = reason;
  };

  const peers: WorktreePeerInfo[] = [];
  for (const project of projects) {
    const agentsDir = path.join(projectsRoot, project, "agents");
    let files: string[];
    try {
      files = readdirSync(agentsDir);
    } catch (e: any) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") continue;
      log.debug("coms_agents_dir_unreadable", { agentsDir, error: e?.message || String(e), code: e?.code });
      markUnverified(`unreadable COMS agents directory (${e?.code || "error"})`);
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(agentsDir, file);
      let entry: any;
      try {
        entry = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch (e: any) {
        if (e?.code === "ENOENT") continue;
        log.debug("coms_peer_entry_unreadable", { file: filePath, error: e?.message || String(e) });
        markUnverified(`unreadable COMS peer entry ${file}`);
        continue;
      }
      if (!entry || typeof entry !== "object" || typeof entry.name !== "string") {
        log.debug("coms_peer_entry_malformed", { file: filePath });
        markUnverified(`malformed COMS peer entry ${file}`);
        continue;
      }

      const heartbeatAt = typeof entry.heartbeat_at === "string" ? entry.heartbeat_at : null;
      const startedAt = typeof entry.started_at === "string" ? entry.started_at : null;
      const fresh =
        isFreshHeartbeat(heartbeatAt, now) ||
        (!heartbeatAt && isFreshHeartbeat(startedAt, now));
      const endpoint = typeof entry.endpoint === "string" ? entry.endpoint : "";
      const pid = Number.isInteger(entry.pid) ? (entry.pid as number) : null;

      if (!fresh) {
        if (!strict) continue;
        // In strict removal-guard mode, a stale heartbeat may mean heartbeat writes failed
        // while the peer is still running — confirm PID and endpoint before treating it as dead.
        if (pid !== null) {
          if (!isPidAlive(pid)) continue;
          if (process.platform !== "win32" && endpoint && !endpointExists(endpoint)) continue;
        } else if (process.platform !== "win32" && endpoint) {
          if (!endpointExists(endpoint)) continue;
        } else {
          markUnverified(`unverifiable stale COMS peer entry ${file}`);
          continue;
        }
      } else {
        if (process.platform !== "win32" && endpoint && !endpointExists(endpoint)) continue;
        if (pid !== null && !isPidAlive(pid)) continue;
      }

      peers.push({
        name: sanitizePeerText(entry.name, 40),
        project: sanitizePeerText(project, 60),
        cwd: typeof entry.cwd === "string" ? entry.cwd : "",
        busy: entry.busy === true,
        pid,
        purpose: sanitizePeerText(typeof entry.purpose === "string" ? entry.purpose : "", 120),
      });
    }
  }
  return { peers, verified, ...(error ? { error } : {}) };
}

/**
 * Scan the local COMS registry (`~/.pi/coms/projects/<project>/agents/<name>.json`) and return
 * live peers (best-effort display discovery).
 */
export function readLiveComsPeers(
  cwd: string,
  opts: ReadLivePeersOptions = {},
): WorktreePeerInfo[] {
  return inspectLiveComsPeers(cwd, opts).peers;
}

/** Match live COMS peers (and optional open PRs by branch) to worktrees. */
export function attachPeersToWorktrees(
  worktrees: readonly WorktreeEntry[],
  peers: readonly WorktreePeerInfo[],
  prsByBranch?: ReadonlyMap<string, OpenPr>,
  peersUnverifiedReason?: string,
): WorktreeView[] {
  const views: WorktreeView[] = worktrees.map((wt) => {
    const pr = wt.branch ? prsByBranch?.get(wt.branch) : undefined;
    return {
      ...wt,
      id: wt.path,
      peers: [],
      ...(peersUnverifiedReason ? { peersUnverifiedReason } : {}),
      ...(pr ? { pr } : {}),
    };
  });
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
 * unverifiable COMS peer state, locked, dirty, or unknown dirty state worktrees.
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
  if (wt.peersUnverifiedReason) {
    return {
      allowed: false,
      reason: `Cannot verify active COMS peers (${wt.peersUnverifiedReason}) — refusing to remove worktree.`,
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

/** Format compact table for `/worktree list` (OSC 8 hyperlinks in TUI, markdown links in headless). */
export function formatWorktreeTable(
  worktrees: readonly WorktreeView[],
  cwd: string,
  opts: { hyperlinks?: boolean } = {},
): string {
  if (worktrees.length === 0) return "Not in a git repository (no worktrees found).";
  const useHyperlinks = opts.hyperlinks ?? true;
  const linked = countLinkedWorktrees(worktrees);
  const header = `⊞ Worktrees (${worktrees.length} total, ${linked} linked):`;
  const hasAnyPr = worktrees.some((wt) => Boolean(wt.pr));

  const rows = worktrees.map((wt) => {
    const tags = formatWorktreeTags(wt).join(" ");
    const branch = formatWorktreeLabel(wt);
    const prPlain = wt.pr ? `#${wt.pr.number}` : hasAnyPr ? "-" : "";
    const prDisplay = wt.pr
      ? useHyperlinks
        ? hyperlink(prPlain, wt.pr.url)
        : `[${prPlain}](${wt.pr.url})`
      : prPlain;
    const prWidth = useHyperlinks ? prPlain.length : prDisplay.length;
    const state = formatDirtyText(wt);
    const peer =
      wt.peers.length === 0
        ? ""
        : wt.peers.length === 1
          ? `@${wt.peers[0].name}`
          : `@${wt.peers[0].name} +${wt.peers.length - 1}`;
    const relPath = displayWorktreePath(wt.path, cwd);
    return { branch, tags, prDisplay, prWidth, state, peer, relPath };
  });

  const wBranch = Math.max(...rows.map((r) => r.branch.length));
  const wTags = Math.max(0, ...rows.map((r) => r.tags.length));
  const wPr = Math.max(0, ...rows.map((r) => r.prWidth));
  const wState = Math.max(...rows.map((r) => r.state.length));
  const wPeer = Math.max(0, ...rows.map((r) => r.peer.length));

  const lines = rows.map((r) => {
    const cols = [
      r.branch.padEnd(wBranch),
      ...(wTags > 0 ? [r.tags.padEnd(wTags)] : []),
      ...(wPr > 0 ? [r.prDisplay + " ".repeat(wPr - r.prWidth)] : []),
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

export interface CopyClipboardOptions {
  platform?: NodeJS.Platform;
  waylandDisplay?: string;
  runCommand?: (cmd: string, args: string[], text: string) => Promise<boolean>;
  isTTY?: boolean;
  writeStdout?: (data: string) => void;
}

export function runClipboardCommand(
  cmd: string,
  args: string[],
  text: string,
  timeoutMs = 2000,
): Promise<boolean> {
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
      }, timeoutMs);
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
  opts: CopyClipboardOptions = {},
): Promise<{ ok: boolean; method?: string; error?: string }> {
  const platform = opts.platform ?? process.platform;
  const waylandDisplay = opts.waylandDisplay ?? process.env.WAYLAND_DISPLAY;
  const runCmd = opts.runCommand ?? runClipboardCommand;
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
  const writeStdout = opts.writeStdout ?? ((data: string) => { process.stdout.write(data); });

  const candidates: Array<{ cmd: string; args: string[]; label: string }> =
    platform === "darwin"
      ? [{ cmd: "pbcopy", args: [], label: "pbcopy" }]
      : platform === "win32"
        ? [{ cmd: "clip", args: [], label: "clip" }]
        : [
            ...(waylandDisplay ? [{ cmd: "wl-copy", args: [], label: "wl-copy" }] : []),
            { cmd: "xclip", args: ["-selection", "clipboard"], label: "xclip" },
            { cmd: "xsel", args: ["--clipboard", "--input"], label: "xsel" },
          ];

  for (const c of candidates) {
    if (await runCmd(c.cmd, c.args, text)) {
      log.debug("clipboard_copied", { method: c.label });
      return { ok: true, method: c.label };
    }
  }

  if (isTTY) {
    try {
      const encoded = Buffer.from(text, "utf-8").toString("base64");
      writeStdout(`\x1b]52;c;${encoded}\x07`);
      log.debug("clipboard_copied", { method: "osc52" });
      return { ok: true, method: "osc52" };
    } catch (e: any) {
      log.debug("clipboard_osc52_failed", { error: e?.message || String(e) });
    }
  }

  return { ok: false, error: "No clipboard utility found (pbcopy/wl-copy/xclip/xsel)." };
}
