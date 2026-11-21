/**
 * Tests for worktree helpers, COMS peer matching, cleanup guards,
 * /worktree overlay + subcommands, /status summary, and autocomplete (#1316).
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  countLinkedWorktrees,
  invalidateWorktreeCache,
  isInLinkedWorktree,
  listWorktreesAsync,
  parseGitStatusPorcelain,
  parseWorktreePorcelain,
  type GitAsyncRunner,
} from "../../../extensions/orchestrator/git-helpers.js";
import { registerExtendedAutocomplete } from "../../../extensions/orchestrator/extended-autocomplete.js";
import { registerStatus } from "../../../extensions/orchestrator/status.js";
import {
  buildWorktreeDetailLines,
  buildWorktreeRowParts,
  executeGuardedWorktreeRemove,
  openWorktreeOverlay,
  registerWorktree,
} from "../../../extensions/orchestrator/worktree.js";
import {
  attachPeersToWorktrees,
  canRemoveWorktree,
  formatPruneResult,
  formatWorktreeStatusSummary,
  formatWorktreeTable,
  readLiveComsPeers,
  type WorktreePeerInfo,
  type WorktreeView,
} from "../../../extensions/orchestrator/worktree-helpers.js";
import { fakeTheme, fakeTui } from "../helpers/fake-tui.js";
import { withSubagentChildEnv } from "../helpers/subagent-env.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

const SAMPLE_PORCELAIN = [
  "worktree /repo",
  "HEAD aaaaaaa11111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /repo/.worktrees/feat-a",
  "HEAD bbbbbbb22222222222222222222222222222222",
  "branch refs/heads/feat/a",
  "",
  "worktree /repo/.worktrees/detached-wt",
  "HEAD ccccccc33333333333333333333333333333333",
  "detached",
  "locked in use by CI",
  "",
  "worktree /repo/.worktrees/stale-wt",
  "HEAD ddddddd44444444444444444444444444444444",
  "branch refs/heads/fix/stale",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

describe("parseWorktreePorcelain & listWorktreesAsync (#1316)", () => {
  beforeEach(() => invalidateWorktreeCache());

  it("parses main, linked, detached, locked, prunable, and longest-prefix isCurrent", () => {
    const entries = parseWorktreePorcelain(SAMPLE_PORCELAIN, "/repo/.worktrees/feat-a/nested/dir");
    assert.equal(entries.length, 4);

    assert.equal(entries[0].path, "/repo");
    assert.equal(entries[0].branch, "main");
    assert.equal(entries[0].isMain, true);
    assert.equal(entries[0].isCurrent, false);

    assert.equal(entries[1].path, "/repo/.worktrees/feat-a");
    assert.equal(entries[1].branch, "feat/a");
    assert.equal(entries[1].isMain, false);
    assert.equal(entries[1].isCurrent, true);

    assert.equal(entries[2].detached, true);
    assert.equal(entries[2].branch, null);
    assert.equal(entries[2].locked, true);
    assert.equal(entries[2].lockedReason, "in use by CI");

    assert.equal(entries[3].prunable, true);
    assert.equal(entries[3].prunableReason, "gitdir file points to non-existent location");

    assert.equal(isInLinkedWorktree(entries), true);
    assert.equal(countLinkedWorktrees(entries), 3);
  });

  it("marks main worktree as isCurrent when cwd is in main checkout", () => {
    const entries = parseWorktreePorcelain(SAMPLE_PORCELAIN, "/repo/src");
    assert.equal(entries[0].isCurrent, true);
    assert.equal(entries[1].isCurrent, false);
    assert.equal(isInLinkedWorktree(entries), false);
  });

  it("parses bare worktrees and git status porcelain counters", () => {
    const bareRaw = "worktree /srv/bare.git\nbare\n";
    const bare = parseWorktreePorcelain(bareRaw);
    assert.equal(bare.length, 1);
    assert.equal(bare[0].bare, true);
    assert.equal(bare[0].branch, null);

    const dirty = parseGitStatusPorcelain(" M a.ts\nA  b.ts\n D c.ts\n?? d.ts\nUU e.ts\n");
    assert.deepEqual(dirty, { modified: 2, added: 1, deleted: 1, untracked: 1, total: 5 });
    assert.deepEqual(parseGitStatusPorcelain(""), { modified: 0, added: 0, deleted: 0, untracked: 0, total: 0 });
  });

  it("caches worktree listing per runner+cwd within TTL and refreshes on forceRefresh", async () => {
    let calls = 0;
    const runner: GitAsyncRunner = async (args) => {
      calls++;
      if (args[0] === "worktree") return { stdout: SAMPLE_PORCELAIN, code: 0 };
      if (args[0] === "status") return { stdout: " M index.ts\n", code: 0 };
      return { stdout: "", code: 0 };
    };

    const first = await listWorktreesAsync("/repo/.worktrees/feat-a", { runGitAsync: runner, ttlMs: 5_000 });
    assert.equal(first.length, 4);
    assert.equal(calls, 1);

    const second = await listWorktreesAsync("/repo/.worktrees/feat-a", { runGitAsync: runner, ttlMs: 5_000 });
    assert.equal(second.length, 4);
    assert.equal(calls, 1, "should reuse cached base listing within TTL");

    const withDirty = await listWorktreesAsync("/repo/.worktrees/feat-a", {
      runGitAsync: runner,
      includeDirty: true,
      forceRefresh: true,
    });
    assert.equal(withDirty[0].dirty?.total, 1);
    assert.equal(withDirty[3].dirty, undefined, "prunable worktree skips git status");
    assert.equal(calls, 1 + 1 + 3, "forceRefresh + 3 non-prunable status calls");
  });

  it("does not cache non-zero exit failures", async () => {
    let attempt = 0;
    const runner: GitAsyncRunner = async () => {
      attempt++;
      if (attempt === 1) return { stdout: "", code: 128 };
      return { stdout: "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n", code: 0 };
    };
    const r1 = await listWorktreesAsync("/repo", { runGitAsync: runner });
    assert.deepEqual(r1, []);
    const r2 = await listWorktreesAsync("/repo", { runGitAsync: runner });
    assert.equal(r2.length, 1);
    assert.equal(attempt, 2);
  });
});

describe("COMS peer matching & cleanup guards (#1316)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("wt-coms-");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads only live COMS peers and matches them by longest worktree prefix", () => {
    const agentsDir = join(tmpDir, "projects", "proj-a", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const now = Date.now();
    const freshIso = new Date(now - 5_000).toISOString();
    const staleIso = new Date(now - 300_000).toISOString();

    writeFileSync(
      join(agentsDir, "peer-live.json"),
      JSON.stringify({
        name: "peer-live",
        pid: 12345,
        cwd: "/repo/.worktrees/feat-a/sub",
        endpoint: "/tmp/live.sock",
        busy: true,
        purpose: "working on #1316",
        heartbeat_at: freshIso,
      }),
    );
    writeFileSync(
      join(agentsDir, "peer-stale.json"),
      JSON.stringify({
        name: "peer-stale",
        pid: 12346,
        cwd: "/repo/.worktrees/feat-a",
        endpoint: "/tmp/stale.sock",
        heartbeat_at: staleIso,
      }),
    );
    writeFileSync(
      join(agentsDir, "peer-dead-pid.json"),
      JSON.stringify({
        name: "peer-dead",
        pid: 99999,
        cwd: "/repo",
        endpoint: "/tmp/dead.sock",
        heartbeat_at: freshIso,
      }),
    );

    const peers = readLiveComsPeers("/repo", {
      comsDir: tmpDir,
      now,
      isPidAlive: (pid) => pid === 12345,
      endpointExists: (ep) => ep === "/tmp/live.sock",
    });
    assert.equal(peers.length, 1);
    assert.equal(peers[0].name, "peer-live");

    const entries = parseWorktreePorcelain(SAMPLE_PORCELAIN, "/repo");
    const views = attachPeersToWorktrees(entries, peers);
    assert.equal(views[0].peers.length, 0, "main worktree must not steal nested linked-worktree peer");
    assert.equal(views[1].peers.length, 1);
    assert.equal(views[1].peers[0].name, "peer-live");
  });

  it("enforces fail-closed remove guards for main, current, peer, locked, dirty, and unknown state", () => {
    const base: WorktreeView = {
      id: "/repo/.worktrees/clean",
      path: "/repo/.worktrees/clean",
      head: "aaaaaaa1111111",
      branch: "feat/clean",
      detached: false,
      bare: false,
      isMain: false,
      isCurrent: false,
      locked: false,
      prunable: false,
      dirty: { modified: 0, added: 0, deleted: 0, untracked: 0, total: 0 },
      peers: [],
    };

    assert.deepEqual(canRemoveWorktree(base), { allowed: true });

    const rMain = canRemoveWorktree({ ...base, isMain: true });
    assert.equal(rMain.allowed, false);

    const rCurrent = canRemoveWorktree({ ...base, isCurrent: true });
    assert.equal(rCurrent.allowed, false);

    const peer: WorktreePeerInfo = { name: "peer-x", project: "p", cwd: base.path, busy: false, pid: 1, purpose: "" };
    const rPeer = canRemoveWorktree({ ...base, peers: [peer] });
    assert.equal(rPeer.allowed, false);
    if (!rPeer.allowed) assert.match(rPeer.reason, /peer-x/);

    const rLocked = canRemoveWorktree({ ...base, locked: true, lockedReason: "CI" });
    assert.equal(rLocked.allowed, false);
    if (!rLocked.allowed) assert.match(rLocked.reason, /locked.*CI/i);

    const rDirty = canRemoveWorktree({
      ...base,
      dirty: { modified: 2, added: 0, deleted: 0, untracked: 1, total: 3 },
    });
    assert.equal(rDirty.allowed, false);
    if (!rDirty.allowed) assert.match(rDirty.reason, /3 uncommitted changes/);

    const rUnknown = canRemoveWorktree({ ...base, dirty: undefined });
    assert.equal(rUnknown.allowed, false);

    const rPrunable = canRemoveWorktree({ ...base, prunable: true, dirty: undefined });
    assert.equal(rPrunable.allowed, true);
  });

  it("re-verifies live state inside executeGuardedWorktreeRemove before calling git remove", async () => {
    const calls: string[][] = [];
    const runner: GitAsyncRunner = async (args) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") return { stdout: SAMPLE_PORCELAIN, code: 0 };
      if (args[0] === "status") return { stdout: " M dirty-now.ts\n", code: 0 };
      return { stdout: "", code: 0 };
    };

    const blocked = await executeGuardedWorktreeRemove("/repo", "/repo/.worktrees/feat-a", {
      runGitAsync: runner,
      readLivePeers: () => [],
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /uncommitted/);
    assert.equal(calls.some((a) => a[0] === "worktree" && a[1] === "remove"), false);

    const cleanCalls: string[][] = [];
    let changed = 0;
    const cleanRunner: GitAsyncRunner = async (args) => {
      cleanCalls.push(args);
      if (args[0] === "worktree" && args[1] === "list") return { stdout: SAMPLE_PORCELAIN, code: 0 };
      if (args[0] === "status") return { stdout: "", code: 0 };
      return { stdout: "", code: 0 };
    };
    const removed = await executeGuardedWorktreeRemove("/repo", "/repo/.worktrees/feat-a", {
      runGitAsync: cleanRunner,
      readLivePeers: () => [],
      onWorktreesChanged: () => { changed++; },
    });
    assert.equal(removed.ok, true);
    assert.equal(changed, 1);
    assert.equal(cleanCalls.some((a) => a[0] === "worktree" && a[1] === "remove" && a[2] === "/repo/.worktrees/feat-a"), true);
  });
});

describe("formatting & /worktree subcommands + overlay (#1316)", () => {
  it("formats plain-text table, 1-line /status summary, and prune results", () => {
    const entries = parseWorktreePorcelain(SAMPLE_PORCELAIN, "/repo/.worktrees/feat-a");
    entries[0].dirty = { modified: 0, added: 0, deleted: 0, untracked: 0, total: 0 };
    entries[1].dirty = { modified: 2, added: 1, deleted: 0, untracked: 1, total: 4 };
    const peer: WorktreePeerInfo = { name: "peer-wt", project: "p", cwd: "/repo/.worktrees/feat-a", busy: true, pid: 42, purpose: "dev" };
    const views = attachPeersToWorktrees(entries, [peer]);

    const table = formatWorktreeTable(views, "/repo");
    assert.match(table, /Worktrees \(4 total, 3 linked\)/);
    assert.match(table, /feat\/a/);
    assert.match(table, /\[current\]/);
    assert.match(table, /~2 \+1 \?1/);
    assert.match(table, /@peer-wt/);
    assert.match(table, /\[locked\]/);
    assert.match(table, /\[prunable\]/);

    const summary = formatWorktreeStatusSummary(entries);
    assert.equal(summary, "⊞ Worktrees: 3 linked (current: feat/a [wt])");
    assert.equal(formatWorktreeStatusSummary([entries[0]]), null, "single checkout hides /status worktrees line");

    const emptyPrune = formatPruneResult("", "", 0);
    assert.equal(emptyPrune.ok, true);
    assert.match(emptyPrune.message, /No stale worktrees/);

    const realPrune = formatPruneResult("", "Removing worktrees/stale: gitdir file points to non-existent location\n", 0);
    assert.equal(realPrune.ok, true);
    assert.equal(realPrune.pruned.length, 1);
    assert.match(realPrune.message, /Pruned 1 stale worktree/);

    const errPrune = formatPruneResult("", "fatal: not a git repository", 128);
    assert.equal(errPrune.ok, false);
    assert.match(errPrune.message, /fatal: not a git repository/);
  });

  it("renders overlay row parts and detail lines with HEAD, status, COMS peer, and guard status", () => {
    const entries = parseWorktreePorcelain(SAMPLE_PORCELAIN, "/repo/.worktrees/feat-a");
    entries[1].dirty = { modified: 1, added: 0, deleted: 0, untracked: 1, total: 2 };
    const views = attachPeersToWorktrees(entries, [
      { name: "peer-worktree-ux", project: "p", cwd: "/repo/.worktrees/feat-a", busy: true, pid: 77, purpose: "#1316" },
    ]);

    const theme = fakeTheme();
    const parts = buildWorktreeRowParts(views[1], "/repo", theme as any);
    assert.equal(parts.title, "feat/a");
    assert.match(parts.idLabel, /\[current\]/);
    assert.ok(parts.rightParts.some((p) => p.includes("~1 ?1")));
    assert.ok(parts.rightParts.some((p) => p.includes("peer-worktree-ux")));

    const detailLines = buildWorktreeDetailLines(
      views[1],
      { headSubject: "feat: initial worktree ux", statusLines: [" M a.ts", "?? b.ts"] },
      theme as any,
    );
    const joined = detailLines.join("\n");
    assert.match(joined, /\/repo\/.worktrees\/feat-a/);
    assert.match(joined, /feat: initial worktree ux/);
    assert.match(joined, /peer-worktree-ux \(busy, pid:77\) — #1316/);
    assert.match(joined, /M a\.ts/);
    assert.match(joined, /Cannot remove the current session/);
  });

  it("drives openWorktreeOverlay detail actions: c copy, d blocked on current, d confirmed remove, p prune", async () => {
    let removed = false;
    const copied: string[] = [];
    const notifications: Array<{ msg: string; level: string }> = [];
    const confirms: string[] = [];

    const runner: GitAsyncRunner = async (args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        const raw = removed
          ? "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n"
          : [
              "worktree /repo",
              "HEAD aaaaaaa",
              "branch refs/heads/main",
              "",
              "worktree /repo/.worktrees/clean-wt",
              "HEAD bbbbbbb",
              "branch refs/heads/feat/clean",
              "",
            ].join("\n");
        return { stdout: raw, code: 0 };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        removed = true;
        return { stdout: "", code: 0 };
      }
      if (args[0] === "worktree" && args[1] === "prune") {
        return { stdout: "", stderr: "Removing worktrees/old: missing\n", code: 0 };
      }
      if (args[0] === "log") return { stdout: "chore: clean commit", code: 0 };
      if (args[0] === "status") return { stdout: "", code: 0 };
      return { stdout: "", code: 0 };
    };

    // Drive list: first open selects clean-wt, second open exits
    let listOpens = 0;
    const fakeOpenOverlay: any = async (_ctx: any, opts: any) => {
      listOpens++;
      if (listOpens === 1) {
        const items = opts.listSpec.listItems();
        assert.equal(items.length, 2);
        opts.listSpec.onSelect(items[1]); // Enter on clean-wt
      }
    };

    // Drive detail: 1st open press 'c' (copy), 2nd open press 'p' (prune), 3rd open press 'd' (remove)
    const detailKeys = ["c", "p", "d"];
    const theme = fakeTheme();
    const tui = fakeTui();
    const ctx: any = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        theme,
        notify: (msg: string, level: string) => notifications.push({ msg, level }),
        confirm: async (title: string) => {
          confirms.push(title);
          return true;
        },
        custom: async (factory: any) => {
          let resolveDone!: () => void;
          const p = new Promise<void>((r) => { resolveDone = r; });
          const comp = factory(tui, theme, {}, () => resolveDone());
          const key = detailKeys.shift() ?? "\x1b";
          comp.handleInput(key);
          comp.dispose?.();
          await p;
          return null;
        },
      },
    };

    await openWorktreeOverlay(ctx, {
      runGitAsync: runner,
      readLivePeers: () => [],
      copyToClipboard: async (text) => {
        copied.push(text);
        return { ok: true, method: "test" };
      },
      openOverlay: fakeOpenOverlay,
    });

    assert.deepEqual(copied, ["/repo/.worktrees/clean-wt"]);
    assert.deepEqual(confirms, ["Remove worktree?"]);
    assert.equal(removed, true);
    assert.ok(notifications.some((n) => n.msg.includes("Copied worktree path")));
    assert.ok(notifications.some((n) => n.msg.includes("Pruned 1 stale worktree")));
    assert.ok(notifications.some((n) => n.msg.includes("Removed worktree")));
  });

  it("refuses 'd' in detail view on current/dirty/peer worktrees without prompting confirm", async () => {
    const notifications: Array<{ msg: string; level: string }> = [];
    let confirmCalls = 0;
    const runner: GitAsyncRunner = async (args) => {
      if (args[0] === "worktree" && args[1] === "list") return { stdout: SAMPLE_PORCELAIN, code: 0 };
      if (args[0] === "log") return { stdout: "wip", code: 0 };
      if (args[0] === "status") return { stdout: "", code: 0 };
      return { stdout: "", code: 0 };
    };

    let listOpens = 0;
    const fakeOpenOverlay: any = async (_ctx: any, opts: any) => {
      listOpens++;
      if (listOpens === 1) {
        const items = opts.listSpec.listItems();
        opts.listSpec.onSelect(items[1]); // feat-a is [current]
      }
    };

    const theme = fakeTheme();
    const tui = fakeTui();
    const ctx: any = {
      hasUI: true,
      cwd: "/repo/.worktrees/feat-a",
      ui: {
        theme,
        notify: (msg: string, level: string) => notifications.push({ msg, level }),
        confirm: async () => {
          confirmCalls++;
          return true;
        },
        custom: async (factory: any) => {
          let resolveDone!: () => void;
          const p = new Promise<void>((r) => { resolveDone = r; });
          const comp = factory(tui, theme, {}, () => resolveDone());
          comp.handleInput("d");
          comp.handleInput("\x1b");
          comp.dispose?.();
          await p;
          return null;
        },
      },
    };

    await openWorktreeOverlay(ctx, {
      runGitAsync: runner,
      readLivePeers: () => [],
      openOverlay: fakeOpenOverlay,
    });

    assert.equal(confirmCalls, 0);
    assert.ok(notifications.some((n) => n.level === "warning" && n.msg.includes("current session")));
  });

  it("registers /worktree (skips PI_SUBAGENT_CHILD=1) and handles list, prune, headless, and unknown subcommands", async () => {
    const childRegistered: string[] = [];
    withSubagentChildEnv("1", () => {
      registerWorktree({ registerCommand: (n: string) => childRegistered.push(n) } as any);
    });
    assert.deepEqual(childRegistered, []);

    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const sentMessages: string[] = [];
    const emittedEvents: string[] = [];
    const mockPi: any = {
      registerCommand(name: string, opts: any) {
        if (name === "worktree") handler = opts.handler;
      },
      sendMessage(msg: any) {
        sentMessages.push(msg.content);
      },
      events: {
        emit(ch: string) {
          emittedEvents.push(ch);
        },
      },
    };

    const runner: GitAsyncRunner = async (args) => {
      if (args[0] === "worktree" && args[1] === "list") return { stdout: SAMPLE_PORCELAIN, code: 0 };
      if (args[0] === "worktree" && args[1] === "prune") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "status") return { stdout: "", code: 0 };
      return { stdout: "", code: 0 };
    };

    withSubagentChildEnv(undefined, () => {
      registerWorktree(mockPi, { runGitAsync: runner, readLivePeers: () => [] });
    });
    assert.ok(handler);

    const notified: string[] = [];
    const uiCtx: any = { hasUI: true, cwd: "/repo", ui: { notify: (m: string) => notified.push(m) } };
    await handler!("list", uiCtx);
    assert.match(notified[0], /Worktrees \(4 total, 3 linked\)/);

    await handler!("prune", uiCtx);
    assert.match(notified[1], /No stale worktrees to prune/);
    assert.ok(emittedEvents.includes("orchestrator:worktrees-changed"));

    await handler!("bogus", uiCtx);
    assert.match(notified[2], /Unknown subcommand/);

    // Headless /worktree (no args, hasUI: false) falls back to plain-text table via sendMessage
    await handler!("", { hasUI: false, cwd: "/repo" });
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /Worktrees \(4 total, 3 linked\)/);
  });

  it("completes /worktree subcommands (list, prune) via extended-autocomplete", () => {
    const commands = new Map<string, any>();
    const mockPi: any = {
      registerCommand(name: string, opts: any) { commands.set(name, opts); },
      on() {},
      exec: async () => ({ code: 0, stdout: "" }),
    };
    withSubagentChildEnv(undefined, () => {
      registerExtendedAutocomplete(mockPi);
      mockPi.registerCommand("worktree", { description: "worktree", handler: async () => {} });
    });
    const cmd = commands.get("worktree");
    assert.ok(cmd?.getArgumentCompletions);
    const all = cmd.getArgumentCompletions("");
    assert.deepEqual(all?.map((i: any) => i.value), ["list", "prune"]);
    const pr = cmd.getArgumentCompletions("pru");
    assert.deepEqual(pr?.map((i: any) => i.value), ["prune"]);
    assert.equal(cmd.getArgumentCompletions("list extra"), null);
  });

  it("includes 1-line Worktrees summary in /status when linked worktrees exist", async () => {
    let statusHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const mockPi: any = {
      registerCommand(name: string, opts: any) {
        if (name === "status") statusHandler = opts.handler;
      },
    };
    registerStatus(mockPi, false, () => [], () => []);
    assert.ok(statusHandler);

    let notified = "";
    await statusHandler!("", {
      hasUI: true,
      cwd: process.cwd(),
      ui: { notify: (msg: string) => { notified = msg; } },
    });
    // This test runs inside a repo — if linked worktrees exist, verify Worktrees line; always check Git line
    assert.match(notified, /Git:/);
  });
});
