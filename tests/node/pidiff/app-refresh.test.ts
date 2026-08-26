/**
 * App header + stale-banner Refresh wiring (App.tsx slots).
 * Run with: npx tsx --test tests/node/pidiff/app-refresh.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createLogger } from "../../../extensions/pidiff/pidiff-ui/src/lib/create-logger.ts";
import { AppRefreshActions } from "../../../extensions/pidiff/pidiff-ui/src/lib/app-refresh-actions.tsx";
import {
  buildRequestDiffsMessage,
  refreshButtonState,
  shouldBeginRefresh,
} from "../../../extensions/pidiff/pidiff-ui/src/lib/request-diffs.ts";

const log = createLogger("pidiff-ui");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const appSrc = readFileSync(join(repoRoot, "extensions/pidiff/pidiff-ui/src/App.tsx"), "utf8");

type VNode = {
  type?: unknown;
  props?: {
    onClick?: () => void;
    disabled?: boolean;
    "data-pidiff-refresh-slot"?: string;
    children?: unknown;
  };
};

function walk(node: unknown, out: VNode[] = []): VNode[] {
  log.debug("walk vnode", { empty: node == null });
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
  log.debug("clickSlot", { slot });
  const btn = walk(tree).find(b => b.props?.["data-pidiff-refresh-slot"] === slot);
  assert.ok(btn, `missing ${slot} Refresh button`);
  assert.equal(typeof btn?.props?.onClick, "function");
  btn?.props?.onClick?.();
}

function slotTree(opts: {
  hasSession: boolean;
  stale: boolean;
  refreshing: boolean;
  connected: boolean;
  onRefresh: () => void;
}) {
  log.debug("slotTree", opts);
  return AppRefreshActions(opts);
}

describe("App Refresh slots", () => {
  it("App header slot mounts AppRefreshActions with requestDiffs", () => {
    assert.match(appSrc, /hasSession=\{Boolean\(activeSession\)\}/);
    assert.match(appSrc, /connected=\{connected\}/);
    assert.match(appSrc, /onRefresh=\{requestDiffs\}/);
  });

  it("App stale banner slot mounts AppRefreshActions with requestDiffs", () => {
    assert.match(appSrc, /stale=\{stale\}/);
    assert.match(appSrc, /refreshing=\{refreshing\}/);
    const mounts = [...appSrc.matchAll(/<AppRefreshActions[\s\S]*?onRefresh=\{requestDiffs\}/g)];
    assert.equal(mounts.length, 2);
  });

  it("header Refresh click sends request-diffs", () => {
    const sent: unknown[] = [];
    const tree = slotTree({
      hasSession: true,
      stale: false,
      refreshing: false,
      connected: true,
      onRefresh: () => { sent.push(buildRequestDiffsMessage("branch", "", "")); },
    });
    clickSlot(tree, "header");
    assert.deepEqual(sent, [{ type: "request-diffs", mode: "branch" }]);
  });

  it("header Refresh keeps the current tree mounted", () => {
    assert.equal(refreshButtonState(true, true).unmountBody, false);
  });

  it("header Refresh disables the control while in flight", () => {
    const html = renderToString(
      createElement(AppRefreshActions, {
        hasSession: true,
        stale: false,
        refreshing: true,
        connected: true,
        onRefresh: () => {},
      }),
    );
    assert.match(html, /disabled/);
    assert.match(html, /data-spinning="true"/);
  });

  it("banner Refresh click invokes requestDiffs", () => {
    let clicks = 0;
    const tree = slotTree({
      hasSession: false,
      stale: true,
      refreshing: false,
      connected: true,
      onRefresh: () => { clicks += 1; },
    });
    clickSlot(tree, "banner");
    assert.equal(clicks, 1);
  });

  it("disconnected header Refresh stays disabled", () => {
    const html = renderToString(
      createElement(AppRefreshActions, {
        hasSession: true,
        stale: false,
        refreshing: false,
        connected: false,
        onRefresh: () => {},
      }),
    );
    assert.match(html, /disabled/);
    assert.doesNotMatch(html, /data-spinning="true"/);
  });

  it("disconnected requestDiffs does not send", () => {
    assert.equal(shouldBeginRefresh(false, false), false);
  });
});
