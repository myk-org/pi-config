/** Graft integration contract for #820. Run: npx tsx --test tests/node/orchestrator/graft.test.ts */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as graft from "../../../extensions/orchestrator/graft.js";

type GraftRun = (args: readonly string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string; code: number }>;
type Handler = (event: any, ctx: any) => Promise<any> | any;
type Tool = { name: string; execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };

function mockPi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const emitted: Array<{ event: string; data: any }> = [];
  return { pi: { events: { emit(event: string, data: any) { emitted.push({ event, data }); } }, on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, registerTool(tool: Tool) { tools.set(tool.name, tool); } }, handlers, tools, emitted };
}
function runner(results: Array<{ stdout?: string; stderr?: string; code?: number }> = []) {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const run: GraftRun = async (args, { cwd }) => { calls.push({ args, cwd }); const next = results.shift() ?? {}; return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", code: next.code ?? 0 }; };
  return { run, calls };
}
const defaultRoot = mkdtempSync(join(tmpdir(), "graft-default-"));
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
  graft.createGraftIntegration({ enabled: true, executable: async () => true, graph: async () => "fresh", run: command.run, ...opts }).register(mock.pi as any);
  return { ...mock, ...command };
}
async function start(r: ReturnType<typeof register>, c = ctx()) { await r.handlers.get("session_start")![0]({ reason: "startup" }, c); return c; }

