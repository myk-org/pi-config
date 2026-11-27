import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  MAX_SNAPSHOT_STACK,
  captureShadowTree,
  parseDiffTreeRawZ,
  registerSnapshots,
  resolveSnapshotTimeoutMs,
  restoreShadowTree,
} from "../../../extensions/orchestrator/snapshots.js";
import { runGitAsync } from "../../../extensions/orchestrator/git-helpers.js";
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
  emit: (eventName: string, event: any, ctx: any) => Promise<void>;
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

  const emit = async (eventName: string, event: any, ctx: any): Promise<void> => {
    for (const fn of hooks.get(eventName) ?? []) {
      await fn(event, ctx);
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

async function runTurn(
  harness: MockHarness,
  ctx: any,
  prompt: string,
  toolName: string,
  mutate: () => void,
): Promise<void> {
  await harness.emit("before_agent_start", { prompt, messageType: "user" }, ctx);
  await harness.emit("tool_call", { toolName }, ctx);
  mutate();
  await harness.emit("agent_end", {}, ctx);
}

describe("orchestrator turn snapshots (/undo & /redo)", () => {
  let globalTmp: string;
  const savedEnv = {
    PI_TURN_SNAPSHOTS: process.env.PI_TURN_SNAPSHOTS,
    PI_TURN_SNAPSHOTS_TIMEOUT_MS: process.env.PI_TURN_SNAPSHOTS_TIMEOUT_MS,
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
  };

  beforeEach(() => {
    clearSettingsCache();
    globalTmp = makeTempDir("pi-snap-global-");
    setGlobalSettingsPath(join(globalTmp, "pi-config-settings.json"));
    delete process.env.PI_TURN_SNAPSHOTS;
    delete process.env.PI_TURN_SNAPSHOTS_TIMEOUT_MS;
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

    await runTurn(harness, ctx, "Edit README", "edit", () => {
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

    await runTurn(harness, ctx, "Refactor app and add helper", "write", () => {
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

    await runTurn(harness, ctx, "Turn 1", "write", () => {
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
    await runTurn(harness, ctx, "Turn 2", "bash", () => {
      writeFileSync(join(repo, "turn2.txt"), "t2\n");
    });

    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(harness.notifications.at(-1)!.msg, "Nothing to redo.");
    assert.equal(readFileSync(join(repo, "turn2.txt"), "utf-8"), "t2\n");
  });

  it("preserves unrelated user edits made after agent_end and detects conflicts on affected files", async () => {
    const repo = initRepo(makeTempDir("pi-snap-user-edits-"));
    writeFileSync(join(repo, "unrelated.txt"), "orig\n");
    git(repo, ["add", "unrelated.txt"]);
    git(repo, ["commit", "-q", "-m", "add unrelated"]);

    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    await runTurn(harness, ctx, "Edit README only", "edit", () => {
      writeFileSync(join(repo, "README.md"), "# turn edit\n");
    });

    // User modifies an unrelated tracked file and creates a brand-new file AFTER agent_end.
    writeFileSync(join(repo, "unrelated.txt"), "user later edit\n");
    writeFileSync(join(repo, "user-created.txt"), "keep me\n");

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "# initial\n");
    assert.equal(readFileSync(join(repo, "unrelated.txt"), "utf-8"), "user later edit\n");
    assert.equal(readFileSync(join(repo, "user-created.txt"), "utf-8"), "keep me\n");

    // Redo also preserves the unrelated edits.
    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "# turn edit\n");
    assert.equal(readFileSync(join(repo, "unrelated.txt"), "utf-8"), "user later edit\n");
    assert.equal(readFileSync(join(repo, "user-created.txt"), "utf-8"), "keep me\n");

    // Now user modifies the SAME file the turn touched -> /undo must refuse with a conflict.
    writeFileSync(join(repo, "README.md"), "# manual conflict edit\n");
    await harness.commands.get("undo")!.handler("", ctx);
    const conflictNotice = harness.notifications.at(-1)!;
    assert.equal(conflictNotice.level, "error");
    assert.match(conflictNotice.msg, /Conflicting changes.*README\.md/);
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "# manual conflict edit\n");
  });

  it("protects originally-ignored files when a turn removes an ignore rule and newly-ignored files on /redo", async () => {
    const repo = initRepo(makeTempDir("pi-snap-ignore-change-"));
    writeFileSync(join(repo, "secret.ignored"), "precious user secret\n");

    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    // Scenario A: turn removes `*.ignored` from .gitignore, exposing pre-existing secret.ignored.
    await runTurn(harness, ctx, "Update gitignore", "edit", () => {
      writeFileSync(join(repo, ".gitignore"), ".env\n.pi/\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(harness.notifications.at(-1)!.level, "error");
    assert.match(harness.notifications.at(-1)!.msg, /previously gitignored.*secret\.ignored/);
    assert.equal(readFileSync(join(repo, "secret.ignored"), "utf-8"), "precious user secret\n");

    // Scenario B: turn creates a new file, user undoes it, then adds it to .gitignore and writes a local ignored file.
    const repo2 = initRepo(makeTempDir("pi-snap-redo-ignored-"));
    const harness2 = createHarness();
    registerSnapshots(harness2.pi);
    const ctx2 = harness2.makeCtx(repo2);

    await runTurn(harness2, ctx2, "Create generated file", "write", () => {
      writeFileSync(join(repo2, "local.cfg"), "from turn\n");
    });
    await harness2.commands.get("undo")!.handler("", ctx2);
    assert.equal(existsSync(join(repo2, "local.cfg")), false);

    // User adds local.cfg to .gitignore and writes their own ignored replacement.
    writeFileSync(join(repo2, ".gitignore"), ".env\n.pi/\n*.ignored\nlocal.cfg\n");
    writeFileSync(join(repo2, "local.cfg"), "my private local config\n");

    await harness2.commands.get("redo")!.handler("", ctx2);
    assert.equal(harness2.notifications.at(-1)!.level, "error");
    assert.match(harness2.notifications.at(-1)!.msg, /currently gitignored.*local\.cfg/);
    assert.equal(readFileSync(join(repo2, "local.cfg"), "utf-8"), "my private local config\n");
  });

  it("preflights file-vs-directory collision with ignored child without deleting any files", async () => {
    const repo = initRepo(makeTempDir("pi-snap-preflight-"));
    writeFileSync(join(repo, "item"), "original-file\n");
    git(repo, ["add", "item"]);
    git(repo, ["commit", "-q", "-m", "add item"]);

    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    await runTurn(harness, ctx, "Replace item with dir", "bash", () => {
      rmSync(join(repo, "item"));
      mkdirSync(join(repo, "item"), { recursive: true });
      writeFileSync(join(repo, "item", "child.txt"), "child content\n");
      writeFileSync(join(repo, "item", "keep.ignored"), "ignored child\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(harness.notifications.at(-1)!.level, "error");
    assert.match(harness.notifications.at(-1)!.msg, /(?:gitignored|preserved\/ignored).*item\/keep\.ignored/);
    // Preflight must abort BEFORE deleting item/child.txt!
    assert.equal(readFileSync(join(repo, "item", "child.txt"), "utf-8"), "child content\n");
    assert.equal(readFileSync(join(repo, "item", "keep.ignored"), "utf-8"), "ignored child\n");

    // Also verify empty-subdir collision is caught in preflight before deleting item/child.txt.
    rmSync(join(repo, "item", "keep.ignored"));
    mkdirSync(join(repo, "item", "empty-sub"), { recursive: true });
    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(harness.notifications.at(-1)!.level, "error");
    assert.match(harness.notifications.at(-1)!.msg, /preserved\/ignored.*item\/empty-sub\//);
    assert.equal(readFileSync(join(repo, "item", "child.txt"), "utf-8"), "child content\n");
  });

  it("rolls back deletions, partially overwritten files, and newly created files if checkout-index fails mid-restore, and reports rollback failures", async () => {
    const repo = initRepo(makeTempDir("pi-snap-rollback-"));
    writeFileSync(join(repo, "deleted-in-turn.txt"), "will be re-added by undo\n");
    git(repo, ["add", "deleted-in-turn.txt"]);
    git(repo, ["commit", "-q", "-m", "add deleted-in-turn"]);

    const preTree = await captureShadowTree(repo);
    assert.ok(preTree);

    writeFileSync(join(repo, "README.md"), "# mutated\n");
    rmSync(join(repo, "deleted-in-turn.txt"));
    writeFileSync(join(repo, "added-in-turn.txt"), "keep on rollback\n");
    const postTree = await captureShadowTree(repo);
    assert.ok(postTree);

    // Simulate checkout-index partially overwriting README.md and creating deleted-in-turn.txt before failing.
    let failOnceDone = false;
    const partialCheckoutGit: typeof runGitAsync = async (args, cwd, env, timeoutMs, input) => {
      if (args[0] === "checkout-index" && env?.GIT_INDEX_FILE && !failOnceDone) {
        failOnceDone = true;
        writeFileSync(join(repo, "README.md"), "# partially overwritten by failed checkout\n");
        writeFileSync(join(repo, "deleted-in-turn.txt"), "partially created by failed checkout\n");
        return { stdout: "", stderr: "simulated partial checkout failure", code: 1 };
      }
      return runGitAsync(args, cwd, env, timeoutMs, input);
    };

    const res = await restoreShadowTree(repo, postTree, preTree, { runGit: partialCheckoutGit });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Failed to restore files/);
    assert.doesNotMatch(res.error ?? "", /rollback failed/);
    assert.equal(
      readFileSync(join(repo, "added-in-turn.txt"), "utf-8"),
      "keep on rollback\n",
      "removed file must be rolled back when checkout fails",
    );
    assert.equal(
      readFileSync(join(repo, "README.md"), "utf-8"),
      "# mutated\n",
      "partially overwritten file must be rolled back to expectedTree",
    );
    assert.equal(
      existsSync(join(repo, "deleted-in-turn.txt")),
      false,
      "partially created file absent from expectedTree must be removed on rollback",
    );

    // Also verify rollback failure is surfaced explicitly in the returned error.
    const doubleFailGit: typeof runGitAsync = async (args, cwd, env, timeoutMs, input) => {
      if (args[0] === "checkout-index" && env?.GIT_INDEX_FILE) {
        return { stdout: "", stderr: "checkout always fails", code: 1 };
      }
      return runGitAsync(args, cwd, env, timeoutMs, input);
    };
    const res2 = await restoreShadowTree(repo, postTree, preTree, { runGit: doubleFailGit });
    assert.equal(res2.ok, false);
    assert.match(res2.error ?? "", /Failed to restore files.*rollback failed: rollback git checkout-index failed/);
  });

  it("refuses to record an undo entry if post-turn diff fails when pre-turn ignored files exist", async () => {
    const repo = initRepo(makeTempDir("pi-snap-diff-fail-"));
    writeFileSync(join(repo, "secret.ignored"), "must never be unlinked\n");

    const failingDiffGit: typeof runGitAsync = async (args, cwd, env, timeoutMs, input) => {
      if (args[0] === "diff-tree") {
        return { stdout: "", stderr: "simulated diff-tree failure", code: 1 };
      }
      return runGitAsync(args, cwd, env, timeoutMs, input);
    };

    const harness = createHarness();
    registerSnapshots(harness.pi, { runGit: failingDiffGit });
    const ctx = harness.makeCtx(repo);

    await runTurn(harness, ctx, "Remove ignore rule", "edit", () => {
      writeFileSync(join(repo, ".gitignore"), ".env\n.pi/\n");
    });

    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0]!.level, "warning");
    assert.match(harness.notifications[0]!.msg, /Post-turn snapshot capture failed/);

    // No undo entry should have been recorded, and secret.ignored must stay intact.
    await harness.commands.get("undo")!.handler("", ctx);
    assert.match(harness.notifications.at(-1)!.msg, /Nothing to undo.*last snapshot capture failed/);
    assert.equal(readFileSync(join(repo, "secret.ignored"), "utf-8"), "must never be unlinked\n");
  });

  it("rejects symlinked parent directories pointing outside the repository before delete or checkout", async () => {
    const outsideDir = makeTempDir("pi-snap-outside-");
    const outsideTarget = join(outsideDir, "victim.txt");
    writeFileSync(outsideTarget, "DO NOT DELETE OR OVERWRITE\n");

    const repo = initRepo(makeTempDir("pi-snap-symlink-"));
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "victim.txt"), "in-repo-before\n");
    git(repo, ["add", "sub/victim.txt"]);
    git(repo, ["commit", "-q", "-m", "add sub/victim"]);

    const preTree = await captureShadowTree(repo);
    assert.ok(preTree);
    writeFileSync(join(repo, "sub", "victim.txt"), "in-repo-after\n");
    writeFileSync(join(repo, "sub", "extra.txt"), "added\n");
    const postTree = await captureShadowTree(repo);
    assert.ok(postTree);

    // Swap `sub` directory with a symlink pointing outside the repo AFTER capture!
    rmSync(join(repo, "sub"), { recursive: true, force: true });
    symlinkSync(outsideDir, join(repo, "sub"));

    const res = await restoreShadowTree(repo, postTree, preTree);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /symlinked parent directory|Conflicting changes/i);
    assert.equal(readFileSync(outsideTarget, "utf-8"), "DO NOT DELETE OR OVERWRITE\n");

    // Also verify symlink rejection even when drift check is bypassed by simulating swap right after capture:
    const repo2 = initRepo(makeTempDir("pi-snap-symlink-race-"));
    const pre2 = await captureShadowTree(repo2);
    assert.ok(pre2);
    mkdirSync(join(repo2, "dir"), { recursive: true });
    writeFileSync(join(repo2, "dir", "victim.txt"), "temp\n");
    const post2 = await captureShadowTree(repo2);
    assert.ok(post2);

    let swapped = false;
    const raceGit: typeof runGitAsync = async (args, cwd, env, timeoutMs, input) => {
      const r = await runGitAsync(args, cwd, env, timeoutMs, input);
      // Swap `dir` for symlink to outsideDir right after current-tree write-tree completes.
      if (!swapped && args[0] === "write-tree") {
        swapped = true;
        rmSync(join(repo2, "dir"), { recursive: true, force: true });
        symlinkSync(outsideDir, join(repo2, "dir"));
      }
      return r;
    };

    const res2 = await restoreShadowTree(repo2, post2, pre2, { runGit: raceGit });
    assert.equal(res2.ok, false);
    assert.match(res2.error ?? "", /Refused symlinked parent directory: dir/);
    assert.equal(readFileSync(outsideTarget, "utf-8"), "DO NOT DELETE OR OVERWRITE\n");
  });

  it("supports configurable timeout and warns visibly when pre-turn snapshot capture fails", async () => {
    assert.equal(resolveSnapshotTimeoutMs(), DEFAULT_SNAPSHOT_TIMEOUT_MS);
    process.env.PI_TURN_SNAPSHOTS_TIMEOUT_MS = "45000";
    assert.equal(resolveSnapshotTimeoutMs(), 45_000);
    assert.equal(resolveSnapshotTimeoutMs(12_000), 12_000);

    const repo = initRepo(makeTempDir("pi-snap-timeout-"));
    const timingOutGit: typeof runGitAsync = async (args, cwd, env, timeoutMs, input) => {
      if (args[0] === "add") {
        return { stdout: "", stderr: "", code: 1, timedOut: true };
      }
      return runGitAsync(args, cwd, env, timeoutMs, input);
    };

    const harness = createHarness();
    registerSnapshots(harness.pi, { timeoutMs: 2500, runGit: timingOutGit });
    const ctx = harness.makeCtx(repo);

    await runTurn(harness, ctx, "Large repo edit", "edit", () => {
      writeFileSync(join(repo, "README.md"), "# edited\n");
    });

    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0]!.level, "warning");
    assert.match(harness.notifications[0]!.msg, /Turn snapshot capture failed.*timed out after 2500ms/);

    await harness.commands.get("undo")!.handler("", ctx);
    assert.match(harness.notifications.at(-1)!.msg, /last snapshot capture failed: git add -A timed out/);
  });

  it("read-only turns and unchanged bash turns push nothing and preserve redo stack", async () => {
    const repo = initRepo(makeTempDir("pi-snap-noop-"));
    const harness = createHarness();
    registerSnapshots(harness.pi);
    const ctx = harness.makeCtx(repo);

    await runTurn(harness, ctx, "Read file", "read", () => {});
    await harness.commands.get("undo")!.handler("", ctx);
    assert.match(harness.notifications.at(-1)!.msg, /Nothing to undo/);

    await runTurn(harness, ctx, "Mutate", "edit", () => {
      writeFileSync(join(repo, "README.md"), "# mutated\n");
    });
    await harness.commands.get("undo")!.handler("", ctx);

    await runTurn(harness, ctx, "Inspect status", "bash", () => {});
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
      await runTurn(harness, ctx, `Turn ${i}`, "write", () => {
        writeFileSync(join(repo, "counter.txt"), `${i}\n`);
      });
    }

    for (let i = 0; i < 20; i++) {
      await harness.commands.get("undo")!.handler("", ctx);
    }
    assert.equal(readFileSync(join(repo, "counter.txt"), "utf-8"), "2\n");

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

    await runTurn(harness, ctx, "Edit while disabled", "write", () => {
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

    await runTurn(harness, ctx, "Edit outside git", "write", () => {
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

    await runTurn(harness, ctx, "Create spaced file", "write", () => {
      writeFileSync(join(subDir, "my file.txt"), "hello spaces\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(existsSync(join(subDir, "my file.txt")), false);

    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(readFileSync(join(subDir, "my file.txt"), "utf-8"), "hello spaces\n");
  });

  it("cleans up temporary GIT_INDEX_FILE directories unconditionally", async () => {
    const repo = initRepo(makeTempDir("pi-snap-cleanup-"));
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("pi-snapshot-")));

    const tree1 = await captureShadowTree(repo);
    assert.ok(tree1);
    writeFileSync(join(repo, "README.md"), "# temp\n");
    const tree2 = await captureShadowTree(repo);
    assert.ok(tree2);
    const res = await restoreShadowTree(repo, tree2, tree1);
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

    await harness.emit("before_agent_start", { prompt: "Multi-step turn", messageType: "user" }, ctx);
    await harness.emit("tool_call", { toolName: "write" }, ctx);
    writeFileSync(join(repo, "a.txt"), "a\n");
    await harness.emit("tool_call", { toolName: "edit" }, ctx);
    writeFileSync(join(repo, "README.md"), "# multi\n");
    await harness.emit("tool_call", { toolName: "bash" }, ctx);
    writeFileSync(join(repo, "b.txt"), "b\n");
    await harness.emit("agent_end", {}, ctx);

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

    await runTurn(harness, ctx, "Replace file with dir", "bash", () => {
      rmSync(join(repo, "item"));
      mkdirSync(join(repo, "item"), { recursive: true });
      writeFileSync(join(repo, "item", "child.txt"), "dir-version\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "item"), "utf-8"), "file-version\n");

    await harness.commands.get("redo")!.handler("", ctx);
    assert.equal(readFileSync(join(repo, "item", "child.txt"), "utf-8"), "dir-version\n");

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

    await runTurn(harness, ctx, "Headless edit", "write", () => {
      writeFileSync(join(repo, "README.md"), "# headless\n");
    });

    await harness.commands.get("undo")!.handler("", ctx);
    assert.equal(harness.notifications.length, 0);
    assert.equal(harness.messages.length, 1);
    assert.equal(harness.messages[0]!.customType, "snapshots");
    assert.match(harness.messages[0]!.content, /Undid turn: "Headless edit"/);
  });
});
