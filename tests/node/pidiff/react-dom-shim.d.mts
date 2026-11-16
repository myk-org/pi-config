/**
 * Types for `react-dom-shim.mjs`. The shim returns a fake node that stands in for the
 * container `react-dom/client` mounts into, so it is typed as the `HTMLElement` the
 * callers pass to `createRoot`.
 */
export function installReactDomShim(): HTMLElement;
