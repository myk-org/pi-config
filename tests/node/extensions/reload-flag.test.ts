/**
 * reload-flag extension tests (agent-triggered extension reload).
 *
 * Verifies the routing and the nonce protocol. pi 1.3 constraint: event ctxs
 * have NO reload() — only the extension COMMAND ctx does. So the watcher
 * dispatches the registered `/reload-flag` command via sendUserMessage, and
 * the command handler consumes the flag and reloads. Crash safety: no path
 * may ever let an exception escape (an unhandled rejection kills pi).
 */

import { test, describe, afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";

import path from "node:path";
import reloadExtension, {
  shouldSkipReloadFlag,
  isHandshakeParticipant,
  STALE_HANDSHAKE_MS,
  RELOAD_COMMAND,
  runReloadFlagCommand,
  parkReloadNonce,
  reloadFlagPath,
  reloadPendingPath,
  reloadDonePath,
} from "../../../extensions/reload-flag/index.js";
import { makeTempDir } from "../helpers/temp-dirs.js";


type Handler = (event: any, ctx: any) => Promise<void>;
type CommandHandler = (args: string, ctx: any) => Promise<void>;

interface Registered {
  handlers: Map<string, Handler>;
  commands: Map<string, CommandHandler>;
  sent: { text: string; options?: any }[];
  messages: { customType: string; content: string; details?: any; options?: any }[];
}

function register(): Registered {
  const reg: Registered = { handlers: new Map(), commands: new Map(), sent: [], messages: [] };
  const pi = {
    on: (name: string, fn: Handler) => reg.handlers.set(name, fn),
    registerCommand: (name: string, opts: { handler: CommandHandler }) => reg.commands.set(name, opts.handler),
    sendUserMessage: (text: string, options?: any) => {
      reg.sent.push({ text, options });
    },
    sendMessage: (message: any, options?: any) => {
      reg.messages.push({ ...message, options });
    },
  };
  reloadExtension(pi as any);
  return reg;
}

function makeCwd(): string {
  const dir = makeTempDir("reload-flag-");
  mkdirSync(path.join(dir, ".pi", "run"), { recursive: true });
  // Legacy location — kept only for the pre-#1020 read-fallback tests.
  mkdirSync(path.join(dir, ".pi", "tmp"), { recursive: true });
  return dir;
}

/** Pre-#1020 control-file path (`.pi/tmp`). */
function legacyPath(cwd: string, name: string): string {
  return path.join(cwd, ".pi", "tmp", name);
}

/** Mock ctx whose `mode` getter stays live (isLiveExtensionCtx compatible). */
function makeCtx(cwd: string, reloads: { count: number }, sessionId = "test-session", mode = "agent") {
  return {
    cwd,
    mode,
    sessionManager: { getSessionId: () => sessionId },
    reload: async () => {
      reloads.count++;
    },
  };
}

/** Age a control file past the stale bound (cleanup is time-bounded, #1091). */
function backdate(file: string, ageMs = STALE_HANDSHAKE_MS * 2): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
}

