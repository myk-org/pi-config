class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.key = init.key;
    this.defaultPrevented = false;
    this.cancelBubble = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.cancelBubble = true; }
}

class FakeNode {
  constructor(nodeType, nodeName, ownerDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.tagName = nodeType === 1 ? nodeName : undefined;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = new Map();
  }
  appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.childNodes = this.childNodes.filter((item) => item !== child); child.parentNode = null; return child; }
  insertBefore(child, before) {
    const index = this.childNodes.indexOf(before);
    this.childNodes.splice(index < 0 ? 0 : index, 0, child);
    child.parentNode = this;
    return child;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
  }
  dispatchEvent(event) {
    if (!event.target) Object.defineProperty(event, "target", { value: this });
    Object.defineProperty(event, "currentTarget", { value: this, configurable: true });
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    if (event.bubbles && !event.cancelBubble) this.parentNode?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)); }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) {
    if (this.nodeType === 3) { this.data = String(value); return; }
    this.childNodes = value ? [this.ownerDocument.createTextNode(String(value))] : [];
    for (const child of this.childNodes) child.parentNode = this;
  }
}

class FakeElement extends FakeNode {
  constructor(tag, ownerDocument) {
    super(1, String(tag).toUpperCase(), ownerDocument);
    this.style = {};
    this.attributes = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }; }
}

export function installReactDomShim() {
  const document = new FakeNode(9, "#document", null);
  document.ownerDocument = document;
  document.activeElement = null;
  document.createElement = (tag) => new FakeElement(tag, document);
  document.createElementNS = (_ns, tag) => document.createElement(tag);
  document.createTextNode = (text) => {
    const node = new FakeNode(3, "#text", document);
    node.data = String(text);
    return node;
  };
  document.body = document.createElement("body");
  document.documentElement = document.createElement("html");
  document.body.parentNode = document;
  document.documentElement.parentNode = document;
  document.defaultView = globalThis;

  globalThis.window = globalThis;
  globalThis.document = document;
  globalThis.Node = FakeNode;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLIFrameElement = class {};
  globalThis.Event = FakeEvent;
  globalThis.MouseEvent = FakeEvent;
  globalThis.KeyboardEvent = FakeEvent;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);

  const container = document.createElement("div");
  container.parentNode = document.body;
  document.body.childNodes.push(container);
  return { container, document };
}

export function elements(root, tag) {
  const found = [];
  const visit = (node) => {
    if (!tag || node.tagName === tag.toUpperCase()) found.push(node);
    for (const child of node.childNodes || []) visit(child);
  };
  visit(root);
  return found;
}
