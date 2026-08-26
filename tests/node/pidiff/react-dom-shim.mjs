/** Minimal document so react-dom/client can run useEffect in Node tests. */
import { createLogger } from "../../../extensions/pidiff/pidiff-ui/src/lib/create-logger.ts";

globalThis.__PIDIFF_DEBUG = true;
const log = createLogger("pidiff-ui");

function createNode(tag) {
  log.debug("createNode", tag);
  return {
    nodeType: 1,
    nodeName: String(tag).toUpperCase(),
    tagName: String(tag).toUpperCase(),
    style: {},
    childNodes: [],
    parentNode: null,
    ownerDocument: null,
    textContent: "",
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      this.childNodes = this.childNodes.filter((n) => n !== child);
      return child;
    },
    insertBefore(child) {
      this.childNodes.unshift(child);
      child.parentNode = this;
      return child;
    },
  };
}

export function installReactDomShim() {
  log.debug("installReactDomShim");
  function HTMLIFrameElement() {}
  globalThis.window = globalThis;
  globalThis.HTMLIFrameElement = HTMLIFrameElement;
  globalThis.HTMLElement = globalThis.HTMLElement || function HTMLElement() {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const doc = {
    nodeType: 9,
    createElement(tag) {
      const node = createNode(tag);
      node.ownerDocument = doc;
      return node;
    },
    createElementNS(_ns, tag) {
      return doc.createElement(tag);
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: text, ownerDocument: doc, parentNode: null, childNodes: [] };
    },
    body: createNode("body"),
    documentElement: createNode("html"),
    activeElement: null,
    defaultView: globalThis,
    addEventListener() {},
    removeEventListener() {},
  };
  doc.body.ownerDocument = doc;
  globalThis.document = doc;
  if (!globalThis.window.location) {
    globalThis.window.location = { protocol: "http:", host: "localhost" };
  }
  return doc.createElement("div");
}
