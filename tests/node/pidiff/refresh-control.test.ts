/**
 * Header/banner Refresh control render + click.
 * Run with: npx tsx --test tests/node/pidiff/refresh-control.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PidiffRefreshControl } from "../../../extensions/pidiff/pidiff-ui/src/lib/refresh-control.tsx";

describe("PidiffRefreshControl", () => {
  it("renders an enabled Refresh control when idle", () => {
    const html = renderToString(
      createElement(PidiffRefreshControl, { refreshing: false, onRefresh: () => {} }),
    );
    assert.match(html, /Refresh/);
    assert.match(html, /data-pidiff-refresh="true"/);
    assert.doesNotMatch(html, /disabled=""/);
  });

  it("renders a disabled spinning Refresh control while refreshing", () => {
    const html = renderToString(
      createElement(PidiffRefreshControl, { refreshing: true, onRefresh: () => {} }),
    );
    assert.match(html, /disabled/);
    assert.match(html, /data-spinning="true"/);
  });

  it("wires the rendered button onClick to onRefresh", () => {
    let clicks = 0;
    const vnode = PidiffRefreshControl({
      refreshing: false,
      onRefresh: () => { clicks += 1; },
    }) as { type: string; props: { onClick: () => void } };
    assert.equal(vnode.type, "button");
    vnode.props.onClick();
    assert.equal(clicks, 1);
  });

  it("renders a disabled control while disconnected", () => {
    const html = renderToString(
      createElement(PidiffRefreshControl, {
        refreshing: false,
        connected: false,
        onRefresh: () => {},
      }),
    );
    assert.match(html, /disabled/);
  });

  it("does not spin while disconnected", () => {
    const html = renderToString(
      createElement(PidiffRefreshControl, {
        refreshing: false,
        connected: false,
        onRefresh: () => {},
      }),
    );
    assert.doesNotMatch(html, /data-spinning="true"/);
  });
});
