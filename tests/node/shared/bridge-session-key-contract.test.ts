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
  MALFORMED_RECOVERY_BRIDGE_SYMBOL,
  markRecoveryPending,
  notifyMalformedRecoveryAborted,
  onMalformedRecoveryAborted,
  registerRecoveryCoordinator,
  resetMalformedRecoveryBridgeForTests,
  shouldDeferForMalformedRecovery,
} from "../../../extensions/shared/malformed-recovery-bridge.ts";
import {
  TASK_STORE_SYMBOL,
  TASK_TELEMETRY_ACTIVE_SYMBOL,
  clearTaskStore,
  clearTaskTelemetryActive,
  publishTaskStore,
  publishTaskTelemetryActive,
  publishedTaskStore,
  publishedTaskTelemetryActive,
  resetTaskStoreBridgeForTests,
} from "../../../extensions/shared/task-store-bridge.ts";
import {
  createBridgedUi,
  isBrowserDispatch,
  markBrowserDispatch,
} from "../../../extensions/shared/ui-bridge.ts";
import {
  WORKLOAD_SOURCES_SYMBOL,
  clearWorkloadSources,
  publishWorkloadSources,
  publishedWorkloadSources,
  resetWorkloadBridgeForTests,
} from "../../../extensions/shared/workload-bridge.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "../../..");
const SHARED_DIR = join(REPO_ROOT, "extensions/shared");

/**
 * Explicit allowlist for `extensions/shared/*-bridge.ts` files that intentionally store a
 * process-wide singleton on `globalThis`. Every entry must carry a concrete justification
 * explaining why concurrent sessions in `pi-sidecar` cannot conflict on it.
 */
const PROCESS_WIDE_SINGLETON_ALLOWLIST: ReadonlyMap<string, string> = new Map();

/** Strip JS/TS comments while preserving string, template, and regex-safe literals. */
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
 * Audit one `*-bridge.ts` source string for un-allowlisted single-slot `globalThis` bindings.
 * Exported only via local testing below to prove the guardrail catches regressions.
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

  // Detect non-computed property assignments like `globalThis.__foo = ...`
  const dotWriteRe = new RegExp(`(?:\\(\\s*)?\\b(?:${aliasPattern})\\b(?:\\s+as\\s+[^)]+\\))?\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*=[^=]`, "g");
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
    const bridgeFiles = readdirSync(SHARED_DIR)
      .filter((name) => name.endsWith("-bridge.ts"))
      .sort();

    assert.ok(bridgeFiles.length >= 4, `expected at least 4 bridge files, found: ${bridgeFiles.join(", ")}`);

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

  it("rejects synthetic single-slot globalThis[Symbol.for(...)] bridges and accepts allowlisted or Map-keyed ones", () => {
    const singleSlot = `
      export const SYM = Symbol.for("pi-config.badBridge");
      export function publish(val: unknown): void {
        (globalThis as Record<symbol, unknown>)[SYM] = val;
      }
    `;
    const singleSlotResult = auditBridgeSource("bad-bridge.ts", singleSlot);
    assert.ok(singleSlotResult.violations.length > 0, "single-slot globalThis write must fail audit");

    const singleSlotGetter = `
      export const SYM = Symbol.for("pi-config.badGetterBridge");
      export function publish(getVal: () => unknown): void {
        (globalThis as Record<symbol, unknown>)[SYM] = { get current() { return getVal(); } };
      }
    `;
    assert.ok(
      auditBridgeSource("bad-getter-bridge.ts", singleSlotGetter).violations.length > 0,
      "single-slot getter object on globalThis must fail audit",
    );

    const dotProp = `
      export function publish(val: unknown): void {
        (globalThis as any).__badSlot = val;
      }
    `;
    assert.ok(
      auditBridgeSource("bad-dot-bridge.ts", dotProp).violations.length > 0,
      "mutable dot-property on globalThis must fail audit",
    );

    const allowlisted = auditBridgeSource(
      "singleton-bridge.ts",
      singleSlot,
      new Map([["singleton-bridge.ts", "process-wide singleton justification"]]),
    );
    assert.deepEqual(allowlisted.violations, [], "explicitly allowlisted singleton must pass");

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
    assert.deepEqual(
      auditBridgeSource("good-bridge.ts", mapKeyed).violations,
      [],
      "Map-keyed per-session bridge must pass",
    );
  });
});

