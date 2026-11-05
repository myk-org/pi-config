import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_SIZE,
  TMP_PROTECTED_NAMES,
  TMP_SWEEP_LOCK,
  parseSize,
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
  fs.writeFileSync(path.join(dir, "payload.bin"), Buffer.alloc(size));
  const when = new Date(Date.now() - ageDays * DAY);
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

  it("default is 2G", () => {
    assert.equal(parseSize(DEFAULT_MAX_SIZE), 2 * G);
  });
});

describe("sweepProjectTmp", () => {
  it("deletes nothing under the cap, even for 90-day-old entries", () => {
    makeEntry("old-a.bin", MB, 90);
    makeEntry("old-b.bin", MB, 90);
    const result = sweepProjectTmp({ tmpDir, maxBytes: 2 * G, retentionDays: 7 });
    assert.equal(result.deleted, 0);
    assert.equal(fs.readdirSync(tmpDir).length, 2);
  });

  it("deletes nothing when every entry is younger than the retention floor", () => {
    makeEntry("young-a.bin", 2 * MB, 1);
    makeEntry("young-b.bin", 2 * MB, 2);
    const result = sweepProjectTmp({ tmpDir, maxBytes: MB, retentionDays: 7 });
    assert.equal(result.deleted, 0);
    assert.equal(result.skippedYoung, 2);
    assert.equal(result.beforeMb, result.afterMb);
    assert.equal(fs.readdirSync(tmpDir).length, 2);
  });

  it("deletes oldest-first and stops at the cap, young entries survive", () => {
    makeEntry("oldest.bin", 2 * MB, 30);
    makeEntry("older.bin", 2 * MB, 20);
    makeEntry("young.bin", 2 * MB, 1);
    const result = sweepProjectTmp({ tmpDir, maxBytes: 4 * MB, retentionDays: 7 });
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(tmpDir, "oldest.bin")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "older.bin")), true);
    assert.equal(fs.existsSync(path.join(tmpDir, "young.bin")), true);
    assert.ok(result.afterMb <= 4);
  });

  it("removes a whole directory entry as one unit", () => {
    makeDirEntry("cloned-repo", 3 * MB, 30);
    makeDirEntry("keep-me", 3 * MB, 30);
    const result = sweepProjectTmp({ tmpDir, maxBytes: 3 * MB, retentionDays: 7 });
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(tmpDir, "cloned-repo")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "keep-me")), true);
  });

  it("never deletes a protected control file or the tmp root", () => {
    for (const name of TMP_PROTECTED_NAMES) {
      if (name === TMP_SWEEP_LOCK) continue;
      makeEntry(name, 2 * MB, 90);
    }
    // Condition 1: over the cap, everything old enough.
    sweepProjectTmp({ tmpDir, maxBytes: 0, retentionDays: 7 });
    // Condition 2: under the cap.
    makeEntry("filler.bin", 2 * MB, 90);
    sweepProjectTmp({ tmpDir, maxBytes: 100 * MB, retentionDays: 7 });
    for (const name of TMP_PROTECTED_NAMES) {
      if (name === TMP_SWEEP_LOCK) continue;
      assert.equal(fs.existsSync(path.join(tmpDir, name)), true, `${name} must survive`);
    }
    assert.equal(fs.existsSync(tmpDir), true, "tmp root must survive");
  });

  it("unlinks a symlink without touching its target", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-cleanup-target-"));
    try {
      const target = path.join(outside, "precious.bin");
      fs.writeFileSync(target, Buffer.alloc(4 * MB));
      const link = path.join(tmpDir, "old-link");
      fs.symlinkSync(target, link);
      const when = new Date(Date.now() - 90 * DAY);
      fs.lutimesSync(link, when, when);
      const result = sweepProjectTmp({ tmpDir, maxBytes: 1, retentionDays: 7 });
      assert.equal(result.deleted, 1);
      assert.equal(fs.existsSync(link), false);
      assert.equal(fs.existsSync(target), true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("cannot reach a path outside the tmp root", () => {
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-cleanup-sibling-"));
    try {
      const victim = path.join(sibling, "keep.bin");
      fs.writeFileSync(victim, Buffer.alloc(2 * MB));
      makeEntry("filler.bin", 2 * MB, 90);
      sweepProjectTmp({ tmpDir, maxBytes: 0, retentionDays: 7 });
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

  it('"0" disables the sweep — no deletion', () => {
    process.env.PI_PROJECT_TMP_MAX_SIZE = "0";
    makeEntry("old.bin", 4 * MB, 90);
    const result = runProjectTmpSweep(cwd(), { tmpDir });
    assert.equal(result.skipped, "disabled");
    assert.equal(fs.existsSync(path.join(tmpDir, "old.bin")), true);
  });

  it("an invalid size falls back conservatively and deletes nothing", () => {
    process.env.PI_PROJECT_TMP_MAX_SIZE = "2Q";
    makeEntry("old.bin", 4 * MB, 90);
    const result = runProjectTmpSweep(cwd(), { tmpDir });
    assert.equal(result.skipped, "invalid_max_size");
    assert.equal(fs.existsSync(path.join(tmpDir, "old.bin")), true);
  });

  it("skips cleanly when another process holds the lock", () => {
    makeEntry(TMP_SWEEP_LOCK, 8, 0);
    makeEntry("old.bin", 4 * MB, 90);
    const result = runProjectTmpSweep(cwd(), { tmpDir });
    assert.equal(result.skipped, "locked");
    assert.equal(fs.existsSync(path.join(tmpDir, "old.bin")), true);
    assert.equal(fs.existsSync(path.join(tmpDir, TMP_SWEEP_LOCK)), true, "the holder keeps its lock");
  });

  it("releases the lock after a sweep", () => {
    process.env.PI_PROJECT_TMP_MAX_SIZE = "1M";
    makeEntry("old.bin", 4 * MB, 90);
    const result = runProjectTmpSweep(cwd(), { tmpDir });
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(tmpDir, TMP_SWEEP_LOCK)), false);
  });
});
