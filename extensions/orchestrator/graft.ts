/** Opt-in, local Graft graph integration. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.js";
import { isPiOneshotInvocation } from "../shared/oneshot.js";
import { getSetting } from "./project-settings.js";
import { clearSlot, setSlot } from "./status-bar.js";
import { getProjectTmpDir, resolveWorktreeRoot } from "./utils.js";
import { formatCompactTotal } from "../shared/format-total.js";

const exec = promisify(execFile);
const log = createLogger("graft");
const TIMEOUT_MS = 45_000;
const MAX_BUFFER = 64 * 1024;
const MIN_PROMPT_CHARS = 12;
const INTERACTIVE_TIMEOUT_MS = 2_000;
export const GRAFT_QUERY_TOOLS = ["graft_find_code", "graft_find_all", "graft_file_api", "graft_trace_calls", "graft_repo_map"] as const;
export function withGraftTools(tools: readonly string[] | undefined, enabled: boolean): string[] | undefined {
  if (!tools?.length || !enabled) return tools ? [...tools] : undefined;
  return [...new Set([...tools, ...GRAFT_QUERY_TOOLS])];
}
export type GraftState = "syncing" | "ready" | "stale" | "failed";
export type GraftRun = (args: readonly string[], options: { cwd: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>;
type GraphStatus = "fresh" | "stale" | "absent";
type Options = { enabled: boolean; setting?: (cwd: string) => boolean; executable?: () => Promise<boolean>; graph?: (cwd: string) => Promise<GraphStatus>; retrieve?: (query: string, cwd: string) => Promise<{ pointers: string[] }>; run?: GraftRun; interactiveTimeoutMs?: number };
type StatusTheme = { fg: (color: string, value: string) => string };
type Hit = { title?: string; pointer?: string; snippet?: string };
type Ask = { coverage?: number; coverageStrong?: number; hits?: Hit[] };

/** Graft's statusline shape, adapted to Pi's theme API. */
export function formatGraftFooter({ state, nodeCount, tokenSavings }: { state: GraftState; nodeCount: number; tokenSavings: number }, theme?: StatusTheme): string {
  const fg = (color: string, value: string) => theme?.fg(color, value) ?? value;
  const freshness = state === "syncing" ? fg("warning", "syncing…") : state === "stale" ? fg("warning", "⚠ stale") : state === "failed" ? fg("error", "failed") : fg("success", "✓ synced");
  const parts = [fg("dim", "◤ ") + fg("accent", "graft"), fg("dim", `${nodeCount} nodes`), freshness];
  if (tokenSavings > 0) parts.push(fg("success", `~${formatCompactTotal(tokenSavings)} tok saved`));
  return parts.join(fg("dim", " · "));
}
function text(value: unknown, max = 500): string | null { return typeof value === "string" && value.trim() && value.length <= max && !/[\0\r\n]/.test(value) ? value.trim() : null; }
function projectPath(root: string, value: unknown): string | null {
  const file = text(value); if (!file || isAbsolute(file)) return null;
  const absolute = resolve(root, file); if (relative(root, absolute).startsWith("..")) return null;
  try { const realRoot = realpathSync(root); const realFile = realpathSync(absolute); return realFile === realRoot || realFile.startsWith(realRoot + sep) ? file : null; } catch { return null; }
}
function wiring(root: string): any | null { try { return JSON.parse(readFileSync(resolve(root, "graft/.graph/wiring.json"), "utf8")); } catch { return null; } }
function nodes(root: string): number { const graph = wiring(root); return Number.isSafeInteger(graph?.meta?.nodeCount) ? graph.meta.nodeCount : graph?.nodes?.length ?? 0; }
function savedTokens(output: string): number { return [...output.matchAll(/\[graft\] tokens saved ≈ ([\d,]+)/g)].reduce((total, match) => total + (Number(match[1].replaceAll(",", "")) || 0), 0); }
function savingsStore(ctx: any): string {
  let id: unknown = process.env.PI_SUBAGENT_CHILD === "1" ? process.env.__PI_PARENT_SESSION_ID : undefined;
  try { id ||= ctx.sessionManager?.getSessionId?.(); } catch { return ""; }
  if (typeof id !== "string" || !id) return "";
  const dir = getProjectTmpDir(ctx.cwd); chmodSync(dir, 0o700);
  return join(dir, `graft-savings-${createHash("sha256").update(id).digest("hex")}.json`);
}
function validSavings(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
function readSavings(file: string): number {
  if (!file) return 0;
  try { return validSavings(JSON.parse(readFileSync(file, "utf8"))?.tokenSavings); } catch { return 0; }
}
function writeSavings(file: string, delta: number): number {
  if (!file || !delta) return readSavings(file);
  const lock = `${file}.lock`; const owner = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      writeFileSync(lock, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
      const total = readSavings(file) + delta; const tmp = `${file}.${owner.token}.tmp`;
      writeFileSync(tmp, JSON.stringify({ tokenSavings: total }), { mode: 0o600 }); renameSync(tmp, file);
      if (lockOwner(lock)?.token === owner.token) unlinkSync(lock);
      return total;
    } catch (error: any) {
      if (error?.code !== "EEXIST") { log.warn("savings_persist_failed", { code: error?.code }); return readSavings(file); }
      const existing = lockOwner(lock);
      if (!ownerAlive(existing)) {
        const claim = `${lock}.claim-${owner.token}`;
        try { renameSync(lock, claim); if (lockOwner(claim)?.token === existing?.token && !ownerAlive(existing)) unlinkSync(claim); else try { renameSync(claim, lock); } catch {} } catch {}
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  log.warn("savings_persist_failed", { code: "LOCK_BUSY" }); return readSavings(file);
}
function toolText(content: unknown): string { return Array.isArray(content) ? content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n") : ""; }
export function classifyToolUse(name: unknown, input: any): "graft" | "source" | null {
  const tool = typeof name === "string" ? name.toLowerCase() : "";
  if (tool.startsWith("graft_")) return "graft";
  if (["read", "grep", "find", "ls"].includes(tool)) return "source";
  if (["bash", "powershell"].includes(tool) && /(^|[|&;]\s*)(npx\s+(-y\s+)?(@nanonets\/)?\s*)?graft(-dev)?\b/i.test(String(input?.command ?? ""))) return "graft";
  return null;
}
function forceUseGuidance(stale = false): string { return `[graft] This trusted project has a ${stale ? "stale but usable" : "ready"} local Graft graph. Use Graft before raw grep/read: graft_find_code for where/how, graft_trace_calls for callers/callees or blast radius, graft_file_api for a file API, graft_repo_map for orientation, and graft_find_all only when every occurrence is required. Use raw tools only to inspect a Graft result or when Graft has no answer.${stale ? " The owner is rebuilding the graph; verify pointers against source." : ""}`; }
function substantive(query: string): boolean { return query.length >= MIN_PROMPT_CHARS && !query.startsWith("/"); }
function pointerPath(pointer: string): string | null { const match = /^(.+?):\d+(?::\d+)?$/.exec(pointer.trim()); return match?.[1] ?? null; }
function navigationTool(event: any): boolean {
  const tool = String(event?.toolName ?? event?.name ?? "").toLowerCase();
  if (["grep", "find", "glob", "search"].includes(tool)) return true;
  if (tool !== "bash" && tool !== "powershell") return false;
  return /(^|[|;&]\s*)(?:\S+=\S+\s+)*(?:rg|grep|find|ag|ack)\b/i.test(String(event?.input?.command ?? ""));
}
function graftGateReason(): string { return "[graft] Project navigation is blocked until Graft retrieval runs for this turn. Use graft_find_code (or graft_repo_map/graft_trace_calls), then inspect its returned file pointers. If Graft has no relevant result, retry the raw navigation."; }
function diagnostic(stderr: string): string { return text(stderr.split(/\r?\n/, 1)[0], 240) ?? "no diagnostic output"; }
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("automatic retrieval timed out")), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
type LockOwner = { pid: number; token: string };
function lockOwner(lock: string): LockOwner | null { try { const raw = readFileSync(lock, "utf8"); const legacyPid = Number(raw); if (Number.isSafeInteger(legacyPid)) return { pid: legacyPid, token: `legacy-${legacyPid}` }; const owner = JSON.parse(raw); return Number.isSafeInteger(owner?.pid) && typeof owner?.token === "string" ? owner : null; } catch { return null; } }
function ownerAlive(owner: LockOwner | null): boolean { if (!owner) return false; try { process.kill(owner.pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; } }
export function acquireBuildLock(root: string, afterClaim?: () => void): (() => void) | null {
  const lock = resolve(root, "graft/.graph/pi-build.lock"); const claim = `${lock}.claim`; const owner = { pid: process.pid, token: randomUUID() };
  try { mkdirSync(dirname(lock), { recursive: true }); } catch { log.warn("build_lock_unavailable", { root }); return null; }
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
function relevant(ask: Ask): Hit[] { const hits = ask.hits?.filter(hit => text(hit.pointer) && text(hit.title)) ?? []; if (!hits.length) return []; if ((typeof ask.coverage === "number" || typeof ask.coverageStrong === "number") && (ask.coverageStrong ?? 0) < .1 && (ask.coverage ?? 0) < .5) return []; return hits.slice(0, 3); }
function pointerText(hits: Hit[]): string { return hits.map((hit, i) => { const snippet = text(hit.snippet, 140); return ` ${i + 1}. ${text(hit.title)!}: ${text(hit.pointer)!}${snippet ? `\n    ${snippet.replace(/\s+/g, " ")}` : ""}`; }).join("\n"); }
function blastHint(root: string, path: unknown): string | null {
  const file = typeof path === "string" ? path : null; const graph = file && wiring(root); if (!file || !graph) return null;
  const names = new Map((graph.nodes ?? []).map((node: any) => [node.id, node]));
  const ids = new Set((graph.nodes ?? []).filter((node: any) => node.path === file || file.endsWith(`/${node.path}`)).map((node: any) => node.id));
  const dependents = (graph.edges ?? []).filter((edge: any) => ids.has(edge.target) && !ids.has(edge.source)).slice(0, 8).map((edge: any) => { const node = names.get(edge.source); return ` • ${edge.relation} ← ${node ? `${node.name} (${basename(node.path)})` : edge.source}`; });
  return dependents.length ? `[graft] blast radius for ${basename(file)}, who depends on it:\n${dependents.join("\n")}` : null;
}
export function isEligibleGraftStartup(event: any, ctx: any): boolean { return event?.reason === "startup" && ctx?.mode !== "print" && ctx?.mode !== "json" && process.env.PI_SUBAGENT_CHILD !== "1" && !isPiOneshotInvocation(); }

export function createGraftIntegration(options: Options) {
  const child = process.env.PI_SUBAGENT_CHILD === "1";
  const state = { generation: 0, root: "", store: "", dirtySignal: "", enabled: false, events: undefined as ExtensionAPI["events"] | undefined, value: "stale" as GraftState, nodeCount: 0, tokenSavings: 0, graftReads: 0, sourceReads: 0, dirty: false, refresh: undefined as Promise<boolean> | undefined, ctx: undefined as any, gate: { active: false, retrieved: false, pointers: new Set<string>() } };
  const publishSavings = () => {
    if (child || !state.events) return;
    state.events.emit("pidash:graft-savings", { tokenSavings: state.tokenSavings });
    log.debug("savings_published", { tokenSavings: state.tokenSavings });
  };
  const setState = (value: GraftState) => { state.value = value; setSlot("graft", formatGraftFooter({ state: value, nodeCount: state.nodeCount, tokenSavings: state.tokenSavings }, state.ctx?.ui?.theme), state.ctx); publishSavings(); };
  const addSavings = (amount: number) => { if (!amount) return; state.tokenSavings = state.store ? writeSavings(state.store, amount) : state.tokenSavings + amount; };
  const rawRun: GraftRun = options.run ?? (async (args, { cwd, timeoutMs }) => { try { const result = await exec("graft", args as string[], { cwd, timeout: timeoutMs ?? TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, DO_NOT_TRACK: "1", npm_config_offline: "true" } }); return { stdout: String(result.stdout).slice(0, MAX_BUFFER), stderr: String(result.stderr).slice(0, MAX_BUFFER), code: 0 }; } catch (error: any) { return { stdout: String(error?.stdout ?? "").slice(0, MAX_BUFFER), stderr: String(error?.stderr || error?.message || "").slice(0, MAX_BUFFER), code: Number(error?.code) || 1 }; } });
  const run: GraftRun = async (args, options) => {
    const started = Date.now();
    // Do not log ask arguments: they contain the user's prompt.
    log.info("subprocess_start", { command: args[0], argCount: args.length, cwd: options.cwd });
    const result = await rawRun(args, options);
    const timing = { command: args[0], argCount: args.length, code: result.code, elapsedMs: Date.now() - started, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length };
    if (result.code) log.warn("subprocess_end", timing); else log.info("subprocess_end", timing);
    return result;
  };
  const available = options.executable ?? (async () => (await run(["--version"], { cwd: state.root })).code === 0);
  const graph = options.graph ?? (async cwd => (await run(["check", "--json"], { cwd })).code === 0 ? "fresh" : nodes(cwd) ? "stale" : "absent");
  const refresh = async (): Promise<boolean> => {
    if (child) return false;
    if (state.refresh) { log.info("refresh_join", { dirty: state.dirty }); return state.refresh; }
    const generation = state.generation;
    const root = state.root;
    const release = acquireBuildLock(root);
    if (!release) { log.info("refresh_locked", { root }); return false; }
    const started = Date.now();
    log.info("refresh_start", { root, dirty: state.dirty });
    setState(state.value === "stale" || state.nodeCount ? "stale" : "syncing");
    let pending!: Promise<boolean>;
    pending = (async () => {
      const result = await run(["build"], { cwd: root });
      const nodeCount = nodes(root);
      if (state.generation !== generation || state.root !== root) {
        log.info("refresh_end_stale", { root, ok: result.code === 0, nodes: nodeCount, elapsedMs: Date.now() - started });
        return false;
      }
      state.nodeCount = nodeCount; state.dirty = result.code !== 0;
      if (!result.code && state.dirtySignal) try { for (const signal of readdirSync(state.dirtySignal)) try { unlinkSync(join(state.dirtySignal, signal)); } catch {} } catch {}
      setState(result.code === 0 ? "ready" : state.nodeCount ? "stale" : "failed");
      log.info("refresh_end", { ok: result.code === 0, nodes: state.nodeCount, elapsedMs: Date.now() - started });
      return result.code === 0;
    })().finally(() => { release(); if (state.refresh === pending) state.refresh = undefined; });
    state.refresh = pending;
    return pending;
  };
  const markDirty = (source: string) => { if (state.dirty) { log.debug("graph_dirty_repeat", { source }); return; } state.dirty = true; setState("stale"); log.info("graph_dirty", { source }); };
  const consumeDirtySignals = () => {
    if (child || !state.dirtySignal) return;
    try { const signals = readdirSync(state.dirtySignal); if (!signals.length) return; markDirty("child"); log.info("child_dirty_consumed", { count: signals.length }); } catch {}
  };
  const invalidate = (ctx: any, reason: string) => {
    state.generation++; state.ctx = ctx; state.enabled = false; state.root = ""; state.store = ""; state.dirtySignal = ""; state.refresh = undefined; state.dirty = false; state.nodeCount = 0; state.tokenSavings = 0; state.gate = { active: false, retrieved: false, pointers: new Set<string>() };
    clearSlot("graft", ctx); publishSavings(); log.info("session_invalidated", { reason });
  };
  const invoke = async (args: string[]) => {
    log.info("tool_invoke", { command: args[0], enabled: state.enabled, dirty: state.dirty }); if (!state.enabled || !state.root || !trusted(state.ctx) || resolveWorktreeRoot(state.ctx.cwd) !== state.root) return "Graft is disabled or untrusted for this project.";
    if (args[0] === "build") return await refresh() ? "Graft graph rebuilt." : "Graft rebuild was skipped or failed; the existing graph remains available when present.";
    let result = await run(args, { cwd: state.root });
    const scoped = args.indexOf("--in");
    if (result.code && scoped >= 0) { const retry = [...args]; retry.splice(scoped, 2); log.info("scope_retry_root", { command: args[0] }); result = await run(retry, { cwd: state.root }); }
    if (result.code) return `Graft ${args[0]} failed: ${diagnostic(result.stderr)}`;
    state.nodeCount = nodes(state.root); setState(state.dirty || state.value === "stale" ? "stale" : "ready"); return result.stdout.slice(0, MAX_BUFFER);
  };
  const register = (pi: ExtensionAPI) => {
    if (!options.enabled) return;
    state.events = pi.events;
    let toolsRegistered = false;
    const registerTools = () => { if (toolsRegistered) return; toolsRegistered = true; const tool = (name: string, description: string, parameters: any, args: (params: any) => string[] | null) => pi.registerTool({ name, label: name.replace("graft_", "Graft ").replace(/_/g, " "), description, parameters, async execute(_id, params) { const command = args(params); return { content: [{ type: "text" as const, text: command ? await invoke(command) : "Invalid input: use an existing project-relative path." }], details: {} }; } });
      tool("graft_find_code", "Find compact ranked code references in the local Graft graph.", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), path: Type.Optional(Type.String()) }), p => { const q = text(p.query), file = p.path === undefined ? undefined : projectPath(state.root, p.path); return q && (p.path === undefined || file) ? ["ask", q, ".", "--limit", String(p.limit ?? 8), ...(file ? ["--in", file] : [])] : null; });
      tool("graft_find_all", "Search indexed project files.", Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), fixed: Type.Optional(Type.Boolean()) }), p => { const pattern = text(p.pattern), file = p.path === undefined ? undefined : projectPath(state.root, p.path); return pattern && (p.path === undefined || file) ? ["grep", ...(p.fixed ? ["--fixed"] : []), ...(file ? ["--in", file] : []), pattern] : null; });
      tool("graft_file_api", "Get a signatures-only API view for a project file.", Type.Object({ path: Type.String() }), p => { const file = projectPath(state.root, p.path); return file ? ["skeleton", file] : null; });
      tool("graft_trace_calls", "Trace callers or callees of a symbol.", Type.Object({ symbol: Type.String(), direction: Type.Optional(Type.Union([Type.Literal("in"), Type.Literal("out")])), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), p => { const symbol = text(p.symbol); return symbol ? ["callers", "--direction", p.direction ?? "in", "--depth", String(p.depth ?? 1), symbol] : null; });
      tool("graft_repo_map", "Show a compact graph-based repository map.", Type.Object({ max_dirs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }), p => ["map", "--max-dirs", String(p.max_dirs ?? 16)]);
      if (!child) { tool("graft_refresh", "Rebuild the local Graft graph.", Type.Object({}), () => ["build"]); tool("graft_blast_radius", "Find dependencies affected by the local diff.", Type.Object({ depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), p => ["blast", "--depth", String(p.depth ?? 2)]); }
    };
    pi.on("session_start", async (event: any, ctx: any) => {
      state.ctx = ctx; log.info("session_start_enter", { reason: event?.reason, mode: ctx?.mode, trusted: trusted(ctx) });
      if (!trusted(ctx)) { invalidate(ctx, "untrusted"); log.info("session_start_exit", { decision: "untrusted" }); return; }
      const enabled = options.setting?.(ctx.cwd) ?? options.enabled;
      if (!enabled) { invalidate(ctx, "disabled"); log.info("session_start_exit", { decision: "disabled" }); return; }
      registerTools(); state.generation++; state.enabled = true; state.refresh = undefined; state.dirty = false; state.root = resolveWorktreeRoot(ctx.cwd); state.nodeCount = nodes(state.root);
      try { state.store = savingsStore(ctx); state.dirtySignal = state.store ? `${state.store}.dirty` : ""; if (state.dirtySignal) { mkdirSync(state.dirtySignal, { recursive: true, mode: 0o700 }); chmodSync(state.dirtySignal, 0o700); } state.tokenSavings = readSavings(state.store); } catch (error: any) { state.store = ""; state.dirtySignal = ""; state.tokenSavings = 0; log.warn("savings_restore_failed", { code: error?.code }); }
      setState(state.value);
      if (!child && !isEligibleGraftStartup(event, ctx) && !["reload", "resume"].includes(event?.reason)) { log.info("session_start_exit", { decision: "ineligible" }); return; }
      if (!child && !await available()) { setState("failed"); log.info("session_start_exit", { decision: "unavailable" }); return; }
      const status = await graph(state.root);
      if (status === "fresh") setState("ready");
      else { setState(state.nodeCount ? "stale" : "failed"); if (!child) void refresh(); }
      log.info("session_start_exit", { decision: status, nodes: state.nodeCount });
    });
    pi.on("tool_call", (event: any, ctx: any) => {
      const tool = String(event?.toolName ?? event?.name ?? "").toLowerCase();
      const allowedPointerRead = tool === "read" && typeof event?.input?.path === "string" && state.gate.pointers.has(event.input.path.replace(/^\.\//, ""));
      if (!state.enabled || !["ready", "stale"].includes(state.value) || !state.gate.active || state.gate.retrieved || allowedPointerRead || !(navigationTool(event) || tool === "read")) return;
      log.info("navigation_blocked", { tool: event.toolName });
      return { block: true, reason: graftGateReason() };
    });
    pi.on("tool_result", (event: any, ctx: any) => {
      state.ctx = ctx;
      const attemptedGraft = String(event.toolName).toLowerCase().startsWith("graft_");
      if (attemptedGraft) { state.gate.retrieved = true; state.gate.active = false; }
      const kind = !event.isError ? classifyToolUse(event.toolName, event.input) : null;
      const savings = !event.isError ? savedTokens(toolText(event.content)) : 0;
      if (kind === "graft") state.graftReads++; else if (kind === "source") state.sourceReads++;
      addSavings(savings);
      if (kind || savings) { setState(state.dirty || state.value === "stale" ? "stale" : "ready"); log.info("session_metric", { tool: event.toolName, kind, savings, graftReads: state.graftReads, sourceReads: state.sourceReads, tokenSavings: state.tokenSavings }); }
      const eligible = state.enabled && !event.isError && ["write", "edit"].includes(event.toolName);
      log.info("tool_result", { tool: event.toolName, eligible, kind, savings }); if (!eligible) return;
      if (child) { try { writeFileSync(join(state.dirtySignal, `${process.pid}-${randomUUID()}`), event.toolName, { mode: 0o600, flag: "wx" }); log.info("child_dirty_signaled", { tool: event.toolName }); } catch (error: any) { log.warn("child_dirty_signal_failed", { code: error?.code }); } return; }
      markDirty(event.toolName); const hint = blastHint(state.root, event.input?.path);
      return hint ? { content: [...(event.content ?? []), { type: "text", text: hint }] } : undefined;
    });
    pi.on("before_agent_start", async (event: any, ctx: any) => {
      const started = Date.now(); state.ctx = ctx; const query = text(event?.prompt);
      state.gate = { active: false, retrieved: false, pointers: new Set<string>() };
      const finish = (decision: string, extra = {}) => log.info("prompt_retrieval_exit", { decision, elapsedMs: Date.now() - started, ...extra });
      log.info("prompt_retrieval_enter", { enabled: state.enabled, trusted: trusted(ctx), dirty: state.dirty, refreshing: Boolean(state.refresh), queryLength: query?.length ?? 0 });
      if (!trusted(ctx) || !state.enabled || !state.root || resolveWorktreeRoot(ctx.cwd) !== state.root) { finish("disabled_or_untrusted"); return; }
      consumeDirtySignals(); state.tokenSavings = Math.max(state.tokenSavings, readSavings(state.store)); setState(state.value);
      if (!["ready", "stale"].includes(state.value)) {
        const status = await graph(state.root);
        if (status === "fresh") setState("ready"); else if (status === "stale") setState("stale"); else { finish("graph_absent"); return; }
      }
      const guidance = forceUseGuidance(state.value === "stale");
      if (!query || !substantive(query)) { finish("guidance_only_control_prompt"); return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` }; }
      state.gate.active = true;
      let hits: Hit[] = [];
      try {
        if (options.retrieve) hits = (await withTimeout(options.retrieve(query, state.root), options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS)).pointers.map(pointer => ({ title: pointer, pointer }));
        else { const result = await withTimeout(run(["ask", query, ".", "--json", "-n", "3"], { cwd: state.root, timeoutMs: options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS }), options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS); if (result.code) { state.gate.active = false; finish("ask_failed", { diagnostic: diagnostic(result.stderr) }); return { systemPrompt: `${event.systemPrompt}\n\n${guidance}\n\n[graft] Retrieval failed: ${diagnostic(result.stderr)}. Raw navigation is available.` }; } const savings = savedTokens(result.stdout); addSavings(savings); setState(state.value); try { hits = relevant(JSON.parse(result.stdout.replace(/^\[graft\] tokens saved ≈ [\d,]+\s*$/gm, "").trim())); } catch { state.gate.active = false; finish("invalid_ask_json"); return { systemPrompt: `${event.systemPrompt}\n\n${guidance}\n\n[graft] Retrieval returned malformed output. Raw navigation is available.` }; } }
      } catch (error: any) { state.gate.active = false; finish("ask_error"); return { systemPrompt: `${event.systemPrompt}\n\n${guidance}\n\n[graft] Retrieval failed: ${text(error?.message, 240) ?? "unknown error"}. Raw navigation is available.` }; }
      if (!hits.length) { state.gate.active = false; finish("guidance_only_no_relevant_hits"); return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` }; }
      hits.forEach(hit => { const path = pointerPath(hit.pointer!); if (path) state.gate.pointers.add(path); });
      state.gate.retrieved = true; finish("injected", { hits: hits.length });
      return { systemPrompt: `${event.systemPrompt}\n\n${guidance}\n\n[graft] starting points for this task:\n${pointerText(hits)}` };
    });
    pi.on("agent_end", (_event: any, ctx: any) => { state.ctx = ctx; consumeDirtySignals(); const shouldRefresh = !child && trusted(ctx) && state.enabled && state.dirty && !state.refresh; log.info("agent_end", { dirty: state.dirty, refreshing: Boolean(state.refresh), shouldRefresh }); if (shouldRefresh) void refresh(); });
    pi.on("session_shutdown", () => { log.info("session_shutdown", { state: state.value, dirty: state.dirty, graftReads: state.graftReads, sourceReads: state.sourceReads, tokenSavings: state.tokenSavings }); clearSlot("graft", state.ctx); });
  };
  return { register };
}
export function registerGraft(pi: ExtensionAPI): void { createGraftIntegration({ enabled: true, setting: cwd => getSetting(cwd, "graft_enable") }).register(pi); }
