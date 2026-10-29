/** Trail integration contract for #978. Run: npx tsx --test tests/node/orchestrator/trail.test.ts */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as trail from "../../../extensions/orchestrator/trail.js";
import { getPiLogPath, setGlobalSessionId } from "../../../extensions/shared/file-logger.js";

type TrailRun = (args: readonly string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string; code: number }>;
type Handler = (event: any, ctx: any) => Promise<any> | any;
type Tool = { name: string; execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
/**
 * Silent logger for every integration under test: these suites drive fake ctx
 * and session ids, so the real trail logger would write fake telemetry into
 * ~/.pi/logs/trail — the source of the #978 G1-G3 measurements.
 */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, isDebugEnabled: () => false };
/** Records debug entries so tests can assert the retrieval budget and parsed savings. */
function capturingLogger() {
  const entries: Array<{ message: string; data: any }> = [];
  const logger = { debug(message: string, data: any) { entries.push({ message, data }); }, info() {}, warn() {}, error() {}, isDebugEnabled: () => true };
  const entriesFor = (message: string) => entries.filter(entry => entry.message === message);
  return { logger, entriesFor };
}

function mockPi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const emitted: Array<{ event: string; data: any }> = [];
  return { pi: { events: { emit(event: string, data: any) { emitted.push({ event, data }); } }, on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, registerTool(tool: Tool) { tools.set(tool.name, tool); } }, handlers, tools, emitted };
}
function runner(results: Array<{ stdout?: string; stderr?: string; code?: number }> = []) {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const run: TrailRun = async (args, { cwd }) => { calls.push({ args, cwd }); const next = results.shift() ?? {}; return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", code: next.code ?? 0 }; };
  return { run, calls };
}
/** Prompt event carrying the mutable structured prompt options Pi exposes. */
function promptEvent(prompt: string, options: Record<string, any> = {}) {
  return { messageType: "user", prompt, systemPrompt: "base", systemPromptOptions: { selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [], cwd: "/repo", ...options } };
}
/** Temp repo root with an on-disk code map (map presence is a filesystem check now). */
function mapRoot(nodes: Array<{ id: string; name: string; path: string }>, nodeCount = nodes.length) {
  const root = mkdtempSync(join(tmpdir(), "trail-map-"));
  mkdirSync(join(root, "graft/.graph"), { recursive: true });
  writeFileSync(join(root, "graft/.graph/wiring.json"), JSON.stringify({ meta: { nodeCount }, nodes, edges: [] }));
  return root;
}
const defaultRoot = mkdtempSync(join(tmpdir(), "trail-default-"));
let defaultSession = 0;
function ctx(cwd = defaultRoot, trusted = true, sessionId = `session-${++defaultSession}`) {
  const status: Array<{ key: string; text: string | undefined }> = [];
  return { cwd, status, sessionManager: { getSessionId: () => sessionId }, isProjectTrusted: () => trusted, ui: { setStatus: (key: string, text: string | undefined) => status.push({ key, text }) } };
}
const originalArgv = process.argv.slice();
const originalChild = process.env.PI_SUBAGENT_CHILD;
const originalParentSession = process.env.__PI_PARENT_SESSION_ID;
beforeEach(() => { delete process.env.PI_SUBAGENT_CHILD; delete process.env.__PI_PARENT_SESSION_ID; });
afterEach(() => {
  process.argv = originalArgv.slice();
  if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = originalChild;
  if (originalParentSession === undefined) delete process.env.__PI_PARENT_SESSION_ID; else process.env.__PI_PARENT_SESSION_ID = originalParentSession;
});
function register(opts: any = {}) {
  const mock = mockPi(); const command = runner(opts.results);
  // worktree defaults to a real-looking root so the fake cwd is treated as a
  // git worktree; pass worktree: () => null to exercise the non-repo path.
  trail.createTrailIntegration({ enabled: true, executable: async () => true, worktree: () => "/repo", run: command.run, logger: silentLogger, ...opts }).register(mock.pi as any);
  return { ...mock, ...command };
}
async function start(r: ReturnType<typeof register>, c = ctx()) { await r.handlers.get("session_start")![0]({ reason: "startup" }, c); return c; }

describe("Trail enablement, trust, and startup", () => {
  it("is inert when disabled", () => { const r = register({ enabled: false }); assert.equal(r.handlers.size, 0); assert.equal(r.tools.size, 0); });
  it("registers tools only for trusted projects that enable Trail", async () => {
    const disabled = register({ setting: () => false }); await start(disabled); assert.equal(disabled.tools.size, 0);
    const enabled = register({ setting: () => true }); await start(enabled); assert.ok(enabled.tools.size > 0);
    const untrusted = register({ setting: () => true }); await start(untrusted, ctx("/untrusted/project", false)); assert.equal(untrusted.tools.size, 0); assert.equal(untrusted.calls.length, 0);
  });
  for (const transition of ["untrusted", "disabled"] as const) it(`invalidates tools and status on a ${transition} session transition`, async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-transition-"));
    try {
      let enabled = true;
      const r = register({ setting: () => enabled }); await start(r, ctx(root));
      assert.ok(r.tools.size > 0);
      enabled = transition !== "disabled";
      const nextCtx = ctx(join(root, "next"), transition !== "untrusted");
      await r.handlers.get("session_start")![0]({ reason: "new" }, nextCtx);
      const result = await r.tools.get("trail_repo_map")!.execute("id", {}, undefined, undefined, nextCtx);
      assert.match(result.content[0].text, /disabled|untrusted/i);
      assert.equal(r.calls.length, 0);
      assert.deepEqual(nextCtx.status.at(-1), { key: "4b-trail", text: undefined });
      assert.deepEqual(r.emitted.filter(item => item.event === "pidash:trail-savings").at(-1)?.data, { tokenSavings: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("takes state from map presence and never builds or probes freshness", async () => {
    const root = mapRoot([{ id: "a", name: "a", path: "src/a.ts" }], 7);
    try {
      const r = register(); const c = await start(r, ctx(root));
      assert.deepEqual(r.calls, [], "map presence is a filesystem check, never a CLI probe");
      assert.deepEqual(c.status.at(-1), { key: "4b-trail", text: "◤ trail · 7 nodes · ✓ synced" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("reports a repo with no map as absent without cold-building it", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-nomap-"));
    try {
      const r = register(); const c = await start(r, ctx(root));
      assert.deepEqual(r.calls, [], "a repo without a map is never cold-built at session start");
      assert.deepEqual(c.status.at(-1), { key: "4b-trail", text: "◤ trail · n/a" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("probes the trail binary before exposing tools and stops when unavailable", async () => {
    const mock = mockPi(); const command = runner([{ code: 1 }]);
    trail.createTrailIntegration({ enabled: true, worktree: () => "/repo", run: command.run, logger: silentLogger }).register(mock.pi as any);
    const c = ctx(); await mock.handlers.get("session_start")![0]({ reason: "startup" }, c);
    assert.deepEqual(command.calls.map(call => call.args), [["--version"]]);
    assert.deepEqual(c.status.at(-1), { key: "4b-trail", text: "◤ trail · 0 nodes · failed" });
    assert.equal(mock.tools.size, 0, "no map tools without the binary");
  });
  it("keeps child processes consumer-only while registering query tools and retrieval", async () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    const child = register({ graph: async () => "fresh", retrieve: async () => ({ pointers: ["src/a.ts:1"] }) });
    await start(child);
    assert.ok(child.tools.has("trail_find_code"));
    assert.equal(child.tools.has("trail_refresh"), false);
    assert.equal(child.tools.has("trail_blast_radius"), false);
    assert.equal(child.calls.length, 0);
    const event = promptEvent("Explain how authentication sessions are validated");
    await child.handlers.get("before_agent_start")![0](event, ctx());
    assert.match(event.systemPromptOptions.sections.trail, /trail/i);
  });
  it("registers the map tools for a print-mode oneshot without probing the binary", async () => {
    const argv = process.argv.slice();
    let print: ReturnType<typeof register>;
    let c: ReturnType<typeof ctx>;
    try {
      process.argv = [process.execPath, "pi", "-p", "prompt"];
      print = register();
      c = await start(print);
      assert.deepEqual(print.calls, [], "no probe and no build in a one-shot run");
      assert.ok(print.tools.has("trail_find_code"), "a print-mode session still gets the map tools");
      assert.ok(print.tools.has("trail_repo_map"));
      // ...and per-prompt retrieval/gating still works.
      assert.equal(await print.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c), undefined);
    } finally {
      // Print mode is read from process-global argv: leaving it set would run
      // every later test in this process in print mode.
      process.argv = argv;
    }
    assert.deepEqual(process.argv, argv, "the test restores process.argv");
  });
  it("resolves .trail/cache before a legacy graft/ map", async () => {
    const root = mapRoot([{ id: "a", name: "a", path: "src/a.ts" }], 3);
    try {
      assert.equal(trail.trailMapDir(root, silentLogger), join(root, "graft"));
      mkdirSync(join(root, ".trail/cache/.graph"), { recursive: true });
      writeFileSync(join(root, ".trail/cache/.graph/wiring.json"), JSON.stringify({ meta: { nodeCount: 5 }, nodes: [] }));
      assert.equal(trail.trailMapDir(root, silentLogger), join(root, ".trail/cache"));
      assert.equal(trail.trailNodes(root, silentLogger), 5);
      const empty = mkdtempSync(join(tmpdir(), "trail-empty-"));
      assert.equal(trail.trailMapDir(empty, silentLogger), null);
      rmSync(empty, { recursive: true, force: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("seeds a map-less worktree with a query instead of a build", async () => {
    const main = mapRoot([{ id: "a", name: "a", path: "src/auth.ts" }]);
    const worktree = mkdtempSync(join(tmpdir(), "trail-wt-"));
    try {
      mkdirSync(join(main, ".git/worktrees/wt"), { recursive: true });
      writeFileSync(join(main, ".git/worktrees/wt/commondir"), "../..\n");
      writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git/worktrees/wt")}\n`);
      const r = register({ results: [{ stdout: JSON.stringify({ hits: [{ title: "authenticate", pointer: "src/auth.ts:12" }] }) }] });
      const c = await start(r, ctx(worktree));
      assert.deepEqual(c.status.at(-1), { key: "4b-trail", text: "◤ trail · n/a" });
      const event = promptEvent("locate the authentication implementation");
      await r.handlers.get("before_agent_start")![0](event, c);
      assert.deepEqual(r.calls.map(call => call.args), [["ask", "locate the authentication implementation", ".", "--json", "-n", "3", "--source"]]);
      assert.match(event.systemPromptOptions.sections.trail, /src\/auth\.ts:12/);
    } finally { rmSync(worktree, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
  });
  for (const reason of ["reload", "resume", "new", "fork"]) it(`restores a ready map on ${reason}`, async () => {
    const root = mapRoot([{ id: "a", name: "a", path: "src/a.ts" }], 9);
    try {
      const r = register(); const c = ctx(root);
      await r.handlers.get("session_start")![0]({ reason }, c);
      assert.deepEqual(c.status.at(-1), { key: "4b-trail", text: "◤ trail · 9 nodes · ✓ synced" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Trail retrieval, injection, and the gate", () => {
  const askOutput = JSON.stringify({ coverage: 0.9, hits: [{ title: "authenticate", pointer: "src/auth.ts:12", snippet: "validates sessions", code: "export function authenticate() {}" }] });
  it("injects durable guidelines plus this turn's hits into the structured prompt", async () => {
    const r = register({ graph: async () => "fresh", results: [{ stdout: askOutput }] }); const c = await start(r);
    const event = promptEvent("where is authentication handled?");
    const result = await r.handlers.get("before_agent_start")![0](event, c);
    assert.equal(result, undefined, "the system prompt is never replaced");
    assert.deepEqual(r.calls[0].args, ["ask", "where is authentication handled?", ".", "--json", "-n", "3", "--source"]);
    assert.match(event.systemPromptOptions.promptGuidelines.join("\n"), /trail_find_code/);
    assert.match(event.systemPromptOptions.toolGuidelines.trail_find_code.join("\n"), /search concepts, not identifiers/i);
    assert.match(event.systemPromptOptions.sections.trail, /authenticate: src\/auth\.ts:12/);
    assert.match(event.systemPromptOptions.sections.trail, /export function authenticate/, "source is inlined by --source");
  });
  it("injects only the durable guidance for control prompts", async () => {
    const r = register({ graph: async () => "fresh" }); const c = await start(r);
    const event = promptEvent("yes");
    await r.handlers.get("before_agent_start")![0](event, c);
    assert.equal(r.calls.length, 0);
    assert.match(event.systemPromptOptions.promptGuidelines.join("\n"), /trail_find_code/);
    assert.equal(event.systemPromptOptions.sections.trail, undefined);
  });
  it("does not let automatic retrieval satisfy the gate", async () => {
    const root = mapRoot([{ id: "a", name: "a", path: "src/auth.ts" }, { id: "b", name: "b", path: "src/other.ts" }]);
    try {
      const r = register({ results: [{ stdout: askOutput }, { stdout: "grr" }] }); const c = await start(r, ctx(root));
      const event = promptEvent("locate the authentication implementation");
      await r.handlers.get("before_agent_start")![0](event, c);
      assert.match((await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c))?.reason ?? "", /trail_find_code/i);
      assert.match((await r.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "src/other.ts" } }, c))?.reason ?? "", /trail_find_code/i);
      // a trail tool result is what releases the gate
      r.handlers.get("tool_result")![0]({ toolName: "trail_find_code", input: {}, content: [{ type: "text", text: "hit" }], isError: false }, c);
      assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "src/other.ts" } }, c), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("allows an injected pointer read and never blocks unindexed paths", async () => {
    const root = mapRoot([{ id: "a", name: "a", path: "src/auth.ts" }]);
    try {
      const r = register({ results: [{ stdout: askOutput }] }); const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "src/auth.ts" } }, c), undefined);
      assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "package.json" } }, c), undefined);
      assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "git status --short" } }, c), undefined);
      assert.equal((await r.handlers.get("tool_call")![0]({ toolName: "grep", input: { pattern: "auth" } }, c))?.block, true);
      assert.equal((await r.handlers.get("tool_call")![0]({ toolName: "glob", input: { pattern: "**/*.ts" } }, c))?.block, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("parses an answer preceded by a refresh note and unlocks file-level pointers", async () => {
    const root = mapRoot([{ id: "a", name: "a", path: "src/auth.ts" }]);
    try {
      const output = `[trail] refreshed the graph (6 files changed) before answering\n${JSON.stringify({ hits: [{ title: "auth · file", pointer: "src/auth.ts" }] })}`;
      const r = register({ results: [{ stdout: output }] }); const c = await start(r, ctx(root));
      const event = promptEvent("locate the authentication implementation");
      await r.handlers.get("before_agent_start")![0](event, c);
      assert.match(event.systemPromptOptions.sections.trail, /auth · file: src\/auth\.ts/);
      assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "src/auth.ts" } }, c), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("does not gate navigation when the map is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-nogate-"));
    try {
      const r = register(); const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      assert.deepEqual(r.calls.map(call => call.args), [["build"]], "a mapless checkout builds once in the background, never retrieves");
      assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c), undefined);
      assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "src/a.ts" } }, c), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("fails automatic retrieval open at the interactive deadline", async () => {
    const r = register({ graph: async () => "fresh", retrieve: async () => new Promise(() => {}), interactiveTimeoutMs: 20 }); const c = await start(r);
    const started = Date.now();
    const event = promptEvent("locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](event, c);
    // Wall-clock bound is deliberately loose: the semantic assertion is the
    // `timed out` note below, and a 250 ms ceiling flaked under full-suite load.
    assert.ok(Date.now() - started < 5_000);
    assert.match(event.systemPromptOptions.sections.trail, /timed out/i);
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c), undefined);
  });
  // No `interactiveTimeoutMs` here on purpose: it overrides every budget, so the
  // cold ceiling and the warm 2s default are what these tests exercise.
  const slowRetrieve = () => async () => { await new Promise(resolve => setTimeout(resolve, 40)); return { pointers: ["src/a.ts:1"] }; };
  const budgets = (capture: ReturnType<typeof capturingLogger>) => capture.entriesFor("retrieval_budget").map(entry => [entry.data.cold, entry.data.budgetMs]);
  it("gives the first retrieval of a session the cold budget", async () => {
    const capture = capturingLogger();
    const r = register({ graph: async () => "fresh", coldTimeoutMs: 20, retrieve: slowRetrieve(), logger: capture.logger }); const c = await start(r);
    const event = promptEvent("locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](event, c);
    assert.match(event.systemPromptOptions.sections.trail, /timed out/i);
    assert.deepEqual(budgets(capture), [[true, 20]]);
  });
  it("keeps the cold budget after a failed first retrieval", async () => {
    const capture = capturingLogger();
    const r = register({ graph: async () => "fresh", coldTimeoutMs: 20, retrieve: slowRetrieve(), logger: capture.logger }); const c = await start(r);
    const first = promptEvent("locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](first, c);
    const second = promptEvent("locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](second, c);
    assert.match(first.systemPromptOptions.sections.trail, /timed out/i);
    assert.match(second.systemPromptOptions.sections.trail, /timed out/i);
    assert.deepEqual(budgets(capture), [[true, 20], [true, 20]]);
  });
  it("switches to the warm ceiling after a retrieval succeeds", async () => {
    const capture = capturingLogger();
    const r = register({ graph: async () => "fresh", coldTimeoutMs: 1_000, retrieve: async () => ({ pointers: ["src/a.ts:1"] }), logger: capture.logger }); const c = await start(r);
    const cold = promptEvent("locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](cold, c);
    assert.match(cold.systemPromptOptions.sections.trail, /src\/a\.ts:1/);
    await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
    assert.deepEqual(budgets(capture), [[true, 1_000], [false, 2_000]]);
  });
  it("re-arms the cold budget for a new session", async () => {
    const capture = capturingLogger();
    const r = register({ graph: async () => "fresh", coldTimeoutMs: 20, retrieve: slowRetrieve(), logger: capture.logger }); const first = await start(r);
    const coldFirst = promptEvent("locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](coldFirst, first);
    assert.match(coldFirst.systemPromptOptions.sections.trail, /timed out/i);
    const warm = promptEvent("locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](warm, first);
    const attempts = capture.entriesFor("retrieval_budget").map(entry => entry.data.attempt);
    assert.deepEqual(attempts, [1, 2], "a failed retrieval keeps the session on the cold path");
    const next = ctx(); await r.handlers.get("session_start")![0]({ reason: "new" }, next);
    const cold = promptEvent("locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](cold, next);
    assert.match(cold.systemPromptOptions.sections.trail, /timed out/i);
    assert.deepEqual(capture.entriesFor("retrieval_budget").at(-1)?.data, { cold: true, budgetMs: 20, attempt: 1 }, "a new session re-arms the cold ceiling");
  });
  it("logs the parsed token savings figure", async () => {
    const capture = capturingLogger();
    const r = register({ graph: async () => "fresh", logger: capture.logger }); const c = await start(r);
    r.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: [{ type: "text", text: "[trail] tokens saved ≈ 700" }], isError: false }, c);
    assert.deepEqual(capture.entriesFor("saved_tokens").map(entry => entry.data), [{ matches: 1, total: 700 }]);
  });
  it("directs the model to trail_find_code when retrieval fails", async () => {
    const r = register({ graph: async () => "fresh", results: [{ code: 1, stderr: "boom" }] }); const c = await start(r);
    const event = promptEvent("locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](event, c);
    assert.match(event.systemPromptOptions.sections.trail, /trail_find_code/);
    assert.match(event.systemPromptOptions.sections.trail, /Retrieval failed: boom/);
  });
  it("keeps low-coverage hits instead of dropping them", async () => {
    const r = register({ graph: async () => "fresh", results: [{ stdout: JSON.stringify({ coverage: 0.01, coverageStrong: 0, hits: [{ title: "noise", pointer: "src/noise.ts:1" }] }) }] }); const c = await start(r);
    const event = promptEvent("please locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](event, c);
    assert.match(event.systemPromptOptions.sections.trail, /noise: src\/noise\.ts:1/);
  });
  it("shows the repo map once per session then redirects to find_code", async () => {
    const r = register({ graph: async () => "fresh", results: [{ stdout: "map ok" }, { stdout: "map ok" }] }); const c = await start(r);
    const first = await r.tools.get("trail_repo_map")!.execute("one", {}, undefined, undefined, c);
    assert.equal(first.content[0].text, "map ok");
    const second = await r.tools.get("trail_repo_map")!.execute("two", {}, undefined, undefined, c);
    assert.match(second.content[0].text, /trail_find_code/);
    assert.deepEqual(r.calls.map(call => call.args), [["map", "--max-dirs", "16"]]);
    const next = ctx(c.cwd);
    await r.handlers.get("session_start")![0]({ reason: "new" }, next);
    assert.equal((await r.tools.get("trail_repo_map")!.execute("three", {}, undefined, undefined, next)).content[0].text, "map ok");
  });
  it("injects a retrieval failure note without replacing the prompt", async () => {
    const r = register({ graph: async () => "fresh", results: [{ code: 1, stderr: "boom\nsecret second line" }] }); const c = await start(r);
    const event = promptEvent("locate the authentication implementation");
    await r.handlers.get("before_agent_start")![0](event, c);
    assert.match(event.systemPromptOptions.sections.trail, /Retrieval failed: boom/);
    assert.doesNotMatch(JSON.stringify(event.systemPromptOptions), /secret second line/);
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c), undefined);
  });
  it("discards CLI retrieval savings from a replaced session", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const output = `${JSON.stringify({ coverage: .9, hits: [{ title: "old", pointer: "src/old.ts:1" }] })}\n[trail] tokens saved ≈ 450`;
    const r = register({ graph: async () => "fresh", run: async (args: readonly string[], { cwd }: { cwd: string }) => {
      r.calls.push({ args, cwd });
      if (args[0] === "ask") await pending;
      return { stdout: args[0] === "ask" ? output : "", stderr: "", code: 0 };
    }, interactiveTimeoutMs: 1_000 });
    const oldCtx = await start(r, ctx(defaultRoot, true, "old-retrieval"));
    const retrieval = r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), oldCtx);
    await new Promise(resolve => setImmediate(resolve));
    const nextCtx = ctx(defaultRoot, true, "new-retrieval");
    await r.handlers.get("session_start")![0]({ reason: "new" }, nextCtx);
    const published = r.emitted.filter(item => item.event === "pidash:trail-savings").length;
    release();
    assert.equal(await retrieval, undefined);
    assert.equal(r.emitted.filter(item => item.event === "pidash:trail-savings").length, published);
    assert.doesNotMatch(nextCtx.status.at(-1)?.text ?? "", /tok saved/);
  });
  it("does not install a filesystem watcher or run a process for control prompts", async () => {
    let watches = 0;
    const r = register({ graph: async () => "fresh", watch: () => { watches++; return () => {}; } }); const c = await start(r);
    const event = promptEvent("hello");
    await r.handlers.get("before_agent_start")![0](event, c);
    assert.equal(watches, 0);
    assert.equal(r.calls.length, 0);
    assert.match(event.systemPromptOptions.promptGuidelines.join("\n"), /trail/i);
  });
});

describe("Trail savings accounting", () => {
  const savings = (text: string) => [{ type: "text", text }];
  it("accounts for each Trail tool footer exactly once in tool_result", async () => {
    const r = register({ graph: async () => "fresh", results: [{ stdout: "map\n[trail] tokens saved ≈ 100" }] });
    const c = await start(r); const result = await r.tools.get("trail_repo_map")!.execute("one", {}, undefined, undefined, c);
    assert.doesNotMatch(c.status.at(-1)?.text ?? "", /tok saved/);
    r.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: result.content, isError: false }, c);
    assert.match(c.status.at(-1)?.text ?? "", /~100 tok saved/);
  });
  it("accepts the CLI savings footer and ignores an absent figure", async () => {
    const r = register({ graph: async () => "fresh" }); const c = await start(r);
    r.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("[trail] tokens saved ≈ 700"), isError: false }, c);
    r.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("no figure"), isError: false }, c);
    assert.match(c.status.at(-1)?.text ?? "", /~700 tok saved/);
  });
  it("publishes the exact authoritative parent aggregate", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-publish-"));
    try {
      const r = register({ graph: async () => "fresh" }); const c = await start(r, ctx(root));
      r.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("[trail] tokens saved ≈ 1,098,359"), isError: false }, c);
      assert.deepEqual(r.emitted.filter(item => item.event === "pidash:trail-savings").at(-1)?.data, { tokenSavings: 1_098_359 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("aggregates a parent and two child processes into the parent status", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-family-"));
    try {
      const parent = register({ graph: async () => "fresh" }); const parentCtx = await start(parent, ctx(root, true, "parent-session"));
      for (const [id, amount] of [["child-one", 200], ["child-two", 300]] as const) {
        process.env.PI_SUBAGENT_CHILD = "1"; process.env.__PI_PARENT_SESSION_ID = "parent-session";
        const child = register({ graph: async () => "fresh" }); const childCtx = await start(child, ctx(root, true, id));
        child.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings(`[trail] tokens saved ≈ ${amount}`), isError: false }, childCtx);
      }
      delete process.env.PI_SUBAGENT_CHILD; delete process.env.__PI_PARENT_SESSION_ID;
      await parent.handlers.get("before_agent_start")![0](promptEvent("yes"), parentCtx);
      assert.match(parentCtx.status.at(-1)?.text ?? "", /~500 tok saved/);
      const stores = readdirSync(join(root, ".pi/tmp"));
      assert.equal(stores.filter(name => name.startsWith("trail-savings-") && name.endsWith(".json")).length, 1);
      assert.equal(stores.some(name => name.includes(".events")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("treats an unreadable savings lock as contended", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-partial-lock-"));
    try {
      const seeded = register({ graph: async () => "fresh" }); const c = await start(seeded, ctx(root, true, "partial-lock"));
      const store = join(root, ".pi/tmp", readdirSync(join(root, ".pi/tmp")).find(name => name.endsWith(".dirty"))!.replace(/\.dirty$/, ""));
      writeFileSync(`${store}.lock`, "{", { mode: 0o600 });
      seeded.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("[trail] tokens saved ≈ 100"), isError: false }, c);
      assert.equal(readFileSync(`${store}.lock`, "utf8"), "{");
      assert.equal(existsSync(store), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("releases its savings lock after a persist failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-failed-save-"));
    try {
      const r = register({ graph: async () => "fresh" }); const c = await start(r, ctx(root, true, "failed-save"));
      const store = join(root, ".pi/tmp", readdirSync(join(root, ".pi/tmp")).find(name => name.endsWith(".dirty"))!.replace(/\.dirty$/, ""));
      mkdirSync(store);
      r.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("[trail] tokens saved ≈ 100"), isError: false }, c);
      assert.equal(existsSync(`${store}.lock`), false);
      assert.equal(readdirSync(join(root, ".pi/tmp")).some(name => name.endsWith(".tmp")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("does not lose deltas from independently initialized writers", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-race-"));
    try {
      const writers = [register({ graph: async () => "fresh" }), register({ graph: async () => "fresh" }), register({ graph: async () => "fresh" })];
      await Promise.all(writers.map((writer, index) => start(writer, ctx(root, true, `writer-${index}`))));
      process.env.__PI_PARENT_SESSION_ID = "shared-parent";
      const children = writers.map((_, index) => { process.env.PI_SUBAGENT_CHILD = "1"; const child = register({ graph: async () => "fresh" }); return { child, context: ctx(root, true, `child-${index}`) }; });
      await Promise.all(children.map(({ child, context }) => start(child, context)));
      children.forEach(({ child, context }, index) => child.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings(`[trail] tokens saved ≈ ${(index + 1) * 100}`), isError: false }, context));
      delete process.env.PI_SUBAGENT_CHILD; delete process.env.__PI_PARENT_SESSION_ID;
      const main = register({ graph: async () => "fresh" }); const mainCtx = await start(main, ctx(root, true, "shared-parent"));
      assert.match(mainCtx.status.at(-1)?.text ?? "", /~600 tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("persists canonical savings emitted by automatic prompt retrieval", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-prompt-"));
    try {
      const output = `${JSON.stringify({ coverage: .9, hits: [{ title: "answer", pointer: "src/a.ts:1" }] })}\n[trail] tokens saved ≈ 450`;
      const r = register({ graph: async () => "fresh", results: [{ stdout: output }] }); const c = await start(r, ctx(root, true, "prompt-session"));
      await r.handlers.get("before_agent_start")![0](promptEvent("Explain this implementation in detail"), c);
      const restored = register({ graph: async () => "fresh" }); const restoredCtx = ctx(root, true, "prompt-session"); await restored.handlers.get("session_start")![0]({ reason: "reload" }, restoredCtx);
      assert.match(restoredCtx.status.at(-1)?.text ?? "", /~450 tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const reason of ["reload", "resume"]) it(`restores session savings before rendering on ${reason}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-session-"));
    try {
      const first = register({ graph: async () => "fresh" }); const firstCtx = await start(first, ctx(root, true, "saved-session"));
      first.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("map\n[trail] tokens saved ≈ 700"), isError: false }, firstCtx);
      const restored = register({ graph: async () => "fresh" }); const restoredCtx = ctx(root, true, "saved-session");
      await restored.handlers.get("session_start")![0]({ reason }, restoredCtx);
      assert.match(restoredCtx.status[0]?.text ?? "", /~700 tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("isolates new sessions and stores a hashed ID with private modes", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-session-"));
    try {
      const first = register({ graph: async () => "fresh" }); const firstCtx = await start(first, ctx(root, true, "secret-session-id"));
      first.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("map\n[trail] tokens saved ≈ 400"), isError: false }, firstCtx);
      const dir = join(root, ".pi/tmp"); const files = readdirSync(dir).filter(file => file.startsWith("trail-savings-") && file.endsWith(".json"));
      assert.equal(files.length, 1); assert.doesNotMatch(files[0], /secret-session-id/);
      assert.equal(statSync(dir).mode & 0o777, 0o700); assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
      assert.equal(readdirSync(dir).some(file => file.includes(".events")), false);
      const fresh = register({ graph: async () => "fresh" }); const freshCtx = ctx(root, true, "new-session"); await fresh.handlers.get("session_start")![0]({ reason: "startup" }, freshCtx);
      assert.doesNotMatch(freshCtx.status.at(-1)?.text ?? "", /tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("falls back safely for a corrupt session store", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-session-"));
    try {
      const seeded = register({ graph: async () => "fresh" }); const seededCtx = await start(seeded, ctx(root));
      seeded.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("[trail] tokens saved ≈ 100"), isError: false }, seededCtx);
      const store = join(root, ".pi/tmp", readdirSync(join(root, ".pi/tmp")).find(name => name.endsWith(".json"))!);
      writeFileSync(store, "{broken", { mode: 0o600 });
      const restored = register({ graph: async () => "fresh" }); const restoredCtx = ctx(root); await restored.handlers.get("session_start")![0]({ reason: "reload" }, restoredCtx);
      assert.doesNotMatch(restoredCtx.status.at(-1)?.text ?? "", /tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("accumulates and persists savings after restoration", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-session-"));
    try {
      const first = register({ graph: async () => "fresh" }); const c1 = await start(first, ctx(root, true, "aggregate-session")); first.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("[trail] tokens saved ≈ 250"), isError: false }, c1);
      const second = register({ graph: async () => "fresh" }); const c2 = ctx(root, true, "aggregate-session"); await second.handlers.get("session_start")![0]({ reason: "reload" }, c2); second.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("[trail] tokens saved ≈ 350"), isError: false }, c2);
      const third = register({ graph: async () => "fresh" }); const c3 = ctx(root, true, "aggregate-session"); await third.handlers.get("session_start")![0]({ reason: "reload" }, c3);
      assert.match(c3.status.at(-1)?.text ?? "", /~600 tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("publishes zero when a new session replaces one with savings", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-switch-"));
    try {
      const r = register({ graph: async () => "fresh" });
      const oldCtx = await start(r, ctx(root, true, "old-session"));
      r.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("[trail] tokens saved ≈ 700"), isError: false }, oldCtx);
      await r.handlers.get("session_start")![0]({ reason: "new" }, ctx(root, true, "new-session"));
      assert.deepEqual(r.emitted.filter(item => item.event === "pidash:trail-savings").at(-1)?.data, { tokenSavings: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("tracks Trail and source reads in the footer", async () => {
    const r = register({ graph: async () => "fresh" }); const c = await start(r);
    r.handlers.get("tool_result")![0]({ toolName: "trail_repo_map", input: {}, content: savings("[trail] tokens saved ≈ 500"), isError: false }, c);
    r.handlers.get("tool_result")![0]({ toolName: "grep", input: {}, content: [], isError: false }, c);
    r.handlers.get("tool_result")![0]({ toolName: "read", input: {}, content: [], isError: false }, c);
    assert.match(c.status.at(-1)?.text ?? "", /~500 tok saved/);
    assert.match(c.status.at(-1)?.text ?? "", /1\/3 reads/);
  });
});

describe("Trail build locking", () => {
  it("does not evict an old lock while its owner is alive", () => {
    const root = mapRoot([]);
    try {
      const lock = join(root, "graft/.graph/pi-build.lock");
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "owner" })); utimesSync(lock, 0, 0);
      assert.equal(trail.acquireBuildLock(root, undefined, silentLogger), null);
      assert.equal(existsSync(lock), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("preserves a replacement lock created during dead-owner reclamation", () => {
    const root = mapRoot([]);
    try {
      const lock = join(root, "graft/.graph/pi-build.lock");
      writeFileSync(lock, JSON.stringify({ pid: 999_999_999, token: "dead" }));
      const release = trail.acquireBuildLock(root, () => writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "replacement" }), { flag: "wx" }), silentLogger);
      assert.equal(release, null);
      assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "replacement");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("warns when another process holds the build lock", async () => {
    const root = mapRoot([{ id: "a", name: "a", path: "src/a.ts" }]);
    try {
      const warnings: string[] = [];
      const logger = { debug() {}, info() {}, warn(message: string) { warnings.push(message); }, error() {}, isDebugEnabled: () => false };
      writeFileSync(join(root, "graft/.graph/pi-build.lock"), JSON.stringify({ pid: process.pid, token: "owner" }));
      const r = register({ results: [{ stdout: "built" }], logger }); const c = await start(r, ctx(root));
      const result = await r.tools.get("trail_refresh")!.execute("id", {}, undefined, undefined, c);
      assert.match(result.content[0].text, /skipped|failed/i);
      assert.deepEqual(warnings, ["refresh_locked"], "a contended refresh is a degraded state, not routine");
      assert.deepEqual(r.calls, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("warns when a rebuild fails instead of reporting a routine refresh_end", async () => {
    const root = mapRoot([{ id: "a", name: "a", path: "src/a.ts" }]);
    try {
      const events: Array<{ level: string; message: string; data: any }> = [];
      const logger = {
        debug() {},
        info(message: string, data: any) { events.push({ level: "info", message, data }); },
        warn(message: string, data: any) { events.push({ level: "warn", message, data }); },
        error() {}, isDebugEnabled: () => false,
      };
      const r = register({ results: [{ code: 3, stderr: "build failed" }], logger }); const c = await start(r, ctx(root));
      assert.match((await r.tools.get("trail_refresh")!.execute("id", {}, undefined, undefined, c)).content[0].text, /failed|skipped/i);
      const failed = events.filter(event => event.message === "refresh_end");
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.level, "warn", "a failed build is not logged at info");
      assert.equal(failed[0]!.data.code, 3);
      assert.equal(failed[0]!.data.ok, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rebuilds only through the explicit trail_refresh tool", async () => {
    const root = mapRoot([{ id: "a", name: "a", path: "src/a.ts" }]);
    try {
      const r = register({ results: [{ stdout: "built" }] }); const c = await start(r, ctx(root));
      r.handlers.get("tool_result")![0]({ toolName: "edit", input: { path: "src/a.ts" }, content: [], isError: false }, c);
      assert.match(c.status.at(-1)?.text ?? "", /stale/);
      const result = await r.tools.get("trail_refresh")!.execute("id", {}, undefined, undefined, c);
      assert.match(result.content[0].text, /rebuilt/i);
      assert.deepEqual(r.calls.map(call => call.args), [["build"]]);
      assert.equal(existsSync(join(root, "graft/.graph/pi-build.lock")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const mode of ["sync", "async"] as const) it(`marks the parent stale from a ${mode} child edit signal without rebuilding`, async () => {
    const root = mkdtempSync(join(tmpdir(), `trail-${mode}-child-`));
    try {
      const parent = register({ graph: async () => "fresh" }); const parentCtx = await start(parent, ctx(root, true, "parent"));
      process.env.PI_SUBAGENT_CHILD = "1"; process.env.__PI_PARENT_SESSION_ID = "parent";
      const child = register({ graph: async () => "fresh" }); const childCtx = await start(child, ctx(root, true, `${mode}-child`));
      child.handlers.get("tool_result")![0]({ toolName: mode === "sync" ? "write" : "edit", input: { path: "src/a.ts" }, content: [], isError: false }, childCtx);
      delete process.env.PI_SUBAGENT_CHILD; delete process.env.__PI_PARENT_SESSION_ID;
      const signals = join(root, ".pi/tmp", readdirSync(join(root, ".pi/tmp")).find(name => name.endsWith(".dirty"))!);
      assert.equal(readdirSync(signals).length, 1, "the child left one signal");
      await parent.handlers.get("before_agent_start")![0](promptEvent("yes"), parentCtx);
      assert.match(parentCtx.status.at(-1)?.text ?? "", /stale/);
      assert.equal(readdirSync(signals).length, 0, "the consumed signal is deleted, not re-read every prompt");
      await parent.handlers.get("before_agent_start")![0](promptEvent("yes"), parentCtx);
      assert.match(parentCtx.status.at(-1)?.text ?? "", /stale/);
      assert.equal(parent.calls.length, 0);
      assert.equal(child.calls.some(call => call.args[0] === "build"), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("writes child dirty signals under the resolved worktree root", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-child-root-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      const nested = join(root, "nested"); mkdirSync(nested);
      process.env.PI_SUBAGENT_CHILD = "1"; process.env.__PI_PARENT_SESSION_ID = "parent";
      const child = register({ graph: async () => "fresh" }); const childCtx = await start(child, ctx(nested, true, "child"));
      child.handlers.get("tool_result")![0]({ toolName: "edit", input: { path: "src/a.ts" }, content: [], isError: false }, childCtx);
      assert.equal(existsSync(join(nested, ".pi")), false);
      assert.equal(readdirSync(join(root, ".pi/tmp")).some(name => name.endsWith(".dirty")), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Trail paths and status", () => {
  it("adds required query tools to restricted child tool lists", () => {
    const tools = trail.withTrailTools(["read"], true)!;
    assert.ok(tools.includes("read"));
    for (const tool of trail.TRAIL_QUERY_TOOLS) assert.ok(tools.includes(tool), tool);
    assert.deepEqual(trail.withTrailTools(["read"], false), ["read"]);
  });
  it("rejects a symlink that escapes the project before invoking Trail", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-root-")); const outside = mkdtempSync(join(tmpdir(), "trail-outside-"));
    try { mkdirSync(join(root, "src")); writeFileSync(join(outside, "secret.ts"), "secret"); symlinkSync(join(outside, "secret.ts"), join(root, "src", "escape.ts"));
      const r = register({ graph: async () => "fresh" }); const c = await start(r, ctx(root)); const result = await r.tools.get("trail_file_api")!.execute("id", { path: "src/escape.ts" }, undefined, undefined, c);
      assert.match(result.content[0].text, /project/i); assert.equal(r.calls.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
  it("reports n/a, not failed, when the cwd is not a git worktree", async () => {
    const mock = mockPi(); const command = runner([]);
    trail.createTrailIntegration({ enabled: true, worktree: () => null, run: command.run, logger: silentLogger }).register(mock.pi as any);
    const c = ctx();
    await mock.handlers.get("session_start")![0]({ reason: "startup" }, c);
    // The whole point: an ordinary directory is not a broken install, so it must
    // not be reported with the error-red "failed" state.
    assert.deepEqual(c.status.at(-1), { key: "4b-trail", text: "◤ trail · n/a" });
    assert.deepEqual(command.calls, []);
    assert.equal(mock.tools.size, 0, "no trail tools may be registered outside a worktree");
  });
  it("uses the shared trail status slot", async () => {
    const r = register({ executable: async () => false }); const c = await start(r);
    assert.deepEqual(c.status.at(-1), { key: "4b-trail", text: "◤ trail · 0 nodes · failed" });
  });
  it("formats nodes, freshness, reads, and compact savings", () => {
    const theme = { fg: (color: string, value: string) => `<${color}>${value}</${color}>` };
    assert.equal(trail.formatTrailFooter({ state: "ready", nodeCount: 12, tokenSavings: 1_098_359 }, theme), "<dim>◤ </dim><accent>trail</accent><dim> · </dim><dim>12 nodes</dim><dim> · </dim><success>✓ synced</success><dim> · </dim><success>~1.1M tok saved</success>");
    assert.equal(trail.formatTrailFooter({ state: "ready", nodeCount: 12, tokenSavings: 0, trailReads: 3, sourceReads: 9 }, theme), "<dim>◤ </dim><accent>trail</accent><dim> · </dim><dim>12 nodes</dim><dim> · </dim><success>✓ synced</success><dim> · </dim><dim>3/12 reads</dim>");
    assert.doesNotMatch(trail.formatTrailFooter({ state: "ready", nodeCount: 12, tokenSavings: 0 }, theme), /tok saved|reads/);
  });
});

describe("Logger injection", () => {
  it("labels where each turn's query came from", async () => {
    const exits: any[] = [];
    const stub = {
      debug() {},
      info(message: string, data: any) { if (message === "prompt_retrieval_exit") exits.push(data); },
      warn() {}, error() {}, isDebugEnabled: () => false,
    };
    const root = mapRoot([{ id: "a", name: "a", path: "src/auth.ts" }]);
    try {
      const r = register({ graph: async () => "fresh", logger: stub, results: [{ stdout: JSON.stringify({ hits: [{ title: "authenticate", pointer: "src/auth.ts:1" }] }) }, { stdout: JSON.stringify({ hits: [{ title: "authenticate", pointer: "src/auth.ts:1" }] }) }] });
      const c = await start(r, ctx(root));
      const custom = (message: any) => ({ messageType: "custom", message, systemPrompt: "base", systemPromptOptions: { sections: {} } });
      await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      await r.handlers.get("before_agent_start")![0](custom({ content: [{ type: "text", text: "locate the authentication implementation" }] }), c);
      await r.handlers.get("before_agent_start")![0](custom({ content: [] }), c);
      assert.deepEqual(exits.map(exit => [exit.querySource, exit.decision]), [
        ["prompt", "injected"],
        ["custom_message", "injected"],
        ["custom_message", "guidance_only_control_prompt"],
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("routes the whole turn to the injected logger and never to the production log", async () => {
    const events: Array<{ level: string; message: string }> = [];
    const stub = {
      debug(message: string) { events.push({ level: "debug", message }); },
      info(message: string) { events.push({ level: "info", message }); },
      warn(message: string) { events.push({ level: "warn", message }); },
      error(message: string) { events.push({ level: "error", message }); },
      isDebugEnabled: () => true,
    };
    // Pin a throwaway session id so the real logger's destination is known and
    // empty: anything written there during this test came from this test.
    const sessionId = `trail-injection-${process.pid}-${Date.now()}`;
    const previous = (globalThis as any).__piConfigSessionId;
    setGlobalSessionId(sessionId);
    const logPath = getPiLogPath("trail")!;
    rmSync(dirname(logPath), { recursive: true, force: true });
    const root = mapRoot([{ id: "a", name: "a", path: "src/auth.ts" }]);
    try {
      const mock = mockPi();
      const command = runner([{ stdout: JSON.stringify({ hits: [{ title: "authenticate", pointer: "src/auth.ts:1" }] }) }]);
      trail.createTrailIntegration({ enabled: true, executable: async () => true, worktree: () => "/repo", run: command.run, logger: stub }).register(mock.pi as any);
      const c = ctx(root, true, "fake-session");
      await mock.handlers.get("session_start")![0]({ reason: "startup" }, c);
      await mock.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      await mock.handlers.get("tool_call")![0]({ toolName: "grep", input: { pattern: "authenticate" } }, c);
      const messages = events.map(event => event.message);
      assert.ok(messages.includes("prompt_retrieval_exit"), "the stub receives the turn events");
      assert.ok(messages.includes("gate_blocked"), "the stub receives gate events");
      assert.ok(messages.includes("map_dir_resolved"), "helper logging is routed to the injected logger too");
      assert.ok(events.some(event => event.level === "debug" && event.message === "map_loaded"), "sub-info levels stay on the injected logger");
      assert.equal(existsSync(logPath), false, "the real trail logger is never reached");
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (previous === undefined) { delete (globalThis as any).__piConfigSessionId; delete process.env.__PI_CONFIG_SESSION_ID; }
      else setGlobalSessionId(previous);
    }
  });
});
