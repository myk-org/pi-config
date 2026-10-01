/**
 * search.js: index loading, the pending-query re-run, and the error guidance.
 *
 * The two behaviours re-run-on-settle and the error branch both landed in 4.7.2
 * with no test, so they are pinned here. The `file:` split is issue #875.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countRenders, errorResponse, jsonResponse, loadAsset, resultText, search } from "./dom.ts";

const INDEX = [
	{ slug: "quickstart", title: "Quickstart", content: "Install and run the thing." },
	{ slug: "config", title: "Configuration", content: "Everything is a flag." },
];

describe("search.js", () => {
	it("reports results for a query typed before the index resolved", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const asset = loadAsset("search.js", {
			fetch: async () => {
				await gate;
				return jsonResponse(INDEX);
			},
		});

		search(asset, "quick");
		assert.match(resultText(asset), /Loading search index/);

		release?.();
		await asset.flush();
		// No second input event: the pending query re-ran by itself.
		assert.match(resultText(asset), /Quickstart/);
		assert.doesNotMatch(resultText(asset), /Loading search index/);
	});

	it("shows the failure, not a spinner, when a query was pending and the load failed", async () => {
		const asset = loadAsset("search.js", { fetch: async () => errorResponse(500) });

		search(asset, "quick");
		assert.match(resultText(asset), /Loading search index/);

		await asset.flush();
		assert.doesNotMatch(resultText(asset), /Loading search index/);
		assert.ok(asset.errors.length > 0, "the underlying error stays in the console");
	});

	it("records a non-OK HTTP response as a load failure", async () => {
		const asset = loadAsset("search.js", { fetch: async () => errorResponse(404) });

		search(asset, "quick");
		await asset.flush();

		assert.match(resultText(asset), /not found/i);
		assert.doesNotMatch(resultText(asset), /No results found/);
	});

	it("does not tell the reader to rebuild when the server failed", async () => {
		// A 500 says nothing about the index file: it may be perfectly intact.
		const asset = loadAsset("search.js", { fetch: async () => errorResponse(500) });

		search(asset, "quick");
		await asset.flush();

		const text = resultText(asset);
		assert.match(text, /HTTP 500/);
		assert.doesNotMatch(text, /rebuild/i);
	});

	it("does not send the reader round the retry loop on an access denial", async () => {
		// 403 (and 401) are permanent: waiting does not lift an access
		// restriction, so retry advice would be as wrong as rebuild advice.
		const asset = loadAsset("search.js", { fetch: async () => errorResponse(403) });

		search(asset, "quick");
		await asset.flush();

		const text = resultText(asset);
		assert.match(text, /HTTP 403/);
		assert.match(text, /access/i);
		assert.doesNotMatch(text, /Try again/i);
		assert.doesNotMatch(text, /rebuild/i);
	});

	it("keeps retry advice for a transient server failure", async () => {
		const asset = loadAsset("search.js", { fetch: async () => errorResponse(503) });

		search(asset, "quick");
		await asset.flush();

		assert.match(resultText(asset), /Try again shortly/);
	});

	it("distinguishes a network or parse failure from a server error", async () => {
		const network = loadAsset("search.js", {
			fetch: async () => {
				throw new TypeError("Failed to fetch");
			},
		});
		search(network, "quick");
		await network.flush();
		const networkText = resultText(network);

		const server = loadAsset("search.js", { fetch: async () => errorResponse(503) });
		search(server, "quick");
		await server.flush();

		assert.match(networkText, /could not be loaded/i);
		assert.notStrictEqual(networkText, resultText(server));
	});

	it("records malformed JSON as a load failure", async () => {
		const asset = loadAsset("search.js", {
			fetch: async () => ({
				ok: true,
				status: 200,
				json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
			}),
		});

		search(asset, "quick");
		await asset.flush();

		assert.doesNotMatch(resultText(asset), /Loading search index/);
		assert.ok(asset.errors.length > 0);
	});

	it("blames the file protocol only on a file: page (issue #875)", async () => {
		const fileAsset = loadAsset("search.js", {
			url: "file:///tmp/docs/index.html",
			fetch: async () => errorResponse(404),
		});
		search(fileAsset, "quick");
		await fileAsset.flush();
		const fileText = resultText(fileAsset);

		const httpAsset = loadAsset("search.js", { fetch: async () => errorResponse(404) });
		search(httpAsset, "quick");
		await httpAsset.flush();
		const httpText = resultText(httpAsset);

		assert.match(fileText, /served over HTTP/i);
		// Served over HTTP already: telling the reader to serve it over HTTP is
		// advice that cannot help.
		assert.doesNotMatch(httpText, /served over HTTP/i);
		assert.notStrictEqual(fileText, httpText);
	});

	it("searches the inlined index without fetching", () => {
		let fetched = false;
		const asset = loadAsset("search.js", {
			globals: { __DOCS_SEARCH_INDEX__: INDEX },
			fetch: async () => {
				fetched = true;
				return jsonResponse(INDEX);
			},
		});

		search(asset, "flag");
		assert.match(resultText(asset), /Configuration/);
		assert.equal(fetched, false);
	});

	it("does not render when the index arrives and nothing was typed", async () => {
		const asset = loadAsset("search.js", { fetch: async () => jsonResponse(INDEX) });
		const renders = countRenders(asset, ".search-modal-results");

		await asset.flush();
		assert.equal(renders(), 0, "no query means no render");
	});

	it("renders exactly once more when a failure lands on a live query", async () => {
		const asset = loadAsset("search.js", { fetch: async () => errorResponse(500) });
		const renders = countRenders(asset, ".search-modal-results");

		search(asset, "quick");
		const afterTyping = renders();
		await asset.flush();
		assert.equal(renders(), afterTyping + 1, "the rejection re-renders the pending query");
	});

	it("matches on page title, page content and case, not the other page", () => {
		const payload = [
			{ slug: "one", title: "Configuration", content: "nothing relevant" },
			{ slug: "two", title: "Other", content: "mentions coms_max_hops inside" },
		];
		for (const [query, expected] of [
			["coms_max_hops", /Other/],
			["configuration", /Configuration/],
			["CONFIG", /Configuration/],
		] as const) {
			const asset = loadAsset("search.js", { globals: { __DOCS_SEARCH_INDEX__: payload } });
			search(asset, query);
			assert.match(resultText(asset), expected);
			assert.equal(asset.document.querySelectorAll(".search-result-item").length, 1);
		}
	});
});
