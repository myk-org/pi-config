import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AgentSessionRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntimeDiagnostic,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import { logger } from "../../src/logger.js";
import {
  PiProviderRuntime,
  SessionStore,
  createApiKeyRedactor,
  logUnreportedRuntimeDiagnostics,
} from "../../src/sessions.js";
import { makeTempDir } from "./helpers/temp-dirs.js";

function stubLogger(): {
  calls: { level: "debug" | "info" | "warn" | "error"; args: unknown[] }[];
  restore: () => void;
} {
  const orig = {
    debug: logger.debug,
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
  };
  const calls: { level: "debug" | "info" | "warn" | "error"; args: unknown[] }[] = [];
  logger.debug = (...args: unknown[]) => {
    calls.push({ level: "debug", args });
  };
  logger.info = (...args: unknown[]) => {
    calls.push({ level: "info", args });
  };
  logger.warn = (...args: unknown[]) => {
    calls.push({ level: "warn", args });
  };
  logger.error = (...args: unknown[]) => {
    calls.push({ level: "error", args });
  };
  return {
    calls,
    restore: () => {
      logger.debug = orig.debug;
      logger.info = orig.info;
      logger.warn = orig.warn;
      logger.error = orig.error;
    },
  };
}

function diagnosticCalls(
  calls: { level: "debug" | "info" | "warn" | "error"; args: unknown[] }[],
): { level: "debug" | "info" | "warn" | "error"; line: string }[] {
  return calls
    .filter(
      (c) =>
        typeof c.args[0] === "string" &&
        c.args[0].startsWith("[sidecar] INTERNAL_RUNTIME_DIAGNOSTIC:"),
    )
    .map((c) => ({ level: c.level, line: c.args[0] as string }));
}

