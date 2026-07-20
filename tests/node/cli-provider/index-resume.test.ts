/**
 * Contract tests for /resume|/new CLI history re-seed (issue #661).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
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
  setCliSessionMarkerMeta,
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

  it("resume from bound sid does not clear concurrent default markers", () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-resume-no-cross-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const cwd = "/proj-concurrent";
      const mine: CliSessionKey = {
        cwd,
        agent: "cursor",
        model: "composer",
        piSessionId: "bound-sid",
      };
      const concurrentDefault: CliSessionKey = {
        cwd,
        agent: "cursor",
        model: "composer",
        piSessionId: "default",
      };
      saveCliSessionId(mine, "mine-cli");
      saveCliSessionId(concurrentDefault, "other-process-cli");

      const prevSid = "bound-sid";
      const includeLegacyDefault =
        prevSid == null || prevSid === "" || prevSid === "default";
      assert.equal(includeLegacyDefault, false);

      const cleared = clearCliSessionsForPiSession(cwd, "new-sid", {
        includeLegacyDefault,
      });
      // Also clear previous bound sid (index.ts path when prev !== readSid)
      const clearedPrev = clearCliSessionsForPiSession(cwd, prevSid, {
        includeLegacyDefault: false,
      });
      assert.equal(cleared + clearedPrev, 1);
      assert.equal(loadCliSessionId(mine), null);
      assert.equal(loadCliSessionId(concurrentDefault), "other-process-cli");
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
      assert.equal(
        setCliSessionMarkerMeta(key, { status: "running", idleMs: 60_000 }),
        true,
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

  it("does not reap idle running marker from a different piSessionId", () => {
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
        piSessionId: "other-sid",
      };
      saveCliSessionId(key, "other-cli");
      assert.equal(
        setCliSessionMarkerMeta(key, { status: "running", idleMs: 60_000 }),
        true,
      );
      const n = reapStaleCliSessions({
        inactivityThresholdMs: 1_000,
        activePiSessionId: "current-sid",
      });
      assert.equal(n, 0);
      assert.equal(loadCliSessionId(key), "other-cli");
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
      assert.equal(
        setCliSessionMarkerMeta(key, { status: "running", idleMs: 60_000 }),
        true,
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
  });

  it("resolveReaperActivePiSessionId stays unknown when getter returns null", () => {
    assert.equal(
      resolveReaperActivePiSessionId(() => null, "from-env"),
      null,
    );
  });

  it("resolveReaperActivePiSessionId stays unknown when getter returns empty", () => {
    assert.equal(
      resolveReaperActivePiSessionId(() => "", "from-env"),
      null,
    );
  });

  it("resolveReaperActivePiSessionId uses env when no getter provided", () => {
    assert.equal(
      resolveReaperActivePiSessionId(undefined, "from-env"),
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
      assert.equal(
        setCliSessionMarkerMeta(key, { status: "running", idleMs: 60_000 }),
        true,
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

  it("interval sweep reaps idle stopped but keeps concurrent running markers", async () => {
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const home = mkdtempSync(join(tmpdir(), "cli-reaper-interval-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PI_SESSION_ID = "env-sid";
    stopCliSessionReaper();
    try {
      const otherRunning: CliSessionKey = {
        cwd: "/proj",
        agent: "gemini",
        model: "flash",
        piSessionId: "other-sid",
      };
      const stopped: CliSessionKey = {
        cwd: "/proj",
        agent: "cursor",
        model: "composer",
        piSessionId: "old-sid",
      };
      saveCliSessionId(otherRunning, "other-cli");
      saveCliSessionId(stopped, "stopped-cli");
      assert.equal(
        setCliSessionMarkerMeta(otherRunning, {
          status: "running",
          idleMs: 60_000,
        }),
        true,
      );
      assert.equal(
        setCliSessionMarkerMeta(stopped, { status: "stopped", idleMs: 60_000 }),
        true,
      );

      startCliSessionReaper({
        sweepIntervalMs: 40,
        inactivityThresholdMs: 1_000,
        getActivePiSessionId: () => "current-sid",
      });
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && loadCliSessionId(stopped) !== null) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(loadCliSessionId(stopped), null);
      assert.equal(loadCliSessionId(otherRunning), "other-cli");
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
