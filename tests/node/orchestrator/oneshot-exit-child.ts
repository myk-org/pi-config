/**
 * Child for oneshot-exit.test.ts — must drain with no leftover handles.
 * Mirrors the #755 hang: unref-less timer/spawn kept `pi -p` alive.
 * Production guards are isPiOneshotInvocation + shouldSkipOneshotShutdownDream.
 */
import {
  isPiOneshotInvocation,
  shouldSkipOneshotShutdownDream,
} from "../../../extensions/orchestrator/utils.ts";

process.argv = ["node", "pi", "-p", "say hi"];

if (!isPiOneshotInvocation()) {
  setInterval(() => {}, 60_000);
}
if (!shouldSkipOneshotShutdownDream("print")) {
  setInterval(() => {}, 60_000);
}
