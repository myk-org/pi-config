/**
 * Unit tests for LLM tool parity interfaces (#1384):
 *   - session_status (extensions/orchestrator/status.ts)
 *   - worktree_status (extensions/orchestrator/worktree.ts)
 *   - skill_adopt (extensions/orchestrator/skill-maintenance.ts)
 *   - memory_dream (extensions/orchestrator/dreaming.ts)
 *   - async_status (extensions/orchestrator/async-agents.ts)
 *
 * Run with: npx tsx --test tests/node/orchestrator/llm-tool-parity.test.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildStatusSnapshot, registerStatus } from "../../../extensions/orchestrator/status.js";
import { registerWorktree } from "../../../extensions/orchestrator/worktree.js";
import { invalidateSkillMaintenanceCache, registerSkillMaintenance } from "../../../extensions/orchestrator/skill-maintenance.js";
import { registerDreaming } from "../../../extensions/orchestrator/dreaming.js";
import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { abortAllSyncAgentRuns, beginSyncAgentRun, listSyncAgentRuns } from "../../../extensions/orchestrator/sync-agent-runs.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

function createFakePi(opts: { getCommands?: () => any[] } = {}) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const pi = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, cmd: any) => { commands.set(name, cmd); },
    on: (event: string, fn: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    sendMessage: () => {},
    events: { on: () => () => {}, emit: () => {} },
    ...(opts.getCommands ? { getCommands: opts.getCommands } : {}),
  } as unknown as ExtensionAPI;

  const emit = (event: string, ...args: any[]) => {
    for (const fn of handlers.get(event) ?? []) fn(...args);
  };

  return { pi, tools, commands, emit };
}

function textOf(result: any): string {
  return (result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

// ── session_status ────────────────────────────────────────────────────

describe("session_status tool (#1384)", () => {
  it("registers session_status alongside /status", () => {
    const { pi, tools, commands } = createFakePi();
    registerStatus(pi, false, () => [], () => []);
    assert.ok(commands.has("status"));
    assert.ok(tools.has("session_status"));
  });

  it("returns the same snapshot as buildStatusSnapshot", async () => {
    const { pi, tools } = createFakePi();
    const now = Date.now();
    const deps = {
      inContainer: true,
      getAsyncJobs: () => [
        { id: "job-1", agent: "worker", name: "Scout", task: "Inspect repo", status: "running", startedAt: now - 30_000 },
      ],
      getCronTasks: () => [
        {
          id: "c1",
          scope: "session" as const,
          cwd: "/tmp",
          description: "Hourly ping",
          task: "ping",
          intervalMs: 3_600_000,
          createdAt: now,
        },
      ],
    };
    registerStatus(pi, deps.inContainer, deps.getAsyncJobs, deps.getCronTasks);

    const ctx = {
      cwd: makeTempDir("status-tool-"),
      hasUI: false,
      getContextUsage: () => ({ percent: 42.4 }),
    };

    const expected = await buildStatusSnapshot(ctx, deps);
    const res = await tools.get("session_status").execute("call-1", {}, undefined, undefined, ctx);
    assert.equal(textOf(res), expected);
    assert.match(textOf(res), /Async agents: 1 running/);
    assert.match(textOf(res), /Scout/);
    assert.match(textOf(res), /Cron tasks: 1 active/);
    assert.match(textOf(res), /Running in container/);
    assert.match(textOf(res), /Context: 42%/);
  });

  it("omits context line when ctx.getContextUsage is absent", async () => {
    const { pi, tools } = createFakePi();
    registerStatus(pi, false, () => [], () => []);
    const ctx = { cwd: makeTempDir("status-no-ctx-"), hasUI: false };

    const res = await tools.get("session_status").execute("call-2", {}, undefined, undefined, ctx);
    assert.doesNotMatch(textOf(res), /Context:/);
    assert.match(textOf(res), /Async agents: none/);
    assert.match(textOf(res), /Cron tasks: none/);
  });
});

// ── worktree_status ───────────────────────────────────────────────────

describe("worktree_status tool (#1384)", () => {
  it("lists worktrees with branch, PR, COMS peer info", async () => {
    const repoDir = makeTempDir("wt-tool-list-");
    const wtDir = path.join(repoDir, ".worktrees", "feat-a");
    const { pi, tools } = createFakePi();

    const runner = async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          stdout: [
            `worktree ${repoDir}`,
            "HEAD 1111111111111111111111111111111111111111",
            "branch refs/heads/main",
            "",
            `worktree ${wtDir}`,
            "HEAD 2222222222222222222222222222222222222222",
            "branch refs/heads/feat/a",
            "",
          ].join("\n"),
          code: 0,
        };
      }
      if (args[0] === "status") return { stdout: "", code: 0 };
      return { stdout: "", code: 0 };
    };

    withSubagentChildEnv(undefined, () => {
      registerWorktree(pi, {
        runGitAsync: runner,
        readLivePeers: () => [{ name: "peer-a", project: "test", cwd: wtDir, busy: false, pid: 1234, purpose: "work" }],
        fetchOpenPrs: async () => new Map([["feat/a", { number: 1384, url: "https://github.com/myk-org/pi-config/pull/1384" }]]),
      });
    });

    const tool = tools.get("worktree_status");
    assert.ok(tool, "worktree_status tool registered");
    const res = await tool.execute("call-1", { action: "list" }, undefined, undefined, { cwd: repoDir });
    const out = textOf(res);
    assert.match(out, /feat\/a/);
    assert.match(out, /#1384/);
    assert.match(out, /peer-a/);
    assert.equal(res.details.count, 2);
  });

  it("prunes stale worktrees when action is prune", async () => {
    const repoDir = makeTempDir("wt-tool-prune-");
    const { pi, tools } = createFakePi();
    let pruneCalled = false;

    const runner = async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") {
        pruneCalled = true;
        return {
          stdout: "Removing worktrees/stale: gitdir file points to non-existent location\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", code: 0 };
    };

    withSubagentChildEnv(undefined, () => {
      registerWorktree(pi, { runGitAsync: runner });
    });

    const res = await tools.get("worktree_status").execute("call-2", { action: "prune" }, undefined, undefined, { cwd: repoDir });
    assert.equal(pruneCalled, true);
    assert.equal(res.details.ok, true);
    assert.match(textOf(res), /stale/);
  });

  it("reports failure cleanly when git worktree prune fails", async () => {
    const repoDir = makeTempDir("wt-tool-prune-fail-");
    const { pi, tools } = createFakePi();

    const runner = async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") {
        return { stdout: "", stderr: "fatal: not a git repository", code: 128 };
      }
      return { stdout: "", code: 0 };
    };

    withSubagentChildEnv(undefined, () => {
      registerWorktree(pi, { runGitAsync: runner });
    });

    const res = await tools.get("worktree_status").execute("call-3", { action: "prune" }, undefined, undefined, { cwd: repoDir });
    assert.equal(res.details.ok, false);
    assert.match(textOf(res), /not a git repository/i);
  });

  it("skips worktree_status registration in subagent children", () => {
    const { pi, tools } = createFakePi();
    withSubagentChildEnv("1", () => {
      registerWorktree(pi);
    });
    assert.equal(tools.has("worktree_status"), false);
  });
});

// ── skill_adopt ───────────────────────────────────────────────────────

describe("skill_adopt tool (#1384)", () => {
  const UNMARKED = "---\nname: my-skill\ndescription: Test skill\n---\n\n# My Skill\n";
  const MARKED = "---\nname: done-skill\ndescription: Already adopted\nskill-maintenance: auto\n---\n\n# Done\n";

  function writeSkill(cwd: string, name: string, content: string): string {
    const file = path.join(cwd, ".pi", "skills", name, "SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf-8");
    return file;
  }

  afterEach(() => {
    invalidateSkillMaintenanceCache();
  });

  it("lists unmarked adoptable skills", async () => {
    const cwd = makeTempDir("skill-adopt-list-");
    const unmarkedPath = writeSkill(cwd, "my-skill", UNMARKED);
    const markedPath = writeSkill(cwd, "done-skill", MARKED);

    const { pi, tools } = createFakePi({
      getCommands: () => [
        { name: "skill:my-skill", source: "skill", sourceInfo: { path: unmarkedPath, scope: "project", origin: "top-level" } },
        { name: "skill:done-skill", source: "skill", sourceInfo: { path: markedPath, scope: "project", origin: "top-level" } },
      ],
    });
    registerSkillMaintenance(pi);

    const res = await tools.get("skill_adopt").execute("call-1", { action: "list" }, undefined, undefined, { cwd });
    assert.deepEqual(res.details.unmarked, ["my-skill"]);
    assert.match(textOf(res), /my-skill/);
    assert.doesNotMatch(textOf(res), /done-skill/);
  });

  it("reports when every adoptable skill is already maintained", async () => {
    const cwd = makeTempDir("skill-adopt-all-done-");
    const markedPath = writeSkill(cwd, "done-skill", MARKED);

    const { pi, tools } = createFakePi({
      getCommands: () => [
        { name: "skill:done-skill", source: "skill", sourceInfo: { path: markedPath, scope: "project", origin: "top-level" } },
      ],
    });
    registerSkillMaintenance(pi);

    const res = await tools.get("skill_adopt").execute("call-2", { action: "list" }, undefined, undefined, { cwd });
    assert.deepEqual(res.details.unmarked, []);
    assert.match(textOf(res), /already maintained/i);
  });

  it("stamps skill-maintenance: auto when adopting a valid skill", async () => {
    const cwd = makeTempDir("skill-adopt-run-");
    const file = writeSkill(cwd, "my-skill", UNMARKED);

    const { pi, tools } = createFakePi({
      getCommands: () => [
        { name: "skill:my-skill", source: "skill", sourceInfo: { path: file, scope: "project", origin: "top-level" } },
      ],
    });
    registerSkillMaintenance(pi);

    const res = await tools.get("skill_adopt").execute("call-3", { action: "adopt", name: "my-skill" }, undefined, undefined, { cwd });
    assert.equal(res.details.ok, true);
    assert.match(fs.readFileSync(file, "utf-8"), /skill-maintenance:\s*auto/);
  });

  it("returns an error when adopt is called without a skill name", async () => {
    const cwd = makeTempDir("skill-adopt-noname-");
    const { pi, tools } = createFakePi({ getCommands: () => [] });
    registerSkillMaintenance(pi);

    const res = await tools.get("skill_adopt").execute("call-4", { action: "adopt" }, undefined, undefined, { cwd });
    assert.equal(res.details.ok, false);
    assert.match(textOf(res), /'name' is required/i);
  });

  it("refuses to adopt a shipped package skill", async () => {
    const cwd = makeTempDir("skill-adopt-pkg-");
    const file = writeSkill(cwd, "pkg-skill", UNMARKED);

    const { pi, tools } = createFakePi({
      getCommands: () => [
        { name: "skill:pkg-skill", source: "skill", sourceInfo: { path: file, scope: "user", origin: "package" } },
      ],
    });
    registerSkillMaintenance(pi);

    const res = await tools.get("skill_adopt").execute("call-5", { action: "adopt", name: "pkg-skill" }, undefined, undefined, { cwd });
    assert.equal(res.details.ok, false);
    assert.match(textOf(res), /package skill/i);
  });
});

// ── memory_dream ──────────────────────────────────────────────────────

describe("memory_dream tool (#1384)", () => {
  it("reports initial enabled idle dreaming status", async () => {
    const cwd = makeTempDir("dream-status-");
    const { pi, tools } = createFakePi();

    withSubagentChildEnv(undefined, () => {
      registerDreaming(pi, () => ({ id: "dream-1" }));
    });

    const res = await tools.get("memory_dream").execute("call-1", { action: "status" }, undefined, undefined, { cwd });
    assert.equal(res.details.enabled, true);
    assert.equal(res.details.inFlight, false);
    assert.match(textOf(res), /Auto-dreaming: enabled/);
    assert.match(textOf(res), /Dream in flight: no/);
  });

  it("triggers background consolidation reporting the job id", async () => {
    const cwd = makeTempDir("dream-run-");
    const { pi, tools } = createFakePi();
    let capturedOnComplete: (() => void) | undefined;

    withSubagentChildEnv(undefined, () => {
      registerDreaming(pi, (_agent, _task, _cwd, _agents, options) => {
        capturedOnComplete = options?.onComplete;
        return { id: "dream-42" };
      });
    });

    const res = await tools.get("memory_dream").execute("call-2", { action: "run" }, undefined, undefined, { cwd });
    assert.equal(res.details.ok, true);
    assert.equal(res.details.id, "dream-42");
    assert.match(textOf(res), /dream-42/);

    // Complete cleanly so timers/state reset
    capturedOnComplete?.();
  });

  it("refuses a concurrent dream while one is already in flight", async () => {
    const cwd = makeTempDir("dream-concurrent-");
    const { pi, tools } = createFakePi();
    let spawns = 0;

    withSubagentChildEnv(undefined, () => {
      registerDreaming(pi, () => {
        spawns++;
        return { id: `dream-${spawns}` };
      });
    });

    const first = await tools.get("memory_dream").execute("call-1", { action: "run" }, undefined, undefined, { cwd });
    const second = await tools.get("memory_dream").execute("call-2", { action: "run" }, undefined, undefined, { cwd });
    assert.equal(first.details.ok, true);
    assert.equal(second.details.ok, false);
    assert.equal(second.details.inFlight, true);
    assert.equal(spawns, 1);
    assert.match(textOf(second), /already running/i);
  });

  it("reports spawn failure when dream worker cannot start", async () => {
    const cwd = makeTempDir("dream-fail-");
    const { pi, tools } = createFakePi();

    withSubagentChildEnv(undefined, () => {
      registerDreaming(pi, () => ({ id: "", error: "worker unavailable" }));
    });

    const res = await tools.get("memory_dream").execute("call-1", { action: "run" }, undefined, undefined, { cwd });
    assert.equal(res.details.ok, false);
    assert.match(textOf(res), /worker unavailable/);
  });

  it("clears in-flight state when spawn returns an error alongside an id", async () => {
    const cwd = makeTempDir("dream-id-err-");
    const { pi, tools } = createFakePi();
    let attempt = 0;

    withSubagentChildEnv(undefined, () => {
      registerDreaming(pi, () => {
        attempt++;
        if (attempt === 1) return { id: "ghost-id", error: "runner unavailable" };
        return { id: "dream-retry" };
      });
    });

    const first = await tools.get("memory_dream").execute("call-1", { action: "run" }, undefined, undefined, { cwd });
    assert.equal(first.details.ok, false);
    assert.match(textOf(first), /runner unavailable/);

    const status = await tools.get("memory_dream").execute("call-2", { action: "status" }, undefined, undefined, { cwd });
    assert.equal(status.details.inFlight, false);

    const second = await tools.get("memory_dream").execute("call-3", { action: "run" }, undefined, undefined, { cwd });
    assert.equal(second.details.ok, true);
    assert.equal(second.details.id, "dream-retry");
  });

  it("disables automatic dreaming on auto_off", async () => {
    const cwd = makeTempDir("dream-toggle-off-");
    const { pi, tools, emit } = createFakePi();

    withSubagentChildEnv(undefined, () => {
      registerDreaming(pi, () => ({ id: "dream-1" }));
    });

    const offRes = await tools.get("memory_dream").execute("call-1", { action: "auto_off" }, undefined, undefined, { cwd });
    assert.equal(offRes.details.enabled, false);
    const statusOff = await tools.get("memory_dream").execute("call-2", { action: "status" }, undefined, undefined, { cwd });
    assert.equal(statusOff.details.enabled, false);
    emit("session_shutdown", { reason: "reload" });
  });

  it("enables automatic dreaming on auto_on", async () => {
    const cwd = makeTempDir("dream-toggle-on-");
    const { pi, tools, emit } = createFakePi();

    withSubagentChildEnv(undefined, () => {
      registerDreaming(pi, () => ({ id: "dream-1" }));
    });

    await tools.get("memory_dream").execute("call-1", { action: "auto_off" }, undefined, undefined, { cwd });
    const onRes = await tools.get("memory_dream").execute("call-2", { action: "auto_on" }, undefined, undefined, { cwd });
    assert.equal(onRes.details.enabled, true);
    const statusOn = await tools.get("memory_dream").execute("call-3", { action: "status" }, undefined, undefined, { cwd });
    assert.equal(statusOn.details.enabled, true);
    emit("session_shutdown", { reason: "reload" });
  });

  it("skips memory_dream registration in subagent children", () => {
    const { pi, tools } = createFakePi();
    withSubagentChildEnv("1", () => {
      registerDreaming(pi, () => ({ id: "dream-1" }));
    });
    assert.equal(tools.has("memory_dream"), false);
  });
});

// ── async_status ──────────────────────────────────────────────────────

describe("async_status tool (#1384)", () => {
  afterEach(() => {
    abortAllSyncAgentRuns();
  });

  it("reports empty state when no async or sync jobs exist", async () => {
    const { pi, tools, emit } = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerAsyncAgents(pi, () => {});
    });

    const res = await tools.get("async_status").execute("call-1", {});
    assert.equal(res.details.total, 0);
    assert.match(textOf(res), /No async or sync subagent jobs/i);
    emit("session_shutdown");
  });

  it("lists active sync runs with id, agent, status, current tool", async () => {
    const tmpDir = makeTempDir("async-status-list-");
    const { pi, tools, emit } = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerAsyncAgents(pi, () => {});
    });

    const handle = beginSyncAgentRun({
      agent: "ts-expert",
      task: "Fix type errors in daemon manager",
      cwd: tmpDir,
    });
    handle.setTool("edit");

    const res = await tools.get("async_status").execute("call-1", {});
    const out = textOf(res);
    assert.equal(res.details.active, 1);
    assert.match(out, new RegExp(handle.id));
    assert.match(out, /ts-expert/);
    assert.match(out, /running/);
    assert.match(out, /tool: edit/);

    handle.end(true);
    emit("session_shutdown");
  });

  it("inspects a job output tail by exact id respecting max_chars", async () => {
    const tmpDir = makeTempDir("async-status-detail-");
    const { pi, tools, emit } = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerAsyncAgents(pi, () => {});
    });

    const handle = beginSyncAgentRun({
      agent: "worker",
      task: "Generate long output",
      cwd: tmpDir,
    });
    const run = listSyncAgentRuns().find((r) => r.id === handle.id);
    assert.ok(run?.workerDir, "sync run has workerDir");
    fs.mkdirSync(run.workerDir, { recursive: true });
    const longText = "A".repeat(300) + "TAIL_MARKER_1384";
    fs.writeFileSync(
      path.join(run.workerDir, "output.log"),
      `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: longText } })}\n`,
      "utf-8",
    );

    const res = await tools.get("async_status").execute("call-1", { id: handle.id, max_chars: 200 });
    const out = textOf(res);
    assert.equal(res.details.found, true);
    assert.match(out, /TAIL_MARKER_1384/);
    assert.match(out, /earlier output truncated/);

    handle.end(true);
    emit("session_shutdown");
  });

  it("matches a job by unique id prefix", async () => {
    const tmpDir = makeTempDir("async-status-prefix-");
    const { pi, tools, emit } = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerAsyncAgents(pi, () => {});
    });

    const handle = beginSyncAgentRun({
      agent: "scout",
      task: "Scan modules",
      cwd: tmpDir,
    });

    const prefix = handle.id.slice(0, 6);
    const res = await tools.get("async_status").execute("call-1", { id: prefix });
    assert.equal(res.details.found, true);
    assert.match(textOf(res), new RegExp(`ID: ${handle.id}`));

    handle.end(true);
    emit("session_shutdown");
  });

  it("reports when a requested job id is not found", async () => {
    const { pi, tools, emit } = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerAsyncAgents(pi, () => {});
    });

    const res = await tools.get("async_status").execute("call-1", { id: "nonexistent-id" });
    assert.equal(res.details.found, false);
    assert.match(textOf(res), /No async or sync job found/i);
    emit("session_shutdown");
  });

  it("reports ambiguous id prefixes when multiple jobs match", async () => {
    const tmpDir = makeTempDir("async-status-ambig-");
    const { pi, tools, emit } = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerAsyncAgents(pi, () => {});
    });

    const h1 = beginSyncAgentRun({
      agent: "worker",
      task: "First job",
      cwd: tmpDir,
    });
    const h2 = beginSyncAgentRun({
      agent: "worker",
      task: "Second job",
      cwd: tmpDir,
    });

    // Both sync run IDs share the "sync-" prefix
    const res = await tools.get("async_status").execute("call-1", { id: "sync-" });
    assert.equal(res.details.ambiguous, true);
    assert.match(textOf(res), /Ambiguous job id prefix/i);

    h1.end(true);
    h2.end(true);
    emit("session_shutdown");
  });

  it("retrieves in-memory output tail for a running sync job without output.log", async () => {
    const tmpDir = makeTempDir("async-status-sync-mem-");
    const { pi, tools, emit } = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerAsyncAgents(pi, () => {});
    });

    const handle = beginSyncAgentRun({
      agent: "ts-expert",
      task: "Streamed sync output",
      cwd: tmpDir,
    });
    handle.appendOutput("Scanning files...\n");
    handle.appendOutput("SYNC_TAIL_OK");

    const res = await tools.get("async_status").execute("call-1", { id: handle.id });
    assert.equal(res.details.found, true);
    assert.match(textOf(res), /SYNC_TAIL_OK/);

    handle.end(true);
    emit("session_shutdown");
  });

  it("retains in-memory output tail for a recently finished sync job", async () => {
    const tmpDir = makeTempDir("async-status-sync-done-");
    const { pi, tools, emit } = createFakePi();
    withSubagentChildEnv(undefined, () => {
      registerAsyncAgents(pi, () => {});
    });

    const handle = beginSyncAgentRun({
      agent: "worker",
      task: "Completed sync output",
      cwd: tmpDir,
    });
    handle.appendOutput("FINISHED_SYNC_MARKER");
    handle.end(true);

    const res = await tools.get("async_status").execute("call-1", { id: handle.id });
    assert.equal(res.details.found, true);
    assert.match(textOf(res), /FINISHED_SYNC_MARKER/);
    assert.match(textOf(res), /Status: complete/);

    emit("session_shutdown");
  });
});
