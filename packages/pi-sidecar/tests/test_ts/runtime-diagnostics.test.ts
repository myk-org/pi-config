import { after, before, describe, it } from "node:test";
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
  collectServiceDiagnostics,
  createApiKeyRedactor,
  logUnreportedRuntimeDiagnostics,
  redactDiagnosticSecrets,
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

describe("collectServiceDiagnostics", () => {
  it("returns an empty array when services.diagnostics is absent", () => {
    assert.deepEqual(collectServiceDiagnostics({}), []);
  });

  it("preserves Pi 1.7.0 services.diagnostics warnings without duplicating modelRuntime.getError()", () => {
    const rawError = "Invalid models.json schema:\n  - providers.acme.models.0.contextWindow: must be number";
    const result = collectServiceDiagnostics({
      diagnostics: [{ type: "warning", message: `models.json error: ${rawError}` }],
      modelRuntime: { getError: () => rawError },
    });
    assert.deepEqual(result, [
      { type: "warning", message: `models.json error: ${rawError}` },
    ]);
  });

  it("backfills modelRuntime.getError() as a warning when services.diagnostics omits it", () => {
    const rawError = "Invalid models.json schema:\n  - providers.acme.models.0.contextWindow: must be number";
    const result = collectServiceDiagnostics({
      diagnostics: [],
      modelRuntime: { getError: () => rawError },
    });
    assert.deepEqual(result, [
      { type: "warning", message: `models.json error: ${rawError}` },
    ]);
  });

  it("ignores malformed diagnostic entries and appends extension load errors", () => {
    const result = collectServiceDiagnostics({
      diagnostics: [
        null,
        { type: "unknown", message: "skip me" },
        { type: "warning", message: 123 },
        { type: "warning", message: "kept warning" },
      ],
      resourceLoader: {
        getExtensions: () => ({
          errors: [{ path: "/ext/broken.ts", error: "syntax error" }],
        }),
      },
    });
    assert.deepEqual(result, [
      { type: "warning", message: "kept warning" },
      { type: "error", message: 'Failed to load extension "/ext/broken.ts": syntax error' },
    ]);
  });

  it("redacts inline credentials while preserving schema field paths", () => {
    const raw = [
      'Failed parsing {"apiKey": "literal-secret-1489"}', // pragma: allowlist secret — synthetic test credential
      "endpoint https://alice:s3cr3t@example.com/v1", // pragma: allowlist secret — synthetic test credential
      "Authorization: Bearer tok-1489-secret", // pragma: allowlist secret — synthetic test credential
      "x-api-key: raw-header-secret-1489", // pragma: allowlist secret — synthetic test credential
      "providers.acme.apiKey: must be string",
      "providers.acme.headers.Authorization: must be string",
    ].join("\n");

    const scrubbed = redactDiagnosticSecrets(raw);
    assert.ok(!scrubbed.includes("literal-secret-1489"), "JSON apiKey literal must be redacted");
    assert.ok(!scrubbed.includes("alice:s3cr3t"), "URL userinfo must be redacted");
    assert.ok(!scrubbed.includes("tok-1489-secret"), "Bearer token must be redacted");
    assert.ok(!scrubbed.includes("raw-header-secret-1489"), "x-api-key header must be redacted");
    assert.ok(
      scrubbed.includes("providers.acme.apiKey: must be string"),
      "dotted apiKey schema path must be preserved",
    );
    assert.ok(
      scrubbed.includes("providers.acme.headers.Authorization: must be string"),
      "dotted headers.Authorization schema path must be preserved",
    );
  });
});

