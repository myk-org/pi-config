import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAGIC_KEYWORDS,
  detectMagicKeyword,
  getModelSupportedThinkingLevels,
  registerMagicKeywords,
  resolveMagicThinkingLevel,
} from "../../../extensions/orchestrator/magic-keywords.ts";
import {
  SETTINGS_KEYS,
  clearSettingsCache,
  setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.ts";
import { registerSessionRestore } from "../../../extensions/providers/session-restore.ts";
import { readThinkingLevelState, saveModelThinkingLevel, modelThinkingKey } from "../../../extensions/providers/last-thinking-level.ts";

type Handler = (event: any, ctx: any) => any;

function createMockPi(initialLevel = "medium") {
  const handlers = new Map<string, Handler[]>();
  const eventBusListeners = new Map<string, Array<(payload: unknown) => void>>();
  let currentLevel = initialLevel;
  const setLevelCalls: string[] = [];
  const emittedEvents: Array<{ name: string; payload: unknown }> = [];

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
    events: {
      on(name: string, fn: (payload: unknown) => void) {
        const list = eventBusListeners.get(name) ?? [];
        list.push(fn);
        eventBusListeners.set(name, list);
        return () => {
          const idx = list.indexOf(fn);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
      emit(name: string, payload: unknown) {
        emittedEvents.push({ name, payload });
        for (const fn of eventBusListeners.get(name) ?? []) fn(payload);
      },
    },
    getThinkingLevel() {
      return currentLevel;
    },
    setThinkingLevel(level: string) {
      const previousLevel = currentLevel;
      currentLevel = level;
      setLevelCalls.push(level);
      for (const fn of handlers.get("thinking_level_select") ?? []) {
        fn({ type: "thinking_level_select", level, previousLevel }, lastCtx);
      }
    },
  };

  let lastCtx: any = undefined;

  async function fire(name: string, event: any, ctx: any) {
    lastCtx = ctx;
    let lastResult: any;
    for (const fn of handlers.get(name) ?? []) {
      const res = await fn(event, ctx);
      if (res !== undefined) lastResult = res;
    }
    return lastResult;
  }

  return {
    pi,
    fire,
    getLevel: () => currentLevel,
    setRawLevel: (l: string) => { currentLevel = l; },
    setLevelCalls,
    emittedEvents,
  };
}

describe("magic-keywords (#1418)", () => {
  let tmpRoot: string;
  let globalSettingsFile: string;
  let savedSubagentChild: string | undefined;
  let savedEnvMagic: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-magic-kw-test-"));
    globalSettingsFile = join(tmpRoot, "global-settings.json");
    setGlobalSettingsPath(globalSettingsFile);
    clearSettingsCache();
    savedSubagentChild = process.env.PI_SUBAGENT_CHILD;
    savedEnvMagic = process.env.PI_MAGIC_KEYWORDS;
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_MAGIC_KEYWORDS;
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    if (savedSubagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = savedSubagentChild;
    if (savedEnvMagic === undefined) delete process.env.PI_MAGIC_KEYWORDS;
    else process.env.PI_MAGIC_KEYWORDS = savedEnvMagic;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("schema & keyword table", () => {
    it("declares magic_keywords in settings-keys.json with default true", () => {
      assert.equal(SETTINGS_KEYS.magic_keywords?.type, "bool");
      assert.equal(SETTINGS_KEYS.magic_keywords?.default, true);
      assert.equal(SETTINGS_KEYS.magic_keywords?.env, "PI_MAGIC_KEYWORDS");
      assert.equal(SETTINGS_KEYS.magic_keywords?.group, "Session");
    });

    it("exposes single source-of-truth MAGIC_KEYWORDS table", () => {
      assert.deepEqual(
        MAGIC_KEYWORDS.map((k) => ({ keyword: k.keyword, direction: k.direction })),
        [
          { keyword: "ultrathink", direction: "highest" },
          { keyword: "chillax", direction: "lowest" },
        ],
      );
      const ultra = MAGIC_KEYWORDS.find((k) => k.keyword === "ultrathink");
      assert.ok(ultra?.notice && ultra.notice.length > 0);
    });
  });

  describe("detectMagicKeyword — strict prose-only parser", () => {
    it("matches standalone lowercase keywords in prose", () => {
      assert.equal(detectMagicKeyword("ultrathink")?.keyword, "ultrathink");
      assert.equal(detectMagicKeyword("chillax")?.keyword, "chillax");
      assert.equal(detectMagicKeyword("Please ultrathink about this race condition")?.keyword, "ultrathink");
      assert.equal(detectMagicKeyword("Just chillax and rename the variable.")?.keyword, "chillax");
      assert.equal(detectMagicKeyword("ultrathink: why does this deadlock?")?.keyword, "ultrathink");
      assert.equal(detectMagicKeyword("Can we fix this? ultrathink!")?.keyword, "ultrathink");
      assert.equal(detectMagicKeyword("Let's do a quick pass, chillax, nothing fancy")?.keyword, "chillax");
      assert.equal(detectMagicKeyword("(ultrathink) check all invariants")?.keyword, "ultrathink");
      assert.equal(detectMagicKeyword("Keep it simple [chillax].")?.keyword, "chillax");
    });

    it("uses last-match-wins when multiple keywords appear in prose", () => {
      assert.equal(detectMagicKeyword("Initially chillax, actually ultrathink this")?.keyword, "ultrathink");
      assert.equal(detectMagicKeyword("No need to ultrathink, just chillax")?.keyword, "chillax");
    });

    it("is strictly case-sensitive (exact lowercase only)", () => {
      for (const prompt of ["Ultrathink", "ULTRATHINK", "UltraThink", "Chillax", "CHILLAX", "ChilLax"]) {
        assert.equal(detectMagicKeyword(prompt), null, `should ignore "${prompt}"`);
      }
    });

    it("ignores fenced code blocks (backticks and tildes)", () => {
      assert.equal(detectMagicKeyword("Look at this:\n```ts\nultrathink\n```\nDone."), null);
      assert.equal(detectMagicKeyword("Example:\n~~~~\nchillax\n~~~~\nThanks."), null);
      assert.equal(detectMagicKeyword("   ```bash\necho ultrathink\n   ```"), null);
      // Unclosed fence runs to EOF
      assert.equal(detectMagicKeyword("Code:\n```\nultrathink\nchillax"), null);
    });

    it("ignores inline code spans (single and multi-backtick)", () => {
      assert.equal(detectMagicKeyword("Check the `ultrathink` keyword handling"), null);
      assert.equal(detectMagicKeyword("Use ``the chillax flag`` here"), null);
      assert.equal(detectMagicKeyword("Compare `ultrathink` vs `chillax`"), null);
    });

    it("ignores HTML/XML tags and comments", () => {
      assert.equal(detectMagicKeyword("<ultrathink>hello</ultrathink>"), null);
      assert.equal(detectMagicKeyword('<div class="chillax">text</div>'), null);
      assert.equal(detectMagicKeyword("<!-- ultrathink --> please check"), null);
      assert.equal(detectMagicKeyword("<config mode='ultrathink' />"), null);
    });

    it("ignores paths, URLs, identifiers, function calls, flags, and quoted literals", () => {
      const nonMatches = [
        "Open ultrathink.ts and check line 10",
        "Inspect extensions/orchestrator/ultrathink/index.ts",
        "Check ./chillax and ../ultrathink",
        "Windows path C:\\tools\\chillax\\run.exe",
        "Call foo::chillax and chillax::bar",
        "Access obj.ultrathink or ultrathink.value",
        "Invoke ultrathink() now",
        "Pass fn(ultrathink) and arr[chillax]",
        "Check my_ultrathink and ultrathink_mode",
        "Pass --ultrathink or ultrathink-mode",
        'Search for "ultrathink" or \'chillax\'',
        "Env $ultrathink or @chillax or #ultrathink",
        "See https://example.com/ultrathink for docs",
        "Check (ultrathink).ts extension",
        "Map key chillax:123",
      ];
      for (const prompt of nonMatches) {
        assert.equal(detectMagicKeyword(prompt), null, `should ignore "${prompt}"`);
      }
    });

    it("still matches real prose when code/paths appear elsewhere in the same prompt", () => {
      const prompt = "Review `chillax.ts`:\n```ts\nconst x = chillax();\n```\nPlease ultrathink about edge cases.";
      assert.equal(detectMagicKeyword(prompt)?.keyword, "ultrathink");
    });
  });

  describe("resolveMagicThinkingLevel", () => {
    it("raises ultrathink to highest supported level (max / xhigh / high)", () => {
      const maxModel = { id: "m1", provider: "p", reasoning: true, thinkingLevelMap: { max: "max" } };
      const xhighModel = { id: "m2", provider: "p", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
      const stdModel = { id: "m3", provider: "p", reasoning: true };

      assert.equal(resolveMagicThinkingLevel(maxModel, "medium", "highest"), "max");
      assert.equal(resolveMagicThinkingLevel(maxModel, "max", "highest"), null);
      assert.equal(resolveMagicThinkingLevel(xhighModel, "low", "highest"), "xhigh");
      assert.equal(resolveMagicThinkingLevel(stdModel, "off", "highest"), "high");
      assert.equal(resolveMagicThinkingLevel(stdModel, "high", "highest"), null);
    });

    it("returns null for non-reasoning models", () => {
      const nonReasoning = { id: "plain", provider: "p", reasoning: false };
      assert.deepEqual(getModelSupportedThinkingLevels(nonReasoning), ["off"]);
      assert.equal(resolveMagicThinkingLevel(nonReasoning, "off", "highest"), null);
      assert.equal(resolveMagicThinkingLevel(nonReasoning, "off", "lowest"), null);
    });

    it("lowers chillax to lowest supported level and NEVER raises or enables when off", () => {
      const stdModel = { id: "m1", provider: "p", reasoning: true };
      const alwaysOnModel = { id: "m2", provider: "p", reasoning: true, thinkingLevelMap: { off: null } };
      const minLowModel = {
        id: "m3",
        provider: "p",
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null },
      };

      assert.equal(resolveMagicThinkingLevel(stdModel, "high", "lowest"), "off");
      assert.equal(resolveMagicThinkingLevel(stdModel, "off", "lowest"), null);

      assert.equal(resolveMagicThinkingLevel(alwaysOnModel, "high", "lowest"), "minimal");
      assert.equal(resolveMagicThinkingLevel(alwaysOnModel, "minimal", "lowest"), null);
      // Critical invariant: chillax MUST NEVER raise or enable thinking when currently off
      assert.equal(resolveMagicThinkingLevel(alwaysOnModel, "off", "lowest"), null);

      assert.equal(resolveMagicThinkingLevel(minLowModel, "high", "lowest"), "low");
      assert.equal(resolveMagicThinkingLevel(minLowModel, "off", "lowest"), null);
    });
  });

  describe("registerMagicKeywords lifecycle", () => {
    const reasoningModel = { id: "gemini-pro", provider: "google", reasoning: true, thinkingLevelMap: { max: "max" } };

    it("raises thinking for ultrathink, injects hidden notice without touching systemPrompt, and restores on turn_end", async () => {
      const { pi, fire, getLevel, setLevelCalls } = createMockPi("medium");
      registerMagicKeywords(pi);

      const ctx = { cwd: tmpRoot, model: reasoningModel, sessionManager: { getSessionId: () => "s1" } };
      const sysOpts = { sections: { base: "stable" } };
      const res = await fire(
        "before_agent_start",
        { messageType: "user", prompt: "Please ultrathink about this bug", systemPrompt: "SYS", systemPromptOptions: sysOpts },
        ctx,
      );

      assert.equal(getLevel(), "max");
      assert.deepEqual(setLevelCalls, ["max"]);
      assert.equal(res?.systemPrompt, undefined);
      assert.deepEqual(sysOpts.sections, { base: "stable" });
      assert.equal(res?.message?.customType, "magic-keyword-notice");
      assert.equal(res?.message?.display, false);
      assert.ok(typeof res?.message?.content === "string" && res.message.content.length > 0);

      // Multi-tool intermediate turn (continue: true) preserves override
      await fire("turn_end", { outcome: "completed", continue: true }, ctx);
      assert.equal(getLevel(), "max");

      // Final turn restores previous level
      await fire("turn_end", { outcome: "completed", continue: false }, ctx);
      assert.equal(getLevel(), "medium");
      assert.deepEqual(setLevelCalls, ["max", "medium"]);
    });

    it("restores previous thinking level on error, abort, and agent_end", async () => {
      for (const endCase of ["error", "aborted", "agent_end"] as const) {
        const { pi, fire, getLevel } = createMockPi("high");
        registerMagicKeywords(pi);
        const ctx = { cwd: tmpRoot, model: reasoningModel, sessionManager: { getSessionId: () => `s-${endCase}` } };

        await fire("before_agent_start", { messageType: "user", prompt: "chillax and fix typo" }, ctx);
        assert.equal(getLevel(), "off");

        if (endCase === "agent_end") {
          await fire("agent_end", { messages: [] }, ctx);
        } else {
          await fire("turn_end", { outcome: endCase, continue: true }, ctx);
        }
        assert.equal(getLevel(), "high", `should restore on ${endCase}`);
      }
    });

    it("has zero prompt-cache or thinking-level impact when no keyword matches", async () => {
      const { pi, fire, getLevel, setLevelCalls } = createMockPi("medium");
      registerMagicKeywords(pi);
      const ctx = { cwd: tmpRoot, model: reasoningModel, sessionManager: { getSessionId: () => "s-noop" } };

      const res = await fire(
        "before_agent_start",
        { messageType: "user", prompt: "Fix `ultrathink.ts` and call foo::chillax()" },
        ctx,
      );
      assert.equal(res, undefined);
      assert.equal(getLevel(), "medium");
      assert.deepEqual(setLevelCalls, []);
    });

    it("ignores synthetic extension prompts and custom messages", async () => {
      const { pi, fire, getLevel, setLevelCalls } = createMockPi("medium");
      registerMagicKeywords(pi);
      const ctx = { cwd: tmpRoot, model: reasoningModel, sessionManager: { getSessionId: () => "s-synth" } };

      // Custom triggerTurn message
      const customRes = await fire(
        "before_agent_start",
        { messageType: "custom", message: { content: "ultrathink" } },
        ctx,
      );
      assert.equal(customRes, undefined);
      assert.equal(getLevel(), "medium");

      // Extension-initiated sendUserMessage (fires input with source: "extension")
      await fire("input", { text: "Please ultrathink this", source: "extension" }, ctx);
      const synthRes = await fire(
        "before_agent_start",
        { messageType: "user", prompt: "Please ultrathink this" },
        ctx,
      );
      assert.equal(synthRes, undefined);
      assert.equal(getLevel(), "medium");
      assert.deepEqual(setLevelCalls, []);

      // Subsequent real interactive user prompt still works
      await fire("input", { text: "Please ultrathink now", source: "interactive" }, ctx);
      const realRes = await fire(
        "before_agent_start",
        { messageType: "user", prompt: "Please ultrathink now" },
        ctx,
      );
      assert.ok(realRes?.message);
      assert.equal(getLevel(), "max");
    });

    it("respects magic_keywords: false setting", async () => {
      mkdirSync(join(tmpRoot, ".pi"), { recursive: true });
      writeFileSync(join(tmpRoot, ".pi", "pi-config-settings.json"), JSON.stringify({ magic_keywords: false }));
      clearSettingsCache();

      const { pi, fire, getLevel, setLevelCalls } = createMockPi("medium");
      registerMagicKeywords(pi);
      const ctx = { cwd: tmpRoot, model: reasoningModel, sessionManager: { getSessionId: () => "s-off" } };

      const res = await fire("before_agent_start", { messageType: "user", prompt: "ultrathink please" }, ctx);
      assert.equal(res, undefined);
      assert.equal(getLevel(), "medium");
      assert.deepEqual(setLevelCalls, []);
    });

    it("skips registration in subagent children (PI_SUBAGENT_CHILD=1)", async () => {
      process.env.PI_SUBAGENT_CHILD = "1";
      const { pi, fire, getLevel } = createMockPi("medium");
      registerMagicKeywords(pi);
      const ctx = { cwd: tmpRoot, model: reasoningModel, sessionManager: { getSessionId: () => "s-sub" } };

      const res = await fire("before_agent_start", { messageType: "user", prompt: "ultrathink" }, ctx);
      assert.equal(res, undefined);
      assert.equal(getLevel(), "medium");
    });

    it("does not clobber an explicit user thinking-level change made mid-turn", async () => {
      const { pi, fire, getLevel, setRawLevel } = createMockPi("medium");
      registerMagicKeywords(pi);
      const ctx = { cwd: tmpRoot, model: reasoningModel, sessionManager: { getSessionId: () => "s-user" } };

      await fire("before_agent_start", { messageType: "user", prompt: "ultrathink" }, ctx);
      assert.equal(getLevel(), "max");

      // User manually switches to "low" mid-turn
      setRawLevel("low");
      await fire("turn_end", { outcome: "completed", continue: false }, ctx);
      assert.equal(getLevel(), "low");
    });

    it("suppresses session-restore persistence so last-thinking-level.json is not overwritten", async () => {
      const statePath = join(tmpRoot, "last-thinking-level.json");
      const key = modelThinkingKey(reasoningModel)!;
      saveModelThinkingLevel(key, "medium", statePath);

      const { pi, fire, getLevel } = createMockPi("medium");
      registerSessionRestore(pi, { thinkingStatePath: statePath, argv: [] });
      registerMagicKeywords(pi);

      const ctx = {
        cwd: tmpRoot,
        model: reasoningModel,
        sessionManager: { getSessionId: () => "s-persist", getEntries: () => [{ type: "message" }] },
      };
      await fire("session_start", { reason: "startup" }, ctx);

      await fire("before_agent_start", { messageType: "user", prompt: "ultrathink deeply" }, ctx);
      assert.equal(getLevel(), "max");
      assert.equal(readThinkingLevelState(statePath).models[key], "medium");

      await fire("turn_end", { outcome: "completed", continue: false }, ctx);
      assert.equal(getLevel(), "medium");
      assert.equal(readThinkingLevelState(statePath).models[key], "medium");
    });
  });
});
