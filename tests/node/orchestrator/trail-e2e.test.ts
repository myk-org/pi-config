/**
 * Trail #978 against the REAL `trail` binary: no injected `run`, no fixture map,
 * no fixture ask output. Every other trail suite stubs the subprocess, so this is
 * the only file that proves the integration still matches the live CLI (pointer
 * shape, `build` output location, `ask --json --source` payload).
 *
 * Run: env -u PI_SUBAGENT_CHILD npx tsx --test tests/node/orchestrator/trail-e2e.test.ts
 * Skipped (not failed) when the binary is absent: it is a developer/CI-installed
 * prerequisite, not a repository dependency.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrailIntegration } from "../../../extensions/orchestrator/trail.js";

type Handler = (event: any, ctx: any) => Promise<any> | any;
type Tool = { name: string; execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }> };

/** `false` when the real binary answers, otherwise node:test's skip reason. */
function skipReason(): false | string {
  try {
    execFileSync("trail", ["--version"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
    return false;
  } catch { return "trail binary not installed"; }
}
const SKIP = skipReason();

/** Logger stub: captures the turn-level decisions, never writes ~/.pi/logs/trail. */
function eventLog() {
  const enters: any[] = [];
  const exits: any[] = [];
  const logger = {
    debug() {}, warn() {}, error() {}, isDebugEnabled: () => false,
    info(message: string, data: any) {
      if (message === "prompt_retrieval_enter") enters.push(data);
      else if (message === "prompt_retrieval_exit") exits.push(data);
    },
  };
  return { enters, exits, logger };
}
function mockPi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  return {
    pi: {
      events: { emit() {} },
      on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
      registerTool(tool: Tool) { tools.set(tool.name, tool); },
    },
    handlers,
    tools,
  };
}
/**
 * Three real TypeScript files with a real call chain (`handler` -> `authenticate`
 * -> `verifyToken`). Git-less on purpose: the integration gates on a resolved
 * worktree root, which the test supplies explicitly.
 */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "trail-e2e-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/auth.ts"), [
    "export type Claims = { sub: string };",
    "",
    "export function verifyToken(token: string): Claims | null {",
    '  if (!token.startsWith("tok_")) return null;',
    "  return { sub: token.slice(4) };",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src/session.ts"), [
    'import { verifyToken } from "./auth.js";',
    "",
    "export function authenticate(token: string): string | null {",
    "  const claims = verifyToken(token);",
    "  return claims ? claims.sub : null;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(root, "src/server.ts"), [
    'import { authenticate } from "./session.js";',
    "",
    "export const handler = (token: string) => authenticate(token);",
    "",
  ].join("\n"));
  // Indexed but unrelated to the auth query, so it is never an injected pointer.
  writeFileSync(join(root, "src/format.ts"), [
    "export function formatTotal(value: number): string {",
    '  return `${value.toFixed(2)} B`;',
    "}",
    "",
  ].join("\n"));
  return root;
}
/** The map file, in either layout the integration accepts. Fails with the CLI's stderr, never silently. */
function assertBuild(root: string): string {
  try {
    execFileSync("trail", ["build", "."], { cwd: root, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error: any) {
    assert.fail(`trail build failed (exit ${error?.status ?? "?"}): ${String(error?.stderr || error?.message || "").trim()}`);
  }
  for (const rel of [".trail/cache/.graph/wiring.json", "graft/.graph/wiring.json"]) {
    if (existsSync(join(root, rel))) return join(root, rel);
  }
  assert.fail("trail build produced no wiring.json in .trail/cache/ or graft/");
}
function ctx(root: string) {
  const status: Array<{ key: string; text: string | undefined }> = [];
  return { cwd: root, status, sessionManager: { getSessionId: () => "trail-e2e-session" }, isProjectTrusted: () => true, ui: { setStatus: (key: string, text: string | undefined) => status.push({ key, text }) } };
}
/** Structured prompt options, exactly what Pi hands a real extension. */
function promptEvent(prompt: string) {
  return {
    messageType: "user",
    prompt,
    systemPrompt: "base",
    systemPromptOptions: {
      selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [],
      appendSystemPrompt: "", sections: {} as Record<string, string | undefined>, contextFiles: [], skills: [], cwd: "/repo",
    },
  };
}
const PROMPT = "explain how verifyToken validates an auth token and where authenticate calls it";
const blocked = (result: any) => result?.block === true;

describe("Real `trail` binary end-to-end", { skip: SKIP }, () => {
  it("builds a map, injects live file:line pointers and gates a real search until real retrieval runs", async () => {
    const started = Date.now();
    const root = fixtureRepo();
    try {
      const wiring = assertBuild(root);
      const map = JSON.parse(readFileSync(wiring, "utf8")) as { nodes?: Array<{ path: string }> };
      assert.ok(map.nodes?.some(node => node.path === "src/auth.ts"), "the real map indexes src/auth.ts");

      const log = eventLog();
      const mock = mockPi();
      // No `run`, no `graph`, no `retrieve`: the default code paths, i.e. the CLI.
      createTrailIntegration({ enabled: true, worktree: () => root, logger: log.logger, interactiveTimeoutMs: 30_000 }).register(mock.pi as any);
      const c = ctx(root);
      await mock.handlers.get("session_start")![0]({ reason: "startup" }, c);
      assert.match(c.status.at(-1)?.text ?? "", /✓ synced/, "session_start reports the freshly built map as ready");

      const event = promptEvent(PROMPT);
      await mock.handlers.get("before_agent_start")![0](event, c);
      assert.equal(log.exits.at(-1)?.decision, "injected", "the real `trail ask` returned hits for this prompt");
      assert.equal(log.enters.at(-1)?.querySource, "prompt");
      const section = String(event.systemPromptOptions.sections.trail ?? "");
      // Real CLI pointer shape (`src/auth.ts:L3-L6`), not the stubbed `path:12`.
      assert.match(section, /src\/auth\.ts:L?\d+/, "the injected section carries a live file:line pointer for the file");
      assert.match(event.systemPromptOptions.promptGuidelines.join("\n"), /trail_find_code/);
      assert.match(c.status.at(-1)?.text ?? "", /✓ synced/, "state is ready after a successful retrieval");

      // Gate armed by retrieval, not by a fixture: a real search shape is blocked.
      const search = { toolName: "bash", input: { command: "rg verifyToken ." } };
      const before = await mock.handlers.get("tool_call")![0](search, c);
      assert.equal(blocked(before), true, "bash rg is blocked while the gate is armed");
      assert.match(String(before.reason), /trail_find_code/);

      // Run the REAL registered tool against the REAL map, then feed its result back.
      const retrieval = await mock.tools.get("trail_find_code")!.execute("call-1", { query: "verifyToken" });
      assert.match(retrieval.content[0]!.text, /src\/auth\.ts:L?\d+/, "the live trail_find_code tool returns a file:line pointer");
      await mock.handlers.get("tool_result")![0]({ toolName: "trail_find_code", input: { query: "verifyToken" }, content: retrieval.content, isError: false }, c);

      assert.equal(await mock.handlers.get("tool_call")![0](search, c), undefined, "the same real search is allowed once retrieval ran");
      assert.ok(Date.now() - started < 60_000, "real build + retrieval stays well inside the test budget");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Qodo round 4: the live CLI emits `src/auth.ts:L3-L6`, and the gate must
   * recognise the file that this turn's own retrieval just injected.
   */
  it("allows reading a file this turn's own retrieval injected", async () => {
    const root = fixtureRepo();
    try {
      assertBuild(root);
      const log = eventLog();
      const mock = mockPi();
      createTrailIntegration({ enabled: true, worktree: () => root, logger: log.logger, interactiveTimeoutMs: 30_000 }).register(mock.pi as any);
      const c = ctx(root);
      await mock.handlers.get("session_start")![0]({ reason: "startup" }, c);
      await mock.handlers.get("before_agent_start")![0](promptEvent(PROMPT), c);
      assert.equal(log.exits.at(-1)?.decision, "injected");
      // The gate is armed: an indexed file the retrieval did not point at is blocked.
      const unrelated = await mock.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "src/format.ts" } }, c);
      assert.equal(blocked(unrelated), true, "an indexed file outside this turn's pointers is still blocked");
      // The live pointer shape (`src/auth.ts:L3-L6`) opens the file it names.
      const read = await mock.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "src/auth.ts" } }, c);
      assert.equal(read, undefined, "the injected pointer is readable without a detour through trail_find_code");
      // And that read is enough to satisfy the gate for the turn.
      await mock.handlers.get("tool_result")![0]({ toolName: "read", input: { path: "src/auth.ts" }, content: [{ type: "text", text: "code" }], isError: false }, c);
      assert.equal(await mock.handlers.get("tool_call")![0]({ toolName: "read", input: { path: "src/format.ts" } }, c), undefined, "reading an injected pointer releases the gate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
