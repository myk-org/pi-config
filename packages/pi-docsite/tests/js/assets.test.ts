/**
 * The remaining shipped browser assets: copy, theme, codelabels, callouts,
 * scrollspy and github. One behaviour each that would otherwise only show up on
 * someone's site months later (issue #876).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, loadAsset } from "./dom.ts";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

function click(asset: ReturnType<typeof loadAsset>, element: Element): void {
	element.dispatchEvent(new asset.window.MouseEvent("click", { bubbles: true }));
}

describe("copy.js", () => {
	const code = page("<pre><code>uvx pi-docsite</code></pre>");

	it("adds one button per code block and does not stack on re-run", () => {
		const asset = loadAsset("copy.js", { html: code, runs: 2 });
		assert.equal(asset.document.querySelectorAll(".copy-btn").length, 1);
	});

	it("copies the code text and flashes Copied, then reverts", async () => {
		const copied: string[] = [];
		const asset = loadAsset("copy.js", {
			html: code,
			clipboard: {
				writeText: (text) => {
					copied.push(text);
					return Promise.resolve();
				},
			},
		});
		const btn = asset.document.querySelector(".copy-btn") as HTMLButtonElement;
		assert.strictEqual(btn.getAttribute("aria-label"), "Copy code");

		click(asset, btn);
		await asset.flush();

		assert.deepEqual(copied, ["uvx pi-docsite"]);
		assert.strictEqual(btn.getAttribute("aria-label"), "Copied");
		assert.ok(btn.classList.contains("copied"));

		asset.runTimers();
		assert.strictEqual(btn.getAttribute("aria-label"), "Copy code");
		assert.ok(!btn.classList.contains("copied"));
	});

	it("falls back to execCommand when the clipboard rejects", async () => {
		const asset = loadAsset("copy.js", {
			html: code,
			clipboard: { writeText: () => Promise.reject(new Error("denied")) },
			execCommand: () => true,
		});
		const btn = asset.document.querySelector(".copy-btn") as HTMLButtonElement;

		click(asset, btn);
		await asset.flush();

		assert.strictEqual(btn.getAttribute("aria-label"), "Copied");
		// The scratch textarea must not be left in the document.
		assert.equal(asset.document.querySelectorAll("textarea").length, 0);
	});

	it("reports failure when there is no clipboard and execCommand fails", async () => {
		const asset = loadAsset("copy.js", {
			html: code,
			clipboard: null,
			execCommand: () => false,
		});
		const btn = asset.document.querySelector(".copy-btn") as HTMLButtonElement;

		click(asset, btn);
		await asset.flush();

		assert.strictEqual(btn.getAttribute("aria-label"), "Copy failed");
	});
});

describe("theme.js", () => {
	it("restores the stored theme on load", () => {
		const asset = loadAsset("theme.js", {
			html: page('<button id="theme-toggle"></button>'),
			storage: { theme: "dark" },
		});
		assert.strictEqual(asset.document.documentElement.getAttribute("data-theme"), "dark");
	});

	it("ignores a stored value that is not a theme", () => {
		const asset = loadAsset("theme.js", { html: page(""), storage: { theme: "chartreuse" } });
		assert.strictEqual(asset.document.documentElement.getAttribute("data-theme"), "light");
	});

	it("defaults to light and toggles, persisting the choice", () => {
		const asset = loadAsset("theme.js", { html: page('<button id="theme-toggle"></button>') });
		const root = asset.document.documentElement;
		assert.strictEqual(root.getAttribute("data-theme"), "light");

		click(asset, asset.document.getElementById("theme-toggle") as Element);
		assert.strictEqual(root.getAttribute("data-theme"), "dark");
		assert.strictEqual(asset.window.localStorage.getItem("theme"), "dark");

		click(asset, asset.document.getElementById("theme-toggle") as Element);
		assert.strictEqual(root.getAttribute("data-theme"), "light");
		assert.strictEqual(asset.window.localStorage.getItem("theme"), "light");
	});

	it("survives a page without a toggle", () => {
		const asset = loadAsset("theme.js", { html: page("") });
		assert.strictEqual(asset.document.documentElement.getAttribute("data-theme"), "light");
	});
});

describe("codelabels.js", () => {
	it("labels a fenced block from its language class", () => {
		const asset = loadAsset("codelabels.js", {
			html: page('<div class="code-block-wrapper"><pre><code class="language-python">x = 1</code></pre></div>'),
		});
		const label = asset.document.querySelector(".code-label");
		assert.strictEqual(label?.textContent, "Python");
		// The label goes first inside the wrapper, not inside the <pre>.
		assert.strictEqual(label?.parentElement?.className, "code-block-wrapper");
	});

	it("falls back to the raw language for unmapped ones and skips unmarked code", () => {
		const asset = loadAsset("codelabels.js", {
			html: page('<div class="code-block-wrapper"><pre><code class="language-brainfuck">+++</code></pre></div><pre><code>plain</code></pre>'),
		});
		const labels = [...asset.document.querySelectorAll(".code-label")];
		assert.deepEqual(
			labels.map((l) => l.textContent),
			["brainfuck"],
		);
	});
});

describe("callouts.js", () => {
	it("maps the leading bold word to a callout class", () => {
		const asset = loadAsset("callouts.js", {
			html: page(
				"<blockquote><p><strong>Note:</strong> body</p></blockquote>" +
					"<blockquote><p><strong>Warning</strong> body</p></blockquote>" +
					"<blockquote><p>no marker</p></blockquote>",
			),
		});
		const [note, warning, plain] = [...asset.document.querySelectorAll("blockquote")];
		assert.ok(note.classList.contains("callout") && note.classList.contains("callout-note"));
		assert.ok(warning.classList.contains("callout-warning"));
		assert.ok(!plain.classList.contains("callout"));
	});
});

describe("scrollspy.js", () => {
	const toc = page(
		'<div class="toc-container"><a href="#one">One</a><a href="#two">Two</a></div><h2 id="one">One</h2><h2 id="two">Two</h2>',
	);

	function at(asset: ReturnType<typeof loadAsset>, id: string, offsetTop: number): void {
		Object.defineProperty(asset.document.getElementById(id) as HTMLElement, "offsetTop", {
			value: offsetTop,
			configurable: true,
		});
	}

	it("marks the last heading scrolled past, ignoring hrefs with no target", async () => {
		const asset = loadAsset("scrollspy.js", { html: toc });
		const [one, two] = [...asset.document.querySelectorAll(".toc-container a")];
		// Unknown target: must be skipped, not crash the loop.
		(one as Element).setAttribute("href", "#gone");

		at(asset, "one", 0);
		at(asset, "two", 900);
		Object.defineProperty(asset.window, "scrollY", { value: 1000, configurable: true });
		asset.window.dispatchEvent(new asset.window.Event("scroll"));
		// jsdom's requestAnimationFrame runs on a ~16ms timer.
		await new Promise((resolve) => setTimeout(resolve, 50));

		assert.ok(two.classList.contains("active"));
		assert.ok(!one.classList.contains("active"));
	});

	it("does nothing on a page without a table of contents", () => {
		const asset = loadAsset("scrollspy.js", { html: page("<h2 id='one'>One</h2>") });
		assert.equal(asset.document.querySelectorAll(".active").length, 0);
	});
});

describe("github.js", () => {
	const shell = (repoUrl: string) =>
		page(`<a id="github-link" data-repo-url="${repoUrl}"></a><span id="github-stars"></span>`);

	it("renders the star count in compact form", async () => {
		const urls: string[] = [];
		const asset = loadAsset("github.js", {
			html: shell("https://github.com/myk-org/pi-config"),
			fetch: async (url) => {
				urls.push(url);
				return jsonResponse({ stargazers_count: 1234 });
			},
		});
		await asset.flush();

		assert.deepEqual(urls, ["https://api.github.com/repos/myk-org/pi-config"]);
		const stars = asset.document.getElementById("github-stars") as HTMLElement;
		assert.strictEqual(stars.textContent, "★ 1.2k");
		assert.match(stars.title, /1,234/);
	});

	it("leaves the counter alone when the API fails", async () => {
		const asset = loadAsset("github.js", {
			html: shell("git@github.com:myk-org/pi-config.git"),
			fetch: () => Promise.reject(new Error("rate limited")),
		});
		await asset.flush();
		assert.strictEqual(asset.document.getElementById("github-stars")?.textContent, "");
	});

	it("does not fetch without a repo URL or a target element", async () => {
		let calls = 0;
		const fetchStub = async () => {
			calls++;
			return jsonResponse({ stargazers_count: 1 });
		};
		loadAsset("github.js", {
			html: page('<a id="github-link"></a><span id="github-stars"></span>'),
			fetch: fetchStub,
		});
		loadAsset("github.js", { html: page('<a id="github-link" data-repo-url="https://x"></a>'), fetch: fetchStub });
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(calls, 0);
	});
});
