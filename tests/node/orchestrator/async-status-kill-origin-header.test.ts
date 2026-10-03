import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatKillOriginSuffix } from "../../../extensions/orchestrator/async-status-ui.js";
import { createLogger } from "../../../extensions/shared/logger.js";

const log = createLogger("async-status-kill-origin-test");

/** The overlay is interactive, so the header attribution is tested as a pure helper. */
const identity = { fg: (_color: string, value: string) => value };

describe("async status kill-origin header (issue #816)", () => {
  it("shows who killed the job using the human label, not the raw enum key", () => {
    log.debug("kill_origin_header_case", { origin: "orchestrator" });
    assert.equal(formatKillOriginSuffix("orchestrator", identity), " · killed by orchestrator");
    // The peer caught this live: the overlay echoed the stored key, so it read
    // "· killed by task-system" while every other surface said "Killed by task system".
    assert.equal(
      formatKillOriginSuffix("task-system", identity),
      " · killed by task system",
      "must use KILL_ORIGIN_LABELS, not the raw key",
    );
    assert.equal(formatKillOriginSuffix("user", identity), " · killed by user");
  });

  it("ignores an unrecognised origin instead of rendering it", () => {
    log.debug("kill_origin_header_case", { origin: "injected" });
    assert.equal(formatKillOriginSuffix("toString", identity), "", "prototype keys must not render");
    assert.equal(
      formatKillOriginSuffix("<script>alert(1)</script>", identity),
      "",
      "a hand-edited status.json must not inject text into the header",
    );
  });

  it("adds nothing when no origin is recorded", () => {
    log.debug("kill_origin_header_case", { origin: "absent" });
    assert.equal(formatKillOriginSuffix(undefined, identity), "");
    assert.equal(formatKillOriginSuffix("", identity), "", "an empty origin must not render a dangling suffix");
  });

  it("passes the suffix through the theme", () => {
    const seen: Array<[string, string]> = [];
    const theme = { fg: (color: string, value: string) => { seen.push([color, value]); return value; } };
    formatKillOriginSuffix("user", theme);
    assert.deepEqual(seen, [["dim", " · killed by user"]]);
  });
});
