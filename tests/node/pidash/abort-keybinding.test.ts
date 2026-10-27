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

  it("raw matching: real keys never match an empty binding", () => {
    // The matcher compares against an empty key part, so real keys are inert.
    assert.equal(matchesKeybinding(keydown({ key: "Escape" }), ""), false);
    assert.equal(matchesKeybinding(keydown({ key: "a" }), ""), false);
  });

  it("raw matching: a degenerate empty-key event DOES match an empty binding", () => {
    // This is why the guard is explicit — the string compare alone is not a
    // safe "nothing is bound" test.
    assert.equal(matchesKeybinding(keydown({ key: "" }), ""), true);
  });

  it("isAbortKey suppresses even the degenerate empty-key event", () => {
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
