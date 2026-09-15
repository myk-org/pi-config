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
    assert.deepEqual(c.status.at(-1), { key: "4b-graft", text: "graft: failed" });
  });
  it("skips graph work for print/json oneshots, children, resumes, and reloads", async () => {
    process.argv = [process.execPath, "pi", "-p", "prompt"]; const print = register({ graph: async () => "absent" }); await start(print); assert.equal(print.calls.length, 0);
    process.env.PI_SUBAGENT_CHILD = "1"; const child = register({ graph: async () => "absent" }); assert.equal(child.handlers.size, 0); assert.equal(child.tools.size, 0);
    delete process.env.PI_SUBAGENT_CHILD; process.argv = originalArgv.slice(); const resume = register({ graph: async () => "absent" }); await resume.handlers.get("session_start")![0]({ reason: "resume" }, ctx()); assert.equal(resume.calls.length, 0);
    const reload = register({ graph: async () => "absent" }); await reload.handlers.get("session_start")![0]({ reason: "reload" }, ctx()); assert.equal(reload.calls.length, 0);
  });
});

describe("Graft retrieval and accounting", () => {
  it("uses the safe local ask invocation for production prompt pointers", async () => {
    const r = register({ results: [{ code: 0 }, { stdout: "src/auth.ts:12 authenticate\nsrc/session.ts:8 loadSession" }] });
    await start(r); const result = await r.handlers.get("before_agent_start")![0]({ prompt: "where is authentication?", systemPrompt: "base" }, ctx());
    assert.deepEqual(r.calls[1].args, ["ask", "--no-refresh", "--limit", "8", "where is authentication?"]);
    assert.match(result.systemPrompt, /src\/auth\.ts:12/);
  });
  it("sums savings footers from successful local command output", async () => {
    const r = register({ results: [{ code: 0 }, { stdout: "map\n[graft] tokens saved ≈ 100" }, { code: 0 }, { stdout: "map\n[graft] tokens saved ≈ 1,250" }] });
    const c = await start(r); const tool = r.tools.get("graft_repo_map")!;
    await tool.execute("one", {}, undefined, undefined, c); await tool.execute("two", {}, undefined, undefined, c);
    assert.match(c.status.at(-1)?.text ?? "", /1350 tokens saved/);
    assert.deepEqual(r.calls.map(call => call.args), [["check", "--json"], ["map", "--no-refresh", "--max-dirs", "16"], ["check", "--json"], ["map", "--no-refresh", "--max-dirs", "16"]]);
  });
  it("checks freshness before every provider request and rebuilds after arbitrary mutations", async () => {
    const r = register({ results: [{ code: 0 }, { code: 1 }, { code: 0 }] });
    const c = await start(r);
    await r.handlers.get("before_provider_request")![0]({}, c);
    await r.handlers.get("before_provider_request")![0]({}, c);
    assert.deepEqual(r.calls.map(call => call.args), [["check", "--json"], ["check", "--json"], ["build"]]);
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
  it("uses the shared graft status slot", async () => { const r = register({ executable: async () => false }); const c = await start(r); assert.deepEqual(c.status.at(-1), { key: "4b-graft", text: "graft: failed" }); });
  it("formats footer states", () => { assert.equal(graft.formatGraftFooter({ state: "ready", nodeCount: 12, tokenSavings: 340 }), "graft: ready · 12 nodes · 340 tokens saved"); });
});
