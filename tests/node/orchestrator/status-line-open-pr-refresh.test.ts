/**
 * Tests for status-line open-PR refresh callback wiring.
 * Run with: npx tsx --test tests/node/orchestrator/status-line-open-pr-refresh.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideOpenPrRefreshRerender,
  scheduleOpenPrStatusRefresh,
  shouldApplyOpenPrRefresh,
  type OpenPr,
} from "../../../extensions/orchestrator/git-helpers.js";

describe("shouldApplyOpenPrRefresh", () => {
  it("returns false when lastCtx is missing", () => {
    assert.equal(shouldApplyOpenPrRefresh(null, "main", "/repo:main"), false);
  });

  it("returns false when lastBranch is null", () => {
    assert.equal(
      shouldApplyOpenPrRefresh({ cwd: "/repo" }, null, "/repo:main"),
      false,
    );
  });

  it("returns false after branch switch", () => {
    assert.equal(
      shouldApplyOpenPrRefresh({ cwd: "/repo" }, "feat", "/repo:main"),
      false,
    );
  });

  it("returns false after cwd switch", () => {
    assert.equal(
      shouldApplyOpenPrRefresh({ cwd: "/other" }, "main", "/repo:main"),
      false,
    );
  });

  it("returns true when cwd and branch still match", () => {
    assert.equal(
      shouldApplyOpenPrRefresh({ cwd: "/repo" }, "main", "/repo:main"),
      true,
    );
  });
});

describe("decideOpenPrRefreshRerender", () => {
  const pr = (n: number): OpenPr => ({
    number: n,
    url: `https://github.com/org/repo/pull/${n}`,
  });

  it("skips when refresh key no longer matches", () => {
    assert.equal(
      decideOpenPrRefreshRerender({
        lastCtx: { cwd: "/repo" },
        lastBranch: "feat",
        refreshKey: "/repo:main",
        shownKey: "",
        fresh: pr(1),
      }),
      "skip",
    );
  });

  it("skips when fresh PR matches already shown PR", () => {
    const shown = pr(7);
    assert.equal(
      decideOpenPrRefreshRerender({
        lastCtx: { cwd: "/repo" },
        lastBranch: "main",
        refreshKey: "/repo:main",
        shownKey: `${shown.number}\0${shown.url}`,
        fresh: shown,
      }),
      "skip",
    );
  });

  it("rerenders when fresh PR differs from shown", () => {
    assert.equal(
      decideOpenPrRefreshRerender({
        lastCtx: { cwd: "/repo" },
        lastBranch: "main",
        refreshKey: "/repo:main",
        shownKey: "",
        fresh: pr(9),
      }),
      "rerender",
    );
  });
});

describe("scheduleOpenPrStatusRefresh", () => {
  it("rerenders when refresh returns a new PR on same branch", async () => {
    let rerenders = 0;
    const ctx = { cwd: "/repo" };
    let lastBranch: string | null = "main";
    scheduleOpenPrStatusRefresh({
      cwd: "/repo",
      branch: "main",
      shownPr: null,
      getState: () => ({ lastCtx: ctx, lastBranch }),
      onRerender: () => {
        rerenders++;
      },
      refresh: async () => ({
        number: 3,
        url: "https://github.com/org/repo/pull/3",
      }),
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(rerenders, 1);
  });

  it("skips rerender after branch switch during refresh", async () => {
    let resolve!: (v: OpenPr | null) => void;
    const pending = new Promise<OpenPr | null>((r) => {
      resolve = r;
    });
    let rerenders = 0;
    const ctx = { cwd: "/repo" };
    let lastBranch: string | null = "main";
    scheduleOpenPrStatusRefresh({
      cwd: "/repo",
      branch: "main",
      shownPr: null,
      getState: () => ({ lastCtx: ctx, lastBranch }),
      onRerender: () => {
        rerenders++;
      },
      refresh: async () => pending,
    });
    lastBranch = "other";
    resolve({ number: 3, url: "https://github.com/org/repo/pull/3" });
    await new Promise((r) => setImmediate(r));
    assert.equal(rerenders, 0);
  });

  it("skips rerender when lastBranch cleared to null", async () => {
    let resolve!: (v: OpenPr | null) => void;
    const pending = new Promise<OpenPr | null>((r) => {
      resolve = r;
    });
    let rerenders = 0;
    const ctx = { cwd: "/repo" };
    let lastBranch: string | null = "main";
    scheduleOpenPrStatusRefresh({
      cwd: "/repo",
      branch: "main",
      shownPr: null,
      getState: () => ({ lastCtx: ctx, lastBranch }),
      onRerender: () => {
        rerenders++;
      },
      refresh: async () => pending,
    });
    lastBranch = null;
    resolve({ number: 3, url: "https://github.com/org/repo/pull/3" });
    await new Promise((r) => setImmediate(r));
    assert.equal(rerenders, 0);
  });
});
