/**
 * Browser search behaviour — the timing paths the generator tests cannot reach.
 *
 * The generator tests assert which files were produced; nothing exercised the
 * search script itself. That gap hid a real bug: a query typed before the index
 * fetch resolved was answered with "Loading search index..." and never re-run,
 * so results stayed hidden until the user edited the box again. The same applied
 * to a failed fetch.
 *
 * These tests drive the real assets/search.js in a minimal DOM stub, so a
 * regression in the re-render wiring fails here rather than in a browser.
 *
 * Run with: npx tsx --test tests/node/shared/search-script.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSearchScript } from "./search-harness.js";

const SEARCH_JS = readFileSync(
  join(import.meta.dirname, "../../../packages/pi-docsite/src/pi_docsite/renderer/static/search.js"),
  "utf-8",
);

describe("search.js index-loading races", () => {
  it("shows results for a query typed before the index resolves", async () => {
    const h = loadSearchScript(SEARCH_JS, { indexPayload: [{ slug: "a", title: "Alpha", content: "alpha body" }] });
    h.type("alpha"); // before the fetch settles
    assert.match(h.results(), /Loading search index/);
    await h.settle();
    assert.doesNotMatch(h.results(), /Loading search index/, "loading state must not persist");
    assert.match(h.results(), /Alpha/, "the pending query must be re-run when the index arrives");
  });

  it("does not render when the index arrives and nothing was typed", async () => {
    // Asserts the render count, not the panel text: an empty panel is the same
    // whether render() ran and produced nothing, or never ran at all.
    const h = loadSearchScript(SEARCH_JS, { indexPayload: [{ slug: "a", title: "Alpha", content: "x" }] });
    await h.settle();
    assert.equal(h.renderCount(), 0, "no query means no render");
  });

  it("does not render when the index fails and nothing was typed", async () => {
    // The counter, not the panel text: an empty panel looks identical whether
    // render() ran and produced nothing or never ran at all. The earlier
    // version of this test asserted only the panel, so it could not fail.
    const h = loadSearchScript(SEARCH_JS, { indexPayload: null });
    await h.settle();
    assert.equal(h.renderCount(), 0, "no query means no render, on success or on failure");
  });

  it("renders exactly once more when a failure lands on a live query", async () => {
    const h = loadSearchScript(SEARCH_JS, { indexPayload: null });
    h.type("alpha");
    const afterTyping = h.renderCount();
    await h.settle();
    assert.equal(h.renderCount(), afterTyping + 1, "the rejection re-renders the pending query");
  });

  it("matches on page content", async () => {
    const h = await searcher([
      { slug: "one", title: "Configuration", content: "nothing relevant" },
      { slug: "two", title: "Other", content: "mentions coms_max_hops inside" },
    ]);
    h.type("coms_max_hops");
    assert.match(h.results(), /Other/);
    assert.doesNotMatch(h.results(), /Configuration/);
  });

  it("matches on page title", async () => {
    const h = await searcher([
      { slug: "one", title: "Configuration", content: "nothing relevant" },
      { slug: "two", title: "Other", content: "mentions coms_max_hops inside" },
    ]);
    h.type("configuration");
    assert.match(h.results(), /Configuration/);
    assert.doesNotMatch(h.results(), /Other/);
  });

  it("matches case-insensitively", async () => {
    const h = await searcher([{ slug: "one", title: "Configuration", content: "x" }]);
    h.type("CONFIG");
    assert.match(h.results(), /Configuration/);
  });

  /** Harness with the index already loaded. */
  async function searcher(payload: Array<{ slug: string; title: string; content: string }>) {
    const h = loadSearchScript(SEARCH_JS, { indexPayload: payload });
    await h.settle();
    return h;
  }
});
