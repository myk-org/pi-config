/**
 * Tests for automatic `codemode` activation on `session_start` (#1447).
 *
 * Ensures default Pi 1.6.1 sessions automatically activate `codemode` so native
 * `models.generateImages()` works after retiring `extensions/image-gen/`, while
 * strictly respecting explicit exclusions (`--no-tools`, `--exclude-tools`,
 * `--tools -codemode`, and `defaultTools` in Pi's `settings.json`).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import orchestratorExtension, {
  ensureCodemodeActive,
} from "../../../extensions/orchestrator/index.js";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeToolApi(opts: {
  allTools?: Array<{ name: string; reachesTools?: (input: Record<string, unknown>) => "all" | readonly string[] }>;
  activeTools?: string[];
} = {}) {
  let active = [...(opts.activeTools ?? ["read", "bash", "edit", "write"])];
  const setCalls: string[][] = [];
  const all = opts.allTools ?? [
    { name: "read" },
    { name: "bash" },
    { name: "edit" },
    { name: "write" },
    { name: "codemode", reachesTools: () => "all" },
  ];
  const pi = {
    getAllTools: () => all as any,
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
      setCalls.push([...names]);
    },
  };
  return { pi, getActive: () => [...active], setCalls };
}

describe("ensureCodemodeActive (#1447)", () => {
  it("activates codemode in a fresh default session without user tool settings", () => {
    const agentDir = createTempDir("codemode-agent-");
    const cwd = createTempDir("codemode-cwd-");
    const { pi, getActive, setCalls } = makeToolApi();

    const activated = ensureCodemodeActive(pi, {
      agentDir,
      cwd,
      projectTrusted: true,
      argv: ["node", "pi"],
      isSubagentChild: false,
    });

    assert.equal(activated, true);
    assert.equal(setCalls.length, 1);
    assert.deepEqual(getActive(), ["read", "bash", "edit", "write", "codemode"]);
  });

  it("does not call setActiveTools when codemode is already active", () => {
    const agentDir = createTempDir("codemode-agent-");
    const { pi, setCalls } = makeToolApi({
      activeTools: ["read", "bash", "codemode"],
    });

    const activated = ensureCodemodeActive(pi, {
      agentDir,
      argv: ["node", "pi"],
      isSubagentChild: false,
    });

    assert.equal(activated, false);
    assert.equal(setCalls.length, 0);
  });

  it("skips when codemode is absent from getAllTools (--no-tools / --exclude-tools / -builtin:codemode)", () => {
    const agentDir = createTempDir("codemode-agent-");
    const { pi, getActive, setCalls } = makeToolApi({
      allTools: [{ name: "read" }, { name: "bash" }],
      activeTools: ["read", "bash"],
    });

    const activated = ensureCodemodeActive(pi, {
      agentDir,
      argv: ["node", "pi"],
      isSubagentChild: false,
    });

    assert.equal(activated, false);
    assert.equal(setCalls.length, 0);
    assert.deepEqual(getActive(), ["read", "bash"]);
  });

  it("requires reachesTools on the codemode tool definition", () => {
    const agentDir = createTempDir("codemode-agent-");
    const { pi, setCalls } = makeToolApi({
      allTools: [{ name: "read" }, { name: "codemode" }],
    });

    const activated = ensureCodemodeActive(pi, {
      agentDir,
      argv: ["node", "pi"],
      isSubagentChild: false,
    });

    assert.equal(activated, false);
    assert.equal(setCalls.length, 0);
  });

  it("skips activation in subagent children", () => {
    const agentDir = createTempDir("codemode-agent-");
    const { pi, setCalls } = makeToolApi();

    const activated = ensureCodemodeActive(pi, {
      agentDir,
      argv: ["node", "pi"],
      isSubagentChild: true,
    });

    assert.equal(activated, false);
    assert.equal(setCalls.length, 0);
  });

  it("respects CLI --tools -codemode and --no-tools / -nt exclusions", () => {
    const agentDir = createTempDir("codemode-agent-");

    for (const argv of [
      ["node", "pi", "--tools", "-codemode"],
      ["node", "pi", "--tools=+grep,-codemode"],
      ["node", "pi", "--no-tools"],
      ["node", "pi", "-nt"],
    ]) {
      const { pi, setCalls } = makeToolApi();
      const activated = ensureCodemodeActive(pi, {
        agentDir,
        argv,
        isSubagentChild: false,
      });
      assert.equal(activated, false, `expected skip for argv=${argv.join(" ")}`);
      assert.equal(setCalls.length, 0);
    }
  });

  it("ignores --tools -codemode appearing after -- positional separator", () => {
    const agentDir = createTempDir("codemode-agent-");
    const { pi, getActive } = makeToolApi();

    const activated = ensureCodemodeActive(pi, {
      agentDir,
      argv: ["node", "pi", "--", "--tools", "-codemode"],
      isSubagentChild: false,
    });

    assert.equal(activated, true);
    assert.equal(getActive().includes("codemode"), true);
  });

  it("respects defaultTools exclusions in global Pi settings.json", () => {
    for (const defaultTools of [["-codemode"], ["read", "bash"], []]) {
      const agentDir = createTempDir("codemode-agent-");
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools }));
      const { pi, setCalls } = makeToolApi();

      const activated = ensureCodemodeActive(pi, {
        agentDir,
        argv: ["node", "pi"],
        isSubagentChild: false,
      });
      assert.equal(activated, false, `expected skip for defaultTools=${JSON.stringify(defaultTools)}`);
      assert.equal(setCalls.length, 0);
    }
  });

  it("activates codemode when defaultTools only adds an unrelated modifier like +grep", () => {
    const agentDir = createTempDir("codemode-agent-");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+grep"] }));
    const { pi, getActive } = makeToolApi();

    const activated = ensureCodemodeActive(pi, {
      agentDir,
      argv: ["node", "pi"],
      isSubagentChild: false,
    });

    assert.equal(activated, true);
    assert.equal(getActive().includes("codemode"), true);
  });

  it("ignores project defaultTools when the project is untrusted", () => {
    const agentDir = createTempDir("codemode-agent-");
    const cwd = createTempDir("codemode-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["-codemode"] }));

    const { pi } = makeToolApi();
    assert.equal(
      ensureCodemodeActive(pi, {
        agentDir,
        cwd,
        projectTrusted: false,
        argv: ["node", "pi"],
        isSubagentChild: false,
      }),
      true,
    );
  });

  it("suppresses codemode when a trusted project excludes it in defaultTools", () => {
    const agentDir = createTempDir("codemode-agent-");
    const cwd = createTempDir("codemode-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["-codemode"] }));

    const { pi } = makeToolApi();
    assert.equal(
      ensureCodemodeActive(pi, {
        agentDir,
        cwd,
        projectTrusted: true,
        argv: ["node", "pi"],
        isSubagentChild: false,
      }),
      false,
    );
  });

  it("lets CLI --tools +codemode override a trusted project exclusion", () => {
    const agentDir = createTempDir("codemode-agent-");
    const cwd = createTempDir("codemode-cwd-");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["-codemode"] }));

    const { pi } = makeToolApi();
    assert.equal(
      ensureCodemodeActive(pi, {
        agentDir,
        cwd,
        projectTrusted: true,
        argv: ["node", "pi", "--tools", "+codemode"],
        isSubagentChild: false,
      }),
      true,
    );
  });

  it("preserves global -codemode when a trusted project adds modifier-only defaultTools", () => {
    const agentDir = createTempDir("codemode-agent-");
    const cwd = createTempDir("codemode-cwd-");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["-codemode"] }));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["-grep"] }));

    // Matches Pi 1.6.1 SettingsManager.mergeDefaultTools(): modifier-only overrides append to global.
    const { pi } = makeToolApi();
    assert.equal(
      ensureCodemodeActive(pi, {
        agentDir,
        cwd,
        projectTrusted: true,
        argv: ["node", "pi"],
        isSubagentChild: false,
      }),
      false,
    );
  });

  it("lets a trusted project plain defaultTools list replace global -codemode", () => {
    const agentDir = createTempDir("codemode-agent-");
    const cwd = createTempDir("codemode-cwd-");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["-codemode"] }));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read", "bash", "codemode"] }));

    const { pi } = makeToolApi();
    assert.equal(
      ensureCodemodeActive(pi, {
        agentDir,
        cwd,
        projectTrusted: true,
        argv: ["node", "pi"],
        isSubagentChild: false,
      }),
      true,
    );
  });

  it("fails soft on corrupt settings.json", () => {
    const agentDir = createTempDir("codemode-agent-");
    writeFileSync(join(agentDir, "settings.json"), "{ invalid json");
    const { pi, getActive } = makeToolApi();

    const activated = ensureCodemodeActive(pi, {
      agentDir,
      argv: ["node", "pi"],
      isSubagentChild: false,
    });

    assert.equal(activated, true);
    assert.equal(getActive().includes("codemode"), true);
  });

  it("orchestrator session_start wires codemode activation in a fresh session", async () => {
    const agentDir = createTempDir("codemode-e2e-agent-");
    const cwd = createTempDir("codemode-e2e-cwd-");
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    let activeTools = ["read", "bash", "edit", "write"];
    const allTools: any[] = [
      { name: "read" },
      { name: "bash" },
      { name: "edit" },
      { name: "write" },
      { name: "codemode", reachesTools: () => "all" },
    ];
    const fakePi: any = {
      on: (event: string, fn: (...args: any[]) => any) => {
        const list = handlers.get(event) ?? [];
        list.push(fn);
        handlers.set(event, list);
      },
      events: {
        emit: () => {},
        on: () => () => {},
      },
      registerCommand: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      registerEntryRenderer: () => {},
      registerMessageRenderer: () => {},
      registerToolRenderer: () => {},
      getFlag: () => undefined,
      registerTool: (def: any) => {
        allTools.push(def);
        if (def.defaultActive !== false && !activeTools.includes(def.name)) {
          activeTools.push(def.name);
        }
      },
      getAllTools: () => [...allTools],
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => {
        activeTools = [...names];
      },
      appendEntry: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
    };

    try {
      withSubagentChildEnv(undefined, () => {
        orchestratorExtension(fakePi);
        return undefined;
      });

      assert.equal(activeTools.includes("codemode"), false);
      const startHandlers = handlers.get("session_start") ?? [];
      assert.ok(startHandlers.length > 0, "expected orchestrator to register session_start handler");

      // Invoke the first session_start handler (orchestrator bootstrap handler)
      await startHandlers[0](
        { reason: "startup" },
        {
          cwd,
          mode: "tui",
          hasUI: false,
          isProjectTrusted: () => true,
          ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
          sessionManager: { getSessionId: () => "fresh-session-1447", getEntries: () => [] },
        },
      );

      assert.equal(activeTools.includes("codemode"), true);
    } finally {
      // Shut down orchestrator resources (timers/DB handles) cleanly
      for (const fn of handlers.get("session_shutdown") ?? []) {
        try {
          await fn({ reason: "exit" }, { cwd });
        } catch {}
      }
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  });
});
