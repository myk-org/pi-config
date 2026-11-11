/**
 * Cross-session Discord prompts: where a question goes, when to nudge, and which thread mappings
 * may be evicted. Pure decisions, asserted without a Discord client.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensurePromptTarget, evictableSessions, hydratableTargets, nudgeChannelId, promptHeader, fallbackPromptTarget, nudgeDue, planPromptTarget, promptById, resolvePromptTarget, shouldNudge, resolveInboundSession } from "../../../extensions/pidash/discord-prompt-targets.ts";

describe("planPromptTarget", () => {
  const base = { existingChannelId: null, threadParentChannelId: "chan", dmChannelId: "dm-1", plainChannelId: "chan" };

  it("reuses the target a watched session already has", () => {
    assert.deepEqual(planPromptTarget({ ...base, existingChannelId: "thread-1" }),
      { action: "existing", channelId: "thread-1" });
  });

  it("creates a thread for a session the user never picked", () => {
    // Case 1/2: nothing exists for this session yet, so the question gets its own home and the
    // answer has a route back.
    assert.deepEqual(planPromptTarget(base), { action: "create-thread", parentChannelId: "chan" });
  });

  it("prefers the DM when no guild channel can hold a thread", () => {
    assert.deepEqual(planPromptTarget({ ...base, threadParentChannelId: null }),
      { action: "use-dm", channelId: "dm-1" });
  });

  it("falls back to a plain channel, then reports nowhere", () => {
    assert.deepEqual(planPromptTarget({ ...base, threadParentChannelId: null, dmChannelId: null }),
      { action: "use-channel", channelId: "chan" });
    assert.deepEqual(planPromptTarget({ existingChannelId: null, threadParentChannelId: null, dmChannelId: null, plainChannelId: null }),
      { action: "nowhere" });
  });
});

describe("fallbackPromptTarget", () => {
  const input = {
    existingChannelId: null,
    threadParentChannelId: "chan",
    dmChannelId: "dm-1",
    plainChannelId: "chan",
  };

  it("moves to the DM when a thread cannot be created", () => {
    // A permission failure must not drop the question when a DM exists.
    assert.deepEqual(fallbackPromptTarget(input, "thread"), { action: "use-dm", channelId: "dm-1" });
  });

  it("moves to a plain channel when neither thread nor DM works", () => {
    assert.deepEqual(fallbackPromptTarget({ ...input, dmChannelId: null }, "thread"), { action: "use-channel", channelId: "chan" });
    assert.deepEqual(fallbackPromptTarget(input, "dm"), { action: "use-channel", channelId: "chan" });
  });

  it("reports nowhere when nothing is left", () => {
    const bare = { existingChannelId: null, threadParentChannelId: null, dmChannelId: null, plainChannelId: null };
    assert.deepEqual(fallbackPromptTarget(bare, "thread"), { action: "nowhere" });
    assert.deepEqual(fallbackPromptTarget({ ...bare, plainChannelId: null }, "dm"), { action: "nowhere" });
  });
});

describe("nudgeDue", () => {
  it("allows the first nudge and then throttles", () => {
    assert.equal(nudgeDue(undefined, 1_000), true);
    assert.equal(nudgeDue(1_000, 30_000), false, "inside the window");
    assert.equal(nudgeDue(1_000, 61_000), true, "after it");
  });
});

describe("promptById", () => {
  const prompts = {
    A: { id: "q1", sessionId: "A" },
    B: { id: "q2", sessionId: "B" },
  };

  it("finds a prompt in another session", () => {
    assert.equal(promptById(prompts, "q2")?.sessionId, "B");
  });

  it("returns null for an unknown id", () => {
    assert.equal(promptById(prompts, "nope"), null);
    assert.equal(promptById(undefined, "q1"), null);
  });

  it("lets the thread decide when two sessions share a prompt id", () => {
    const collided = { A: { id: "same", sessionId: "A" }, B: { id: "same", sessionId: "B" } };
    assert.equal(promptById(collided, "same", "B")?.sessionId, "B");
    // Without a thread context an ambiguous id is refused rather than answering the wrong agent.
    assert.equal(promptById(collided, "same"), null);
  });
});

describe("resolvePromptTarget (the router, with an injected thread creator)", () => {
  const input = { existingChannelId: null, threadParentChannelId: "chan", dmChannelId: "dm-1", plainChannelId: "chan" };

  it("uses a thread when Discord creates one", async () => {
    const resolved = await resolvePromptTarget(input, async () => "thread-9");
    assert.deepEqual(resolved, { target: { channelId: "thread-9", threadId: "thread-9" }, used: "thread", firstFailure: null });
  });

  it("falls back to the DM when thread creation fails", async () => {
    // The case that used to drop the question: a permission error on threads.create.
    const resolved = await resolvePromptTarget(input, async () => { throw new Error("Missing Permissions"); });
    assert.deepEqual(resolved.target, { channelId: "dm-1", threadId: null });
    assert.equal(resolved.used, "dm");
  });

  it("reports why the first route failed", async () => {
    const resolved = await resolvePromptTarget(input, async () => { throw new Error("Missing Permissions"); });
    assert.match(String(resolved.firstFailure), /Missing Permissions/);
  });

  it("falls back past the DM to a plain channel", async () => {
    const resolved = await resolvePromptTarget({ ...input, dmChannelId: null }, async () => { throw new Error("nope"); });
    assert.deepEqual(resolved.target, { channelId: "chan", threadId: null });
    assert.equal(resolved.used, "channel");
  });

  it("reports nowhere instead of pretending a delivery happened", async () => {
    const resolved = await resolvePromptTarget(
      { existingChannelId: null, threadParentChannelId: "chan", dmChannelId: null, plainChannelId: null },
      async () => { throw new Error("nope"); },
    );
    assert.equal(resolved.target, null);
    assert.equal(resolved.used, "nowhere");
  });

  it("reuses an existing target without touching Discord", async () => {
    let calls = 0;
    const resolved = await resolvePromptTarget({ ...input, existingChannelId: "thread-1" }, async () => { calls++; return "x"; });
    assert.deepEqual(resolved.target, { channelId: "thread-1", threadId: null });
    assert.equal(resolved.used, "existing");
    assert.equal(calls, 0);
  });
});

describe("ensurePromptTarget (the wiring, with Discord injected)", () => {
  const guildChannel = { guildId: "g1", threads: { create: async () => ({ id: "thread-new" }) } };
  const deps = (over: any = {}) => ({
    fetchChannel: async (id: string) => (id === "guild-chan" ? guildChannel : Promise.reject(new Error("gone"))),
    createThread: async () => "thread-new",
    persist: () => { calls.persist++; },
    inFlight: new Map(),
    maxThreads: 5,
    truncate: (t: string) => t,
    ...over,
  });
  let calls: { persist: number };
  beforeEach(() => { calls = { persist: 0 }; });

  it("creates a thread, records it and marks the target prompt-only", async () => {
    const state = { responseChannelId: "guild-chan", threads: {}, targets: {}, promptOnlyTargets: {} };
    const target = await ensurePromptTarget(deps(), state, { userId: "u", sessionId: "s1", name: "proj" });
    assert.deepEqual(target, { channelId: "thread-new", threadId: "thread-new" });
    assert.equal(state.threads.s1, "thread-new");
    assert.deepEqual(state.targets.s1, target);
    assert.equal(state.promptOnlyTargets.s1, true, "a delivery thread is not a subscription");
    assert.ok(calls.persist > 0, "the mapping is persisted for the answer route");
  });

  it("reuses an existing thread instead of creating a second one", async () => {
    let created = 0;
    const state = { responseChannelId: "guild-chan", threads: { s1: "thread-old" }, targets: {}, promptOnlyTargets: {} };
    const target = await ensurePromptTarget(deps({ createThread: async () => { created++; return "x"; } }), state,
      { userId: "u", sessionId: "s1", name: "proj" });
    assert.deepEqual(target, { channelId: "thread-old", threadId: "thread-old" });
    assert.equal(created, 0);
    assert.equal(state.promptOnlyTargets.s1, true, "reuse re-marks it, or output streams forever");
  });

  it("falls back to the DM when the guild channel cannot hold a thread", async () => {
    const state = { responseChannelId: "guild-chan", dmChannelId: "dm-1", threads: {}, targets: {}, promptOnlyTargets: {} };
    const target = await ensurePromptTarget(
      deps({ fetchChannel: async () => Promise.reject(new Error("missing access")), createThread: async () => { throw new Error("no"); } }),
      state, { userId: "u", sessionId: "s2", name: "proj" },
    );
    assert.deepEqual(target, { channelId: "dm-1", threadId: null }, "the question is not dropped");
  });

  it("evicts the thread AND the target mapping, never a session waiting on an answer", async () => {
    const threads: Record<string, string> = { old1: "t1", waiting: "t2" };
    const state = { responseChannelId: "guild-chan", threads, targets: { old1: { channelId: "t1", threadId: "t1" } }, pendingPrompts: { waiting: { id: "q" } } };
    await ensurePromptTarget(deps({ maxThreads: 2 }), state, { userId: "u", sessionId: "s3", name: "proj" });
    assert.equal(state.threads.old1, undefined, "the oldest mapping is evicted");
    assert.equal(state.targets.old1, undefined, "and its target with it");
    assert.equal(state.threads.waiting, "t2", "a session waiting on an answer keeps its thread");
  });

  it("uses a stored response channel as the DM when no dmChannelId was recorded", async () => {
    // Users saved before dmChannelId existed: Discord reports no guild for their DM, so the DM
    // route is still available instead of losing the question.
    const state = { responseChannelId: "legacy-dm", threads: {}, targets: {}, promptOnlyTargets: {} };
    const target = await ensurePromptTarget(
      deps({ fetchChannel: async (id: string) => (id === "legacy-dm" ? { id, type: 1 } : Promise.reject(new Error("gone"))) }),
      state, { userId: "u", sessionId: "s5", name: "p" },
    );
    assert.deepEqual(target, { channelId: "legacy-dm", threadId: null });
  });

  it("never evicts the session whose question is being delivered", async () => {
    // All slots taken by older sessions: the thread just created for THIS question must survive.
    const threads: Record<string, string> = { a: "t1", b: "t2" };
    const state = { responseChannelId: "guild-chan", threads, targets: {}, promptOnlyTargets: {} };
    await ensurePromptTarget(deps({ maxThreads: 2, createThread: async () => "thread-fresh" }), state,
      { userId: "u", sessionId: "fresh", name: "p" });
    assert.equal(state.threads.fresh, "thread-fresh", "the new thread keeps its mapping");
  });

  it("returns null instead of inventing a delivery", async () => {
    const state = { responseChannelId: null, dmChannelId: null, threads: {}, targets: {} };
    assert.equal(await ensurePromptTarget(deps(), state, { userId: "u", sessionId: "s4", name: "p" }), null);
  });
});

describe("eviction and selection races", () => {
  const guild = { guildId: "g1", threads: { create: async () => ({ id: "x" }) } };
  const deps = (over: any = {}) => ({
    fetchChannel: async () => guild,
    createThread: async () => "thread-new",
    persist: () => {},
    inFlight: new Map(),
    maxThreads: 2,
    ...over,
  });

  it("never evicts the session the user watches", async () => {
    // Background questions must not take the watched session's thread away: after a restart its
    // output would fall back to a different channel.
    const state = {
      responseChannelId: "guild-chan",
      watchedSessionId: "watched",
      threads: { watched: "t-watched", other: "t-other" },
      targets: { watched: { channelId: "t-watched", threadId: "t-watched" } },
      promptOnlyTargets: {},
    };
    await ensurePromptTarget(deps(), state, { userId: "u", sessionId: "bg", name: "p" });
    assert.equal(state.threads.watched, "t-watched", "the watched thread survives");
    assert.equal(state.targets.watched?.channelId, "t-watched", "and keeps its target");
    assert.equal(state.threads.other, undefined, "an un-watched session gives up its mapping");
  });

  it("adopts a thread the user selected while Discord was working", async () => {
    // switchWatch won the race; the prompt must route to THAT thread, not a second one.
    const state: any = { responseChannelId: "guild-chan", threads: {}, targets: {}, promptOnlyTargets: {} };
    const slow = deps({
      createThread: async () => {
        state.threads.s1 = "thread-from-watch";
        return "thread-created";
      },
    });
    const target = await ensurePromptTarget(slow, state, { userId: "u", sessionId: "s1", name: "p" });
    assert.deepEqual(target, { channelId: "thread-from-watch", threadId: "thread-from-watch" });
    assert.equal(state.threads.s1, "thread-from-watch", "the selected thread is not overwritten");
  });
});

describe("hydratableTargets", () => {
  it("keeps a watched session's thread", () => {
    assert.deepEqual(hydratableTargets({ threads: { s1: "t1" } }), { s1: "t1" });
  });

  it("drops question-only threads", () => {
    assert.deepEqual(hydratableTargets({ threads: { s1: "t1", s2: "t2" }, promptOnlyTargets: { s2: true } }), { s1: "t1" });
  });

  it("gives a muted user no targets at all", () => {
    // /disconnect survives a restart: nothing may be rebuilt that streams output to them.
    assert.deepEqual(hydratableTargets({ threads: { s1: "t1" }, deliveryMuted: true }), {});
  });
});

describe("routing is logged", () => {
  const guild = { guildId: "g1", threads: { create: async () => ({ id: "x" }) } };

  it("records the fallback route and why", async () => {
    // A silent route decision is how a live run delivered a question with no evidence of where.
    const lines: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
    const log = {
      debug: (message: string, data?: Record<string, unknown>) => lines.push({ level: "debug", message, data }),
      info: (message: string, data?: Record<string, unknown>) => lines.push({ level: "info", message, data }),
      warn: (message: string, data?: Record<string, unknown>) => lines.push({ level: "warn", message, data }),
      error: (message: string, data?: Record<string, unknown>) => lines.push({ level: "error", message, data }),
    };
    const state = { responseChannelId: "guild-chan", dmChannelId: "dm-1", threads: {}, targets: {}, promptOnlyTargets: {} };
    await ensurePromptTarget(
      {
        fetchChannel: async (id: string) => (id === "guild-chan" ? guild : Promise.reject(new Error("gone"))),
        createThread: async () => { throw new Error("Missing Permissions"); },
        persist: () => {}, inFlight: new Map(), maxThreads: 5, log,
      },
      state, { userId: "u", sessionId: "s1", name: "p" },
    );
    // A fallback is a warning that names the route taken and the failure — not an info line.
    const warned = lines.find((line) => line.message === "prompt target fell back");
    assert.equal(warned?.level, "warn");
    assert.equal(warned?.data?.used, "dm");
    assert.match(String(warned?.data?.failure), /Missing Permissions/, "the failing route is named");
  });

  it("logs an error when there is no route at all", async () => {
    const lines: Array<{ level: string; message: string }> = [];
    const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (message: string) => lines.push({ level: "error", message }) };
    const state = { responseChannelId: null, dmChannelId: null, threads: {}, targets: {} };
    await ensurePromptTarget(
      { fetchChannel: async () => { throw new Error("gone"); }, createThread: async () => "x", persist: () => {}, inFlight: new Map(), maxThreads: 5, log },
      state, { userId: "u", sessionId: "s2", name: "p" },
    );
    assert.equal(lines.at(-1)?.message, "prompt target unavailable");
    assert.equal(lines.at(-1)?.level, "error");
  });
});

describe("nudgeChannelId", () => {
  it("prefers the watched session's own channel", () => {
    assert.equal(nudgeChannelId({ watchedTargetChannelId: "watch-chan", responseChannelId: "dm", askedChannelId: "other" }), "watch-chan");
  });

  it("falls back to where the user last spoke when the watch has no channel", () => {
    // The live gap: watching a session with no channel meant no notification at all.
    assert.equal(nudgeChannelId({ watchedTargetChannelId: null, responseChannelId: "dm", askedChannelId: "other" }), "dm");
  });

  it("never nudges into the channel that already has the question", () => {
    assert.equal(nudgeChannelId({ watchedTargetChannelId: "same", responseChannelId: "same", askedChannelId: "same" }), null);
    assert.equal(nudgeChannelId({ watchedTargetChannelId: null, responseChannelId: null, askedChannelId: "x" }), null);
  });
});

describe("promptHeader", () => {
  it("names the asking session", () => {
    // Without this a DM user saw a bare question and had to guess the session.
    assert.equal(promptHeader({ name: "pi-config", cwd: "/home/u/git/pi-config", title: "Proceed?" }), "pi-config — Proceed?");
  });

  it("never puts the checkout path in the title", () => {
    // A guild-visible thread must not leak a private filesystem path, and 500 characters of path
    // would crowd the question out of Discord's title.
    const header = promptHeader({ name: "pi", cwd: "/home/someone/secret/project", title: "Deploy?", sessionId: "42:/home/someone/secret/project" });
    assert.ok(!header.includes("/home/someone"), "no absolute path");
    assert.equal(header, "pi (#42) — Deploy?");
  });

  it("distinguishes two sessions in the same checkout by pid", () => {
    // Two playground sessions produced identical headers; the pid is what makes a session unique.
    const a = promptHeader({ name: "pg", cwd: "/home/u/pg", title: "Q?", sessionId: "850486:/home/u/pg" });
    const b = promptHeader({ name: "pg", cwd: "/home/u/pg", title: "Q?", sessionId: "320698:/home/u/pg" });
    assert.match(a, /#850486/);
    assert.match(b, /#320698/);
    assert.notEqual(a, b, "the header tells the two sessions apart");
  });

  it("works without a known checkout", () => {
    assert.equal(promptHeader({ name: "rootcoz", cwd: null, title: "Proceed?" }), "rootcoz — Proceed?");
  });

  it("falls back to a default question instead of an empty header", () => {
    assert.equal(promptHeader({ name: "x", cwd: null, title: "   " }), "x — The agent is asking");
    assert.equal(promptHeader({ name: "x", cwd: null, title: undefined }), "x — The agent is asking");
  });
});

describe("eviction and reuse are logged", () => {
  const guild = { guildId: "g1", threads: { create: async () => ({ id: "fresh" }) } };
  function collector() {
    const lines: Array<{ level: string; message: string; data?: Record<string, unknown> }> = [];
    const push = (level: string) => (message: string, data?: Record<string, unknown>) => lines.push({ level, message, data });
    return { lines, log: { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") } };
  }

  it("logs a reused target at debug", async () => {
    const { lines, log } = collector();
    const state = { responseChannelId: "guild-chan", threads: {}, targets: { s1: { channelId: "c", threadId: "t" } } };
    await ensurePromptTarget(
      { fetchChannel: async () => guild, createThread: async () => "x", persist: () => {}, inFlight: new Map(), maxThreads: 5, log },
      state, { userId: "u", sessionId: "s1", name: "p" },
    );
    assert.equal(lines.at(-1)?.message, "prompt target reused");
    assert.equal(lines.at(-1)?.level, "debug");
  });

  it("names the sessions it evicted", async () => {
    const { lines, log } = collector();
    const state = {
      responseChannelId: "guild-chan",
      threads: { old: "t-old", older: "t-older" },
      targets: { old: { channelId: "t-old", threadId: "t-old" } },
    };
    await ensurePromptTarget(
      { fetchChannel: async () => guild, createThread: async () => "fresh", persist: () => {}, inFlight: new Map(), maxThreads: 2, log },
      state, { userId: "u", sessionId: "s9", name: "p" },
    );
    const evicted = lines.find((line) => line.message === "prompt targets evicted");
    assert.ok(evicted, "eviction is logged");
    assert.equal(evicted?.level, "info");
    assert.ok(Array.isArray(evicted?.data?.evicted), "the evicted sessions are named");
  });

  it("warns when a route failed and the question fell back", async () => {
    const { lines, log } = collector();
    const state = { responseChannelId: "guild-chan", dmChannelId: "dm", threads: {}, targets: {} };
    await ensurePromptTarget(
      { fetchChannel: async () => guild, createThread: async () => { throw new Error("Missing Permissions"); }, persist: () => {}, inFlight: new Map(), maxThreads: 5, log },
      state, { userId: "u", sessionId: "s5", name: "p" },
    );
    const fellBack = lines.find((line) => line.message === "prompt target fell back");
    assert.equal(fellBack?.level, "warn", "a failed route is a warning, not info");
    assert.match(String(fellBack?.data?.failure), /Missing Permissions/);
  });
});

describe("resolveInboundSession", () => {
  const live = (...ids: string[]) => (id: string) => ids.includes(id);

  it("prefers the thread's session", () => {
    const r = resolveInboundSession({ channelId: "ch", threadSessionId: "s1", watchedSessionId: "s2", isLive: live("s1", "s2") });
    assert.deepEqual([r.sessionId, r.source], ["s1", "thread"]);
  });

  it("falls back to the watched session", () => {
    const r = resolveInboundSession({ channelId: "ch", watchedSessionId: "s2", isLive: live("s2") });
    assert.deepEqual([r.sessionId, r.source], ["s2", "watch"]);
  });

  it("routes through the session whose output this channel carries", () => {
    // The reported bug: the channel streams s3's output while the watch is gone.
    const r = resolveInboundSession({
      channelId: "ch",
      targets: { s3: { channelId: "ch", threadId: null } },
      isLive: live("s3"),
    });
    assert.deepEqual([r.sessionId, r.source], ["s3", "target"]);
  });

  it("never routes to a dead target", () => {
    const r = resolveInboundSession({ channelId: "ch", targets: { s3: { channelId: "ch" } }, isLive: live() });
    assert.deepEqual([r.sessionId, r.source], [null, "none"]);
  });

  it("says the channel's session died instead of calling the channel unwatched", () => {
    const r = resolveInboundSession({ channelId: "ch", targets: { s3: { channelId: "ch" } }, isLive: live() });
    assert.equal(r.deadTarget, true);
    const healthy = resolveInboundSession({ channelId: "other", isLive: live() });
    assert.equal(healthy.deadTarget, undefined);
  });

  it("keeps a disconnected thread's message on that thread's session", () => {
    // Spilling it into the live watch would deliver a thread's text to another agent.
    const r = resolveInboundSession({ channelId: "ch", threadSessionId: "gone", watchedSessionId: "s2", isLive: live("s2") });
    assert.deepEqual([r.sessionId, r.source], ["gone", "thread"]);
  });

  it("does not let a dead watch hide a live target on the same channel", () => {
    const r = resolveInboundSession({
      channelId: "ch",
      watchedSessionId: "gone",
      targets: { s3: { channelId: "ch", threadId: null } },
      isLive: live("s3"),
    });
    assert.deepEqual([r.sessionId, r.source, r.deadWatch], ["s3", "target", true]);
  });

  it("resolves nothing for a DM that carries no session", () => {
    // A DM is session-agnostic, so /cancel must not be pinned to one: with no thread, no watch and no
    // target the resolver has no answer and the bot passes no session, letting the engine cancel the
    // newest question (Qodo a1c4f7e2).
    const r = resolveInboundSession({ channelId: "dm-1", isLive: live() });
    assert.deepEqual([r.sessionId, r.source], [null, "none"]);
  });

  it("reports a dead watch so the caller can clear it", () => {
    const r = resolveInboundSession({ channelId: "ch", watchedSessionId: "gone", isLive: live() });
    assert.equal(r.deadWatch, true);
    assert.equal(r.sessionId, null);
  });

  it("refuses two live sessions delivering into one channel", () => {
    const r = resolveInboundSession({ channelId: "ch", targets: { a: { channelId: "ch" }, b: { channelId: "ch" } }, isLive: live("a", "b") });
    assert.equal(r.ambiguous, true);
    assert.equal(r.sessionId, null);
  });
});