describe("extensions/shared/*-bridge.ts runtime multi-session isolation (#1337)", () => {
  afterEach(() => {
    resetWorkloadBridgeForTests();
    resetTaskStoreBridgeForTests();
    resetMalformedRecoveryBridgeForTests();
  });

  it("workload-bridge stores a Map on globalThis and isolates concurrent sessions", () => {
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

    assert.ok(
      (globalThis as Record<symbol, unknown>)[WORKLOAD_SOURCES_SYMBOL] instanceof Map,
      "workload bridge must store a Map on globalThis",
    );
    assert.equal(publishedWorkloadSources("sess-a")?.agents()[0].id, "a1");
    assert.equal(publishedWorkloadSources("sess-b")?.agents()[0].id, "b1");
    assert.equal(publishedWorkloadSources("sess-unknown"), null);
    assert.equal(publishedWorkloadSources(), null, "un-keyed lookup must not guess across concurrent sessions");

    unregA();
    assert.equal(publishedWorkloadSources("sess-a"), null);
    assert.equal(publishedWorkloadSources("sess-b")?.agents()[0].id, "b1");

    clearWorkloadSources("sess-b");
    assert.equal(publishedWorkloadSources("sess-b"), null);
    assert.equal((globalThis as Record<symbol, unknown>)[WORKLOAD_SOURCES_SYMBOL], undefined);
  });

  it("task-store-bridge stores Maps on globalThis and isolates concurrent sessions", () => {
    const storeA = { id: "store-a" };
    const storeB = { id: "store-b" };
    const callsA: string[] = [];
    const callsB: string[] = [];

    const unregStoreA = publishTaskStore(() => storeA, "sess-a");
    publishTaskStore(() => storeB, "sess-b");
    const unregTelA = publishTaskTelemetryActive((id) => callsA.push(id), "sess-a");
    publishTaskTelemetryActive((id) => callsB.push(id), "sess-b");

    assert.ok((globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL] instanceof Map);
    assert.ok((globalThis as Record<symbol, unknown>)[TASK_TELEMETRY_ACTIVE_SYMBOL] instanceof Map);

    assert.equal(publishedTaskStore("sess-a"), storeA);
    assert.equal(publishedTaskStore("sess-b"), storeB);
    assert.equal(publishedTaskStore("sess-unknown"), null);
    assert.equal(publishedTaskStore(), null, "un-keyed store lookup must not guess across concurrent sessions");

    publishedTaskTelemetryActive("sess-a")?.("1");
    publishedTaskTelemetryActive("sess-b")?.("2");
    assert.deepEqual(callsA, ["1"]);
    assert.deepEqual(callsB, ["2"]);
    assert.equal(publishedTaskTelemetryActive(), null, "un-keyed telemetry lookup must not guess across concurrent sessions");

    unregStoreA();
    unregTelA();
    assert.equal(publishedTaskStore("sess-a"), null);
    assert.equal(publishedTaskStore("sess-b"), storeB);
    assert.equal(publishedTaskTelemetryActive("sess-a"), null);
    assert.ok(publishedTaskTelemetryActive("sess-b"));

    clearTaskStore("sess-b");
    clearTaskTelemetryActive("sess-b");
    assert.equal((globalThis as Record<symbol, unknown>)[TASK_STORE_SYMBOL], undefined);
    assert.equal((globalThis as Record<symbol, unknown>)[TASK_TELEMETRY_ACTIVE_SYMBOL], undefined);
  });

  it("malformed-recovery-bridge stores a Map on globalThis and isolates concurrent sessions", () => {
    const abortedA: number[] = [];
    const abortedB: number[] = [];
    const unregCoordA = registerRecoveryCoordinator(() => true, "sess-a");
    const unregCoordB = registerRecoveryCoordinator(() => false, "sess-b");
    const unregAbortA = onMalformedRecoveryAborted(() => abortedA.push(1), "sess-a");
    const unregAbortB = onMalformedRecoveryAborted(() => abortedB.push(1), "sess-b");

    assert.ok((globalThis as Record<symbol, unknown>)[MALFORMED_RECOVERY_BRIDGE_SYMBOL] instanceof Map);
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
  });

  it("ui-bridge keeps no globalThis state and isolates concurrent session event buses", async () => {
    const beforeSymbols = Object.getOwnPropertySymbols(globalThis).length;
    const ctxCopyA = { hasUI: true };
    const ctxCopyB = { hasUI: true };
    markBrowserDispatch(ctxCopyA);
    assert.equal(isBrowserDispatch(ctxCopyA), true);
    assert.equal(isBrowserDispatch(ctxCopyB), false);
    assert.equal(Object.getOwnPropertySymbols(globalThis).length, beforeSymbols);

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
