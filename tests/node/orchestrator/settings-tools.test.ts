/**
 * Unit tests for #1473 structured LLM settings tools (`settings_get` and `settings_set`).
 *
 * Run with: npx tsx --test tests/node/orchestrator/settings-tools.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SETTINGS_KEYS,
  clearSettingsCache,
  setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";
import {
  SETTINGS_APPROVAL_APPROVE,
  SETTINGS_APPROVAL_DENY,
  buildSettingsApprovalPrompt,
  registerSettingsTools,
} from "../../../extensions/orchestrator/settings-tools.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

function createToolHarness() {
  const tools = new Map<string, any>();
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const pi = {
    registerTool: (def: any) => { tools.set(def.name, def); },
    events: {
      on: () => () => {},
      emit: (channel: string, payload: unknown) => { emitted.push({ channel, payload }); },
    },
  } as unknown as ExtensionAPI;

  registerSettingsTools(pi);
  return { tools, emitted };
}

describe("settings_get tool (#1473)", () => {
  let projectDir: string;
  let globalDir: string;
  let prevDcoEnv: string | undefined;

  beforeEach(() => {
    prevDcoEnv = process.env.PI_DCO;
    delete process.env.PI_DCO;
    projectDir = makeTempDir("settings-tools-get-proj-");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    globalDir = makeTempDir("settings-tools-get-global-");
    setGlobalSettingsPath(join(globalDir, "pi-config-settings.json"));
    clearSettingsCache();
  });

  afterEach(() => {
    if (prevDcoEnv === undefined) delete process.env.PI_DCO;
    else process.env.PI_DCO = prevDcoEnv;
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("registers under runtime codemode namespace with read-only annotations", () => {
    const { tools } = createToolHarness();
    const tool = tools.get("settings_get");
    assert.ok(tool);
    assert.equal(tool.exposure, "codemode");
    assert.equal(tool.namespace?.name, "runtime");
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.idempotentHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  });

  it("returns effective value with per-scope breakdown for a single key", async () => {
    process.env.PI_DCO = "false";
    writeFileSync(join(globalDir, "pi-config-settings.json"), JSON.stringify({ dco: false }), "utf8");
    writeFileSync(join(projectDir, ".pi", "pi-config-settings.json"), JSON.stringify({ dco: true }), "utf8");
    clearSettingsCache();

    const { tools } = createToolHarness();
    const res = await tools.get("settings_get").execute("c1", { key: "dco" }, undefined, undefined, { cwd: projectDir });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.setting.key, "dco");
    assert.equal(parsed.setting.effective, true);
    assert.equal(parsed.setting.source, "P");
    assert.equal(parsed.setting.global_only, false);
    assert.equal(parsed.setting.scopes.project, true);
    assert.equal(parsed.setting.scopes.global, false);
    assert.equal(parsed.setting.scopes.env, false);
    assert.equal(parsed.setting.scopes.default, false);
    assert.ok(parsed.setting.description.length > 0);
  });

  it("filters results by category case-insensitively", async () => {
    const { tools } = createToolHarness();
    const res = await tools.get("settings_get").execute("c2", { category: "git" }, undefined, undefined, { cwd: projectDir });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.settings.length > 0);
    assert.ok(parsed.settings.every((s: any) => s.category === "Git"));
  });

  it("returns only non-default overrides when only_overrides is true", async () => {
    writeFileSync(join(projectDir, ".pi", "pi-config-settings.json"), JSON.stringify({ dco: true }), "utf8");
    writeFileSync(join(globalDir, "pi-config-settings.json"), JSON.stringify({ advisor_enabled: true }), "utf8");
    clearSettingsCache();

    const { tools } = createToolHarness();
    const res = await tools.get("settings_get").execute("c3", { only_overrides: true }, undefined, undefined, { cwd: projectDir });
    const parsed = JSON.parse(res.content[0].text);
    const keys = parsed.settings.map((s: any) => s.key);
    assert.ok(keys.includes("dco"));
    assert.ok(keys.includes("advisor_enabled"));
    assert.ok(parsed.settings.every((s: any) => s.source !== "D"));
  });

  it("returns error for an unknown setting key", async () => {
    const { tools } = createToolHarness();
    const res = await tools.get("settings_get").execute("c4", { key: "no_such_key" }, undefined, undefined, { cwd: projectDir });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Unknown setting key/);
  });
});

describe("settings_set tool (#1473)", () => {
  let projectDir: string;
  let globalDir: string;
  let prevSubagentChild: string | undefined;

  beforeEach(() => {
    prevSubagentChild = process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD;
    projectDir = makeTempDir("settings-tools-set-proj-");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    globalDir = makeTempDir("settings-tools-set-global-");
    setGlobalSettingsPath(join(globalDir, "pi-config-settings.json"));
    clearSettingsCache();
  });

  afterEach(() => {
    if (prevSubagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = prevSubagentChild;
    setGlobalSettingsPath(null);
    clearSettingsCache();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("registers as model-only with destructiveHint true", () => {
    const { tools } = createToolHarness();
    const tool = tools.get("settings_set");
    assert.ok(tool);
    assert.equal(tool.exposure, "model-only");
    assert.equal(tool.namespace, undefined);
    assert.equal(tool.annotations?.destructiveHint, true);
    assert.equal(tool.annotations?.readOnlyHint, false);
  });

  it("rejects unknown setting keys before prompting", async () => {
    let prompted = false;
    const { tools } = createToolHarness();
    const res = await tools.get("settings_set").execute(
      "s1",
      { action: "set", key: "bogus_key", scope: "project", value: true },
      undefined,
      undefined,
      { cwd: projectDir, hasUI: true, ui: { select: async () => { prompted = true; return SETTINGS_APPROVAL_APPROVE; } } },
    );
    assert.equal(res.isError, true);
    assert.equal(prompted, false);
  });

  it("rejects invalid schema values before prompting", async () => {
    let prompted = false;
    const { tools } = createToolHarness();
    const res = await tools.get("settings_set").execute(
      "s2",
      { action: "set", key: "advisor_interval_turns", scope: "project", value: 999 },
      undefined,
      undefined,
      { cwd: projectDir, hasUI: true, ui: { select: async () => { prompted = true; return SETTINGS_APPROVAL_APPROVE; } } },
    );
    assert.equal(res.isError, true);
    assert.equal(prompted, false);
    assert.match(res.content[0].text, /<= 50/);
  });

  it("rejects project writes for global_only settings", async () => {
    const orig = SETTINGS_KEYS.dco.global_only;
    SETTINGS_KEYS.dco.global_only = true;
    try {
      let prompted = false;
      const { tools } = createToolHarness();
      const res = await tools.get("settings_set").execute(
        "s3",
        { action: "set", key: "dco", scope: "project", value: true },
        undefined,
        undefined,
        { cwd: projectDir, hasUI: true, ui: { select: async () => { prompted = true; return SETTINGS_APPROVAL_APPROVE; } } },
      );
      assert.equal(res.isError, true);
      assert.equal(prompted, false);
      assert.match(res.content[0].text, /global-only/);
    } finally {
      if (orig === undefined) delete SETTINGS_KEYS.dco.global_only;
      else SETTINGS_KEYS.dco.global_only = orig;
    }
  });

  it("fails closed when ctx.hasUI is false", async () => {
    const { tools } = createToolHarness();
    const res = await tools.get("settings_set").execute(
      "s4",
      { action: "set", key: "dco", scope: "project", value: true },
      undefined,
      undefined,
      { cwd: projectDir, hasUI: false },
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /interactive UI/);
    assert.equal(existsSync(join(projectDir, ".pi", "pi-config-settings.json")), false);
  });

  it("fails closed when PI_SUBAGENT_CHILD is 1", async () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    const { tools } = createToolHarness();
    const res = await tools.get("settings_set").execute(
      "s5",
      { action: "set", key: "dco", scope: "project", value: true },
      undefined,
      undefined,
      { cwd: projectDir, hasUI: true, ui: { select: async () => SETTINGS_APPROVAL_APPROVE } },
    );
    assert.equal(res.isError, true);
    assert.equal(existsSync(join(projectDir, ".pi", "pi-config-settings.json")), false);
  });

  it("refuses to write when user denies the permission prompt", async () => {
    let seenOpts: any;
    const { tools } = createToolHarness();
    const res = await tools.get("settings_set").execute(
      "s6",
      { action: "set", key: "dco", scope: "project", value: true },
      undefined,
      undefined,
      {
        cwd: projectDir,
        hasUI: true,
        ui: {
          select: async (_title: string, _options: string[], opts: any) => {
            seenOpts = opts;
            return SETTINGS_APPROVAL_DENY;
          },
        },
      },
    );
    assert.equal(res.isError, true);
    assert.equal(seenOpts?.blockedKind, "permission");
    assert.equal(existsSync(join(projectDir, ".pi", "pi-config-settings.json")), false);
  });

  it("refuses to write when user cancels the permission prompt", async () => {
    const { tools } = createToolHarness();
    const res = await tools.get("settings_set").execute(
      "s7",
      { action: "set", key: "dco", scope: "project", value: true },
      undefined,
      undefined,
      {
        cwd: projectDir,
        hasUI: true,
        ui: { select: async () => undefined },
      },
    );
    assert.equal(res.isError, true);
    assert.equal(existsSync(join(projectDir, ".pi", "pi-config-settings.json")), false);
  });

  it("includes explicit security warning banner for protected keys", () => {
    const prompt = buildSettingsApprovalPrompt({
      action: "set",
      key: "dangerous_command_allowlist",
      scope: "project",
      scopeFile: "/tmp/proj/.pi/pi-config-settings.json",
      def: SETTINGS_KEYS.dangerous_command_allowlist,
      hadOld: false,
      oldValue: undefined,
      newValue: ["rm -rf /tmp/foo"],
    });
    assert.match(prompt, /SECURITY-SENSITIVE SETTING CHANGE/);
    assert.match(prompt, /dangerous_command_allowlist/);
    assert.match(prompt, /\(unset\) -> \["rm -rf \/tmp\/foo"\]/);
  });

  it("persists approved set change to target scope file", async () => {
    let seenTitle = "";
    let seenOptions: string[] = [];
    const { tools } = createToolHarness();
    const res = await tools.get("settings_set").execute(
      "s8",
      { action: "set", key: "dco", scope: "global", value: true },
      undefined,
      undefined,
      {
        cwd: projectDir,
        hasUI: true,
        ui: {
          select: async (title: string, options: string[]) => {
            seenTitle = title;
            seenOptions = options;
            return SETTINGS_APPROVAL_APPROVE;
          },
        },
      },
    );
    assert.equal(res.isError, undefined);
    assert.deepEqual(seenOptions, [SETTINGS_APPROVAL_DENY, SETTINGS_APPROVAL_APPROVE]);
    assert.match(seenTitle, /dco/);
    assert.match(seenTitle, /global/);
    assert.match(seenTitle, /\(unset\) -> true/);

    const onDisk = JSON.parse(readFileSync(join(globalDir, "pi-config-settings.json"), "utf8"));
    assert.equal(onDisk.dco, true);
  });

  it("emits orchestrator settings-changed event after approved update", async () => {
    const { tools, emitted } = createToolHarness();
    const res = await tools.get("settings_set").execute(
      "s8b",
      { action: "set", key: "dco", scope: "project", value: true },
      undefined,
      undefined,
      {
        cwd: projectDir,
        hasUI: true,
        ui: { select: async () => SETTINGS_APPROVAL_APPROVE },
      },
    );
    assert.equal(res.isError, undefined);
    assert.ok(emitted.some((e) => e.channel === "orchestrator:settings-changed"));
  });

  it("removes key from target scope on approved reset", async () => {
    writeFileSync(join(projectDir, ".pi", "pi-config-settings.json"), JSON.stringify({ dco: true, trail_enable: false }), "utf8");
    clearSettingsCache();

    const { tools } = createToolHarness();
    const res = await tools.get("settings_set").execute(
      "s9",
      { action: "reset", key: "dco", scope: "project" },
      undefined,
      undefined,
      {
        cwd: projectDir,
        hasUI: true,
        ui: { select: async () => SETTINGS_APPROVAL_APPROVE },
      },
    );
    assert.equal(res.isError, undefined);
    const onDisk = JSON.parse(readFileSync(join(projectDir, ".pi", "pi-config-settings.json"), "utf8"));
    assert.equal("dco" in onDisk, false);
    assert.equal(onDisk.trail_enable, false);
  });

  it("returns no-op without prompting when resetting an already-unset key", async () => {
    let prompted = false;
    const { tools } = createToolHarness();
    const res = await tools.get("settings_set").execute(
      "s10",
      { action: "reset", key: "dco", scope: "project" },
      undefined,
      undefined,
      {
        cwd: projectDir,
        hasUI: true,
        ui: { select: async () => { prompted = true; return SETTINGS_APPROVAL_APPROVE; } },
      },
    );
    assert.equal(res.isError, undefined);
    assert.equal(prompted, false);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.changed, false);
  });
});
