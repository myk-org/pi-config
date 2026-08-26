/**
 * Header/banner Refresh control render + click.
 * Run with: npx tsx --test tests/node/pidiff/refresh-control.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "../../../extensions/pidiff/pidiff-ui/node_modules/react/index.js";
import { renderToString } from "../../../extensions/pidiff/pidiff-ui/node_modules/react-dom/server.node.js";
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

  it("invokes onRefresh when the idle control is clicked", () => {
    let clicks = 0;
    const el = createElement(PidiffRefreshControl, {
      refreshing: false,
      onRefresh: () => { clicks += 1; },
    });
    const onClick = (el.props as { onRefresh: () => void }).onRefresh;
    onClick();
    assert.equal(clicks, 1);
  });
});
