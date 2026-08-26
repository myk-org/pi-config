/**
 * In-place pidiff Refresh payload and button state.
 * Run with: npx tsx --test tests/node/pidiff/request-diffs.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequestDiffsMessage,
  refreshButtonState,
} from "../../../extensions/pidiff/pidiff-ui/src/lib/request-diffs.ts";

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
  it("disables and spins while refreshing without unmounting the body", () => {
    assert.deepEqual(refreshButtonState(true), {
      disabled: true,
      spinning: true,
      unmountBody: false,
    });
  });

  it("enables the button when idle", () => {
    assert.deepEqual(refreshButtonState(false), {
      disabled: false,
      spinning: false,
      unmountBody: false,
    });
  });
});
