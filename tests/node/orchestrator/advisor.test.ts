import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import {
  ADVISOR_ALLOWED_TOOLS,
  buildAdvisorContext,
  isAdvisorEligible,
  parseAdvisorResponse,
  registerAdvisor,
  resolveAdvisorModel,
  type AdvisorCheckSummary,
} from "../../../extensions/orchestrator/advisor.ts";
import {
  SETTINGS_KEYS,
  clearSettingsCache,
  parseAdvisorModelSpec,
  parseSettingInput,
  setGlobalSettingsPath,
  validateSetting,
} from "../../../extensions/orchestrator/project-settings.ts";
import { resolveModelKeySubmenu } from "../../../extensions/orchestrator/settings-tui-helpers.ts";

type Handler = (event: any, ctx: any) => any;

function createMockPi() {
  const handlers = new Map<string, Handler[]>();
  const pi: any = {
    on(name: string, fn: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
      return () => {
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
  };
  async function fire(name: string, event: any, ctx: any) {
    let lastResult: any;
    for (const fn of handlers.get(name) ?? []) {
      const res = await fn(event, ctx);
      if (res !== undefined) lastResult = res;
    }
    return lastResult;
  }
  return { pi, fire };
}

function makeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  } as unknown as Model<Api>;
}

function makeAssistantResponse(
  text: string,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "google",
    model: "gemini-2.5-flash",
    usage: {
      input: 400,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 430,
      cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  } as AssistantMessage;
}

