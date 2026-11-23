/**
 * Unified session-restore lifecycle tests (#753 / #901 / #1360).
 *
 * Exercises registerSessionRestore end-to-end through a fake pi object:
 * - Single ordered session_start handler (default model restore -> thinking-level restore)
 * - Reason gates (startup, resume, new with/without model, fork, reload)
 * - CLI override forwarding (--model / --provider / --models / --thinking)
 * - Explicit in-module restore state (our own setModel vs user switches)
 * - Pending retry cancellation on session_shutdown and superseded session_start
 *
 * Run: npx tsx --test tests/node/providers/session-restore.test.ts
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerSessionRestore } from "../../../extensions/providers/session-restore.js";
import { writeLastThinkingLevel, writeThinkingLevelState } from "../../../extensions/providers/last-thinking-level.js";
import { createLogger } from "../../../extensions/shared/logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { fakeModel } from "../helpers/fake-model.js";


const log = createLogger("session-restore-test");

type Handler = (event: any, ctx: any) => any;

const DEFAULT_PROVIDER = "foo";
const DEFAULT_MODEL = "foo-model";

function harness(opts: {
  argv?: string[];
  thinkingStatePath?: string;
  initialLevel?: string;
  onSetModel?: (model: any, ctx: any) => Promise<boolean> | boolean;
} = {}) {
  const handlerCounts = new Map<string, number>();
  const handlers = new Map<string, Handler[]>();
  const setModelCalls: Array<{ id: string; provider: string }> = [];
  const events: string[] = [];
  let level = opts.initialLevel ?? "off";
  let activeCtx: any;

  const emit = (name: string, event: any, ctx = activeCtx) => {
    for (const h of handlers.get(name) ?? []) h(event, ctx);
  };

  const pi = {
    on: (name: string, handler: Handler) => {
      handlerCounts.set(name, (handlerCounts.get(name) ?? 0) + 1);
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    getThinkingLevel: () => level,
    setThinkingLevel: (next: string) => {
      const previousLevel = level;
      level = next;
      events.push(`setThinkingLevel:${next}`);
      emit("thinking_level_select", { level: next, previousLevel }, activeCtx);
    },
    setModel: async (model: any) => {
      setModelCalls.push({ id: model.id, provider: String(model.provider) });
      events.push(`setModel:${model.provider}/${model.id}`);
      if (opts.onSetModel) {
        return await opts.onSetModel(model, activeCtx);
      }
      if (activeCtx) activeCtx.model = model;
      emit("model_select", { model, source: "set" }, activeCtx);
      return true;
    },
  } as any;

  const handle = registerSessionRestore(pi, {
    argv: opts.argv ?? ["node", "pi"],
    thinkingStatePath: opts.thinkingStatePath,
  });
  log.debug("session-restore harness registered", {
    handlerCounts: Object.fromEntries(handlerCounts),
    argv: opts.argv,
  });

  return {
    pi,
    handle,
    emit,
    handlerCounts,
    setModelCalls,
    events,
    level: () => level,
    setCtx: (ctx: any) => { activeCtx = ctx; },
  };
}

/** Registry whose find resolves the saved default as a reasoning model. */
const registry = {
  find: (provider: string, id: string) => fakeModel({ id, provider, reasoning: true }),
};

