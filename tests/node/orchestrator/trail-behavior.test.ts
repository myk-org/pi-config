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
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as trail from "../../../extensions/orchestrator/trail.js";
import { clearSettingsCache, setGlobalSettingsPath } from "../../../extensions/orchestrator/project-settings.js";

type TrailRun = (args: readonly string[], opts: { cwd: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>;
type Handler = (event: any, ctx: any) => Promise<any> | any;
type Tool = { name: string; execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };

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
  trail.createTrailIntegration({ enabled: true, executable: async () => true, worktree: () => "/repo", run: command.run, ...opts }).register(mock.pi as any);
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
      assert.deepEqual(r.calls, [], "no map means no retrieval subprocess either");
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

  it("prefers .trail/cache over a legacy graft map", () => {
    const root = mapRoot([{ id: "g", name: "graft", path: "src/graft.ts" }], 3);
    try {
      mkdirSync(join(root, ".trail/cache/.graph"), { recursive: true });
      writeFileSync(join(root, ".trail/cache/.graph/wiring.json"), JSON.stringify({ meta: { nodeCount: 5 }, nodes: [] }));
      assert.equal(trail.trailMapDir(root), join(root, ".trail/cache"));
      assert.equal(trail.trailNodes(root), 5);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("resolves a graft-only repo as the legacy layout", () => {
    const root = mapRoot([{ id: "g", name: "graft", path: "src/graft.ts" }]);
    try {
      assert.equal(trail.trailMapDir(root), join(root, "graft"));
      assert.equal(trail.trailNodes(root), 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reports no map when neither layout exists", () => {
    const root = mkdtempSync(join(tmpdir(), "trail-behavior-nolayout-"));
    try {
      assert.equal(trail.trailMapDir(root), null);
      assert.equal(trail.trailNodes(root), 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not fall back to graft when .trail/cache exists without a wiring file", () => {
    const root = mapRoot([{ id: "g", name: "graft", path: "src/graft.ts" }, { id: "h", name: "h", path: "src/h.ts" }], 2);
    try {
      mkdirSync(join(root, ".trail/cache"), { recursive: true });
      // Being "on trail" wins: the stale legacy map must not be read behind it.
      assert.equal(trail.trailMapDir(root), join(root, ".trail/cache"));
      assert.equal(trail.trailNodes(root), 0);
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
      assert.equal(trail.trailEnabled(worktree), value);
    } finally { rmSync(worktree, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
  });

  it("keeps its own trail_enable outside a worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "trail-behavior-plain-"));
    try {
      settings(root, { trail_enable: false });
      clearSettingsCache();
      assert.equal(trail.trailEnabled(root), false);
      settings(root, { trail_enable: true });
      clearSettingsCache();
      assert.equal(trail.trailEnabled(root), true);
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
