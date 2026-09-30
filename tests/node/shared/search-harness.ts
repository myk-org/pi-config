/**
 * Minimal DOM stub for exercising the generated docs' static scripts under
 * node:test. The docs site ships plain browser JS with no framework, so a small
 * stub is enough to drive it -- and driving the real file is the point: a mock
 * would not catch a missing re-render call.
 */

type Listener = (event: any) => void;

class El {
  tagName: string;
  children: El[] = [];
  attributes: Record<string, string> = {};
  className = "";
  _text = "";
  listeners: Record<string, Listener[]> = {};
  style: Record<string, string> = {};
  classList = {
    add: (...c: string[]) => { this.className = [this.className, ...c].filter(Boolean).join(" "); },
    remove: (c: string) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(" "); },
  };
  parent: El | null = null;

  /** Form value; the search script reads input.value.trim(). */
  value = "";
  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }

  get className$() { return this.className; }
  set textContent(v: string) { this._text = v; this.children = []; }
  get textContent(): string {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  set innerHTML(v: string) {
    this._text = v;
    this.children = [];
    // Tiny markup pass: the search script builds its modal by assigning markup
    // and then queries it. Nothing here needs real HTML, but it does need the
    // class attributes to become elements, so the script's own querySelector
    // calls find what they refer to.
    for (const m of v.matchAll(/<(\w+)[^>]*class="([\w -]+)"/g)) {
      const el = new El(m[1]);
      el.className = m[2].trim();
      this.appendChild(el);
    }
  }
  get innerHTML(): string { return this._text; }

  setAttribute(k: string, v: string): void { this.attributes[k] = v; }
  getAttribute(k: string): string | null { return this.attributes[k] ?? null; }

  appendChild(child: El): El { child.parent = this; this.children.push(child); return child; }
  insertBefore(child: El, ref: El | null): El {
    child.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type: string, event: any = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  matchesSelector(selector: string): boolean {
    return selector.split(",").map((s) => s.trim()).some((s) => {
      const m = s.match(/^([a-zA-Z]*)\.([\w-]+)$/);
      if (m) {
        const tagOk = m[1] === "" || this.tagName === m[1].toUpperCase();
        // An empty tag name means a bare ".class" selector; requiring a match
        // against it would make every class-only selector fail.
        return tagOk && this.className.split(/\s+/).includes(m[2]);
      }
      if (s.startsWith(".")) return this.className.split(/\s+/).includes(s.slice(1));
      return this.tagName === s.toUpperCase();
    });
  }
  querySelectorAll(selector: string): El[] {
    return this.descendants().filter((e) => e.matchesSelector(selector));
  }
  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus(): void { /* no-op */ }
  select(): void { /* no-op */ }
}

export interface Harness {
  /** Set the query and fire the input event, as a user typing would. */
  type(query: string): void;
  /** Current results-panel text. */
  results(): string;
  /** Resolve the pending index fetch (or its rejection) and flush timers. */
  settle(): Promise<void>;
}

interface Options {
  /** null rejects the fetch, as it would over file://. */
  indexPayload: Array<{ slug: string; title: string; content: string }> | null;
}

export function loadSearchScript(source: string, options: Options): Harness {
  const body = new El("body");
  const documentListeners: Listener[] = [];

  const documentStub: any = {
    body,
    createElement: (tag: string) => new El(tag),
    addEventListener: (t: string, fn: Listener) => { documentListeners.push(fn); void t; },
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
    getElementById: (id: string) => body.querySelector(`#${id}`),
    execCommand: () => true,
  };

  let resolveIndex: any;
  const fetchPromise = new Promise((res, rej) => { resolveIndex = { res, rej }; });

  const sandbox: any = {
    document: documentStub,
    window: { __DOCS_SEARCH_INDEX__: undefined },
    fetch: () => fetchPromise,
    navigator: {},
    console: { error: () => {}, warn: () => {}, log: () => {} },
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout: () => {},
  };
  sandbox.globalThis = sandbox;
  // eslint-disable-next-line no-new-func
  const run = new Function(...Object.keys(sandbox), `${source}\nreturn true;`);
  run(...Object.values(sandbox));

  // The script builds its own modal and assigns markup, which this stub does not
  // parse, so the elements it goes on to query are attached here instead.
  const input = body.querySelector(".search-modal-input") as El | null
    ?? (() => { const el = new El("input"); el.className = "search-modal-input"; body.appendChild(el); return el; })();
  const results = body.querySelector(".search-modal-results") as El | null
    ?? (() => { const el = new El("div"); el.className = "search-modal-results"; body.appendChild(el); return el; })();
  if (!input.parent) body.appendChild(input);
  if (!results.parent) body.appendChild(results);

  const flush = () => new Promise((r) => setImmediate(r));

  return {
    type(query: string) {
      (input as any).value = query;
      input.dispatch("input", { target: input });
    },
    results: () => results.textContent,
    async settle() {
      if (options.indexPayload === null) resolveIndex.rej(new Error("HTTP 0"));
      else resolveIndex.res({ ok: true, json: async () => options.indexPayload });
      await flush();
      await flush();
    },
  };
}
