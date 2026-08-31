import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cronRemoveAutocompleteItems, parseCronScope } from "../../../extensions/orchestrator/cron.js";

describe("cron remove autocomplete", () => {
  it("returns unique scope-qualified IDs", () => {
    assert.deepEqual(
      cronRemoveAutocompleteItems([
        { id: "session-id", scope: "session", description: "session task", task: "one" },
        { id: "project-id", scope: "project", description: "persistent task", task: "two" },
        { id: "project-id", scope: "project", description: "duplicate", task: "duplicate" },
      ]),
      [
        { value: "session:session-id", label: "session:session-id", description: "session task" },
        { value: "persist:project-id", label: "persist:project-id", description: "persistent task" },
      ],
    );
  });
});

describe("cron scopes", () => {
  it("defaults to session and uses --persist for persistence", () => {
    assert.deepEqual(parseCronScope(["add", "work"]), { scope: "session", rest: ["add", "work"] });
    assert.deepEqual(parseCronScope(["add", "--persist", "work"]), { scope: "project", rest: ["add", "work"] });
    assert.match(parseCronScope(["list", "--scope", "project"]).error!, /--persist/);
    assert.match(parseCronScope(["add", "--project"]).error!, /--persist/);
  });
});
