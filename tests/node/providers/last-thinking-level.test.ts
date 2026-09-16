import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  it("persists validated levels atomically with private permissions", () => {
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

  it("migrates legacy fallback when saving an exact model preference", () => {
    writeLastThinkingLevel("high", statePath);
    writeFileSync(statePath, JSON.stringify({ level: "high" }));
    const h = harness(statePath);
    h.handlers.get("session_start")!({ reason: "new" }, reasoningCtx());
    h.pi.setThinkingLevel("low");
    assert.deepEqual(JSON.parse(JSON.stringify(readThinkingLevelState(statePath))), {
      version: 2,
      fallback: "low",
      models: { "native/reasoner": "low" },
    });
  });

  it("ignores invalid and corrupt state", () => {
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

  it("restores on cold startup and /new after model restoration settles", async () => {
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

  it("skips reload, resume, fork, and startup of an existing conversational session", () => {
    for (const reason of ["reload", "resume", "fork"]) {
      assert.equal(shouldRestoreLastThinkingLevel({ reason, ctx: reasoningCtx(), argv: [] }), false);
    }
    assert.equal(shouldRestoreLastThinkingLevel({
      reason: "startup",
      ctx: reasoningCtx([{ type: "message" }]),
      argv: [],
    }), false);
  });

  it("restores when provider discovery appended only its summary before the startup handler", async () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness(statePath);
    const ctx = reasoningCtx([{ type: "custom", customType: "provider-discovery-summary" }]);

    assert.equal(await h.api.applyAfterModelRestore({ reason: "startup" }, ctx, Promise.resolve()), true);
    assert.equal(h.level(), "high");
  });

  it("skips non-reasoning models", () => {
    assert.equal(shouldRestoreLastThinkingLevel({
      reason: "new",
      ctx: { model: { reasoning: false } },
      argv: [],
    }), false);
  });

  it("does not overwrite a user change while model restoration is pending", async () => {
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

  it("preserves explicit CLI and CLI/ACPX suffix thinking", () => {
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

  it("persists native TUI and pidash setter events through the direct Pi event", () => {
    const h = harness(statePath);
    h.handlers.get("session_start")!({ reason: "new" }, reasoningCtx());
    h.handlers.get("thinking_level_select")!({ level: "xhigh", previousLevel: "off" }, reasoningCtx());
    assert.equal(readLastThinkingLevel(statePath), "xhigh");
    h.pi.setThinkingLevel("medium");
    assert.deepEqual({ ...readThinkingLevelState(statePath).models }, { "native/reasoner": "medium" });
  });

  it("ignores a model-switch clamp and restores each exact model preference", () => {
    const h = harness(statePath);
    h.handlers.get("session_start")!({ reason: "new" }, reasoningCtx());
    h.pi.setThinkingLevel("low");

    const other = reasoningCtx([], "other");
    h.setCtx(other);
    h.handlers.get("thinking_level_select")!({ level: "off", previousLevel: "low" }, other);
    h.handlers.get("model_select")!({ model: other.model, source: "set" }, other);
    assert.equal(h.level(), "low");
    assert.deepEqual({ ...readThinkingLevelState(statePath).models }, { "native/reasoner": "low" });

    h.pi.setThinkingLevel("high");
    const first = reasoningCtx();
    h.setCtx(first);
    h.handlers.get("thinking_level_select")!({ level: "off", previousLevel: "high" }, first);
    h.handlers.get("model_select")!({ model: first.model, source: "set" }, first);
    assert.equal(h.level(), "low");
    assert.deepEqual({ ...readThinkingLevelState(statePath).models }, {
      "native/reasoner": "low",
      "native/other": "high",
    });
  });

  it("clamps restored preferences without overwriting the requested value", () => {
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
