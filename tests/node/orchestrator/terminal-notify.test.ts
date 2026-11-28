/**
 * Unit tests for desktop notification title formatting and terminalNotify gating (#1464).
 *
 * Run with: npx tsx --test --test-concurrency=4 tests/node/orchestrator/terminal-notify.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  formatNotificationTitle,
  setTerminalNotifyExecForTests,
  terminalNotify,
} from "../../../extensions/orchestrator/utils.js";
import { registerComs } from "../../../extensions/coms/coms-wrapper.js";
import { resetSessionBridge, setComsActive } from "../../../extensions/shared/session-bridge.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] });
}

function makeRealRepo(base: string, name: string): string {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  writeFileSync(join(repo, "README.md"), "hi\n", "utf-8");
  git(["add", "README.md"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  return repo;
}

function makeComsTestPi() {
  const tools = new Map<string, any>();
  const events = new Map<string, any[]>();
  let activeTools: string[] = [];
  const pi = {
    events: {
      emit: () => {},
      on: () => () => {},
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      if (tool.defaultActive !== false && !activeTools.includes(tool.name)) {
        activeTools.push(tool.name);
      }
    },
    registerFlag: () => {},
    registerMessageRenderer: () => {},
    getFlag: () => undefined,
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    on: (event: string, handler: any) => {
      const list = events.get(event) ?? [];
      list.push(handler);
      events.set(event, list);
    },
    appendEntry: () => {},
    sendMessage: () => {},
  };
  return { pi, tools, events };
}

describe("formatNotificationTitle", () => {
  let base: string;

  beforeEach(() => {
    resetSessionBridge({ all: true });
    base = makeTempDir("terminal-notify-");
  });

  afterEach(() => {
    resetSessionBridge({ all: true });
  });

  it("formats main git checkout with repo name", () => {
    const repo = makeRealRepo(base, "my-repo");
    const title = formatNotificationTitle("pi", { cwd: repo, argv: ["node", "pi"] });
    assert.equal(title, "pi (my-repo)");
  });

  it("formats subdirectory of main git checkout with repo name", () => {
    const repo = makeRealRepo(base, "my-repo");
    const nested = join(repo, "packages", "sub");
    mkdirSync(nested, { recursive: true });
    const title = formatNotificationTitle("pi", { cwd: nested, argv: ["node", "pi"] });
    assert.equal(title, "pi (my-repo)");
  });

  it("formats real linked git worktree with repo plus worktree name", () => {
    const repo = makeRealRepo(base, "pi-config");
    const worktree = join(base, "issue-1449-turn-snapshots");
    git(["worktree", "add", "-q", worktree, "-b", "wt-branch"], repo);
    const title = formatNotificationTitle("pi", { cwd: worktree, argv: ["node", "pi"] });
    assert.equal(title, "pi (pi-config · issue-1449-turn-snapshots)");
  });

  it("formats linked worktree gitdir fixture with repo plus worktree name", () => {
    const worktree = join(base, "issue-1464-wt");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(base, "pi-config", ".git", "worktrees", "issue-1464-wt")}\n`,
      "utf-8",
    );
    const title = formatNotificationTitle("pi", { cwd: worktree, argv: ["node", "pi"] });
    assert.equal(title, "pi (pi-config · issue-1464-wt)");
  });

  it("formats COMS peer from separate --cname flag", () => {
    const repo = makeRealRepo(base, "pi-config");
    const title = formatNotificationTitle("pi", {
      cwd: repo,
      argv: ["node", "pi", "--coms", "--cname", "peer-1449-snapshots"],
    });
    assert.equal(title, "pi (pi-config · peer-1449-snapshots)");
  });

  it("formats COMS peer from equals --cname flag", () => {
    const repo = makeRealRepo(base, "pi-config");
    const title = formatNotificationTitle("pi", {
      cwd: repo,
      argv: ["node", "pi", "--coms", "--cname=peer-foo"],
    });
    assert.equal(title, "pi (pi-config · peer-foo)");
  });

  it("prefers COMS peer name over linked worktree name", () => {
    const worktree = join(base, "issue-1449-turn-snapshots");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(base, "pi-config", ".git", "worktrees", "issue-1449-turn-snapshots")}\n`,
      "utf-8",
    );
    const title = formatNotificationTitle("pi", {
      cwd: worktree,
      argv: ["node", "pi", "--coms", "--cname", "peer-1449-snapshots"],
    });
    assert.equal(title, "pi (pi-config · peer-1449-snapshots)");
  });

  it("avoids duplicate label when peer name matches repo name", () => {
    const repo = makeRealRepo(base, "pi-config");
    const title = formatNotificationTitle("pi", {
      cwd: repo,
      argv: ["node", "pi", "--coms", "--cname", "pi-config"],
    });
    assert.equal(title, "pi (pi-config)");
  });

  it("falls back to directory basename outside git repos", () => {
    const plain = join(base, "scratch-folder");
    mkdirSync(plain, { recursive: true });
    const title = formatNotificationTitle("pi", { cwd: plain, argv: ["node", "pi"] });
    assert.equal(title, "pi (scratch-folder)");
  });

  it("honors custom resolveGitCommonDir option", () => {
    const title = formatNotificationTitle("pi", {
      cwd: "/virtual/pi-config/.worktrees/feature-x",
      argv: ["node", "pi"],
      resolveGitCommonDir: () => "/virtual/pi-config/.git",
    });
    assert.equal(title, "pi (pi-config · feature-x)");
  });

  it("derives repo name from separate git directory without worktree suffix", () => {
    const separateGitDir = join(base, "project.git");
    const workingCopy = join(base, "working-copy");
    mkdirSync(workingCopy, { recursive: true });
    git(["init", "-q", `--separate-git-dir=${separateGitDir}`], workingCopy);
    const title = formatNotificationTitle("pi", { cwd: workingCopy, argv: ["node", "pi"] });
    assert.equal(title, "pi (project)");
  });

  it("reflects git classification change on subsequent notification for same directory", () => {
    const dir = join(base, "evolving-dir");
    mkdirSync(dir, { recursive: true });
    assert.equal(formatNotificationTitle("pi", { cwd: dir, argv: ["node", "pi"] }), "pi (evolving-dir)");

    writeFileSync(
      join(dir, ".git"),
      `gitdir: ${join(base, "pi-config", ".git", "worktrees", "evolving-dir")}\n`,
      "utf-8",
    );
    assert.equal(formatNotificationTitle("pi", { cwd: dir, argv: ["node", "pi"] }), "pi (pi-config · evolving-dir)");
  });

  it("includes active in-session COMS peer name from session bridge", () => {
    const repo = makeRealRepo(base, "my-repo");
    setComsActive(true, "sess-active", "peer-live");
    const title = formatNotificationTitle("pi", {
      cwd: repo,
      argv: ["node", "pi"],
      sessionKey: "sess-active",
    });
    assert.equal(title, "pi (my-repo · peer-live)");
  });

  it("isolates active COMS peer name across sessions", () => {
    const repo = makeRealRepo(base, "my-repo");
    setComsActive(true, "sess-a", "peer-alpha");
    const title = formatNotificationTitle("pi", {
      cwd: repo,
      argv: ["node", "pi"],
      sessionKey: "sess-b",
    });
    assert.equal(title, "pi (my-repo)");
  });

  it("falls back to linked worktree name after COMS deactivation", () => {
    const worktree = join(base, "issue-1464-wt");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${join(base, "pi-config", ".git", "worktrees", "issue-1464-wt")}\n`,
      "utf-8",
    );
    setComsActive(true, "sess-stop", "peer-live");
    setComsActive(false, "sess-stop");
    const title = formatNotificationTitle("pi", {
      cwd: worktree,
      argv: ["node", "pi"],
      sessionKey: "sess-stop",
    });
    assert.equal(title, "pi (pi-config · issue-1464-wt)");
  });

  it("uses peer name activated via coms_start tool in an existing session", async () => {
    const repo = makeRealRepo(base, "pi-config");
    const comsDir = join(base, "coms");
    const sessionKey = "sess-coms-start-1464";
    const { pi, tools } = makeComsTestPi();
    const registered = registerComs(pi as any, {
      comsDir,
      sessionId: sessionKey,
      allowSubagentChild: true,
      registerSignalHandlers: false,
    });
    const ctx = {
      cwd: repo,
      hasUI: false,
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      sessionManager: {
        getSessionId: () => sessionKey,
        getEntries: () => [],
      },
    };
    try {
      const startTool = tools.get("coms_start");
      assert.ok(startTool);
      const res = await startTool.execute("call-1", { cname: "peer-session-live" }, undefined, undefined, ctx);
      assert.equal(res.details?.ok, true);

      const title = formatNotificationTitle("pi", {
        cwd: repo,
        argv: ["node", "pi"],
        sessionKey,
      });
      assert.equal(title, "pi (pi-config · peer-session-live)");
    } finally {
      await registered.runtime.stop();
    }
  });

  it("clears peer name after coms_stop tool deactivates session", async () => {
    const repo = makeRealRepo(base, "pi-config");
    const comsDir = join(base, "coms");
    const sessionKey = "sess-coms-stop-1464";
    const { pi, tools } = makeComsTestPi();
    const registered = registerComs(pi as any, {
      comsDir,
      sessionId: sessionKey,
      allowSubagentChild: true,
      registerSignalHandlers: false,
    });
    const ctx = {
      cwd: repo,
      hasUI: false,
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      sessionManager: {
        getSessionId: () => sessionKey,
        getEntries: () => [],
      },
    };
    try {
      const startTool = tools.get("coms_start");
      const stopTool = tools.get("coms_stop");
      assert.ok(startTool);
      assert.ok(stopTool);
      const started = await startTool.execute("call-1", { cname: "peer-session-temp" }, undefined, undefined, ctx);
      assert.equal(started.details?.ok, true);
      await stopTool.execute("call-2", {}, undefined, undefined, ctx);

      const title = formatNotificationTitle("pi", {
        cwd: repo,
        argv: ["node", "pi"],
        sessionKey,
      });
      assert.equal(title, "pi (pi-config)");
    } finally {
      await registered.runtime.stop();
    }
  });
});

describe("terminalNotify", () => {
  let savedSubagentChild: string | undefined;
  let savedSupervisedPeer: string | undefined;

  beforeEach(() => {
    resetSessionBridge({ all: true });
    savedSubagentChild = process.env.PI_SUBAGENT_CHILD;
    savedSupervisedPeer = process.env.PI_COMS_SUPERVISED_PEER;
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_COMS_SUPERVISED_PEER;
  });

  afterEach(() => {
    setTerminalNotifyExecForTests(null);
    resetSessionBridge({ all: true });
    if (savedSubagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = savedSubagentChild;
    if (savedSupervisedPeer === undefined) delete process.env.PI_COMS_SUPERVISED_PEER;
    else process.env.PI_COMS_SUPERVISED_PEER = savedSupervisedPeer;
  });

  it("suppresses notification for subagent children", () => {
    const calls: Array<[string, string]> = [];
    setTerminalNotifyExecForTests((args) => calls.push(args));
    process.env.PI_SUBAGENT_CHILD = "1";

    terminalNotify("pi", "Action required");

    assert.equal(calls.length, 0);
  });

  it("sends notification for supervised COMS peers", () => {
    const calls: Array<[string, string]> = [];
    setTerminalNotifyExecForTests((args) => calls.push(args));
    process.env.PI_COMS_SUPERVISED_PEER = "1";

    terminalNotify("pi", "Action required");

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [formatNotificationTitle("pi"), "Action required"]);
  });

  it("forwards sessionKey to include active in-session COMS peer name", () => {
    const base = makeTempDir("terminal-notify-session-");
    const repo = makeRealRepo(base, "my-repo");
    const calls: Array<[string, string]> = [];
    setTerminalNotifyExecForTests((args) => calls.push(args));
    setComsActive(true, "sess-notify", "peer-inline");

    terminalNotify("pi", "Task completed", { cwd: repo, argv: ["node", "pi"], sessionKey: "sess-notify" });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["pi (my-repo · peer-inline)", "Task completed"]);
  });
});
