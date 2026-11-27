/**
 * Unit tests for opt-in percentage-based auto-compaction trigger (issue #1486).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  clearSettingsCache,
  getSetting,
  parseSettingInput,
  SETTINGS_KEYS,
  setGlobalSettingsPath,
  validateSetting,
} from "../../../extensions/orchestrator/project-settings.js";
import { NumberInputSubmenu } from "../../../extensions/orchestrator/settings-tui-submenus.js";
import {
  registerAutoCompact,
  resolveAutoCompactUsagePercent,
  type RegisterAutoCompactOptions,
} from "../../../extensions/orchestrator/auto-compact.js";
import type { Logger } from "../../../extensions/shared/logger.js";
import { makeTempDir } from "../helpers/temp-dirs.js";

type Handler = (...args: any[]) => any;

interface RecordedLog {
  level: "debug" | "info" | "warn" | "error";
  args: any[];
}

interface CompactCall {
  onComplete?: (result?: any) => void;
  onError?: (error: Error) => void;
}

const tempDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function createTempProject(settings?: Record<string, unknown>): string {
  const dir = makeTempDir("auto-compact-");
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (settings !== undefined) {
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".pi", "pi-config-settings.json"),
      JSON.stringify(settings),
      "utf-8",
    );
  }
  const globalFile = path.join(dir, "global-settings.json");
  setGlobalSettingsPath(globalFile);
  clearSettingsCache();
  return dir;
}

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  clearSettingsCache();
}

function createFakeLogger(): { logger: Logger; entries: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const logger: Logger = {
    debug: (...args: any[]) => entries.push({ level: "debug", args }),
    info: (...args: any[]) => entries.push({ level: "info", args }),
    warn: (...args: any[]) => entries.push({ level: "warn", args }),
    error: (...args: any[]) => entries.push({ level: "error", args }),
    isDebugEnabled: () => true,
  };
  return { logger, entries };
}

function createHarness(options: RegisterAutoCompactOptions = {}) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as any;

  registerAutoCompact(pi, {
    argv: ["node", "pi"],
    env: {},
    ...options,
  });

  function emit(event: string, payload: any, ctx: any): void {
    for (const handler of handlers.get(event) ?? []) {
      handler(payload, ctx);
    }
  }

  return { emit };
}

function createFakeCtx(opts: {
  cwd: string;
  sessionId?: string;
  mode?: string;
  hasUI?: boolean;
  getUsage: () => any;
  compactImpl?: (call: CompactCall) => void;
  model?: { contextWindow?: number };
}) {
  const compactCalls: CompactCall[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx: any = {
    cwd: opts.cwd,
    mode: opts.mode ?? "tui",
    hasUI: opts.hasUI ?? false,
    model: opts.model,
    sessionManager: {
      getSessionId: () => opts.sessionId ?? "sess-1",
    },
    getContextUsage: () => opts.getUsage(),
    compact: (call: CompactCall = {}) => {
      compactCalls.push(call);
      opts.compactImpl?.(call);
    },
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
    },
  };
  return { ctx, compactCalls, notifications };
}

const fakeTheme: any = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
  setGlobalSettingsPath(null);
  clearSettingsCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("auto_compact_threshold_pct schema validation", () => {
  it("declares auto_compact_threshold_pct under Session with default 0", () => {
    const def = SETTINGS_KEYS.auto_compact_threshold_pct;
    assert.ok(def, "auto_compact_threshold_pct must exist in settings-keys.json");
    assert.equal(def.group, "Session");
    assert.equal(def.type, "int");
    assert.equal(def.env, "PI_AUTO_COMPACT_THRESHOLD_PCT");
    assert.equal(def.default, 0);
    assert.equal(def.min, 20);
    assert.equal(def.max, 99);
    assert.equal(def.allow_zero, true);
  });

  it("accepts 0 as disabled in validateSetting", () => {
    assert.deepEqual(validateSetting("auto_compact_threshold_pct", 0), { ok: true, value: 0 });
  });

  it("accepts boundary value 20 in validateSetting", () => {
    assert.deepEqual(validateSetting("auto_compact_threshold_pct", 20), { ok: true, value: 20 });
  });

  it("accepts boundary value 99 in validateSetting", () => {
    assert.deepEqual(validateSetting("auto_compact_threshold_pct", 99), { ok: true, value: 99 });
  });

  it("rejects value 1 below minimum in validateSetting", () => {
    assert.equal(validateSetting("auto_compact_threshold_pct", 1).ok, false);
  });

  it("rejects value 19 below minimum in validateSetting", () => {
    assert.equal(validateSetting("auto_compact_threshold_pct", 19).ok, false);
  });

  it("rejects negative values in validateSetting", () => {
    assert.equal(validateSetting("auto_compact_threshold_pct", -1).ok, false);
  });

  it("rejects value 100 above maximum in validateSetting", () => {
    assert.equal(validateSetting("auto_compact_threshold_pct", 100).ok, false);
  });

  it("rejects non-integer numbers in validateSetting", () => {
    assert.equal(validateSetting("auto_compact_threshold_pct", 50.5).ok, false);
  });

  it("parses valid threshold input in parseSettingInput", () => {
    assert.deepEqual(parseSettingInput("auto_compact_threshold_pct", "0"), { ok: true, value: 0 });
    assert.deepEqual(parseSettingInput("auto_compact_threshold_pct", "75"), { ok: true, value: 75 });
  });

  it("rejects out-of-range input in parseSettingInput", () => {
    assert.equal(parseSettingInput("auto_compact_threshold_pct", "19").ok, false);
    assert.equal(parseSettingInput("auto_compact_threshold_pct", "100").ok, false);
    assert.equal(parseSettingInput("auto_compact_threshold_pct", "50.5").ok, false);
  });

  it("honors PI_AUTO_COMPACT_THRESHOLD_PCT environment override", () => {
    const cwd = createTempProject();
    setEnv("PI_AUTO_COMPACT_THRESHOLD_PCT", "65");
    assert.equal(getSetting(cwd, "auto_compact_threshold_pct"), 65);
  });

  it("ignores invalid PI_AUTO_COMPACT_THRESHOLD_PCT environment values", () => {
    const cwd = createTempProject();
    setEnv("PI_AUTO_COMPACT_THRESHOLD_PCT", "15");
    assert.equal(getSetting(cwd, "auto_compact_threshold_pct"), 0);
  });

  it("accepts 0 in NumberInputSubmenu for allow_zero settings", () => {
    let submitted: string | undefined;
    const sub = new NumberInputSubmenu(
      "auto_compact_threshold_pct",
      "0",
      SETTINGS_KEYS.auto_compact_threshold_pct,
      fakeTheme,
      (val) => {
        submitted = val;
      },
    );
    sub.handleInput("\r");
    assert.equal(submitted, "0");
  });

  it("rejects 19 in NumberInputSubmenu for allow_zero settings", () => {
    let submitted: string | undefined;
    const sub = new NumberInputSubmenu(
      "auto_compact_threshold_pct",
      "19",
      SETTINGS_KEYS.auto_compact_threshold_pct,
      fakeTheme,
      (val) => {
        submitted = val;
      },
    );
    sub.handleInput("\r");
    assert.equal(submitted, undefined);
    const rendered = sub.render(80).join("\n");
    assert.match(rendered, /0 \(disabled\) or 20-99/);
  });
});

describe("resolveAutoCompactUsagePercent", () => {
  it("returns usage.percent when positive finite", () => {
    const pct = resolveAutoCompactUsagePercent({
      getContextUsage: () => ({ tokens: 50_000, contextWindow: 100_000, percent: 62.5 }),
    });
    assert.equal(pct, 62.5);
  });

  it("falls back to tokens over contextWindow when percent is null", () => {
    const pct = resolveAutoCompactUsagePercent({
      getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: null }),
    });
    assert.equal(pct, 80);
  });

  it("falls back to tokens over contextWindow when percent is 0 with positive tokens", () => {
    const pct = resolveAutoCompactUsagePercent({
      getContextUsage: () => ({ tokens: 75_000, contextWindow: 100_000, percent: 0 }),
    });
    assert.equal(pct, 75);
  });

  it("returns 0 for explicit zero usage", () => {
    const pct = resolveAutoCompactUsagePercent({
      getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
    });
    assert.equal(pct, 0);
  });

  it("returns null when usage is unavailable", () => {
    const pct = resolveAutoCompactUsagePercent({
      getContextUsage: () => ({ tokens: null, contextWindow: 100_000, percent: null }),
    });
    assert.equal(pct, null);
  });
});

describe("registerAutoCompact", () => {
  it("does not trigger compaction when threshold is default 0", () => {
    const cwd = createTempProject();
    const { emit } = createHarness();
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 95_000, contextWindow: 100_000, percent: 95 }),
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 0);
  });

  it("does not trigger compaction when context usage is below threshold", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { emit } = createHarness();
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 79_000, contextWindow: 100_000, percent: 79 }),
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 0);
  });

  it("triggers ctx.compact when context usage meets threshold", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { logger, entries } = createFakeLogger();
    const { emit } = createHarness({ log: logger });
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);
    assert.ok(entries.some((e) => e.level === "info" && e.args[0] === "auto_compact_triggered"));
  });

  it("computes usage from tokens over contextWindow when percent is null", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 70 });
    const { emit } = createHarness();
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 72_000, contextWindow: 100_000, percent: null }),
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);
  });

  it("notifies UI when ctx.hasUI is true", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { emit } = createHarness();
    const { ctx, notifications } = createFakeCtx({
      cwd,
      hasUI: true,
      getUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent: 85 }),
      compactImpl: (call) => call.onComplete?.(),
    });

    emit("agent_end", {}, ctx);
    assert.equal(notifications.length, 2);
    assert.match(notifications[0].message, /85% >= 80%/);
    assert.equal(notifications[0].level, "info");
    assert.match(notifications[1].message, /completed/i);
  });

  it("skips duplicate trigger while compaction is already in flight", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { emit } = createHarness();
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent: 85 }),
    });

    emit("agent_end", {}, ctx);
    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);
  });

  it("suppresses re-triggering after compaction completes without dropping below threshold", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { emit } = createHarness();
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent: 85 }),
      compactImpl: (call) => call.onComplete?.(),
    });

    emit("agent_end", {}, ctx);
    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);
  });

  it("suppresses re-triggering after compaction fails via onError", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { logger, entries } = createFakeLogger();
    const { emit } = createHarness({ log: logger });
    const { ctx, compactCalls, notifications } = createFakeCtx({
      cwd,
      hasUI: true,
      getUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent: 85 }),
      compactImpl: (call) => call.onError?.(new Error("Already compacted")),
    });

    emit("agent_end", {}, ctx);
    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);
    assert.ok(entries.some((e) => e.level === "warn" && e.args[0] === "auto_compact_failed"));
    assert.ok(notifications.some((n) => n.level === "error" && /Already compacted/.test(n.message)));
  });

  it("suppresses re-triggering after ctx.compact throws synchronously", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { emit } = createHarness();
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent: 85 }),
      compactImpl: () => {
        throw new Error("sync failure");
      },
    });

    emit("agent_end", {}, ctx);
    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);
  });

  it("re-arms after usage drops below threshold", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { emit } = createHarness();
    let pct = 85;
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: pct * 1000, contextWindow: 100_000, percent: pct }),
      compactImpl: (call) => call.onError?.(new Error("transient")),
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);

    // Still above threshold -> suppressed
    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);

    // Usage drops below threshold -> re-arms
    pct = 50;
    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);

    // Usage crosses threshold again -> triggers again
    pct = 82;
    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 2);
  });

  it("resets suppression on session_start", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { emit } = createHarness();
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent: 85 }),
      compactImpl: (call) => call.onComplete?.(),
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);

    emit("session_start", {}, ctx);
    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 2);
  });

  it("resets suppression on external session_compact", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { emit } = createHarness();
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent: 85 }),
      compactImpl: (call) => call.onComplete?.(),
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);

    emit("session_compact", {}, ctx);
    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 2);
  });

  it("clears session state on session_shutdown", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 80 });
    const { emit } = createHarness();
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent: 85 }),
      compactImpl: (call) => call.onError?.(new Error("failed")),
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 1);

    emit("session_shutdown", {}, ctx);
    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 2);
  });

  it("skips oneshot invocations via argv", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 50 });
    const { emit } = createHarness({ argv: ["node", "pi", "-p", "hello"] });
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 0);
  });

  it("skips subagent child invocations when PI_SUBAGENT_CHILD is 1", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 50 });
    const { emit } = createHarness({ env: { PI_SUBAGENT_CHILD: "1" } });
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 0);
  });

  it("skips stale extension contexts", () => {
    const cwd = createTempProject({ auto_compact_threshold_pct: 50 });
    const { emit } = createHarness();
    const { ctx, compactCalls } = createFakeCtx({
      cwd,
      getUsage: () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
    });
    Object.defineProperty(ctx, "mode", {
      get() {
        throw new Error("Extension context is no longer active");
      },
    });

    emit("agent_end", {}, ctx);
    assert.equal(compactCalls.length, 0);
  });
});
