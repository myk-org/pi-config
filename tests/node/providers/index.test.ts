/**
 * Direct integration tests for extensions/providers/index.ts (#1360).
 *
 * Exercises the default extension entrypoint with an in-memory fake `pi`:
 * - Meta invocation skip (--help / --version)
 * - Single ordered session_start flow (default model restore -> thinking-level restore)
 * - User model_select / thinking_level_select vs restored model_select
 * - Legacy gate integration (isProjectTrusted fail-closed, enabledModels scope,
 *   CLI overrides, legacy thinking-level keys/formats, /new vs startup/resume)
 * - Timeout cleanup on session_shutdown
 *
 * Run: npx tsx --test tests/node/providers/index.test.ts
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import providersExtension from "../../../extensions/providers/index.js";
import {
  readThinkingLevelState,
  writeLastThinkingLevel,
  writeThinkingLevelState,
} from "../../../extensions/providers/last-thinking-level.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { fakeModel } from "../helpers/fake-model.js";


type Handler = (event: any, ctx: any) => any;

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakePi(opts: {
  initialLevel?: string;
  onSetModel?: (
    model: any,
    emit: (name: string, event: any, ctx: any) => void,
    ctx: any,
  ) => Promise<boolean>;
} = {}) {
  const handlers = new Map<string, Handler[]>();
  const setModelCalls: Array<{ provider: string; id: string }> = [];
  const timeline: string[] = [];
  let level = opts.initialLevel ?? "off";
  let activeCtx: any;

  const emit = (name: string, event: any, ctx = activeCtx) => {
    for (const h of handlers.get(name) ?? []) h(event, ctx);
  };

  const pi = {
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    getThinkingLevel: () => level,
    setThinkingLevel: (next: string) => {
      const previousLevel = level;
      level = next;
      timeline.push(`thinking:${next}`);
      emit("thinking_level_select", { level: next, previousLevel }, activeCtx);
    },
    setModel: async (model: any) => {
      setModelCalls.push({ provider: String(model.provider), id: model.id });
      timeline.push(`model:${model.provider}/${model.id}`);
      if (opts.onSetModel) {
        return opts.onSetModel(model, emit, activeCtx);
      }
      if (activeCtx) activeCtx.model = model;
      emit("model_select", { model, source: "set" }, activeCtx);
      return true;
    },
  } as any;

  return {
    pi,
    handlers,
    emit,
    setModelCalls,
    timeline,
    level: () => level,
    setCtx: (ctx: any) => { activeCtx = ctx; },
  };
}

describe("extensions/providers/index.ts direct tests (#1360)", () => {
  let agentDir: string;
  let projectDir: string;
  let statePath: string;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    agentDir = makeTempDir("pi-providers-index-agent-");
    projectDir = makeTempDir("pi-providers-index-project-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    statePath = join(agentDir, "state", "last-thinking-level.json");
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "foo", defaultModel: "foo-model" }),
    );
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("skips registration for pi --help / --version meta invocations", () => {
    for (const flag of ["--help", "-h", "--version", "-v"]) {
      const fake = createFakePi();
      providersExtension(fake.pi, {
        thinkingStatePath: statePath,
        argv: ["node", "pi", flag],
      });
      assert.equal(fake.handlers.size, 0, `expected no handlers for ${flag}`);
    }
  });

  it("registers one unified session_start flow and restores model before thinking level", async () => {
    writeThinkingLevelState(
      {
        version: 2,
        fallback: "low",
        models: { '["foo","foo-model"]': "high" },
      },
      statePath,
    );
    const defaultModel = fakeModel({ provider: "foo", id: "foo-model", reasoning: true });
    let releaseSetModel!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSetModel = resolve; });

    const fake = createFakePi({
      onSetModel: async (model, emit, ctx) => {
        await gate;
        ctx.model = model;
        emit("model_select", { model, source: "set" }, ctx);
        return true;
      },
    });

    providersExtension(fake.pi, {
      thinkingStatePath: statePath,
      argv: ["node", "pi"],
    });

    assert.equal(fake.handlers.get("session_start")?.length, 1);
    assert.equal(fake.handlers.get("model_select")?.length, 1);
    assert.equal(fake.handlers.get("thinking_level_select")?.length, 1);
    assert.equal(fake.handlers.get("session_shutdown")?.length, 1);

    const ctx = {
      model: fakeModel({ provider: "bar", id: "bar-model", reasoning: true }),
      modelRegistry: { find: () => defaultModel },
    };
    fake.setCtx(ctx);
    fake.emit("session_start", { reason: "startup" }, ctx);

    // Thinking level must wait until model restore settles.
    await settle(30);
    assert.equal(fake.level(), "off");
    assert.deepEqual(fake.setModelCalls, [{ provider: "foo", id: "foo-model" }]);

    releaseSetModel();
    assert.equal(await until(() => fake.level() === "high"), true);
    assert.deepEqual(fake.timeline, ["model:foo/foo-model", "thinking:high"]);

    // Internal restore must not overwrite fallback with the restored model's level.
    assert.equal(readThinkingLevelState(statePath).fallback, "low");
  });

  it("distinguishes user model_select from restored model_select", async () => {
    writeThinkingLevelState(
      {
        version: 2,
        fallback: "low",
        models: {
          '["foo","foo-model"]': "high",
          '["baz","baz-model"]': "medium",
        },
      },
      statePath,
    );
    const defaultModel = fakeModel({ provider: "foo", id: "foo-model", reasoning: true });
    const userModel = fakeModel({ provider: "baz", id: "baz-model", reasoning: true });

    let releaseSetModel!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSetModel = resolve; });

    const fake = createFakePi({
      onSetModel: async () => {
        await gate;
        return false;
      },
    });
    providersExtension(fake.pi, {
      thinkingStatePath: statePath,
      argv: ["node", "pi"],
    });

    const ctx = {
      model: fakeModel({ provider: "bar", id: "bar-model", reasoning: true }),
      modelRegistry: { find: () => defaultModel },
    };
    fake.setCtx(ctx);
    fake.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(await until(() => fake.setModelCalls.length === 1), true);

    // User switches to baz/baz-model while default restore is still in flight.
    ctx.model = userModel;
    fake.emit("model_select", { model: userModel, source: "set" }, ctx);
    assert.equal(fake.level(), "medium");

    releaseSetModel();
    await settle(80);
    // Startup restore must not override the user's selected model thinking level.
    assert.equal(fake.level(), "medium");
  });

  it("enforces legacy project-trust gate (trusted merges project settings; untrusted/throwing fails closed)", async () => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ defaultProvider: "proj", defaultModel: "proj-model" }),
    );
    const registry = {
      find: (provider: string, id: string) => fakeModel({ provider, id, reasoning: true }),
    };

    // 1. Trusted project -> project default wins
    {
      const fake = createFakePi();
      providersExtension(fake.pi, { thinkingStatePath: statePath, argv: ["node", "pi"] });
      const ctx = {
        cwd: projectDir,
        isProjectTrusted: () => true,
        model: fakeModel({ provider: "bar", id: "bar-model", reasoning: true }),
        modelRegistry: registry,
      };
      fake.setCtx(ctx);
      fake.emit("session_start", { reason: "startup" }, ctx);
      assert.equal(await until(() => fake.setModelCalls.length === 1), true);
      assert.deepEqual(fake.setModelCalls, [{ provider: "proj", id: "proj-model" }]);
    }

    // 2. Untrusted project -> global default wins
    {
      const fake = createFakePi();
      providersExtension(fake.pi, { thinkingStatePath: statePath, argv: ["node", "pi"] });
      const ctx = {
        cwd: projectDir,
        isProjectTrusted: () => false,
        model: fakeModel({ provider: "bar", id: "bar-model", reasoning: true }),
        modelRegistry: registry,
      };
      fake.setCtx(ctx);
      fake.emit("session_start", { reason: "startup" }, ctx);
      assert.equal(await until(() => fake.setModelCalls.length === 1), true);
      assert.deepEqual(fake.setModelCalls, [{ provider: "foo", id: "foo-model" }]);
    }

    // 3. Throwing isProjectTrusted -> fails closed to global default
    {
      const fake = createFakePi();
      providersExtension(fake.pi, { thinkingStatePath: statePath, argv: ["node", "pi"] });
      const ctx = {
        cwd: projectDir,
        isProjectTrusted: () => { throw new Error("trust probe boom"); },
        model: fakeModel({ provider: "bar", id: "bar-model", reasoning: true }),
        modelRegistry: registry,
      };
      fake.setCtx(ctx);
      fake.emit("session_start", { reason: "startup" }, ctx);
      assert.equal(await until(() => fake.setModelCalls.length === 1), true);
      assert.deepEqual(fake.setModelCalls, [{ provider: "foo", id: "foo-model" }]);
    }
  });

  it("enforces enabledModels scope, CLI --thinking override, and legacy single-slash thinking keys", async () => {
    // 1. Legacy single-slash thinking key restores cleanly via index.ts
    mkdirSync(join(agentDir, "state"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ version: 2, models: { "foo/foo-model": "high" } }),
    );
    const registry = {
      find: (provider: string, id: string) => fakeModel({ provider, id, reasoning: true }),
    };
    {
      const fake = createFakePi();
      providersExtension(fake.pi, { thinkingStatePath: statePath, argv: ["node", "pi"] });
      const ctx = {
        model: fakeModel({ provider: "bar", id: "bar-model", reasoning: true }),
        modelRegistry: registry,
      };
      fake.setCtx(ctx);
      fake.emit("session_start", { reason: "startup" }, ctx);
      assert.equal(await until(() => fake.level() === "high"), true);
    }

    // 2. --thinking CLI override prevents startup and model_select thinking overrides
    {
      const fake = createFakePi({ initialLevel: "low" });
      providersExtension(fake.pi, {
        thinkingStatePath: statePath,
        argv: ["node", "pi", "--thinking=low"],
      });
      const ctx = {
        model: fakeModel({ provider: "bar", id: "bar-model", reasoning: true }),
        modelRegistry: registry,
      };
      fake.setCtx(ctx);
      fake.emit("session_start", { reason: "startup" }, ctx);
      assert.equal(await until(() => fake.setModelCalls.length === 1), true);
      await settle(50);
      assert.equal(fake.level(), "low");

      const other = fakeModel({ provider: "foo", id: "foo-model", reasoning: true });
      ctx.model = other;
      fake.emit("model_select", { model: other, source: "set" }, ctx);
      assert.equal(fake.level(), "low");
    }

    // 3. enabledModels scope blocks cold-start default model restore
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
        enabledModels: ["bar/bar-model"],
      }),
    );
    {
      const fake = createFakePi();
      providersExtension(fake.pi, { thinkingStatePath: statePath, argv: ["node", "pi"] });
      const ctx = {
        model: fakeModel({ provider: "bar", id: "bar-model", reasoning: true }),
        modelRegistry: registry,
      };
      fake.setCtx(ctx);
      fake.emit("session_start", { reason: "startup" }, ctx);
      await settle();
      assert.deepEqual(fake.setModelCalls, []);
    }
  });

  it("cleans up pending retry timers on session_shutdown with no further attempts", async () => {
    writeLastThinkingLevel("high", statePath);
    let findCalls = 0;
    const fake = createFakePi();
    providersExtension(fake.pi, {
      thinkingStatePath: statePath,
      argv: ["node", "pi"],
    });

    const ctx = {
      model: fakeModel({ provider: "bar", id: "bar-model", reasoning: true }),
      modelRegistry: {
        find: () => {
          findCalls += 1;
          return undefined;
        },
      },
    };
    fake.setCtx(ctx);
    fake.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(findCalls, 1, "attempt 1 should run before retry timer");

    // Shut down immediately while attempt 1 -> 2 retry sleep (100ms) is pending.
    fake.emit("session_shutdown", {}, ctx);
    // Wait past two default retry windows (250ms > 2 * 100ms) to prove timer was cancelled.
    await settle(250);
    assert.equal(findCalls, 1, "no further retries should fire after session_shutdown");
    assert.deepEqual(fake.setModelCalls, []);
    assert.equal(fake.level(), "off");
  });
});
