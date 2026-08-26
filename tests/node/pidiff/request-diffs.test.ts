/**
 * In-place pidiff Refresh payload and button state.
 * Run with: npx tsx --test tests/node/pidiff/request-diffs.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../../extensions/pidiff/pidiff-ui/src/lib/create-logger.ts";
import {
  buildRequestDiffsMessage,
  commitRefsForRefresh,
  refreshButtonState,
  runAppRefresh,
  shouldBeginRefresh,
} from "../../../extensions/pidiff/pidiff-ui/src/lib/request-diffs.ts";

const log = createLogger("pidiff-ui");

describe("buildRequestDiffsMessage", () => {
  it("sends branch mode without commit refs", () => {
    assert.deepEqual(buildRequestDiffsMessage("branch", "abc", "def"), {
      type: "request-diffs",
      mode: "branch",
    });
  });

  it("preserves fromRef and toRef in commits mode", () => {
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

describe("refreshButtonState", () => {
  it("disables the control while refreshing", () => {
    assert.equal(refreshButtonState(true).disabled, true);
  });

  it("spins the control while refreshing", () => {
    assert.equal(refreshButtonState(true).spinning, true);
  });

  it("keeps the body mounted while refreshing", () => {
    assert.equal(refreshButtonState(true).unmountBody, false);
  });

  it("enables the button when idle", () => {
    assert.deepEqual(refreshButtonState(false), {
      disabled: false,
      spinning: false,
      unmountBody: false,
    });
  });

  it("disables the control while the socket is down", () => {
    assert.equal(refreshButtonState(false, false).disabled, true);
  });

  it("does not spin while the socket is down", () => {
    assert.equal(refreshButtonState(false, false).spinning, false);
  });
});

describe("commitRefsForRefresh", () => {
  it("ignores picker SHAs outside commits mode", () => {
    assert.deepEqual(commitRefsForRefresh("branch", "aa", "bb", "cc", "dd"), { from: "", to: "" });
  });

  it("prefers displayed comparison refs over leftover picker SHAs", () => {
    assert.deepEqual(
      commitRefsForRefresh("commits", "disp-a", "disp-b", "old-a", "old-b"),
      { from: "disp-a", to: "disp-b" },
    );
  });
});

describe("shouldBeginRefresh", () => {
  it("allows Refresh when the socket is open", () => {
    assert.equal(shouldBeginRefresh(true, false), true);
  });

  it("blocks Refresh while disconnected", () => {
    assert.equal(shouldBeginRefresh(false, false), false);
  });

  it("blocks Refresh while a request is in flight", () => {
    assert.equal(shouldBeginRefresh(true, true), false);
  });
});

describe("runAppRefresh", () => {
  it("skips send while disconnected", () => {
    log.info("runAppRefresh disconnected");
    const sent: object[] = [];
    const result = runAppRefresh(false, false, (m) => sent.push(m), "branch", undefined, undefined, "", "");
    assert.deepEqual(result, { skipped: true, sent: false });
    assert.deepEqual(sent, []);
  });

  it("sends request-diffs when connected", () => {
    log.info("runAppRefresh connected");
    const sent: object[] = [];
    const result = runAppRefresh(true, false, (m) => { sent.push(m); return true; }, "branch", undefined, undefined, "", "");
    assert.deepEqual(result, { skipped: false, sent: true });
    assert.deepEqual(sent, [{ type: "request-diffs", mode: "branch" }]);
  });

  it("keeps commits refs on refresh", () => {
    log.info("runAppRefresh commits");
    const sent: object[] = [];
    runAppRefresh(true, false, (m) => { sent.push(m); return true; }, "commits", "aa", "bb", "old-a", "old-b");
    assert.deepEqual(sent, [{ type: "request-diffs", mode: "commits", fromRef: "aa", toRef: "bb" }]);
  });
});
