import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  readLastThinkingLevel,
  readThinkingLevelState,
  registerLastThinkingLevel,
  shouldRestoreLastThinkingLevel,
  writeLastThinkingLevel,
} from "../../../extensions/providers/last-thinking-level.js";

type Handler = (event: any, ctx: any) => any;

function harness(statePath: string, initial = "off") {
  const handlers = new Map<string, Handler>();
  let level = initial;
  let ctx: any = reasoningCtx();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getThinkingLevel: () => level,
    setThinkingLevel: (next: string) => {
      const previousLevel = level;
      level = next;
      handlers.get("thinking_level_select")?.({ level: next, previousLevel }, ctx);
    },
  } as any;
  const api = registerLastThinkingLevel(pi, { statePath, argv: ["node", "pi"] });
  return { handlers, api, pi, level: () => level, setCtx: (next: any) => { ctx = next; } };
}

const reasoningCtx = (entries: any[] = [], id = "reasoner") => ({
  model: { id, provider: "native", reasoning: true },
  sessionManager: { getEntries: () => entries },
});

describe("last-used thinking level", () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-thinking-"));
    statePath = join(dir, "state", "last-thinking-level.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists a validated fallback with private permissions", () => {
    assert.equal(writeLastThinkingLevel("high", statePath), true);
    assert.equal(readLastThinkingLevel(statePath), "high");
    assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), {
      version: 2,
      fallback: "high",
      models: {},
    });
  });

  it("migrates a legacy fallback when saving an exact model preference", () => {
    writeLastThinkingLevel("high", statePath);
    writeFileSync(statePath, JSON.stringify({ level: "high" }));
    const h = harness(statePath);
    h.handlers.get("session_start")!({ reason: "new" }, reasoningCtx());
    h.pi.setThinkingLevel("low");
    assert.deepEqual(JSON.parse(JSON.stringify(readThinkingLevelState(statePath))), {
      version: 2,
      fallback: "low",
      models: { '["native","reasoner"]': "low" },
    });
  });

  it("ignores corrupt state when reading the saved fallback", () => {
    writeLastThinkingLevel("high", statePath);
    writeFileSync(statePath, "not json");
    assert.equal(readLastThinkingLevel(statePath), undefined);
    writeFileSync(statePath, JSON.stringify({ version: 2, fallback: "low", models: { safe: "high", bad: "turbo", "__proto__": "max" } }));
    assert.deepEqual(JSON.parse(JSON.stringify(readThinkingLevelState(statePath))), {
      version: 2,
      fallback: "low",
      models: { safe: "high" },
    });
    assert.equal(writeLastThinkingLevel("turbo", statePath), false);
  });

  it("restores saved preferences after cold startup or /new model restoration settles", async () => {
    writeLastThinkingLevel("high", statePath);
    for (const reason of ["startup", "new"]) {
      const h = harness(statePath);
      let release!: () => void;
      const modelRestore = new Promise<void>((resolve) => { release = resolve; });
      const pending = h.api.applyAfterModelRestore({ reason }, reasoningCtx(), modelRestore);
      assert.equal(h.level(), "off");
      release();
      assert.equal(await pending, true);
      assert.equal(h.level(), "high");
    }
  });

  it("skips lifecycle preference restoration for existing sessions", () => {
    for (const reason of ["reload", "resume", "fork"]) {
      assert.equal(shouldRestoreLastThinkingLevel({ reason, ctx: reasoningCtx(), argv: [] }), false);
    }
    assert.equal(shouldRestoreLastThinkingLevel({
      reason: "startup",
      ctx: reasoningCtx([{ type: "message" }]),
      argv: [],
    }), false);
  });

  it("restores after the SDK appends its initial model and thinking entries before session_start", async () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness(statePath);
    const sessionManager = SessionManager.inMemory();
    // sdk.createAgentSession appends these before AgentSession emits session_start.
    sessionManager.appendModelChange("native", "reasoner");
    sessionManager.appendThinkingLevelChange("off");
    const ctx = { ...reasoningCtx(), sessionManager };
    h.handlers.get("session_start")!({ reason: "startup" }, ctx);
    assert.equal(await h.api.applyAfterModelRestore({ reason: "startup" }, ctx, Promise.resolve(false)), true);
    assert.equal(h.level(), "high");
  });

  it("restores on startup with only a provider discovery summary", async () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness(statePath);
    const ctx = reasoningCtx([{ type: "custom", customType: "provider-discovery-summary" }]);

    assert.equal(await h.api.applyAfterModelRestore({ reason: "startup" }, ctx, Promise.resolve()), true);
    assert.equal(h.level(), "high");
  });

  it("skips preference restoration on non-reasoning models", () => {
    assert.equal(shouldRestoreLastThinkingLevel({
      reason: "new",
      ctx: { model: { reasoning: false } },
      argv: [],
    }), false);
  });

  it("does not overwrite an explicit thinking change while model restoration is pending", async () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness(statePath);
    let release!: () => void;
    const modelRestore = new Promise<void>((resolve) => { release = resolve; });
    const pending = h.api.applyAfterModelRestore({ reason: "new" }, reasoningCtx(), modelRestore);
    h.pi.setThinkingLevel("low");
    release();
    assert.equal(await pending, false);
    assert.equal(h.level(), "low");
    assert.equal(readLastThinkingLevel(statePath), "low");
  });

  it("skips lifecycle preference restoration for explicitly selected thinking", () => {
    assert.equal(shouldRestoreLastThinkingLevel({
      reason: "new",
      ctx: reasoningCtx(),
      argv: ["pi", "--thinking", "high"],
    }), false);
    assert.equal(shouldRestoreLastThinkingLevel({
      reason: "new",
      ctx: {
        model: { id: "codex:gpt-5-high", provider: "cli-codex", reasoning: true },
        sessionManager: { getEntries: () => [] },
      },
      argv: [],
    }), false);
  });

  it("persists explicit thinking selections from Pi events", () => {
    const h = harness(statePath);
    h.handlers.get("session_start")!({ reason: "new" }, reasoningCtx());
    h.handlers.get("thinking_level_select")!({ level: "xhigh", previousLevel: "off" }, reasoningCtx());
    assert.equal(readLastThinkingLevel(statePath), "xhigh");
    h.pi.setThinkingLevel("medium");
    assert.deepEqual({ ...readThinkingLevelState(statePath).models }, { '["native","reasoner"]': "medium" });
  });

  it("restores the exact preference after switching back to a saved model", () => {
    const h = harness(statePath);
    h.handlers.get("session_start")!({ reason: "new" }, reasoningCtx());
    h.pi.setThinkingLevel("low");

    const other = reasoningCtx([], "other");
    h.setCtx(other);
    h.handlers.get("thinking_level_select")!({ level: "off", previousLevel: "low" }, other);
    h.handlers.get("model_select")!({ model: other.model, source: "set" }, other);
    assert.equal(h.level(), "low");
    assert.deepEqual({ ...readThinkingLevelState(statePath).models }, { '["native","reasoner"]': "low" });

    h.pi.setThinkingLevel("high");
    const first = reasoningCtx();
    h.setCtx(first);
    h.handlers.get("thinking_level_select")!({ level: "off", previousLevel: "high" }, first);
    h.handlers.get("model_select")!({ model: first.model, source: "set" }, first);
    assert.equal(h.level(), "low");
    assert.deepEqual({ ...readThinkingLevelState(statePath).models }, {
      '["native","reasoner"]': "low",
      '["native","other"]': "high",
    });
  });

  it("keeps preferences distinct when slash-joined model identifiers collide", () => {
    const h = harness(statePath);
    const first = { model: { provider: "relay", id: "vendor/model", reasoning: true } };
    const second = { model: { provider: "relay/vendor", id: "model", reasoning: true } };
    h.setCtx(first);
    h.handlers.get("session_start")!({ reason: "new" }, first);
    h.pi.setThinkingLevel("low");
    h.setCtx(second);
    h.handlers.get("model_select")!({ model: second.model, source: "set" }, second);
    h.pi.setThinkingLevel("high");
    assert.deepEqual({ ...readThinkingLevelState(statePath).models }, {
      '["relay","vendor/model"]': "low",
      '["relay/vendor","model"]': "high",
    });
    h.setCtx(first);
    h.handlers.get("model_select")!({ model: first.model, source: "set" }, first);
    assert.equal(h.level(), "low");
    h.setCtx(second);
    h.handlers.get("model_select")!({ model: second.model, source: "set" }, second);
    assert.equal(h.level(), "high");
  });

  it("restores a legacy unambiguous key without discarding its saved value", () => {
    mkdirSync(join(dir, "state"));
    writeFileSync(statePath, JSON.stringify({ version: 2, models: { "native/reasoner": "high" } }));
    const h = harness(statePath);
    const ctx = reasoningCtx();
    h.handlers.get("session_start")!({ reason: "new" }, ctx);
    h.handlers.get("model_select")!({ model: ctx.model, source: "set" }, ctx);
    assert.equal(h.level(), "high");
    h.pi.setThinkingLevel("low");
    assert.deepEqual({ ...readThinkingLevelState(statePath).models }, {
      "native/reasoner": "high",
      '["native","reasoner"]': "low",
    });
    const resumed = harness(statePath);
    resumed.handlers.get("session_start")!({ reason: "new" }, ctx);
    resumed.handlers.get("model_select")!({ model: ctx.model, source: "set" }, ctx);
    assert.equal(resumed.level(), "low");
  });

  it("does not assign an ambiguous legacy preference to either colliding model", () => {
    mkdirSync(join(dir, "state"));
    writeFileSync(statePath, JSON.stringify({ version: 2, models: { "relay/vendor/model": "max" } }));
    const h = harness(statePath);
    const first = { model: { provider: "relay", id: "vendor/model", reasoning: true } };
    const second = { model: { provider: "relay/vendor", id: "model", reasoning: true } };
    for (const ctx of [first, second]) {
      h.setCtx(ctx);
      h.handlers.get("session_start")!({ reason: "new" }, ctx);
      h.handlers.get("model_select")!({ model: ctx.model, source: "set" }, ctx);
      assert.equal(h.level(), "off");
    }
    assert.equal(readThinkingLevelState(statePath).models["relay/vendor/model"], "max");
  });

  it("applies saved preferences on model switches after resume", () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness(statePath);
    const original = reasoningCtx();
    h.handlers.get("session_start")!({ reason: "resume" }, original);
    h.handlers.get("model_select")!({ model: original.model, source: "restore" }, original);
    assert.equal(h.level(), "off");
    const selected = reasoningCtx([], "other");
    h.setCtx(selected);
    h.handlers.get("model_select")!({ model: selected.model, source: "set" }, selected);
    assert.equal(h.level(), "high");
  });

  it("restores the default model preference after its set event", async () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness(statePath);
    const initial = reasoningCtx();
    const target = reasoningCtx([], "default");
    h.handlers.get("session_start")!({ reason: "startup" }, initial);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const restore = h.api.restoreModel(target.model, async () => {
      await waiting;
      h.setCtx(target);
      h.handlers.get("model_select")!({ model: target.model, source: "set" }, target);
      return true;
    });
    const pending = h.api.applyAfterModelRestore({ reason: "startup" }, target, restore);
    release();
    assert.equal(await pending, true);
    assert.equal(h.level(), "high");
  });

  it("does not override a user model switch during default restoration", async () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness(statePath);
    const initial = reasoningCtx();
    h.handlers.get("session_start")!({ reason: "startup" }, initial);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const target = reasoningCtx([], "default");
    const restore = h.api.restoreModel(target.model, async () => { await waiting; return false; });
    const pending = h.api.applyAfterModelRestore({ reason: "startup" }, initial, restore);
    const selected = reasoningCtx([], "chosen");
    h.setCtx(selected);
    h.handlers.get("model_select")!({ model: selected.model, source: "set" }, selected);
    release();
    assert.equal(await pending, false);
    assert.equal(h.level(), "high"); // selection applied its own preference
  });

  it("recovers a stale empty legacy lock during a preference write", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(`${statePath}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${statePath}.lock`, old, old);
    assert.equal(writeLastThinkingLevel("high", statePath), true);
    assert.equal(readLastThinkingLevel(statePath), "high");
  });

  it("retains both preferences from concurrent processes", async () => {
    const script = `import { registerLastThinkingLevel } from ${JSON.stringify(new URL("../../../extensions/providers/last-thinking-level.ts", import.meta.url).href)};
      const model = { provider: 'native', id: process.argv[2], reasoning: true };
      const handlers = new Map();
      const pi = { on: (name, handler) => handlers.set(name, handler), setThinkingLevel: () => {}, getThinkingLevel: () => 'off' };
      registerLastThinkingLevel(pi, { statePath: process.argv[1], argv: [] });
      handlers.get('session_start')({ reason: 'new' }, { model });
      handlers.get('thinking_level_select')({ level: 'high' }, { model });`;
    const run = (id: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, statePath, id], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`writer ${id} exited ${code}`)));
    });
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(`${statePath}.lock`, "999999999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${statePath}.lock`, old, old);
    await Promise.all([run("one"), run("two")]);
    assert.deepEqual({ ...readThinkingLevelState(statePath).models }, { '["native","one"]': "high", '["native","two"]': "high" });
  });

  it("clamps a restored preference while preserving the saved value", () => {
    writeLastThinkingLevel("max", statePath);
    const h = harness(statePath);
    const ctx = reasoningCtx([], "limited");
    ctx.model.thinkingLevelMap = { xhigh: null, max: null };
    h.handlers.get("session_start")!({ reason: "new" }, ctx);
    h.handlers.get("model_select")!({ model: ctx.model, source: "set" }, ctx);
    assert.equal(h.level(), "high");
    assert.equal(readThinkingLevelState(statePath).fallback, "max");
  });
});
