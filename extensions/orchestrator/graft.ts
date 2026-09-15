/** Opt-in, local Graft graph integration. */
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../shared/logger.js";
import { isPiOneshotInvocation } from "../shared/oneshot.js";
import { getSetting } from "./project-settings.js";
import { clearSlot, setSlot } from "./status-bar.js";
import { resolveWorktreeRoot } from "./utils.js";

const exec = promisify(execFile);
const log = createLogger("graft");
const TIMEOUT_MS = 45_000;
const MAX_BUFFER = 64 * 1024;
const MIN_PROMPT_CHARS = 12;
export type GraftState = "syncing" | "ready" | "stale" | "failed";
export type GraftRun = (args: readonly string[], options: { cwd: string }) => Promise<{ stdout: string; stderr: string; code: number }>;
type GraphStatus = "fresh" | "stale" | "absent";
type Options = { enabled: boolean; setting?: (cwd: string) => boolean; executable?: () => Promise<boolean>; graph?: (cwd: string) => Promise<GraphStatus>; retrieve?: (query: string, cwd: string) => Promise<{ pointers: string[] }>; run?: GraftRun };
type StatusTheme = { fg: (color: string, value: string) => string };
type Hit = { title?: string; pointer?: string; snippet?: string };
type Ask = { coverage?: number; coverageStrong?: number; hits?: Hit[] };

