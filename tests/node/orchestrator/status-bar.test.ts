import { describe, it } from "node:test";
import assert from "node:assert";
import { setSlot, clearSlot } from "../../../extensions/orchestrator/status-bar.js";

describe("status-bar", () => {
  it("setSlot does not throw when ctx is undefined", () => {
    assert.doesNotThrow(() => setSlot("async", "test", undefined));
  });

  it("setSlot does not throw when ctx.ui is undefined", () => {
    assert.doesNotThrow(() => setSlot("async", "test", {}));
  });

  it("clearSlot does not throw when ctx is undefined", () => {
    assert.doesNotThrow(() => clearSlot("async", undefined));
  });

  it("setSlot calls ctx.ui.setStatus when ctx is valid", () => {
    let called = false;
    let calledKey = "";
    let calledValue = "";
    const ctx = {
      ui: {
        setStatus: (key: string, value: string) => {
          called = true;
          calledKey = key;
          calledValue = value;
        },
      },
    };
    setSlot("async", "test-value", ctx);
    assert.equal(called, true);
    assert.equal(calledKey, "2-async");
    assert.equal(calledValue, "test-value");
  });
});
