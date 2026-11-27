import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_SNAPSHOT_STACK,
  captureShadowTree,
  parseDiffTreeRawZ,
  registerSnapshots,
  restoreShadowTree,
} from "../../../extensions/orchestrator/snapshots.js";
import {
  clearSettingsCache,
  setGlobalSettingsPath,
} from "../../../extensions/orchestrator/project-settings.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trimEnd();
}

function initRepo(dir: string, withInitialCommit = true): string {
  git(dir, ["init", "-q"]);
  if (withInitialCommit) {
    writeFileSync(join(dir, ".gitignore"), ".env\n.pi/\n*.ignored\n");
    writeFileSync(join(dir, "README.md"), "# initial\n");
    git(dir, ["add", ".gitignore", "README.md"]);
    git(dir, ["commit", "-q", "-m", "init"]);
  }
  return dir;
}

interface MockHarness {
  pi: any;
  commands: Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>;
  hooks: Map<string, Array<(...args: any[]) => any>>;
  notifications: Array<{ msg: string; level: string }>;
  messages: Array<{ content: string; customType: string }>;
  emit: (eventName: string, event: any, ctx: any) => void;
  makeCtx: (cwd: string, sessionId?: string, hasUI?: boolean) => any;
}

function createHarness(): MockHarness {
  const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const hooks = new Map<string, Array<(...args: any[]) => any>>();
  const notifications: Array<{ msg: string; level: string }> = [];
  const messages: Array<{ content: string; customType: string }> = [];

  const pi = {
    on(eventName: string, handler: (...args: any[]) => any) {
      const list = hooks.get(eventName) ?? [];
      list.push(handler);
      hooks.set(eventName, list);
    },
    registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, opts);
    },
    sendMessage(msg: { customType: string; content: string; display?: boolean }) {
      messages.push({ customType: msg.customType, content: msg.content });
    },
  };

  const emit = (eventName: string, event: any, ctx: any): void => {
    for (const fn of hooks.get(eventName) ?? []) {
      fn(event, ctx);
    }
  };

  const makeCtx = (cwd: string, sessionId = "sess-1", hasUI = true) => ({
    cwd,
    hasUI,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify(msg: string, level: string) {
        notifications.push({ msg, level });
      },
    },
  });

  return { pi, commands, hooks, notifications, messages, emit, makeCtx };
}

function runTurn(
  harness: MockHarness,
  ctx: any,
  prompt: string,
  toolName: string,
  mutate: () => void,
): void {
  harness.emit("before_agent_start", { prompt, messageType: "user" }, ctx);
  harness.emit("tool_call", { toolName }, ctx);
  mutate();
  harness.emit("agent_end", {}, ctx);
}