describe("reload-flag", () => {
  test("registers the /reload-flag command and dispatches it when the flag appears", async () => {
    const reg = register();
    assert.ok(reg.commands.has("reload-flag"), "command registered");
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      assert.equal(reg.sent.length, 0, "no dispatch without a flag");
      writeFileSync(reloadFlagPath(cwd), "nonce-1");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.deepEqual(
        reg.sent.map((s) => s.text),
        [RELOAD_COMMAND],
        "watcher dispatches the command",
      );
      assert.equal(reg.sent[0].options?.expandPromptTemplates, true);
      assert.equal(reg.sent[0].options?.deliverAs, "followUp", "disposition contract");
      // Double turn_end must not dispatch twice
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("mid-write race: an EMPTY flag does not dispatch — wait for the nonce (Qodo PR #950 R7)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      // Requester created the flag but has not written the nonce yet
      writeFileSync(reloadFlagPath(cwd), "");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 0, "no dispatch on an empty flag (no nonce to verify)");
      // Nonce lands — the next tick dispatches
      writeFileSync(reloadFlagPath(cwd), "nonce-race");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1, "dispatches once the nonce is readable");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the command handler parks the nonce and consumes the flag", async () => {
    const cwd = makeCwd();
    try {
      writeFileSync(reloadFlagPath(cwd), "nonce-2");
      await runReloadFlagCommand(makeCtx(cwd, { count: 0 }));
      assert.ok(!existsSync(reloadFlagPath(cwd)), "flag consumed");
      const parked = JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8"));
      assert.equal(parked.nonce, "nonce-2", "nonce parked in pending");
      assert.equal(typeof parked.owner, "string", "pending carries the owner identity");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the command handler waits for idle BEFORE reloading (pi refuses mid-stream)", async () => {
    const cwd = makeCwd();
    try {
      const order: string[] = [];
      writeFileSync(reloadFlagPath(cwd), "nonce-idle");
      const ctx = {
        ...makeCtx(cwd, { count: 0 }),
        waitForIdle: async () => {
          order.push("waited");
        },
        reload: async () => {
          order.push("reloaded");
        },
      };
      await runReloadFlagCommand(ctx);
      assert.deepEqual(order, ["waited", "reloaded"], "idle wait strictly precedes the reload call");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the command handler reloads exactly once", async () => {
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadFlagPath(cwd), "nonce-2");
      const ctx = {
        ...makeCtx(cwd, reloads),
        waitForIdle: async () => {},
      };
      await runReloadFlagCommand(ctx);
      assert.equal(reloads.count, 1, "ctx.reload called exactly once");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the command handler NEVER throws, even without a reload action (crash safety)", async () => {
    const cwd = makeCwd();
    try {
      writeFileSync(reloadFlagPath(cwd), "nonce-3");
      // ctx lacking reload() entirely — the pi-1.3 crash scenario
      await runReloadFlagCommand({ cwd });
      assert.ok(!existsSync(reloadFlagPath(cwd)), "flag still consumed");
      assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8")).nonce, "nonce-3");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("new runtime completes the handshake: pending nonce → done marker + continuation turn", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadPendingPath(cwd), "nonce-4");
      await reg.handlers.get("session_start")!({ reason: "reload" }, makeCtx(cwd, reloads));
      assert.ok(!existsSync(reloadPendingPath(cwd)), "pending consumed");
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "nonce-4", "done carries the nonce");
      // Continuation message wakes the agent (seamless flow, no human)
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(reg.messages.length, 1, "continuation message sent");
      assert.equal(reg.messages[0].customType, "reload-flag-done");
      assert.equal(reg.messages[0].options?.triggerTurn, true, "continuation triggers a turn");
      assert.match(reg.messages[0].content, /nonce-4/);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an EMPTY pending file is garbage: session_start removes it and sends no continuation (R8 reload-loop fix)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadPendingPath(cwd), ""); // truncated/empty pending
      await reg.handlers.get("session_start")!({ reason: "reload" }, makeCtx(cwd, reloads));
      assert.ok(!existsSync(reloadPendingPath(cwd)), "garbage pending removed");
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(reg.messages.length, 0, "no continuation for a nonce-less pending");
      // And the watcher must not re-dispatch on the removed garbage either
      await reg.handlers.get("turn_end")!({}, makeCtx(cwd, reloads));
      assert.equal(reg.sent.length, 0, "no reload dispatch — loop closed");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("an EMPTY pending file does not dispatch from turn_end either (R8 reload-loop fix)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      writeFileSync(reloadPendingPath(cwd), "   "); // whitespace-only nonce
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 0, "garbage pending never dispatches");
      assert.ok(!existsSync(reloadPendingPath(cwd)), "garbage pending removed by the watcher");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("session_shutdown cancels a pending continuation message (R8: no turn injected into a closed session)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadPendingPath(cwd), "nonce-cancel");
      await reg.handlers.get("session_start")!({ reason: "reload" }, makeCtx(cwd, reloads));
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "nonce-cancel", "done already published");
      // Session closes INSIDE the 250ms deferral window
      await reg.handlers.get("session_shutdown")!({}, undefined);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(reg.messages.length, 0, "continuation cancelled — never fired into the closed session");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a pending handshake owned by ANOTHER LIVE session is never stolen (Qodo PR #950 R9)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctxB = makeCtx(cwd, reloads, "session-B");
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctxB);
      // Session A (pid 1 = always alive, different session) parked a handshake
      writeFileSync(
        reloadPendingPath(cwd),
        JSON.stringify({ nonce: "nonce-A", owner: "1:session-A" }),
      );
      // B's watcher must NOT dispatch a reload for A's handshake
      await reg.handlers.get("turn_end")!({}, ctxB);
      assert.equal(reg.sent.length, 0, "foreign live pending never dispatches");
      // B's manual reload must NOT consume it or send the continuation
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctxB);
      await new Promise((r) => setTimeout(r, 350));
      assert.equal(reg.messages.length, 0, "no continuation stolen");
      assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8")).nonce, "nonce-A", "pending left for its owner");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a pending handshake whose owner process is DEAD is recoverable (stranded)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads, "session-B");
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      // Owner pid 999999 does not exist — the handshake is stranded
      writeFileSync(
        reloadPendingPath(cwd),
        JSON.stringify({ nonce: "nonce-dead", owner: "999999:session-A" }),
      );
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1, "dead-owner pending re-dispatches (stranded handshake recovery)");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("our OWN pending handshake still re-dispatches (same pid + session)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads, "session-A");
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      writeFileSync(
        reloadPendingPath(cwd),
        JSON.stringify({ nonce: "nonce-self", owner: `${process.pid}:session-A` }),
      );
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 1, "own pending re-dispatches (idempotent command)");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("manual /reload (no pending) publishes NO continuation message", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      await reg.handlers.get("session_start")!({ reason: "reload" }, makeCtx(cwd, reloads));
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(reg.messages.length, 0, "manual reload stays silent");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("manual /reload satisfies a sitting flag — no second reload, done carries its nonce", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      writeFileSync(reloadFlagPath(cwd), "nonce-stale");
      // User reloaded manually BEFORE the watcher consumed the flag
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.ok(!existsSync(reloadFlagPath(cwd)), "sitting flag removed by manual reload");
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "nonce-stale", "done = the code just loaded");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 0, "no double reload");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("fresh session start clears stale flag/pending/done without dispatching", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(reloadFlagPath(cwd), "old");
      writeFileSync(reloadPendingPath(cwd), "older");
      writeFileSync(reloadDonePath(cwd), "oldest");
      for (const file of [reloadFlagPath(cwd), reloadPendingPath(cwd), reloadDonePath(cwd)]) backdate(file);
      await reg.handlers.get("session_start")!({ reason: "startup" }, makeCtx(cwd, reloads));
      assert.ok(!existsSync(reloadFlagPath(cwd)));
      assert.ok(!existsSync(reloadPendingPath(cwd)));
      assert.ok(!existsSync(reloadDonePath(cwd)));
      await reg.handlers.get("turn_end")!({}, makeCtx(cwd, reloads));
      assert.equal(reg.sent.length, 0);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("fresh session start keeps handshake state that is NOT old yet (#1091)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads, "session-B");
      writeFileSync(reloadFlagPath(cwd), "deploy-in-flight");
      writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "p", owner: "" }));
      writeFileSync(reloadDonePath(cwd), "stale-done");
      backdate(reloadDonePath(cwd)); // only the done marker is old
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      assert.equal(readFileSync(reloadFlagPath(cwd), "utf-8"), "deploy-in-flight", "a just-written flag survives");
      assert.ok(existsSync(reloadPendingPath(cwd)), "a just-parked pending survives");
      assert.ok(!existsSync(reloadDonePath(cwd)), "an old done marker is still cleaned up");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a fresh session never deletes another session's pending, not even when old (#1091)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      writeFileSync(
        reloadPendingPath(cwd),
        JSON.stringify({ nonce: "nonce-A", owner: "1:session-A" }), // pid 1 = alive
      );
      backdate(reloadPendingPath(cwd));
      const ctxB = makeCtx(cwd, reloads, "session-B");
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctxB);
      assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8")).nonce, "nonce-A", "foreign pending kept");
      await reg.handlers.get("turn_end")!({}, ctxB);
      assert.equal(reg.sent.length, 0, "and B never dispatches for it");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a print/json child session never deletes the handshake (#1091)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      writeFileSync(reloadFlagPath(cwd), "deploy-B");
      writeFileSync(reloadPendingPath(cwd), JSON.stringify({ nonce: "nonce-1", owner: "1:session-A" }));
      writeFileSync(reloadDonePath(cwd), "deploy-A");
      for (const mode of ["json", "print"]) {
        const ctx = makeCtx(cwd, { count: 0 }, "child", mode);
        await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
        await reg.handlers.get("turn_end")!({}, ctx);
      }
      assert.equal(readFileSync(reloadFlagPath(cwd), "utf-8"), "deploy-B", "flag untouched");
      assert.ok(existsSync(reloadPendingPath(cwd)), "pending untouched");
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "deploy-A", "done untouched");
      assert.equal(reg.sent.length, 0, "a child never dispatches the reload command");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a flag written during an in-flight reload still reloads — done ends with the NEWER nonce (#1091)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads, "session-A");
      const command = reg.commands.get("reload-flag")!;
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      // Deploy A: watcher dispatches, the command parks A's nonce and reloads.
      writeFileSync(reloadFlagPath(cwd), "deploy-A");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.deepEqual(reg.sent.map((s) => s.text), [RELOAD_COMMAND]);
      await command("", ctx);
      assert.equal(reloads.count, 1, "first reload fired");
      assert.equal(JSON.parse(readFileSync(reloadPendingPath(cwd), "utf-8")).nonce, "deploy-A");
      // Deploy B lands while A's reload is in flight...
      writeFileSync(reloadFlagPath(cwd), "deploy-B");
      // ...and a oneshot child starts in the same checkout in between.
      const child = register();
      await child.handlers.get("session_start")!(
        { reason: "startup" },
        makeCtx(cwd, { count: 0 }, "child", "json"),
      );
      assert.equal(readFileSync(reloadFlagPath(cwd), "utf-8"), "deploy-B", "the child deleted nothing");
      // A's new runtime publishes the nonce it actually loaded, leaves B's flag.
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "deploy-A", "done = the nonce just loaded");
      assert.equal(readFileSync(reloadFlagPath(cwd), "utf-8"), "deploy-B", "newer request left for the watcher");
      // The watcher dispatches it → second reload → done converges on B.
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.equal(reg.sent.length, 2, "second dispatch, not a swallowed request");
      await command("", ctx);
      assert.equal(reloads.count, 2, "second reload fired");
      await reg.handlers.get("session_start")!({ reason: "reload" }, ctx);
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "deploy-B", "done ends with the NEWER nonce");
      assert.ok(!existsSync(reloadFlagPath(cwd)), "no request left behind");
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("parkReloadNonce is a no-op without a flag", () => {
    const cwd = makeCwd();
    try {
      assert.equal(parkReloadNonce(cwd), null);
      assert.ok(!existsSync(reloadPendingPath(cwd)));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a stranded handshake (pending without done) re-dispatches on the next turn", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      // Simulate a refused reload from an older runtime: nonce parked, no done
      writeFileSync(reloadPendingPath(cwd), "nonce-stranded");
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.deepEqual(
        reg.sent.map((s) => s.text),
        [RELOAD_COMMAND],
        "stranded pending re-dispatches the command (self-heal)",
      );
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("flag paths live in the session cwd's .pi/run (not throwaway .pi/tmp)", () => {
    const legacyDir = path.join("/proj", ".pi", "tmp");
    const cases: [string, string][] = [
      [reloadFlagPath("/proj"), "reload.flag"],
      [reloadPendingPath("/proj"), "reload.pending"],
      [reloadDonePath("/proj"), "reload.done"],
    ];
    for (const [resolved, name] of cases) {
      assert.equal(resolved, path.join("/proj", ".pi", "run", name));
      // Explicit: the home is `.pi/run`, OUTSIDE the dir the sweep deletes (#1020).
      assert.equal(
        resolved.startsWith(legacyDir + path.sep),
        false,
        `${name} must not resolve into the swept .pi/tmp dir`,
      );
    }
  });

  test("legacy .pi/tmp flag is consumed (#1020)", () => {
    const cwd = makeCwd();
    try {
      const legacyFlag = legacyPath(cwd, "reload.flag");
      writeFileSync(legacyFlag, "nonce-legacy");
      const nonce = parkReloadNonce(cwd, `${process.pid}:session-A`);
      assert.equal(nonce, "nonce-legacy", "a pre-upgrade deploy script's flag is still consumed");
      assert.ok(!existsSync(legacyFlag), "legacy flag removed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a consumed legacy flag parks pending in .pi/run (#1020)", () => {
    const cwd = makeCwd();
    try {
      writeFileSync(legacyPath(cwd, "reload.flag"), "nonce-legacy");
      parkReloadNonce(cwd, `${process.pid}:session-A`);
      assert.ok(existsSync(reloadPendingPath(cwd)), "pending parked in the new dir");
      assert.ok(!existsSync(legacyPath(cwd, "reload.pending")), "never written to the legacy dir");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the done marker is mirrored to .pi/tmp for a pre-#1020 requester (#1020)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      writeFileSync(legacyPath(cwd, "reload.flag"), "nonce-legacy");
      parkReloadNonce(cwd, `${process.pid}:session-A`);
      await reg.handlers.get("session_start")!(
        { reason: "reload" },
        makeCtx(cwd, { count: 0 }, `session-A`),
      );
      assert.equal(readFileSync(reloadDonePath(cwd), "utf-8"), "nonce-legacy");
      assert.equal(
        readFileSync(legacyPath(cwd, "reload.done"), "utf-8"),
        "nonce-legacy",
        "a requester polling the old location still sees its nonce",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("legacy .pi/tmp pending is still seen by the watcher (#1020)", async () => {
    const reg = register();
    const cwd = makeCwd();
    try {
      const reloads = { count: 0 };
      const ctx = makeCtx(cwd, reloads);
      await reg.handlers.get("session_start")!({ reason: "startup" }, ctx);
      // A pre-upgrade runtime parked this one in the old location.
      writeFileSync(legacyPath(cwd, "reload.pending"), JSON.stringify({ nonce: "n-legacy", owner: "999999:gone" }));
      await reg.handlers.get("turn_end")!({}, ctx);
      assert.deepEqual(reg.sent.map((s) => s.text), [RELOAD_COMMAND]);
      await reg.handlers.get("session_shutdown")!({}, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("isHandshakeParticipant", () => {
  it("only an interactive session may touch the handshake (#1091)", () => {
    assert.equal(isHandshakeParticipant("tui", ["node", "pi"]), true);
    assert.equal(isHandshakeParticipant("agent", ["node", "pi"]), true);
    assert.equal(isHandshakeParticipant("print", ["node", "pi"]), false);
    assert.equal(isHandshakeParticipant("json", ["node", "pi"]), false);
    assert.equal(isHandshakeParticipant("tui", ["node", "pi", "-p", "hi"]), false);
    assert.equal(isHandshakeParticipant("tui", ["node", "pi", "--mode", "json"]), false);
  });
});

describe("shouldSkipReloadFlag", () => {
  it("skips a headless rpc session", () => {
    // The bug: a spawned peer in the same checkout consumed the deploy nonce, so the operator's
    // TUI session never reloaded and no banner appeared.
    assert.equal(shouldSkipReloadFlag(["node", "pi", "--mode", "rpc", "--coms"]), true);
    assert.equal(shouldSkipReloadFlag(["node", "pi", "--mode=rpc"]), true);
  });

  it("does not skip a TUI or oneshot session", () => {
    assert.equal(shouldSkipReloadFlag(["node", "pi"]), false);
    assert.equal(shouldSkipReloadFlag(["node", "pi", "--mode", "json"]), false);
    assert.equal(shouldSkipReloadFlag(["node", "pi", "-p", "hi"]), false);
  });
});