describe("advisor / watchdog (#1419)", () => {
  let tmpRoot: string;
  let globalSettingsFile: string;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "PI_SUBAGENT_CHILD",
    "PI_COMS_SUPERVISED_PEER",
    "PI_ADVISOR_ENABLED",
    "PI_ADVISOR_MODEL",
    "PI_ADVISOR_INTERVAL_TURNS",
    "PI_ADVISOR_ALLOW_HEADLESS",
  ];

  function writeProjectSettings(data: Record<string, unknown>) {
    mkdirSync(join(tmpRoot, ".pi"), { recursive: true });
    writeFileSync(join(tmpRoot, ".pi", "pi-config-settings.json"), JSON.stringify(data));
    clearSettingsCache();
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-advisor-test-"));
    globalSettingsFile = join(tmpRoot, "global-settings.json");
    setGlobalSettingsPath(globalSettingsFile);
    clearSettingsCache();
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("settings schema, validation, and TUI picker", () => {
    it("declares advisor settings in settings-keys.json with advisor_enabled defaulting to false", () => {
      assert.equal(SETTINGS_KEYS.advisor_enabled?.type, "bool");
      assert.equal(SETTINGS_KEYS.advisor_enabled?.default, false);
      assert.equal(SETTINGS_KEYS.advisor_enabled?.env, "PI_ADVISOR_ENABLED");
      assert.equal(SETTINGS_KEYS.advisor_enabled?.group, "Review");

      assert.equal(SETTINGS_KEYS.advisor_model?.type, "string");
      assert.equal(SETTINGS_KEYS.advisor_model?.default, "");
      assert.equal(SETTINGS_KEYS.advisor_model?.env, "PI_ADVISOR_MODEL");
      assert.equal(SETTINGS_KEYS.advisor_model?.group, "Review");

      assert.equal(SETTINGS_KEYS.advisor_interval_turns?.type, "int");
      assert.equal(SETTINGS_KEYS.advisor_interval_turns?.default, 5);
      assert.equal(SETTINGS_KEYS.advisor_interval_turns?.min, 1);
      assert.equal(SETTINGS_KEYS.advisor_interval_turns?.max, 50);
      assert.equal(SETTINGS_KEYS.advisor_interval_turns?.env, "PI_ADVISOR_INTERVAL_TURNS");
      assert.equal(SETTINGS_KEYS.advisor_interval_turns?.group, "Review");
    });

    it("validates advisor_model as empty or explicit provider/model-id", () => {
      assert.deepEqual(parseAdvisorModelSpec("google/gemini-2.5-flash"), {
        provider: "google",
        model: "gemini-2.5-flash",
      });
      assert.deepEqual(parseAdvisorModelSpec("openrouter/anthropic/claude-sonnet-4-5"), {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-5",
      });

      assert.deepEqual(validateSetting("advisor_model", ""), { ok: true, value: "" });
      assert.deepEqual(validateSetting("advisor_model", "  anthropic/claude-sonnet-4-5  "), {
        ok: true,
        value: "anthropic/claude-sonnet-4-5",
      });
      assert.deepEqual(parseSettingInput("advisor_model", "(empty)"), { ok: true, value: "" });

      for (const bad of ["gemini-2.5-flash", "/gemini", "google/", "google//flash", "google/flash/", "google/my model"]) {
        assert.equal(parseAdvisorModelSpec(bad), null, `should reject "${bad}"`);
        assert.equal(validateSetting("advisor_model", bad).ok, false, `validateSetting should reject "${bad}"`);
      }
    });

    it("formats advisor_model items as provider/model-id in /pi-config-settings picker", () => {
      const submenu = resolveModelKeySubmenu("advisor_model", [
        { value: "claude-sonnet-4-5", label: "claude-sonnet-4-5", description: "anthropic" },
        { value: "gemini-2.5-flash", label: "gemini-2.5-flash", description: "google" },
      ]);
      assert.equal(submenu.mode, "picker");
      assert.deepEqual(
        submenu.models.map((m) => m.value),
        ["", "anthropic/claude-sonnet-4-5", "google/gemini-2.5-flash"],
      );

      const emptySubmenu = resolveModelKeySubmenu("advisor_model", []);
      assert.equal(emptySubmenu.mode, "input");
    });
  });

  describe("eligibility & model resolution", () => {
    it("is disabled by default and skips subagents and headless/RPC unless opted in", () => {
      const tuiCtx = { hasUI: true, mode: "tui" };
      assert.deepEqual(isAdvisorEligible(tmpRoot, tuiCtx), { eligible: false, reason: "disabled" });

      writeProjectSettings({ advisor_enabled: true });
      assert.deepEqual(isAdvisorEligible(tmpRoot, tuiCtx), { eligible: true });

      // Subagent always skipped
      process.env.PI_SUBAGENT_CHILD = "1";
      assert.deepEqual(isAdvisorEligible(tmpRoot, tuiCtx, { allowHeadless: true }), {
        eligible: false,
        reason: "subagent",
      });
      delete process.env.PI_SUBAGENT_CHILD;

      // RPC / headless skipped by default
      assert.deepEqual(isAdvisorEligible(tmpRoot, { hasUI: true, mode: "rpc" }), {
        eligible: false,
        reason: "headless_or_rpc",
      });
      assert.deepEqual(isAdvisorEligible(tmpRoot, { hasUI: false, mode: "print" }), {
        eligible: false,
        reason: "headless_or_rpc",
      });
      process.env.PI_COMS_SUPERVISED_PEER = "1";
      assert.deepEqual(isAdvisorEligible(tmpRoot, tuiCtx), {
        eligible: false,
        reason: "headless_or_rpc",
      });

      // Explicit opt-in enables headless/RPC
      process.env.PI_ADVISOR_ALLOW_HEADLESS = "1";
      assert.deepEqual(isAdvisorEligible(tmpRoot, { hasUI: true, mode: "rpc" }), { eligible: true });
    });

    it("resolves explicit provider/model-id via modelRegistry or inherits session model", () => {
      const sessionModel = makeModel("anthropic", "claude-opus-4-6");
      const flashModel = makeModel("google", "gemini-2.5-flash");
      const registry = {
        find: (p: string, id: string) =>
          p === "google" && id === "gemini-2.5-flash" ? flashModel : undefined,
        hasConfiguredAuth: () => true,
      };

      // Empty setting -> session model
      const inherited = resolveAdvisorModel(tmpRoot, sessionModel, registry, "");
      assert.equal(inherited.ok, true);
      if (inherited.ok) {
        assert.equal(inherited.source, "session");
        assert.equal(inherited.model.id, "claude-opus-4-6");
      }

      // Explicit provider/model-id -> registry model
      const explicit = resolveAdvisorModel(tmpRoot, sessionModel, registry, "google/gemini-2.5-flash");
      assert.equal(explicit.ok, true);
      if (explicit.ok) {
        assert.equal(explicit.source, "setting");
        assert.equal(explicit.model.id, "gemini-2.5-flash");
      }

      // Unknown model -> fail-soft
      const missing = resolveAdvisorModel(tmpRoot, sessionModel, registry, "google/nonexistent");
      assert.deepEqual(missing, {
        ok: false,
        reason: "model_not_found",
        requested: "google/nonexistent",
      });

      // Missing auth -> fail-soft
      const noAuth = resolveAdvisorModel(
        tmpRoot,
        sessionModel,
        { ...registry, hasConfiguredAuth: () => false },
        "google/gemini-2.5-flash",
      );
      assert.deepEqual(noAuth, {
        ok: false,
        reason: "auth_missing",
        requested: "google/gemini-2.5-flash",
      });
    });
  });

  describe("read-only context & response parsing", () => {
    it("mechanically omits tools from advisor context (strictly read-only)", () => {
      assert.equal(ADVISOR_ALLOWED_TOOLS.length, 0);
      const context = buildAdvisorContext("Fix bug in parser", [
        {
          seq: 1,
          turnIndex: 0,
          outcome: "completed",
          assistantSnippet: "Edited parser.ts",
          tools: [{ name: "edit", isError: false, snippet: "ok" }],
          hadError: false,
        },
      ]);
      assert.equal(context.tools, undefined);
      assert.equal(context.messages.length, 1);
      assert.ok(String(context.messages[0]!.content).includes("<transcript_delta>"));
    });

    it("parses clean verdicts silently and extracts structured advice notes", () => {
      assert.deepEqual(parseAdvisorResponse(""), { status: "clean" });
      assert.deepEqual(parseAdvisorResponse("CLEAN"), { status: "clean" });
      assert.deepEqual(parseAdvisorResponse('{"status":"clean"}'), { status: "clean" });
      assert.deepEqual(parseAdvisorResponse('```json\n{"status":"clean"}\n```'), { status: "clean" });

      assert.deepEqual(
        parseAdvisorResponse('{"status":"advise","category":"bug","note":"Null check missing on line 42."}'),
        { status: "advise", category: "bug", note: "Null check missing on line 42." },
      );
      assert.deepEqual(
        parseAdvisorResponse('```json\n{"status":"advise","category":"loop","note":"Stop retrying same command."}\n```'),
        { status: "advise", category: "loop", note: "Stop retrying same command." },
      );
    });
  });

  describe("runtime lifecycle (cadence, silence-on-clean, injection, fail-soft)", () => {
    it("makes zero calls when advisor_enabled is false (default)", async () => {
      let calls = 0;
      const { pi, fire } = createMockPi();
      registerAdvisor(pi, {
        completeFn: async () => {
          calls += 1;
          return makeAssistantResponse('{"status":"clean"}');
        },
      });

      const ctx = {
        cwd: tmpRoot,
        hasUI: true,
        mode: "tui",
        model: makeModel("google", "gemini-2.5-flash"),
        sessionManager: { getSessionId: () => "adv-default-off" },
      };

      for (let i = 0; i < 10; i += 1) {
        await fire("turn_end", { turnIndex: i, outcome: "completed", message: { content: "hi" } }, ctx);
      }
      assert.equal(calls, 0);
    });

    it("respects advisor_interval_turns, passes zero tools, stays silent on clean, and injects hidden note on advise", async () => {
      writeProjectSettings({
        advisor_enabled: true,
        advisor_model: "google/gemini-2.5-flash",
        advisor_interval_turns: 3,
      });

      const flashModel = makeModel("google", "gemini-2.5-flash");
      const sessionModel = makeModel("anthropic", "claude-opus-4-6");
      const capturedCalls: Array<{ model: Model<Api>; context: Context }> = [];
      let nextResponse = '{"status":"clean"}';
      let settledResolve: ((s: AdvisorCheckSummary) => void) | null = null;
      const waitSettled = () =>
        new Promise<AdvisorCheckSummary>((resolve) => {
          settledResolve = resolve;
        });

      const { pi, fire } = createMockPi();
      registerAdvisor(pi, {
        completeFn: async (model, context) => {
          capturedCalls.push({ model, context });
          return makeAssistantResponse(nextResponse);
        },
        onCheckSettled: (summary) => {
          settledResolve?.(summary);
          settledResolve = null;
        },
      });

      const ctx = {
        cwd: tmpRoot,
        hasUI: true,
        mode: "tui",
        model: sessionModel,
        modelRegistry: {
          find: (p: string, id: string) =>
            p === "google" && id === "gemini-2.5-flash" ? flashModel : undefined,
          hasConfiguredAuth: () => true,
        },
        sessionManager: { getSessionId: () => "adv-cadence" },
      };

      await fire("before_agent_start", { messageType: "user", prompt: "Implement feature X" }, ctx);

      // Turns 1 & 2: below cadence of 3 -> no call
      await fire("turn_end", { turnIndex: 0, outcome: "completed", message: { content: "Step 1" } }, ctx);
      await fire("turn_end", { turnIndex: 1, outcome: "completed", message: { content: "Step 2" } }, ctx);
      assert.equal(capturedCalls.length, 0);

      // Turn 3: hits cadence -> triggers non-blocking check returning CLEAN
      const p1 = waitSettled();
      await fire("turn_end", { turnIndex: 2, outcome: "completed", message: { content: "Step 3" } }, ctx);
      const s1 = await p1;
      assert.equal(s1.status, "clean");
      assert.equal(s1.triggerReason, "interval");
      assert.equal(capturedCalls.length, 1);
      assert.equal(capturedCalls[0]!.model.provider, "google");
      assert.equal(capturedCalls[0]!.model.id, "gemini-2.5-flash");
      assert.equal(capturedCalls[0]!.context.tools, undefined);

      // Silence-on-clean: next before_agent_start injects nothing
      const cleanStart = await fire("before_agent_start", { messageType: "user", prompt: "Continue" }, ctx);
      assert.equal(cleanStart, undefined);

      // Next 3 turns -> advisor returns concrete course correction
      nextResponse = '{"status":"advise","category":"drift","note":"You are editing the wrong file path."}';
      await fire("turn_end", { turnIndex: 3, outcome: "completed", message: { content: "Step 4" } }, ctx);
      await fire("turn_end", { turnIndex: 4, outcome: "completed", message: { content: "Step 5" } }, ctx);
      const p2 = waitSettled();
      await fire("turn_end", { turnIndex: 5, outcome: "completed", message: { content: "Step 6" } }, ctx);
      const s2 = await p2;
      assert.equal(s2.status, "advise");
      assert.equal(s2.category, "drift");

      // Next before_agent_start delivers hidden note once (does not mutate systemPrompt)
      const advisedStart = await fire(
        "before_agent_start",
        { messageType: "user", prompt: "Next step", systemPrompt: "STABLE" },
        ctx,
      );
      assert.equal(advisedStart?.systemPrompt, undefined);
      assert.equal(advisedStart?.message?.customType, "advisor-watchdog-note");
      assert.equal(advisedStart?.message?.display, false);
      assert.match(advisedStart?.message?.content ?? "", /\[Background Advisor Note \(drift\)\]/);
      assert.match(advisedStart?.message?.content ?? "", /wrong file path/);

      // Consumed: subsequent turn does not re-inject
      const afterStart = await fire("before_agent_start", { messageType: "user", prompt: "After" }, ctx);
      assert.equal(afterStart, undefined);
    });

    it("triggers early on consecutive error/retry loops", async () => {
      writeProjectSettings({
        advisor_enabled: true,
        advisor_interval_turns: 20,
      });

      let settledResolve: ((s: AdvisorCheckSummary) => void) | null = null;
      const p = new Promise<AdvisorCheckSummary>((r) => {
        settledResolve = r;
      });

      const { pi, fire } = createMockPi();
      registerAdvisor(pi, {
        errorLoopThreshold: 3,
        completeFn: async () =>
          makeAssistantResponse('{"status":"advise","category":"loop","note":"Same test failing 3x; inspect root cause."}'),
        onCheckSettled: (s) => settledResolve?.(s),
      });

      const ctx = {
        cwd: tmpRoot,
        hasUI: true,
        mode: "tui",
        model: makeModel("google", "gemini-2.5-flash"),
        sessionManager: { getSessionId: () => "adv-loop" },
      };

      for (let i = 0; i < 3; i += 1) {
        await fire(
          "turn_end",
          {
            turnIndex: i,
            outcome: "completed",
            message: { content: "Retrying command" },
            toolResults: [{ toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] }],
          },
          ctx,
        );
      }
      const summary = await p;
      assert.equal(summary.triggerReason, "error_loop");
      assert.equal(summary.status, "advise");
      assert.equal(summary.category, "loop");
    });

    it("fails soft on provider errors, stopReason=error, and timeouts without blocking turns", async () => {
      writeProjectSettings({
        advisor_enabled: true,
        advisor_interval_turns: 1,
      });

      const settled: AdvisorCheckSummary[] = [];
      let waitNext: ((s: AdvisorCheckSummary) => void) | null = null;
      const nextSettled = () =>
        new Promise<AdvisorCheckSummary>((r) => {
          waitNext = r;
        });

      let mode: "throw" | "error_stop" | "hang" | "ok" = "throw";
      const { pi, fire } = createMockPi();
      registerAdvisor(pi, {
        timeoutMs: 500,
        completeFn: async (_m, _c, opts) => {
          if (mode === "throw") throw new Error("429 rate limited");
          if (mode === "error_stop") {
            return makeAssistantResponse("", { stopReason: "error", errorMessage: "upstream 500" });
          }
          if (mode === "hang") {
            return await new Promise<AssistantMessage>((_res, rej) => {
              opts?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
            });
          }
          return makeAssistantResponse('{"status":"clean"}');
        },
        onCheckSettled: (s) => {
          settled.push(s);
          waitNext?.(s);
          waitNext = null;
        },
      });

      const ctx = {
        cwd: tmpRoot,
        hasUI: true,
        mode: "tui",
        model: makeModel("google", "gemini-2.5-flash"),
        sessionManager: { getSessionId: () => "adv-failsoft" },
      };

      // 1. Thrown error
      let p = nextSettled();
      await fire("turn_end", { turnIndex: 0, outcome: "completed", message: { content: "t0" } }, ctx);
      assert.equal((await p).status, "error");

      // 2. stopReason === "error"
      mode = "error_stop";
      p = nextSettled();
      await fire("turn_end", { turnIndex: 1, outcome: "completed", message: { content: "t1" } }, ctx);
      assert.equal((await p).status, "error");

      // 3. Timeout (non-blocking: turn_end returns immediately before 500ms)
      mode = "hang";
      p = nextSettled();
      const t0 = Date.now();
      await fire("turn_end", { turnIndex: 2, outcome: "completed", message: { content: "t2" } }, ctx);
      assert.ok(Date.now() - t0 < 200, "turn_end must not block on advisor request");
      const timedOutSummary = await p;
      assert.equal(timedOutSummary.status, "error");
      assert.match(timedOutSummary.error ?? "", /timed out/);

      // 4. Recovers cleanly on next turn after failures
      mode = "ok";
      p = nextSettled();
      await fire("turn_end", { turnIndex: 3, outcome: "completed", message: { content: "t3" } }, ctx);
      assert.equal((await p).status, "clean");
      assert.equal(settled.length, 4);
    });
  });
});
