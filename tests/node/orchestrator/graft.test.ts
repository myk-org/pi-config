/** Graft integration contract for #820. Run: npx tsx --test tests/node/orchestrator/graft.test.ts */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as graft from "../../../extensions/orchestrator/graft.js";

type GraftRun = (args: readonly string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string; code: number }>;
type Handler = (event: any, ctx: any) => Promise<any> | any;
type Tool = { name: string; execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };

function mockPi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  return { pi: { on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, registerTool(tool: Tool) { tools.set(tool.name, tool); } }, handlers, tools };
}
function runner(results: Array<{ stdout?: string; stderr?: string; code?: number }> = []) {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const run: GraftRun = async (args, { cwd }) => { calls.push({ args, cwd }); const next = results.shift() ?? {}; return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", code: next.code ?? 0 }; };
  return { run, calls };
}
function ctx(cwd = "/trusted/project", trusted = true) {
  const status: Array<{ key: string; text: string | undefined }> = [];
  return { cwd, status, isProjectTrusted: () => trusted, ui: { setStatus: (key: string, text: string | undefined) => status.push({ key, text }) } };
}
const originalArgv = process.argv.slice();
const originalChild = process.env.PI_SUBAGENT_CHILD;
beforeEach(() => { delete process.env.PI_SUBAGENT_CHILD; });
afterEach(() => { process.argv = originalArgv.slice(); if (originalChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = originalChild; });
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
  it("builds absent graphs only for trusted eligible sessions", async () => { const r = register({ graph: async () => "absent" }); await start(r); assert.deepEqual(r.calls.map(c => c.args), [["build"]]); });
  it("probes the Graft version before graph work and stops when unavailable", async () => {
    const mock = mockPi(); const command = runner([{ code: 1 }]);
    graft.createGraftIntegration({ enabled: true, graph: async () => "absent", run: command.run }).register(mock.pi as any);
    const c = ctx(); await mock.handlers.get("session_start")![0]({ reason: "startup" }, c);
    assert.deepEqual(command.calls.map(call => call.args), [["--version"]]);
    assert.deepEqual(c.status.at(-1), { key: "4b-graft", text: "◤ graft · 0 nodes · failed" });
  });
  it("skips graph work for print/json oneshots and children", async () => {
    process.argv = [process.execPath, "pi", "-p", "prompt"]; const print = register({ graph: async () => "absent" }); await start(print); assert.equal(print.calls.length, 0);
    process.env.PI_SUBAGENT_CHILD = "1"; const child = register({ graph: async () => "absent" }); assert.equal(child.handlers.size, 0); assert.equal(child.tools.size, 0);
  });
  for (const reason of ["reload", "resume"]) it(`restores the synced footer from the local graph on ${reason}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-root-"));
    try {
      mkdirSync(join(root, "graft/.graph"), { recursive: true });
      writeFileSync(join(root, "graft/.graph/wiring.json"), JSON.stringify({ meta: { nodeCount: 7 } }));
      const r = register({ graph: async () => "absent" }); const c = ctx(root);
      await r.handlers.get("session_start")![0]({ reason }, c);
      assert.deepEqual(c.status.at(-1), { key: "4b-graft", text: "◤ graft · 7 nodes · ✓ synced" });
      assert.equal(r.calls.length, 0);
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
  it("retrieves before substantive code work and gates broad raw navigation", async () => {
    const r = register({ results: [{ stdout: JSON.stringify({ coverage: .9, hits: [{ title: "authentication", pointer: "src/auth.ts:12" }] }) }] }); const c = await start(r);
    await r.handlers.get("before_agent_start")![0]({ prompt: "locate the authentication implementation", systemPrompt: "base" }, c);
    assert.deepEqual(r.calls[0].args, ["ask", "locate the authentication implementation", ".", "--json", "-n", "3"]);
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c), undefined);
  });
  it("blocks raw navigation only when a code turn has not retrieved Graft", async () => {
    const r = register(); const c = await start(r);
    await r.handlers.get("before_agent_start")![0]({ prompt: "locate the authentication implementation", systemPrompt: "base" }, c);
    assert.match((await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "rg authentication" } }, c))?.reason ?? "", /graft_find_code/i);
    assert.equal(await r.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: "git status --short" } }, c), undefined);
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
  it("sums Graft's canonical savings footer from tool output", async () => {
    const r = register({ results: [{ stdout: "map\n[graft] tokens saved ≈ 100" }, { stdout: "map\n[graft] tokens saved ≈ 1,250" }] });
    const c = await start(r); const tool = r.tools.get("graft_repo_map")!;
    await tool.execute("one", {}, undefined, undefined, c); await tool.execute("two", {}, undefined, undefined, c);
    assert.match(c.status.at(-1)?.text ?? "", /~1,350 tok saved/);
    assert.deepEqual(r.calls.map(call => call.args), [["map", "--max-dirs", "16"], ["map", "--max-dirs", "16"]]);
  });
  it("does not block the next user message on a pending post-edit refresh", async () => {
    const r = register(); const c = await start(r);
    r.handlers.get("tool_result")![0]({ toolName: "edit", input: { path: "src/a.ts" }, content: [], isError: false }, c);
    const result = await r.handlers.get("before_agent_start")![0]({ prompt: "locate the authentication implementation", systemPrompt: "base" }, c);
    assert.equal(result, undefined);
    assert.deepEqual(r.calls, []);
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
});

describe("Graft paths and status", () => {
  it("rejects a symlink that escapes the project before invoking Graft", async () => {
    const root = mkdtempSync(join(tmpdir(), "graft-root-")); const outside = mkdtempSync(join(tmpdir(), "graft-outside-"));
    try { mkdirSync(join(root, "src")); writeFileSync(join(outside, "secret.ts"), "secret"); symlinkSync(join(outside, "secret.ts"), join(root, "src", "escape.ts"));
      const r = register(); const c = await start(r, ctx(root)); const result = await r.tools.get("graft_file_api")!.execute("id", { path: "src/escape.ts" }, undefined, undefined, c);
      assert.match(result.content[0].text, /project/i); assert.equal(r.calls.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
  it("uses the shared graft status slot", async () => { const r = register({ executable: async () => false }); const c = await start(r); assert.deepEqual(c.status.at(-1), { key: "4b-graft", text: "◤ graft · 0 nodes · failed" }); });
  it("formats Graft-style themed status with session savings", () => {
    const theme = { fg: (color: string, value: string) => `<${color}>${value}</${color}>` };
    assert.equal(graft.formatGraftFooter({ state: "ready", nodeCount: 12, tokenSavings: 340 }, theme), "<dim>◤ </dim><accent>graft</accent><dim> · </dim><dim>12 nodes</dim><dim> · </dim><success>✓ synced</success><dim> · </dim><accent>~340 tok saved</accent>");
  });
});
