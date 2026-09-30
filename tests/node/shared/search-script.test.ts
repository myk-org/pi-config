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

  it("leaves an empty box alone when the index arrives", async () => {
    const h = loadSearchScript(SEARCH_JS, { indexPayload: [{ slug: "a", title: "Alpha", content: "x" }] });
    await h.settle();
    assert.equal(h.results().trim(), "");
  });

  it("reports the failure when a pending query's fetch rejects", async () => {
    const h = loadSearchScript(SEARCH_JS, { indexPayload: null });
    h.type("alpha");
    assert.match(h.results(), /Loading search index/);
    await h.settle();
    assert.doesNotMatch(h.results(), /Loading search index/, "a failed index must not read as still loading");
    assert.match(h.results(), /served over HTTP|unavailable/i);
  });

  it("does not re-render after a rejection when nothing was typed", async () => {
    const h = loadSearchScript(SEARCH_JS, { indexPayload: null });
    await h.settle();
    assert.equal(h.results().trim(), "", "no query, no error banner");
  });

  it("matches on title or content, case-insensitively", async () => {
    const h = loadSearchScript(SEARCH_JS, {
      indexPayload: [
        { slug: "one", title: "Configuration", content: "nothing here" },
        { slug: "two", title: "Other", content: "mentions coms_max_hops inside" },
      ],
    });
    await h.settle();
    h.type("coms_max_hops");
    assert.match(h.results(), /Other/);
    h.type("configuration");
    assert.match(h.results(), /Configuration/);
  });
});