describe("models.json startup and refresh diagnostics", { concurrency: false }, () => {
  let offline: string | undefined;

  before(() => {
    offline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
  });
  after(() => {
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  });

  it("logs and retains a warning when models.json has a string contextWindow while still serving built-in providers", async () => {
    const tempDir = makeTempDir("sidecar-diag-1489-schema-");
    writeFileSync(
      join(tempDir, "models.json"),
      JSON.stringify({
        providers: {
          "acme-bad-1489": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "test-key-1489", // pragma: allowlist secret — synthetic test credential
            models: [{ id: "m1", name: "M1", contextWindow: "32000" }],
          },
        },
      }),
    );

    const store = new SessionStore({ agentDir: tempDir });
    const stub = stubLogger();
    try {
      const providers = await store.getProviders();
      assert.ok(providers.length > 0, "built-in providers should still be served");

      const warnings = diagnosticCalls(stub.calls).filter((entry) => entry.level === "warn");
      assert.ok(
        warnings.some(
          (entry) =>
            entry.line.includes("models.json error:") && entry.line.includes("contextWindow"),
        ),
        `expected models.json contextWindow warning log, got: ${JSON.stringify(warnings)}`,
      );

      const retained = store.getInternalDiagnostics();
      assert.ok(
        retained.some(
          (diag) =>
            diag.type === "warning" &&
            diag.message.includes("models.json error:") &&
            diag.message.includes("contextWindow"),
        ),
        `expected retained models.json warning, got: ${JSON.stringify(retained)}`,
      );
    } finally {
      stub.restore();
      await store.disposeAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("logs and retains a warning when models.json has invalid JSON syntax", async () => {
    const tempDir = makeTempDir("sidecar-diag-1489-syntax-");
    writeFileSync(join(tempDir, "models.json"), "{ providers: broken");

    const store = new SessionStore({ agentDir: tempDir });
    const stub = stubLogger();
    try {
      await store.getProviders();
      const warnings = diagnosticCalls(stub.calls).filter((entry) => entry.level === "warn");
      assert.ok(
        warnings.some((entry) => entry.line.includes("models.json error:")),
        `expected models.json syntax warning log, got: ${JSON.stringify(warnings)}`,
      );
      assert.ok(
        store
          .getInternalDiagnostics()
          .some((diag) => diag.type === "warning" && diag.message.includes("models.json error:")),
        "expected retained models.json syntax warning",
      );
    } finally {
      stub.restore();
      await store.disposeAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("logs a structured warning during refreshModels() when models.json becomes invalid after startup", async () => {
    const tempDir = makeTempDir("sidecar-diag-1489-refresh-");
    writeFileSync(
      join(tempDir, "models.json"),
      JSON.stringify({
        providers: {
          "acme-refresh-1489": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "test-key-1489", // pragma: allowlist secret — synthetic test credential
            models: [{ id: "m1", name: "M1", contextWindow: 32000 }],
          },
        },
      }),
    );

    const store = new SessionStore({ agentDir: tempDir });
    const stub = stubLogger();
    try {
      await store.refreshModels();
      assert.deepEqual(store.getInternalDiagnostics(), []);

      writeFileSync(
        join(tempDir, "models.json"),
        JSON.stringify({
          providers: {
            "acme-refresh-1489": {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              apiKey: "test-key-1489", // pragma: allowlist secret — synthetic test credential
              models: [{ id: "m1", name: "M1", contextWindow: "32000" }],
            },
          },
        }),
      );
      stub.calls.length = 0;

      await store.refreshModels();
      const refreshWarns = stub.calls.filter(
        (c) =>
          c.level === "warn" &&
          c.args[0] === "[internal-runtime-diagnostics]" &&
          c.args[1] === "models.json diagnostic detected during refresh",
      );
      assert.equal(refreshWarns.length, 1, `expected one refresh warning, got: ${JSON.stringify(refreshWarns)}`);
      const meta = refreshWarns[0].args[2] as { type?: string; message?: string };
      assert.equal(meta?.type, "warning");
      assert.ok(
        typeof meta?.message === "string" &&
          meta.message.includes("models.json error:") &&
          meta.message.includes("contextWindow"),
        `expected contextWindow warning in refresh metadata, got: ${JSON.stringify(meta)}`,
      );
    } finally {
      stub.restore();
      await store.disposeAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("updates getInternalDiagnostics() when models.json becomes invalid or changes error on refreshModels()", async () => {
    const tempDir = makeTempDir("sidecar-diag-1489-refresh-getter-");
    const modelsPath = join(tempDir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          "acme-refresh-getter": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "test-key-1489", // pragma: allowlist secret — synthetic test credential
            models: [{ id: "m1", name: "M1", contextWindow: 32000 }],
          },
        },
      }),
    );

    const store = new SessionStore({ agentDir: tempDir });
    const stub = stubLogger();
    try {
      await store.refreshModels();
      assert.deepEqual(store.getInternalDiagnostics(), []);

      // Break models.json with a schema error and refresh.
      writeFileSync(
        modelsPath,
        JSON.stringify({
          providers: {
            "acme-refresh-getter": {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              apiKey: "test-key-1489", // pragma: allowlist secret — synthetic test credential
              models: [{ id: "m1", name: "M1", contextWindow: "32000" }],
            },
          },
        }),
      );
      await store.refreshModels();
      const afterSchemaError = store.getInternalDiagnostics();
      assert.equal(afterSchemaError.length, 1);
      assert.equal(afterSchemaError[0].type, "warning");
      assert.ok(
        afterSchemaError[0].message.includes("models.json error:") &&
          afterSchemaError[0].message.includes("contextWindow"),
        `expected contextWindow warning in getInternalDiagnostics(), got: ${JSON.stringify(afterSchemaError)}`,
      );

      // Replace with a syntax error and verify the getter reflects only the latest error.
      writeFileSync(modelsPath, "{ providers: broken");
      await store.refreshModels();
      const afterSyntaxError = store.getInternalDiagnostics();
      assert.equal(afterSyntaxError.length, 1);
      assert.equal(afterSyntaxError[0].type, "warning");
      assert.ok(
        afterSyntaxError[0].message.includes("models.json error:") &&
          !afterSyntaxError[0].message.includes("contextWindow"),
        `expected updated syntax warning without stale schema warning, got: ${JSON.stringify(afterSyntaxError)}`,
      );
    } finally {
      stub.restore();
      await store.disposeAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears models.json warnings from getInternalDiagnostics() on a clean refresh while preserving extension errors", async () => {
    const tempDir = makeTempDir("sidecar-diag-1489-refresh-clear-");
    const modelsPath = join(tempDir, "models.json");
    const extDir = join(tempDir, "extensions", "broken-diag-ext-1489");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "index.ts"),
      'throw new Error("synthetic extension load failure 1489");\n',
    );
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          "acme-refresh-clear": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "test-key-1489", // pragma: allowlist secret — synthetic test credential
            models: [{ id: "m1", name: "M1", contextWindow: "32000" }],
          },
        },
      }),
    );

    const store = new SessionStore({ agentDir: tempDir });
    const stub = stubLogger();
    try {
      await store.refreshModels();
      const initial = store.getInternalDiagnostics();
      assert.ok(
        initial.some((d) => d.type === "warning" && d.message.includes("models.json error:")),
        `expected initial models.json warning, got: ${JSON.stringify(initial)}`,
      );
      assert.ok(
        initial.some(
          (d) => d.type === "error" && d.message.includes("synthetic extension load failure 1489"),
        ),
        `expected initial extension error, got: ${JSON.stringify(initial)}`,
      );

      // Fix models.json and refresh: models.json warning clears, extension error remains.
      writeFileSync(
        modelsPath,
        JSON.stringify({
          providers: {
            "acme-refresh-clear": {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              apiKey: "test-key-1489", // pragma: allowlist secret — synthetic test credential
              models: [{ id: "m1", name: "M1", contextWindow: 32000 }],
            },
          },
        }),
      );
      await store.refreshModels();
      const afterFix = store.getInternalDiagnostics();
      assert.ok(
        !afterFix.some((d) => d.type === "warning" && d.message.includes("models.json error:")),
        `expected models.json warning to clear after fix, got: ${JSON.stringify(afterFix)}`,
      );
      assert.ok(
        afterFix.some(
          (d) => d.type === "error" && d.message.includes("synthetic extension load failure 1489"),
        ),
        `expected extension error to remain after clean refresh, got: ${JSON.stringify(afterFix)}`,
      );
    } finally {
      stub.restore();
      await store.disposeAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
