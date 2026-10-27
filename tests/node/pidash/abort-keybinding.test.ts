/**
 * Abort must never be reachable by a bare Escape (Qodo R7 follow-up).
 *
 * Live verification found Escape bound to abort: pressing it to dismiss the
 * model dropdown silently killed the running turn — twice, including the
 * verification run itself. Abort is now the composer's Stop button only.
 *
 * `matchesKeybinding` compares against an empty key part, so an unbound binding
 * is not inert by accident — it still answers "yes" to a degenerate event whose
 * `key` is "". `isAbortKey` makes the unbound case an explicit no; these
 * assertions lock in both the default and that guard.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KEYBINDINGS, isAbortKey, matchesKeybinding } from "../../../extensions/pidash/pidash-ui/src/hooks/useKeybindings.ts";

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return { key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent;
}

describe("abort keybinding", () => {
  it("ships unbound so no keypress can kill a run", () => {
    const abort = DEFAULT_KEYBINDINGS.find((b) => b.id === "abort");
    assert.ok(abort, "abort binding exists");
    assert.equal(abort!.defaultKey, "");
  });

  it("an unbound abort ignores Escape", () => {
    assert.equal(isAbortKey(keydown({ key: "Escape" }), ""), false);
  });

  it("the raw matcher is not inert for an unbound key — isAbortKey is", () => {
    // The raw matcher compares against an empty key part: real keys never
    // match it, but a degenerate event with key "" does. Hence the explicit
    // Boolean guard in isAbortKey rather than relying on the string compare.
    assert.equal(matchesKeybinding(keydown({ key: "Escape" }), ""), false);
    assert.equal(matchesKeybinding(keydown({ key: "a" }), ""), false);
    assert.equal(matchesKeybinding(keydown({ key: "" }), ""), true);
    assert.equal(isAbortKey(keydown({ key: "" }), ""), false);
  });

  it("a key the user explicitly assigns still works", () => {
    assert.equal(isAbortKey(keydown({ key: "Escape" }), "Escape"), true);
    assert.equal(isAbortKey(keydown({ key: "k", ctrlKey: true }), "Ctrl+K"), true);
    assert.equal(isAbortKey(keydown({ key: "k" }), "Ctrl+K"), false);
  });

  it("session switcher keeps its own Escape-free default", () => {
    const switcher = DEFAULT_KEYBINDINGS.find((b) => b.id === "session-switcher");
    assert.ok(switcher, "session switcher binding exists");
    assert.notEqual(switcher!.defaultKey, "Escape");
  });
});
