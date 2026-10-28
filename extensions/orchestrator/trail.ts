/** Local Trail-code integration: code-map tools, per-prompt retrieval, navigation gate. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger, type Logger } from "../shared/logger.js";
import { isPiOneshotInvocation } from "../shared/oneshot.js";
import { isLiveExtensionCtx } from "../shared/live-ctx.js";
import { findSettingsFile, getSetting, parseSettingsFile } from "./project-settings.js";
import { clearSlot, setSlot } from "./status-bar.js";
import { getProjectTmpDir, mainCheckoutRoot, resolveWorktreeRoot, tryResolveWorktreeRoot } from "./utils.js";
import { formatCompactTotal } from "../shared/format-total.js";

const exec = promisify(execFile);
const log = createLogger("trail");
const TIMEOUT_MS = 45_000;
const MAX_BUFFER = 64 * 1024;
const MIN_PROMPT_CHARS = 12;
const QUERY_MAX_CHARS = 2_000;
const QUERY_FALLBACK_CHARS = 200;
const INTERACTIVE_TIMEOUT_MS = 2_000;
export const TRAIL_QUERY_TOOLS = ["trail_find_code", "trail_find_all", "trail_file_api", "trail_trace_calls", "trail_repo_map"] as const;
/**
 * The five read-only Trail query tools, added to a child's tool list when it declares one.
 *
 * `undefined` deliberately stays `undefined`: it means "this agent declares no list",
 * which the spawner passes as "no --tools restriction". A child with no restriction
 * already gets every tool registered in its own session — including these five, because
 * registerTrail runs there too — so naming them would narrow the child instead of
 * widening it. A declared list gets them appended.
 */
export function withTrailTools(tools: readonly string[] | undefined, enabled: boolean): string[] | undefined {
  if (!tools?.length || !enabled) return tools ? [...tools] : undefined;
  return [...new Set([...tools, ...TRAIL_QUERY_TOOLS])];
}
/**
 * The `--tools` pair a spawner appends to its child command, or `[]` for none.
 * `--tools ""` would restrict a child to zero tools, so only a non-empty list
 * produces the flag; `undefined` (no declared list) stays unrestricted.
 */
