/**
 * Temp dirs for the sidecar suite: one run root, per-test teardown, nothing left behind.
 *
 * Every dir lives in `<tmp>/pi-config-tests/run-<pid>`, so a run adds ONE directory under /tmp
 * instead of one per test. Scope follows creation time, like a fixture: dirs made at module load
 * or in `before()` die with the file, dirs made inside a test are deleted by `afterEach`.
 * A run root whose process is gone is reaped on the next import (process check, no timers).
 *
 * The hooks register on import, so a test file cannot forget teardown.
 */
import { after, afterEach, beforeEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_TMP_BASE = process.env.PI_TEST_TMP_BASE ?? path.join(os.tmpdir(), "pi-config-tests");
export const TEST_RUN_ROOT = path.join(TEST_TMP_BASE, `run-${process.pid}`);

const created: string[] = [];
let testStart = 0;

function create(prefix: string): string {
  // `recursive` still throws if the container vanishes mid-call; one retry covers that window.
  try {
    fs.mkdirSync(TEST_RUN_ROOT, { recursive: true });
  } catch {
    fs.mkdirSync(TEST_RUN_ROOT, { recursive: true });
  }
  const dir = fs.mkdtempSync(path.join(TEST_RUN_ROOT, prefix));
  created.push(dir);
  return dir;
}

function removeDirs(dirs: string[]): void {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}

function reapDeadRuns(): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(TEST_TMP_BASE);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = /^run-(\d+)$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch {
      try {
        fs.rmSync(path.join(TEST_TMP_BASE, name), { recursive: true, force: true });
      } catch {
        /* raced with its own cleanup */
      }
    }
  }
}

/** Test-scoped: deleted after the test that created it, pass or fail. */
export function makeTempDir(prefix: string): string {
  return create(prefix);
}

/** File-scoped: for a fixture created in `before()`; removed with the run root. */
export const makeFileTempDir = makeTempDir;

reapDeadRuns();

beforeEach(() => {
  testStart = created.length;
});
afterEach(() => removeDirs(created.splice(testStart)));
after(() => {
  removeDirs(created.splice(0));
  try {
    fs.rmSync(TEST_RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
  // The shared container is deliberately left in place: another test process can be between
  // creating it and creating its run root, and removing it here makes that mkdir fail (ENOENT).
});
