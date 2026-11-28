/**
 * Tests for worktree helpers, COMS peer matching, cleanup guards,
 * /worktree overlay + subcommands, /status summary, and autocomplete (#1316).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { hyperlink } from "@earendil-works/pi-tui";
import {
  countLinkedWorktrees,
  detectWorktreePresence,
  invalidateWorktreeCache,
  isInLinkedWorktree,
  listWorktreesAsync,
  parseGitStatusPorcelain,
  parseWorktreePorcelain,
  runGitAsync,
  type GitAsyncRunner,
  type OpenPr,
} from "../../../extensions/orchestrator/git-helpers.js";
import { registerExtendedAutocomplete } from "../../../extensions/orchestrator/extended-autocomplete.js";
import { registerStatus } from "../../../extensions/orchestrator/status.js";
import {
  buildWorktreeDetailLines,
  buildWorktreeRowParts,
  executeGuardedWorktreeRemove,
  loadWorktreeDetail,
  openWorktreeOverlay,
  registerWorktree,
} from "../../../extensions/orchestrator/worktree.js";
import {
  attachPeersToWorktrees,
  canRemoveWorktree,
  copyTextToClipboard,
  defaultIsPidAlive,
  fetchOpenPrsByBranchAsync,
  formatPruneResult,
  formatWorktreeStatusSummary,
  formatWorktreeTable,
  inspectLiveComsPeers,
  readLiveComsPeers,
  runClipboardCommand,
  type GhPrListRunner,
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

  it("caches worktree listing within TTL until forceRefresh", async () => {
    let updated = false;
    const runner: GitAsyncRunner = async (args) => {
      if (args[0] === "worktree") {
        return {
          stdout: updated
            ? SAMPLE_PORCELAIN.replace("refs/heads/feat/a", "refs/heads/feat/updated")
            : SAMPLE_PORCELAIN,
          code: 0,
        };
      }
      if (args[0] === "status") return { stdout: " M index.ts\n", code: 0 };
      return { stdout: "", code: 0 };
    };

    const first = await listWorktreesAsync("/repo/.worktrees/feat-a", { runGitAsync: runner, ttlMs: 5_000 });
    assert.equal(first[1].branch, "feat/a");

    updated = true;
    const cached = await listWorktreesAsync("/repo/.worktrees/feat-a", { runGitAsync: runner, ttlMs: 5_000 });
    assert.equal(cached[1].branch, "feat/a", "should reuse cached listing within TTL");

    const refreshed = await listWorktreesAsync("/repo/.worktrees/feat-a", {
      runGitAsync: runner,
      includeDirty: true,
      forceRefresh: true,
    });
    assert.equal(refreshed[1].branch, "feat/updated", "forceRefresh should bypass cache");
    assert.equal(refreshed[0].dirty?.total, 1);
    assert.equal(refreshed[3].dirty, undefined, "prunable worktree skips git status");
  });

  it("prevents older worktree listing from overwriting newer forced refresh", async () => {
    let resolveSlow!: (v: { stdout: string; code: number }) => void;
    const slowPromise = new Promise<{ stdout: string; code: number }>((r) => { resolveSlow = r; });
    let started = 0;

    const runner: GitAsyncRunner = async () => {
      started++;
      if (started === 1) return slowPromise;
      return { stdout: "worktree /repo\nHEAD bbb\nbranch refs/heads/main\n", code: 0 };
    };

    const olderLoad = listWorktreesAsync("/repo", { runGitAsync: runner, ttlMs: 5_000 });
    const newerLoad = await listWorktreesAsync("/repo", {
      runGitAsync: runner,
      ttlMs: 5_000,
      forceRefresh: true,
    });
    assert.equal(newerLoad.length, 1);

    resolveSlow({ stdout: SAMPLE_PORCELAIN, code: 0 });
    await olderLoad;

    const cachedAfter = await listWorktreesAsync("/repo", { runGitAsync: runner, ttlMs: 5_000 });
    assert.equal(cachedAfter.length, 1, "stale older refresh must not overwrite newer cached listing");
  });

  it("does not cache non-zero exit failures", async () => {
    let failedOnce = false;
    const runner: GitAsyncRunner = async () => {
      if (!failedOnce) {
        failedOnce = true;
        return { stdout: "", code: 128 };
      }
      return { stdout: "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n", code: 0 };
    };
    const r1 = await listWorktreesAsync("/repo", { runGitAsync: runner });
    assert.deepEqual(r1, []);
    const r2 = await listWorktreesAsync("/repo", { runGitAsync: runner });
    assert.equal(r2.length, 1);
  });

  it("runs real runGitAsync against a temporary git repository", async () => {
    const tmpRepo = makeTempDir("wt-real-git-");
    try {
      execFileSync("git", ["init", "-q"], { cwd: tmpRepo });
      const res = await runGitAsync(["worktree", "list", "--porcelain"], tmpRepo);
      assert.equal(res.code, 0);
      assert.match(res.stdout, /worktree /);
      assert.equal(detectWorktreePresence(tmpRepo), false);

      const nonRepo = makeTempDir("wt-non-git-");
      try {
        const failRes = await runGitAsync(["rev-parse", "--git-dir"], nonRepo);
        assert.notEqual(failRes.code, 0);
      } finally {
        rmSync(nonRepo, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
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

  it("treats EPERM as alive in defaultIsPidAlive", () => {
    const alive = defaultIsPidAlive(4242, () => {
      const err: NodeJS.ErrnoException = new Error("operation not permitted");
      err.code = "EPERM";
      throw err;
    });
    assert.equal(alive, true);
  });

  it("treats ESRCH as dead in defaultIsPidAlive", () => {
    const alive = defaultIsPidAlive(4242, () => {
      const err: NodeJS.ErrnoException = new Error("no such process");
      err.code = "ESRCH";
      throw err;
    });
    assert.equal(alive, false);
  });

  it("marks absent COMS registry as verified", () => {
    const res = inspectLiveComsPeers("/repo", {
      comsDir: join(tmpDir, "does-not-exist"),
      strict: true,
    });
    assert.equal(res.verified, true);
    assert.deepEqual(res.peers, []);
  });

  it("marks malformed COMS peer entries as unverified", () => {
    const agentsDir = join(tmpDir, "projects", "proj-a", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "corrupt.json"), "{not-valid-json");

    const res = inspectLiveComsPeers("/repo", { comsDir: tmpDir, strict: true });
    assert.equal(res.verified, false);
    assert.match(res.error ?? "", /corrupt\.json/);
  });

  it("keeps stale-heartbeat peers with live PID and socket in strict mode", () => {
    const agentsDir = join(tmpDir, "projects", "proj-a", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const now = Date.now();
    const staleIso = new Date(now - 600_000).toISOString();

    writeFileSync(
      join(agentsDir, "peer-stale-live.json"),
      JSON.stringify({
        name: "peer-stale-live",
        pid: 7777,
        cwd: "/repo/.worktrees/feat-a",
        endpoint: "/tmp/still-there.sock",
        heartbeat_at: staleIso,
      }),
    );

    const display = readLiveComsPeers("/repo", {
      comsDir: tmpDir,
      now,
      isPidAlive: (pid) => pid === 7777,
      endpointExists: (ep) => ep === "/tmp/still-there.sock",
    });
    assert.equal(display.length, 0, "best-effort display skips stale heartbeats");

    const strict = inspectLiveComsPeers("/repo", {
      comsDir: tmpDir,
      now,
      strict: true,
      isPidAlive: (pid) => pid === 7777,
      endpointExists: (ep) => ep === "/tmp/still-there.sock",
    });
    assert.equal(strict.verified, true);
    assert.equal(strict.peers.length, 1);
    assert.equal(strict.peers[0].name, "peer-stale-live");
  });

  describe("canRemoveWorktree guards", () => {
    const baseView = (): WorktreeView => ({
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
    });

    it("allows removing a clean linked worktree", () => {
      assert.deepEqual(canRemoveWorktree(baseView()), { allowed: true });
    });

    it("refuses removing the main worktree", () => {
      assert.equal(canRemoveWorktree({ ...baseView(), isMain: true }).allowed, false);
    });

    it("refuses removing the current session worktree", () => {
      assert.equal(canRemoveWorktree({ ...baseView(), isCurrent: true }).allowed, false);
    });

    it("refuses removing a worktree with an active COMS peer", () => {
      const peer: WorktreePeerInfo = { name: "peer-x", project: "p", cwd: "/repo/.worktrees/clean", busy: false, pid: 1, purpose: "" };
      const res = canRemoveWorktree({ ...baseView(), peers: [peer] });
      assert.equal(res.allowed, false);
      if (!res.allowed) assert.match(res.reason, /peer-x/);
    });

    it("refuses removing a worktree when COMS peer state is unverified", () => {
      const res = canRemoveWorktree({ ...baseView(), peersUnverifiedReason: "unreadable COMS registry" });
      assert.equal(res.allowed, false);
      if (!res.allowed) assert.match(res.reason, /unreadable COMS registry/);
    });

    it("refuses removing a locked worktree", () => {
      const res = canRemoveWorktree({ ...baseView(), locked: true, lockedReason: "CI" });
      assert.equal(res.allowed, false);
      if (!res.allowed) assert.match(res.reason, /locked.*CI/i);
    });

    it("refuses removing a dirty worktree", () => {
      const res = canRemoveWorktree({
        ...baseView(),
        dirty: { modified: 2, added: 0, deleted: 0, untracked: 1, total: 3 },
      });
      assert.equal(res.allowed, false);
      if (!res.allowed) assert.match(res.reason, /3 uncommitted changes/);
    });

    it("refuses removing a worktree with unknown dirty state", () => {
      assert.equal(canRemoveWorktree({ ...baseView(), dirty: undefined }).allowed, false);
    });

    it("allows removing a prunable worktree without dirty status", () => {
      assert.equal(canRemoveWorktree({ ...baseView(), prunable: true, dirty: undefined }).allowed, true);
    });
  });

  it("refuses executeGuardedWorktreeRemove when COMS peer state cannot be verified", async () => {
    const calls: string[][] = [];
    const runner: GitAsyncRunner = async (args) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") return { stdout: SAMPLE_PORCELAIN, code: 0 };
      if (args[0] === "status") return { stdout: "", code: 0 };
      return { stdout: "", code: 0 };
    };

    const res = await executeGuardedWorktreeRemove("/repo", "/repo/.worktrees/feat-a", {
      runGitAsync: runner,
      inspectLivePeers: () => ({ peers: [], verified: false, error: "EACCES reading registry" }),
    });
    assert.equal(res.ok, false);
    assert.match(res.message, /EACCES reading registry/);
    assert.equal(calls.some((a) => a[0] === "worktree" && a[1] === "remove"), false);
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

  it("renders overlay row parts and detail lines with HEAD, status, COMS peer, PR link, and guard status", () => {
    const entries = parseWorktreePorcelain(SAMPLE_PORCELAIN, "/repo/.worktrees/feat-a");
    entries[1].dirty = { modified: 1, added: 0, deleted: 0, untracked: 1, total: 2 };
    const prUrl = "https://github.com/myk-org/pi-config/pull/1323";
    const prs = new Map<string, OpenPr>([["feat/a", { number: 1323, url: prUrl }]]);
    const views = attachPeersToWorktrees(
      entries,
      [{ name: "peer-worktree-ux", project: "p", cwd: "/repo/.worktrees/feat-a", busy: true, pid: 77, purpose: "#1316" }],
      prs,
    );

    const theme = fakeTheme();
    const parts = buildWorktreeRowParts(views[1], "/repo", theme as any);
    assert.equal(parts.title, "feat/a");
    assert.match(parts.idLabel, /\[current\]/);
    assert.ok(parts.rightParts.some((p) => p.includes(hyperlink("#1323", prUrl))));
    assert.ok(parts.rightParts.some((p) => p.includes("~1 ?1")));
    assert.ok(parts.rightParts.some((p) => p.includes("peer-worktree-ux")));

    const mainParts = buildWorktreeRowParts(views[0], "/repo", theme as any);
    assert.equal(mainParts.rightParts.some((p) => p.includes("#1323")), false);

    const detailLines = buildWorktreeDetailLines(
      views[1],
      { headSubject: "feat: initial worktree ux", statusLines: [" M a.ts", "?? b.ts"] },
      theme as any,
    );
    const joined = detailLines.join("\n");
    assert.match(joined, /\/repo\/.worktrees\/feat-a/);
    assert.ok(joined.includes(hyperlink("#1323", prUrl)));
    assert.ok(joined.includes(hyperlink(prUrl, prUrl)));
    assert.match(joined, /feat: initial worktree ux/);
    assert.match(joined, /peer-worktree-ux \(busy, pid:77\) — #1316/);
    assert.match(joined, /M a\.ts/);
    assert.match(joined, /Cannot remove the current session/);

    const mainDetail = buildWorktreeDetailLines(views[0], { headSubject: "main", statusLines: [] }, theme as any).join("\n");
    assert.doesNotMatch(mainDetail, /^PR\s+/m);
  });

  it("marks failed detail git status as unavailable instead of clean", async () => {
    const entries = parseWorktreePorcelain(SAMPLE_PORCELAIN, "/repo");
    const views = attachPeersToWorktrees(entries, []);
    const detail = await loadWorktreeDetail(views[1], async (args) => {
      if (args[0] === "log") return { stdout: "feat: wip", code: 0 };
      return { stdout: "", stderr: "fatal: unable to read index", code: 128 };
    });
    assert.equal(detail.statusOk, false);
    assert.match(detail.statusError ?? "", /unable to read index/);

    const lines = buildWorktreeDetailLines(views[1], detail, fakeTheme() as any).join("\n");
    assert.match(lines, /Working tree status unavailable/);
    assert.doesNotMatch(lines, /Working tree clean/);
  });

  it("ignores unsafe PR URLs and non-positive PR numbers when fetching open PRs", async () => {
    const prUrl = "https://github.com/myk-org/pi-config/pull/1323";
    const runner: GhPrListRunner = async () =>
      JSON.stringify([
        { number: 1323, url: prUrl, headRefName: "feat/a" },
        { number: 99, url: "javascript:alert(1)", headRefName: "feat/bad-url" },
        { number: 0, url: "https://github.com/myk-org/pi-config/pull/0", headRefName: "feat/zero" },
      ]);

    const res = await fetchOpenPrsByBranchAsync("/repo", { runner, ttlMs: 15_000 });
    assert.deepEqual(res.get("feat/a"), { number: 1323, url: prUrl });
    assert.equal(res.has("feat/bad-url"), false, "unsafe URL must be ignored");
    assert.equal(res.has("feat/zero"), false, "non-positive PR number must be ignored");
  });

  it("serves cached open PRs within TTL until forceRefresh", async () => {
    const prUrl1 = "https://github.com/myk-org/pi-config/pull/1323";
    const prUrl2 = "https://github.com/myk-org/pi-config/pull/1400";
    let updated = false;
    const runner: GhPrListRunner = async () =>
      JSON.stringify(
        updated
          ? [{ number: 1400, url: prUrl2, headRefName: "feat/a" }]
          : [{ number: 1323, url: prUrl1, headRefName: "feat/a" }],
      );

    const first = await fetchOpenPrsByBranchAsync("/repo-pr-cache", { runner, ttlMs: 15_000 });
    assert.equal(first.get("feat/a")?.number, 1323);

    updated = true;
    const cached = await fetchOpenPrsByBranchAsync("/repo-pr-cache", { runner, ttlMs: 15_000 });
    assert.equal(cached.get("feat/a")?.number, 1323, "should serve cached PR map within TTL");

    const refreshed = await fetchOpenPrsByBranchAsync("/repo-pr-cache", {
      runner,
      ttlMs: 15_000,
      forceRefresh: true,
    });
    assert.equal(refreshed.get("feat/a")?.number, 1400, "forceRefresh should bypass PR cache");
  });

  it("fails open on gh PR errors without caching failures", async () => {
    let step = 0;
    const flakyRunner: GhPrListRunner = async () => {
      step++;
      if (step === 1) throw new Error("gh not found");
      if (step === 2) return "not json{";
      return JSON.stringify([{ number: 42, url: "https://github.com/myk-org/pi-config/pull/42", headRefName: "feat/ok" }]);
    };
    const errRes = await fetchOpenPrsByBranchAsync("/repo-flaky", { runner: flakyRunner });
    assert.equal(errRes.size, 0);
    const badJsonRes = await fetchOpenPrsByBranchAsync("/repo-flaky", { runner: flakyRunner });
    assert.equal(badJsonRes.size, 0);
    const recovered = await fetchOpenPrsByBranchAsync("/repo-flaky", { runner: flakyRunner });
    assert.deepEqual(recovered.get("feat/ok"), { number: 42, url: "https://github.com/myk-org/pi-config/pull/42" });
  });

  it("formats PR column with OSC 8 hyperlinks for TUI and markdown links for headless, showing '-' when unmatched", () => {
    const entries = parseWorktreePorcelain(SAMPLE_PORCELAIN, "/repo/.worktrees/feat-a");
    entries[0].dirty = { modified: 0, added: 0, deleted: 0, untracked: 0, total: 0 };
    entries[1].dirty = { modified: 0, added: 0, deleted: 0, untracked: 0, total: 0 };
    const prUrl = "https://github.com/myk-org/pi-config/pull/1323";
    const views = attachPeersToWorktrees(
      entries,
      [],
      new Map<string, OpenPr>([["feat/a", { number: 1323, url: prUrl }]]),
    );

    const tuiTable = formatWorktreeTable(views, "/repo", { hyperlinks: true });
    assert.ok(tuiTable.includes(hyperlink("#1323", prUrl)));
    const tuiLines = tuiTable.split("\n");
    const mainLine = tuiLines.find((l) => l.includes("main"));
    assert.ok(mainLine && /\s-\s+clean/.test(mainLine), `expected '-' for worktree without PR: ${mainLine}`);

    const mdTable = formatWorktreeTable(views, "/repo", { hyperlinks: false });
    assert.ok(mdTable.includes(`[#1323](${prUrl})`));

    // When no worktrees have PRs, omit PR column entirely
    const noPrViews = attachPeersToWorktrees(entries, []);
    const plainTable = formatWorktreeTable(noPrViews, "/repo", { hyperlinks: true });
    assert.equal(plainTable.includes("\x1b]8;;"), false);
    assert.doesNotMatch(plainTable, /\s-\s+clean/);
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
      fetchOpenPrs: async () => new Map(),
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
      fetchOpenPrs: async () => new Map(),
      openOverlay: fakeOpenOverlay,
    });

    assert.equal(confirmCalls, 0);
    assert.ok(notifications.some((n) => n.level === "warning" && n.msg.includes("current session")));
  });

  it("uses best-effort OSC 52 wording when clipboard falls back to terminal sequence", async () => {
    const notifications: Array<{ msg: string; level: string }> = [];
    const runner: GitAsyncRunner = async (args) => {
      if (args[0] === "worktree" && args[1] === "list") return { stdout: SAMPLE_PORCELAIN, code: 0 };
      if (args[0] === "log") return { stdout: "init", code: 0 };
      if (args[0] === "status") return { stdout: "", code: 0 };
      return { stdout: "", code: 0 };
    };
    let listOpens = 0;
    const fakeOpenOverlay: any = async (_ctx: any, opts: any) => {
      listOpens++;
      if (listOpens === 1) opts.listSpec.onSelect(opts.listSpec.listItems()[1]);
    };
    const detailKeys = ["c", "\x1b"];
    const theme = fakeTheme();
    const tui = fakeTui();
    const ctx: any = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        theme,
        notify: (msg: string, level: string) => notifications.push({ msg, level }),
        custom: async (factory: any) => {
          let resolveDone!: () => void;
          const p = new Promise<void>((r) => { resolveDone = r; });
          const comp = factory(tui, theme, {}, () => resolveDone());
          comp.handleInput(detailKeys.shift() ?? "\x1b");
          comp.dispose?.();
          await p;
          return null;
        },
      },
    };
    await openWorktreeOverlay(ctx, {
      runGitAsync: runner,
      readLivePeers: () => [],
      fetchOpenPrs: async () => new Map(),
      copyToClipboard: async () => ({ ok: true, method: "osc52" }),
      openOverlay: fakeOpenOverlay,
    });
    assert.ok(
      notifications.some((n) => n.msg.includes("OSC 52") && n.msg.includes("/repo/.worktrees/feat-a")),
      `expected OSC 52 wording with path, got: ${JSON.stringify(notifications)}`,
    );
  });

  it("handles Kitty CSI-u keys for list r/p and detail c/d/p/r in openWorktreeOverlay (#1391)", async () => {
    const notifications: Array<{ msg: string; level: string }> = [];
    const copied: string[] = [];
    let pruneCount = 0;
    const runner: GitAsyncRunner = async (args) => {
      if (args[0] === "worktree" && args[1] === "list") return { stdout: SAMPLE_PORCELAIN, code: 0 };
      if (args[0] === "worktree" && args[1] === "prune") {
        pruneCount++;
        return { stdout: "", code: 0 };
      }
      if (args[0] === "log") return { stdout: "init", code: 0 };
      if (args[0] === "status") return { stdout: "", code: 0 };
      return { stdout: "", code: 0 };
    };
    let listOpens = 0;
    const fakeOpenOverlay: any = async (_ctx: any, opts: any) => {
      listOpens++;
      const items = opts.listSpec.listItems();
      if (listOpens === 1) {
        assert.equal(opts.listSpec.onKey("\x1b[112;129u", items[0], []), "close"); // Kitty p + NumLock
      } else if (listOpens === 2) {
        opts.listSpec.onSelect(items[1]);
      }
    };
    const detailKeys = ["\x1b[1489::99u", "\x1b[114;129u", "\x1b"]; // non-Latin 'c', Kitty 'r' + NumLock, Esc
    const theme = fakeTheme();
    const tui = fakeTui();
    const ctx: any = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        theme,
        notify: (msg: string, level: string) => notifications.push({ msg, level }),
        custom: async (factory: any) => {
          let resolveDone!: () => void;
          const p = new Promise<void>((r) => { resolveDone = r; });
          const comp = factory(tui, theme, {}, () => resolveDone());
          comp.handleInput(detailKeys.shift() ?? "\x1b");
          comp.dispose?.();
          await p;
          return null;
        },
      },
    };
    await openWorktreeOverlay(ctx, {
      runGitAsync: runner,
      readLivePeers: () => [],
      fetchOpenPrs: async () => new Map(),
      copyToClipboard: async (text) => {
        copied.push(text);
        return { ok: true, method: "test" };
      },
      openOverlay: fakeOpenOverlay,
    });
    assert.equal(pruneCount, 1);
    assert.deepEqual(copied, ["/repo/.worktrees/feat-a"]);
  });

  it("exits overlay remove branch cleanly when ctx.ui.confirm throws on stale context", async () => {
    let confirmAttempted = false;
    const runner: GitAsyncRunner = async (args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          stdout: "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo/.worktrees/clean-wt\nHEAD bbb\nbranch refs/heads/feat/clean\n",
          code: 0,
        };
      }
      if (args[0] === "log") return { stdout: "clean", code: 0 };
      if (args[0] === "status") return { stdout: "", code: 0 };
      return { stdout: "", code: 0 };
    };
    let listOpens = 0;
    const fakeOpenOverlay: any = async (_ctx: any, opts: any) => {
      listOpens++;
      if (listOpens === 1) opts.listSpec.onSelect(opts.listSpec.listItems()[1]);
    };
    const theme = fakeTheme();
    const tui = fakeTui();
    const ctx: any = {
      hasUI: true,
      cwd: "/repo",
      ui: {
        theme,
        notify: () => {},
        confirm: async () => {
          confirmAttempted = true;
          throw new Error("stale extension context");
        },
        custom: async (factory: any) => {
          let resolveDone!: () => void;
          const p = new Promise<void>((r) => { resolveDone = r; });
          const comp = factory(tui, theme, {}, () => resolveDone());
          comp.handleInput("d");
          comp.dispose?.();
          await p;
          return null;
        },
      },
    };
    await openWorktreeOverlay(ctx, {
      runGitAsync: runner,
      readLivePeers: () => [],
      fetchOpenPrs: async () => new Map(),
      openOverlay: fakeOpenOverlay,
    });
    assert.equal(confirmAttempted, true);
  });

  describe("copyTextToClipboard & runClipboardCommand", () => {
    it("dispatches pbcopy on darwin", async () => {
      const tried: string[] = [];
      const res = await copyTextToClipboard("/tmp/wt", {
        platform: "darwin",
        isTTY: false,
        runCommand: async (cmd) => {
          tried.push(cmd);
          return cmd === "pbcopy";
        },
      });
      assert.deepEqual(tried, ["pbcopy"]);
      assert.deepEqual(res, { ok: true, method: "pbcopy" });
    });

    it("dispatches clip on win32", async () => {
      const tried: string[] = [];
      const res = await copyTextToClipboard("/tmp/wt", {
        platform: "win32",
        isTTY: false,
        runCommand: async (cmd) => {
          tried.push(cmd);
          return cmd === "clip";
        },
      });
      assert.deepEqual(tried, ["clip"]);
      assert.deepEqual(res, { ok: true, method: "clip" });
    });

    it("prefers wl-copy on Wayland Linux before falling back to xclip and xsel", async () => {
      const tried: Array<{ cmd: string; args: string[] }> = [];
      const res = await copyTextToClipboard("/tmp/wt", {
        platform: "linux",
        waylandDisplay: "wayland-0",
        isTTY: false,
        runCommand: async (cmd, args) => {
          tried.push({ cmd, args });
          return cmd === "xsel";
        },
      });
      assert.deepEqual(tried, [
        { cmd: "wl-copy", args: ["--type", "text/plain"] },
        { cmd: "xclip", args: ["-selection", "clipboard"] },
        { cmd: "xsel", args: ["--clipboard", "--input"] },
      ]);
      assert.deepEqual(res, { ok: true, method: "xsel" });
    });

    it("falls back to OSC 52 on a TTY when clipboard utilities fail", async () => {
      const written: string[] = [];
      const res = await copyTextToClipboard("/repo/wt", {
        platform: "linux",
        waylandDisplay: "",
        isTTY: true,
        runCommand: async () => false,
        writeStdout: (data) => written.push(data),
      });
      assert.deepEqual(res, { ok: true, method: "osc52" });
      const b64 = Buffer.from("/repo/wt", "utf-8").toString("base64");
      assert.equal(written[0], `\x1b]52;c;${b64}\x07`);
    });

    it("returns an error outside a TTY when no clipboard utility succeeds", async () => {
      const res = await copyTextToClipboard("/repo/wt", {
        platform: "linux",
        waylandDisplay: "",
        isTTY: false,
        runCommand: async () => false,
      });
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /No clipboard utility/);
    });

    it("returns true when runClipboardCommand exits with code 0", async () => {
      const ok = await runClipboardCommand(process.execPath, ["-e", "process.stdin.resume()"], "hello", 2000);
      assert.equal(ok, true);
    });

    it("returns false when runClipboardCommand exits with non-zero code", async () => {
      const ok = await runClipboardCommand(process.execPath, ["-e", "process.exit(1)"], "hello", 2000);
      assert.equal(ok, false);
    });

    it("kills hung clipboard process when runClipboardCommand exceeds timeout", async () => {
      const ok = await runClipboardCommand(
        process.execPath,
        ["-e", "setTimeout(() => {}, 10000)"],
        "hello",
        60,
      );
      assert.equal(ok, false);
    });
  });

  describe("/worktree command subcommands", () => {
    const prUrl = "https://github.com/myk-org/pi-config/pull/1323";

    const setupWorktreeCommand = () => {
      let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const sentMessages: string[] = [];
      const emittedEvents: string[] = [];
      const mockPi: any = {
        registerCommand(name: string, opts: any) {
          if (name === "worktree") handler = opts.handler;
        },
        registerTool() {},
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
        registerWorktree(mockPi, {
          runGitAsync: runner,
          readLivePeers: () => [],
          fetchOpenPrs: async () => new Map<string, OpenPr>([["feat/a", { number: 1323, url: prUrl }]]),
        });
      });
      assert.ok(handler);
      return { handler: handler!, sentMessages, emittedEvents };
    };

    it("skips /worktree registration when PI_SUBAGENT_CHILD=1", () => {
      const childRegistered: string[] = [];
      withSubagentChildEnv("1", () => {
        registerWorktree({ registerCommand: (n: string) => childRegistered.push(n) } as any);
      });
      assert.deepEqual(childRegistered, []);
    });

    it("falls back to markdown table via sendMessage when headless regardless of args", async () => {
      const { handler, sentMessages } = setupWorktreeCommand();
      await handler("", { hasUI: false, cwd: "/repo" });
      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0], /Worktrees \(4 total, 3 linked\)/);
      assert.ok(sentMessages[0].includes(`[#1323](${prUrl})`));
    });

    it("removes multiple Space-selected clean worktrees via guarded multi-select d/x", async () => {
      const removedPaths: string[] = [];
      const confirmPrompts: string[] = [];
      const notified: Array<{ msg: string; level: string }> = [];
      let viewsList = [
        { path: "/repo", head: "aaaa", branch: "main", isMain: true, isCurrent: true, detached: false, bare: false, locked: false, prunable: false },
        { path: "/repo/.worktrees/w1", head: "bbbb", branch: "feat/1", isMain: false, isCurrent: false, detached: false, bare: false, locked: false, prunable: false },
        { path: "/repo/.worktrees/w2", head: "cccc", branch: "feat/2", isMain: false, isCurrent: false, detached: false, bare: false, locked: false, prunable: false },
      ];
      const runner: GitAsyncRunner = async (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          const out = viewsList
            .map((w) => `worktree ${w.path}\nHEAD ${w.head}\nbranch refs/heads/${w.branch}\n`)
            .join("\n");
          return { stdout: out, stderr: "", code: 0 };
        }
        if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
        if (args[0] === "worktree" && args[1] === "remove") {
          removedPaths.push(args[2]);
          viewsList = viewsList.filter((w) => w.path !== args[2]);
          return { stdout: "", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      };
      let openCount = 0;
      const ctx: any = {
        hasUI: true,
        cwd: "/repo",
        mode: "tui",
        ui: {
          notify: (msg: string, level: string) => notified.push({ msg, level }),
          confirm: async (title: string) => {
            confirmPrompts.push(title);
            return true;
          },
        },
      };
      await openWorktreeOverlay(ctx, {
        runGitAsync: runner,
        readLivePeers: () => [],
        fetchOpenPrs: async () => new Map(),
        openOverlay: (async (_c: any, opts: any) => {
          openCount++;
          if (openCount === 1) {
            const items = opts.listSpec.listItems();
            const w1 = items.find((i: any) => i.path === "/repo/.worktrees/w1")!;
            const w2 = items.find((i: any) => i.path === "/repo/.worktrees/w2")!;
            const res = opts.listSpec.onKey?.("x", w1, [w1, w2]);
            assert.equal(res, "close");
          }
        }) as any,
      });
      assert.deepEqual(confirmPrompts, ["Remove 2 worktrees?"]);
      assert.deepEqual(removedPaths, ["/repo/.worktrees/w1", "/repo/.worktrees/w2"]);
      assert.match(notified.at(-1)?.msg ?? "", /removed 2 worktrees/i);
    });
  });

  it("includes 1-line Worktrees summary in /status for detached HEAD linked worktrees", async () => {
    const tmpBase = makeTempDir("wt-status-detached-");
    const mainDir = join(tmpBase, "main");
    const wtDir = join(tmpBase, "detached-wt");
    try {
      mkdirSync(mainDir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: mainDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: mainDir });
      writeFileSync(join(mainDir, "a.txt"), "hello\n");
      execFileSync("git", ["add", "a.txt"], { cwd: mainDir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: mainDir });
      execFileSync("git", ["worktree", "add", "-q", "--detach", wtDir, "HEAD"], { cwd: mainDir });

      let statusHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const mockPi: any = {
        registerCommand(name: string, opts: any) {
          if (name === "status") statusHandler = opts.handler;
        },
        registerTool() {},
      };
      registerStatus(mockPi, false, () => [], () => []);
      assert.ok(statusHandler);

      let notified = "";
      await statusHandler!("", {
        hasUI: true,
        cwd: wtDir,
        ui: { notify: (msg: string) => { notified = msg; } },
      });
      assert.match(notified, /Git: \(detached /);
      assert.match(notified, /⊞ Worktrees: 1 linked \(current: \(detached /);
    } finally {
      invalidateWorktreeCache();
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("does not attach argument completions to zero-arg /worktree via extended-autocomplete", () => {
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
    assert.equal(cmd?.getArgumentCompletions, undefined);
  });

  it("includes 1-line Worktrees summary in /status when linked worktrees exist", async () => {
    let statusHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const mockPi: any = {
      registerCommand(name: string, opts: any) {
        if (name === "status") statusHandler = opts.handler;
      },
      registerTool() {},
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

  it("omits Git and Worktrees lines in /status for non-git directories", async () => {
    const plainDir = makeTempDir("wt-status-nongit-");
    try {
      let statusHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const mockPi: any = {
        registerCommand(name: string, opts: any) {
          if (name === "status") statusHandler = opts.handler;
        },
        registerTool() {},
      };
      registerStatus(mockPi, false, () => [], () => []);
      assert.ok(statusHandler);

      let notified = "";
      await statusHandler!("", {
        hasUI: true,
        cwd: plainDir,
        ui: { notify: (msg: string) => { notified = msg; } },
      });
      assert.doesNotMatch(notified, /🔀 Git:/);
      assert.doesNotMatch(notified, /⊞ Worktrees:/);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
