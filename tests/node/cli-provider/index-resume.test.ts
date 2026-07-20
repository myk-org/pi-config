/**
 * Contract tests for /resume|/new CLI history re-seed (issue #661).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applySystemPromptToCliPrompt,
  clearCliSessionsForPiSession,
  decideCliSessionStartReseed,
  loadCliSessionId,
  resolveCliHistorySeed,
  saveCliSessionId,
  type CliSessionKey,
} from "../../../extensions/cli-provider/sessions.js";
import { reapStaleCliSessions, resolveReaperActivePiSessionId, startCliSessionReaper, stopCliSessionReaper } from "../../../extensions/cli-provider/session-reaper.js";

describe("decideCliSessionStartReseed (/resume contract)", () => {
  it("keeps markers on reload", () => {
    const d = decideCliSessionStartReseed({
      reason: "reload",
      prevPiSessionId: "sid-a",
      nextPiSessionId: "sid-a",
    });
    assert.equal(d.action, "keep");
    assert.equal(d.forceHistorySeed, false);
  });

  it("reseeds on resume", () => {
    const d = decideCliSessionStartReseed({
      reason: "resume",
      prevPiSessionId: null,
      nextPiSessionId: "sid-b",
    });
    assert.equal(d.action, "reseed");
    assert.equal(d.forceHistorySeed, true);
  });

  it("reseeds on new", () => {
    const d = decideCliSessionStartReseed({
      reason: "new",
      prevPiSessionId: "sid-a",
      nextPiSessionId: "sid-b",
    });
    assert.equal(d.action, "reseed");
    assert.equal(d.forceHistorySeed, true);
  });

  it("reseeds when pi session id changes", () => {
    const d = decideCliSessionStartReseed({
      reason: "startup",
      prevPiSessionId: "sid-a",
      nextPiSessionId: "sid-b",
    });
    assert.equal(d.action, "reseed");
    assert.equal(d.forceHistorySeed, true);
  });

  it("bind-only on ordinary start with same id", () => {
    const d = decideCliSessionStartReseed({
      reason: "startup",
      prevPiSessionId: null,
      nextPiSessionId: "sid-a",
    });
    assert.equal(d.action, "bind-only");
    assert.equal(d.forceHistorySeed, false);
  });
});

describe("/resume reseed path (markers + history seed)", () => {
  it("clears matching piSession markers on resume", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-resume-clear-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const cwd = "/proj-resume";
      const key: CliSessionKey = {
        cwd,
        agent: "cursor",
        model: "composer",
        piSessionId: "new-sid",
      };
      const other: CliSessionKey = {
        cwd,
        agent: "cursor",
        model: "composer",
        piSessionId: "other-sid",
      };
      saveCliSessionId(key, "stale-cli-chat");
      saveCliSessionId(other, "other-cli-chat");

      const decision = decideCliSessionStartReseed({
        reason: "resume",
        prevPiSessionId: null,
        nextPiSessionId: "new-sid",
      });
      assert.equal(decision.action, "reseed");

      const cleared = clearCliSessionsForPiSession(cwd, "new-sid", {
        includeLegacyDefault: true,
      });
      assert.equal(cleared, 1);
      assert.equal(loadCliSessionId(key), null);
      assert.equal(loadCliSessionId(other), "other-cli-chat");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("forces history seed after resume decision", () => {
    const decision = decideCliSessionStartReseed({
      reason: "resume",
      prevPiSessionId: "old-sid",
      nextPiSessionId: "new-sid",
    });
    assert.equal(decision.forceHistorySeed, true);
    assert.deepEqual(
      resolveCliHistorySeed({
        hasCliSession: true,
        forceHistorySeed: decision.forceHistorySeed,
      }),
      { useCliSession: false, seedHistory: true },
    );
  });

  it("reload clears a pending forceHistorySeed flag", () => {
    const reseed = decideCliSessionStartReseed({
      reason: "resume",
      prevPiSessionId: null,
      nextPiSessionId: "sid-a",
    });
    assert.equal(reseed.forceHistorySeed, true);

    // Mimic index.ts: every session_start assigns forceHistorySeed = decision.forceHistorySeed
    let forceHistorySeed = reseed.forceHistorySeed;
    const reload = decideCliSessionStartReseed({
      reason: "reload",
      prevPiSessionId: "sid-a",
      nextPiSessionId: "sid-a",
    });
    forceHistorySeed = reload.forceHistorySeed;
    assert.equal(forceHistorySeed, false);
    assert.deepEqual(
      resolveCliHistorySeed({ hasCliSession: true, forceHistorySeed }),
      { useCliSession: true, seedHistory: false },
    );
  });

  it("reload does not clear markers", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-reload-keep-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const cwd = "/proj-reload";
      const key: CliSessionKey = {
        cwd,
        agent: "cursor",
        model: "composer",
        piSessionId: "same-sid",
      };
      saveCliSessionId(key, "live-cli-chat");

      const decision = decideCliSessionStartReseed({
        reason: "reload",
        prevPiSessionId: "same-sid",
        nextPiSessionId: "same-sid",
      });
      assert.equal(decision.action, "keep");
      assert.equal(loadCliSessionId(key), "live-cli-chat");
      assert.deepEqual(
        resolveCliHistorySeed({
          hasCliSession: true,
          forceHistorySeed: decision.forceHistorySeed,
        }),
        { useCliSession: true, seedHistory: false },
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("reaper vs active piSessionId", () => {
  it("does not reap idle running marker for the active pi session", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-reap-active-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "active-sid",
      };
      saveCliSessionId(key, "live-id");
      const dir = join(home, ".pi", "cli-sessions");
      const files = readdirSync(dir);
      const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
      writeFileSync(
        join(dir, files[0]),
        JSON.stringify({
          ...rec,
          status: "running",
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const n = reapStaleCliSessions({
        inactivityThresholdMs: 1_000,
        activePiSessionId: "active-sid",
      });
      assert.equal(n, 0);
      assert.equal(loadCliSessionId(key), "live-id");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reaps idle running marker from a different piSessionId", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-reap-other-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "old-sid",
      };
      saveCliSessionId(key, "orphan-id");
      const dir = join(home, ".pi", "cli-sessions");
      const files = readdirSync(dir);
      const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
      writeFileSync(
        join(dir, files[0]),
        JSON.stringify({
          ...rec,
          status: "running",
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const n = reapStaleCliSessions({
        inactivityThresholdMs: 1_000,
        activePiSessionId: "current-sid",
      });
      assert.equal(n, 1);
      assert.equal(loadCliSessionId(key), null);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps idle running markers when active piSessionId is unknown", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-reap-unknown-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "orphan",
      };
      saveCliSessionId(key, "orphan-id");
      const dir = join(home, ".pi", "cli-sessions");
      const files = readdirSync(dir);
      const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
      writeFileSync(
        join(dir, files[0]),
        JSON.stringify({
          ...rec,
          status: "running",
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );
      const n = reapStaleCliSessions({
        inactivityThresholdMs: 1_000,
        activePiSessionId: null,
      });
      assert.equal(n, 0);
      assert.equal(loadCliSessionId(key), "orphan-id");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("applySystemPromptToCliPrompt (resume-retry contract)", () => {
  it("prepends system prompt for a fresh CLI session after failed resume", () => {
    const rebuilt = "seeded history\n\nuser: try again";
    const withSys = applySystemPromptToCliPrompt(
      rebuilt,
      "You are being used as a backend LLM",
    );
    assert.match(withSys, /^You are being used as a backend LLM/);
    assert.match(withSys, /---/);
    assert.match(withSys, /seeded history/);
  });

  it("leaves prompt unchanged when system prompt is missing", () => {
    assert.equal(applySystemPromptToCliPrompt("only user", undefined), "only user");
  });
});

describe("startCliSessionReaper scheduling", () => {
  it("resolveReaperActivePiSessionId prefers getter over env", () => {
    assert.equal(
      resolveReaperActivePiSessionId(() => "from-getter", "from-env"),
      "from-getter",
    );
    assert.equal(
      resolveReaperActivePiSessionId(() => null, "from-env"),
      "from-env",
    );
    assert.equal(
      resolveReaperActivePiSessionId(() => "", "from-env"),
      "from-env",
    );
  });

  it("does not sweep immediately on start", async () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-reaper-start-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    stopCliSessionReaper();
    try {
      const key: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "other",
      };
      saveCliSessionId(key, "orphan-id");
      const dir = join(home, ".pi", "cli-sessions");
      const files = readdirSync(dir);
      const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
      writeFileSync(
        join(dir, files[0]),
        JSON.stringify({
          ...rec,
          status: "running",
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );

      startCliSessionReaper({
        sweepIntervalMs: 200,
        inactivityThresholdMs: 1_000,
        getActivePiSessionId: () => "current",
      });
      // Immediate check — must not have swept yet
      assert.equal(loadCliSessionId(key), "orphan-id");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(loadCliSessionId(key), "orphan-id");
    } finally {
      stopCliSessionReaper();
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("interval sweep uses getActivePiSessionId to protect current session", async () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-reaper-interval-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PI_SESSION_ID = "env-sid";
    stopCliSessionReaper();
    try {
      const other: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "other-sid",
      };
      saveCliSessionId(other, "other-cli");
      const dir = join(home, ".pi", "cli-sessions");
      const files = readdirSync(dir);
      const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
      writeFileSync(
        join(dir, files[0]),
        JSON.stringify({
          ...rec,
          status: "running",
          lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      );

      startCliSessionReaper({
        sweepIntervalMs: 40,
        inactivityThresholdMs: 1_000,
        getActivePiSessionId: () => "current-sid",
      });
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(loadCliSessionId(other), null);
    } finally {
      stopCliSessionReaper();
      delete process.env.PI_SESSION_ID;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
