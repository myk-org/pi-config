/**
 * Types for `react-dom-shim.mjs`.
 *
 * The shim builds just enough of a DOM for `react-dom/client` to mount in Node. The fake
 * nodes pretend to be `HTMLElement`s because that is the only contract the callers care
 * about: React needs a `Container`, and the tests read `textContent` / dispatch events.
 * `activeElement` starts as `null` in the real shim; it is typed non-optional because every
 * test reads it only after focusing something.
 */
export interface FakeElement extends HTMLElement {}

export interface FakeDocument extends Document {
	activeElement: FakeElement;
}

export function installReactDomShim(): { container: FakeElement; document: FakeDocument };

export function elements(root: FakeDocument | FakeElement, tag: string): FakeElement[];
