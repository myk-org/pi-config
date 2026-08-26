/**
 * App header + stale-banner Refresh wiring (App.tsx slots).
 * Run with: npx tsx --test tests/node/pidiff/app-refresh.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppRefreshActions } from "../../../extensions/pidiff/pidiff-ui/src/lib/app-refresh-actions.tsx";
import {
  buildRequestDiffsMessage,
  refreshButtonState,
} from "../../../extensions/pidiff/pidiff-ui/src/lib/request-diffs.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const appSrc = readFileSync(join(repoRoot, "extensions/pidiff/pidiff-ui/src/App.tsx"), "utf8");

type VNode = {
  type?: unknown;
  props?: {
    onClick?: () => void;
    "data-pidiff-refresh-slot"?: string;
    children?: unknown;
  };
};

function walk(node: unknown, out: VNode[] = []): VNode[] {
  if (node == null || typeof node !== "object") return out;
  const n = node as VNode & { type?: ((p: unknown) => unknown) | string | symbol };
  if (typeof n.type === "function") {
    return walk(n.type(n.props), out);
  }
  if (n.type === "button") out.push(n);
  const kids = n.props?.children;
  if (Array.isArray(kids)) for (const k of kids) walk(k, out);
  else walk(kids, out);
  return out;
}

function clickSlot(tree: unknown, slot: "header" | "banner"): void {
  const btn = walk(tree).find(b => b.props?.["data-pidiff-refresh-slot"] === slot);
  assert.ok(btn, `missing ${slot} Refresh button`);
  assert.equal(typeof btn?.props?.onClick, "function");
  btn?.props?.onClick?.();
}

describe("App Refresh slots", () => {
  it("App mounts header and banner AppRefreshActions with requestDiffs", () => {
    const mounts = [...appSrc.matchAll(/<AppRefreshActions[\s\S]*?onRefresh=\{requestDiffs\}/g)];
    assert.equal(mounts.length, 2);
    assert.match(appSrc, /hasSession=\{Boolean\(activeSession\)\}/);
    assert.match(appSrc, /stale=\{stale\}/);
    assert.match(appSrc, /refreshing=\{refreshing\}/);
    assert.doesNotMatch(appSrc, /setLoading\(true\).*requestDiffs|requestDiffs[\s\S]{0,80}setLoading\(true\)/);
  });

  it("header Refresh click runs the in-place requestDiffs callback", () => {
    const sent: unknown[] = [];
    let refreshing = false;
    const requestDiffs = () => {
      if (refreshing) return;
      refreshing = true;
      sent.push(buildRequestDiffsMessage("branch", "", ""));
    };
    const tree = AppRefreshActions({
      hasSession: true,
      stale: false,
      refreshing: false,
      onRefresh: requestDiffs,
    });
    clickSlot(tree, "header");
    assert.deepEqual(sent, [{ type: "request-diffs", mode: "branch" }]);
    assert.equal(refreshButtonState(refreshing).unmountBody, false);
    assert.equal(refreshButtonState(refreshing).disabled, true);
  });

  it("stale banner Refresh click runs the same in-place requestDiffs callback", () => {
    let clicks = 0;
    const tree = AppRefreshActions({
      hasSession: false,
      stale: true,
      refreshing: false,
      onRefresh: () => { clicks += 1; },
    });
    clickSlot(tree, "banner");
    assert.equal(clicks, 1);
  });
});