describe("orchestrator turn snapshots (/undo & /redo)", () => {
  let globalTmp: string;
  const savedEnv = {
    PI_TURN_SNAPSHOTS: process.env.PI_TURN_SNAPSHOTS,
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
  };

  beforeEach(() => {
    clearSettingsCache();
    globalTmp = makeTempDir("pi-snap-global-");
    setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
    delete process.env.PI_TURN_SNAPSHOTS;
    delete process.env.PI_SUBAGENT_CHILD;
  });

  afterEach(() => {
    setGlobalSettingsPath(null);
    clearSettingsCache();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
  });

  it("preserves real .git/index staged changes, HEAD, reflog, and stash across capture/undo/redo", async () => {
    const repo = initRepo(makeTempDir("pi-snap-index-"));
    writeFileSync(join(repo, "staged.txt"), "staged-v1\n");
    git(repo, ["add", "staged.txt"]);
    writeFileSync(join(repo, "staged.txt"), "staged-v1-unstaged-edit\n");

    const headBefore = git(repo, ["rev-parse", "HEAD"]);
    const cachedBefore = git(repo, ["diff", "--cached", "--raw"]);
    const reflogBefore = git(repo, ["reflog"]);

    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    runTurn(harness, ctx, "Edit README", "edit", () => {
      writeFileSync(join(repo, "README.md"), "# changed by turn\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "# initial\n");
    assert.equal(readFileSync(join(repo, "staged.txt"), "utf-8"), "staged-v1-unstaged-edit\n");
    assert.equal(git(repo, ["diff", "--cached", "--raw"]), cachedBefore);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(git(repo, ["reflog"]), reflogBefore);
    assert.equal(git(repo, ["stash", "list"]), "");

    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "# changed by turn\n");
    assert.equal(git(repo, ["diff", "--cached", "--raw"]), cachedBefore);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(git(repo, ["stash", "list"]), "");
  });

  it("/undo reverts modified, deleted, and newly created files while preserving gitignored files", async () => {
    const repo = initRepo(makeTempDir("pi-snap-undo-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "export const v = 1;\n");
    writeFileSync(join(repo, "src", "keep.ts"), "export const keep = true;\n");
    writeFileSync(join(repo, ".env"), "SECRET=keep-me\n");
    writeFileSync(join(repo, ".pi", "state.json"), '{"ok":true}\n');
    git(repo, ["add", "src/app.ts", "src/keep.ts"]);
    git(repo, ["commit", "-q", "-m", "add src"]);

    // Pre-existing untracked non-ignored file should also be preserved.
    writeFileSync(join(repo, "notes.txt"), "user notes\n");

    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    runTurn(harness, ctx, "Refactor app and add helper", "write", () => {
      writeFileSync(join(repo, "src", "app.ts"), "export const v = 2;\n");
      rmSync(join(repo, "src", "keep.ts"));
      mkdirSync(join(repo, "src", "brand-new"), { recursive: true });
      writeFileSync(join(repo, "src", "brand-new", "helper.ts"), "export const h = 1;\n");
      mkdirSync(join(repo, "src", "with-ignored"), { recursive: true });
      writeFileSync(join(repo, "src", "with-ignored", "temp.ts"), "export const t = 1;\n");
      writeFileSync(join(repo, "src", "with-ignored", "local.ignored"), "keep ignored\n");
      writeFileSync(join(repo, ".env"), "SECRET=updated-ignored\n");
      writeFileSync(join(repo, "notes.txt"), "user notes mutated\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);

    assert.equal(readFileSync(join(repo, "src", "app.ts"), "utf-8"), "export const v = 1;\n");
    assert.equal(readFileSync(join(repo, "src", "keep.ts"), "utf-8"), "export const keep = true;\n");
    assert.equal(readFileSync(join(repo, "notes.txt"), "utf-8"), "user notes\n");
    assert.equal(existsSync(join(repo, "src", "brand-new", "helper.ts")), false);
    assert.equal(existsSync(join(repo, "src", "brand-new")), false, "empty new dir should be pruned");
    assert.equal(existsSync(join(repo, "src", "with-ignored", "temp.ts")), false);
    assert.equal(
      readFileSync(join(repo, "src", "with-ignored", "local.ignored"), "utf-8"),
      "keep ignored\n",
      "gitignored file inside new dir must be preserved",
    );
    assert.equal(
      readFileSync(join(repo, ".env"), "utf-8"),
      "SECRET=updated-ignored\n",
      "gitignored .env must never be overwritten or deleted",
    );
    assert.equal(readFileSync(join(repo, ".pi", "state.json"), "utf-8"), '{"ok":true}\n');

    const lastNotice = harness.notifications.at(-1)!;
    assert.equal(lastNotice.level, "info");
    assert.match(lastNotice.msg, /Undid turn: "Refactor app and add helper"/);
    assert.match(lastNotice.msg, /Restored \(3\):/);
    assert.match(lastNotice.msg, /Removed \(2\):/);
    assert.match(lastNotice.msg, /\(0 undo, 1 redo available\)/);
  });

  it("/redo restores the undone turn and a subsequent mutating turn clears the redo stack", async () => {
    const repo = initRepo(makeTempDir("pi-snap-redo-"));
    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    runTurn(harness, ctx, "Turn 1", "write", () => {
      writeFileSync(join(repo, "README.md"), "# turn 1\n");
      writeFileSync(join(repo, "added.txt"), "new file\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "# initial\n");
    assert.equal(existsSync(join(repo, "added.txt")), false);

    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "# turn 1\n");
    assert.equal(readFileSync(join(repo, "added.txt"), "utf-8"), "new file\n");
    assert.match(harness.notifications.at(-1)!.msg, /Redid turn: "Turn 1"/);

    // Undo again, then perform a brand-new mutating turn — redo stack must clear.
    await harness.commands.get("undo")!.handler("", ctx);
    runTurn(harness, ctx, "Turn 2", "bash", () => {
      writeFileSync(join(repo, "turn2.txt"), "t2\n");
    });

    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(harness.notifications.at(-1)!.msg, "Nothing to redo.");
    assert.equal(readFileSync(join(repo, "turn2.txt"), "utf-8"), "t2\n");
  });

  it("read-only turns and unchanged bash turns push nothing and preserve redo stack", async () => {
    const repo = initRepo(makeTempDir("pi-snap-noop-"));
    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    // Pure read turn — never captures.
    runTurn(harness, ctx, "Read file", "read", () => {});
    await harness.commands.get("undo")!.handler("", ctx);
    assert.match(harness.notifications.at(-1)!.msg, /Nothing to undo/);

    // Record one real mutating turn and undo it so redoStack has 1 entry.
    runTurn(harness, ctx, "Mutate", "edit", () => {
      writeFileSync(join(repo, "README.md"), "# mutated\n");
    });
    await harness.commands.get("undo")!.handler("", ctx);

    // Bash turn that mutates nothing must neither push to undo nor clear redo.
    runTurn(harness, ctx, "Inspect status", "bash", () => {});
    await harness.commands.get("undo")!.handler("", ctx);
    assert.match(harness.notifications.at(-1)!.msg, /Nothing to undo/);

    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "# mutated\n");
  });

  it("enforces bounded stack depth of 20 by dropping oldest entries", async () => {
    assert.equal(MAX_SNAPSHOT_STACK, 20);
    const repo = initRepo(makeTempDir("pi-snap-bound-"));
    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    for (let i = 1; i <= 22; i++) {
      runTurn(harness, ctx, `Turn ${i}`, "write", () => {
        writeFileSync(join(repo, "counter.txt"), `${i}\n`);
      });
    }

    // 20 undos should succeed, stepping back from 22 to 2 (turns 1 and 2 were evicted).
    for (let i = 0; i < 20; i++) {
      await harness.commands.get("undo")!.handler("", ctx);
    }
    assert.equal(readFileSync(join(repo, "counter.txt"), "utf-8"), "2\n");

    // 21st undo must report nothing left.
    await harness.commands.get("undo")!.handler("", ctx);
    assert.match(harness.notifications.at(-1)!.msg, /Nothing to undo/);
  });

  it("no-ops cleanly when turn_snapshots is false", async () => {
    const repo = initRepo(makeTempDir("pi-snap-disabled-"));
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(join(repo, ".pi", "pi-config-settings.json"), JSON.stringify({ turn_snapshots: false }));
    clearSettingsCache();

    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    runTurn(harness, ctx, "Edit while disabled", "write", () => {
      writeFileSync(join(repo, "README.md"), "# changed\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(harness.notifications.at(-1)!.level, "warning");
    assert.match(harness.notifications.at(-1)!.msg, /disabled/i);
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "# changed\n");

    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(harness.notifications.at(-1)!.level, "warning");
    assert.match(harness.notifications.at(-1)!.msg, /disabled/i);
  });

  it("no-ops cleanly outside git repositories", async () => {
    const nonGit = makeTempDir("pi-snap-nongit-");
    writeFileSync(join(nonGit, "file.txt"), "v1\n");

    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(nonGit);

    runTurn(harness, ctx, "Edit outside git", "write", () => {
      writeFileSync(join(nonGit, "file.txt"), "v2\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.match(harness.notifications.at(-1)!.msg, /Nothing to undo/);
    assert.equal(readFileSync(join(nonGit, "file.txt"), "utf-8"), "v2\n");
  });

  it("skips registration completely in headless subagents (PI_SUBAGENT_CHILD=1)", () => {
    process.env.PI_SUBAGENT_CHILD = "1";
    const harness = createHarness();
    registerSnapshots(harness.pi);

    assert.equal(harness.commands.size, 0);
    assert.equal(harness.hooks.size, 0);
  });

  it("works in unborn git repos, nested cwds, and with filenames containing spaces", async () => {
    const repo = initRepo(makeTempDir("pi-snap-unborn-"), false);
    const subDir = join(repo, "packages", "web");
    mkdirSync(subDir, { recursive: true });

    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(subDir);

    runTurn(harness, ctx, "Create spaced file", "write", () => {
      writeFileSync(join(subDir, "my file.txt"), "hello spaces\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(existsSync(join(subDir, "my file.txt")), false);

    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(readFileSync(join(subDir, "my file.txt"), "utf-8"), "hello spaces\n");
  });

  it("cleans up temporary GIT_INDEX_FILE directories unconditionally", () => {
    const repo = initRepo(makeTempDir("pi-snap-cleanup-"));
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("pi-snapshot-")));

    const tree1 = captureShadowTree(repo);
    assert.ok(tree1);
    writeFileSync(join(repo, "README.md"), "# temp\n");
    const res = restoreShadowTree(repo, tree1);
    assert.equal(res.ok, true);

    const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith("pi-snapshot-") && !before.has(n));
    assert.deepEqual(leaked, []);
  });

  it("parseDiffTreeRawZ skips submodule gitlinks and unsafe paths", () => {
    const raw = [
      `:160000 160000 ${"a".repeat(40)} ${"b".repeat(40)} M\0submod\0`,
      `:100644 000000 ${"a".repeat(40)} ${"0".repeat(40)} D\0../escape.txt\0`,
      `:100644 000000 ${"a".repeat(40)} ${"0".repeat(40)} D\0.git/config\0`,
      `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0src/ok file.ts\0`,
      `:100644 000000 ${"a".repeat(40)} ${"0".repeat(40)} D\0src/removed.ts\0`,
    ].join("");
    const diff = parseDiffTreeRawZ(raw);
    assert.deepEqual(diff, {
      restored: ["src/ok file.ts"],
      removed: ["src/removed.ts"],
    });
  });

  it("collapses multiple mutating tool calls in one turn into a single undo entry", async () => {
    const repo = initRepo(makeTempDir("pi-snap-multi-tool-"));
    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    harness.emit("before_agent_start", { prompt: "Multi-step turn", messageType: "user" }, ctx);
    harness.emit("tool_call", { toolName: "write" }, ctx);
    writeFileSync(join(repo, "a.txt"), "a\n");
    harness.emit("tool_call", { toolName: "edit" }, ctx);
    writeFileSync(join(repo, "README.md"), "# multi\n");
    harness.emit("tool_call", { toolName: "bash" }, ctx);
    writeFileSync(join(repo, "b.txt"), "b\n");
    harness.emit("agent_end", {}, ctx);

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(existsSync(join(repo, "a.txt")), false);
    assert.equal(existsSync(join(repo, "b.txt")), false);
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "# initial\n");

    await harness.commands.get("undo")!.handler("", ctx);
    assert.match(harness.notifications.at(-1)!.msg, /Nothing to undo/);
  });

  it("handles file-to-directory replacement and PI_TURN_SNAPSHOTS=false env override", async () => {
    const repo = initRepo(makeTempDir("pi-snap-typechange-"));
    writeFileSync(join(repo, "item"), "file-version\n");
    git(repo, ["add", "item"]);
    git(repo, ["commit", "-q", "-m", "add item file"]);

    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    runTurn(harness, ctx, "Replace file with dir", "bash", () => {
      rmSync(join(repo, "item"));
      mkdirSync(join(repo, "item"), { recursive: true });
      writeFileSync(join(repo, "item", "child.txt"), "dir-version\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "item"), "utf-8"), "file-version\n");

    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "item", "child.txt"), "utf-8"), "dir-version\n");

    // Env override disables snapshots dynamically.
    process.env.PI_TURN_SNAPSHOTS = "false";
    clearSettingsCache();
    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(harness.notifications.at(-1)!.level, "warning");
    assert.equal(readFileSync(join(repo, "item", "child.txt"), "utf-8"), "dir-version\n");
  });

  it("falls back to pi.sendMessage when ctx.hasUI is false", async () => {
    const repo = initRepo(makeTempDir("pi-snap-noui-"));
    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo, "sess-noui", false);

    runTurn(harness, ctx, "Headless edit", "write", () => {
      writeFileSync(join(repo, "README.md"), "# headless\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(harness.notifications.length, 0);
    assert.equal(harness.messages.length, 1);
    assert.equal(harness.messages[0]!.customType, "snapshots");
    assert.match(harness.messages[0]!.content, /Undid turn: "Headless edit"/);
  });
});
