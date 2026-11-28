/**
 * Unit tests for Pi 1.6 codemode tool exposure, namespaces, MCP-style annotations,
 * and automatic `codemode` activation (#1451).
 *
 * Run with: npx tsx --test tests/node/orchestrator/codemode-tool-exposure.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolAnnotations, ToolNamespace } from "@earendil-works/pi-coding-agent";
import orchestratorExtension from "../../../extensions/orchestrator/index.js";
import { registerAskUser } from "../../../extensions/orchestrator/ask-user.js";
import { registerSubagentTool } from "../../../extensions/orchestrator/subagent-tool.js";
import { registerMemoryTools } from "../../../extensions/orchestrator/memory-tools.js";
import { registerDreaming } from "../../../extensions/orchestrator/dreaming.js";
import { registerSkillMaintenance } from "../../../extensions/orchestrator/skill-maintenance.js";
import { registerEnforcement } from "../../../extensions/orchestrator/enforcement.js";
import { registerStatus } from "../../../extensions/orchestrator/status.js";
import { registerAsyncAgents } from "../../../extensions/orchestrator/async-agents.js";
import { registerWorktree } from "../../../extensions/orchestrator/worktree.js";
import { registerCron } from "../../../extensions/orchestrator/cron.js";
import { registerSessionSearch } from "../../../extensions/orchestrator/session-search.js";
import { createTrailIntegration } from "../../../extensions/orchestrator/trail.js";
import {
  CODEMODE_TOOL_NAME,
  ensureCodemodeActive,
  isCodemodeExcludedByArgv,
  registerCodemodeActivation,
} from "../../../extensions/orchestrator/codemode-activation.js";
import { registerDaemonManageTool } from "../../../extensions/shared/daemon-manager.js";
import { registerTaskTools } from "../../../extensions/pitasks/task-tools.js";
import { registerComs } from "../../../extensions/coms/coms-wrapper.js";
import { syncComsActiveTools } from "../../../extensions/coms/coms-shared.js";
import { TOOL_NAMESPACES } from "../../../extensions/shared/tool-namespaces.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { useSupportedPiVersion } from "../helpers/pi-version-env.js";

useSupportedPiVersion();

function createMockPi(opts: {
  initialTools?: Array<Record<string, any>>;
  initialActive?: string[];
  settings?: Record<string, any>;
} = {}) {
  const registered = new Map<string, any>();
  for (const t of opts.initialTools ?? []) registered.set(t.name, t);
  let activeTools = [...(opts.initialActive ?? ["read", "bash", "edit", "write"])];
  let setActiveCalls = 0;
  const handlers = new Map<string, Array<(...args: any[]) => any>>();

  const pi: Record<string, any> = {
    registerTool: (tool: any) => {
      registered.set(tool.name, tool);
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    registerEntryRenderer: () => {},
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    getFlag: () => undefined,
    appendEntry: () => {},
    sendMessage: () => {},
    getAllTools: () => [...registered.values()],
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      setActiveCalls++;
      activeTools = [...names];
    },
    getSettings: () => opts.settings ?? {},
    on: (event: string, fn: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    events: {
      on: () => () => {},
      emit: () => {},
    },
  };

  const emit = async (event: string, ...args: any[]) => {
    for (const fn of handlers.get(event) ?? []) {
      await fn(...args);
    }
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    registered,
    getActive: () => [...activeTools],
    getSetActiveCalls: () => setActiveCalls,
    emit,
  };
}

function assertValidAnnotations(name: string, annotations: ToolAnnotations | undefined, expected: ToolAnnotations) {
  assert.ok(annotations, `${name} must declare MCP-style annotations`);
  assert.equal(typeof annotations.readOnlyHint, "boolean", `${name}.annotations.readOnlyHint must be boolean`);
  assert.equal(typeof annotations.destructiveHint, "boolean", `${name}.annotations.destructiveHint must be boolean`);
  assert.equal(typeof annotations.idempotentHint, "boolean", `${name}.annotations.idempotentHint must be boolean`);
  assert.equal(typeof annotations.openWorldHint, "boolean", `${name}.annotations.openWorldHint must be boolean`);
  assert.deepEqual(annotations, expected, `${name} annotations mismatch`);
}

function assertValidNamespace(name: string, ns: ToolNamespace | undefined, expectedName: string) {
  assert.ok(ns, `${name} must declare namespace`);
  assert.equal(ns.name, expectedName, `${name} namespace.name mismatch`);
  assert.ok(typeof ns.description === "string" && ns.description.length > 0, `${name} namespace.description missing`);
  assert.ok(typeof ns.instructions === "string" && ns.instructions.length > 0, `${name} namespace.instructions missing`);
}

describe("Pi 1.6 tool exposure, namespaces, and annotations (#1451)", () => {
  it("registers ask_user and subagent with exposure: model-only and accurate annotations", () => {
    const { pi, registered } = createMockPi();
    const prevSupervised = process.env.PI_COMS_SUPERVISED_PEER;
    delete process.env.PI_COMS_SUPERVISED_PEER;
    try {
      withSubagentChildEnv(undefined, () => {
        registerAskUser(pi, () => {});
        registerSubagentTool(
          pi,
          () => ({ id: "1" }),
          () => ({ killed: [], errors: [] }),
        );
      });
    } finally {
      if (prevSupervised === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
      else process.env.PI_COMS_SUPERVISED_PEER = prevSupervised;
    }

    const askUser = registered.get("ask_user");
    assert.equal(askUser?.exposure, "model-only");
    assert.equal(askUser?.namespace, undefined);
    assertValidAnnotations("ask_user", askUser?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });

    const subagent = registered.get("subagent");
    assert.equal(subagent?.exposure, "model-only");
    assert.equal(subagent?.namespace, undefined);
    assertValidAnnotations("subagent", subagent?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("registers memory tools under memory namespace with codemode/deferred exposure and annotations", () => {
    const { pi, registered } = createMockPi();
    withSubagentChildEnv(undefined, () => {
      registerMemoryTools(pi);
      registerDreaming(pi, () => ({ id: "1" }));
    });

    const ro: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const expected: Record<string, { exposure: string; annotations: ToolAnnotations }> = {
      memory_search: { exposure: "codemode", annotations: ro },
      memory_topics: { exposure: "codemode", annotations: ro },
      memory_reflect: { exposure: "codemode", annotations: ro },
      memory_add: { exposure: "codemode", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
      memory_reinforce: { exposure: "codemode", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
      memory_edit: { exposure: "codemode", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
      memory_remove: { exposure: "codemode", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
      memory_consolidate: { exposure: "deferred", annotations: ro },
      memory_dream: { exposure: "deferred", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    };

    for (const [name, spec] of Object.entries(expected)) {
      const tool = registered.get(name);
      assert.ok(tool, `expected ${name} to be registered`);
      assert.equal(tool.exposure, spec.exposure, `${name} exposure mismatch`);
      assertValidNamespace(name, tool.namespace, "memory");
      assertValidAnnotations(name, tool.annotations, spec.annotations);
    }
  });

  it("registers all 21 coms tools under coms namespace with codemode exposure and annotations", async () => {
    const { pi, registered, emit } = createMockPi();
    try {
      withSubagentChildEnv(undefined, () => {
        registerComs(pi, { allowSubagentChild: true, registerSignalHandlers: false });
      });

      const ro: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
      const expected: Record<string, ToolAnnotations> = {
        coms_start: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        coms_stop: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        coms_peers: ro,
        coms_peer_spawn: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        coms_peer_kill: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        coms_list: ro,
        coms_send: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        coms_broadcast: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        coms_history: ro,
        coms_get: ro,
        coms_queue_inspect: ro,
        coms_queue_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        coms_queue_edit: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        coms_queue_clear: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        coms_queue_prioritize: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        coms_local_queue: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        coms_tasks_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        coms_task_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        coms_task_list: ro,
        coms_task_get: ro,
        coms_task_update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      };

      for (const [name, annotations] of Object.entries(expected)) {
        const tool = registered.get(name);
        assert.ok(tool, `expected ${name} to be registered`);
        assert.equal(tool.exposure, "codemode", `${name} exposure mismatch`);
        assertValidNamespace(name, tool.namespace, "coms");
        assertValidAnnotations(name, tool.annotations, annotations);
      }
    } finally {
      await emit("session_shutdown", {}, {});
    }
  });

  it("registers all 7 task tools under tasks namespace with codemode exposure and annotations", () => {
    const { pi, registered } = createMockPi();
    registerTaskTools(pi, () => ({} as any), { update: () => {}, setActiveTask: () => {} } as any);

    const ro: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const expected: Record<string, ToolAnnotations> = {
      TaskCreate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      TaskList: ro,
      TaskGet: ro,
      TaskUpdate: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      TaskBulkCreate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      TaskBulkDelete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      TaskBulkUpdate: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    };

    for (const [name, annotations] of Object.entries(expected)) {
      const tool = registered.get(name);
      assert.ok(tool, `expected ${name} to be registered`);
      assert.equal(tool.exposure, "codemode", `${name} exposure mismatch`);
      assertValidNamespace(name, tool.namespace, "tasks");
      assertValidAnnotations(name, tool.annotations, annotations);
    }
  });

  it("registers all 7 trail tools under trail namespace with codemode exposure and annotations", async () => {
    const { pi, registered, emit } = createMockPi();
    const prevChild = process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD;
    try {
      const silentLog = { debug() {}, info() {}, warn() {}, error() {}, isDebugEnabled: () => false };
      createTrailIntegration({
        enabled: true,
        executable: async () => true,
        worktree: () => process.cwd(),
        graph: async () => "fresh" as const,
        logger: silentLog,
      }).register(pi);
      await emit("session_start", { reason: "startup" }, { cwd: process.cwd(), mode: "tui", hasUI: true });
      await emit("session_shutdown", {}, {});
    } finally {
      if (prevChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = prevChild;
    }

    const ro: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const expected: Record<string, ToolAnnotations> = {
      trail_find_code: ro,
      trail_find_all: ro,
      trail_file_api: ro,
      trail_trace_calls: ro,
      trail_repo_map: ro,
      trail_blast_radius: ro,
      trail_refresh: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };

    for (const [name, annotations] of Object.entries(expected)) {
      const tool = registered.get(name);
      assert.ok(tool, `expected ${name} to be registered`);
      assert.equal(tool.exposure, "codemode", `${name} exposure mismatch`);
      assertValidNamespace(name, tool.namespace, "trail");
      assertValidAnnotations(name, tool.annotations, annotations);
    }
  });

  it("registers runtime and deferred admin tools under runtime namespace with annotations", async () => {
    const { pi, registered, emit } = createMockPi();
    try {
      withSubagentChildEnv(undefined, () => {
        registerAsyncAgents(pi, () => {});
        registerStatus(pi, false, () => [], () => []);
        registerWorktree(pi);
        registerDaemonManageTool(pi);
        registerCron(pi, () => ({ id: "1" }));
        registerSessionSearch(pi);
        registerSkillMaintenance(pi);
        registerEnforcement(pi, false);
        // list_models is registered directly by orchestrator index.
        orchestratorExtension(pi);
      });

      const ro: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
      const expected: Record<string, { exposure: string; annotations: ToolAnnotations }> = {
        session_status: { exposure: "codemode", annotations: ro },
        async_status: { exposure: "codemode", annotations: ro },
        worktree_status: { exposure: "codemode", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
        daemon_manage: { exposure: "codemode", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
        list_models: { exposure: "codemode", annotations: ro },
        settings_get: { exposure: "codemode", annotations: ro },
        cron_manage: { exposure: "codemode", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
        session_search: { exposure: "codemode", annotations: ro },
        skill_adopt: { exposure: "deferred", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
        review_status: { exposure: "deferred", annotations: ro },
      };

      for (const [name, spec] of Object.entries(expected)) {
        const tool = registered.get(name);
        assert.ok(tool, `expected ${name} to be registered`);
        assert.equal(tool.exposure, spec.exposure, `${name} exposure mismatch`);
        assertValidNamespace(name, tool.namespace, "runtime");
        assertValidAnnotations(name, tool.annotations, spec.annotations);
      }
    } finally {
      await emit("session_shutdown", {}, {});
    }
  });
});

describe("session_start codemode auto-activation (#1451)", () => {
  const sampleFallbackTools = [
    { name: CODEMODE_TOOL_NAME, exposure: "model-only", reachesTools: () => "all" },
    { name: "TaskCreate", exposure: "codemode", namespace: TOOL_NAMESPACES.tasks },
    { name: "memory_search", exposure: "codemode", namespace: TOOL_NAMESPACES.memory },
    { name: "memory_dream", exposure: "deferred", namespace: TOOL_NAMESPACES.memory },
    { name: "trail_find_code", exposure: "codemode", namespace: TOOL_NAMESPACES.trail },
    { name: "cron_manage", exposure: "codemode", namespace: TOOL_NAMESPACES.runtime },
    { name: "coms_start", exposure: "codemode", namespace: TOOL_NAMESPACES.coms },
    { name: "coms_send", exposure: "codemode", namespace: TOOL_NAMESPACES.coms, defaultActive: false },
    { name: "mcp__external__ping", exposure: "codemode", namespace: { name: "mcp__external" } },
  ];

  it("activates codemode on session_start when registered and inactive", async () => {
    const { pi, getActive, getSetActiveCalls, emit } = createMockPi({
      initialTools: [{ name: CODEMODE_TOOL_NAME, exposure: "model-only", reachesTools: () => "all" }],
      initialActive: ["read", "bash"],
    });

    registerCodemodeActivation(pi, ["node", "pi"]);
    await emit("session_start", { reason: "startup" }, {});

    assert.deepEqual(getActive(), ["read", "bash", CODEMODE_TOOL_NAME]);
    assert.equal(getSetActiveCalls(), 1);
  });

  it("does not call setActiveTools redundantly when codemode is already active", () => {
    const { pi, getSetActiveCalls } = createMockPi({
      initialTools: [{ name: CODEMODE_TOOL_NAME, exposure: "model-only", reachesTools: () => "all" }],
      initialActive: ["read", "bash", CODEMODE_TOOL_NAME],
    });

    const result = ensureCodemodeActive(pi, ["node", "pi"]);
    assert.deepEqual(result, { activated: false, reason: "already_active" });
    assert.equal(getSetActiveCalls(), 0);
  });

  it("detects CLI flags that exclude codemode via isCodemodeExcludedByArgv", () => {
    assert.equal(isCodemodeExcludedByArgv(["node", "pi", "--no-tools"]), true);
    assert.equal(isCodemodeExcludedByArgv(["node", "pi", "-nt"]), true);
    assert.equal(isCodemodeExcludedByArgv(["node", "pi", "--exclude-tools", "codemode"]), true);
    assert.equal(isCodemodeExcludedByArgv(["node", "pi", "--exclude-tools=code*"]), true);
    assert.equal(isCodemodeExcludedByArgv(["node", "pi", "-xt", "read,*mode"]), true);
    assert.equal(isCodemodeExcludedByArgv(["node", "pi", "--tools", "-codemode"]), true);
    assert.equal(isCodemodeExcludedByArgv(["node", "pi", "--tools", "read,bash"]), true);
    assert.equal(isCodemodeExcludedByArgv(["node", "pi", "--tools", "read,codemode"]), false);
    assert.equal(isCodemodeExcludedByArgv(["node", "pi", "--tools", "+codemode"]), false);
    assert.equal(isCodemodeExcludedByArgv(["node", "pi", "--", "--no-tools"]), false);
  });

  it("skips codemode activation when defaultTools contains -codemode", () => {
    const { pi, getActive, getSetActiveCalls } = createMockPi({
      initialTools: [{ name: CODEMODE_TOOL_NAME, exposure: "model-only", reachesTools: () => "all" }],
      initialActive: ["read", "bash"],
      settings: { defaultTools: ["-codemode"] },
    });

    assert.deepEqual(ensureCodemodeActive(pi, ["node", "pi"]), { activated: false, reason: "excluded" });
    assert.deepEqual(getActive(), ["read", "bash"]);
    assert.equal(getSetActiveCalls(), 0);
  });

  it("returns not_registered without throwing when codemode is absent and no fallback tools exist", () => {
    const { pi, getSetActiveCalls } = createMockPi({
      initialTools: [{ name: "read", exposure: "direct" }],
      initialActive: ["read"],
    });

    assert.deepEqual(ensureCodemodeActive(pi, ["node", "pi"]), {
      activated: false,
      reason: "not_registered",
    });
    assert.equal(getSetActiveCalls(), 0);
  });

  it("activates ungated extension tools as fallback when --exclude-tools codemode is set", () => {
    const { pi, getActive } = createMockPi({
      initialTools: sampleFallbackTools,
      initialActive: ["read", "bash"],
    });

    const res = ensureCodemodeActive(pi, ["node", "pi", "--exclude-tools", "codemode"]);
    assert.deepEqual(res, { activated: false, reason: "excluded", fallbackCount: 6 });
    assert.deepEqual(getActive(), [
      "read",
      "bash",
      "TaskCreate",
      "memory_search",
      "memory_dream",
      "trail_find_code",
      "cron_manage",
      "coms_start",
    ]);
  });

  it("keeps explicitly excluded tools omitted during codemode-excluded fallback", () => {
    const { pi, getActive } = createMockPi({
      initialTools: sampleFallbackTools,
      initialActive: ["read", "bash"],
    });

    const res = ensureCodemodeActive(pi, ["node", "pi", "--exclude-tools", "codemode,cron_manage"]);
    assert.deepEqual(res, { activated: false, reason: "excluded", fallbackCount: 5 });
    assert.equal(getActive().includes("cron_manage"), false);
    assert.equal(getActive().includes("TaskCreate"), true);
  });

  it("activates ungated extension tools as fallback when codemode is not registered", () => {
    const { pi, getActive } = createMockPi({
      initialTools: sampleFallbackTools.filter((t) => t.name !== CODEMODE_TOOL_NAME),
      initialActive: ["read", "bash"],
    });

    const res = ensureCodemodeActive(pi, ["node", "pi"]);
    assert.deepEqual(res, { activated: false, reason: "not_registered", fallbackCount: 6 });
    assert.equal(getActive().includes("TaskCreate"), true);
    assert.equal(getActive().includes("memory_search"), true);
    assert.equal(getActive().includes("coms_send"), false);
    assert.equal(getActive().includes("mcp__external__ping"), false);
  });

  it("does not activate fallback tools when --no-tools is passed", () => {
    const { pi, getActive } = createMockPi({
      initialTools: sampleFallbackTools,
      initialActive: [],
    });

    assert.deepEqual(ensureCodemodeActive(pi, ["node", "pi", "--no-tools"]), {
      activated: false,
      reason: "excluded",
    });
    assert.deepEqual(getActive(), []);
  });

  it("does not activate fallback tools when an explicit --tools allowlist omits codemode", () => {
    const { pi, getActive } = createMockPi({
      initialTools: sampleFallbackTools,
      initialActive: ["read", "bash"],
    });

    assert.deepEqual(ensureCodemodeActive(pi, ["node", "pi", "--tools", "read,bash"]), {
      activated: false,
      reason: "excluded",
    });
    assert.deepEqual(getActive(), ["read", "bash"]);
  });

  it("keeps gated COMS tools out of activeTools when codemode is active", () => {
    const { pi, getActive } = createMockPi({
      initialTools: [
        { name: CODEMODE_TOOL_NAME, exposure: "model-only", reachesTools: () => "all" },
        { name: "coms_send", exposure: "codemode" },
      ],
      initialActive: ["read", "bash", CODEMODE_TOOL_NAME],
    });

    syncComsActiveTools(pi, new Set(["coms_send"]), true);
    assert.deepEqual(getActive(), ["read", "bash", CODEMODE_TOOL_NAME]);
  });

  it("activates gated COMS tools directly when codemode is registered but inactive", () => {
    const { pi, getActive } = createMockPi({
      initialTools: [
        { name: CODEMODE_TOOL_NAME, exposure: "model-only", reachesTools: () => "all" },
        { name: "coms_send", exposure: "codemode" },
      ],
      initialActive: ["read", "bash"],
    });

    syncComsActiveTools(pi, new Set(["coms_send"]), true);
    assert.deepEqual(getActive(), ["read", "bash", "coms_send"]);
  });

  it("activates gated COMS tools directly when codemode is not registered", () => {
    const { pi, getActive } = createMockPi({
      initialTools: [{ name: "coms_send", exposure: "codemode" }],
      initialActive: ["read", "bash"],
    });

    syncComsActiveTools(pi, new Set(["coms_send"]), true);
    assert.deepEqual(getActive(), ["read", "bash", "coms_send"]);
  });

  it("demotes transiently activated gated COMS tools once ensureCodemodeActive activates codemode", () => {
    const { pi, getActive } = createMockPi({
      initialTools: [
        { name: CODEMODE_TOOL_NAME, exposure: "model-only", reachesTools: () => "all" },
        { name: "coms_send", exposure: "codemode", namespace: TOOL_NAMESPACES.coms },
      ],
      initialActive: ["read", "bash"],
    });

    syncComsActiveTools(pi, new Set(["coms_send"]), true);
    assert.deepEqual(getActive(), ["read", "bash", "coms_send"]);
    ensureCodemodeActive(pi, ["node", "pi"]);
    assert.deepEqual(getActive(), ["read", "bash", CODEMODE_TOOL_NAME]);
  });

  it("preserves gated COMS tools explicitly selected via --tools allowlist when codemode activates", () => {
    const { pi, getActive } = createMockPi({
      initialTools: [
        { name: CODEMODE_TOOL_NAME, exposure: "model-only", reachesTools: () => "all" },
        { name: "coms_send", exposure: "codemode", namespace: TOOL_NAMESPACES.coms },
      ],
      initialActive: ["read", "coms_send"],
    });

    ensureCodemodeActive(pi, ["node", "pi", "--tools", "read,codemode,coms_send"]);
    assert.deepEqual(getActive(), ["read", "coms_send", CODEMODE_TOOL_NAME]);
  });

  it("preserves gated COMS tools explicitly selected via defaultTools settings when codemode activates", () => {
    const { pi, getActive } = createMockPi({
      initialTools: [
        { name: CODEMODE_TOOL_NAME, exposure: "model-only", reachesTools: () => "all" },
        { name: "coms_send", exposure: "codemode", namespace: TOOL_NAMESPACES.coms },
      ],
      initialActive: ["read", "bash", "coms_send"],
      settings: { defaultTools: ["+coms_send"] },
    });

    ensureCodemodeActive(pi, ["node", "pi"]);
    assert.deepEqual(getActive(), ["read", "bash", "coms_send", CODEMODE_TOOL_NAME]);
  });
});