/** Graft's statusline shape, adapted to Pi's theme API. */
export function formatGraftFooter({ state, nodeCount, tokenSavings }: { state: GraftState; nodeCount: number; tokenSavings: number }, theme?: StatusTheme): string {
  const fg = (color: string, value: string) => theme?.fg(color, value) ?? value;
  const freshness = state === "syncing" ? fg("warning", "syncing…") : state === "stale" ? fg("warning", "⚠ stale") : state === "failed" ? fg("error", "failed") : fg("success", "✓ synced");
  const parts = [fg("dim", "◤ ") + fg("accent", "graft"), fg("dim", `${nodeCount} nodes`), freshness];
  if (tokenSavings > 0) parts.push(fg("accent", `~${tokenSavings.toLocaleString()} tok saved`));
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
function toolText(content: unknown): string { return Array.isArray(content) ? content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n") : ""; }
export function classifyToolUse(name: unknown, input: any): "graft" | "source" | null {
  const tool = typeof name === "string" ? name.toLowerCase() : "";
  if (tool.startsWith("graft_")) return "graft";
  if (["read", "grep", "find", "ls"].includes(tool)) return "source";
  if (["bash", "powershell"].includes(tool) && /(^|[|&;]\s*)(npx\s+(-y\s+)?(@nanonets\/)?\s*)?graft(-dev)?\b/i.test(String(input?.command ?? ""))) return "graft";
  return null;
}
function forceUseGuidance(): string { return "[graft] This trusted project has a ready local Graft graph. For code-relation work, use Graft before raw grep/read: graft_find_code for where/how, graft_trace_calls for callers/callees or blast radius, graft_file_api for a file API, graft_repo_map for orientation, and graft_find_all only when every occurrence is required. Use raw tools only to inspect a Graft result or when Graft has no answer."; }
function isCodePrompt(query: string): boolean { return /\b(code|file|function|class|implementation|implement|fix|bug|test|call(?:er|ee)?|trace|find|locate|search|where|refactor|component|api|module|handler|type)\b/i.test(query); }
function pointerPath(pointer: string): string | null { const match = /^(.+?):\d+(?::\d+)?$/.exec(pointer.trim()); return match?.[1] ?? null; }
function navigationTool(event: any): boolean {
  const tool = String(event?.toolName ?? event?.name ?? "").toLowerCase();
  if (["grep", "find", "glob", "search"].includes(tool)) return true;
  if (tool !== "bash" && tool !== "powershell") return false;
  return /(^|[|;&]\s*)(?:\S+=\S+\s+)*(?:rg|grep|find|ag|ack)\b/i.test(String(event?.input?.command ?? ""));
}
function graftGateReason(): string { return "[graft] Code navigation is blocked until Graft retrieval runs for this turn. Use graft_find_code (or graft_repo_map/graft_trace_calls), then inspect its returned file pointers. If Graft has no relevant result, retry the raw navigation."; }
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
  const state = { root: "", enabled: false, value: "stale" as GraftState, nodeCount: 0, tokenSavings: 0, graftReads: 0, sourceReads: 0, dirty: false, refresh: undefined as Promise<boolean> | undefined, ctx: undefined as any, injected: new Set<string>(), gate: { active: false, retrieved: false, pointers: new Set<string>() } };
  const setState = (value: GraftState) => { state.value = value; setSlot("graft", formatGraftFooter({ state: value, nodeCount: state.nodeCount, tokenSavings: state.tokenSavings }, state.ctx?.ui?.theme), state.ctx); };
  const rawRun: GraftRun = options.run ?? (async (args, { cwd }) => { try { const result = await exec("graft", args as string[], { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, DO_NOT_TRACK: "1", npm_config_offline: "true" } }); return { stdout: String(result.stdout).slice(0, MAX_BUFFER), stderr: String(result.stderr).slice(0, MAX_BUFFER), code: 0 }; } catch (error: any) { return { stdout: "", stderr: "", code: 1 }; } });
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
    if (state.refresh) { log.info("refresh_join", { dirty: state.dirty }); return state.refresh; }
    const started = Date.now();
    log.info("refresh_start", { root: state.root, dirty: state.dirty });
    setState("syncing");
    state.refresh = (async () => {
      const result = await run(["build"], { cwd: state.root });
      state.nodeCount = nodes(state.root); state.dirty = result.code !== 0;
      setState(result.code === 0 ? "ready" : "failed");
      log.info("refresh_end", { ok: result.code === 0, nodes: state.nodeCount, elapsedMs: Date.now() - started });
      return result.code === 0;
    })().finally(() => { state.refresh = undefined; });
    return state.refresh;
  };
  const markDirty = (source: string) => { if (state.dirty) { log.debug("graph_dirty_repeat", { source }); return; } state.dirty = true; setState("stale"); log.info("graph_dirty", { source }); };
  const invoke = async (args: string[]) => { log.info("tool_invoke", { command: args[0], enabled: state.enabled, dirty: state.dirty }); if (!state.enabled) return "Graft is disabled for this project."; const result = await run(args, { cwd: state.root }); if (result.code) { setState("failed"); return "Graft operation failed."; } state.nodeCount = nodes(state.root); state.tokenSavings += savedTokens(result.stdout); setState(state.dirty ? "stale" : "ready"); return result.stdout.slice(0, MAX_BUFFER); };
  const register = (pi: ExtensionAPI) => {
    if (!options.enabled || process.env.PI_SUBAGENT_CHILD === "1") return;
    let toolsRegistered = false;
    const registerTools = () => { if (toolsRegistered) return; toolsRegistered = true; const tool = (name: string, description: string, parameters: any, args: (params: any) => string[] | null) => pi.registerTool({ name, label: name.replace("graft_", "Graft ").replace(/_/g, " "), description, parameters, async execute(_id, params) { const command = args(params); return { content: [{ type: "text" as const, text: command ? await invoke(command) : "Invalid input: use an existing project-relative path." }], details: {} }; } });
      tool("graft_find_code", "Find compact ranked code references in the local Graft graph.", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), path: Type.Optional(Type.String()) }), p => { const q = text(p.query), file = p.path === undefined ? undefined : projectPath(state.root, p.path); return q && (p.path === undefined || file) ? ["ask", q, ".", "--limit", String(p.limit ?? 8), ...(file ? ["--in", file] : [])] : null; });
      tool("graft_find_all", "Search indexed project files.", Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), fixed: Type.Optional(Type.Boolean()) }), p => { const pattern = text(p.pattern), file = p.path === undefined ? undefined : projectPath(state.root, p.path); return pattern && (p.path === undefined || file) ? ["grep", ...(p.fixed ? ["--fixed"] : []), ...(file ? ["--in", file] : []), pattern] : null; });
      tool("graft_file_api", "Get a signatures-only API view for a project file.", Type.Object({ path: Type.String() }), p => { const file = projectPath(state.root, p.path); return file ? ["skeleton", file] : null; });
      tool("graft_trace_calls", "Trace callers or callees of a symbol.", Type.Object({ symbol: Type.String(), direction: Type.Optional(Type.Union([Type.Literal("in"), Type.Literal("out")])), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), p => { const symbol = text(p.symbol); return symbol ? ["callers", "--direction", p.direction ?? "in", "--depth", String(p.depth ?? 1), symbol] : null; });
      tool("graft_repo_map", "Show a compact graph-based repository map.", Type.Object({ max_dirs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }), p => ["map", "--max-dirs", String(p.max_dirs ?? 16)]); tool("graft_refresh", "Rebuild the local Graft graph.", Type.Object({}), () => ["build"]); tool("graft_blast_radius", "Find dependencies affected by the local diff.", Type.Object({ depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), p => ["blast", "--depth", String(p.depth ?? 2)]);
    };
    pi.on("session_start", async (event: any, ctx: any) => {
      state.ctx = ctx; log.info("session_start_enter", { reason: event?.reason, mode: ctx?.mode, trusted: trusted(ctx) });
      if (!trusted(ctx)) { log.info("session_start_exit", { decision: "untrusted" }); return; }
      state.enabled = options.setting?.(ctx.cwd) ?? options.enabled;
      if (!state.enabled) { log.info("session_start_exit", { decision: "disabled" }); return; }
      registerTools(); state.root = resolveWorktreeRoot(ctx.cwd); state.nodeCount = nodes(state.root);
      if (["reload", "resume"].includes(event?.reason)) { setState("ready"); log.info("session_start_exit", { decision: "restore", nodes: state.nodeCount }); return; }
      if (!isEligibleGraftStartup(event, ctx)) { log.info("session_start_exit", { decision: "ineligible" }); return; }
      if (!await available()) { setState("failed"); log.info("session_start_exit", { decision: "unavailable" }); return; }
      const status = await graph(state.root);
      if (status !== "fresh") await refresh(); else setState("ready");
      log.info("session_start_exit", { decision: status, nodes: state.nodeCount });
    });
    pi.on("tool_call", (event: any, ctx: any) => {
      const tool = String(event?.toolName ?? event?.name ?? "").toLowerCase();
      const allowedPointerRead = tool === "read" && typeof event?.input?.path === "string" && state.gate.pointers.has(event.input.path.replace(/^\.\//, ""));
      if (!state.enabled || state.value !== "ready" || !state.gate.active || state.gate.retrieved || allowedPointerRead || !(navigationTool(event) || tool === "read")) return;
      log.info("navigation_blocked", { tool: event.toolName });
      return { block: true, reason: graftGateReason() };
    });
    pi.on("tool_result", (event: any, ctx: any) => {
      state.ctx = ctx;
      const kind = !event.isError ? classifyToolUse(event.toolName, event.input) : null;
      const savings = !event.isError ? savedTokens(toolText(event.content)) : 0;
      if (kind === "graft") state.graftReads++; else if (kind === "source") state.sourceReads++;
      if (savings) state.tokenSavings += savings;
      if (kind || savings) { setState(state.dirty ? "stale" : "ready"); log.info("session_metric", { tool: event.toolName, kind, savings, graftReads: state.graftReads, sourceReads: state.sourceReads, tokenSavings: state.tokenSavings }); }
      const eligible = state.enabled && !event.isError && ["write", "edit"].includes(event.toolName);
      log.info("tool_result", { tool: event.toolName, eligible, kind, savings }); if (!eligible) return;
      markDirty(event.toolName); const hint = blastHint(state.root, event.input?.path);
      return hint ? { content: [...(event.content ?? []), { type: "text", text: hint }] } : undefined;
    });
    pi.on("before_agent_start", async (event: any, ctx: any) => {
      const started = Date.now(); state.ctx = ctx; const query = text(event?.prompt);
      state.gate = { active: false, retrieved: false, pointers: new Set<string>() };
      const finish = (decision: string, extra = {}) => log.info("prompt_retrieval_exit", { decision, elapsedMs: Date.now() - started, ...extra });
      log.info("prompt_retrieval_enter", { enabled: state.enabled, trusted: trusted(ctx), dirty: state.dirty, refreshing: Boolean(state.refresh), queryLength: query?.length ?? 0 });
      if (!trusted(ctx) || !state.enabled || state.value !== "ready") { finish("disabled_untrusted_or_unavailable"); return; }
      const guidance = forceUseGuidance();
      if (!query || query.length < MIN_PROMPT_CHARS || !isCodePrompt(query)) { finish("guidance_only_non_code_prompt"); return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` }; }
      // A just-edited graph is rebuilt from agent_end. Never make the next user message wait for ask's implicit refresh.
      if (state.dirty || state.refresh) { finish("guidance_only_refresh_pending"); return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` }; }
      state.gate.active = true;
      let hits: Hit[] = [];
      if (options.retrieve) hits = (await options.retrieve(query, state.root)).pointers.map(pointer => ({ title: pointer, pointer }));
      else { const result = await run(["ask", query, ".", "--json", "-n", "3"], { cwd: state.root }); if (result.code) { finish("ask_failed"); return; } try { hits = relevant(JSON.parse(result.stdout)); } catch { finish("invalid_ask_json"); return; } }
      hits = hits.filter(hit => hit.pointer && !state.injected.has(hit.pointer));
      if (!hits.length) { state.gate.active = false; finish("guidance_only_no_new_relevant_hits"); return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` }; }
      hits.forEach(hit => { state.injected.add(hit.pointer!); const path = pointerPath(hit.pointer!); if (path) state.gate.pointers.add(path); });
      state.gate.retrieved = true; finish("injected", { hits: hits.length });
      return { systemPrompt: `${event.systemPrompt}\n\n${guidance}\n\n[graft] starting points for this task:\n${pointerText(hits)}` };
    });
    pi.on("agent_end", (_event: any, ctx: any) => { state.ctx = ctx; const shouldRefresh = trusted(ctx) && state.enabled && state.dirty && !state.refresh; log.info("agent_end", { dirty: state.dirty, refreshing: Boolean(state.refresh), shouldRefresh }); if (shouldRefresh) void refresh(); });
    pi.on("session_shutdown", () => { log.info("session_shutdown", { state: state.value, dirty: state.dirty, graftReads: state.graftReads, sourceReads: state.sourceReads, tokenSavings: state.tokenSavings }); clearSlot("graft", state.ctx); });
  };
  return { register };
}
export function registerGraft(pi: ExtensionAPI): void { createGraftIntegration({ enabled: true, setting: cwd => getSetting(cwd, "graft_enable") }).register(pi); }
