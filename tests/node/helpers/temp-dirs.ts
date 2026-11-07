/**
 * Temp dirs for tests: one run root, per-test teardown, nothing left behind.
 *
 * Every test temp dir is created inside ONE run root — `<tmp>/pi-config-tests/run-<pid>` — so a
 * run puts a single directory in /tmp, not thousands. `makeTempDir` is test-scoped (deleted by
 * `afterEach`, pass or fail); `makeFileTempDir` is for fixtures created in `before()` and dies
 * with the file. When the file's tests finish, the run root goes as a whole.
 *
 * The hooks register on import, so a test file cannot forget the teardown: 87 files used to call
 * `mkdtempSync` with no cleanup at all and 50k+ directories accumulated in /tmp.
 */
import { after, afterEach, beforeEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Container for every run; one entry per active test process. */
export const TEST_TMP_BASE = process.env.PI_TEST_TMP_BASE ?? path.join(os.tmpdir(), "pi-config-tests");
/** This process's run root — the single directory a run adds under /tmp. */
export const TEST_RUN_ROOT = path.join(TEST_TMP_BASE, `run-${process.pid}`);

/** Every dir this file created, in creation order. Dirs made before the first test (module
 *  setup) or inside `before()` belong to the file and live until its teardown; dirs made
 *  inside a test die with that test. */
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

/** Delete run roots whose process is gone — a killed run, not a time-based rule. */
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
      continue; // owner still alive
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
/** Alias kept for fixtures created in `before()`; the scope comes from when it is created. */
export const makeFileTempDir = makeTempDir;

// A test process can end without reaching `after()`: a spawned child killed, a crash, Ctrl-C, or a
// cancelled CI job. `exit` covers the first two, but a signal terminates without emitting `exit`
// unless it is handled — so SIGINT/SIGTERM/SIGHUP remove the run root and then exit with the
// conventional 128+signal code. Only SIGKILL (and power loss) can still leave a directory, and the
// next run reaps it by PID.
function cleanupRunRoot(): void {
  try {
    fs.rmSync(TEST_RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

process.once("exit", cleanupRunRoot);
for (const [signal, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const) {
  process.once(signal, () => {
    cleanupRunRoot();
    process.exit(128 + number);
  });
}

reapDeadRuns();

beforeEach(() => {
  testStart = created.length;
});
afterEach(() => {
  removeDirs(created.splice(testStart));
});
after(() => {
  removeDirs(created.splice(0));
  try {
    fs.rmSync(TEST_RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
  try {
    fs.rmdirSync(TEST_TMP_BASE);
  } catch {
    /* other test files are still running */
  }
});
