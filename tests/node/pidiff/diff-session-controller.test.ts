/**
 * In-process unit tests and React hook integration tests for DiffSessionController (#1359).
 * Run with: npx tsx --test tests/node/pidiff/diff-session-controller.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  buildRequestDiffsMessage,
  createDiffSessionController,
  getRefreshButtonState,
  useDiffSessionController,
  type DiffSessionController,
  type StorageLike,
} from "../../../extensions/pidiff/pidiff-ui/src/lib/diff-session-controller.ts";
import type { PiSession, Worktree } from "../../../extensions/pidiff/pidiff-ui/src/types.ts";
import { installReactDomShim } from "./react-dom-shim.mjs";

(globalThis as { __PIDIFF_DEBUG?: boolean }).__PIDIFF_DEBUG = true;

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

function makeSession(overrides: Partial<PiSession> = {}): PiSession {
  return {
    sessionId: "sess-1",
    cwd: "/repo/main",
    branch: "main",
    repo: "pi-config",
    worktrees: [
      { path: "/repo/main", branch: "main", head: "aaa1111", isMain: true },
      { path: "/repo/wt-a", branch: "feat/a", head: "bbb2222", isMain: false },
    ],
    ...overrides,
  };
}

const WORKTREE_A: Worktree = { path: "/repo/wt-a", branch: "feat/a", head: "bbb2222", isMain: false };
const WORKTREE_B: Worktree = { path: "/repo/wt-b", branch: "feat/b", head: "ccc3333", isMain: false };

describe("buildRequestDiffsMessage", () => {
  it("omits commit refs in branch mode", () => {
    assert.deepEqual(buildRequestDiffsMessage("branch", "abc", "def"), {
      type: "request-diffs",
      mode: "branch",
    });
  });

  it("includes commit refs in commits mode when both are set", () => {
    assert.deepEqual(buildRequestDiffsMessage("commits", "aaa111", "bbb222"), {
      type: "request-diffs",
      mode: "commits",
      fromRef: "aaa111",
      toRef: "bbb222",
    });
  });

  it("omits refs in commits mode when either side is empty", () => {
    assert.deepEqual(buildRequestDiffsMessage("commits", "aaa111", ""), {
      type: "request-diffs",
      mode: "commits",
    });
  });
});

describe("getRefreshButtonState", () => {
  it("enables control when idle while connected", () => {
    assert.deepEqual(getRefreshButtonState(false, true), {
      disabled: false,
      spinning: false,
      unmountBody: false,
    });
  });

  it("disables control while refreshing", () => {
    assert.equal(getRefreshButtonState(true, true).disabled, true);
  });

  it("spins control while refreshing", () => {
    assert.equal(getRefreshButtonState(true, true).spinning, true);
  });

  it("keeps diff body mounted while refreshing", () => {
    assert.equal(getRefreshButtonState(true, true).unmountBody, false);
  });

  it("disables control while disconnected", () => {
    assert.equal(getRefreshButtonState(false, false).disabled, true);
  });

  it("does not spin while disconnected", () => {
    assert.equal(getRefreshButtonState(true, false).spinning, false);
  });
});

describe("createDiffSessionController — WebSocket message dispatch", () => {
  it("auto-selects matching saved session from sessions-list", () => {
    const s1 = makeSession({ sessionId: "s1", branch: "main" });
    const s2 = makeSession({ sessionId: "s2", branch: "dev" });
    const sent: object[] = [];
    const storage = createMemoryStorage({ "pidiff-session": JSON.stringify(s2) });
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; }, storage });

    ctrl.handleMessage({ type: "sessions-list", sessions: [s1, s2] });

    assert.equal(ctrl.getState().activeSession?.sessionId, "s2");
    assert.equal(ctrl.getState().loading, true);
    assert.deepEqual(sent, [{ type: "watch", sessionId: "s2" }]);
    ctrl.dispose();
  });

  it("falls back to first session when saved session is absent from sessions-list", () => {
    const staleSaved = makeSession({ sessionId: "dead-session" });
    const live = makeSession({ sessionId: "live-1" });
    const sent: object[] = [];
    const storage = createMemoryStorage({ "pidiff-session": JSON.stringify(staleSaved) });
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; }, storage });

    ctrl.handleMessage({ type: "sessions-list", sessions: [live] });

    assert.equal(ctrl.getState().activeSession?.sessionId, "live-1");
    assert.deepEqual(sent, [{ type: "watch", sessionId: "live-1" }]);
    ctrl.dispose();
  });

  it("clears stale unbound saved session when sessions-list is empty", () => {
    const staleSaved = makeSession({ sessionId: "dead-session" });
    const storage = createMemoryStorage({ "pidiff-session": JSON.stringify(staleSaved) });
    const ctrl = createDiffSessionController({ send: () => true, storage });

    ctrl.handleMessage({ type: "sessions-list", sessions: [] });

    assert.equal(ctrl.getState().activeSession, null);
    assert.equal(storage.getItem("pidiff-session"), null);
    ctrl.dispose();
  });

  it("auto-selects first session received via session_added", () => {
    const s1 = makeSession({ sessionId: "added-1" });
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });

    ctrl.handleMessage({ type: "session_added", session: s1 });

    assert.equal(ctrl.getState().sessions.length, 1);
    assert.equal(ctrl.getState().activeSession?.sessionId, "added-1");
    assert.deepEqual(sent, [{ type: "watch", sessionId: "added-1" }]);
    ctrl.dispose();
  });

  it("ignores duplicate session_added entries", () => {
    const s1 = makeSession({ sessionId: "s1" });
    const ctrl = createDiffSessionController({ send: () => true });

    ctrl.handleMessage({ type: "session_added", session: s1 });
    ctrl.handleMessage({ type: "session_added", session: s1 });

    assert.equal(ctrl.getState().sessions.length, 1);
    ctrl.dispose();
  });

  it("resets active session state on session_removed", () => {
    const s1 = makeSession({ sessionId: "s1" });
    const storage = createMemoryStorage();
    const ctrl = createDiffSessionController({ send: () => true, storage });

    ctrl.setConnected(true);
    ctrl.handleMessage({ type: "sessions-list", sessions: [s1] });
    ctrl.switchWorktree(WORKTREE_A);
    ctrl.handleMessage({ type: "status_changed", changedWorktrees: [WORKTREE_A.path] });
    ctrl.refresh();
    ctrl.handleMessage({ type: "session_removed", sessionId: "s1" });

    const st = ctrl.getState();
    assert.equal(st.activeSession, null);
    assert.equal(st.activeWorktree, null);
    assert.equal(st.stale, false);
    assert.equal(st.refreshing, false);
    assert.equal(st.loading, false);
    assert.equal(st.staleWorktrees.size, 0);
    assert.equal(storage.getItem("pidiff-session"), null);
    ctrl.dispose();
  });

  it("merges session_updated fields into active session", () => {
    const s1 = makeSession({ sessionId: "s1", branch: "old-branch" });
    const storage = createMemoryStorage();
    const ctrl = createDiffSessionController({ send: () => true, storage });

    ctrl.handleMessage({ type: "sessions-list", sessions: [s1] });
    ctrl.handleMessage({ type: "session_updated", session: { sessionId: "s1", branch: "new-branch" } });

    assert.equal(ctrl.getState().activeSession?.branch, "new-branch");
    assert.equal(JSON.parse(storage.getItem("pidiff-session") || "{}").branch, "new-branch");
    ctrl.dispose();
  });

  it("deduplicates diff_update files with unstaged over staged over committed priority", () => {
    const ctrl = createDiffSessionController({ send: () => true });

    ctrl.handleMessage({
      type: "diff_update",
      mode: "branch",
      branch: "feat",
      committed: [
        { name: "shared.ts", status: "modified", oldContents: "c0", newContents: "c1" },
        { name: "only-committed.ts", status: "added", oldContents: "", newContents: "x" },
      ],
      staged: [
        { name: "shared.ts", status: "modified", oldContents: "s0", newContents: "s1" },
        { name: "staged-only.ts", status: "modified", oldContents: "a", newContents: "b" },
      ],
      unstaged: [
        { name: "shared.ts", status: "modified", oldContents: "u0", newContents: "u1" },
      ],
    });

    const files = ctrl.getState().diffData.files;
    assert.deepEqual(
      files.map((f) => [f.name, f.area]),
      [
        ["shared.ts", "unstaged"],
        ["staged-only.ts", "staged"],
        ["only-committed.ts", "committed"],
      ],
    );
    ctrl.dispose();
  });

  it("clears loading flag on matching diff_update", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    ctrl.switchSession(makeSession());
    assert.equal(ctrl.getState().loading, true);

    ctrl.handleMessage({ type: "diff_update", mode: "branch", branch: "main", committed: [], staged: [], unstaged: [] });

    assert.equal(ctrl.getState().loading, false);
    ctrl.dispose();
  });

  it("clears refreshing flag on matching diff_update", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    ctrl.setConnected(true);
    ctrl.refresh();
    assert.equal(ctrl.getState().refreshing, true);

    ctrl.handleMessage({ type: "diff_update", mode: "branch", branch: "main", committed: [], staged: [], unstaged: [] });

    assert.equal(ctrl.getState().refreshing, false);
    ctrl.dispose();
  });

  it("preserves stale flag on diff_update", () => {
    const ctrl = createDiffSessionController({ send: () => true, initialStale: true });

    ctrl.handleMessage({ type: "diff_update", mode: "branch", branch: "main", committed: [], staged: [], unstaged: [] });

    assert.equal(ctrl.getState().stale, true);
    ctrl.dispose();
  });

  it("ignores diff_update targeting an inactive mode", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    ctrl.switchMode("commits");

    ctrl.handleMessage({
      type: "diff_update",
      mode: "branch",
      branch: "main",
      committed: [{ name: "a.ts", status: "modified", oldContents: "1", newContents: "2" }],
    });

    assert.equal(ctrl.getState().diffData.files.length, 0);
    ctrl.dispose();
  });

  it("stores commits list on commits-list message", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    const commits = [{ hash: "aaa1111", short: "aaa1111", subject: "init", date: "today" }];

    ctrl.handleMessage({ type: "commits-list", commits });

    assert.deepEqual(ctrl.getState().commits, commits);
    ctrl.dispose();
  });

  it("marks active tab stale when status_changed includes active worktree path", () => {
    const s1 = makeSession();
    const ctrl = createDiffSessionController({ send: () => true });
    ctrl.handleMessage({ type: "sessions-list", sessions: [s1] });
    ctrl.switchWorktree(WORKTREE_A);

    ctrl.handleMessage({ type: "status_changed", changedWorktrees: [WORKTREE_A.path] });

    assert.equal(ctrl.getState().stale, true);
    assert.equal(ctrl.getState().staleWorktrees.has(WORKTREE_A.path), true);
    ctrl.dispose();
  });

  it("tracks background worktree staleness without setting active stale banner", () => {
    const s1 = makeSession();
    const ctrl = createDiffSessionController({ send: () => true });
    ctrl.handleMessage({ type: "sessions-list", sessions: [s1] });

    ctrl.handleMessage({ type: "status_changed", changedWorktrees: [WORKTREE_A.path] });

    assert.equal(ctrl.getState().stale, false);
    assert.equal(ctrl.getState().staleWorktrees.has(WORKTREE_A.path), true);
    ctrl.dispose();
  });

  it("marks active tab stale on unscoped status_changed", () => {
    const ctrl = createDiffSessionController({ send: () => true });

    ctrl.handleMessage({ type: "status_changed" });

    assert.equal(ctrl.getState().stale, true);
    ctrl.dispose();
  });
});

describe("createDiffSessionController — reconnect watch restoration", () => {
  it("sends nothing while disconnected", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });

    ctrl.setConnected(false);

    assert.deepEqual(sent, []);
    ctrl.dispose();
  });

  it("restores session watch before worktree watch on disconnected-to-connected edge", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });

    ctrl.setConnected(true);
    ctrl.handleMessage({ type: "sessions-list", sessions: [makeSession({ sessionId: "sess" })] });
    ctrl.switchWorktree(WORKTREE_A);
    sent.length = 0;

    ctrl.setConnected(false);
    ctrl.setConnected(true);

    assert.deepEqual(sent, [
      { type: "watch", sessionId: "sess" },
      { type: "watch-worktree", worktreePath: WORKTREE_A.path },
    ]);
    ctrl.dispose();
  });

  it("restores session watch alone when no worktree is active", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });

    ctrl.setConnected(true);
    ctrl.handleMessage({ type: "sessions-list", sessions: [makeSession({ sessionId: "sess" })] });
    sent.length = 0;

    ctrl.setConnected(false);
    ctrl.setConnected(true);

    assert.deepEqual(sent, [{ type: "watch", sessionId: "sess" }]);
    ctrl.dispose();
  });

  it("does not resend watches on repeated connected notifications", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });

    ctrl.setConnected(true);
    ctrl.handleMessage({ type: "sessions-list", sessions: [makeSession({ sessionId: "sess" })] });
    sent.length = 0;

    ctrl.setConnected(true);

    assert.deepEqual(sent, []);
    ctrl.dispose();
  });

  it("does not resend reconnect watches on worktree selection while connected", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });

    ctrl.setConnected(true);
    ctrl.handleMessage({ type: "sessions-list", sessions: [makeSession({ sessionId: "sess" })] });
    sent.length = 0;

    ctrl.switchWorktree(WORKTREE_B);

    assert.deepEqual(sent, [{ type: "watch-worktree", worktreePath: WORKTREE_B.path }]);
    ctrl.dispose();
  });

  it("clears in-flight refreshing state on disconnect", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    ctrl.setConnected(true);
    ctrl.refresh();
    assert.equal(ctrl.getState().refreshing, true);

    ctrl.setConnected(false);

    assert.equal(ctrl.getState().refreshing, false);
    assert.equal(ctrl.getState().refreshButton.spinning, false);
    assert.equal(ctrl.getState().refreshButton.disabled, true);
    ctrl.dispose();
  });
});

describe("createDiffSessionController — canonical request-diffs and switching", () => {
  it("routes branch mode switch through canonical request-diffs payload", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });
    ctrl.setConnected(true);
    ctrl.switchMode("commits");
    sent.length = 0;

    ctrl.switchMode("branch");

    assert.deepEqual(sent, [{ type: "request-diffs", mode: "branch" }]);
    assert.equal(ctrl.getState().loading, true);
    ctrl.dispose();
  });

  it("requests commits once when switching to commits mode", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });

    ctrl.switchMode("commits");
    ctrl.switchMode("branch");
    sent.length = 0;
    ctrl.switchMode("commits");

    assert.deepEqual(sent, []);
    assert.equal(ctrl.getState().diffData.files.length, 0);
    ctrl.dispose();
  });

  it("compares selected commits via canonical request-diffs payload", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });
    ctrl.setCommitFrom("aaa111");
    ctrl.setCommitTo("bbb222");

    const ok = ctrl.compareCommits();

    assert.equal(ok, true);
    assert.equal(ctrl.getState().loading, true);
    assert.deepEqual(sent, [
      { type: "request-diffs", mode: "commits", fromRef: "aaa111", toRef: "bbb222" },
    ]);
    ctrl.dispose();
  });

  it("skips compareCommits when either commit ref is missing", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });
    ctrl.setCommitFrom("aaa111");

    const ok = ctrl.compareCommits();

    assert.equal(ok, false);
    assert.deepEqual(sent, []);
    ctrl.dispose();
  });

  it("resets refresh state on session switch", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });
    const s1 = makeSession({ sessionId: "s1", branch: "main" });
    const s2 = makeSession({ sessionId: "s2", branch: "release" });

    ctrl.setConnected(true);
    ctrl.handleMessage({ type: "sessions-list", sessions: [s1, s2] });
    ctrl.handleMessage({ type: "status_changed", changedWorktrees: [s1.cwd] });
    ctrl.refresh();
    assert.equal(ctrl.getState().refreshing, true);
    sent.length = 0;

    ctrl.switchSession(s2);

    const st = ctrl.getState();
    assert.equal(st.activeSession?.sessionId, "s2");
    assert.equal(st.activeWorktree, null);
    assert.equal(st.refreshing, false);
    assert.equal(st.stale, false);
    assert.equal(st.mode, "branch");
    assert.equal(st.loading, true);
    assert.deepEqual(sent, [{ type: "watch", sessionId: "s2" }]);
    ctrl.dispose();
  });

  it("resets refreshing state on switchWorktree", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });
    const s1 = makeSession();

    ctrl.setConnected(true);
    ctrl.handleMessage({ type: "sessions-list", sessions: [s1] });
    ctrl.refresh();
    assert.equal(ctrl.getState().refreshing, true);
    sent.length = 0;

    ctrl.switchWorktree(WORKTREE_A);

    const st = ctrl.getState();
    assert.equal(st.activeWorktree?.path, WORKTREE_A.path);
    assert.equal(st.refreshing, false);
    assert.equal(st.loading, true);
    assert.deepEqual(sent, [{ type: "watch-worktree", worktreePath: WORKTREE_A.path }]);
    ctrl.dispose();
  });

  it("adopts target worktree staleness on switchWorktree", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    const s1 = makeSession();

    ctrl.setConnected(true);
    ctrl.handleMessage({ type: "sessions-list", sessions: [s1] });
    ctrl.handleMessage({ type: "status_changed", changedWorktrees: [WORKTREE_A.path] });

    ctrl.switchWorktree(WORKTREE_A);

    assert.equal(ctrl.getState().stale, true);
    ctrl.dispose();
  });
});

describe("createDiffSessionController — refresh UI transitions and safety timers", () => {
  it("skips refresh when disconnected", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });

    assert.equal(ctrl.refresh(), false);
    assert.deepEqual(sent, []);
    ctrl.dispose();
  });

  it("skips refresh when a refresh is already in flight", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });
    ctrl.setConnected(true);

    assert.equal(ctrl.refresh(), true);
    assert.equal(ctrl.refresh(), false);
    assert.equal(sent.length, 1);
    ctrl.dispose();
  });

  it("sends branch request-diffs on refresh", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });
    ctrl.setConnected(true);

    const ok = ctrl.refresh();

    assert.equal(ok, true);
    assert.deepEqual(sent, [{ type: "request-diffs", mode: "branch" }]);
    assert.equal(ctrl.getState().refreshing, true);
    ctrl.dispose();
  });

  it("clears active worktree staleness while keeping background worktrees stale on refresh", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    const s1 = makeSession();
    ctrl.setConnected(true);
    ctrl.handleMessage({ type: "sessions-list", sessions: [s1] });
    ctrl.handleMessage({ type: "status_changed", changedWorktrees: [s1.cwd, WORKTREE_A.path] });

    ctrl.refresh();

    assert.equal(ctrl.getState().stale, false);
    assert.equal(ctrl.getState().staleWorktrees.has(s1.cwd), false);
    assert.equal(ctrl.getState().staleWorktrees.has(WORKTREE_A.path), true);
    ctrl.dispose();
  });

  it("preserves displayed commit refs over leftover picker refs on commits refresh", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });
    ctrl.setConnected(true);
    ctrl.switchMode("commits");
    ctrl.handleMessage({
      type: "diff_update",
      mode: "commits",
      branch: "main",
      fromRef: "disp-a",
      toRef: "disp-b",
      committed: [],
    });
    ctrl.setCommitFrom("picker-a");
    ctrl.setCommitTo("picker-b");
    sent.length = 0;

    ctrl.refresh();

    assert.deepEqual(sent, [
      { type: "request-diffs", mode: "commits", fromRef: "disp-a", toRef: "disp-b" },
    ]);
    ctrl.dispose();
  });

  it("keeps stale state when socket drops refresh payload", () => {
    const ctrl = createDiffSessionController({ send: () => false, initialStale: true });
    ctrl.setConnected(true);

    const ok = ctrl.refresh();

    assert.equal(ok, false);
    assert.equal(ctrl.getState().stale, true);
    assert.equal(ctrl.getState().refreshing, false);
    ctrl.dispose();
  });

  it("clears loading state when safety timeout expires", async () => {
    const ctrl = createDiffSessionController({ send: () => true, timeoutMs: 20 });
    ctrl.switchSession(makeSession());
    assert.equal(ctrl.getState().loading, true);

    await new Promise((r) => setTimeout(r, 40));

    assert.equal(ctrl.getState().loading, false);
    ctrl.dispose();
  });

  it("clears refreshing state when safety timeout expires", async () => {
    const ctrl = createDiffSessionController({ send: () => true, timeoutMs: 20 });
    ctrl.setConnected(true);
    ctrl.refresh();
    assert.equal(ctrl.getState().refreshing, true);

    await new Promise((r) => setTimeout(r, 40));

    assert.equal(ctrl.getState().refreshing, false);
    ctrl.dispose();
  });

  it("cancels pending timers on dispose", async () => {
    const ctrl = createDiffSessionController({ send: () => true, timeoutMs: 20 });
    let calls = 0;
    ctrl.subscribe(() => { calls += 1; });
    ctrl.setConnected(true);
    ctrl.refresh();
    calls = 0;

    ctrl.dispose();
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(calls, 0);
  });
});

describe("createDiffSessionController — review comments and persistence", () => {
  it("hydrates persisted comments from storage", () => {
    const saved = [{ file: "a.ts", line: 4, side: "new" as const, body: "check" }];
    const storage = createMemoryStorage({ "pidiff-comments": JSON.stringify(saved) });
    const ctrl = createDiffSessionController({ send: () => true, storage });

    assert.deepEqual(ctrl.getState().comments, saved);
    ctrl.dispose();
  });

  it("submits trimmed comment with active worktree metadata", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    ctrl.switchWorktree(WORKTREE_A);
    ctrl.addCommentForm("src/a.ts", "deletions", 12);

    ctrl.submitComment("src/a.ts", "deletions", 12, "  fix null check  ");

    const st = ctrl.getState();
    assert.equal(st.openForms.length, 0);
    assert.deepEqual(st.comments, [{
      file: "src/a.ts",
      line: 12,
      side: "old",
      body: "fix null check",
      branch: WORKTREE_A.branch,
      worktreePath: WORKTREE_A.path,
    }]);
    ctrl.dispose();
  });

  it("persists submitted comments to storage", () => {
    const storage = createMemoryStorage();
    const ctrl = createDiffSessionController({ send: () => true, storage });

    ctrl.submitComment("src/a.ts", "additions", 5, "save me");

    const persisted = JSON.parse(storage.getItem("pidiff-comments") || "[]");
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].body, "save me");
    ctrl.dispose();
  });

  it("reopens comment location as an open form on editComment", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    ctrl.submitComment("src/a.ts", "additions", 7, "typo");

    ctrl.editComment(0);

    assert.equal(ctrl.getState().comments.length, 0);
    assert.deepEqual(ctrl.getState().openForms, [{ file: "src/a.ts", side: "additions", lineNumber: 7 }]);
    ctrl.dispose();
  });

  it("marks comment resolved without removing it", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    ctrl.submitComment("src/a.ts", "additions", 7, "typo");

    ctrl.resolveComment(0);

    assert.equal(ctrl.getState().comments[0].resolved, true);
    ctrl.dispose();
  });

  it("appends reply to existing comment", () => {
    const ctrl = createDiffSessionController({ send: () => true });
    ctrl.submitComment("src/a.ts", "additions", 7, "typo");

    ctrl.replyToComment(0, "fixed");

    assert.equal(ctrl.getState().comments[0].replies?.[0].body, "fixed");
    ctrl.dispose();
  });

  it("sends publish-review payload when socket is open", () => {
    const sent: object[] = [];
    const ctrl = createDiffSessionController({ send: (m) => { sent.push(m); return true; } });
    ctrl.submitComment("src/a.ts", "additions", 3, "note");

    const ok = ctrl.publishReview();

    assert.equal(ok, true);
    assert.equal((sent[0] as { type: string }).type, "publish-review");
    ctrl.dispose();
  });

  it("clears comments from state and storage after publishReview succeeds", () => {
    const storage = createMemoryStorage();
    const ctrl = createDiffSessionController({ send: () => true, storage });
    ctrl.submitComment("src/a.ts", "additions", 3, "note");

    ctrl.publishReview();

    assert.equal(ctrl.getState().comments.length, 0);
    assert.equal(storage.getItem("pidiff-comments"), null);
    ctrl.dispose();
  });

  it("retains comments when publish-review send is dropped", () => {
    const storage = createMemoryStorage();
    const ctrl = createDiffSessionController({ send: () => false, storage });
    ctrl.submitComment("src/a.ts", "additions", 3, "keep me");

    const ok = ctrl.publishReview();

    assert.equal(ok, false);
    assert.equal(ctrl.getState().comments.length, 1);
    assert.ok(storage.getItem("pidiff-comments"));
    ctrl.dispose();
  });
});

describe("useDiffSessionController — React reconnect integration", () => {
  it("restores session watch before worktree watch across a WebSocket reconnect", async () => {
    const prevWindow = globalThis.window;
    const prevWs = globalThis.WebSocket;
    const prevStorage = globalThis.localStorage;

    type FakeSocket = {
      readyState: number;
      sent: object[];
      onopen?: () => void;
      onclose?: () => void;
      onmessage?: (ev: { data: string }) => void;
      send: (payload: string) => void;
      close: () => void;
    };
    const sockets: FakeSocket[] = [];

    globalThis.window = { location: { protocol: "http:", host: "localhost" } } as Window & typeof globalThis;
    globalThis.localStorage = createMemoryStorage() as unknown as Storage;
    globalThis.WebSocket = class {
      static OPEN = 1;
      readyState = 0;
      sent: object[] = [];
      onopen?: () => void;
      onclose?: () => void;
      onmessage?: (ev: { data: string }) => void;
      constructor() {
        sockets.push(this);
      }
      send(payload: string) {
        this.sent.push(JSON.parse(payload));
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    } as unknown as typeof WebSocket;

    const container = installReactDomShim();
    let exposed: DiffSessionController | null = null;

    function Probe() {
      const { controller } = useDiffSessionController({ reconnectMs: 5 });
      exposed = controller;
      return null;
    }

    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(Probe));
      });
      assert.equal(sockets.length, 1);

      // Initial open + session/worktree binding
      await act(async () => {
        sockets[0].readyState = 1;
        sockets[0].onopen?.();
        sockets[0].onmessage?.({
          data: JSON.stringify({ type: "sessions-list", sessions: [makeSession({ sessionId: "sess-live" })] }),
        });
      });
      await act(async () => {
        exposed!.switchWorktree(WORKTREE_A);
      });

      // Unexpected disconnect -> auto reconnect -> second socket opens
      await act(async () => {
        sockets[0].readyState = 3;
        sockets[0].onclose?.();
        await new Promise((r) => setTimeout(r, 25));
      });
      assert.equal(sockets.length, 2);

      await act(async () => {
        sockets[1].readyState = 1;
        sockets[1].onopen?.();
      });

      assert.deepEqual(sockets[1].sent, [
        { type: "watch", sessionId: "sess-live" },
        { type: "watch-worktree", worktreePath: WORKTREE_A.path },
      ]);
    } finally {
      await act(async () => { root.unmount(); });
      globalThis.window = prevWindow;
      globalThis.WebSocket = prevWs;
      globalThis.localStorage = prevStorage;
    }
  });

  it("renders without crashing when reading global localStorage throws SecurityError", async () => {
    const prevStorageDesc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });

    const container = installReactDomShim();
    const ref: { current: DiffSessionController | null } = { current: null };

    function Probe() {
      const { controller } = useDiffSessionController({ testWs: null });
      ref.current = controller;
      return null;
    }

    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(Probe));
      });
      assert.ok(ref.current, "controller should initialize when localStorage getter throws");
      assert.equal(ref.current.getState().activeSession, null);
      assert.deepEqual(ref.current.getState().comments, []);
    } finally {
      await act(async () => { root.unmount(); });
      if (prevStorageDesc) Object.defineProperty(globalThis, "localStorage", prevStorageDesc);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});
