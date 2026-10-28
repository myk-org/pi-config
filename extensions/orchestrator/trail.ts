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
import { getSetting, getSettingsPath } from "./project-settings.js";
import { clearSlot, setSlot } from "./status-bar.js";
import { getProjectTmpDir, mainCheckoutRoot, resolveWorktreeRoot, tryResolveWorktreeRoot } from "./utils.js";
import { formatCompactTotal } from "../shared/format-total.js";

const exec = promisify(execFile);
const log = createLogger("trail");
const TIMEOUT_MS = 45_000;
const MAX_BUFFER = 64 * 1024;
const MIN_PROMPT_CHARS = 12;
const QUERY_MAX_CHARS = 500;
const INTERACTIVE_TIMEOUT_MS = 2_000;
export const TRAIL_QUERY_TOOLS = ["trail_find_code", "trail_find_all", "trail_file_api", "trail_trace_calls", "trail_repo_map"] as const;
export function withTrailTools(tools: readonly string[] | undefined, enabled: boolean): string[] | undefined {
  if (!tools?.length || !enabled) return tools ? [...tools] : undefined;
  return [...new Set([...tools, ...TRAIL_QUERY_TOOLS])];
}
export type TrailState = "syncing" | "ready" | "stale" | "absent" | "failed";
export type TrailRun = (args: readonly string[], options: { cwd: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>;
type GraphStatus = "fresh" | "stale" | "absent";
type Options = { enabled: boolean; setting?: (cwd: string) => boolean; executable?: () => Promise<boolean>; graph?: (cwd: string) => Promise<GraphStatus> | GraphStatus; retrieve?: (query: string, cwd: string) => Promise<{ pointers: string[] }>; worktree?: (cwd: string) => string | null; run?: TrailRun; interactiveTimeoutMs?: number; logger?: Logger };
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
 */
export function trailMapDir(root: string, logger: Logger = log): string | null {
  const trail = join(root, ".trail", "cache");
  // `.trail/learnings` marks a repo on trail before its first build lands.
  if (existsSync(trail) || existsSync(join(root, ".trail", "learnings"))) {
    logger.debug("map_dir_resolved", { root, layout: "trail", dir: trail });
    return trail;
  }
  const graft = join(root, "graft");
  if (existsSync(join(graft, ".graph", "wiring.json"))) {
    // Upstream owns this path name; we only read it until trail renames it.
    logger.debug("map_dir_resolved", { root, layout: "legacy", dir: graft });
    return graft;
  }
  logger.debug("map_dir_resolved", { root, layout: "none" });
  return null;
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
function queryText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = value.replace(/\0/g, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, QUERY_MAX_CHARS).trim();
  return query || null;
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
export function classifyToolUse(name: unknown, _input: any): "trail" | "source" | null {
  const tool = typeof name === "string" ? name.toLowerCase() : "";
  if (tool.startsWith("trail_")) return "trail";
  if (["read", "grep", "find", "ls"].includes(tool)) return "source";
  return null;
}
const MAP_RULE = "This project has a Trail code map. Start every code exploration with trail_find_code (describe the concept, not an identifier) before read/grep/find/glob or shell searches; it returns ranked file:line hits with source inlined.";
const TOOL_RULE = "Search concepts, not identifiers; call before read/grep for code navigation.";
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
function pointerPath(pointer: string): string | null {
  // A pointer is `path:span`, a bare file path, or a comma-joined source list.
  const first = pointer.split(",")[0].trim();
  const span = /^(.+?):\d+(?::\d+)?$/.exec(first);
  if (span) return span[1];
  return /[/.]/.test(first) && !/\s/.test(first) ? first : null;
}
/** The CLI may print a note line ("refreshed the graph…", "tokens saved ≈ …") before the JSON. */
function parseAsk(stdout: string): Ask | null {
  const start = stdout.indexOf("{"); const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(stdout.slice(start, end + 1)) as Ask; } catch { return null; }
}
function searchTool(event: any): boolean {
  const tool = String(event?.toolName ?? event?.name ?? "").toLowerCase();
  if (["grep", "find", "glob", "search"].includes(tool)) return true;
  if (tool !== "bash" && tool !== "powershell") return false;
  return /(^|[|;&]\s*)(?:\S+=\S+\s*)*(?:rg|grep|find|ag|ack)\b/i.test(String(event?.input?.command ?? ""));
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
function buildLockPath(root: string, logger: Logger = log): string { return resolve(trailMapDir(root, logger) ?? resolve(root, "graft"), ".graph/pi-build.lock"); }
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
 */
export function trailEnabled(root: string, logger: Logger = log): boolean {
  const main = mainCheckoutRoot(root);
  if (main && resolve(main) !== resolve(root) && !existsSync(getSettingsPath(root))) {
    logger.info("worktree_settings_source", { root, source: "main_checkout", main });
    return getSetting(main, "trail_enable");
  }
  logger.debug("worktree_settings_source", { root, source: "own", path: getSettingsPath(root) });
  return getSetting(root, "trail_enable");
}

export function createTrailIntegration(options: Options) {
  // Injectable so tests (fake ctx/session ids, /tmp roots) never write production
  // telemetry into ~/.pi/logs/trail, which is the G1-G3 measurement source for #978.
  const log = options.logger ?? createLogger("trail");
  const child = process.env.PI_SUBAGENT_CHILD === "1";
  const state = { generation: 0, root: "", store: "", dirtySignal: "", enabled: false, toolsRegistered: false, events: undefined as ExtensionAPI["events"] | undefined, value: "stale" as TrailState, nodeCount: 0, tokenSavings: 0, trailReads: 0, sourceReads: 0, repoMapShown: false, dirty: false, refresh: undefined as Promise<boolean> | undefined, mapPaths: new Set<string>(), ctx: undefined as any, gate: { active: false, retrieved: false, pointers: new Set<string>() } };
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
      log.info("refresh_locked", { root });
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
      log.info("refresh_end", { ok: result.code === 0, nodes: state.nodeCount, elapsedMs: Date.now() - started });
      return result.code === 0;
    })().finally(() => { release(); if (state.refresh === pending) state.refresh = undefined; });
    state.refresh = pending;
    return pending;
  };
  const markDirty = (source: string) => { if (state.dirty) { log.debug("graph_dirty_repeat", { source }); return; } state.dirty = true; setState(state.value === "absent" || state.value === "failed" ? state.value : "stale"); log.info("graph_dirty", { source }); };
  const consumeDirtySignals = () => {
    if (child || !state.dirtySignal) return;
    try { const signals = readdirSync(state.dirtySignal); if (!signals.length) return; markDirty("child"); log.info("child_dirty_consumed", { count: signals.length }); } catch {}
  };
  const invalidate = (ctx: any, reason: string) => {
    state.generation++; state.ctx = ctx; state.enabled = false; state.root = ""; state.store = ""; state.dirtySignal = ""; state.refresh = undefined; state.dirty = false; state.nodeCount = 0; state.tokenSavings = 0; state.mapPaths = new Set(); state.repoMapShown = false; state.gate = { active: false, retrieved: false, pointers: new Set<string>() };
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
  /** Inject the durable map-first rule plus this turn's hits into the structured prompt. */
  const inject = (event: any, hits: Hit[], note?: string) => {
    const promptOptions = event?.systemPromptOptions;
    if (!promptOptions) { log.warn("injection_mode", { mode: "unavailable" }); return; }
    const add = (list: string[] | undefined, rule: string) => (list ?? []).includes(rule) ? [...(list ?? [])] : [...(list ?? []), rule];
    promptOptions.promptGuidelines = add(promptOptions.promptGuidelines, MAP_RULE);
    const guidelines: Record<string, string[]> = { ...(promptOptions.toolGuidelines ?? {}) };
    for (const name of ALL_TRAIL_TOOLS) guidelines[name] = add(guidelines[name], TOOL_RULE);
    promptOptions.toolGuidelines = guidelines;
    const section = hits.length ? `Starting points for this task (from the Trail code map):\n${pointerText(hits)}` : note;
    if (section) promptOptions.sections = { ...(promptOptions.sections ?? {}), trail: section };
    log.debug("injection_mode", { mode: "structured", hits: hits.length, section: Boolean(section) });
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
      const enabled = options.setting?.(ctx.cwd) ?? options.enabled;
      if (!enabled) { invalidate(ctx, "disabled"); log.info("session_start_exit", { decision: "disabled" }); return; }
      // Check for a worktree BEFORE anything goes live. This has to sit above
      // registerTools() and `state.enabled = true`: with those already set, the
      // guards compare resolveWorktreeRoot(cwd) against state.root (both the
      // cwd, since resolution falls back to it) and pass, so the integration
      // stayed live outside a repo -- a read flipped the footer to "synced" and
      // every prompt ran a subprocess in a plain directory.
      if (!worktree(ctx.cwd)) { invalidate(ctx, "not_a_worktree"); setState("absent"); log.info("session_start_exit", { decision: "not_a_worktree", cwd: ctx.cwd }); return; }
      if (!child && !isEligibleTrailStartup(event, ctx) && !["new", "reload", "resume", "fork"].includes(event?.reason)) { log.info("session_start_exit", { decision: "ineligible" }); return; }
      state.generation++; state.refresh = undefined; state.dirty = false; state.root = resolveWorktreeRoot(ctx.cwd); const root = state.root; state.repoMapShown = false; state.gate = { active: false, retrieved: false, pointers: new Set<string>() }; state.trailReads = 0; state.sourceReads = 0;
      state.enabled = true; loadMap(root); state.value = "syncing";
      try { state.store = savingsStore(ctx, root, log); state.dirtySignal = state.store ? `${state.store}.dirty` : ""; if (state.dirtySignal) { mkdirSync(state.dirtySignal, { recursive: true, mode: 0o700 }); chmodSync(state.dirtySignal, 0o700); } state.tokenSavings = readSavings(state.store); } catch (error: any) { state.store = ""; state.dirtySignal = ""; state.tokenSavings = 0; log.warn("savings_restore_failed", { code: error?.code }); }
      // Provisional state while we probe. This used to be "failed", which made
      // every session start — including healthy ones — flash the error-red state
      // for a moment before settling.
      setState("syncing");
      const generation = state.generation;
      // The binary is the real gate: missing → failed, no tools registered.
      if (!child) { const executable = await available(); if (state.generation !== generation || state.root !== root) return; if (!executable) { state.enabled = false; setState("failed"); log.info("session_start_exit", { decision: "unavailable" }); return; } }
      registerTools();
      const status = await graph(root);
      if (state.generation !== generation || state.root !== root) return;
      // Never cold-build here: the first `trail ask` seeds a worktree from the
      // main checkout and repairs the branch diff by itself.
      setState(status === "fresh" ? "ready" : "absent");
      log.info("session_start_exit", { decision: status, nodes: state.nodeCount, map: trailMapDir(root, log) });
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
      if (!searchTool(event)) return;
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
          // A fresh worktree has no map of its own, but a query seeds one from
          // the main checkout (a copy plus branch-diff repair, never a cold
          // build). A repo with no map anywhere is left alone — fail open.
          const main = mainCheckoutRoot(root);
          if (!main || !trailMapDir(main, log)) { finish("graph_absent"); return; }
          log.info("graph_seed_expected", { root, main });
        }
      }
      inject(event, []);
      if (!query || !substantive(query)) { finish("guidance_only_control_prompt"); return; }
      state.gate.active = true;
      let hits: Hit[] = [];
      try {
        if (options.retrieve) { const result = await withTimeout(options.retrieve(query, root), options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS, log); if (!current()) return; hits = result.pointers.map(pointer => ({ title: pointer, pointer })); }
        else {
          // `--source` inlines the code, so a hit can be used without re-opening the file.
          const result = await withTimeout(run(["ask", query, ".", "--json", "-n", "3", "--source"], { cwd: root, timeoutMs: options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS }), options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS, log);
          if (!current()) return;
          if (result.code) { state.gate.active = false; finish("ask_failed", { diagnostic: diagnostic(result.stderr) }); inject(event, [], `[trail] Retrieval failed: ${diagnostic(result.stderr)}. Raw navigation is available.`); return; }
          const savings = savedTokens(result.stdout); addSavings(savings); setState(state.value); loadMap(root);
          const ask = parseAsk(result.stdout);
          if (!ask) { state.gate.active = false; finish("invalid_ask_json"); inject(event, [], "[trail] Retrieval returned malformed output. Raw navigation is available."); return; }
          hits = relevant(ask);
        }
      } catch (error: any) { if (!current()) return; state.gate.active = false; finish("ask_error"); inject(event, [], `[trail] Retrieval failed: ${text(error?.message, 240) ?? "unknown error"}. Raw navigation is available.`); return; }
      // Still no map on disk (the seed found nothing, or this was never a
      // worktree): fail open rather than blocking navigation on a map we lack.
      if (!state.mapPaths.size) { state.gate.active = false; log.info("gate_skipped", { reason: "no_map" }); }
      if (!hits.length) {
        // Do NOT satisfy the gate here: the turn still has to reach the map
        // through a real trail_* call (issue #978: auto retrieval was satisfying
        // its own gate, so the block never fired).
        state.dirty = false; setState(state.nodeCount ? "ready" : "absent"); finish("guidance_only_no_relevant_hits"); inject(event, []); return;
      }
      hits.forEach(hit => { const path = pointerPath(hit.pointer!); if (path) state.gate.pointers.add(path); });
      state.dirty = false; setState(state.nodeCount ? "ready" : "absent");
      inject(event, hits); finish("injected", { hits: hits.length });
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