describe("Graft opt-in, trust, and startup", () => {
  it("is inert when disabled", () => { const r = register({ enabled: false }); assert.equal(r.handlers.size, 0); assert.equal(r.tools.size, 0); });
  it("registers tools only for trusted projects that enable Graft", async () => {
    const disabled = register({ setting: () => false }); await start(disabled); assert.equal(disabled.tools.size, 0);
    const enabled = register({ setting: () => true }); await start(enabled); assert.ok(enabled.tools.size > 0);
    const untrusted = register({ setting: () => true }); await start(untrusted, ctx("/untrusted/project", false)); assert.equal(untrusted.tools.size, 0); assert.equal(untrusted.calls.length, 0);
  });
  for (const transition of ["untrusted", "disabled"] as const) it(`invalidates tools and status on a ${transition} session transition`, async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-transition-"));
    try {
      let enabled = true;
      const r = register({ setting: () => enabled }); const oldCtx = await start(r, ctx(root));
      assert.ok(r.tools.size > 0);
      enabled = transition !== "disabled";
      const nextCtx = ctx(join(root, "next"), transition !== "untrusted");
      await r.handlers.get("session_start")![0]({ reason: "new" }, nextCtx);
      const result = await r.tools.get("graft_repo_map")!.execute("id", {}, undefined, undefined, nextCtx);
      assert.match(result.content[0].text, /disabled|untrusted/i);
      assert.equal(r.calls.length, 0);
      assert.deepEqual(nextCtx.status.at(-1), { key: "4b-graft", text: undefined });
      assert.deepEqual(r.emitted.filter(item => item.event === "pidash:graft-savings").at(-1)?.data, { tokenSavings: 0 });
      void oldCtx;
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("builds absent graphs only for trusted eligible sessions", async () => { const r = register({ graph: async () => "absent" }); await start(r); assert.deepEqual(r.calls.map(c => c.args), [["build"]]); });
  it("probes the Graft version before graph work and stops when unavailable", async () => {
    const mock = mockPi(); const command = runner([{ code: 1 }]);
    graft.createGraftIntegration({ enabled: true, graph: async () => "absent", run: command.run }).register(mock.pi as any);
    const c = ctx(); await mock.handlers.get("session_start")![0]({ reason: "startup" }, c);
    assert.deepEqual(command.calls.map(call => call.args), [["--version"]]);
    assert.deepEqual(c.status.at(-1), { key: "4b-graft", text: "◤ graft · 0 nodes · failed" });
  });
  it("keeps child processes consumer-only while registering query tools and retrieval", async () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    let graphChecks = 0;
    const child = register({ graph: async () => { graphChecks++; return "fresh"; }, retrieve: async () => ({ pointers: ["src/a.ts:1"] }) });
    await start(child);
    assert.ok(child.tools.has("graft_find_code"));
    assert.equal(child.tools.has("graft_refresh"), false);
    assert.equal(graphChecks, 1);
    assert.equal(child.calls.length, 0);
    const result = await child.handlers.get("before_agent_start")![0]({ prompt: "Explain how authentication sessions are validated", systemPrompt: "base" }, ctx());
    assert.match(result.systemPrompt, /graft/i);
  });
  it("skips owner graph work for print and json oneshots", async () => {
    process.argv = [process.execPath, "pi", "-p", "prompt"]; const print = register({ graph: async () => "absent" }); await start(print); assert.equal(print.calls.length, 0);
  });
  for (const reason of ["reload", "resume"]) it(`validates graph freshness on ${reason}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-root-"));
    try {
      mkdirSync(join(root, "graft/.graph"), { recursive: true });
      writeFileSync(join(root, "graft/.graph/wiring.json"), JSON.stringify({ meta: { nodeCount: 7 } }));
      const r = register({ graph: async () => "absent" }); const c = ctx(root);
      await r.handlers.get("session_start")![0]({ reason }, c);
      assert.deepEqual(c.status.at(-1), { key: "4b-graft", text: "◤ graft · 7 nodes · ⚠ stale" });
      assert.deepEqual(r.calls.map(call => call.args), [["build"]]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Graft retrieval and accounting", () => {
  it("adds durable force-use guidance whenever a trusted enabled graph is ready", async () => {
    const r = register(); await start(r);
    const result = await r.handlers.get("before_agent_start")![0]({ prompt: "yes", systemPrompt: "base" }, ctx());
    assert.match(result.systemPrompt, /use Graft before raw grep\/read/i);
    assert.match(result.systemPrompt, /graft_trace_calls/i);
  });
  it("retrieves for every substantive prompt without keyword matching", async () => {
    const prompts = ["Explain the current architecture tradeoffs", "Plan the next release carefully", "Review the proposed approach for regressions"];
    const retrieved: string[] = [];
    const r = register({ retrieve: async (query: string) => { retrieved.push(query); return { pointers: [`src/${query.length}.ts:1`] }; } }); const c = await start(r);
    for (const prompt of prompts) await r.handlers.get("before_agent_start")![0]({ prompt, systemPrompt: "base" }, c);
    assert.deepEqual(retrieved, prompts);
  });
  it("retrieves before substantive code work and gates broad raw navigation", async () => {
    const r = register({ results: [{ stdout: JSON.stringify({ coverage: .9, hits: [{ title: "authentication", pointer: "src/auth.ts:12" }] }) }] }); const c = await start(r);
    await r.handlers.get("before_agent_start")![0]({ prompt: "locate the authentication implementation", systemPrompt: "base" }, c);
    assert.deepEqual(r.calls[0].args, ["ask", "locate the authentication implementation", ".", "--json", "-n", "3"]);
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c), undefined);
  });
  it("blocks raw navigation only while retrieval is pending", async () => {
    let release!: (value: { pointers: string[] }) => void;
    const pending = new Promise<{ pointers: string[] }>(resolve => { release = resolve; });
    const r = register({ retrieve: async () => pending, interactiveTimeoutMs: 1_000 }); const c = await start(r);
    const retrieval = r.handlers.get("before_agent_start")![0]({ prompt: "locate the authentication implementation", systemPrompt: "base" }, c);
    await new Promise(resolve => setImmediate(resolve));
    assert.match((await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c))?.reason ?? "", /graft_find_code/i);
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "git status --short" } }, c), undefined);
    release({ pointers: [] }); await retrieval;
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c), undefined);
  });
  it("fails automatic retrieval open at the interactive deadline", async () => {
    const r = register({ retrieve: async () => new Promise(() => {}), interactiveTimeoutMs: 20 }); const c = await start(r);
    const started = Date.now();
    const result = await r.handlers.get("before_agent_start")![0]({ prompt: "locate the authentication implementation", systemPrompt: "base" }, c);
    assert.ok(Date.now() - started < 250);
    assert.match(result.systemPrompt, /timed out/i);
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c), undefined);
  });
  it("does not gate navigation when the graph is unavailable", async () => {
    const r = register({ executable: async () => false }); const c = await start(r);
    await r.handlers.get("before_agent_start")![0]({ prompt: "locate the authentication implementation", systemPrompt: "base" }, c);
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "find src -name '*.ts'" } }, c), undefined);
  });
  it("allows a Graft-returned file and releases the gate after no relevant result", async () => {
    const r = register({ results: [{ stdout: JSON.stringify({ coverage: .9, hits: [{ title: "authentication", pointer: "src/auth.ts:12" }] }) }, { stdout: JSON.stringify({ coverage: 0, coverageStrong: 0, hits: [] }) }] }); const c = await start(r);
    await r.handlers.get("before_agent_start")![0]({ prompt: "locate the authentication implementation", systemPrompt: "base" }, c);
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "src/auth.ts" } }, c), undefined);
    await r.handlers.get("before_agent_start")![0]({ prompt: "find the session handler implementation", systemPrompt: "base" }, c);
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "src/other.ts" } }, c), undefined);
  });
  it("uses upstream bounded JSON ask without --no-refresh and injects compact relevant pointers", async () => {
    const r = register({ results: [{ stdout: JSON.stringify({ coverage: 0.9, hits: [{ title: "authenticate", pointer: "src/auth.ts:12", snippet: "validates sessions" }] }) }] });
    await start(r); const result = await r.handlers.get("before_agent_start")![0]({ prompt: "where is authentication?", systemPrompt: "base" }, ctx());
    assert.deepEqual(r.calls[0].args, ["ask", "where is authentication?", ".", "--json", "-n", "3"]);
    assert.match(result.systemPrompt, /authenticate: src\/auth\.ts:12/);
  });
  it("skips conversational prompts and weak retrieval matches", async () => {
    const r = register({ results: [{ stdout: JSON.stringify({ coverage: 0.01, coverageStrong: 0, hits: [{ title: "noise", pointer: "src/noise.ts:1" }] }) }] });
    await start(r);
    assert.match((await r.handlers.get("before_agent_start")![0]({ prompt: "yes", systemPrompt: "base" }, ctx())).systemPrompt, /graft/i);
    assert.match((await r.handlers.get("before_agent_start")![0]({ prompt: "please locate the authentication implementation", systemPrompt: "base" }, ctx())).systemPrompt, /graft/i);
  });
  it("accounts for each Graft tool footer exactly once in tool_result", async () => {
    const r = register({ results: [{ stdout: "map\n[graft] tokens saved ≈ 100" }] });
    const c = await start(r); const result = await r.tools.get("graft_repo_map")!.execute("one", {}, undefined, undefined, c);
    assert.doesNotMatch(c.status.at(-1)?.text ?? "", /tok saved/);
    r.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: result.content, isError: false }, c);
    r.handlers.get("before_agent_start")![0]({ prompt: "yes", systemPrompt: "base" }, c);
    assert.match(c.status.at(-1)?.text ?? "", /~100 tok saved/);
  });
  it("publishes the exact authoritative parent aggregate", async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-publish-"));
    try {
      const r = register(); const c = await start(r, ctx(root));
      r.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: [{ type: "text", text: "[graft] tokens saved ≈ 1,098,359" }], isError: false }, c);
      assert.deepEqual(r.emitted.filter(item => item.event === "pidash:graft-savings").at(-1)?.data, { tokenSavings: 1_098_359 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("aggregates a parent and two child processes into the parent status", async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-family-"));
    try {
      const parent = register(); const parentCtx = await start(parent, ctx(root, true, "parent-session"));
      const children = [];
      for (const [id, amount] of [["child-one", 200], ["child-two", 300]] as const) {
        process.env.PI_SUBAGENT_CHILD = "1"; process.env.__PI_PARENT_SESSION_ID = "parent-session";
        const child = register(); const childCtx = await start(child, ctx(root, true, id));
        child.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: [{ type: "text", text: `[graft] tokens saved ≈ ${amount}` }], isError: false }, childCtx);
        children.push(child);
      }
      delete process.env.PI_SUBAGENT_CHILD; delete process.env.__PI_PARENT_SESSION_ID;
      await parent.handlers.get("before_agent_start")![0]({ prompt: "yes", systemPrompt: "base" }, parentCtx);
      assert.match(parentCtx.status.at(-1)?.text ?? "", /~500 tok saved/);
      const stores = readdirSync(join(root, ".pi/tmp"));
      assert.equal(stores.filter(name => name.startsWith("graft-savings-") && name.endsWith(".json")).length, 1);
      assert.equal(stores.some(name => name.includes(".events")), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("does not lose deltas from independently initialized writers", async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-race-"));
    try {
      const writers = [register(), register(), register()];
      const contexts = await Promise.all(writers.map((writer, index) => start(writer, ctx(root, true, `writer-${index}`))));
      process.env.__PI_PARENT_SESSION_ID = "shared-parent";
      const children = writers.map((_, index) => { process.env.PI_SUBAGENT_CHILD = "1"; const child = register(); return { child, context: ctx(root, true, `child-${index}`) }; });
      await Promise.all(children.map(({ child, context }) => start(child, context)));
      children.forEach(({ child, context }, index) => child.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: [{ type: "text", text: `[graft] tokens saved ≈ ${(index + 1) * 100}` }], isError: false }, context));
      delete process.env.PI_SUBAGENT_CHILD; delete process.env.__PI_PARENT_SESSION_ID;
      const main = register(); const mainCtx = await start(main, ctx(root, true, "shared-parent"));
      assert.match(mainCtx.status.at(-1)?.text ?? "", /~600 tok saved/);
      void contexts;
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("persists canonical savings emitted by automatic prompt retrieval", async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-prompt-"));
    try {
      const output = `${JSON.stringify({ coverage: .9, hits: [{ title: "answer", pointer: "src/a.ts:1" }] })}\n[graft] tokens saved ≈ 450`;
      const r = register({ results: [{ stdout: output }] }); const c = await start(r, ctx(root, true, "prompt-session"));
      await r.handlers.get("before_agent_start")![0]({ prompt: "Explain this implementation in detail", systemPrompt: "base" }, c);
      const restored = register(); const restoredCtx = ctx(root, true, "prompt-session"); await restored.handlers.get("session_start")![0]({ reason: "reload" }, restoredCtx);
      assert.match(restoredCtx.status.at(-1)?.text ?? "", /~450 tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const reason of ["reload", "resume"]) it(`restores session savings before rendering on ${reason}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-session-"));
    try {
      const first = register(); const firstCtx = await start(first, ctx(root, true, "saved-session"));
      first.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: [{ type: "text", text: "map\n[graft] tokens saved ≈ 700" }], isError: false }, firstCtx);
      const restored = register(); const restoredCtx = ctx(root, true, "saved-session");
      await restored.handlers.get("session_start")![0]({ reason }, restoredCtx);
      assert.match(restoredCtx.status[0]?.text ?? "", /~700 tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("isolates new sessions and stores a hashed ID with private modes", async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-session-"));
    try {
      const first = register(); const firstCtx = await start(first, ctx(root, true, "secret-session-id"));
      first.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: [{ type: "text", text: "map\n[graft] tokens saved ≈ 400" }], isError: false }, firstCtx);
      const dir = join(root, ".pi/tmp"); const files = readdirSync(dir).filter(file => file.startsWith("graft-savings-") && file.endsWith(".json"));
      assert.equal(files.length, 1); assert.doesNotMatch(files[0], /secret-session-id/);
      assert.equal(statSync(dir).mode & 0o777, 0o700); assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
      assert.equal(readdirSync(dir).some(file => file.includes(".events")), false);
      const fresh = register(); const freshCtx = ctx(root, true, "new-session"); await fresh.handlers.get("session_start")![0]({ reason: "startup" }, freshCtx);
      assert.doesNotMatch(freshCtx.status.at(-1)?.text ?? "", /tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("falls back safely for a corrupt session store", async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-session-"));
    try {
      const seeded = register(); const seededCtx = await start(seeded, ctx(root));
      seeded.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: [{ type: "text", text: "[graft] tokens saved ≈ 100" }], isError: false }, seededCtx);
      const store = join(root, ".pi/tmp", readdirSync(join(root, ".pi/tmp")).find(name => name.endsWith(".json"))!);
      writeFileSync(store, "{broken", { mode: 0o600 });
      const restored = register(); const restoredCtx = ctx(root); await restored.handlers.get("session_start")![0]({ reason: "reload" }, restoredCtx);
      assert.doesNotMatch(restoredCtx.status.at(-1)?.text ?? "", /tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("accumulates and persists savings after restoration", async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-session-"));
    try {
      const first = register(); const c1 = await start(first, ctx(root, true, "aggregate-session")); first.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: [{ type: "text", text: "[graft] tokens saved ≈ 250" }], isError: false }, c1);
      const second = register(); const c2 = ctx(root, true, "aggregate-session"); await second.handlers.get("session_start")![0]({ reason: "reload" }, c2); second.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: [{ type: "text", text: "[graft] tokens saved ≈ 350" }], isError: false }, c2);
      const third = register(); const c3 = ctx(root, true, "aggregate-session"); await third.handlers.get("session_start")![0]({ reason: "reload" }, c3);
      assert.match(c3.status.at(-1)?.text ?? "", /~600 tok saved/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("publishes zero when a new session replaces one with savings", async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-switch-"));
    try {
      const r = register();
      const oldCtx = await start(r, ctx(root, true, "old-session"));
      r.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: [{ type: "text", text: "[graft] tokens saved ≈ 700" }], isError: false }, oldCtx);
      await r.handlers.get("session_start")![0]({ reason: "new" }, ctx(root, true, "new-session"));
      assert.deepEqual(r.emitted.filter(item => item.event === "pidash:graft-savings").at(-1)?.data, { tokenSavings: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("discards a pending refresh completion after the session root changes and releases its original lock", async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "graft-refresh-old-"));
    const nextRoot = mkdtempSync(join(tmpdir(), "graft-refresh-new-"));
    let releaseBuild!: () => void;
    const buildPending = new Promise<void>(resolve => { releaseBuild = resolve; });
    try {
      const r = register({ run: async (args: readonly string[], { cwd }: { cwd: string }) => {
        r.calls.push({ args, cwd });
        if (args[0] === "build") await buildPending;
        return { stdout: "", stderr: "", code: 0 };
      } });
      const oldCtx = await start(r, ctx(firstRoot, true, "old-session"));
      r.handlers.get("tool_result")![0]({ toolName: "edit", input: { path: "src/a.ts" }, content: [], isError: false }, oldCtx);
      r.handlers.get("agent_end")![0]({}, oldCtx);
      await new Promise(resolve => setImmediate(resolve));
      const lock = join(firstRoot, "graft/.graph/pi-build.lock");
      assert.equal(existsSync(lock), true);
      const nextCtx = ctx(nextRoot, true, "next-session");
      await r.handlers.get("session_start")![0]({ reason: "new" }, nextCtx);
      const statusCount = nextCtx.status.length;
      releaseBuild();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(nextCtx.status.length, statusCount);
      assert.equal(existsSync(lock), false);
      assert.deepEqual(r.calls.find(call => call.args[0] === "build")?.cwd, firstRoot);
    } finally { releaseBuild?.(); rmSync(firstRoot, { recursive: true, force: true }); rmSync(nextRoot, { recursive: true, force: true }); }
  });
  it("keeps a stale graph queryable while the owner rebuilds it", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const r = register({ graph: async () => "stale", run: async (args: readonly string[], opts: { cwd: string }) => {
      r.calls.push({ args, cwd: opts.cwd }); if (args[0] === "build") await pending;
      return { stdout: args[0] === "ask" ? JSON.stringify({ coverage: .9, hits: [{ title: "answer", pointer: "src/a.ts:1" }] }) : "", stderr: "", code: 0 };
    } });
    const c = await start(r);
    const result = await r.handlers.get("before_agent_start")![0]({ prompt: "Explain the architecture decisions in this project", systemPrompt: "base" }, c);
    assert.match(result.systemPrompt, /src\/a\.ts:1/);
    release();
  });
  it("does not block the next user message on a pending post-edit refresh", async () => {
    const r = register(); const c = await start(r);
    r.handlers.get("tool_result")![0]({ toolName: "edit", input: { path: "src/a.ts" }, content: [], isError: false }, c);
    const result = await r.handlers.get("before_agent_start")![0]({ prompt: "locate the authentication implementation", systemPrompt: "base" }, c);
    assert.match(result.systemPrompt, /graft/i);
    assert.deepEqual(r.calls.map(call => call.args), [["ask", "locate the authentication implementation", ".", "--json", "-n", "3"]]);
  });
  it("revalidates an absent child graph on a later turn", async () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    let checks = 0;
    const r = register({ graph: async () => ++checks === 1 ? "absent" : "fresh", retrieve: async () => ({ pointers: ["src/a.ts:1"] }) }); const c = await start(r);
    const result = await r.handlers.get("before_agent_start")![0]({ prompt: "Explain the architecture decisions in this project", systemPrompt: "base" }, c);
    assert.match(result.systemPrompt, /src\/a\.ts:1/);
    assert.equal(r.calls.length, 0);
  });
  it("syncs a dirty graph once in the background at agent end", async () => {
    const r = register({ results: [{ code: 0 }] }); const c = await start(r);
    r.handlers.get("tool_result")![0]({ toolName: "write", input: { path: "src/a.ts" }, content: [], isError: false }, c);
    r.handlers.get("agent_end")![0]({}, c); await new Promise(resolve => setImmediate(resolve));
    r.handlers.get("agent_end")![0]({}, c);
    assert.deepEqual(r.calls.map(call => call.args), [["build"]]);
  });
  it("tracks Pi-native Graft and source reads without MCP", async () => {
    const r = register(); const c = await start(r);
    r.handlers.get("tool_result")![0]({ toolName: "graft_repo_map", input: {}, content: [{ type: "text", text: "[graft] tokens saved ≈ 500" }], isError: false }, c);
    r.handlers.get("tool_result")![0]({ toolName: "grep", input: {}, content: [], isError: false }, c);
    r.handlers.get("tool_result")![0]({ toolName: "read", input: {}, content: [], isError: false }, c);
    assert.match(c.status.at(-1)?.text ?? "", /~500 tok saved/);
  });
  it("returns sanitized query diagnostics without poisoning later queries", async () => {
    const r = register({ results: [{ code: 1, stderr: "scope missing\nsecret second line" }, { stdout: "map ok" }] }); const c = await start(r);
    const failed = await r.tools.get("graft_repo_map")!.execute("one", {}, undefined, undefined, c);
    assert.match(failed.content[0].text, /scope missing/);
    assert.doesNotMatch(failed.content[0].text, /secret second line/);
    const retried = await r.tools.get("graft_repo_map")!.execute("two", {}, undefined, undefined, c);
    assert.equal(retried.content[0].text, "map ok");
  });
  it("does not install a filesystem watcher or run a process for normal prompts", async () => {
    let watches = 0;
    const r = register({ watch: () => { watches++; return () => {}; } }); const c = await start(r);
    const result = await r.handlers.get("before_agent_start")![0]({ prompt: "hello", systemPrompt: "base" }, c);
    assert.equal(watches, 0);
    assert.equal(r.calls.length, 0);
    assert.match(result.systemPrompt, /graft/i);
  });
  it("marks only successful writes and edits dirty", async () => {
    for (const toolName of ["write", "edit"]) {
      const r = register(); const c = await start(r);
      r.handlers.get("tool_result")![0]({ toolName, input: { path: "src/a.ts" }, content: [], isError: false }, c);
      r.handlers.get("agent_end")![0]({}, c); await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(r.calls.map(call => call.args), [["build"]], toolName);
    }
  });
  for (const mode of ["sync", "async"] as const) it(`lets the parent consume ${mode} child edit notifications and own the rebuild`, async () => {
    const root = mkdtempSync(join(tmpdir(), `graft-${mode}-child-`));
    try {
      const parent = register(); const parentCtx = await start(parent, ctx(root, true, "parent"));
      process.env.PI_SUBAGENT_CHILD = "1"; process.env.__PI_PARENT_SESSION_ID = "parent";
      const child = register(); const childCtx = await start(child, ctx(root, true, `${mode}-child`));
      child.handlers.get("tool_result")![0]({ toolName: mode === "sync" ? "write" : "edit", input: { path: "src/a.ts" }, content: [], isError: false }, childCtx);
      child.handlers.get("agent_end")![0]({}, childCtx); await new Promise(resolve => setImmediate(resolve));
      assert.equal(child.calls.some(call => call.args[0] === "build"), false);
      delete process.env.PI_SUBAGENT_CHILD; delete process.env.__PI_PARENT_SESSION_ID;
      parent.handlers.get("agent_end")![0]({}, parentCtx); await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(parent.calls.map(call => call.args), [["build"]]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Graft build locking", () => {
  it("does not evict an old lock while its owner is alive", () => {
    const root = mkdtempSync(join(tmpdir(), "graft-lock-live-"));
    try {
      const lock = join(root, "graft/.graph/pi-build.lock"); mkdirSync(join(root, "graft/.graph"), { recursive: true });
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "owner" })); utimesSync(lock, 0, 0);
      assert.equal(graft.acquireBuildLock(root), null);
      assert.equal(existsSync(lock), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("preserves a replacement lock created during dead-owner reclamation", () => {
    const root = mkdtempSync(join(tmpdir(), "graft-lock-race-"));
    try {
      const lock = join(root, "graft/.graph/pi-build.lock"); mkdirSync(join(root, "graft/.graph"), { recursive: true });
      writeFileSync(lock, JSON.stringify({ pid: 999_999_999, token: "dead" }));
      const release = graft.acquireBuildLock(root, () => writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "replacement" }), { flag: "wx" }));
      assert.equal(release, null);
      assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "replacement");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Graft paths and status", () => {
  it("adds required query tools to restricted child tool lists", () => {
    const tools = graft.withGraftTools(["read"], true)!;
    assert.ok(tools.includes("read"));
    for (const tool of graft.GRAFT_QUERY_TOOLS) assert.ok(tools.includes(tool), tool);
    assert.deepEqual(graft.withGraftTools(["read"], false), ["read"]);
  });
  it("rejects a symlink that escapes the project before invoking Graft", async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-root-")); const outside = mkdtempSync(join(tmpdir(), "graft-outside-"));
    try { mkdirSync(join(root, "src")); writeFileSync(join(outside, "secret.ts"), "secret"); symlinkSync(join(outside, "secret.ts"), join(root, "src", "escape.ts"));
      const r = register(); const c = await start(r, ctx(root)); const result = await r.tools.get("graft_file_api")!.execute("id", { path: "src/escape.ts" }, undefined, undefined, c);
      assert.match(result.content[0].text, /project/i); assert.equal(r.calls.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
  it("uses the shared graft status slot", async () => { const r = register({ executable: async () => false }); const c = await start(r); assert.deepEqual(c.status.at(-1), { key: "4b-graft", text: "◤ graft · 0 nodes · failed" }); });
  it("formats compact savings and themes positive values as success", () => {
    const theme = { fg: (color: string, value: string) => `<${color}>${value}</${color}>` };
    assert.equal(graft.formatGraftFooter({ state: "ready", nodeCount: 12, tokenSavings: 1_098_359 }, theme), "<dim>◤ </dim><accent>graft</accent><dim> · </dim><dim>12 nodes</dim><dim> · </dim><success>✓ synced</success><dim> · </dim><success>~1.1M tok saved</success>");
    assert.doesNotMatch(graft.formatGraftFooter({ state: "ready", nodeCount: 12, tokenSavings: 0 }, theme), /tok saved/);
  });
});
