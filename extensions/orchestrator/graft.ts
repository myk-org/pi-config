/** Opt-in, local Graft graph integration. */
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
export type GraftState = "syncing" | "ready" | "stale" | "failed";
export type GraftRun = (args: readonly string[], options: { cwd: string }) => Promise<{ stdout: string; stderr: string; code: number }>;
type GraphStatus = "fresh" | "stale" | "absent";
type Options = { enabled: boolean; setting?: (cwd: string) => boolean; executable?: () => Promise<boolean>; graph?: (cwd: string) => Promise<GraphStatus>; retrieve?: (query: string, cwd: string) => Promise<{ pointers: string[] }>; run?: GraftRun };

export function formatGraftFooter({ state, nodeCount, tokenSavings }: { state: GraftState; nodeCount: number; tokenSavings: number }): string {
  return state === "failed" ? "graft: failed" : `graft: ${state} · ${nodeCount} nodes · ${tokenSavings} tokens saved`;
}
function text(value: unknown, max = 500): string | null { return typeof value === "string" && value.trim() && value.length <= max && !/[\0\r\n]/.test(value) ? value.trim() : null; }
function projectPath(root: string, value: unknown): string | null {
  const file = text(value);
  if (!file || isAbsolute(file)) return null;
  const absolute = resolve(root, file);
  if (relative(root, absolute).startsWith("..")) return null;
  try { const realRoot = realpathSync(root); const realFile = realpathSync(absolute); return realFile === realRoot || realFile.startsWith(realRoot + sep) ? file : null; } catch { return null; }
}
function nodes(root: string): number { try { const graph = JSON.parse(readFileSync(resolve(root, "graft/.graph/wiring.json"), "utf8")); return Number.isSafeInteger(graph?.meta?.nodeCount) ? graph.meta.nodeCount : 0; } catch { return 0; } }
function savedTokens(output: string): number { return [...output.matchAll(/\[graft\] tokens saved ≈ ([\d,]+)/g)].reduce((total, match) => total + Number(match[1].replaceAll(",", "")), 0); }
function trusted(ctx: any): boolean { return typeof ctx?.isProjectTrusted !== "function" || ctx.isProjectTrusted() === true; }
export function isEligibleGraftStartup(event: any, ctx: any): boolean { return event?.reason === "startup" && ctx?.mode !== "print" && ctx?.mode !== "json" && process.env.PI_SUBAGENT_CHILD !== "1" && !isPiOneshotInvocation(); }