function makeStubSession(): AgentSession {
  return {
    sessionFile: undefined,
    sessionManager: SessionManager.inMemory("/tmp"),
    extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession;
}

function makeStubServices(): AgentSessionServices {
  return {
    cwd: "/tmp",
    agentDir: "/tmp",
  } as unknown as AgentSessionServices;
}

describe("logUnreportedRuntimeDiagnostics", () => {
  it("logs each diagnostic once with mapped levels and skips duplicates on subsequent drains", () => {
    const initial: AgentSessionRuntimeDiagnostic[] = [
      { type: "error", message: 'Failed to load extension "/ext/a.ts": boom' },
      { type: "warning", message: "Unmatched enabledModels pattern: foo/*" },
      { type: "info", message: "Using fallback provider catalog" },
      // Duplicate of an earlier entry in the same batch must also only log once.
      { type: "warning", message: "Unmatched enabledModels pattern: foo/*" },
    ];
    const factory: CreateAgentSessionRuntimeFactory = async () => {
      throw new Error("not expected");
    };
    const runtime = new AgentSessionRuntime(
      makeStubSession(),
      makeStubServices(),
      factory,
      initial,
    );

    const stub = stubLogger();
    try {
      const firstCount = logUnreportedRuntimeDiagnostics(runtime);
      assert.equal(firstCount, 3);
      assert.deepEqual(diagnosticCalls(stub.calls), [
        {
          level: "error",
          line: '[sidecar] INTERNAL_RUNTIME_DIAGNOSTIC: type=error, message=Failed to load extension "/ext/a.ts": boom',
        },
        {
          level: "warn",
          line: "[sidecar] INTERNAL_RUNTIME_DIAGNOSTIC: type=warning, message=Unmatched enabledModels pattern: foo/*",
        },
        {
          level: "debug",
          line: "[sidecar] INTERNAL_RUNTIME_DIAGNOSTIC: type=info, message=Using fallback provider catalog",
        },
      ]);

      // Even though runtime.diagnostics still retains all entries, a second drain logs nothing.
      assert.equal(runtime.diagnostics.length, 4);
      stub.calls.length = 0;
      const secondCount = logUnreportedRuntimeDiagnostics(runtime);
      assert.equal(secondCount, 0);
      assert.deepEqual(diagnosticCalls(stub.calls), []);
    } finally {
      stub.restore();
    }
  });

  it("logs only newly surfaced diagnostics after session replacement without duplicating prior ones", async () => {
    const initial: AgentSessionRuntimeDiagnostic[] = [
      { type: "warning", message: "Unmatched enabledModels pattern: old/*" },
    ];
    const nextDiagnostics: AgentSessionRuntimeDiagnostic[] = [
      { type: "warning", message: "Unmatched enabledModels pattern: old/*" },
      { type: "error", message: 'Failed to load extension "/ext/reloaded.ts": syntax error' },
    ];
    const factory: CreateAgentSessionRuntimeFactory = async () => ({
      session: makeStubSession(),
      extensionsResult: {} as never,
      services: makeStubServices(),
      diagnostics: nextDiagnostics,
    });
    const runtime = new AgentSessionRuntime(
      makeStubSession(),
      makeStubServices(),
      factory,
      initial,
    );

    const stub = stubLogger();
    try {
      assert.equal(logUnreportedRuntimeDiagnostics(runtime), 1);
      assert.deepEqual(diagnosticCalls(stub.calls), [
        {
          level: "warn",
          line: "[sidecar] INTERNAL_RUNTIME_DIAGNOSTIC: type=warning, message=Unmatched enabledModels pattern: old/*",
        },
      ]);

      stub.calls.length = 0;
      await runtime.newSession();
      assert.equal(logUnreportedRuntimeDiagnostics(runtime), 1);
      assert.deepEqual(diagnosticCalls(stub.calls), [
        {
          level: "error",
          line: '[sidecar] INTERNAL_RUNTIME_DIAGNOSTIC: type=error, message=Failed to load extension "/ext/reloaded.ts": syntax error',
        },
      ]);

      stub.calls.length = 0;
      assert.equal(logUnreportedRuntimeDiagnostics(runtime), 0);
      assert.deepEqual(diagnosticCalls(stub.calls), []);
    } finally {
      stub.restore();
    }
  });

  it("redacts secrets and omits oversized diagnostic messages", () => {
    const secret = "sk-test/diag+secret 1312"; // pragma: allowlist secret — synthetic test credential
    const encoded = encodeURIComponent(secret);
    assert.notEqual(encoded, secret);
    const oversized = `prefix ${secret} ${"x".repeat(20_000)}`;
    const runtime = new AgentSessionRuntime(
      makeStubSession(),
      makeStubServices(),
      async () => {
        throw new Error("not expected");
      },
      [
        { type: "error", message: `Upstream error with ${secret} and ${encoded}` },
        { type: "warning", message: oversized },
      ],
    );

    const stub = stubLogger();
    try {
      const count = logUnreportedRuntimeDiagnostics(runtime, createApiKeyRedactor(secret));
      assert.equal(count, 2);
      const logged = diagnosticCalls(stub.calls);
      assert.equal(logged.length, 2);
      assert.equal(
        logged[0].line,
        "[sidecar] INTERNAL_RUNTIME_DIAGNOSTIC: type=error, message=Upstream error with [REDACTED] and [REDACTED]",
      );
      assert.equal(
        logged[1].line,
        "[sidecar] INTERNAL_RUNTIME_DIAGNOSTIC: type=warning, message=[oversized diagnostic omitted]",
      );
      for (const entry of logged) {
        assert.ok(!entry.line.includes(secret), "raw secret must not appear in logs");
        assert.ok(!entry.line.includes(encoded), "encoded secret must not appear in logs");
      }
    } finally {
      stub.restore();
    }
  });

  it("SessionStore.ensureInternalRuntime() drains diagnostics via takeUnreportedDiagnostics()", async () => {
    const tempDir = makeTempDir("sidecar-diag-1312-");
    const extDir = join(tempDir, "extensions", "broken-diag-ext");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "index.ts"),
      'throw new Error("synthetic extension load failure 1312");\n',
    );

    const runtime = new PiProviderRuntime({ agentDir: tempDir });
    const store = new SessionStore({ runtime });
    const stub = stubLogger();
    try {
      await store.getProviders();
      const initialLogged = diagnosticCalls(stub.calls);
      assert.ok(
        initialLogged.some(
          (entry) =>
            entry.level === "error" &&
            entry.line.includes("synthetic extension load failure 1312"),
        ),
        `expected broken extension diagnostic to be logged once, got: ${JSON.stringify(initialLogged)}`,
      );

      // Draining the same internalRuntime again must produce zero duplicates, proving
      // ensureInternalRuntime() consumed takeUnreportedDiagnostics() rather than reading .diagnostics.
      stub.calls.length = 0;
      assert.ok(runtime.getInternalDiagnostics().length > 0, "runtime should retain diagnostics list");
      assert.equal(runtime.drainUnreportedDiagnostics(), 0);
      assert.deepEqual(diagnosticCalls(stub.calls), []);
    } finally {
      stub.restore();
      await store.disposeAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
