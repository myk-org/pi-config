/**
 * Unit tests for #1279 (buildSubagentChildSpec, validateSyncEstimate, SETTINGS_KEY_NAMES),
 * #1284 (consolidated renderMultiAgentResults for chain & parallel), and
 * #1288 (formatElapsedDuration & /status formatting).
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildSubagentChildSpec, SETTINGS_KEY_NAMES } from "../../../extensions/orchestrator/subagent-child-spec.js";
import {
  clearSettingsCache,
  setGlobalSettingsPath,
  SETTINGS_KEYS,
} from "../../../extensions/orchestrator/project-settings.js";
import { registerSubagentTool } from "../../../extensions/orchestrator/subagent-tool.js";
import { registerStatus } from "../../../extensions/orchestrator/status.js";
import { formatElapsedDuration } from "../../../extensions/orchestrator/utils.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

const tempDirs: string[] = [];

function createMockTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

describe("buildSubagentChildSpec & SETTINGS_KEY_NAMES (#1279)", () => {
  let cwd: string;
  let globalTmp: string;

  beforeEach(() => {
    clearSettingsCache();
    cwd = makeTempDir("child-spec-");
    globalTmp = makeTempDir("child-spec-global-");
    tempDirs.push(cwd, globalTmp);
    setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("precomputes SETTINGS_KEY_NAMES matching SETTINGS_KEYS", () => {
    assert.deepEqual([...SETTINGS_KEY_NAMES], Object.keys(SETTINGS_KEYS));
  });

  it("builds sync child spec without JITI cache flags", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "pi-config-settings.json"), JSON.stringify({ dco: true }), "utf-8");
    clearSettingsCache();

    const spec = buildSubagentChildSpec({
      mode: "sync",
      agentName: "worker",
      agent: {
        model: "claude-sonnet-4",
        provider: "anthropic",
        tools: ["read", "bash"],
        systemPrompt: "Header\n{{IF:dco}}DCO_ENABLED{{/IF}}",
      },
      task: "check files",
      cwd,
      persistSession: false,
    });

    assert.equal(spec.effectiveModel, "claude-sonnet-4");
    assert.equal(spec.effectiveProvider, "anthropic");
    assert.deepEqual(spec.args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
    assert.ok(!spec.args.includes("-nc"));
    assert.ok(!spec.args.includes("--session-id"));
    assert.ok(spec.args.includes("--model"));
    assert.ok(spec.args.includes("--provider"));
    assert.match(spec.resolvedPrompt, /DCO_ENABLED/);
    assert.equal(spec.env.PI_SUBAGENT_CHILD, "1");
    assert.equal(spec.env.PI_AGENT_NAME, "worker");
    assert.equal(spec.env.PI_MODEL, "claude-sonnet-4");
    assert.equal(spec.env.JITI_CACHE, process.env.JITI_CACHE);
  });

  it("builds async child spec with -nc, session id, JITI isolation", () => {
    const spec = buildSubagentChildSpec({
      mode: "async",
      agentName: "code-reviewer-quality",
      agent: {
        systemPrompt: "Review prompt",
      },
      task: "review diff",
      cwd,
      persistSession: true,
      parentModelId: "gemini-2.5-pro",
      parentProvider: "google",
      parentSessionId: "sess-123",
      extraEnv: { PI_REVIEW_BASE_BRANCH: "main", PI_HAS_PR: "true" },
    });

    assert.deepEqual(spec.args.slice(0, 4), ["--mode", "json", "-p", "-nc"]);
    assert.ok(!spec.args.includes("--no-session"), "persistSession=true omits --no-session");
    const sessIdx = spec.args.indexOf("--session-id");
    assert.ok(sessIdx >= 0);
    assert.match(spec.args[sessIdx + 1], /^async-code-reviewer-quality-/);
    assert.equal(spec.env.JITI_CACHE, "false");
    assert.equal(spec.env.JITI_FS_CACHE, "false");
    assert.equal(spec.env.PI_REVIEW_BASE_BRANCH, "main");
    assert.equal(spec.env.PI_HAS_PR, "true");
    assert.equal(spec.resolvedPrompt, "Review prompt");
  });
});

describe("subagent validateSyncEstimate (#1279) & renderMultiAgentResults (#1284)", () => {
  function registerTool() {
    let tool: any;
    const mockPi: any = {
      registerTool(def: any) {
        tool = def;
      },
      on() {},
      events: { on() {}, emit() {} },
    };
    withSubagentChildEnv(undefined, () => {
      registerSubagentTool(
        mockPi,
        () => ({ id: "mock" }),
        () => ({ killed: [], errors: [] }),
      );
      return undefined;
    });
    assert.ok(tool, "subagent tool must be registered");
    return tool;
  }

  it("rejects single sync call when estimatedSeconds is missing", async () => {
    const tool = registerTool();
    const cwd = makeTempDir("sync-val-missing-");
    tempDirs.push(cwd);
    const ctx: any = { cwd, hasUI: false, model: { id: "claude-sonnet-4", provider: "anthropic" } };

    const res = await tool.execute("1", { agent: "worker", task: "hi", cwd }, undefined, undefined, ctx);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /estimatedSeconds/);
  });

  it("rejects single sync call when estimatedSeconds is non-positive", async () => {
    const tool = registerTool();
    const cwd = makeTempDir("sync-val-zero-");
    tempDirs.push(cwd);
    const ctx: any = { cwd, hasUI: false, model: { id: "claude-sonnet-4", provider: "anthropic" } };

    const res = await tool.execute("2", { agent: "worker", task: "hi", cwd, estimatedSeconds: 0 }, undefined, undefined, ctx);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /positive number/);
  });

  it("rejects parallel sync call when max task estimatedSeconds meets sync limit", async () => {
    const tool = registerTool();
    const cwd = makeTempDir("sync-val-parallel-");
    tempDirs.push(cwd);
    const ctx: any = { cwd, hasUI: false, model: { id: "claude-sonnet-4", provider: "anthropic" } };

    const res = await tool.execute(
      "3",
      {
        tasks: [
          { agent: "worker", task: "a", cwd, estimatedSeconds: 10 },
          { agent: "worker", task: "b", cwd, estimatedSeconds: 65 },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /sync limit/i);
  });

  it("rejects chain sync call when summed estimatedSeconds meets sync limit", async () => {
    const tool = registerTool();
    const cwd = makeTempDir("sync-val-chain-");
    tempDirs.push(cwd);
    const ctx: any = { cwd, hasUI: false, model: { id: "claude-sonnet-4", provider: "anthropic" } };

    const res = await tool.execute(
      "4",
      {
        chain: [
          { agent: "worker", task: "a", cwd, estimatedSeconds: 35 },
          { agent: "worker", task: "b", cwd, estimatedSeconds: 30 },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /65s/);
  });

  it("renders collapsed chain results with step prefixes", () => {
    const tool = registerTool();
    const theme = createMockTheme();
    const makeSingle = (agent: string, exitCode: number, step?: number) => ({
      agent,
      agentSource: "package" as const,
      task: `do ${agent}`,
      exitCode,
      messages: [{ role: "assistant", content: [{ type: "text", text: `output from ${agent}` }] }],
      stderr: "",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 150, turns: 1 },
      durationMs: 2000,
      step,
    });

    const chainCollapsed = tool.renderResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "chain",
          agentScope: "both",
          projectAgentsDir: null,
          results: [makeSingle("scout", 0, 1), makeSingle("worker", 0, 2)],
        },
      },
      { expanded: false },
      theme,
      { state: {} },
    );
    const chainCollapsedText = chainCollapsed.render(120).join("\n");
    assert.match(chainCollapsedText, /chain 2\/2 steps/);
    assert.match(chainCollapsedText, /─── Step 1: scout ✓/);
    assert.match(chainCollapsedText, /─── Step 2: worker ✓/);
    assert.match(chainCollapsedText, /Total:/);
    assert.match(chainCollapsedText, /\(Ctrl\+O to expand\)/);
  });

  it("renders expanded chain results with task details", () => {
    const tool = registerTool();
    const theme = createMockTheme();
    const chainExpanded = tool.renderResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "chain",
          agentScope: "both",
          projectAgentsDir: null,
          results: [{
            agent: "scout",
            agentSource: "package" as const,
            task: "do scout",
            exitCode: 0,
            messages: [{ role: "assistant", content: [{ type: "text", text: "output from scout" }] }],
            stderr: "",
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 150, turns: 1 },
            durationMs: 2000,
            step: 1,
          }],
        },
      },
      { expanded: true },
      theme,
      { state: {} },
    );
    const chainExpandedText = chainExpanded.render(120).join("\n");
    assert.match(chainExpandedText, /chain 1\/1 steps/);
    assert.match(chainExpandedText, /Task: do scout/);
    assert.match(chainExpandedText, /output from scout/);
    assert.match(chainExpandedText, /Total:/);
  });

  it("renders running parallel batch with pending indicator", () => {
    const tool = registerTool();
    const theme = createMockTheme();
    const makeSingle = (agent: string, exitCode: number) => ({
      agent,
      agentSource: "package" as const,
      task: `do ${agent}`,
      exitCode,
      messages: exitCode === -1
        ? []
        : [{ role: "assistant", content: [{ type: "text", text: `output from ${agent}` }] }],
      stderr: "",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 150, turns: 1 },
      durationMs: 2000,
    });

    const parallelRunning = tool.renderResult(
      {
        content: [{ type: "text", text: "running" }],
        details: {
          mode: "parallel",
          agentScope: "both",
          projectAgentsDir: null,
          results: [makeSingle("scout", 0), makeSingle("worker", -1)],
        },
      },
      { expanded: false },
      theme,
      { state: {} },
    );
    const parallelRunningText = parallelRunning.render(120).join("\n");
    assert.match(parallelRunningText, /parallel 1\/2 done, 1 running/);
    assert.match(parallelRunningText, /─── worker ⏳/);
    assert.match(parallelRunningText, /\(running\.\.\.\)/);
    assert.doesNotMatch(parallelRunningText, /Total:/);
    assert.match(parallelRunningText, /\(Ctrl\+O to expand\)/);
  });

  it("renders completed parallel batch with partial failure icon", () => {
    const tool = registerTool();
    const theme = createMockTheme();
    const makeSingle = (agent: string, exitCode: number) => ({
      agent,
      agentSource: "package" as const,
      task: `do ${agent}`,
      exitCode,
      messages: [{ role: "assistant", content: [{ type: "text", text: `output from ${agent}` }] }],
      stderr: "",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 150, turns: 1 },
      durationMs: 2000,
    });

    const parallelMixed = tool.renderResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "parallel",
          agentScope: "both",
          projectAgentsDir: null,
          results: [makeSingle("scout", 0), makeSingle("worker", 1)],
        },
      },
      { expanded: false },
      theme,
      { state: {} },
    );
    const parallelMixedText = parallelMixed.render(120).join("\n");
    assert.match(parallelMixedText, /◐ parallel 1\/2 tasks/);
    assert.match(parallelMixedText, /─── worker ✗/);
    assert.match(parallelMixedText, /Total:/);
  });
});

describe("formatElapsedDuration & /status formatting (#1288)", () => {
  it("formats elapsed durations in compact whole units", () => {
    assert.equal(formatElapsedDuration(0), "0s");
    assert.equal(formatElapsedDuration(45_000), "45s");
    assert.equal(formatElapsedDuration(192_000), "3m12s");
    assert.equal(formatElapsedDuration(3_900_000), "1h5m");
  });

  it("renders /status 90s cron interval as every 1m30s", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const mockPi: any = {
      registerCommand(name: string, opts: any) {
        if (name === "status") handler = opts.handler;
      },
    };
    const now = Date.now();
    registerStatus(
      mockPi,
      false,
      () => [{ id: "1", agent: "worker", task: "do work", status: "running", startedAt: now - 125_000 }],
      () => [
        {
          id: "c1",
          scope: "session",
          description: "ninety second check",
          task: "check",
          intervalMs: 90_000,
          createdAt: now,
        } as any,
      ],
    );
    assert.ok(handler);
    let notified = "";
    await handler!("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: (msg: string) => { notified = msg; } },
    });
    assert.match(notified, /worker — 2m5s — do work/);
    assert.match(notified, /session:c1 every 1m30s — ninety second check/);
  });

  it("renders /status time-of-day cron with at HH:MM label", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const mockPi: any = {
      registerCommand(name: string, opts: any) {
        if (name === "status") handler = opts.handler;
      },
    };
    const now = Date.now();
    registerStatus(
      mockPi,
      false,
      () => [],
      () => [
        {
          id: "c2",
          scope: "session",
          description: "morning check",
          task: "check",
          atHour: 9,
          atMinute: 5,
          createdAt: now,
        } as any,
      ],
    );
    assert.ok(handler);
    let notified = "";
    await handler!("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: (msg: string) => { notified = msg; } },
    });
    assert.match(notified, /session:c2 at 09:05 — morning check/);
  });
});
