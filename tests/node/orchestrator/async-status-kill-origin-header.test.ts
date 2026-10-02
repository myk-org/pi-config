import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatKillOriginSuffix } from "../../../extensions/orchestrator/async-status-ui.js";
import { createLogger } from "../../../extensions/shared/logger.js";

const log = createLogger("async-status-kill-origin-test");

/** The overlay is interactive, so the header attribution is tested as a pure helper. */
const identity = { fg: (_color: string, value: string) => value };

describe("async status kill-origin header (issue #816)", () => {
  it("shows who killed the job when status.json records an origin", () => {
    log.debug("kill_origin_header_case", { origin: "orchestrator" });
    assert.equal(formatKillOriginSuffix("orchestrator", identity), " · killed by orchestrator");
  });

  it("renders each recorded origin verbatim", () => {
    assert.equal(formatKillOriginSuffix("user", identity), " · killed by user");
    assert.equal(formatKillOriginSuffix("task-system", identity), " · killed by task-system");
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