export function createGraftIntegration(options: Options) {
  const state = { root: "", enabled: false, value: "stale" as GraftState, nodeCount: 0, tokenSavings: 0, dirty: false, refresh: undefined as Promise<boolean> | undefined, ctx: undefined as any };
  const setState = (value: GraftState) => { state.value = value; setSlot("graft", formatGraftFooter({ state: value, nodeCount: state.nodeCount, tokenSavings: state.tokenSavings }), state.ctx); };
  const run: GraftRun = options.run ?? (async (args, { cwd }) => {
    try {
      // Graft has no update-check opt-out. npm's supported offline mode makes its
      // detached `npm view` updater fail locally instead of opening a network connection.
      const result = await exec("graft", args as string[], { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, DO_NOT_TRACK: "1", npm_config_offline: "true" } });
      return { stdout: String(result.stdout).slice(0, MAX_BUFFER), stderr: String(result.stderr).slice(0, MAX_BUFFER), code: 0 };
    } catch (error: any) { log.warn("command_failed", { command: args[0], code: error?.code === "ENOENT" ? "missing" : "failed", timeout: Boolean(error?.killed) }); return { stdout: "", stderr: "", code: 1 }; }
  });
  const available = options.executable ?? (async () => { const result = await run(["--version"], { cwd: state.root }); log.debug("version_probe", { available: result.code === 0 }); return result.code === 0; });
  const graph = options.graph ?? (async cwd => (await run(["check", "--json"], { cwd })).code === 0 ? "fresh" : nodes(cwd) ? "stale" : "absent");
  const addSavings = (output: string) => { state.tokenSavings += savedTokens(output); };
  const refresh = async (): Promise<boolean> => {
    if (state.refresh) return state.refresh;
    setState("syncing"); state.refresh = (async () => { const result = await run(["build"], { cwd: state.root }); state.nodeCount = nodes(state.root); state.dirty = result.code !== 0; setState(result.code === 0 ? "ready" : "failed"); log.info("refresh", { ok: result.code === 0, nodes: state.nodeCount }); return result.code === 0; })().finally(() => { state.refresh = undefined; });
    return state.refresh;
  };
  const ensureFresh = async (): Promise<boolean> => {
    if (!state.enabled) return false;
    const check = await run(["check", "--json"], { cwd: state.root });
    if (check.code === 0) { state.dirty = false; return true; }
    state.dirty = true;
    return refresh();
  };
  const invoke = async (args: string[], fresh = false) => { if (!state.enabled) return "Graft is disabled for this project."; if (!fresh && args[0] !== "check" && args[0] !== "build" && !await ensureFresh()) return "Graft graph refresh failed."; const result = await run(args, { cwd: state.root }); if (result.code) { setState("failed"); return "Graft operation failed."; } state.nodeCount = nodes(state.root); addSavings(result.stdout); setState("ready"); return result.stdout.slice(0, MAX_BUFFER); };
  const pointers = async (query: string) => {
    if (options.retrieve) return (await options.retrieve(query, state.root)).pointers;
    const result = await invoke(["ask", "--no-refresh", "--limit", "8", query], true);
    return state.value === "ready" ? result.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 8) : [];
  };
  const register = (pi: ExtensionAPI) => {
    if (!options.enabled || process.env.PI_SUBAGENT_CHILD === "1") return;
    let toolsRegistered = false;
    const registerTools = () => {
      if (toolsRegistered) return;
      toolsRegistered = true;
      const tool = (name: string, description: string, parameters: any, args: (params: any) => string[] | null) => pi.registerTool({ name, label: name.replace("graft_", "Graft ").replace(/_/g, " "), description, parameters, async execute(_id, params) { const command = args(params); return { content: [{ type: "text" as const, text: command ? await invoke(command) : "Invalid input: use an existing project-relative path." }], details: {} }; } });
    tool("graft_find_code", "Find compact ranked code references in the local Graft graph.", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), path: Type.Optional(Type.String()) }), p => { const q = text(p.query), file = p.path === undefined ? undefined : projectPath(state.root, p.path); return q && (p.path === undefined || file) ? ["ask", "--no-refresh", "--limit", String(p.limit ?? 8), ...(file ? ["--in", file] : []), q] : null; });
    tool("graft_find_all", "Search indexed project files.", Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), fixed: Type.Optional(Type.Boolean()) }), p => { const pattern = text(p.pattern), file = p.path === undefined ? undefined : projectPath(state.root, p.path); return pattern && (p.path === undefined || file) ? ["grep", "--no-refresh", ...(p.fixed ? ["--fixed"] : []), ...(file ? ["--in", file] : []), pattern] : null; });
    tool("graft_file_api", "Get a signatures-only API view for a project file.", Type.Object({ path: Type.String() }), p => { const file = projectPath(state.root, p.path); return file ? ["skeleton", "--no-refresh", file] : null; });
    tool("graft_trace_calls", "Trace callers or callees of a symbol.", Type.Object({ symbol: Type.String(), direction: Type.Optional(Type.Union([Type.Literal("in"), Type.Literal("out")])), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), p => { const symbol = text(p.symbol); return symbol ? ["callers", "--no-refresh", "--direction", p.direction ?? "in", "--depth", String(p.depth ?? 1), symbol] : null; });
    tool("graft_repo_map", "Show a compact graph-based repository map.", Type.Object({ max_dirs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }), p => ["map", "--no-refresh", "--max-dirs", String(p.max_dirs ?? 16)]);
    tool("graft_check_freshness", "Check whether the local Graft graph is current.", Type.Object({}), () => ["check", "--json"]); tool("graft_refresh", "Rebuild the local Graft graph.", Type.Object({}), () => ["build"]); tool("graft_blast_radius", "Find dependencies affected by the local diff.", Type.Object({ depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), p => ["blast", "--no-refresh", "--depth", String(p.depth ?? 2)]);
    };
    pi.on("session_start", async (event: any, ctx: any) => { state.ctx = ctx; if (!trusted(ctx)) return; state.enabled = options.setting?.(ctx.cwd) ?? options.enabled; if (!state.enabled) return; registerTools(); state.root = resolveWorktreeRoot(ctx.cwd); state.nodeCount = nodes(state.root); if (!isEligibleGraftStartup(event, ctx)) return; if (!await available()) { log.warn("unavailable"); setState("failed"); return; } if (await graph(state.root) !== "fresh") await refresh(); else setState("ready"); });
    pi.on("tool_result", (event: any) => { if (state.enabled && (event.toolName === "write" || event.toolName === "edit") && !event.isError) { state.dirty = true; setState("stale"); log.debug("graph_dirty", { tool: event.toolName }); } });
    pi.on("before_agent_start", async (event: any, ctx: any) => { state.ctx = ctx; if (!trusted(ctx) || !state.enabled || !await ensureFresh()) return; if (state.value !== "ready" && !options.retrieve) return; const query = text(event?.prompt); if (!query) return; const refs = await pointers(query); if (refs.length) return { systemPrompt: `${event.systemPrompt}\n\nGraft references (verify before use):\n${refs.map(ref => `- ${ref}`).join("\n")}` }; });
    pi.on("before_provider_request", async (_event: any, ctx: any) => { state.ctx = ctx; if (trusted(ctx) && state.enabled) await ensureFresh(); });
    pi.on("session_shutdown", () => clearSlot("graft", state.ctx));
  };
  return { register };
}
export function registerGraft(pi: ExtensionAPI): void { createGraftIntegration({ enabled: true, setting: cwd => getSetting(cwd, "graft_enable") }).register(pi); }
