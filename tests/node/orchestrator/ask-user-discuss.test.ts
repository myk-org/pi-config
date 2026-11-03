import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DISCUSS_LABEL,
  DISCUSS_VALUE,
  answerToValue,
  browserAskOptions,
  buildAskOptions,
  registerAskUser,
} from "../../../extensions/orchestrator/ask-user.ts";

const FREE_INPUT = "__free_input__";

describe("buildAskOptions", () => {
  it("appends the discuss item after caller options, before Other (default)", () => {
    const items = buildAskOptions(["Yes", "No"], true);
    assert.deepStrictEqual(
      items.map((i) => i.value),
      ["Yes", "No", DISCUSS_VALUE, FREE_INPUT],
    );
    assert.equal(items[2].label, DISCUSS_LABEL);
  });

  it("omits the discuss item when allowDiscuss is false", () => {
    const items = buildAskOptions(["Yes", "No"], false);
    assert.deepStrictEqual(items.map((i) => i.value), ["Yes", "No", FREE_INPUT]);
    assert.ok(!items.some((i) => i.value === DISCUSS_VALUE));
  });

  it("keeps the discuss item last-of-choices for any option count", () => {
    for (const opts of [["a"], ["a", "b", "c"]]) {
      const values = buildAskOptions(opts, true).map((i) => i.value);
      assert.deepStrictEqual(values, [...opts, DISCUSS_VALUE, FREE_INPUT]);
    }
  });

  it("leaves free-input-only mode unchanged", () => {
    assert.deepStrictEqual(buildAskOptions(undefined, true), []);
    assert.deepStrictEqual(buildAskOptions([], true), []);
  });
});

describe("browserAskOptions", () => {
  it("carries the discuss choice as its label, never the TUI-only Other row", () => {
    const emitted = browserAskOptions(buildAskOptions(["Yes", "No"], true));
    assert.deepStrictEqual(emitted, ["Yes", "No", DISCUSS_LABEL]);
  });

  it("drops the discuss choice when suppressed", () => {
    const emitted = browserAskOptions(buildAskOptions(["Yes"], false));
    assert.deepStrictEqual(emitted, ["Yes"]);
  });
});

describe("answerToValue", () => {
  it("maps the discuss label back to the sentinel", () => {
    assert.equal(answerToValue(DISCUSS_LABEL), DISCUSS_VALUE);
  });

  it("passes ordinary answers through", () => {
    assert.equal(answerToValue("Yes"), "Yes");
  });
});

describe("ask_user result", () => {
  /** Drives registerAskUser's tool with a fake pi/ctx whose dialog answers `answer`. */
  async function runAsk(params: any, answer: string | null) {
    let tool: any;
    const pi = {
      registerTool: (t: any) => {
        tool = t;
      },
      events: { emit: () => {}, on: () => () => {} },
    };
    registerAskUser(pi as any, () => {});
    const ctx = {
      hasUI: true,
      ui: {
        // Fake dialog: build the component, then answer as the TUI would.
        custom: (factory: any) => {
          const theme = new Proxy({}, { get: () => (s: string) => s });
          factory({ requestRender: () => {} }, theme, {}, () => {});
          return Promise.resolve(answer);
        },
      },
    };
    return tool.execute("id", params, undefined, undefined, ctx);
  }

  it("returns the bare sentinel and does not terminate", async () => {
    const result = await runAsk({ question: "Ship it?", options: ["Yes", "No"] }, DISCUSS_VALUE);
    assert.deepStrictEqual(result.content, [{ type: "text", text: DISCUSS_VALUE }]);
    assert.equal(result.terminate, undefined);
  });

  it("still terminates on cancel", async () => {
    const result = await runAsk({ question: "Ship it?", options: ["Yes", "No"] }, null);
    assert.equal(result.terminate, true);
  });
});
