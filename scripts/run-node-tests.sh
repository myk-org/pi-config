#!/usr/bin/env bash
# Run the Node test suites with a run-scoped temp dir that is deleted afterwards.
#
# 90 test files call `mkdtempSync(os.tmpdir(), …)` and node:test only removes what it
# created, so a crashed or killed run left every directory behind — the observed damage
# was /tmp filling with `review-learning-*` dirs until nothing could be created.
#
# The base cannot live under `.pi/tmp`: several tests assert behaviour *because* their temp
# tree is outside the checkout (the tmp sweep refuses a dir inside it; git-root and
# worktree detection would find this repo). So the run gets its own dir in the OS temp
# location, which the trap deletes, and stale dirs from killed runs are swept on start.
#
# Usage: scripts/run-node-tests.sh 'tests/node/**/*.test.ts'
set -euo pipefail

base="${TMPDIR:-/tmp}"
# Reap directories from runs that never reached their trap (killed CI job, Ctrl-C on a
# container teardown). Only ones this script created, and only if they are not this run.
find "$base" -maxdepth 1 -type d -name 'pi-node-tests-*' -mmin +120 -exec /bin/rm -rf {} + 2>/dev/null || true

run_tmp="$(mktemp -d "$base/pi-node-tests-XXXXXX")"
export TMPDIR="$run_tmp"
export TMP="$run_tmp"
export TEMP="$run_tmp"

cleanup() { /bin/rm -rf "$run_tmp"; }
trap cleanup EXIT

npx tsx --test "$@"
