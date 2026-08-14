/**
 * Unit tests for #753 cold-start default model restore (provider-agnostic).
 *
 * Run: npx tsx --test tests/node/providers/restore-default-model.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  shouldRestoreDefaultModel,
  argvHasModelOrProviderOverride,
  hasEnabledModelsScope,
  readPiAgentDefaults,
  mergePiAgentDefaults,
  resolveDefaultModel,
  resolvePiAgentDir,
  resolvePiAgentSettingsPath,
  resolveProjectPiSettingsPath,
  isRestoreModelHopeless,
  restoreDefaultModelOnSessionStart,
} from "../../../extensions/providers/restore-default-model.js";

describe("shouldRestoreDefaultModel (#753 agnostic)", () => {
  it("restores when current missing with defaults set (startup)", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: null,
        currentModelId: null,
      }),
      true,
    );
  });

  it("restores when current ≠ default (new)", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "new",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
      }),
      true,
    );
  });

  it("restores when same provider but different model id", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-a",
        currentProvider: "foo",
        currentModelId: "foo-b",
      }),
      true,
    );
  });

  it("skips when current === default", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "foo",
        currentModelId: "foo-model",
      }),
      false,
    );
  });

  it("skips on resume", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "resume",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
      }),
      false,
    );
  });

  it("skips on fork", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "fork",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
      }),
      false,
    );
  });

  it("skips on reload", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "reload",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
      }),
      false,
    );
  });

  it("skips when reason missing", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
      }),
      false,
    );
  });

  it("skips when argv has --model", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
        argv: ["node", "pi", "--model", "bar/bar-model"],
      }),
      false,
    );
  });

  it("skips when argv has --provider", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
        argv: ["node", "pi", "--provider", "bar"],
      }),
      false,
    );
  });

  it("skips when argv has --models", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
        argv: ["node", "pi", "--models", "foo/foo-model"],
      }),
      false,
    );
  });

  it("restores when argv has neither --model nor --provider nor --models", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
        argv: ["node", "pi", "--help"],
      }),
      true,
    );
  });

  it("skips when enabledModels is non-empty (scopes like --models)", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
        enabledModels: ["bar/bar-model"],
      }),
      false,
    );
  });

  it("restores when enabledModels is empty array", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
        enabledModels: [],
      }),
      true,
    );
  });

  it("restores when enabledModels is missing/null", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
        enabledModels: null,
      }),
      true,
    );
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
      }),
      true,
    );
  });

  it("skips when defaultModelId empty", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: "foo",
        defaultModelId: "  ",
        currentProvider: "bar",
        currentModelId: "bar-model",
      }),
      false,
    );
  });

  it("skips when defaultProvider missing", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: null,
        defaultModelId: "foo-model",
        currentProvider: "bar",
        currentModelId: "bar-model",
      }),
      false,
    );
  });

  it("trims whitespace on provider/model comparisons", () => {
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: " foo ",
        defaultModelId: " foo-model ",
        currentProvider: "bar",
        currentModelId: "bar-model",
      }),
      true,
    );
    assert.equal(
      shouldRestoreDefaultModel({
        reason: "startup",
        defaultProvider: " foo ",
        defaultModelId: " foo-model ",
        currentProvider: " foo ",
        currentModelId: " foo-model ",
      }),
      false,
    );
  });
});

describe("argvHasModelOrProviderOverride / hasEnabledModelsScope", () => {
  it("detects --model flag", () => {
    assert.equal(argvHasModelOrProviderOverride(["--model"]), true);
    assert.equal(argvHasModelOrProviderOverride(["--model=foo/foo-model"]), true);
  });

  it("detects --provider flag", () => {
    assert.equal(argvHasModelOrProviderOverride(["--provider"]), true);
    assert.equal(argvHasModelOrProviderOverride(["--provider=foo"]), true);
  });

  it("detects --models flag", () => {
    assert.equal(argvHasModelOrProviderOverride(["--models"]), true);
    assert.equal(argvHasModelOrProviderOverride(["--models=foo/foo-model"]), true);
  });

  it("ignores argv without model/provider/models flags", () => {
    assert.equal(argvHasModelOrProviderOverride(["node", "pi"]), false);
    assert.equal(argvHasModelOrProviderOverride(null), false);
    assert.equal(argvHasModelOrProviderOverride(undefined), false);
  });

  it("hasEnabledModelsScope only for non-empty arrays", () => {
    assert.equal(hasEnabledModelsScope(["foo/bar"]), true);
    assert.equal(hasEnabledModelsScope([]), false);
    assert.equal(hasEnabledModelsScope(null), false);
    assert.equal(hasEnabledModelsScope(undefined), false);
  });
});

describe("resolvePiAgentDir / settings path (PI_CODING_AGENT_DIR)", () => {
  const prev = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  });

  it("prefers explicit agentDir over env", () => {
    process.env.PI_CODING_AGENT_DIR = "/env/agent";
    assert.equal(resolvePiAgentDir("/explicit/agent"), "/explicit/agent");
    assert.equal(
      resolvePiAgentSettingsPath("/explicit/agent"),
      join("/explicit/agent", "settings.json"),
    );
  });

  it("uses PI_CODING_AGENT_DIR when set with no agentDir", () => {
    process.env.PI_CODING_AGENT_DIR = "/custom/pi-agent";
    assert.equal(resolvePiAgentDir(), "/custom/pi-agent");
    assert.equal(
      resolvePiAgentSettingsPath(),
      join("/custom/pi-agent", "settings.json"),
    );
  });

  it("falls back to ~/.pi/agent when env unset", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const dir = resolvePiAgentDir();
    assert.ok(dir.endsWith(join(".pi", "agent")));
  });

  it("resolveProjectPiSettingsPath joins cwd/.pi/settings.json", () => {
    assert.equal(
      resolveProjectPiSettingsPath("/proj"),
      join("/proj", ".pi", "settings.json"),
    );
  });
});

describe("readPiAgentDefaults + merge", () => {
  let dir: string;
  const prev = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-agent-settings-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  });

  it("reads defaultProvider, defaultModel, enabledModels from settings.json", () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
        enabledModels: ["foo/foo-model", "bar/bar-model"],
      }),
    );
    const got = readPiAgentDefaults(path);
    assert.equal(got.defaultProvider, "foo");
    assert.equal(got.defaultModel, "foo-model");
    assert.deepEqual(got.enabledModels, ["foo/foo-model", "bar/bar-model"]);
  });

  it("reads enabledModels as empty array when present but empty", () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
        enabledModels: [],
      }),
    );
    const got = readPiAgentDefaults(path);
    assert.deepEqual(got.enabledModels, []);
  });

  it("reads via custom PI_CODING_AGENT_DIR when path omitted", () => {
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        defaultProvider: "bar",
        defaultModel: "bar-model",
      }),
    );
    const got = readPiAgentDefaults();
    assert.equal(got.defaultProvider, "bar");
    assert.equal(got.defaultModel, "bar-model");
  });

  it("returns empty object when file missing", () => {
    const got = readPiAgentDefaults(join(dir, "missing.json"));
    assert.deepEqual(got, {});
  });

  it("mergePiAgentDefaults: project wins for defaults plus enabledModels", () => {
    const merged = mergePiAgentDefaults(
      {
        defaultProvider: "global-p",
        defaultModel: "global-m",
        enabledModels: ["g/a"],
      },
      {
        defaultProvider: "project-p",
        defaultModel: "project-m",
        enabledModels: ["p/b"],
      },
    );
    assert.deepEqual(merged, {
      defaultProvider: "project-p",
      defaultModel: "project-m",
      enabledModels: ["p/b"],
    });
  });

  it("mergePiAgentDefaults: keeps global when project omits fields", () => {
    const merged = mergePiAgentDefaults(
      {
        defaultProvider: "global-p",
        defaultModel: "global-m",
        enabledModels: ["g/a"],
      },
      {},
    );
    assert.deepEqual(merged, {
      defaultProvider: "global-p",
      defaultModel: "global-m",
      enabledModels: ["g/a"],
    });
  });

  it("readPiAgentDefaults merges project over global when cwd set", () => {
    const agentDir = join(dir, "agent");
    const cwd = join(dir, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "global-p",
        defaultModel: "global-m",
        enabledModels: [],
      }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        defaultProvider: "project-p",
        defaultModel: "project-m",
        enabledModels: ["project-p/project-m"],
      }),
    );
    const got = readPiAgentDefaults({ agentDir, cwd, projectTrusted: true });
    assert.equal(got.defaultProvider, "project-p");
    assert.equal(got.defaultModel, "project-m");
    assert.deepEqual(got.enabledModels, ["project-p/project-m"]);
  });

  it("readPiAgentDefaults: missing projectTrusted fails closed (ignores project)", () => {
    const agentDir = join(dir, "agent-failclosed");
    const cwd = join(dir, "project-failclosed");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "global-p",
        defaultModel: "global-m",
      }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        defaultProvider: "project-p",
        defaultModel: "project-m",
      }),
    );
    const got = readPiAgentDefaults({ agentDir, cwd });
    assert.equal(got.defaultProvider, "global-p");
    assert.equal(got.defaultModel, "global-m");
  });

  it("readPiAgentDefaults: untrusted ignores project; trusted project wins", () => {
    const agentDir = join(dir, "agent");
    const cwd = join(dir, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "global-p",
        defaultModel: "global-m",
        enabledModels: ["global-p/global-m"],
      }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        defaultProvider: "project-p",
        defaultModel: "project-m",
        enabledModels: ["project-p/project-m"],
      }),
    );

    const untrusted = readPiAgentDefaults({
      agentDir,
      cwd,
      projectTrusted: false,
    });
    assert.equal(untrusted.defaultProvider, "global-p");
    assert.equal(untrusted.defaultModel, "global-m");
    assert.deepEqual(untrusted.enabledModels, ["global-p/global-m"]);

    const trusted = readPiAgentDefaults({
      agentDir,
      cwd,
      projectTrusted: true,
    });
    assert.equal(trusted.defaultProvider, "project-p");
    assert.equal(trusted.defaultModel, "project-m");
    assert.deepEqual(trusted.enabledModels, ["project-p/project-m"]);
  });
});

describe("resolveDefaultModel + restoreDefaultModelOnSessionStart", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-restore-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolveDefaultModel uses find when present", () => {
    const model = { id: "foo-model", provider: "foo" };
    const registry = {
      find: (p: string, id: string) =>
        p === "foo" && id === "foo-model" ? model : undefined,
    };
    assert.equal(resolveDefaultModel(registry, "foo", "foo-model"), model);
  });

  it("resolveDefaultModel falls back to getAvailable", () => {
    const model = { id: "foo-model", provider: "foo" };
    const registry = { getAvailable: () => [model] };
    assert.equal(resolveDefaultModel(registry, "foo", "foo-model"), model);
  });

  it("isRestoreModelHopeless when registeredProviders lack default", () => {
    assert.equal(
      isRestoreModelHopeless(undefined, "foo", "foo-model", ["bar"]),
      true,
    );
  });

  it("isRestoreModelHopeless when registeredProviders empty", () => {
    assert.equal(
      isRestoreModelHopeless(undefined, "foo", "foo-model", []),
      true,
    );
  });

  it("isRestoreModelHopeless false when provider is registered", () => {
    assert.equal(
      isRestoreModelHopeless(
        {
          find: () => undefined,
          getAvailable: () => [{ id: "other", provider: "bar" }],
        },
        "foo",
        "foo-model",
        ["foo"],
      ),
      false,
    );
  });

  it("isRestoreModelHopeless false when registeredProviders omitted", () => {
    assert.equal(
      isRestoreModelHopeless(
        { getAvailable: () => [{ id: "other", provider: "bar" }] },
        "foo",
        "foo-model",
      ),
      false,
    );
  });

  it("restore when current ≠ default", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let setModelArg: unknown;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => target },
      },
      setModel: async (m) => {
        setModelArg = m;
        return true;
      },
    });
    assert.equal(ok, true);
    assert.equal(setModelArg, target);
  });

  it("skips on resume", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "resume",
      argv: ["node", "pi"],
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => ({ id: "foo-model", provider: "foo" }) },
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("skips when current === default", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      ctx: {
        model: { id: "foo-model", provider: "foo" },
        modelRegistry: { find: () => undefined },
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("skips when argv has --model", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi", "--model", "bar/bar-model"],
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => ({ id: "foo-model", provider: "foo" }) },
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("skips when argv has --provider", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi", "--provider", "bar"],
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => ({ id: "foo-model", provider: "foo" }) },
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("skips when argv has --models", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi", "--models", "bar/bar-model"],
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => ({ id: "foo-model", provider: "foo" }) },
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("skips when settings enabledModels is non-empty", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
        enabledModels: ["bar/bar-model"],
      }),
    );
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => ({ id: "foo-model", provider: "foo" }) },
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("restores when settings enabledModels is empty", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
        enabledModels: [],
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => target },
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, true);
    assert.equal(called, true);
  });

  it("uses project settings over global when cwd set", async () => {
    const agentDir = join(dir, "agent");
    const cwd = join(dir, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "global",
        defaultModel: "global-model",
      }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let setModelArg: unknown;
    const ok = await restoreDefaultModelOnSessionStart({
      agentDir,
      cwd,
      reason: "startup",
      argv: ["node", "pi"],
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => target },
      },
      setModel: async (m) => {
        setModelArg = m;
        return true;
      },
    });
    assert.equal(ok, true);
    assert.equal(setModelArg, target);
  });

  it("skips when defaults missing", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({}));
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => ({ id: "foo-model", provider: "foo" }) },
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("fail-fast when registeredProviders lack default provider", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    let finds = 0;
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      registeredProviders: ["bar"],
      retries: 5,
      delayMs: 10,
      sleep: async () => {},
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: {
          find: () => {
            finds += 1;
            return undefined;
          },
        },
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
    assert.equal(finds, 0);
  });

  it("fail-fast when registeredProviders empty", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      registeredProviders: [],
      retries: 5,
      delayMs: 10,
      sleep: async () => {},
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => undefined },
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("retries when setModel returns false then true", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let attempts = 0;
    const sleeps: number[] = [];
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      retries: 5,
      delayMs: 50,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => target },
      },
      setModel: async () => {
        attempts += 1;
        return attempts >= 2;
      },
    });
    assert.equal(ok, true);
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [50]);
  });

  it("keeps retrying when getAvailable misses target but find returns it", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let attempts = 0;
    const sleeps: number[] = [];
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      registeredProviders: ["foo"],
      retries: 5,
      delayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: {
          find: () => target,
          getAvailable: () => [{ id: "bar-model", provider: "bar" }],
        },
      },
      setModel: async () => {
        attempts += 1;
        return attempts >= 2;
      },
    });
    assert.equal(ok, true);
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [10]);
  });

  it("retries when model not resolvable then becomes available", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let finds = 0;
    let setCalls = 0;
    const sleeps: number[] = [];
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      registeredProviders: ["foo"],
      retries: 4,
      delayMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: {
          find: () => {
            finds += 1;
            return finds >= 2 ? target : undefined;
          },
          getAvailable: () => [],
        },
      },
      setModel: async () => {
        setCalls += 1;
        return true;
      },
    });
    assert.equal(ok, true);
    assert.equal(finds, 2);
    assert.equal(setCalls, 1);
    assert.deepEqual(sleeps, [25]);
  });

  it("returns false after retries when setModel always false", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let attempts = 0;
    const sleeps: number[] = [];
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      retries: 3,
      delayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => target },
      },
      setModel: async () => {
        attempts += 1;
        return false;
      },
    });
    assert.equal(ok, false);
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [10, 10]);
  });

  it("without registeredProviders retries native default (no cli fail-fast)", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "google",
        defaultModel: "gemini-flash",
      }),
    );
    const target = { id: "gemini-flash", provider: "google" };
    let finds = 0;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      retries: 3,
      delayMs: 10,
      sleep: async () => {},
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: {
          find: () => {
            finds += 1;
            return finds >= 2 ? target : undefined;
          },
        },
      },
      setModel: async () => true,
    });
    assert.equal(ok, true);
    assert.equal(finds, 2);
  });

  it("getCurrentModel aborts when already at default before setModel", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    let called = false;
    let polls = 0;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      retries: 5,
      delayMs: 10,
      sleep: async () => {},
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => ({ id: "foo-model", provider: "foo" }) },
      },
      getCurrentModel: () => {
        polls += 1;
        return { id: "foo-model", provider: "foo" };
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
    assert.equal(polls, 1);
  });

  it("getCurrentModel aborts when user switched away from snapshot", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    let called = false;
    let polls = 0;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      retries: 5,
      delayMs: 10,
      sleep: async () => {},
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => ({ id: "foo-model", provider: "foo" }) },
      },
      getCurrentModel: () => {
        polls += 1;
        // User switched to baz mid-retry (away from session_start bar snapshot)
        return { id: "baz-model", provider: "baz" };
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
    assert.equal(polls, 1);
  });

  it("getCurrentModel empty snapshot: first live non-default is baseline, not abort", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let called = false;
    let polls = 0;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      retries: 5,
      delayMs: 10,
      sleep: async () => {},
      ctx: {
        // No initial model at session_start
        model: undefined,
        modelRegistry: { find: () => target },
      },
      getCurrentModel: () => {
        polls += 1;
        // Same non-default across polls — first sighting is baseline, not abort
        return { id: "bar-model", provider: "bar" };
      },
      setModel: async (m) => {
        called = true;
        assert.equal(m, target);
        return true;
      },
    });
    assert.equal(ok, true);
    assert.equal(called, true);
    assert.ok(polls >= 1);
  });

  it("getCurrentModel empty snapshot: abort only when live changes from first-seen", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    let called = false;
    let polls = 0;
    let finds = 0;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      retries: 5,
      delayMs: 10,
      sleep: async () => {},
      ctx: {
        model: undefined,
        modelRegistry: {
          find: () => {
            finds += 1;
            // Unresolvable first attempt so we retry and see a live change
            return finds >= 2 ? { id: "foo-model", provider: "foo" } : undefined;
          },
        },
      },
      getCurrentModel: () => {
        polls += 1;
        // First poll(s): bar baseline; later: baz → user intent change → abort
        if (polls <= 2) return { id: "bar-model", provider: "bar" };
        return { id: "baz-model", provider: "baz" };
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
    assert.ok(polls >= 3);
  });

  it("getCurrentModel continues when live still matches snapshot", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let called = false;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => target },
      },
      getCurrentModel: () => ({ id: "bar-model", provider: "bar" }),
      setModel: async (m) => {
        called = true;
        assert.equal(m, target);
        return true;
      },
    });
    assert.equal(ok, true);
    assert.equal(called, true);
  });

  it("getCurrentModel aborts on later attempt after user switch", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let attempts = 0;
    let polls = 0;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      retries: 5,
      delayMs: 10,
      sleep: async () => {},
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => target },
      },
      getCurrentModel: () => {
        polls += 1;
        // pre-resolve + pre-setModel both run on attempt 1; then attempt 2 pre-resolve
        if (polls <= 2) return { id: "bar-model", provider: "bar" };
        return { id: "baz-model", provider: "baz" };
      },
      setModel: async () => {
        attempts += 1;
        return false;
      },
    });
    assert.equal(ok, false);
    assert.equal(attempts, 1);
    assert.equal(polls, 3);
  });

  it("getCurrentModel aborts at pre-setModel TOCTOU check", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaultProvider: "foo",
        defaultModel: "foo-model",
      }),
    );
    const target = { id: "foo-model", provider: "foo" };
    let called = false;
    let polls = 0;
    const ok = await restoreDefaultModelOnSessionStart({
      settingsPath: path,
      reason: "startup",
      argv: ["node", "pi"],
      retries: 5,
      delayMs: 10,
      sleep: async () => {},
      ctx: {
        model: { id: "bar-model", provider: "bar" },
        modelRegistry: { find: () => target },
      },
      getCurrentModel: () => {
        polls += 1;
        if (polls === 1) return { id: "bar-model", provider: "bar" };
        // Switched between resolve and setModel
        return { id: "baz-model", provider: "baz" };
      },
      setModel: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(ok, false);
    assert.equal(called, false);
    assert.equal(polls, 2);
  });
});
