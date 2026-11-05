import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_RETENTION_DAYS,
  TMP_PROTECTED_NAMES,
  TMP_SWEEP_LOCK,
  parseSize,
  registerTmpCleanup,
  runProjectTmpSweep,
  sweepProjectTmp,
} from "../../../extensions/orchestrator/tmp-cleanup.js";

const MB = 1024 * 1024;
const G = 1024 * MB;
const DAY = 24 * 60 * 60 * 1000;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-cleanup-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a file of `size` bytes and back-date it `ageDays` days. */
function makeEntry(name: string, size: number, ageDays: number): string {
  const target = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(size));
  const when = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(target, when, when);
  return target;
}

function makeDirEntry(name: string, size: number, ageDays: number): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const payload = path.join(dir, "payload.bin");
  fs.writeFileSync(payload, Buffer.alloc(size));
  const when = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(payload, when, when);
  fs.utimesSync(dir, when, when);
  return dir;
}

describe("parseSize", () => {
  it("accepts the documented forms", () => {
    assert.equal(parseSize("2G"), 2 * G);
    assert.equal(parseSize("2GB"), 2 * G);
    assert.equal(parseSize("2GiB"), 2 * G);
    assert.equal(parseSize("2g"), 2 * G);
    assert.equal(parseSize("2048M"), 2048 * MB);
    assert.equal(parseSize("100M"), 100 * MB);
    assert.equal(parseSize("1.5G"), 1.5 * G);
    assert.equal(parseSize("2048"), 2048 * MB);
    assert.equal(parseSize("0"), 0);
  });

  it("returns undefined for invalid values", () => {
    for (const bad of ["2Q", "2gig", "", "  ", "G", "1.2.3G", "-1G", "2 G"]) {
      assert.equal(parseSize(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`);
    }
  });

  it("defaults come from settings-keys.json", () => {
    assert.equal(parseSize(DEFAULT_MAX_SIZE), 2 * G);
    assert.equal(DEFAULT_RETENTION_DAYS, 7);
  });
});

describe("sweepProjectTmp", () => {
  it("deletes nothing under the cap, even for 90-day-old entries", async () => {
    makeEntry("old-a.bin", MB, 90);
    makeEntry("old-b.bin", MB, 90);
    const result = await sweepProjectTmp({ tmpDir, maxBytes: 2 * G, retentionDays: 7 });
    assert.equal(result.deleted, 0);
    assert.equal(fs.readdirSync(tmpDir).length, 2);
  });

  it("deletes nothing when every entry is younger than the retention floor", async () => {
    makeEntry("young-a.bin", 2 * MB, 1);
    makeEntry("young-b.bin", 2 * MB, 2);
    const result = await sweepProjectTmp({ tmpDir, maxBytes: MB, retentionDays: 7 });
    assert.equal(result.deleted, 0);
    assert.equal(result.skippedYoung, 2);
    assert.equal(result.beforeMb, result.afterMb);
    assert.equal(fs.readdirSync(tmpDir).length, 2);
  });

  it("deletes the oldest entry first", async () => {
    makeEntry("oldest.bin", 2 * MB, 30);
    makeEntry("older.bin", 2 * MB, 20);
    makeEntry("young.bin", 2 * MB, 1);
    const result = await sweepProjectTmp({ tmpDir, maxBytes: 4 * MB, retentionDays: 7 });
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(tmpDir, "oldest.bin")), false);
  });

  it("stops deleting once the total fits under the cap", async () => {
    makeEntry("oldest.bin", 2 * MB, 30);
    makeEntry("older.bin", 2 * MB, 20);
    makeEntry("old.bin", 2 * MB, 10);
    const result = await sweepProjectTmp({ tmpDir, maxBytes: 4 * MB, retentionDays: 7 });
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(tmpDir, "older.bin")), true);
    assert.ok(result.afterMb <= 4);
  });

  it("keeps young entries while deleting old ones", async () => {
    makeEntry("oldest.bin", 2 * MB, 30);
    makeEntry("young.bin", 2 * MB, 1);
    const result = await sweepProjectTmp({ tmpDir, maxBytes: MB, retentionDays: 7 });
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(tmpDir, "young.bin")), true);
  });

  it("removes a whole directory entry as one unit", async () => {
    makeDirEntry("cloned-repo", 3 * MB, 30);
    makeDirEntry("keep-me", 3 * MB, 30);
    const result = await sweepProjectTmp({ tmpDir, maxBytes: 3 * MB, retentionDays: 7 });
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(tmpDir, "cloned-repo")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "keep-me")), true);
  });

  it("ages a directory by its newest nested file, not its own mtime", async () => {
    const dir = makeDirEntry("active-task", 2 * MB, 90);
    const fresh = path.join(dir, "written-today.bin");
    fs.writeFileSync(fresh, Buffer.alloc(MB));
    const result = await sweepProjectTmp({ tmpDir, maxBytes: 1, retentionDays: 7 });
    assert.equal(result.deleted, 0);
    assert.equal(fs.existsSync(fresh), true);
  });

  it("never deletes a protected control file or the tmp root", async () => {
    for (const name of TMP_PROTECTED_NAMES) {
      if (name === TMP_SWEEP_LOCK) continue;
      makeEntry(name, 2 * MB, 90);
    }
    // Condition 1: over the cap, everything old enough.
    await sweepProjectTmp({ tmpDir, maxBytes: 0, retentionDays: 7 });
    // Condition 2: under the cap.
    makeEntry("filler.bin", 2 * MB, 90);
    await sweepProjectTmp({ tmpDir, maxBytes: 100 * MB, retentionDays: 7 });
    for (const name of TMP_PROTECTED_NAMES) {
      if (name === TMP_SWEEP_LOCK) continue;
      assert.equal(fs.existsSync(path.join(tmpDir, name)), true, `${name} must survive`);
    }
    assert.equal(fs.existsSync(tmpDir), true, "tmp root must survive");
  });

  it("unlinks a symlink without touching its target", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-cleanup-target-"));
    try {
      const target = path.join(outside, "precious.bin");
      fs.writeFileSync(target, Buffer.alloc(4 * MB));
      const link = path.join(tmpDir, "old-link");
      fs.symlinkSync(target, link);
      const when = new Date(Date.now() - 90 * DAY);
      fs.lutimesSync(link, when, when);
      const result = await sweepProjectTmp({ tmpDir, maxBytes: 1, retentionDays: 7 });
      assert.equal(result.deleted, 1);
      assert.equal(fs.existsSync(link), false);
      assert.equal(fs.existsSync(target), true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("skips an entry replaced between the scan and the delete", async () => {
    const victim = makeEntry("old.bin", 4 * MB, 90);
    const realLstat = fsp.lstat;
    let calls = 0;
    // Second look at the victim is the pre-delete identity check: swap the contents first.
    fsp.lstat = ((target: any, ...rest: any[]) => {
      if (target === victim && ++calls === 2) {
        fs.rmSync(victim);
        fs.writeFileSync(victim, Buffer.alloc(MB));
      }
      return (realLstat as any)(target, ...rest);
    }) as any;
    try {
      const result = await sweepProjectTmp({ tmpDir, maxBytes: 1, retentionDays: 7 });
      assert.equal(result.deleted, 0);
      assert.equal(fs.statSync(victim).size, MB, "the replacement must survive");
    } finally {
      fsp.lstat = realLstat;
    }
  });

  it("refuses a tmp root swapped for a symlink once the scan started", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-cleanup-outside-"));
    const moved = `${tmpDir}-moved`;
    try {
      makeEntry("old.bin", 4 * MB, 90);
      const realRealpath = fsp.realpath;
      let swapped = false;
      // The scan is done when the destructive phase re-resolves the root: swap it there.
      fsp.realpath = (async (target: any, ...rest: any[]) => {
        if (!swapped) {
          swapped = true;
          fs.renameSync(tmpDir, moved);
          fs.symlinkSync(outside, tmpDir, "dir");
        }
        return (realRealpath as any)(target, ...rest);
      }) as any;
      try {
        const result = await sweepProjectTmp({ tmpDir, maxBytes: 1, retentionDays: 7 });
        assert.equal(result.skipped, "outside_checkout");
        assert.equal(result.deleted, 0);
        assert.equal(fs.existsSync(path.join(moved, "old.bin")), true);
      } finally {
        fsp.realpath = realRealpath;
        fs.rmSync(tmpDir, { force: true });
        fs.renameSync(moved, tmpDir);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("cannot reach a path outside the tmp root", async () => {
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-cleanup-sibling-"));
    try {
      const victim = path.join(sibling, "keep.bin");
      fs.writeFileSync(victim, Buffer.alloc(2 * MB));
      makeEntry("filler.bin", 2 * MB, 90);
      await sweepProjectTmp({ tmpDir, maxBytes: 0, retentionDays: 7 });
      assert.equal(fs.existsSync(victim), true);
      assert.equal(fs.existsSync(tmpDir), true);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe("runProjectTmpSweep", () => {
  const cwd = () => path.dirname(tmpDir);

  beforeEach(() => {
    process.env.PI_PROJECT_TMP_MAX_SIZE = "";
    process.env.PI_PROJECT_TMP_RETENTION_DAYS = "";
  });

  afterEach(() => {
    delete process.env.PI_PROJECT_TMP_MAX_SIZE;
    delete process.env.PI_PROJECT_TMP_RETENTION_DAYS;
  });

  it('"0" disables the sweep — no deletion', async () => {
    process.env.PI_PROJECT_TMP_MAX_SIZE = "0";
    makeEntry("old.bin", 4 * MB, 90);
    const result = await runProjectTmpSweep(cwd(), { tmpDir });
    assert.equal(result.skipped, "disabled");
    assert.equal(fs.existsSync(path.join(tmpDir, "old.bin")), true);
  });

  it("a numeric 0 in the settings file also disables it", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-cleanup-project-"));
    try {
      fs.mkdirSync(path.join(project, ".pi", "tmp"), { recursive: true });
      fs.writeFileSync(path.join(project, ".pi", "pi-config-settings.json"), JSON.stringify({ project_tmp_max_size: 0 }));
      const result = await runProjectTmpSweep(project);
      assert.equal(result.skipped, "disabled");
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("an invalid size deletes nothing", async () => {
    process.env.PI_PROJECT_TMP_MAX_SIZE = "2Q";
    makeEntry("old.bin", 4 * MB, 90);
    const result = await runProjectTmpSweep(cwd(), { tmpDir });
    assert.equal(result.skipped, "invalid_max_size");
    assert.equal(fs.existsSync(path.join(tmpDir, "old.bin")), true);
  });

  it("refuses a tmp dir that resolves outside the checkout", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-cleanup-project-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-cleanup-outside-"));
    try {
      fs.mkdirSync(path.join(outside, "tmp"), { recursive: true });
      fs.symlinkSync(path.join(outside, "tmp"), path.join(project, ".pi"), "dir");
      const result = await runProjectTmpSweep(project);
      assert.equal(result.skipped, "outside_checkout");
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("skips cleanly when another process holds the lock", async () => {
    makeEntry(TMP_SWEEP_LOCK, 8, 0);
    makeEntry("old.bin", 4 * MB, 90);
    const result = await runProjectTmpSweep(cwd(), { tmpDir });
    assert.equal(result.skipped, "locked");
    assert.equal(fs.existsSync(path.join(tmpDir, "old.bin")), true);
    assert.equal(fs.existsSync(path.join(tmpDir, TMP_SWEEP_LOCK)), true, "the holder keeps its lock");
  });

  it("reclaims a stale lock and sweeps", async () => {
    process.env.PI_PROJECT_TMP_MAX_SIZE = "1M";
    const lock = path.join(tmpDir, TMP_SWEEP_LOCK);
    fs.writeFileSync(lock, "0");
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    makeEntry("old.bin", 4 * MB, 90);
    const result = await runProjectTmpSweep(cwd(), { tmpDir });
    assert.equal(result.skipped, undefined);
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(lock), false);
  });

  it("releases the lock after a sweep", async () => {
    process.env.PI_PROJECT_TMP_MAX_SIZE = "1M";
    makeEntry("old.bin", 4 * MB, 90);
    const result = await runProjectTmpSweep(cwd(), { tmpDir });
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(tmpDir, TMP_SWEEP_LOCK)), false);
  });
});

describe("registerTmpCleanup", () => {
  function handlerFor(): (event: unknown, ctx: unknown) => void {
    let handler: ((event: unknown, ctx: unknown) => void) | undefined;
    const pi = { on: (name: string, fn: any) => { if (name === "session_start") handler = fn; } } as any;
    registerTmpCleanup(pi);
    assert.ok(handler, "session_start must be registered");
    return handler!;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it("skips print sessions", async () => {
    const handler = handlerFor();
    handler({}, { cwd: tmpDir, mode: "print" });
    await settle();
    assert.equal(fs.existsSync(path.join(tmpDir, ".pi", "tmp")), false);
  });

  it("skips json sessions", async () => {
    const handler = handlerFor();
    handler({}, { cwd: tmpDir, mode: "json" });
    await settle();
    assert.equal(fs.existsSync(path.join(tmpDir, ".pi", "tmp")), false);
  });

  it("sweeps a normal session start in the session cwd", async () => {
    const handler = handlerFor();
    handler({}, { cwd: tmpDir, mode: "tui" });
    await settle();
    assert.equal(fs.existsSync(path.join(tmpDir, ".pi", "tmp")), true);
  });
});