describe("session-restore lifecycle (#901 / #1360)", () => {
  let dir: string;
  let statePath: string;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    dir = makeTempDir("pi-session-restore-");
    process.env.PI_CODING_AGENT_DIR = dir;
    statePath = join(dir, "state", "last-thinking-level.json");
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      }),
    );
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers one handler per session restore lifecycle event", () => {
    const h = harness({ thinkingStatePath: statePath });
    assert.equal(h.handlerCounts.get("session_start"), 1);
    assert.equal(h.handlerCounts.get("model_select"), 1);
    assert.equal(h.handlerCounts.get("thinking_level_select"), 1);
    assert.equal(h.handlerCounts.get("session_shutdown"), 1);
  });

  it("new keeps a selected model — setModel never called (#901 regression)", async () => {
    const h = harness({ thinkingStatePath: statePath });
    const ctx = {
      model: fakeModel({ id: "bar-model", provider: "bar", reasoning: true }),
      modelRegistry: registry,
    };
    h.setCtx(ctx);
    h.emit("session_start", { reason: "new" }, ctx);
    await h.handle.waitForPendingRestore();
    assert.deepEqual(h.setModelCalls, []);
  });

  it("startup restores default model first, then restores per-model thinking level", async () => {
    writeThinkingLevelState(
      {
        version: 2,
        fallback: "low",
        models: {
          [JSON.stringify([DEFAULT_PROVIDER, DEFAULT_MODEL])]: "high",
        },
      },
      statePath,
    );
    const h = harness({ thinkingStatePath: statePath });
    const ctx = {
      model: fakeModel({ id: "bar-model", provider: "bar", reasoning: true }),
      modelRegistry: registry,
    };
    h.setCtx(ctx);
    h.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(await h.handle.waitForPendingRestore(), true);
    assert.deepEqual(h.setModelCalls, [
      { id: DEFAULT_MODEL, provider: DEFAULT_PROVIDER },
    ]);
    assert.equal(h.level(), "high");
    assert.deepEqual(h.events, [
      `setModel:${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      "setThinkingLevel:high",
    ]);
  });

  it("resume restores the default model when current differs without overwriting thinking level", async () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness({ thinkingStatePath: statePath });
    const ctx = {
      model: fakeModel({ id: "bar-model", provider: "bar", reasoning: true }),
      modelRegistry: registry,
    };
    h.setCtx(ctx);
    h.emit("session_start", { reason: "resume" }, ctx);
    assert.equal(await h.handle.waitForPendingRestore(), false);
    assert.deepEqual(h.setModelCalls, [
      { id: DEFAULT_MODEL, provider: DEFAULT_PROVIDER },
    ]);
    assert.equal(h.level(), "off");
  });

  it("new with no selected model fills empty selection with default", async () => {
    const h = harness({ thinkingStatePath: statePath });
    const ctx = { model: undefined as any, modelRegistry: registry };
    h.setCtx(ctx);
    h.emit("session_start", { reason: "new" }, ctx);
    await h.handle.waitForPendingRestore();
    assert.deepEqual(h.setModelCalls, [
      { id: DEFAULT_MODEL, provider: DEFAULT_PROVIDER },
    ]);
  });

  it("new with no selected model restores saved thinking level after default fill", async () => {
    writeLastThinkingLevel("medium", statePath);
    const h = harness({ thinkingStatePath: statePath });
    const ctx = { model: undefined as any, modelRegistry: registry };
    h.setCtx(ctx);
    h.emit("session_start", { reason: "new" }, ctx);
    assert.equal(await h.handle.waitForPendingRestore(), true);
    assert.equal(h.level(), "medium");
  });

  it("new with --model in argv never calls setModel (selected or empty)", async () => {
    const h = harness({
      argv: ["node", "pi", "--model", "bar/bar-model"],
      thinkingStatePath: statePath,
    });
    for (const model of [fakeModel({ id: "bar-model", provider: "bar" }), undefined]) {
      const ctx = { model, modelRegistry: registry };
      h.setCtx(ctx);
      h.emit("session_start", { reason: "new" }, ctx);
      await h.handle.waitForPendingRestore();
    }
    assert.deepEqual(h.setModelCalls, []);
  });

  it("fork skips model restore", async () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness({ thinkingStatePath: statePath });
    const ctx = {
      model: fakeModel({ id: "bar-model", provider: "bar", reasoning: true }),
      modelRegistry: registry,
    };
    h.setCtx(ctx);
    h.emit("session_start", { reason: "fork" }, ctx);
    assert.equal(await h.handle.waitForPendingRestore(), false);
    assert.deepEqual(h.setModelCalls, []);
    assert.equal(h.level(), "off");
  });

  it("reload skips model restore", async () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness({ thinkingStatePath: statePath });
    const ctx = {
      model: fakeModel({ id: "bar-model", provider: "bar", reasoning: true }),
      modelRegistry: registry,
    };
    h.setCtx(ctx);
    h.emit("session_start", { reason: "reload" }, ctx);
    assert.equal(await h.handle.waitForPendingRestore(), false);
    assert.deepEqual(h.setModelCalls, []);
    assert.equal(h.level(), "off");
  });

  it("startup still restores thinking level when modelRegistry.find throws", async () => {
    writeLastThinkingLevel("high", statePath);
    const h = harness({ thinkingStatePath: statePath });
    const ctx = {
      model: fakeModel({ id: "bar-model", provider: "bar", reasoning: true }),
      modelRegistry: {
        find: () => {
          throw new Error("registry lookup failed");
        },
      },
    };
    h.setCtx(ctx);
    h.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(await h.handle.waitForPendingRestore(), true);
    assert.deepEqual(h.setModelCalls, []);
    assert.equal(h.level(), "high");
  });

  it("cancels an in-flight restore timer on session_shutdown", async () => {
    writeLastThinkingLevel("high", statePath);
    let findCalls = 0;
    const h = harness({ thinkingStatePath: statePath });
    const ctx = {
      model: fakeModel({ id: "bar-model", provider: "bar", reasoning: true }),
      modelRegistry: {
        find: () => {
          findCalls += 1;
          return undefined;
        },
      },
    };
    h.setCtx(ctx);
    h.emit("session_start", { reason: "startup" }, ctx);
    const pending = h.handle.waitForPendingRestore();
    // Attempt 1 runs synchronously up to the retry sleep timer; shutdown cancels it.
    h.emit("session_shutdown", {}, ctx);
    assert.equal(await pending, false);
    assert.equal(findCalls, 1);
    assert.deepEqual(h.setModelCalls, []);
    assert.equal(h.level(), "off");
  });

  it("aborts a stale restore when a newer session_start arrives", async () => {
    writeLastThinkingLevel("high", statePath);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let callNum = 0;

    const h = harness({
      thinkingStatePath: statePath,
      onSetModel: async (model, ctx) => {
        callNum += 1;
        if (callNum === 1) {
          await firstGate;
          return true;
        }
        ctx.model = model;
        h.emit("model_select", { model, source: "set" }, ctx);
        return true;
      },
    });

    const firstCtx = {
      model: fakeModel({ id: "bar-model", provider: "bar", reasoning: true }),
      modelRegistry: registry,
    };
    h.setCtx(firstCtx);
    h.emit("session_start", { reason: "startup" }, firstCtx);
    const firstDone = h.handle.waitForPendingRestore();

    // Second session_start with reason="reload" supersedes the first before it resolves.
    const secondCtx = {
      model: fakeModel({ id: "bar-model", provider: "bar", reasoning: true }),
      modelRegistry: registry,
    };
    h.setCtx(secondCtx);
    h.emit("session_start", { reason: "reload" }, secondCtx);
    const secondDone = h.handle.waitForPendingRestore();

    releaseFirst();
    assert.equal(await firstDone, false);
    assert.equal(await secondDone, false);
    assert.equal(h.level(), "off");
  });

  it("aborts cleanly when ctx becomes stale mid-retry", async () => {
    writeLastThinkingLevel("high", statePath);
    let active = true;
    let findCalls = 0;
    const h = harness({ thinkingStatePath: statePath });
    const ctx = {
      get mode() {
        if (!active) throw new Error("stale after session replacement or reload");
        return "interactive";
      },
      model: fakeModel({ id: "bar-model", provider: "bar", reasoning: true }),
      modelRegistry: {
        find: () => {
          findCalls += 1;
          active = false;
          return undefined;
        },
      },
    };
    h.setCtx(ctx);
    h.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(await h.handle.waitForPendingRestore(), false);
    assert.equal(findCalls, 1);
    assert.equal(h.level(), "off");
  });
});
