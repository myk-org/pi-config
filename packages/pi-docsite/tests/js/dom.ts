/**
 * Test harness for the browser assets in `src/pi_docsite/renderer/static/`.
 *
 * The assets are shipped to every consumer as plain IIFEs with no exports, so
 * they cannot be imported: the only way to exercise one is to run it against a
 * DOM. A hand-written DOM stub would have to re-implement innerHTML parsing and
 * classList to be worth anything, so the tests use jsdom and evaluate the real
 * file in a real document. That keeps the stubs down to the three things jsdom
 * does not do: fetch, clipboard and timers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const staticDir = join(
	fileURLToPath(new URL(".", import.meta.url)),
	"..",
	"..",
	"src",
	"pi_docsite",
	"renderer",
	"static",
);

/** Anything the assets expect from a fetch response -- only these three fields. */
export interface FakeResponse {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}

export interface AssetOptions {
	/** Page markup. Must contain whatever the asset queries for. */
	html?: string;
	/** Page URL. `file:` selects the blocked-from-disk case. */
	url?: string;
	/** Stand-in for window.fetch. Defaults to one that always 404s. */
	fetch?: (url: string) => Promise<FakeResponse>;
	/** navigator.clipboard, or null for a browser without one. */
	clipboard?: { writeText: (text: string) => Promise<void> } | null;
	/** document.execCommand result for the copy fallback. */
	execCommand?: (command: string) => boolean;
	/** Globals set on window before the asset runs, e.g. the inlined index. */
	globals?: Record<string, unknown>;
	/** localStorage entries set before the asset runs. */
	storage?: Record<string, string>;
	/** Evaluate the asset N times -- the assets claim idempotence on re-run. */
	runs?: number;
}

export interface LoadedAsset {
	window: JSDOM["window"];
	document: Document;
	/** console.error calls the asset made, in order. */
	errors: unknown[][];
	/** Deferred timer callbacks, oldest first. Call runTimers() to fire them. */
	timers: (() => void)[];
	runTimers(): void;
	/** Let pending promise chains settle. */
	flush(): Promise<void>;
}

export function jsonResponse(data: unknown): FakeResponse {
	return { ok: true, status: 200, json: () => Promise.resolve(data) };
}

export function errorResponse(status: number): FakeResponse {
	return { ok: false, status, json: () => Promise.reject(new Error("no body")) };
}

/** Read a shipped asset and run it against a fresh document. */
export function loadAsset(name: string, options: AssetOptions = {}): LoadedAsset {
	const dom = new JSDOM(options.html ?? "<!doctype html><html><body></body></html>", {
		// "outside-only" gives window.eval without executing anything inline,
		// so the asset runs exactly as the <script> tag would run it.
		runScripts: "outside-only",
		pretendToBeVisual: true,
		url: options.url ?? "http://localhost/docs/index.html",
	});
	const { window } = dom;
	const errors: unknown[][] = [];
	const timers: (() => void)[] = [];

	window.console.error = (...args: unknown[]) => {
		errors.push(args);
	};
	window.fetch = ((input: string) =>
		options.fetch
			? options.fetch(input)
			: Promise.resolve(errorResponse(404))) as typeof window.fetch;
	window.setTimeout = ((fn: () => void) => {
		timers.push(fn);
		return 0;
	}) as unknown as typeof window.setTimeout;
	// jsdom has no clipboard and no execCommand; both are only reached by copy.js.
	const navigator = window.navigator as Navigator & {
		clipboard?: unknown;
	};
	Object.defineProperty(navigator, "clipboard", {
		value: options.clipboard === undefined ? { writeText: () => Promise.resolve() } : options.clipboard,
		configurable: true,
	});
	if (options.execCommand) {
		(window as unknown as { document: Document }).document.execCommand = options.execCommand as never;
	}

	Object.assign(window, options.globals ?? {});
	for (const [key, value] of Object.entries(options.storage ?? {})) {
		window.localStorage.setItem(key, value);
	}
	const source = readFileSync(join(staticDir, name), "utf8");
	for (let i = 0; i < (options.runs ?? 1); i++) window.eval(source);

	return {
		window,
		document: window.document,
		errors,
		timers,
		runTimers: () => {
			while (timers.length) timers.shift()?.();
		},
		// Two turns: one for the fetch chain, one for the render it triggers.
		flush: async () => {
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

/** Type into the search box and fire the event search.js listens for. */
export function search(asset: LoadedAsset, query: string): void {
	const input = asset.document.querySelector(".search-modal-input") as HTMLInputElement;
	input.value = query;
	input.dispatchEvent(new asset.window.Event("input"));
}

/**
 * Count assignments to an element's innerHTML after the asset has loaded.
 *
 * Panel text alone cannot tell "never rendered" from "rendered nothing" -- both
 * leave it empty -- and search.js's render() opens by clearing the panel, so the
 * assignment is the observable.
 */
export function countRenders(asset: LoadedAsset, selector: string): () => number {
	const element = asset.document.querySelector(selector);
	if (!element) throw new Error(`countRenders: no element matches ${selector}`);
	// innerHTML lives on Element.prototype, not on the concrete element's.
	let descriptor: PropertyDescriptor | undefined;
	for (let proto = element; proto && !descriptor; proto = Object.getPrototypeOf(proto)) {
		descriptor = Object.getOwnPropertyDescriptor(proto, "innerHTML");
	}
	if (!descriptor?.get || !descriptor.set) throw new Error("countRenders: innerHTML is not an accessor");
	let count = 0;
	Object.defineProperty(element, "innerHTML", {
		get: () => descriptor.get!.call(element),
		set: (value: string) => {
			count += 1;
			descriptor.set!.call(element, value);
		},
	});
	return () => count;
}

/** Text of the search results panel, as one string. */
export function resultText(asset: LoadedAsset): string {
	const results = asset.document.querySelector(".search-modal-results");
	return results?.textContent?.trim() ?? "";
}
