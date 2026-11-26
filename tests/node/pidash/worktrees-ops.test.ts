/**
 * #1427 — Unit tests for PiDash backend worktree operations (`extensions/pidash/browser-ops.ts`)
 * and session-state worktree summary persistence (`scripts/pidash-session-state.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitAsyncRunner } from "../../../extensions/orchestrator/git-helpers.ts";
import type { WorktreePeerInfo } from "../../../extensions/orchestrator/worktree-helpers.ts";
import {
  MAX_WORKTREE_STATUS_LINES,
  getWorktreeSummary,
  loadWorktreeDetailPayload,
  loadWorktreesPayload,
  pruneWorktreesOp,
  removeWorktreesOp,
  worktreeSummaryEqual,
} from "../../../extensions/pidash/browser-ops.ts";
import {
  authorizeWorktreeBrowserCommand,
  buildWorktreeCommandErrorFrame,
  createPidashSessionState,
  shouldNotifyWorktreeChange,
  updatePidashSession,
} from "../../../scripts/pidash-session-state.ts";
import { makeTempDir } from "../helpers/temp-dirs.js";

const REPO_MAIN = "/repo";
const WT_CLEAN = "/repo/.worktrees/feat-clean";
const WT_DIRTY = "/repo/.worktrees/feat-dirty";
const WT_PEER = "/repo/.worktrees/feat-peer";
const WT_LOCKED = "/repo/.worktrees/feat-locked";

const SAMPLE_PORCELAIN = [
  `worktree ${REPO_MAIN}`,
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  `worktree ${WT_CLEAN}`,
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/feat/clean",
  "",
  `worktree ${WT_DIRTY}`,
  "HEAD 3333333333333333333333333333333333333333",
  "branch refs/heads/feat/dirty",
  "",
  `worktree ${WT_PEER}`,
  "HEAD 4444444444444444444444444444444444444444",
  "branch refs/heads/feat/peer",
  "",
  `worktree ${WT_LOCKED}`,
  "HEAD 5555555555555555555555555555555555555555",
  "branch refs/heads/feat/locked",
  "locked in use",
  "",
].join("\n");

function makeMockGit(opts: {
  porcelain?: string;
  dirtyByPath?: Record<string, string>;
  logByPath?: Record<string, string>;
  statusShortByPath?: Record<string, string>;
  removeCalls?: string[];
  pruneOutput?: { stdout: string; stderr?: string; code: number };
} = {}): GitAsyncRunner {
  const porcelain = opts.porcelain ?? SAMPLE_PORCELAIN;
  const dirtyByPath = opts.dirtyByPath ?? {
    [REPO_MAIN]: "",
    [WT_CLEAN]: "",
    [WT_DIRTY]: " M src/app.ts\n?? new.txt\n",
    [WT_PEER]: "",
    [WT_LOCKED]: "",
  };
  return async (args: string[], cwd?: string) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return { stdout: porcelain, stderr: "", code: 0 };
    }
    if (args[0] === "status" && args[1] === "--porcelain") {
      return { stdout: dirtyByPath[cwd ?? ""] ?? "", stderr: "", code: 0 };
    }
    if (args[0] === "status" && args[1] === "--short") {
      const out = opts.statusShortByPath?.[cwd ?? ""] ?? dirtyByPath[cwd ?? ""] ?? "";
      return { stdout: out, stderr: "", code: 0 };
    }
    if (args[0] === "log" && args[1] === "-1") {
      return { stdout: opts.logByPath?.[cwd ?? ""] ?? "feat: sample commit", stderr: "", code: 0 };
    }
    if (args[0] === "worktree" && args[1] === "prune") {
      return opts.pruneOutput ?? { stdout: "Removing worktrees/stale: gitdir file points to non-existent location", stderr: "", code: 0 };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      opts.removeCalls?.push(args[2] ?? "");
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: `unexpected git args: ${args.join(" ")}`, code: 1 };
  };
}

const ACTIVE_PEER: WorktreePeerInfo = {
  name: "peer-worker",
  project: "repo",
  cwd: WT_PEER,
  busy: true,
  pid: 99999,
  purpose: "implementing feature",
};

describe("browser-ops worktrees (#1427)", () => {
  it("loadWorktreesPayload projects shared TUI worktree views, guards, PR links, and COMS peers", async () => {
    const runGitAsync = makeMockGit();
    const payload = await loadWorktreesPayload(REPO_MAIN, {
      forceRefresh: true,
      deps: {
        runGitAsync,
        readLivePeers: () => [ACTIVE_PEER],
        fetchOpenPrs: async () =>
          new Map([["feat/clean", { number: 1427, url: "https://github.com/myk-org/pi-config/pull/1427" }]]),
      },
    });

    assert.equal(payload.error, undefined);
    assert.equal(payload.repoRoot, REPO_MAIN);
    assert.equal(payload.linkedCount, 4);
    assert.equal(payload.dirtyCount, 1);
    assert.equal(payload.inLinkedWorktree, false);
    assert.equal(payload.worktrees.length, 5);

    const byPath = new Map(payload.worktrees.map((w) => [w.path, w]));

    const mainWt = byPath.get(REPO_MAIN)!;
    assert.equal(mainWt.isMain, true);
    assert.equal(mainWt.isCurrent, true);
    assert.equal(mainWt.canRemove, false);
    assert.match(mainWt.removeBlockedReason!, /main worktree/i);

    const cleanWt = byPath.get(WT_CLEAN)!;
    assert.equal(cleanWt.canRemove, true);
    assert.equal(cleanWt.removeBlockedReason, undefined);
    assert.equal(cleanWt.dirtyText, "clean");
    assert.deepEqual(cleanWt.pr, { number: 1427, url: "https://github.com/myk-org/pi-config/pull/1427" });

    const dirtyWt = byPath.get(WT_DIRTY)!;
    assert.equal(dirtyWt.canRemove, false);
    assert.equal(dirtyWt.dirty?.total, 2);
    assert.match(dirtyWt.removeBlockedReason!, /uncommitted change/i);

    const peerWt = byPath.get(WT_PEER)!;
    assert.equal(peerWt.canRemove, false);
    assert.equal(peerWt.peers.length, 1);
    assert.equal(peerWt.peers[0].name, "peer-worker");
    assert.match(peerWt.removeBlockedReason!, /active COMS peer/i);

    const lockedWt = byPath.get(WT_LOCKED)!;
    assert.equal(lockedWt.canRemove, false);
    assert.match(lockedWt.removeBlockedReason!, /locked/i);
  });

  it("loadWorktreeDetailPayload caps git status --short at 60 lines, scans ONLY the target worktree, and rejects unregistered paths", async () => {
    const manyLines = Array.from({ length: 75 }, (_, i) => ` M file-${i}.ts`).join("\n");
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const baseGit = makeMockGit({
      statusShortByPath: { [WT_DIRTY]: manyLines },
      logByPath: { [WT_DIRTY]: "wip: lots of changes" },
    });
    const runGitAsync: GitAsyncRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return baseGit(args, cwd);
    };

    const detail = await loadWorktreeDetailPayload(REPO_MAIN, WT_DIRTY, {
      runGitAsync,
      readLivePeers: () => [],
    });
    assert.equal(detail.error, undefined);
    assert.equal(detail.statusOk, true);
    assert.equal(detail.headSubject, "wip: lots of changes");
    assert.equal(detail.statusLines.length, MAX_WORKTREE_STATUS_LINES);
    assert.equal(detail.truncatedCount, 15);
    // Must never scan dirty status of sibling worktrees during a single-row detail request
    assert.equal(
      calls.some((c) => c.args[0] === "status" && c.args[1] === "--porcelain"),
      false,
      "detail request must not run git status --porcelain across all worktrees",
    );
    assert.equal(
      calls.filter((c) => c.args[0] === "status" && c.args[1] === "--short").length,
      1,
      "detail request should run git status --short only for the selected worktree",
    );

    const rejected = await loadWorktreeDetailPayload(REPO_MAIN, "/etc/passwd", {
      runGitAsync,
      readLivePeers: () => [],
    });
    assert.equal(rejected.statusOk, false);
    assert.match(rejected.error!, /not found/i);

    const empty = await loadWorktreeDetailPayload(REPO_MAIN, "   ", {
      runGitAsync,
      readLivePeers: () => [],
    });
    assert.equal(empty.statusOk, false);
    assert.match(empty.error!, /required/i);
  });

  it("loadWorktreesPayload and loadWorktreeDetailPayload surface git listing errors distinctly from non-git directories", async () => {
    const failingGit: GitAsyncRunner = async () => ({
      stdout: "",
      stderr: "fatal: unable to access worktree metadata: permission denied",
      code: 128,
    });
    const listErr = await loadWorktreesPayload(REPO_MAIN, {
      forceRefresh: true,
      includePrs: false,
      deps: { runGitAsync: failingGit, readLivePeers: () => [] },
    });
    assert.match(listErr.error!, /permission denied/i);
    assert.equal(listErr.worktrees.length, 0);

    const detailErr = await loadWorktreeDetailPayload(REPO_MAIN, WT_CLEAN, {
      runGitAsync: failingGit,
      readLivePeers: () => [],
    });
    assert.equal(detailErr.statusOk, false);
    assert.match(detailErr.error!, /permission denied/i);

    const nonGit: GitAsyncRunner = async () => ({
      stdout: "",
      stderr: "fatal: not a git repository (or any of the parent directories): .git",
      code: 128,
    });
    const emptyOk = await loadWorktreesPayload("/tmp/not-a-repo", {
      forceRefresh: true,
      includePrs: false,
      deps: { runGitAsync: nonGit, readLivePeers: () => [] },
    });
    assert.equal(emptyOk.error, undefined);
    assert.equal(emptyOk.worktrees.length, 0);
  });

  it("pruneWorktreesOp runs git worktree prune -v and fires onWorktreesChanged", async () => {
    let changed = 0;
    const res = await pruneWorktreesOp(REPO_MAIN, {
      runGitAsync: makeMockGit(),
      onWorktreesChanged: () => { changed++; },
    });
    assert.equal(res.op, "prune");
    assert.equal(res.ok, true);
    assert.equal(res.pruned?.length, 1);
    assert.equal(changed, 1);

    const failed = await pruneWorktreesOp(REPO_MAIN, {
      runGitAsync: makeMockGit({ pruneOutput: { stdout: "", stderr: "permission denied", code: 1 } }),
      onWorktreesChanged: () => { changed++; },
    });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /permission denied/i);
    assert.equal(changed, 1);
  });

  it("removeWorktreesOp strictly enforces main/current/dirty/locked/active-peer/unverified-registry guards server-side", async () => {
    const removeCalls: string[] = [];
    const runGitAsync = makeMockGit({ removeCalls });
    const deps = { runGitAsync, readLivePeers: () => [ACTIVE_PEER] };

    // Main worktree rejected
    const rMain = await removeWorktreesOp(REPO_MAIN, [REPO_MAIN], deps);
    assert.equal(rMain.ok, false);
    assert.match(rMain.message, /main worktree/i);

    // Current linked worktree rejected
    const rCurrent = await removeWorktreesOp(WT_CLEAN, [WT_CLEAN], deps);
    assert.equal(rCurrent.ok, false);
    assert.match(rCurrent.message, /current session/i);

    // Dirty worktree rejected
    const rDirty = await removeWorktreesOp(REPO_MAIN, [WT_DIRTY], deps);
    assert.equal(rDirty.ok, false);
    assert.match(rDirty.message, /uncommitted/i);

    // Active COMS peer rejected
    const rPeer = await removeWorktreesOp(REPO_MAIN, [WT_PEER], deps);
    assert.equal(rPeer.ok, false);
    assert.match(rPeer.message, /active COMS peer/i);

    // Locked worktree rejected
    const rLocked = await removeWorktreesOp(REPO_MAIN, [WT_LOCKED], deps);
    assert.equal(rLocked.ok, false);
    assert.match(rLocked.message, /locked/i);

    // Unverified COMS registry fails closed
    const rUnverified = await removeWorktreesOp(REPO_MAIN, [WT_CLEAN], {
      runGitAsync,
      inspectLivePeers: () => ({ peers: [], verified: false, error: "EACCES" }),
    });
    assert.equal(rUnverified.ok, false);
    assert.match(rUnverified.message, /Cannot verify active COMS peers/i);

    assert.equal(removeCalls.length, 0, "git worktree remove must never be invoked for blocked targets");
  });

  it("removeWorktreesOp supports single and bulk guarded removal with deduplication", async () => {
    const removeCalls: string[] = [];
    let changed = 0;
    const runGitAsync = makeMockGit({ removeCalls });

    // Bulk mix: one clean (allowed), one dirty (blocked), one duplicate of clean
    const res = await removeWorktreesOp(REPO_MAIN, [WT_CLEAN, WT_DIRTY, WT_CLEAN], {
      runGitAsync,
      readLivePeers: () => [],
      onWorktreesChanged: () => { changed++; },
    });
    assert.equal(res.op, "remove");
    assert.equal(res.ok, false, "partial bulk remove reports ok=false when any target was blocked");
    assert.deepEqual(res.removed, [WT_CLEAN]);
    assert.equal(res.failed?.length, 1);
    assert.equal(res.failed![0].path, WT_DIRTY);
    assert.deepEqual(removeCalls, [WT_CLEAN]);
    assert.equal(changed, 1);

    // Empty paths rejected
    const empty = await removeWorktreesOp(REPO_MAIN, [], { runGitAsync, readLivePeers: () => [] });
    assert.equal(empty.ok, false);
    assert.match(empty.message, /No worktree paths/i);
  });

  it("getWorktreeSummary short-circuits single-checkout repos, skips dirty scans by default, and computes dirty count when requested", async () => {
    let gitCalled = false;
    const s0 = await getWorktreeSummary(REPO_MAIN, {
      hasLinkedWorktreesHint: () => false,
      runGitAsync: async () => {
        gitCalled = true;
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    assert.equal(gitCalled, false);
    assert.deepEqual(s0, { worktreeCount: 0, worktreeDirtyCount: 0, inLinkedWorktree: false });

    // Default lightweight periodic poll (includeDirty: false) must NOT spawn git status per worktree
    const statusCalls: string[] = [];
    const baseGit = makeMockGit();
    const trackedGit: GitAsyncRunner = async (args, cwd) => {
      if (args[0] === "status") statusCalls.push(cwd ?? "");
      return baseGit(args, cwd);
    };
    const sLight = await getWorktreeSummary(WT_CLEAN, {
      hasLinkedWorktreesHint: () => true,
      runGitAsync: trackedGit,
      fallbackDirtyCount: 2,
    });
    assert.equal(statusCalls.length, 0, "lightweight poll must not invoke git status in worktrees");
    assert.deepEqual(sLight, { worktreeCount: 4, worktreeDirtyCount: 2, inLinkedWorktree: true });

    // Explicit includeDirty: true refreshes dirty count
    const sFull = await getWorktreeSummary(WT_CLEAN, {
      hasLinkedWorktreesHint: () => true,
      includeDirty: true,
      runGitAsync: trackedGit,
    });
    assert.ok(statusCalls.length > 0);
    assert.deepEqual(sFull, { worktreeCount: 4, worktreeDirtyCount: 1, inLinkedWorktree: true });
    assert.equal(worktreeSummaryEqual(null, sFull), false);
    assert.equal(worktreeSummaryEqual(sFull, { worktreeCount: 4, worktreeDirtyCount: 1, inLinkedWorktree: true }), true);
    assert.equal(worktreeSummaryEqual(sFull, { worktreeCount: 4, worktreeDirtyCount: 2, inLinkedWorktree: true }), false);
  });

  it("end-to-end against a real temporary git repo: list, detail, reject dirty, remove clean, prune", async () => {
    const dir = makeTempDir("pidash-worktree-e2e-");
    const cleanWtDir = join(dir, "wt-clean");
    const dirtyWtDir = join(dir, "wt-dirty");
    const repoDir = join(dir, "main");
    try {
      execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "README.md"), "# test\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir, stdio: "ignore" });

      execFileSync("git", ["worktree", "add", "-b", "feat/clean", cleanWtDir], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["worktree", "add", "-b", "feat/dirty", dirtyWtDir], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(dirtyWtDir, "untracked.txt"), "dirty\n");

      const noPeers = { readLivePeers: () => [], fetchOpenPrs: async () => new Map() };
      const list = await loadWorktreesPayload(repoDir, { forceRefresh: true, includePrs: false, deps: noPeers });
      assert.equal(list.linkedCount, 2);
      assert.equal(list.dirtyCount, 1);

      const dirtyItem = list.worktrees.find((w) => w.branch === "feat/dirty")!;
      const cleanItem = list.worktrees.find((w) => w.branch === "feat/clean")!;
      assert.equal(dirtyItem.canRemove, false);
      assert.equal(cleanItem.canRemove, true);

      const detail = await loadWorktreeDetailPayload(repoDir, dirtyItem.path, noPeers);
      assert.equal(detail.statusOk, true);
      assert.equal(detail.headSubject, "initial commit");
      assert.ok(detail.statusLines.some((l) => l.includes("untracked.txt")));

      // Server refuses dirty worktree
      const blocked = await removeWorktreesOp(repoDir, [dirtyItem.path], noPeers);
      assert.equal(blocked.ok, false);
      assert.match(blocked.message, /uncommitted/i);

      // Server removes clean worktree
      const removed = await removeWorktreesOp(repoDir, [cleanItem.path], noPeers);
      assert.equal(removed.ok, true);
      assert.deepEqual(removed.removed, [cleanItem.path]);

      const after = await loadWorktreesPayload(repoDir, { forceRefresh: true, includePrs: false, deps: noPeers });
      assert.equal(after.linkedCount, 1);

      const pruned = await pruneWorktreesOp(repoDir);
      assert.equal(pruned.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pidash-session-state worktree fields (#1427)", () => {
  it("persists worktreeCount, worktreeDirtyCount, and inLinkedWorktree across register and update_info", () => {
    const state = createPidashSessionState(() => {});
    const client = state.register({}, {
      type: "register",
      pid: 101,
      sessionId: "101:/repo/.worktrees/wt1",
      cwd: "/repo/.worktrees/wt1",
      worktreeCount: 3,
      worktreeDirtyCount: 1,
      inLinkedWorktree: true,
    });
    assert.equal(client.session.worktreeCount, 3);
    assert.equal(client.session.worktreeDirtyCount, 1);
    assert.equal(client.session.inLinkedWorktree, true);

    updatePidashSession(client.session, { worktreeCount: 2, worktreeDirtyCount: 0, inLinkedWorktree: false });
    assert.equal(client.session.worktreeCount, 2);
    assert.equal(client.session.worktreeDirtyCount, 0);
    assert.equal(client.session.inLinkedWorktree, false);

    // Invalid negative numbers are ignored
    updatePidashSession(client.session, { worktreeCount: -1, worktreeDirtyCount: -2 });
    assert.equal(client.session.worktreeCount, 2);
    assert.equal(client.session.worktreeDirtyCount, 0);
  });

  it("authorizeWorktreeBrowserCommand restricts mutations to localhost and enforces watched-session matching", () => {
    // Localhost watching target session: allowed for read & mutation
    assert.deepEqual(
      authorizeWorktreeBrowserCommand({
        command: "worktrees-remove",
        targetSessionId: "s1",
        watchedSessionId: "s1",
        remoteAddress: "127.0.0.1",
      }),
      { allowed: true },
    );
    assert.deepEqual(
      authorizeWorktreeBrowserCommand({
        command: "worktrees-prune",
        targetSessionId: "s1",
        watchedSessionId: "s1",
        remoteAddress: "::ffff:127.0.0.1",
      }),
      { allowed: true },
    );

    // Non-loopback LAN client: mutations blocked, read-only list on watched session allowed
    const lanRemove = authorizeWorktreeBrowserCommand({
      command: "worktrees-remove",
      targetSessionId: "s1",
      watchedSessionId: "s1",
      remoteAddress: "192.168.1.50",
    });
    assert.equal(lanRemove.allowed, false);
    assert.match((lanRemove as any).reason, /localhost/i);

    const lanPrune = authorizeWorktreeBrowserCommand({
      command: "worktrees-prune",
      targetSessionId: "s1",
      watchedSessionId: "s1",
      remoteAddress: "10.0.0.12",
    });
    assert.equal(lanPrune.allowed, false);

    assert.deepEqual(
      authorizeWorktreeBrowserCommand({
        command: "worktrees-list",
        targetSessionId: "s1",
        watchedSessionId: "s1",
        remoteAddress: "192.168.1.50",
      }),
      { allowed: true },
    );

    // Cross-session targeting (not watching targetSessionId) rejected even on localhost
    const crossSession = authorizeWorktreeBrowserCommand({
      command: "worktrees-list",
      targetSessionId: "s2",
      watchedSessionId: "s1",
      remoteAddress: "127.0.0.1",
    });
    assert.equal(crossSession.allowed, false);
    assert.match((crossSession as any).reason, /not watching/i);
  });

  it("buildWorktreeCommandErrorFrame and shouldNotifyWorktreeChange scope responses and invalidations cleanly", () => {
    const listErr = buildWorktreeCommandErrorFrame({ command: "worktrees-list", sessionId: "s1", requestId: "r1" }, "Disconnected", "/repo");
    assert.equal(listErr.type, "worktrees-list");
    assert.equal(listErr.requestId, "r1");
    assert.equal(listErr.error, "Disconnected");

    const detailErr = buildWorktreeCommandErrorFrame({ command: "worktrees-detail", path: "/repo/wt", requestId: "r2" }, "Disconnected");
    assert.equal(detailErr.type, "worktrees-detail");
    assert.equal(detailErr.statusOk, false);
    assert.equal(detailErr.error, "Disconnected");

    const opErr = buildWorktreeCommandErrorFrame({ command: "worktrees-remove", requestId: "r3" }, "Restricted");
    assert.equal(opErr.type, "worktrees-op-result");
    assert.equal(opErr.op, "remove");
    assert.equal(opErr.ok, false);

    // Same-session and same-repo watchers notified; foreign repo watchers NOT notified
    assert.equal(
      shouldNotifyWorktreeChange({
        watchId: "s1",
        sourceSessionId: "s1",
        repoRoot: "/repo",
        watchedSessionRepoRoot: "/repo",
        watchedSessionCwd: "/repo",
      }),
      true,
    );
    assert.equal(
      shouldNotifyWorktreeChange({
        watchId: "s2",
        sourceSessionId: "s1",
        repoRoot: "/repo",
        watchedSessionRepoRoot: "/repo",
        watchedSessionCwd: "/repo/.worktrees/wt2",
      }),
      true,
    );
    assert.equal(
      shouldNotifyWorktreeChange({
        watchId: "s3",
        sourceSessionId: "s1",
        repoRoot: "/repo",
        watchedSessionRepoRoot: "/other",
        watchedSessionCwd: "/other",
      }),
      false,
    );
    assert.equal(
      shouldNotifyWorktreeChange({
        watchId: null,
        sourceSessionId: "s1",
        repoRoot: "/repo",
        watchedSessionRepoRoot: undefined,
        watchedSessionCwd: undefined,
      }),
      false,
    );
  });
});
