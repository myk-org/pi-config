/**
 * Trail #978 runtime behavior contract: the navigation gate, map layout,
 * worktree enablement, "never cold build" and the child toolset.
 * Run: npx tsx --test tests/node/orchestrator/trail-behavior.test.ts
 *
 * Deliberately separate from trail.test.ts (owned by the Graft->Trail rename):
 * everything here asserts a user-visible handler return value (block / no
 * block, footer text, CLI invocations) rather than integration internals.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as trail from "../../../extensions/orchestrator/trail.js";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";

type TrailRun = (args: readonly string[], opts: { cwd: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>;
type Handler = (event: any, ctx: any) => Promise<any> | any;
type Tool = { name: string; execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };
/** Silent logger: these suites drive fake ctx/session ids and must not write telemetry into ~/.pi/logs/trail. */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, isDebugEnabled: () => false };

function mockPi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const emitted: Array<{ event: string; data: any }> = [];
  return {
    pi: {
      events: { emit(event: string, data: any) { emitted.push({ event, data }); } },
      on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
      registerTool(tool: Tool) { tools.set(tool.name, tool); },
    },
    handlers,
    tools,
    emitted,
  };
}
/** Injected Trail CLI: records every invocation, replays scripted results. */
function runner(results: Array<{ stdout?: string; stderr?: string; code?: number }> = []) {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const run: TrailRun = async (args, { cwd }) => {
    calls.push({ args, cwd });
    const next = results.shift() ?? {};
    return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", code: next.code ?? 0 };
  };
  return { run, calls };
}
/** Prompt event carrying the mutable structured prompt options Pi exposes. */
function promptEvent(prompt: string, options: Record<string, any> = {}) {
  return {
    messageType: "user",
    prompt,
    systemPrompt: "base",
    systemPromptOptions: {
      selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [],
      appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [], cwd: "/repo", ...options,
    },
  };
}
/** Custom-message event: how a subagent task starts its run — `prompt` is undefined, `message` holds the task. */
function customEvent(message: any, options: Record<string, any> = {}) {
  return {
    messageType: "custom",
    message,
    systemPrompt: "base",
    systemPromptOptions: {
      selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: [], promptGuidelines: [],
      appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [], cwd: "/repo", ...options,
    },
  };
}
/** Temp repo root with an on-disk code map (map presence is a filesystem check). */
function mapRoot(nodes: Array<{ id: string; name: string; path: string }>, nodeCount = nodes.length) {
  const root = mkdtempSync(join(tmpdir(), "trail-behavior-map-"));
  mkdirSync(join(root, "graft/.graph"), { recursive: true });
  writeFileSync(join(root, "graft/.graph/wiring.json"), JSON.stringify({ meta: { nodeCount }, nodes, edges: [] }));
  return root;
}
/** Linked-worktree fixture: `<worktree>/.git` points at `<main>/.git/worktrees/wt`. */
function linkedWorktree(main: string) {
  const worktree = mkdtempSync(join(tmpdir(), "trail-behavior-wt-"));
  mkdirSync(join(main, ".git/worktrees/wt"), { recursive: true });
  writeFileSync(join(main, ".git/worktrees/wt/commondir"), "../..\n");
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git/worktrees/wt")}\n`);
  return worktree;
}
function settings(root: string, values: Record<string, unknown>) {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi/pi-config-settings.jsonc"), JSON.stringify(values));
}
const defaultRoot = mkdtempSync(join(tmpdir(), "trail-behavior-default-"));
let defaultSession = 0;
function ctx(cwd = defaultRoot, trusted = true, sessionId = `trail-behavior-${++defaultSession}`) {
  const status: Array<{ key: string; text: string | undefined }> = [];
  return { cwd, status, sessionManager: { getSessionId: () => sessionId }, isProjectTrusted: () => trusted, ui: { setStatus: (key: string, text: string | undefined) => status.push({ key, text }) } };
}
const originalEnv = { child: process.env.PI_SUBAGENT_CHILD, parent: process.env.__PI_PARENT_SESSION_ID, enable: process.env.PI_TRAIL_ENABLE };
beforeEach(() => {
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.__PI_PARENT_SESSION_ID;
  delete process.env.PI_TRAIL_ENABLE;
  // Trail enablement tests read settings: pin the global file so a developer's
  // ~/.pi settings can never decide the result.
  setGlobalSettingsPath(join(tmpdir(), `trail-behavior-global-${process.pid}.json`));
  clearSettingsCache();
});
afterEach(() => {
  for (const [key, value] of [["PI_SUBAGENT_CHILD", originalEnv.child], ["__PI_PARENT_SESSION_ID", originalEnv.parent], ["PI_TRAIL_ENABLE", originalEnv.enable]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  setGlobalSettingsPath(null);
  clearSettingsCache();
});
function register(opts: any = {}) {
  const mock = mockPi();
  const command = runner(opts.results);
  // worktree() is forced truthy: these tests model a repo root, not a plain dir.
  trail.createTrailIntegration({ enabled: true, executable: async () => true, worktree: () => "/repo", run: command.run, logger: silentLogger, ...opts }).register(mock.pi as any);
  return { ...mock, ...command };
}
async function start(r: ReturnType<typeof register>, c = ctx(), reason = "startup") {
  await r.handlers.get("session_start")![0]({ reason }, c);
  return c;
}
const toolCall = (r: ReturnType<typeof register>, c: any, event: any) => r.handlers.get("tool_call")![0](event, c);
const toolResult = (r: ReturnType<typeof register>, c: any, event: any) => r.handlers.get("tool_result")![0](event, c);
const toolText = (text: string) => [{ type: "text", text }];
const blocked = (result: any) => result?.block === true;
const reasonOf = (result: any) => String(result?.reason ?? "");

/** Logger stub recording the turn-level events the query-shape tests assert on. */
function turnLog() {
  const enters: any[] = [];
  const exits: any[] = [];
  const logger = {
    debug() {},
    info(message: string, data: any) { if (message === "prompt_retrieval_enter") enters.push(data); else if (message === "prompt_retrieval_exit") exits.push(data); },
    warn() {}, error() {}, isDebugEnabled: () => false,
  };
  return { enters, exits, logger };
}
/** A realistic task prompt: multi-line and far longer than the 2000-char query clamp. */
function longTask(prefix = "") {
  const task = `${prefix}locate the authentication implementation and explain how sessions are validated\n${("see the session validator and its callers\n").repeat(60)}`;
  assert.ok(task.length > 2_100, `fixture must exceed the clamp (${task.length})`);
  return task;
}
const ASK_OUTPUT = JSON.stringify({ coverage: 0.9, hits: [{ title: "authenticate", pointer: "src/auth.ts:12", snippet: "validates sessions" }] });
const NODES = [{ id: "a", name: "authenticate", path: "src/auth.ts" }, { id: "b", name: "other", path: "src/other.ts" }];

describe("Automatic retrieval never satisfies the navigation gate", () => {
  it("blocks an indexed read and raw searches after auto-retrieval injected pointers", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      const event = promptEvent("locate the authentication implementation");
      await r.handlers.get("before_agent_start")![0](event, c);
      // Retrieval did run and did record a pointer for this turn...
      assert.match(event.systemPromptOptions.sections.trail, /src\/auth\.ts:12/);
      // ...yet an indexed file that is not an injected pointer stays blocked.
      const read = await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } });
      assert.equal(blocked(read), true);
      assert.match(reasonOf(read), /trail_find_code/);
      const grep = await toolCall(r, c, { toolName: "grep", input: { pattern: "authenticate" } });
      assert.equal(blocked(grep), true);
      assert.match(reasonOf(grep), /trail_find_code/);
      const shell = await toolCall(r, c, { toolName: "bash", input: { command: "rg authenticate src" } });
      assert.equal(blocked(shell), true);
      assert.match(reasonOf(shell), /trail_find_code/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("a trail_find_code result releases the gate for the turn and a new turn re-arms it", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }, { stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      assert.equal(blocked(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } })), true);
      await toolResult(r, c, { toolName: "trail_find_code", input: {}, content: toolText("src/auth.ts:12"), isError: false });
      // Same turn: every navigation form is released.
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined);
      assert.equal(await toolCall(r, c, { toolName: "grep", input: { pattern: "authenticate" } }), undefined);
      assert.equal(await toolCall(r, c, { toolName: "bash", input: { command: "rg authenticate" } }), undefined);
      // Next turn: armed again, no free ride from the previous turn's call.
      await r.handlers.get("before_agent_start")![0](promptEvent("now find the session validator"), c);
      const rearmed = await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } });
      assert.equal(blocked(rearmed), true);
      assert.match(reasonOf(rearmed), /trail_find_code/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("allows reading an injected pointer and that read satisfies the gate", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      // Consolidation: the pointer opens the gate for exactly that file...
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/auth.ts" } }), undefined);
      assert.equal(blocked(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } })), true);
      // ...and reading it (a successful result, no trail_* call) is enough.
      await toolResult(r, c, { toolName: "read", input: { path: "src/auth.ts" }, content: toolText("code"), isError: false });
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("never blocks a read of an unindexed file", async () => {
    const root = mapRoot(NODES);
    try {
      writeFileSync(join(root, "package.json"), "{}");
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs/README.md"), "# docs");
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      // Gate is armed (an indexed read is blocked), yet nothing else is.
      assert.equal(blocked(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } })), true);
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "package.json" } }), undefined);
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "docs/README.md" } }), undefined);
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/not-indexed.ts" } }), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Custom-message turns (a subagent task)", () => {
  it("injects this turn's pointers for a task prompt", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      const event = customEvent({ content: [{ type: "text", text: "locate the authentication implementation" }] });
      await r.handlers.get("before_agent_start")![0](event, c);
      assert.deepEqual(r.calls.map(call => call.args[0]), ["ask"], "a task prompt runs retrieval, it is not a control prompt");
      assert.match(event.systemPromptOptions.sections.trail, /src\/auth\.ts:12/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("arms the gate for a task prompt", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](customEvent({ content: [{ type: "text", text: "locate the authentication implementation" }] }), c);
      const read = await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } });
      assert.equal(blocked(read), true);
      assert.match(reasonOf(read), /trail_find_code/);
      assert.equal(blocked(await toolCall(r, c, { toolName: "grep", input: { pattern: "authenticate" } })), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts string content as the task prompt", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](customEvent({ content: "locate the authentication implementation" }), c);
      assert.deepEqual(r.calls.map(call => call.args[0]), ["ask"]);
      assert.equal(blocked(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } })), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("releases the gate after a trail_find_code result in a task turn", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](customEvent({ content: "locate the authentication implementation" }), c);
      assert.equal(blocked(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } })), true);
      await toolResult(r, c, { toolName: "trail_find_code", input: {}, content: toolText("src/auth.ts:12"), isError: false });
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps empty and slash-command custom messages on the control-prompt path", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      for (const message of [{ content: [] }, { content: "/compact now please" }, { content: [{ type: "image", data: "" }] }]) {
        const event = customEvent(message);
        await r.handlers.get("before_agent_start")![0](event, c);
        assert.match(event.systemPromptOptions.promptGuidelines.join("\n"), /trail_find_code/);
        assert.equal(event.systemPromptOptions.sections.trail, undefined);
        assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined);
      }
      assert.deepEqual(r.calls, [], "a control prompt spawns no retrieval subprocess");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Query clamping (a long prompt is a query, not an absence)", () => {
  it("runs retrieval, injects pointers and arms the gate for a 2100+ char user prompt", async () => {
    const root = mapRoot(NODES);
    try {
      const log = turnLog();
      const r = register({ logger: log.logger, results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      const event = promptEvent(longTask());
      await r.handlers.get("before_agent_start")![0](event, c);
      assert.equal(log.enters[0].querySource, "prompt");
      assert.ok(log.enters[0].queryLength > 1_500 && log.enters[0].queryLength <= 2_000, `the query is clamped, not dropped (${log.enters[0].queryLength})`);
      assert.deepEqual(r.calls.map(call => call.args[0]), ["ask"], "a long prompt still runs retrieval");
      assert.match(event.systemPromptOptions.sections.trail, /src\/auth\.ts:12/);
      assert.equal(blocked(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } })), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does the same for a 2100+ char custom (subagent task) message", async () => {
    const root = mapRoot(NODES);
    try {
      const log = turnLog();
      const r = register({ logger: log.logger, results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      const event = customEvent({ content: [{ type: "text", text: longTask() }] });
      await r.handlers.get("before_agent_start")![0](event, c);
      assert.equal(log.enters[0].querySource, "custom_message");
      assert.ok(log.enters[0].queryLength > 1_500 && log.enters[0].queryLength <= 2_000, `clamped (${log.enters[0].queryLength})`);
      assert.deepEqual(r.calls.map(call => call.args[0]), ["ask"]);
      assert.match(event.systemPromptOptions.sections.trail, /src\/auth\.ts:12/);
      assert.equal(blocked(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } })), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps a long slash-command prompt on the control path", async () => {
    const root = mapRoot(NODES);
    try {
      const log = turnLog();
      const r = register({ logger: log.logger, results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      const event = promptEvent(longTask("/compact "));
      await r.handlers.get("before_agent_start")![0](event, c);
      assert.equal(log.enters[0].querySource, "prompt");
      assert.equal(log.exits.at(-1)!.decision, "guidance_only_control_prompt");
      assert.deepEqual(r.calls, [], "a control prompt spawns no retrieval subprocess");
      assert.equal(event.systemPromptOptions.sections.trail, undefined);
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("never reports a queryLength above the clamp", async () => {
    const root = mapRoot(NODES);
    try {
      const log = turnLog();
      const r = register({ logger: log.logger, results: [{ stdout: ASK_OUTPUT }, { stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](promptEvent(longTask()), c);
      await r.handlers.get("before_agent_start")![0](customEvent({ content: longTask() }), c);
      assert.ok(log.enters.length === 2);
      for (const enter of log.enters) assert.ok(enter.queryLength > 0 && enter.queryLength <= 2_000, `queryLength ${enter.queryLength}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Navigation gate fails open", () => {
  it("does not block when the trail binary is missing", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ executable: async () => false });
      const c = await start(r, ctx(root));
      assert.equal(r.tools.size, 0);
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined);
      assert.equal(await toolCall(r, c, { toolName: "bash", input: { command: "rg authenticate" } }), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not block when the project has no map", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-behavior-nomap-"));
    try {
      const r = register();
      const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      assert.deepEqual(r.calls.map(call => call.args[0]), ["build"], "no map starts one background build, never a retrieval");
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined);
      assert.equal(await toolCall(r, c, { toolName: "grep", input: { pattern: "authenticate" } }), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not block when the project is untrusted", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root, false));
      assert.equal(r.tools.size, 0);
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined);
      assert.equal(await toolCall(r, c, { toolName: "bash", input: { command: "rg authenticate" } }), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not block when the setting disables Trail", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ setting: () => false, results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      assert.equal(r.tools.size, 0);
      await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      assert.deepEqual(r.calls, []);
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not block when automatic retrieval fails", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ code: 1, stderr: "boom" }] });
      const c = await start(r, ctx(root));
      const event = promptEvent("locate the authentication implementation");
      await r.handlers.get("before_agent_start")![0](event, c);
      assert.match(event.systemPromptOptions.sections.trail, /Retrieval failed/);
      assert.match(event.systemPromptOptions.sections.trail, /Raw navigation is available/);
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined);
      assert.equal(await toolCall(r, c, { toolName: "bash", input: { command: "rg authenticate" } }), undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Repo map tool and map layout", () => {
  it("runs trail_repo_map once and then redirects without a second CLI call", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: "map ok" }, { stdout: "must not run" }] });
      const c = await start(r, ctx(root));
      const first = await r.tools.get("trail_repo_map")!.execute("one", {}, undefined, undefined, c);
      assert.equal(first.content[0].text, "map ok");
      const second = await r.tools.get("trail_repo_map")!.execute("two", {}, undefined, undefined, c);
      assert.match(second.content[0].text, /trail_find_code/);
      assert.notEqual(second.content[0].text, "must not run");
      assert.deepEqual(r.calls.map(call => call.args), [["map", "--max-dirs", "16"]]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("trail wiring wins over a populated graft map", () => {
    const root = mapRoot([{ id: "g", name: "graft", path: "src/graft.ts" }], 3);
    try {
      mkdirSync(join(root, ".trail/cache/.graph"), { recursive: true });
      writeFileSync(join(root, ".trail/cache/.graph/wiring.json"), JSON.stringify({ meta: { nodeCount: 5 }, nodes: [] }));
      assert.equal(trail.trailMapDir(root, silentLogger), join(root, ".trail/cache"));
      assert.equal(trail.trailNodes(root, silentLogger), 5);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("resolves a graft-only repo as the legacy layout", () => {
    const root = mapRoot([{ id: "g", name: "graft", path: "src/graft.ts" }]);
    try {
      assert.equal(trail.trailMapDir(root, silentLogger), join(root, "graft"));
      assert.equal(trail.trailNodes(root, silentLogger), 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports no map when neither layout exists", () => {
    const root = mkdtempSync(join(tmpdir(), "trail-behavior-nolayout-"));
    try {
      assert.equal(trail.trailMapDir(root, silentLogger), null);
      assert.equal(trail.trailNodes(root, silentLogger), 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("falls back to a legacy graft map when .trail/cache exists without a wiring file", () => {
    const root = mapRoot([{ id: "g", name: "graft", path: "src/graft.ts" }, { id: "h", name: "h", path: "src/h.ts" }], 2);
    try {
      mkdirSync(join(root, ".trail/cache"), { recursive: true });
      // An empty cache directory is not a map: the usable legacy map must win.
      assert.equal(trail.trailMapDir(root, silentLogger), join(root, "graft"));
      assert.equal(trail.trailNodes(root, silentLogger), 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Worktree enablement", () => {
  for (const value of [false, true]) it(`a linked worktree without .pi settings inherits trail_enable:${value} from the main checkout`, () => {
    const main = mkdtempSync(join(tmpdir(), "trail-behavior-main-"));
    const worktree = linkedWorktree(main);
    try {
      settings(main, { trail_enable: value });
      clearSettingsCache();
      assert.equal(trail.trailEnabled(worktree, silentLogger), value);
    } finally { rmSync(worktree, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
  });

  it("keeps its own trail_enable outside a worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "trail-behavior-plain-"));
    try {
      settings(root, { trail_enable: false });
      clearSettingsCache();
      assert.equal(trail.trailEnabled(root, silentLogger), false);
      settings(root, { trail_enable: true });
      clearSettingsCache();
      assert.equal(trail.trailEnabled(root, silentLogger), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Session start never cold-builds", () => {
  it("performs zero build invocations for a repo with no map", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-behavior-nobuild-"));
    try {
      const r = register();
      await start(r, ctx(root));
      assert.deepEqual(r.calls, [], "no build, no probe, no retrieval at startup");
      assert.equal(r.calls.some(call => call.args[0] === "build"), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("leaves a map-less worktree whose main checkout has a map to the first query", async () => {
    const main = mapRoot(NODES);
    const worktree = linkedWorktree(main);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(worktree));
      assert.deepEqual(r.calls, [], "seeding is the query's job, never session_start's");
      await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      assert.deepEqual(r.calls.map(call => call.args[0]), ["ask"]);
      assert.equal(r.calls.some(call => call.args[0] === "build"), false);
    } finally { rmSync(worktree, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
  });
});

describe("Subagent toolset and status footer", () => {
  it("adds exactly the five read-only query tools", () => {
    const tools = trail.withTrailTools(["read"], true)!;
    assert.deepEqual(trail.TRAIL_QUERY_TOOLS, ["trail_find_code", "trail_find_all", "trail_file_api", "trail_trace_calls", "trail_repo_map"]);
    assert.deepEqual([...tools].sort(), ["read", ...trail.TRAIL_QUERY_TOOLS].sort());
    for (const never of ["trail_refresh", "trail_blast_radius"]) assert.equal(tools.includes(never), false, never);
  });

  it("returns the tool list unchanged when Trail is disabled", () => {
    assert.deepEqual(trail.withTrailTools(["read", "grep"], false), ["read", "grep"]);
    assert.equal(trail.withTrailTools(undefined, true), undefined);
  });

  it("leaves a child that declares no tool list unrestricted", () => {
    // `undefined` reaches the spawner as "no --tools flag", i.e. every tool
    // registered in the child session — the Trail query tools among them, since
    // registerTrail runs there too (see the production registration test).
    assert.equal(trail.withTrailTools(undefined, true), undefined);
    assert.equal(trail.withTrailTools(undefined, false), undefined);
  });

  it("formats the footer with the trail label and the node count", () => {
    const text = trail.formatTrailFooter({ state: "ready", nodeCount: 12, tokenSavings: 0 });
    assert.match(text, /trail/);
    assert.match(text, /12 nodes/);
    assert.match(text, /synced/);
    assert.match(trail.formatTrailFooter({ state: "absent", nodeCount: 0, tokenSavings: 0 }), /trail/);
  });

  it("parses trail savings and still tolerates the legacy graft footer", async () => {
    const trailRun = register({ graph: async () => "fresh" });
    const c1 = await start(trailRun, ctx(defaultRoot, true, "savings-trail"));
    await toolResult(trailRun, c1, { toolName: "trail_repo_map", input: {}, content: toolText("[trail] tokens saved ≈ 700"), isError: false });
    assert.match(c1.status.at(-1)?.text ?? "", /~700 tok saved/);
    const legacy = register({ graph: async () => "fresh" });
    const c2 = await start(legacy, ctx(defaultRoot, true, "savings-graft"));
    await toolResult(legacy, c2, { toolName: "trail_repo_map", input: {}, content: toolText("[graft] tokens saved ≈ 700"), isError: false });
    assert.match(c2.status.at(-1)?.text ?? "", /~700 tok saved/);
  });
});

describe("Shell search classification", () => {
  /** A repo with a map and one injected pointer: the gate is armed, no trail_* call yet. */
  async function armed() {
    const root = mapRoot(NODES);
    const r = register({ results: [{ stdout: ASK_OUTPUT }] });
    const c = await start(r, ctx(root));
    await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
    assert.equal(blocked(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } })), true, "the gate is armed");
    return { root, r, c };
  }

  for (const command of ["rg authenticate src", "grep -rn authenticate src", "find src -name '*.ts'", "fd authenticate", "cd src && rg authenticate", "FOO=1 rg authenticate", "/usr/bin/rg authenticate src", "git grep -n authenticate", "git -C src grep authenticate", "git --no-pager grep authenticate", "git -c core.pager=cat grep authenticate", "git -c x=y --no-pager grep authenticate", "env FOO=1 rg authenticate"]) {
    it(`blocks a first-segment search: ${command}`, async () => {
      const { root, r, c } = await armed();
      try {
        const result = await toolCall(r, c, { toolName: "bash", input: { command } });
        assert.equal(blocked(result), true);
        assert.match(reasonOf(result), /trail_find_code/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  for (const command of ["cat src/auth.ts | grep authenticate", "ps aux | grep pi", "git status --short", "git log --grep=authenticate", "git -C src log --oneline", "ls; grep authenticate", "echo rg", "cat src/auth.ts | /usr/bin/grep authenticate"]) {
    it(`never blocks a shell command that does not search first: ${command}`, async () => {
      const { root, r, c } = await armed();
      try {
        assert.equal(await toolCall(r, c, { toolName: "bash", input: { command } }), undefined);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

describe("Fresh checkout map build", () => {
  it("starts one background build on the first substantive prompt and fails that turn open", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-behavior-fresh-"));
    try {
      const log = turnLog();
      const r = register({ logger: log.logger });
      const c = await start(r, ctx(root));
      const event = promptEvent("locate the authentication implementation");
      await r.handlers.get("before_agent_start")![0](event, c);
      assert.deepEqual(r.calls.map(call => call.args[0]), ["build"], "one bounded build, no retrieval");
      assert.equal(log.exits.at(-1)!.decision, "graph_building");
      assert.ok(c.status.some(status => /syncing/.test(status.text ?? "")), "the footer says the map is being built");
      assert.match(event.systemPromptOptions.sections.trail, /trail build/);
      assert.match(event.systemPromptOptions.sections.trail, /trail_find_code/);
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined, "fail open while it builds");
      // A second prompt never starts a second build.
      await r.handlers.get("before_agent_start")![0](promptEvent("locate the authentication implementation"), c);
      assert.equal(r.calls.filter(call => call.args[0] === "build").length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps a control prompt from starting a build", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-behavior-fresh-control-"));
    try {
      const r = register();
      const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](promptEvent("yes"), c);
      assert.deepEqual(r.calls, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("builds in a worktree whose main checkout is on trail but has no wiring file", async () => {
    const main = mkdtempSync(join(tmpdir(), "trail-behavior-pending-main-"));
    const worktree = linkedWorktree(main);
    try {
      // ".trail/cache" only marks a checkout on trail; without a wiring file
      // there is no map to seed from, so this worktree must build its own.
      mkdirSync(join(main, ".trail/cache"), { recursive: true });
      const log = turnLog();
      const r = register({ logger: log.logger });
      const c = await start(r, ctx(worktree));
      const event = promptEvent("locate the authentication implementation");
      await r.handlers.get("before_agent_start")![0](event, c);
      assert.deepEqual(r.calls.map(call => call.args[0]), ["build"], "one background build, never a seed of a map that does not exist");
      assert.equal(log.exits.at(-1)!.decision, "graph_building");
      assert.match(event.systemPromptOptions.sections.trail, /trail build/);
      assert.equal(await toolCall(r, c, { toolName: "read", input: { path: "src/other.ts" } }), undefined, "the turn fails open");
      assert.equal(await toolCall(r, c, { toolName: "bash", input: { command: "rg authenticate" } }), undefined, "no gate is armed");
    } finally { rmSync(worktree, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
  });
});

describe("Query fallback for long prompts", () => {
  it("retries once with the first sentence when the clamped query finds nothing", async () => {
    const root = mapRoot(NODES);
    try {
      const log = turnLog();
      const r = register({ logger: log.logger, results: [{ stdout: JSON.stringify({ hits: [] }) }, { stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      const event = promptEvent(longTask());
      await r.handlers.get("before_agent_start")![0](event, c);
      const asks = r.calls.filter(call => call.args[0] === "ask");
      assert.equal(asks.length, 2, "one clamped attempt plus one keyword-shaped fallback");
      const fallback = String(asks[1]!.args[1]);
      assert.ok(fallback.length <= 200, `the fallback stays keyword-shaped (${fallback.length})`);
      assert.ok(fallback.startsWith("locate the authentication implementation"), fallback);
      assert.match(event.systemPromptOptions.sections.trail, /src\/auth\.ts:12/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not retry when the first attempt fails", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ code: 1, stderr: "boom" }] });
      const c = await start(r, ctx(root));
      await r.handlers.get("before_agent_start")![0](promptEvent(longTask()), c);
      assert.equal(r.calls.filter(call => call.args[0] === "ask").length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Injection without structured prompt options", () => {
  it("returns the guidance and hits as a replacement system prompt", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register({ results: [{ stdout: ASK_OUTPUT }] });
      const c = await start(r, ctx(root));
      // No systemPromptOptions: another extension forced the prompt.
      const event = { messageType: "user", prompt: "locate the authentication implementation", systemPrompt: "base prompt" };
      const result = await r.handlers.get("before_agent_start")![0](event, c);
      assert.match(result.systemPrompt, /^base prompt/);
      assert.match(result.systemPrompt, /trail_find_code/);
      assert.match(result.systemPrompt, /src\/auth\.ts:12/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps the guidance for a control prompt too", async () => {
    const root = mapRoot(NODES);
    try {
      const r = register();
      const c = await start(r, ctx(root));
      const result = await r.handlers.get("before_agent_start")![0]({ messageType: "user", prompt: "yes", systemPrompt: "base" }, c);
      assert.match(result.systemPrompt, /trail_find_code/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Production registration (registerTrail)", () => {
  it("registers the tools and every handler through the real entry point", async () => {
    const root = mkdtempSync(join(tmpdir(), "trail-behavior-register-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      settings(root, { trail_enable: true });
      clearSettingsCache();
      const mock = mockPi();
      trail.registerTrail(mock.pi as any);
      // print mode keeps this test off the real trail binary: it is the one
      // startup shape that skips the probe while still registering the tools.
      const c = { ...ctx(root), mode: "print" };
      await mock.handlers.get("session_start")![0]({ reason: "startup" }, c);
      assert.deepEqual([...mock.tools.keys()].sort(), ["trail_blast_radius", "trail_file_api", "trail_find_all", "trail_find_code", "trail_refresh", "trail_repo_map", "trail_trace_calls"]);
      for (const name of ["session_start", "tool_call", "tool_result", "before_agent_start", "session_shutdown"]) assert.ok(mock.handlers.get(name)?.length, `${name} handler is wired`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Worktree kill switch", () => {
  it("honours a linked worktree's own trail_enable:false over the main checkout", () => {
    const main = mkdtempSync(join(tmpdir(), "trail-behavior-kill-main-"));
    const worktree = linkedWorktree(main);
    try {
      settings(main, { trail_enable: true });
      settings(worktree, { trail_enable: false });
      clearSettingsCache();
      assert.equal(trail.trailEnabled(worktree, silentLogger), false);
      settings(worktree, { trail_enable: true });
      clearSettingsCache();
      assert.equal(trail.trailEnabled(worktree, silentLogger), true);
    } finally { rmSync(worktree, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
  });
});

describe("Tool classification for read accounting", () => {
  it("classifies trail_* tools as Trail reads", () => {
    assert.equal(trail.classifyToolUse("trail_find_code", {}), "trail");
    assert.equal(trail.classifyToolUse("trail_trace_calls", {}), "trail");
  });

  it("classifies source-reading tools as source reads", () => {
    for (const tool of ["read", "grep", "find", "ls"]) assert.equal(trail.classifyToolUse(tool, {}), "source", tool);
  });

  it("classifies a shell command running the trail binary as a Trail read", () => {
    assert.equal(trail.classifyToolUse("bash", { command: "trail ask authentication" }), "trail");
    assert.equal(trail.classifyToolUse("bash", { command: "cd src && trail find_code auth" }), "trail");
  });

  it("classifies anything else as neither", () => {
    assert.equal(trail.classifyToolUse("bash", { command: "rg authenticate" }), null);
    assert.equal(trail.classifyToolUse("write", {}), null);
    assert.equal(trail.classifyToolUse("edit", {}), null);
    assert.equal(trail.classifyToolUse("graft_find_code", {}), null);
  });
});

describe("Enablement callback logger", () => {
  it("hands the integration logger to the setting callback", async () => {
    const root = mapRoot(NODES);
    try {
      const seen: unknown[] = [];
      const stub = { debug() {}, info() {}, warn() {}, error() {}, isDebugEnabled: () => false };
      const r = register({ logger: stub, setting: (_cwd: string, logger?: unknown) => { seen.push(logger); return true; } });
      await start(r, ctx(root));
      assert.deepEqual(seen, [stub], "a `setting: trailEnabled` caller inherits the injected logger");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