export function trailToolsArgs(tools: readonly string[] | undefined, cwd: string): string[] {
  const list = withTrailTools(tools, trailEnabled(cwd));
  return list?.length ? ["--tools", list.join(",")] : [];
}
export type TrailState = "syncing" | "ready" | "stale" | "absent" | "failed";
export type TrailRun = (args: readonly string[], options: { cwd: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>;
type GraphStatus = "fresh" | "stale" | "absent";
type Options = { enabled: boolean; setting?: (cwd: string, logger?: Logger) => boolean; executable?: () => Promise<boolean>; graph?: (cwd: string) => Promise<GraphStatus> | GraphStatus; retrieve?: (query: string, cwd: string) => Promise<{ pointers: string[] }>; worktree?: (cwd: string) => string | null; run?: TrailRun; interactiveTimeoutMs?: number; logger?: Logger };
type StatusTheme = { fg: (color: string, value: string) => string };
type Hit = { title?: string; pointer?: string; snippet?: string; code?: string };
type Ask = { coverage?: number; coverageStrong?: number; hits?: Hit[] };
type TrailNode = { id: string; name: string; path: string };
type TrailEdge = { source: string; target: string; relation: string };
type TrailWiring = { nodes?: TrailNode[]; edges?: TrailEdge[] };

/**
 * Absolute path of the repo's code map, or null when no map exists yet.
 * Upstream keeps the map in `graft/` until a repo is "on trail" and then moves
 * it to `.trail/cache/` (renaming a legacy map itself), so both layouts must be
 * readable here. Filesystem only: this must never spawn the CLI.
 *
 * A wiring file decides, not the directory: an empty `.trail/cache` left behind by
 * an interrupted build must not hide a usable legacy map.
 */
export function trailMapDir(root: string, logger: Logger = log): string | null {
  const trail = join(root, ".trail", "cache");
  if (existsSync(join(trail, ".graph", "wiring.json"))) {
    logger.debug("map_dir_resolved", { root, layout: "trail", dir: trail });
    return trail;
  }
  const graft = join(root, "graft");
  if (existsSync(join(graft, ".graph", "wiring.json"))) {
    // Upstream owns this path name; we only read it until trail renames it.
    logger.debug("map_dir_resolved", { root, layout: "legacy", dir: graft });
    return graft;
  }
  // No map yet: `.trail/cache` or `.trail/learnings` marks a repo on trail before
  // its first build lands, so that is where a map will appear.
  if (existsSync(trail) || existsSync(join(root, ".trail", "learnings"))) {
    logger.debug("map_dir_resolved", { root, layout: "trail_pending", dir: trail });
    return trail;
  }
  logger.debug("map_dir_resolved", { root, layout: "none" });
  return null;
}
/** A usable map on disk, not just the `.trail/` marker an unfinished build leaves behind. */
function mapOnDisk(root: string, logger: Logger = log): boolean {
  const dir = trailMapDir(root, logger);
  return Boolean(dir && existsSync(join(dir, ".graph", "wiring.json")));
}
function wiring(root: string, logger: Logger = log): TrailWiring | null {
  const dir = trailMapDir(root, logger);
  if (!dir) return null;
  try { return JSON.parse(readFileSync(resolve(dir, ".graph/wiring.json"), "utf8")) as TrailWiring; } catch { return null; }
}
export function trailNodes(root: string, logger: Logger = log): number { const graph = wiring(root, logger); return Number.isSafeInteger((graph as any)?.meta?.nodeCount) ? (graph as any).meta.nodeCount : graph?.nodes?.length ?? 0; }
function indexedFiles(root: string, logger: Logger = log): Set<string> { return new Set((wiring(root, logger)?.nodes ?? []).map(node => node.path).filter((path): path is string => typeof path === "string")); }

/** Trail's statusline shape, adapted to Pi's theme API. */
export function formatTrailFooter({ state, nodeCount, tokenSavings, trailReads = 0, sourceReads = 0 }: { state: TrailState; nodeCount: number; tokenSavings: number; trailReads?: number; sourceReads?: number }, theme?: StatusTheme): string {
  const fg = (color: string, value: string) => theme?.fg(color, value) ?? value;
  // "absent" is deliberately dim, not error-red: the cwd is not a git worktree,
  // so no graph is possible. Reporting that as "failed" made an ordinary
  // directory look like a broken install.
  const freshness = state === "syncing" ? fg("warning", "syncing…") : state === "stale" ? fg("warning", "⚠ stale") : state === "failed" ? fg("error", "failed") : state === "absent" ? fg("dim", "n/a") : fg("success", "✓ synced");
  if (state === "absent") return fg("dim", "◤ trail · n/a");
  const parts = [fg("dim", "◤ ") + fg("accent", "trail"), fg("dim", `${nodeCount} nodes`), freshness];
  const reads = trailReads + sourceReads;
  if (reads > 0) parts.push(fg("dim", `${trailReads}/${reads} reads`));
  if (tokenSavings > 0) parts.push(fg("success", `~${formatCompactTotal(tokenSavings)} tok saved`));
  return parts.join(fg("dim", " · "));
}
function text(value: unknown, max = 500): string | null { return typeof value === "string" && value.trim() && value.length <= max && !/[\0\r\n]/.test(value) ? value.trim() : null; }
/**
 * A retrieval query is clamped, never rejected for length: `text()` is a strict
 * validator for pointers and titles, and a realistic task prompt is far longer
 * than its cap (issue #978: every real prompt was read as "no query").
 */
function queryText(value: unknown, max = QUERY_MAX_CHARS): string | null {
  if (typeof value !== "string") return null;
  const query = value.replace(/\0/g, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return query || null;
}
/**
 * Keyword-shaped retry query for a long prompt whose clamped prefix found nothing:
 * the first sentence, capped, so a task that buries its request below background
 * context still lands a searchable query (issue #978).
 */
function fallbackQuery(query: string): string | null {
  const sentence = query.split(/(?<=[.!?])\s+/)[0] ?? query;
  return queryText(sentence, QUERY_FALLBACK_CHARS);
}
function projectPath(root: string, value: unknown): string | null {
  const file = text(value); if (!file || isAbsolute(file)) return null;
  const absolute = resolve(root, file); if (relative(root, absolute).startsWith("..")) return null;
  try { const realRoot = realpathSync(root); const realFile = realpathSync(absolute); return realFile === realRoot || realFile.startsWith(realRoot + sep) ? file : null; } catch { return null; }
}
/** Repo-relative, forward-slashed path for a user-supplied input, or null when it escapes the repo. */
function repoRelative(root: string, value: unknown): string | null {
  const given = text(value, 4096); if (!given) return null;
  const rel = relative(root, isAbsolute(given) ? given : resolve(root, given));
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel.split(sep).join("/");
}
function samePath(left: string, right: string): boolean { return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`); }
function savedTokens(output: string): number { return [...output.matchAll(/\[(?:trail|graft)\] tokens saved ≈ ([\d,]+)/g)].reduce((total, match) => total + (Number(match[1].replaceAll(",", "")) || 0), 0); }
function savingsStore(ctx: any, root: string, logger: Logger = log): string {
  let id: unknown = process.env.PI_SUBAGENT_CHILD === "1" ? process.env.__PI_PARENT_SESSION_ID : undefined;
  const source = id ? "parent" : "session";
  try { id ||= ctx.sessionManager?.getSessionId?.(); } catch { logger.debug("savings_store_resolved", { source, available: false }); return ""; }
  if (typeof id !== "string" || !id) { logger.debug("savings_store_resolved", { source, available: false }); return ""; }
  const dir = getProjectTmpDir(root); chmodSync(dir, 0o700);
  logger.debug("savings_store_resolved", { source, available: true });
  return join(dir, `trail-savings-${createHash("sha256").update(id).digest("hex")}.json`);
}
function validSavings(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
function readSavings(file: string): number {
  if (!file) return 0;
  try { return validSavings(JSON.parse(readFileSync(file, "utf8"))?.tokenSavings); } catch { return 0; }
}
function writeSavings(file: string, delta: number, logger: Logger = log): number {
  if (!file || !delta) return readSavings(file);
  const lock = `${file}.lock`; const owner = { pid: process.pid, token: randomUUID() }; const ownerTmp = `${lock}.${owner.token}.tmp`; const valueTmp = `${file}.${owner.token}.tmp`;
  for (let attempt = 0; attempt < 100; attempt++) {
    let acquired = false;
    try {
      writeFileSync(ownerTmp, JSON.stringify(owner), { mode: 0o600, flag: "wx" }); linkSync(ownerTmp, lock); acquired = true; unlinkSync(ownerTmp);
      const total = readSavings(file) + delta;
      writeFileSync(valueTmp, JSON.stringify({ tokenSavings: total }), { mode: 0o600 }); renameSync(valueTmp, file);
      return total;
    } catch (error: any) {
      if (error?.code !== "EEXIST") { logger.warn("savings_persist_failed", { code: error?.code }); return readSavings(file); }
      const existing = lockOwner(lock);
      if (existing && !ownerAlive(existing)) {
        const claim = `${lock}.claim-${owner.token}`;
        try { renameSync(lock, claim); if (lockOwner(claim)?.token === existing.token && !ownerAlive(existing)) unlinkSync(claim); else try { renameSync(claim, lock); } catch {} } catch {}
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    } finally {
      try { unlinkSync(ownerTmp); } catch {}
      try { unlinkSync(valueTmp); } catch {}
      if (acquired) try { if (lockOwner(lock)?.token === owner.token) unlinkSync(lock); } catch {}
    }
  }
  logger.warn("savings_persist_failed", { code: "LOCK_BUSY" }); return readSavings(file);
}
function toolText(content: unknown): string { return Array.isArray(content) ? content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n") : ""; }
/**
 * The command that actually does the work: the first segment, skipping a leading
 * `cd` (a location change, not the command). Anything after a pipe only filters
 * the previous command's stdout, so `cat log | grep x` never navigates.
 */
function firstCommand(command: unknown): string | null {
  const segments = String(command ?? "").split("|")[0]!.split(/&&|;|&/).map(part => part.trim()).filter(Boolean);
  return segments.find(part => !/^cd(\s|$)/.test(part)) ?? null;
}
export function classifyToolUse(name: unknown, input?: any): "trail" | "source" | null {
  const tool = typeof name === "string" ? name.toLowerCase() : "";
  if (tool.startsWith("trail_")) return "trail";
  if (["read", "grep", "find", "ls"].includes(tool)) return "source";
  if (tool !== "bash" && tool !== "powershell") return null;
  // `trail ask …` typed in the shell is a Trail read, not source reading.
  const head = (firstCommand(input?.command) ?? "").trim().split(/\s+/)[0] ?? "";
  return head.split("/").pop()!.toLowerCase() === "trail" ? "trail" : null;
}
const MAP_RULE = "This project has a Trail code map. Start every code exploration with trail_find_code (describe the concept, not an identifier) before read/grep/find/glob or shell searches; it returns ranked file:line hits with source inlined.";
const TOOL_RULE = "Search concepts, not identifiers; call before read/grep for code navigation.";
const BUILD_NOTE = "[trail] This project has no code map yet. A bounded background `trail build` is starting now; trail_find_code (and the other trail_* tools) will return ranked file:line hits once it lands. This turn runs without the navigation gate — navigate the source directly.";
const ALL_TRAIL_TOOLS = [...TRAIL_QUERY_TOOLS, "trail_refresh", "trail_blast_radius"] as const;
/**
 * This turn's query, and where it came from. A subagent task starts its run as
 * a custom message (`event.prompt` is undefined), and that turn needs the same
 * retrieval and gate as a user prompt (issue #978, G2).
 */
function promptQuery(event: any): { query: string | null; querySource: "prompt" | "custom_message" | "none" } {
  const prompt = queryText(event?.prompt);
  if (prompt) return { query: prompt, querySource: "prompt" };
  if (event?.messageType !== "custom") return { query: null, querySource: "none" };
  const content = event?.message?.content;
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part: any) => typeof part?.text === "string").map((part: any) => part.text).join(" ") : "";
  return { query: queryText(raw), querySource: "custom_message" };
}
function substantive(query: string): boolean { return query.length >= MIN_PROMPT_CHARS && !query.startsWith("/"); }
/**
 * The repo-relative path a pointer names. The live CLI emits `path:L3-L6`
 * (`L3`, `3-6`, `12`, `12:5` also appear) and comma-joined lists, so the span
 * and any list tail are stripped: the gate compares plain paths. Anything not
 * path-shaped returns null, so a bogus pointer can never widen the gate.
 */
export function pointerPath(pointer: string): string | null {
  const first = pointer.split(",")[0]?.trim() ?? "";
  const path = first.replace(/:L?\d+(?:-L?\d+)?(?::\d+)?$/, "");
  if (!path || /\s/.test(path) || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) return null;
  return /[/.]/.test(path) ? path : null;
}
/** The CLI may print a note line ("refreshed the graph…", "tokens saved ≈ …") before the JSON. */
function parseAsk(stdout: string): Ask | null {
  const start = stdout.indexOf("{"); const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(stdout.slice(start, end + 1)) as Ask; } catch { return null; }
}
const SEARCH_BINARIES = new Set(["rg", "grep", "egrep", "fgrep", "find", "fd", "ag", "ack"]);
/** Prefixes that still name the command they wrap, so the search check must look past them. */
const SEARCH_WRAPPERS = new Set(["sudo", "env", "time", "command", "nice", "exec"]);
/**
 * The search binary a command runs first, if any — the binary is the first token
 * after env assignments and wrappers, and may be path-qualified (`/usr/bin/rg`,
 * which agents do use). `git grep` counts; an argument that merely says `rg`
 * (`echo rg`) does not, because it is not the command.
 */
function searchCommand(command: unknown): { binary: string; operands: string[] } | null {
  const first = firstCommand(command);
  if (!first) return null;
  const tokens = first.trim().split(/\s+/).map(token => token.replace(/^["']|["']$/g, ""));
  let index = 0;
  while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!) || SEARCH_WRAPPERS.has(tokens[index]!.toLowerCase()))) index++;
  const head = tokens[index];
  if (!head) return null;
  const binary = head.split("/").pop()!.toLowerCase();
  // Git takes global options between `git` and its subcommand (`-C src`,
  // `--no-pager`, `-c k=v`), so `grep` is not necessarily the next token.
  if (binary === "git") {
    for (let i = index + 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.startsWith("-")) { if (GIT_VALUE_OPTIONS.has(token)) i++; continue; }
      // A bare `grep` subcommand searches; `--grep=x` on another subcommand is a filter.
      return token.toLowerCase() === "grep" ? { binary: "git grep", operands: tokens.slice(i + 1) } : null;
    }
    return null;
  }
  return SEARCH_BINARIES.has(binary) ? { binary, operands: tokens.slice(index + 1) } : null;
}
function searchBinary(command: unknown): string | null { return searchCommand(command)?.binary ?? null; }
/** `git` options whose value is the following token. */
const GIT_VALUE_OPTIONS = new Set(["-c", "-C"]);
/**
 * A token that names a file rather than a directory or a bare word: its basename
 * carries an extension. `src`, `src/`, `.` and `..` all stay false.
 */
function fileLooking(token: string): boolean {
  const name = token.split("/").pop() ?? "";
  return name !== "." && name !== ".." && name.includes(".");
}
/**
 * A search that only touches files this map does not index cannot be answered by
 * Trail, so blocking it would force a pointless `trail_*` call. Every path operand
 * must be file-shaped and unindexed; one indexed file, directory or bare word
 * keeps the gate (`rg foo .`, `grep -rn foo src`).
 */
function unindexedSearch(command: unknown, mapPaths: Set<string>): boolean {
  const search = searchCommand(command);
  if (!search) return false;
  const operands = search.operands.filter(token => !token.startsWith("-"));
  // `find` names a path first; every other search binary takes the pattern first.
  const paths = search.binary === "find" ? operands : operands.slice(1);
  if (!paths.length) return false;
  return paths.every(path => fileLooking(path) && !mapPaths.has(path.replace(/^\.\//, "")));
}
function searchTool(event: any, logger: Logger = log): boolean {
  const tool = String(event?.toolName ?? event?.name ?? "").toLowerCase();
  if (["grep", "find", "glob", "search"].includes(tool)) return true;
  if (tool !== "bash" && tool !== "powershell") return false;
  const binary = searchBinary(event?.input?.command);
  // Diagnostics, not decoration: a search that slips past here is a gate miss, and
  // this line is the only way to tell a miss from a turn where nothing searched.
  logger.debug("gate_search_classified", { tool, binary });
  return binary !== null;
}
function trailGateReason(): string { return "[trail] Project navigation is blocked until Trail retrieval runs for this turn. Call trail_find_code (or trail_trace_calls/trail_file_api) and inspect the file:line pointers it returns. If Trail has no relevant result, retry the raw navigation."; }
function diagnostic(stderr: string): string { return text(stderr.split(/\r?\n/, 1)[0], 240) ?? "no diagnostic output"; }
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, logger: Logger = log): Promise<T> {
  let timer: NodeJS.Timeout | undefined; let timedOut = false;
  logger.debug("retrieval_timeout_setup", { timeoutMs });
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; logger.warn("retrieval_timeout", { timeoutMs }); reject(new Error("automatic retrieval timed out")); }, timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); logger.debug("retrieval_timeout_cleanup", { timeoutMs, timedOut }); }
}
type LockOwner = { pid: number; token: string };
function lockOwner(lock: string): LockOwner | null { try { const raw = readFileSync(lock, "utf8"); const legacyPid = Number(raw); if (Number.isSafeInteger(legacyPid)) return { pid: legacyPid, token: `legacy-${legacyPid}` }; const owner = JSON.parse(raw); return Number.isSafeInteger(owner?.pid) && typeof owner?.token === "string" ? owner : null; } catch { return null; } }
function ownerAlive(owner: LockOwner | null): boolean { if (!owner) return false; try { process.kill(owner.pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; } }
function buildLockPath(root: string, logger: Logger = log): string {
  // No map yet: the lock goes where the new map will land, so a first build does
  // not leave an empty `graft/` behind in a fresh checkout.
  return resolve(trailMapDir(root, logger) ?? join(root, ".trail", "cache"), ".graph/pi-build.lock");
}
export function acquireBuildLock(root: string, afterClaim?: () => void, logger: Logger = log): (() => void) | null {
  const lock = buildLockPath(root, logger); const claim = `${lock}.claim`; const owner = { pid: process.pid, token: randomUUID() };
  try { mkdirSync(dirname(lock), { recursive: true }); } catch { logger.warn("build_lock_unavailable", { root }); return null; }
  for (let attempt = 0; attempt < 2; attempt++) {
    const claimant = lockOwner(claim);
    if (claimant) { if (ownerAlive(claimant)) return null; try { unlinkSync(claim); } catch { return null; } }
    try {
      const fd = openSync(lock, "wx", 0o600); writeFileSync(fd, JSON.stringify(owner)); closeSync(fd);
      if (lockOwner(claim)) { try { if (lockOwner(lock)?.token === owner.token) unlinkSync(lock); } catch {} return null; }
      return () => { try { if (lockOwner(lock)?.token === owner.token) unlinkSync(lock); } catch {} };
    } catch (error: any) {
      if (error?.code !== "EEXIST") return null;
      try {
        renameSync(lock, claim);
        const claimedOwner = lockOwner(claim);
        if (ownerAlive(claimedOwner)) { try { renameSync(claim, lock); } catch {} return null; }
        afterClaim?.(); unlinkSync(claim);
      } catch { return null; }
    }
  }
  return null;
}
function trusted(ctx: any): boolean { return typeof ctx?.isProjectTrusted !== "function" || ctx.isProjectTrusted() === true; }
function relevant(ask: Ask): Hit[] { return (ask.hits ?? []).filter(hit => text(hit.pointer) && text(hit.title)).slice(0, 3); }
function pointerText(hits: Hit[]): string {
  return hits.map((hit, i) => {
    const snippet = text(hit.snippet, 140); const code = text(hit.code, 4_000);
    return ` ${i + 1}. ${text(hit.title)!}: ${text(hit.pointer)!}${snippet ? `\n    ${snippet.replace(/\s+/g, " ")}` : ""}${code ? `\n${code}` : ""}`;
  }).join("\n");
}
function blastHint(root: string, path: unknown, logger: Logger = log): string | null {
  const file = typeof path === "string" ? path : null; const graph = file && wiring(root, logger); if (!file || !graph) return null;
  const graphNodes = graph.nodes ?? [];
  const names = new Map<string, TrailNode>(graphNodes.map((node) => [node.id, node] as [string, TrailNode]));
  const ids = new Set(graphNodes.filter((node) => node.path === file || file.endsWith(`/${node.path}`)).map((node) => node.id));
  const dependents = (graph.edges ?? []).filter((edge) => ids.has(edge.target) && !ids.has(edge.source)).slice(0, 8).map((edge) => { const node = names.get(edge.source); return ` • ${edge.relation} ← ${node ? `${node.name} (${basename(node.path)})` : edge.source}`; });
  return dependents.length ? `[trail] blast radius for ${basename(file)}, who depends on it:\n${dependents.join("\n")}` : null;
}
export function isEligibleTrailStartup(event: any, ctx: any): boolean { return event?.reason === "startup" && ctx?.mode !== "print" && ctx?.mode !== "json" && process.env.PI_SUBAGENT_CHILD !== "1" && !isPiOneshotInvocation(); }

/**
 * Enablement for `root`, inheriting the main checkout's setting when the
 * worktree has no settings file of its own (`.pi/` is gitignored, so a fresh
 * worktree would otherwise report "disabled" while the main checkout is on).
 *
 * The worktree's OWN `.pi` is checked directly: getSettingsPath() resolves to the
 * main checkout, so it cannot see a worktree-level `trail_enable: false`.
 */
export function trailEnabled(root: string, logger: Logger = log): boolean {
  const main = mainCheckoutRoot(root);
  if (main && resolve(main) !== resolve(root)) {
    // The worktree's own `.pi` is invisible to getSetting(), which resolves to the
    // main checkout, so a worktree-level kill switch has to be read directly.
    const own = findSettingsFile(join(root, ".pi"));
    const value = own ? parseSettingsFile(own).trail_enable : undefined;
    if (typeof value === "boolean") {
      logger.info("worktree_settings_source", { root, source: "worktree", path: own });
      return value;
    }
    logger.info("worktree_settings_source", { root, source: "main_checkout", main });
    return getSetting(main, "trail_enable");
  }
  logger.debug("worktree_settings_source", { root, source: "own", path: findSettingsFile(join(root, ".pi")) });
  return getSetting(root, "trail_enable");
}

export function createTrailIntegration(options: Options) {
  // Injectable so tests (fake ctx/session ids, /tmp roots) never write production
  // telemetry into ~/.pi/logs/trail, which is the G1-G3 measurement source for #978.
  const log = options.logger ?? createLogger("trail");
  const child = process.env.PI_SUBAGENT_CHILD === "1";
  const state = { generation: 0, root: "", store: "", dirtySignal: "", enabled: false, toolsRegistered: false, events: undefined as ExtensionAPI["events"] | undefined, value: "stale" as TrailState, nodeCount: 0, tokenSavings: 0, trailReads: 0, sourceReads: 0, repoMapShown: false, dirty: false, buildAttempted: false, refresh: undefined as Promise<boolean> | undefined, mapPaths: new Set<string>(), ctx: undefined as any, gate: { active: false, retrieved: false, pointers: new Set<string>() } };
  const publishSavings = () => {
    if (child || !state.events) return;
    state.events.emit("pidash:trail-savings", { tokenSavings: state.tokenSavings });
    log.debug("savings_published", { tokenSavings: state.tokenSavings });
  };
  const setState = (value: TrailState) => {
    state.value = value;
    // Stale-ctx safety (reload crash postmortem, PR #950): the theme read
    // and slot write must never crash on a ctx invalidated by a mid-flight
    // reload — setSlot guards internally; the theme read needs its own guard.
    let theme: any;
    if (isLiveExtensionCtx(state.ctx)) {
      try { theme = state.ctx.ui.theme; } catch { theme = undefined; }
    }
    setSlot("trail", formatTrailFooter({ state: value, nodeCount: state.nodeCount, tokenSavings: state.tokenSavings, trailReads: state.trailReads, sourceReads: state.sourceReads }, theme), state.ctx);
    publishSavings();
  };
  const loadMap = (root: string) => {
    state.nodeCount = trailNodes(root, log);
    state.mapPaths = indexedFiles(root, log);
    log.debug("map_loaded", { root, nodes: state.nodeCount, indexed: state.mapPaths.size });
  };
  const addSavings = (amount: number) => { if (!amount) return; state.tokenSavings = state.store ? writeSavings(state.store, amount, log) : state.tokenSavings + amount; };
  const rawRun: TrailRun = options.run ?? (async (args, { cwd, timeoutMs }) => { try { const result = await exec("trail", args as string[], { cwd, timeout: timeoutMs ?? TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, DO_NOT_TRACK: "1", npm_config_offline: "true" } }); return { stdout: String(result.stdout).slice(0, MAX_BUFFER), stderr: String(result.stderr).slice(0, MAX_BUFFER), code: 0 }; } catch (error: any) { return { stdout: String(error?.stdout ?? "").slice(0, MAX_BUFFER), stderr: String(error?.stderr || error?.message || "").slice(0, MAX_BUFFER), code: Number(error?.code) || 1 }; } });
  const run: TrailRun = async (args, options) => {
    const started = Date.now();
    // Do not log ask arguments: they contain the user's prompt.
    log.info("subprocess_start", { command: args[0], argCount: args.length, cwd: options.cwd });
    const result = await rawRun(args, options);
    const timing = { command: args[0], argCount: args.length, code: result.code, elapsedMs: Date.now() - started, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length };
    if (result.code) log.warn("subprocess_end", timing); else log.info("subprocess_end", timing);
    return result;
  };
  const available = options.executable ?? (async () => (await run(["--version"], { cwd: state.root })).code === 0);
  const worktree = options.worktree ?? tryResolveWorktreeRoot;
  // Map presence only: the old `check --json` probe cost ~12s at startup and
  // every query self-refreshes anyway.
  const graph = options.graph ?? ((cwd: string): GraphStatus => { loadMap(cwd); return existsSync(resolve(trailMapDir(cwd, log) ?? join(cwd, "graft"), ".graph/wiring.json")) ? "fresh" : "absent"; });
  const refresh = async (): Promise<boolean> => {
    if (child) return false;
    if (state.refresh) { log.info("refresh_join", { dirty: state.dirty }); return state.refresh; }
    const generation = state.generation;
    const root = state.root;
    const release = acquireBuildLock(root, undefined, log);
    if (!release) {
      // Degraded but recoverable: another process is building, so the map stays
      // stale for now. Warn so operators can tell it apart from a normal refresh.
      log.warn("refresh_locked", { root });
      state.dirty = true;
      log.info("graph_dirty", { source: "refresh_locked" });
      return false;
    }
    const started = Date.now();
    log.info("refresh_start", { root, dirty: state.dirty });
    setState(state.value === "stale" || state.nodeCount ? "stale" : "syncing");
    let pending!: Promise<boolean>;
    pending = (async () => {
      const result = await run(["build"], { cwd: root });
      const nodeCount = trailNodes(root, log);
      if (state.generation !== generation || state.root !== root) {
        log.info("refresh_end_stale", { root, ok: result.code === 0, nodes: nodeCount, elapsedMs: Date.now() - started });
        return false;
      }
      loadMap(root); state.dirty = result.code !== 0;
      if (!result.code && state.dirtySignal) try { for (const signal of readdirSync(state.dirtySignal)) try { unlinkSync(join(state.dirtySignal, signal)); } catch {} } catch {}
      setState(result.code === 0 ? "ready" : state.nodeCount ? "stale" : "failed");
      const outcome = { ok: result.code === 0, code: result.code, nodes: state.nodeCount, elapsedMs: Date.now() - started };
      if (result.code) log.warn("refresh_end", outcome); else log.info("refresh_end", outcome);
      return result.code === 0;
    })().finally(() => { release(); if (state.refresh === pending) state.refresh = undefined; });
    state.refresh = pending;
    return pending;
  };
  const markDirty = (source: string) => { if (state.dirty) { log.debug("graph_dirty_repeat", { source }); return; } state.dirty = true; setState(state.value === "absent" || state.value === "failed" ? state.value : "stale"); log.info("graph_dirty", { source }); };
  const consumeDirtySignals = () => {
    if (child || !state.dirtySignal) return;
    try {
      const signals = readdirSync(state.dirtySignal); if (!signals.length) return;
      markDirty("child");
      // A signal is a one-shot "a child edited": consume it here, otherwise every
      // prompt re-marks the map dirty (the footer never settles) and the signal
      // directory grows without bound.
      for (const signal of signals) try { unlinkSync(join(state.dirtySignal, signal)); } catch {}
      log.info("child_dirty_consumed", { count: signals.length });
    } catch {}
  };
  const invalidate = (ctx: any, reason: string) => {
    state.generation++; state.ctx = ctx; state.enabled = false; state.root = ""; state.store = ""; state.dirtySignal = ""; state.refresh = undefined; state.dirty = false; state.buildAttempted = false; state.nodeCount = 0; state.tokenSavings = 0; state.mapPaths = new Set(); state.repoMapShown = false; state.gate = { active: false, retrieved: false, pointers: new Set<string>() };
    clearSlot("trail", ctx); publishSavings(); log.info("session_invalidated", { reason });
  };
  const invoke = async (args: string[]) => {
    log.info("tool_invoke", { command: args[0], enabled: state.enabled, dirty: state.dirty }); if (!state.enabled || !state.root || !trusted(state.ctx) || resolveWorktreeRoot(state.ctx.cwd) !== state.root) return "Trail is disabled or untrusted for this project.";
    if (args[0] === "build") return await refresh() ? "Trail map rebuilt." : "Trail rebuild was skipped or failed; the existing map remains available when present.";
    let result = await run(args, { cwd: state.root });
    const scoped = args.indexOf("--in");
    if (result.code && scoped >= 0) { const retry = [...args]; retry.splice(scoped, 2); log.info("scope_retry_root", { command: args[0] }); result = await run(retry, { cwd: state.root }); }
    if (result.code) return `Trail ${args[0]} failed: ${diagnostic(result.stderr)}`;
    loadMap(state.root); state.dirty = false; setState("ready");
    return result.stdout.slice(0, MAX_BUFFER);
  };
  /**
   * Inject the durable map-first rule plus this turn's hits into the structured prompt.
   * Returns a replacement system prompt when structured options are unavailable (an
   * extension forced the prompt), so the guidance is never silently dropped.
   */
  const inject = (event: any, hits: Hit[], note?: string): { systemPrompt: string } | undefined => {
    const section = hits.length ? `Starting points for this task (from the Trail code map):\n${pointerText(hits)}` : note;
    const promptOptions = event?.systemPromptOptions;
    // A forced prompt replaces the whole system prompt, so the structured options
    // are dropped by Pi: the guidance has to be appended to that string instead.
    if (!promptOptions || promptOptions.forceSystemPrompt !== undefined) {
      const guidance = [MAP_RULE, section].filter(Boolean).join("\n\n");
      const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
      log.warn("injection_mode", { mode: "system_prompt", hits: hits.length, section: Boolean(section) });
      return { systemPrompt: base ? `${base}\n\n${guidance}` : guidance };
    }
    const add = (list: string[] | undefined, rule: string) => (list ?? []).includes(rule) ? [...(list ?? [])] : [...(list ?? []), rule];
    promptOptions.promptGuidelines = add(promptOptions.promptGuidelines, MAP_RULE);
    const guidelines: Record<string, string[]> = { ...(promptOptions.toolGuidelines ?? {}) };
    for (const name of ALL_TRAIL_TOOLS) guidelines[name] = add(guidelines[name], TOOL_RULE);
    promptOptions.toolGuidelines = guidelines;
    if (section) promptOptions.sections = { ...(promptOptions.sections ?? {}), trail: section };
    log.debug("injection_mode", { mode: "structured", hits: hits.length, section: Boolean(section) });
    return undefined;
  };
  const register = (pi: ExtensionAPI) => {
    if (!options.enabled) return;
    state.events = pi.events;
    const registerTools = () => {
      if (state.toolsRegistered) return; state.toolsRegistered = true;
      const tool = (name: string, description: string, parameters: any, args: (params: any) => string[] | null, special?: (params: any) => Promise<string> | string | null) => pi.registerTool({ name, label: name.replace("trail_", "Trail ").replace(/_/g, " "), description, parameters, async execute(_id, params) { const specialResult = special ? await special(params) : null; const command = specialResult ? null : args(params); return { content: [{ type: "text" as const, text: specialResult ?? (command ? await invoke(command) : "Invalid input: use an existing project-relative path.") }], details: {} }; } });
      tool("trail_find_code", "Find compact ranked code references in the local Trail graph.", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), path: Type.Optional(Type.String()) }), p => { const q = text(p.query), file = p.path === undefined ? undefined : projectPath(state.root, p.path); return q && (p.path === undefined || file) ? ["ask", q, ".", "--limit", String(p.limit ?? 8), ...(file ? ["--in", file] : [])] : null; });
      tool("trail_find_all", "Search indexed project files.", Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), fixed: Type.Optional(Type.Boolean()) }), p => { const pattern = text(p.pattern), file = p.path === undefined ? undefined : projectPath(state.root, p.path); return pattern && (p.path === undefined || file) ? ["grep", ...(p.fixed ? ["--fixed"] : []), ...(file ? ["--in", file] : []), pattern] : null; });
      tool("trail_file_api", "Get a signatures-only API view for a project file.", Type.Object({ path: Type.String() }), p => { const file = projectPath(state.root, p.path); return file ? ["skeleton", file] : null; });
      tool("trail_trace_calls", "Trace callers or callees of a symbol.", Type.Object({ symbol: Type.String(), direction: Type.Optional(Type.Union([Type.Literal("in"), Type.Literal("out")])), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), p => { const symbol = text(p.symbol); return symbol ? ["callers", "--direction", p.direction ?? "in", "--depth", String(p.depth ?? 1), symbol] : null; });
      // The overview is a one-per-session orientation aid: ~6,900 repo_map calls
      // vs ~237 find_code calls (issue #978), so after the first one we redirect
      // instead of running the CLI again.
      tool("trail_repo_map", "Show a compact graph-based repository map.", Type.Object({ max_dirs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }), p => ["map", "--max-dirs", String(p.max_dirs ?? 16)], () => { if (!state.repoMapShown) { state.repoMapShown = true; return null; } log.info("repo_map_capped", { root: state.root }); return "[trail] The repository map was already shown in this session. Use trail_find_code to search for the concept you need instead of re-orienting."; });
      if (!child) { tool("trail_refresh", "Rebuild the local Trail graph.", Type.Object({}), () => ["build"]); tool("trail_blast_radius", "Find dependencies affected by the local diff.", Type.Object({ depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), p => ["blast", "--depth", String(p.depth ?? 2)]); }
    };
    pi.on("session_start", async (event: any, ctx: any) => {
      state.ctx = ctx; log.info("session_start_enter", { reason: event?.reason, mode: ctx?.mode, trusted: trusted(ctx) });
      if (!trusted(ctx)) { invalidate(ctx, "untrusted"); log.info("session_start_exit", { decision: "untrusted" }); return; }
      const enabled = options.setting?.(ctx.cwd, log) ?? options.enabled;
      if (!enabled) { invalidate(ctx, "disabled"); log.info("session_start_exit", { decision: "disabled" }); return; }
      // Check for a worktree BEFORE anything goes live. This has to sit above
      // registerTools() and `state.enabled = true`: with those already set, the
      // guards compare resolveWorktreeRoot(cwd) against state.root (both the
      // cwd, since resolution falls back to it) and pass, so the integration
      // stayed live outside a repo -- a read flipped the footer to "synced" and
      // every prompt ran a subprocess in a plain directory.
      if (!worktree(ctx.cwd)) { invalidate(ctx, "not_a_worktree"); setState("absent"); log.info("session_start_exit", { decision: "not_a_worktree", cwd: ctx.cwd }); return; }
      // Print/json/oneshot startups still get the tools and per-prompt gate below;
      // they only skip the binary probe, which a one-shot run cannot report on.
      // Returning here instead used to leave those sessions without any map tool.
      const probe = !child && (isEligibleTrailStartup(event, ctx) || ["new", "reload", "resume", "fork"].includes(event?.reason));
      state.generation++; state.refresh = undefined; state.dirty = false; state.buildAttempted = false; state.root = resolveWorktreeRoot(ctx.cwd); const root = state.root; state.repoMapShown = false; state.gate = { active: false, retrieved: false, pointers: new Set<string>() }; state.trailReads = 0; state.sourceReads = 0;
      state.enabled = true; loadMap(root); state.value = "syncing";
      try { state.store = savingsStore(ctx, root, log); state.dirtySignal = state.store ? `${state.store}.dirty` : ""; if (state.dirtySignal) { mkdirSync(state.dirtySignal, { recursive: true, mode: 0o700 }); chmodSync(state.dirtySignal, 0o700); } state.tokenSavings = readSavings(state.store); } catch (error: any) { state.store = ""; state.dirtySignal = ""; state.tokenSavings = 0; log.warn("savings_restore_failed", { code: error?.code }); }
      // Provisional state while we probe. This used to be "failed", which made
      // every session start — including healthy ones — flash the error-red state
      // for a moment before settling.
      setState("syncing");
      const generation = state.generation;
      // The binary is the real gate: missing → failed, no tools registered.
      if (probe) { const executable = await available(); if (state.generation !== generation || state.root !== root) return; if (!executable) { state.enabled = false; setState("failed"); log.info("session_start_exit", { decision: "unavailable" }); return; } }
      registerTools();
      const status = await graph(root);
      if (state.generation !== generation || state.root !== root) return;
      // Never cold-build here: the first `trail ask` seeds a worktree from the
      // main checkout and repairs the branch diff by itself.
      setState(status === "fresh" ? "ready" : "absent");
      log.info("session_start_exit", { decision: status, probe, nodes: state.nodeCount, map: trailMapDir(root, log) });
    });
    pi.on("tool_call", (event: any) => {
      if (!state.enabled || !["ready", "stale"].includes(state.value) || !state.gate.active || state.gate.retrieved) return;
      const tool = String(event?.toolName ?? event?.name ?? "").toLowerCase();
      if (tool === "read") {
        const path = repoRelative(state.root, event?.input?.path);
        const injected = path ? [...state.gate.pointers].some(pointer => samePath(path, pointer)) : false;
        // Only indexed code files are gated: package.json, docs, lockfiles, .pi/**
        // and every other unindexed path must never be blocked.
        const indexed = path ? state.mapPaths.has(path) : false;
        if (injected || !indexed) { log.debug("gate_allowed", { tool, path, pathClass: injected ? "injected_pointer" : "unindexed" }); return; }
        log.info("gate_blocked", { tool, path, pathClass: "indexed" });
        return { block: true, reason: trailGateReason() };
      }
      if (!searchTool(event, log)) return;
      if ((tool === "bash" || tool === "powershell") && unindexedSearch(event?.input?.command, state.mapPaths)) {
        log.debug("gate_allowed", { tool, pathClass: "unindexed_search" });
        return;
      }
      // Same exemption for the dedicated search tools: searching a file the map
      // never indexed (package.json, a doc) is not blind navigation.
      const toolPath = tool === "grep" || tool === "find" ? repoRelative(state.root, event?.input?.path) : null;
      if (toolPath && !state.mapPaths.has(toolPath)) {
        log.debug("gate_allowed", { tool, path: toolPath, pathClass: "unindexed_search" });
        return;
      }
      log.info("gate_blocked", { tool, pathClass: "search" });
      return { block: true, reason: trailGateReason() };
    });
    pi.on("tool_result", (event: any, ctx: any) => {
      state.ctx = ctx;
      const tool = String(event.toolName).toLowerCase();
      const injectedRead = tool === "read" && !event.isError && (() => { const path = repoRelative(state.root, event?.input?.path); return Boolean(path && [...state.gate.pointers].some(pointer => samePath(path, pointer))); })();
      if (!event.isError && (tool.startsWith("trail_") || injectedRead)) {
        state.gate.retrieved = true; state.gate.active = false;
        log.info("gate_satisfied", { by: tool.startsWith("trail_") ? "tool" : "auto_pointer_read", tool });
      }
      const kind = !event.isError ? classifyToolUse(event.toolName, event.input) : null;
      const savings = !event.isError ? savedTokens(toolText(event.content)) : 0;
      if (kind === "trail") state.trailReads++; else if (kind === "source") state.sourceReads++;
      addSavings(savings);
      if (kind || savings) { setState(state.dirty ? "stale" : state.value === "absent" || state.value === "failed" ? state.value : "ready"); log.info("session_metric", { tool: event.toolName, kind, savings, trailReads: state.trailReads, sourceReads: state.sourceReads, tokenSavings: state.tokenSavings }); }
      const eligible = state.enabled && !event.isError && ["write", "edit"].includes(event.toolName);
      log.info("tool_result", { tool: event.toolName, eligible, kind, savings }); if (!eligible) return;
      // No rebuild on agent_end any more; the dirty flag only drives the footer
      // (and the next query repairs the map itself).
      if (child) { if (!state.dirtySignal) { log.warn("child_dirty_signal_unavailable", { tool: event.toolName }); return; } try { writeFileSync(join(state.dirtySignal, `${process.pid}-${randomUUID()}`), event.toolName, { mode: 0o600, flag: "wx" }); log.info("child_dirty_signaled", { tool: event.toolName }); } catch (error: any) { log.warn("child_dirty_signal_failed", { code: error?.code }); } return; }
      markDirty(event.toolName); const hint = blastHint(state.root, event.input?.path, log);
      return hint ? { content: [...(event.content ?? []), { type: "text", text: hint }] } : undefined;
    });
    pi.on("before_agent_start", async (event: any, ctx: any) => {
      const started = Date.now(); state.ctx = ctx; const { query, querySource } = promptQuery(event); const generation = state.generation; const root = state.root;
      state.gate = { active: false, retrieved: false, pointers: new Set<string>() }; const gate = state.gate;
      const current = () => {
        const generationMatches = state.generation === generation; const rootMatches = state.root === root; const gateMatches = state.gate === gate;
        log.debug("retrieval_current", { generationMatches, rootMatches, gateMatches });
        return generationMatches && rootMatches && gateMatches;
      };
      const finish = (decision: string, extra = {}) => log.info("prompt_retrieval_exit", { decision, querySource, elapsedMs: Date.now() - started, ...extra });
      log.info("prompt_retrieval_enter", { enabled: state.enabled, trusted: trusted(ctx), dirty: state.dirty, refreshing: Boolean(state.refresh), querySource, queryLength: query?.length ?? 0 });
      if (!trusted(ctx) || !state.enabled || !state.root || resolveWorktreeRoot(ctx.cwd) !== state.root) { finish("disabled_or_untrusted"); return; }
      consumeDirtySignals(); state.tokenSavings = Math.max(state.tokenSavings, readSavings(state.store)); setState(state.value);
      if (!["ready", "stale"].includes(state.value)) {
        const status = await graph(root);
        if (!current()) return;
        if (status === "fresh") setState("ready");
        else if (status === "stale") setState("stale");
        else {
          const main = mainCheckoutRoot(root);
          // Only a real map seeds. A main checkout that is "on trail" but never
          // built has `.trail/cache` and nothing to copy, so fall through to the
          // bounded background build instead of staying mapless forever.
          if (main && mapOnDisk(main)) {
            // A worktree with no map of its own is seeded by the query from the
            // main checkout (a copy plus branch-diff repair, never a cold build).
            log.info("graph_seed_expected", { root, main });
          } else if (!child && query && substantive(query) && !state.buildAttempted) {
            // No map anywhere: build one once, in the background and under the
            // build lock, so the next prompt has a map. The turn itself fails
            // open — no gate, no blocking — and says the map is on its way.
            state.buildAttempted = true;
            void refresh().catch((error: any) => log.warn("graph_build_failed", { code: error?.code }));
            setState("syncing");
            log.info("graph_build_started", { root, refreshing: Boolean(state.refresh) });
            finish("graph_building");
            return inject(event, [], BUILD_NOTE);
          } else {
            finish("graph_absent");
            return;
          }
        }
      }
      const guidance = inject(event, []);
      if (!query || !substantive(query)) { finish("guidance_only_control_prompt"); return guidance; }
      state.gate.active = true;
      // One shared budget: a fallback retry must not double the turn's deadline.
      const deadline = started + (options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS);
      const remaining = () => Math.max(1, deadline - Date.now());
      type Attempt = { hits: Hit[]; failure?: { decision: string; note: string; diagnostic?: string } };
      /** One bounded retrieval attempt; null means the session changed under us. */
      const attempt = async (value: string): Promise<Attempt | null> => {
        if (options.retrieve) {
          const result = await withTimeout(options.retrieve(value, root), remaining(), log);
          if (!current()) return null;
          return { hits: result.pointers.map(pointer => ({ title: pointer, pointer })) };
        }
        // `--source` inlines the code, so a hit can be used without re-opening the file.
        const result = await withTimeout(run(["ask", value, ".", "--json", "-n", "3", "--source"], { cwd: root, timeoutMs: remaining() }), remaining(), log);
        if (!current()) return null;
        if (result.code) { const reason = diagnostic(result.stderr); return { hits: [], failure: { decision: "ask_failed", diagnostic: reason, note: `[trail] Retrieval failed: ${reason}. Raw navigation is available.` } }; }
        const savings = savedTokens(result.stdout); addSavings(savings); setState(state.value); loadMap(root);
        const ask = parseAsk(result.stdout);
        if (!ask) return { hits: [], failure: { decision: "invalid_ask_json", note: "[trail] Retrieval returned malformed output. Raw navigation is available." } };
        return { hits: relevant(ask) };
      };
      let hits: Hit[] = [];
      try {
        let result = await attempt(query);
        // A long prompt is searched through its clamped prefix, which can miss
        // where the actual request sits: retry once with the first sentence.
        if (result && !result.hits.length && !result.failure && query.length > QUERY_FALLBACK_CHARS) {
          const fallback = fallbackQuery(query);
          if (fallback && fallback !== query) {
            log.info("retrieval_fallback", { queryLength: query.length, fallbackLength: fallback.length });
            result = await attempt(fallback);
          }
        }
        if (!result) return;
        if (result.failure) { state.gate.active = false; finish(result.failure.decision, result.failure.diagnostic ? { diagnostic: result.failure.diagnostic } : {}); return inject(event, [], result.failure.note); }
        hits = result.hits;
      } catch (error: any) { if (!current()) return; state.gate.active = false; finish("ask_error"); return inject(event, [], `[trail] Retrieval failed: ${text(error?.message, 240) ?? "unknown error"}. Raw navigation is available.`); }
      // Still no map on disk (the seed found nothing, or this was never a
      // worktree): fail open rather than blocking navigation on a map we lack.
      if (!state.mapPaths.size) { state.gate.active = false; log.info("gate_skipped", { reason: "no_map" }); }
      if (!hits.length) {
        // Do NOT satisfy the gate here: the turn still has to reach the map
        // through a real trail_* call (issue #978: auto retrieval was satisfying
        // its own gate, so the block never fired).
        state.dirty = false; setState(state.nodeCount ? "ready" : "absent"); finish("guidance_only_no_relevant_hits"); return inject(event, []);
      }
      hits.forEach(hit => { const path = pointerPath(hit.pointer!); if (path) state.gate.pointers.add(path); });
      state.dirty = false; setState(state.nodeCount ? "ready" : "absent");
      finish("injected", { hits: hits.length });
      return inject(event, hits);
    });
    pi.on("session_shutdown", () => {
      log.info("session_shutdown", { state: state.value, dirty: state.dirty, trailReads: state.trailReads, sourceReads: state.sourceReads, tokenSavings: state.tokenSavings });
      // Bump the generation so an in-flight refresh continuation (a trail
      // build resolving across a reload/quit) aborts instead of mutating
      // state and touching the now-stale ctx (reload crash postmortem, PR #950).
      state.generation++;
      clearSlot("trail", state.ctx);
    });
  };
  return { register };
}
export function registerTrail(pi: ExtensionAPI): void { createTrailIntegration({ enabled: true, setting: trailEnabled }).register(pi); }
