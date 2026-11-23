/**
 * Contract test for cross-extension bridges under `extensions/shared/*-bridge.ts` (#1337).
 *
 * In multi-session hosts such as `pi-sidecar`, concurrent sessions share one Node process.
 * Any mutable per-session bridge stored on `globalThis[Symbol.for(...)]` must key state in
 * a per-session `Map<sessionId, ...>` with per-session cleanup, unless explicitly allowlisted
 * below as a genuinely process-wide singleton.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SESSION_BRIDGE_SYMBOL,
  isComsActive,
  markRecoveryPending,
  notifyMalformedRecoveryAborted,
  onMalformedRecoveryAborted,
  publishTaskStore,
  publishTaskTelemetryActive,
  publishWorkloadSources,
  publishedTaskStore,
  publishedTaskTelemetryActive,
  publishedWorkloadSources,
  registerRecoveryCoordinator,
  resetSessionBridge,
  setComsActive,
  shouldDeferForMalformedRecovery,
} from "../../../extensions/shared/session-bridge.ts";
import {
  createBridgedUi,
  isBrowserDispatch,
  markBrowserDispatch,
} from "../../../extensions/shared/ui-bridge.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "../../..");
const SHARED_DIR = join(REPO_ROOT, "extensions/shared");

/**
 * Explicit allowlist for `extensions/shared/*-bridge.ts` files that intentionally store a
 * process-wide singleton on `globalThis`. Every entry must carry a concrete justification
 * explaining why concurrent sessions in `pi-sidecar` cannot conflict on it.
 */
const PROCESS_WIDE_SINGLETON_ALLOWLIST: ReadonlyMap<string, string> = new Map();

/** Expected bridge modules under `extensions/shared/`. */
const REQUIRED_BRIDGE_FILES = ["session-bridge.ts", "ui-bridge.ts"] as const;

/** Strip JS/TS comments while preserving string and template literals. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i];
        out += c;
        i += 1;
        if (c === "\\" && i < source.length) {
          out += source[i];
          i += 1;
        } else if (c === quote) {
          break;
        }
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

interface BridgeAuditResult {
  usesGlobalThis: boolean;
  violations: string[];
}

/**
 * Audit one bridge module's source for un-allowlisted single-slot `globalThis` writes,
 * including direct property writes, computed symbol assignments, and reflective/Object mutations.
 */
function auditBridgeSource(
  fileName: string,
  rawSource: string,
  allowlist: ReadonlyMap<string, string> = PROCESS_WIDE_SINGLETON_ALLOWLIST,
): BridgeAuditResult {
  const code = stripComments(rawSource);
  const usesGlobalThis = /\bglobalThis\b/.test(code);
  if (!usesGlobalThis) {
    return { usesGlobalThis: false, violations: [] };
  }
  if (allowlist.has(fileName)) {
    return { usesGlobalThis: true, violations: [] };
  }

  const violations: string[] = [];

  // Collect aliases like `const g = globalThis as Record<symbol, unknown>;`
  const globalAliases = new Set<string>(["globalThis"]);
  const aliasRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*globalThis\b/g;
  for (const match of code.matchAll(aliasRe)) {
    globalAliases.add(match[1]);
  }
  const aliasPattern = [...globalAliases].join("|");

  // Detect alternate mutation primitives targeting globalThis (or any alias):
  // Object.assign(g, ...), Object.defineProperty(g, ...), Object.defineProperties(g, ...),
  // Reflect.set(g, ...), Reflect.defineProperty(g, ...).
  const altWriteRe = new RegExp(
    `\\b(?:Object\\.(?:assign|definePropert(?:y|ies))|Reflect\\.(?:set|defineProperty))\\s*\\(\\s*(?:\\(\\s*)?(?:${aliasPattern})\\b`,
    "g",
  );
  for (const match of code.matchAll(altWriteRe)) {
    violations.push(`${fileName}: mutates globalThis via un-auditable primitive (${match[0].trim()})`);
  }

  // Detect non-computed property assignments like `globalThis.__foo = ...`
  const dotWriteRe = new RegExp(
    `(?:\\(\\s*)?\\b(?:${aliasPattern})\\b(?:\\s+as\\s+[^)]+\\))?\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*=[^=]`,
    "g",
  );
  for (const match of code.matchAll(dotWriteRe)) {
    violations.push(`${fileName}: writes mutable dot-property directly on globalThis (${match[0].trim()})`);
  }

  // Detect computed assignments like `(globalThis as ...)[SYM] = rhs;` or `g[SYM] = rhs;`
  const computedWriteRe = new RegExp(
    `(?:\\(\\s*)?\\b(?:${aliasPattern})\\b(?:\\s+as\\s+[^)]+\\))?\\s*\\[([^\\]]+)\\]\\s*=\\s*([^;\\n]+)`,
    "g",
  );
  const computedWrites = [...code.matchAll(computedWriteRe)];
  if (computedWrites.length === 0 && violations.length === 0) {
    violations.push(`${fileName}: references globalThis without an auditable Map<sessionId, ...> binding`);
  }

  // Identify local variables initialized with `new Map` so `g[SYM] = map` is recognized as Map-backed.
  const mapVars = new Set<string>();
  const mapAssignRe = /\b([A-Za-z_$][\w$]*)\s*=\s*new\s+Map\b/g;
  for (const match of code.matchAll(mapAssignRe)) {
    mapVars.add(match[1]);
  }

  for (const match of computedWrites) {
    const rhs = match[2].trim();
    const isDirectNewMap = /^new\s+Map\b/.test(rhs);
    const rhsIdent = rhs.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+.*)?$/)?.[1];
    const isMapVar = Boolean(rhsIdent && mapVars.has(rhsIdent));
    if (!isDirectNewMap && !isMapVar) {
      violations.push(
        `${fileName}: assigns non-Map single-slot value to globalThis[${match[1].trim()}] = ${rhs}`,
      );
    }
  }

  if (!/\binstanceof\s+Map\b/.test(code)) {
    violations.push(`${fileName}: must guard globalThis bridge reads with \`instanceof Map\``);
  }
  if (!/\bsessionKey\b|\bsessionId\b/.test(code)) {
    violations.push(`${fileName}: must key globalThis Map entries by sessionKey/sessionId`);
  }
  if (!/\.delete\s*\(/.test(code)) {
    violations.push(`${fileName}: must clean up per-session Map entries via \`.delete(...)\``);
  }

  return { usesGlobalThis: true, violations };
}

