import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cronRemoveAutocompleteItems, getCronRemoveAutocompleteItems, parseCronScope } from "../../../extensions/orchestrator/cron.js";

describe("cron remove autocomplete", () => {
  it("returns the current public items", () => {
    assert.deepEqual(getCronRemoveAutocompleteItems(), []);
  });

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
  it("defaults to session scope", () => {
    assert.deepEqual(parseCronScope(["add", "work"]), { scope: "session", rest: ["add", "work"] });
  });

  it("selects project scope with --persist", () => {
    assert.deepEqual(parseCronScope(["add", "--persist", "work"]), { scope: "project", rest: ["add", "work"] });
  });

  it("rejects --scope", () => {
    assert.match(parseCronScope(["list", "--scope", "project"]).error!, /--persist/);
  });

  it("rejects --project", () => {
    assert.match(parseCronScope(["add", "--project"]).error!, /--persist/);
  });
});
