import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DISCUSS_LABEL,
  DISCUSS_VALUE,
  answerToValue,
  browserAskOptions,
  buildAskOptions,
  registerAskUser,
} from "../../../extensions/orchestrator/ask-user.js";

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

  // Regression: a caller passing the discuss row produced a second, inert literal row.
  for (const supplied of ["Discuss with AI first", "  discuss with ai first  ", "__discuss__"]) {
    it(`dedupes a caller-supplied discuss row: ${JSON.stringify(supplied)}`, () => {
      const items = buildAskOptions(["Yes", supplied, "No"], true);
      const discussRows = items.filter((i) => i.value === DISCUSS_VALUE);
      assert.equal(discussRows.length, 1, "exactly one discuss row");
      assert.equal(discussRows[0].label, supplied, "caller label kept for display");
      assert.deepStrictEqual(items.map((i) => i.value), [
        "Yes",
        DISCUSS_VALUE,
        "No",
        FREE_INPUT,
      ]);
    });
  }
});

describe("browserAskOptions", () => {
  it("carries the discuss choice as its label, never the TUI-only Other row", () => {
    const emitted = browserAskOptions(buildAskOptions(["Yes", "No"], true));
    assert.deepStrictEqual(emitted, ["Yes", "No", DISCUSS_LABEL]);
    assert.ok(emitted.includes(DISCUSS_LABEL));
    assert.ok(!emitted.includes(FREE_INPUT));
    assert.ok(!emitted.some((o) => o.toLowerCase().includes("other")));
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
  /**
   * Drives registerAskUser's tool with a fake pi (capturing emitted events) and a
   * fake dialog that answers `answer`.
   */
  async function runAsk(params: any, answer: string | null) {
    let tool: any;
    const events: Array<{ name: string; payload: any }> = [];
    const pi = {
      registerTool: (t: any) => {
        tool = t;
      },
      events: {
        emit: (name: string, payload: any) => events.push({ name, payload }),
        on: () => () => {},
      },
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
    const result = await tool.execute("id", params, undefined, undefined, ctx);
    return { result, events };
  }

  it("returns the bare sentinel and does not terminate", async () => {
    const { result } = await runAsk(
      { question: "Ship it?", options: ["Yes", "No"] },
      DISCUSS_VALUE,
    );
    assert.deepStrictEqual(result.content, [{ type: "text", text: DISCUSS_VALUE }]);
    assert.equal(result.terminate, undefined);
  });

  it("still terminates on cancel", async () => {
    const { result } = await runAsk({ question: "Ship it?", options: ["Yes", "No"] }, null);
    assert.equal(result.terminate, true);
  });

  it("emits a pidash payload matching the assembled options", async () => {
    const options = ["Yes", "No"];
    const { events } = await runAsk({ question: "Ship it?", options }, DISCUSS_VALUE);
    const request = events.find((e) => e.name === "pidash:ui-request")?.payload;
    assert.ok(request, "pidash:ui-request emitted");
    assert.equal(request.method, "select");
    assert.deepStrictEqual(request.options, browserAskOptions(buildAskOptions(options, true)));
    assert.deepStrictEqual(request.options, ["Yes", "No", DISCUSS_LABEL]);
  });

  it("emits input mode with no options for free-input-only prompts", async () => {
    const { events } = await runAsk({ question: "Name?", options: [] }, "custom");
    const request = events.find((e) => e.name === "pidash:ui-request")?.payload;
    assert.equal(request.method, "input");
    assert.equal(request.options, undefined);
  });

  it("emits the deduped discuss label once", async () => {
    const { events } = await runAsk(
      { question: "Ship it?", options: ["Yes", "Discuss with AI first"] },
      DISCUSS_VALUE,
    );
    const request = events.find((e) => e.name === "pidash:ui-request")?.payload;
    assert.deepStrictEqual(request.options, ["Yes", DISCUSS_LABEL]);
  });
});