describe("extensions/shared/*-bridge.ts static session-key contract (#1337)", () => {
  it("audits every *-bridge.ts module under extensions/shared/", () => {
    const sharedFiles = readdirSync(SHARED_DIR);
    const bridgeFiles = sharedFiles.filter((name) => name.endsWith("-bridge.ts")).sort();

    for (const requiredFile of REQUIRED_BRIDGE_FILES) {
      assert.ok(
        bridgeFiles.includes(requiredFile),
        `expected bridge module ${requiredFile} in extensions/shared/, found: ${bridgeFiles.join(", ")}`,
      );
    }

    // Guard against stale allowlist entries.
    for (const allowedFile of PROCESS_WIDE_SINGLETON_ALLOWLIST.keys()) {
      assert.ok(
        bridgeFiles.includes(allowedFile),
        `PROCESS_WIDE_SINGLETON_ALLOWLIST contains non-existent bridge: ${allowedFile}`,
      );
    }

    const allViolations: string[] = [];
    for (const fileName of bridgeFiles) {
      const source = readFileSync(join(SHARED_DIR, fileName), "utf-8");
      const result = auditBridgeSource(fileName, source);
      allViolations.push(...result.violations);
    }

    assert.deepEqual(
      allViolations,
      [],
      `Mutable per-session bridges must key state by sessionId in a Map (or be explicitly allowlisted):\n${allViolations.join("\n")}`,
    );
  });

  it("rejects a single-slot globalThis[Symbol.for(...)] assignment", () => {
    const singleSlot = `
      export const SYM = Symbol.for("pi-config.badBridge");
      export function publish(val: unknown): void {
        (globalThis as Record<symbol, unknown>)[SYM] = val;
      }
    `;
    assert.ok(auditBridgeSource("bad-bridge.ts", singleSlot).violations.length > 0);
  });

  it("rejects a single-slot getter object written to globalThis[Symbol.for(...)]", () => {
    const singleSlotGetter = `
      export const SYM = Symbol.for("pi-config.badGetterBridge");
      export function publish(getVal: () => unknown): void {
        (globalThis as Record<symbol, unknown>)[SYM] = { get current() { return getVal(); } };
      }
    `;
    assert.ok(auditBridgeSource("bad-getter-bridge.ts", singleSlotGetter).violations.length > 0);
  });

  it("rejects a mutable dot-property write on globalThis", () => {
    const dotProp = `
      export function publish(val: unknown): void {
        (globalThis as any).__badSlot = val;
      }
    `;
    assert.ok(auditBridgeSource("bad-dot-bridge.ts", dotProp).violations.length > 0);
  });

  it("rejects Object.assign on globalThis even alongside a valid Map write", () => {
    const mixedAssign = `
      export const SYM = Symbol.for("pi-config.mixedBridge");
      export const SYM2 = Symbol.for("pi-config.secondSlot");
      function getMap(): Map<string, string> {
        const g = globalThis as Record<symbol, unknown>;
        let map = g[SYM];
        if (!(map instanceof Map)) { map = new Map<string, string>(); g[SYM] = map; }
        return map as Map<string, string>;
      }
      export function publish(val: string, sessionKey: string): () => void {
        const map = getMap();
        map.set(sessionKey, val);
        Object.assign(globalThis, { [SYM2]: val });
        return () => { map.delete(sessionKey); };
      }
    `;
    const result = auditBridgeSource("mixed-assign-bridge.ts", mixedAssign);
    assert.ok(result.violations.some((v) => v.includes("Object.assign")));
  });

  it("rejects Object.defineProperty on a globalThis alias alongside a valid Map write", () => {
    const mixedDefine = `
      export const SYM = Symbol.for("pi-config.mixedBridge");
      export const SYM2 = Symbol.for("pi-config.secondSlot");
      function getMap(): Map<string, string> {
        const g = globalThis as Record<symbol, unknown>;
        let map = g[SYM];
        if (!(map instanceof Map)) { map = new Map<string, string>(); g[SYM] = map; }
        return map as Map<string, string>;
      }
      export function publish(val: string, sessionKey: string): () => void {
        const g = globalThis as Record<symbol, unknown>;
        const map = getMap();
        map.set(sessionKey, val);
        Object.defineProperty(g, SYM2, { value: val, configurable: true });
        return () => { map.delete(sessionKey); };
      }
    `;
    const result = auditBridgeSource("mixed-define-bridge.ts", mixedDefine);
    assert.ok(result.violations.some((v) => v.includes("Object.defineProperty")));
  });

  it("rejects Reflect.set on globalThis alongside a valid Map write", () => {
    const mixedReflect = `
      export const SYM = Symbol.for("pi-config.mixedBridge");
      export const SYM2 = Symbol.for("pi-config.secondSlot");
      function getMap(): Map<string, string> {
        const g = globalThis as Record<symbol, unknown>;
        let map = g[SYM];
        if (!(map instanceof Map)) { map = new Map<string, string>(); g[SYM] = map; }
        return map as Map<string, string>;
      }
      export function publish(val: string, sessionKey: string): () => void {
        const map = getMap();
        map.set(sessionKey, val);
        Reflect.set(globalThis, SYM2, val);
        return () => { map.delete(sessionKey); };
      }
    `;
    const result = auditBridgeSource("mixed-reflect-bridge.ts", mixedReflect);
    assert.ok(result.violations.some((v) => v.includes("Reflect.set")));
  });

  it("accepts an explicitly allowlisted process-wide singleton", () => {
    const singleton = `
      export const SYM = Symbol.for("pi-config.singletonBridge");
      export function publish(val: unknown): void {
        (globalThis as Record<symbol, unknown>)[SYM] = val;
      }
    `;
    const result = auditBridgeSource(
      "singleton-bridge.ts",
      singleton,
      new Map([["singleton-bridge.ts", "process-wide singleton justification"]]),
    );
    assert.deepEqual(result.violations, []);
  });

  it("accepts a Map-keyed per-session bridge", () => {
    const mapKeyed = `
      export const SYM = Symbol.for("pi-config.goodBridge");
      function getMap(): Map<string, string> {
        const g = globalThis as Record<symbol, unknown>;
        let map = g[SYM];
        if (!(map instanceof Map)) {
          map = new Map<string, string>();
          g[SYM] = map;
        }
        return map as Map<string, string>;
      }
      export function setVal(val: string, sessionKey: string): () => void {
        const map = getMap();
        map.set(sessionKey, val);
        return () => { map.delete(sessionKey); };
      }
    `;
    assert.deepEqual(auditBridgeSource("good-bridge.ts", mapKeyed).violations, []);
  });
});

describe("extensions/shared/*-bridge.ts runtime multi-session isolation (#1337, #1364)", () => {
  afterEach(() => {
    resetSessionBridge();
  });

  it("isolates workload slot per session inside the single globalThis Map", () => {
    const sourcesA = {
      agents: () => [{ id: "a1", agent: "worker", task: "A", status: "running", startedAt: 1 }],
      crons: () => [],
    };
    const sourcesB = {
      agents: () => [{ id: "b1", agent: "worker", task: "B", status: "running", startedAt: 2 }],
      crons: () => [],
    };

    const unregA = publishWorkloadSources(sourcesA, "sess-a");
    publishWorkloadSources(sourcesB, "sess-b");

    assert.ok((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL] instanceof Map);
    assert.equal(publishedWorkloadSources("sess-a")?.agents()[0].id, "a1");
    assert.equal(publishedWorkloadSources("sess-b")?.agents()[0].id, "b1");
    assert.equal(publishedWorkloadSources("sess-unknown"), null);
    assert.equal(publishedWorkloadSources(), null);

    unregA();
    assert.equal(publishedWorkloadSources("sess-a"), null);
    assert.equal(publishedWorkloadSources("sess-b")?.agents()[0].id, "b1");

    resetSessionBridge("sess-b", { slot: "workload" });
    assert.equal((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL], undefined);
  });

  it("isolates taskStore slot per session inside the single globalThis Map", () => {
    const storeA = { id: "store-a" };
    const storeB = { id: "store-b" };
    const callsA: string[] = [];
    const callsB: string[] = [];

    const unregStoreA = publishTaskStore(() => storeA, "sess-a");
    publishTaskStore(() => storeB, "sess-b");
    const unregTelA = publishTaskTelemetryActive((id) => callsA.push(id), "sess-a");
    publishTaskTelemetryActive((id) => callsB.push(id), "sess-b");

    assert.ok((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL] instanceof Map);
    assert.equal(publishedTaskStore("sess-a"), storeA);
    assert.equal(publishedTaskStore("sess-b"), storeB);
    assert.equal(publishedTaskStore("sess-unknown"), null);
    assert.equal(publishedTaskStore(), null);

    publishedTaskTelemetryActive("sess-a")?.("1");
    publishedTaskTelemetryActive("sess-b")?.("2");
    assert.deepEqual(callsA, ["1"]);
    assert.deepEqual(callsB, ["2"]);
    assert.equal(publishedTaskTelemetryActive(), null);

    unregStoreA();
    unregTelA();
    assert.equal(publishedTaskStore("sess-a"), null);
    assert.equal(publishedTaskStore("sess-b"), storeB);
    assert.equal(publishedTaskTelemetryActive("sess-a"), null);
    assert.ok(publishedTaskTelemetryActive("sess-b"));

    resetSessionBridge("sess-b", { slot: "taskStore" });
    assert.equal((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL], undefined);
  });

  it("isolates malformedRecovery slot across concurrent sessions", () => {
    const abortedA: number[] = [];
    const abortedB: number[] = [];
    const unregCoordA = registerRecoveryCoordinator(() => true, "sess-a");
    const unregCoordB = registerRecoveryCoordinator(() => false, "sess-b");
    const unregAbortA = onMalformedRecoveryAborted(() => abortedA.push(1), "sess-a");
    const unregAbortB = onMalformedRecoveryAborted(() => abortedB.push(1), "sess-b");

    assert.ok((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL] instanceof Map);
    markRecoveryPending(true, "sess-a");

    assert.equal(shouldDeferForMalformedRecovery([], "sess-a"), true);
    assert.equal(shouldDeferForMalformedRecovery([], "sess-b"), false);
    assert.equal(shouldDeferForMalformedRecovery(undefined, "sess-a"), true);
    assert.equal(shouldDeferForMalformedRecovery(undefined, "sess-b"), false);

    notifyMalformedRecoveryAborted("sess-a");
    assert.deepEqual(abortedA, [1]);
    assert.deepEqual(abortedB, []);

    unregCoordA();
    unregCoordB();
    unregAbortA();
    unregAbortB();
    markRecoveryPending(false, "sess-a");
    assert.equal((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL], undefined);
  });

  it("isolates comsActive slot across concurrent sessions", () => {
    setComsActive(true, "sess-a");
    assert.equal(isComsActive("sess-a"), true);
    assert.equal(isComsActive("sess-b"), false);
    assert.equal(isComsActive(), false);

    setComsActive(true, "sess-b");
    setComsActive(false, "sess-a");
    assert.equal(isComsActive("sess-a"), false);
    assert.equal(isComsActive("sess-b"), true);

    setComsActive(false, "sess-b");
    assert.equal(isComsActive("sess-b"), false);
    assert.equal((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL], undefined);
  });

  it("preserves sibling slots on the same session when one slot clears", () => {
    const storeA = { id: "store-a" };
    publishTaskStore(() => storeA, "sess-a");
    setComsActive(true, "sess-a");
    const unregCoord = registerRecoveryCoordinator(() => true, "sess-a");

    resetSessionBridge("sess-a", { slot: "taskStore" });
    assert.equal(publishedTaskStore("sess-a"), null);
    assert.equal(isComsActive("sess-a"), true);
    assert.equal(shouldDeferForMalformedRecovery([], "sess-a"), true);

    setComsActive(false, "sess-a");
    unregCoord();
    assert.equal((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL], undefined);
  });

  it("clears all four slots for one session via resetSessionBridge without affecting siblings", () => {
    publishTaskStore(() => ({ id: "a" }), "sess-a");
    publishWorkloadSources({ agents: () => [], crons: () => [] }, "sess-a");
    markRecoveryPending(true, "sess-a");
    setComsActive(true, "sess-a");
    setComsActive(true, "sess-b");

    resetSessionBridge("sess-a");
    assert.equal(publishedTaskStore("sess-a"), null);
    assert.equal(publishedWorkloadSources("sess-a"), null);
    assert.equal(shouldDeferForMalformedRecovery(undefined, "sess-a"), false);
    assert.equal(isComsActive("sess-a"), false);
    assert.equal(isComsActive("sess-b"), true);

    resetSessionBridge("sess-b");
    assert.equal((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL], undefined);
  });

  it("resets all sessions in one call via resetSessionBridge", () => {
    publishTaskStore(() => ({ id: "a" }), "sess-a");
    publishWorkloadSources({ agents: () => [], crons: () => [] }, "sess-b");
    markRecoveryPending(true, "sess-c");
    setComsActive(true, "sess-d");

    resetSessionBridge();
    assert.equal((globalThis as Record<symbol, unknown>)[SESSION_BRIDGE_SYMBOL], undefined);
    assert.equal(publishedTaskStore("sess-a"), null);
    assert.equal(publishedWorkloadSources("sess-b"), null);
    assert.equal(shouldDeferForMalformedRecovery(undefined, "sess-c"), false);
    assert.equal(isComsActive("sess-d"), false);
  });

  it("ui-bridge leaves globalThis untouched when marking browser dispatch contexts", () => {
    const beforeSymbols = Object.getOwnPropertySymbols(globalThis).length;
    const ctxCopyA = { hasUI: true };
    const ctxCopyB = { hasUI: true };
    markBrowserDispatch(ctxCopyA);
    assert.equal(isBrowserDispatch(ctxCopyA), true);
    assert.equal(isBrowserDispatch(ctxCopyB), false);
    assert.equal(Object.getOwnPropertySymbols(globalThis).length, beforeSymbols);
  });

  it("ui-bridge isolates responses across concurrent session event buses", async () => {
    const makeSessionPi = () => {
      const bus = new EventEmitter();
      const emitted: Array<{ channel: string; payload: any }> = [];
      return {
        bus,
        emitted,
        pi: {
          events: {
            on(channel: string, fn: (data: unknown) => void) {
              bus.on(channel, fn);
              return () => bus.off(channel, fn);
            },
            emit(channel: string, data?: unknown) {
              emitted.push({ channel, payload: data });
              bus.emit(channel, data);
            },
          },
        } as any,
      };
    };

    const sessA = makeSessionPi();
    const sessB = makeSessionPi();
    const uiA = createBridgedUi(sessA.pi);
    const uiB = createBridgedUi(sessB.pi);

    const makeCustomCtx = () => ({
      hasUI: true,
      ui: {
        custom: (factory: any) =>
          new Promise((resolve) => {
            factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_c: string, s: string) => s }, {}, resolve);
          }),
      },
    });

    const pA = uiA.select(makeCustomCtx(), "Pick A", ["alpha", "beta"]);
    const pB = uiB.select(makeCustomCtx(), "Pick B", ["one", "two"]);

    const reqA = sessA.emitted.find((e) => e.channel === "pidash:ui-request")?.payload;
    const reqB = sessB.emitted.find((e) => e.channel === "pidash:ui-request")?.payload;
    assert.ok(reqA && reqB);

    // Cross-session emission on B's bus with A's request id must not resolve A.
    sessB.bus.emit("pidash:ui-response", { id: reqA.id, value: "alpha" });
    sessB.bus.emit("pidash:ui-response", { id: reqB.id, value: "two" });
    sessA.bus.emit("pidash:ui-response", { id: reqA.id, value: "beta" });

    assert.equal(await pA, "beta");
    assert.equal(await pB, "two");
  });
});
