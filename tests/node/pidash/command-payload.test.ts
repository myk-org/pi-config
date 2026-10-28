/**
 * Command registration must be idempotent.
 *
 * A restart that reissues command ids makes a Discord client answer "This
 * command is outdated" when the user taps a cached command (live report), so
 * the comparison has to ignore everything Discord echoes back that we did not
 * set — and still notice a real change.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalCommandShape, compareCommandPayloads } from "../../../extensions/pidash/discord-commands.ts";

const desired = [
  { name: "status", description: "Show status", type: 1, contexts: [0, 1, 2], integration_types: [0, 1] },
  {
    name: "watch",
    description: "Watch a session",
    type: 1,
    contexts: [0, 1, 2],
    integration_types: [0, 1],
    options: [{ type: 3, name: "session", description: "Session to watch", required: true, autocomplete: true }],
  },
];

/** What Discord reports: our payload plus its own bookkeeping. */
const echoed = [
  {
    id: "1", application_id: "a", version: "9", name: "status", description: "Show status", type: 1,
    contexts: [0, 1, 2], integration_types: [0, 1], dm_permission: false, nsfw: false,
    name_localizations: null, description_localizations: null, options: [],
  },
  {
    id: "2", application_id: "a", version: "9", name: "watch", description: "Watch a session", type: 1,
    contexts: [0, 1, 2], integration_types: [0, 1], dm_permission: false, nsfw: false,
    name_localizations: null, description_localizations: null,
    options: [{
      type: 3, name: "session", description: "Session to watch", required: true, autocomplete: true,
      min_length: null, max_length: null, choices: [], options: [], name_localizations: null,
    }],
  },
];

describe("command payload comparison", () => {
  it("treats Discord's echo fields as no change", () => {
    const result = compareCommandPayloads(echoed, desired);
    assert.equal(result.changed, false, `unexpected diff in ${result.differing.join(", ")}`);
    assert.deepEqual(result.differing, []);
  });

  it("does not depend on order", () => {
    assert.equal(compareCommandPayloads([...echoed].reverse(), desired).changed, false);
  });

  it("detects a changed description", () => {
    const changed = [{ ...desired[0], description: "Different" }, desired[1]];
    const result = compareCommandPayloads(echoed, changed);
    assert.equal(result.changed, true);
    assert.deepEqual(result.differing, ["status"]);
  });

  it("detects a changed context (DM support)", () => {
    const changed = [{ ...desired[0], contexts: [0, 1] }, desired[1]];
    assert.equal(compareCommandPayloads(echoed, changed).changed, true);
  });

  it("reports a removed command", () => {
    const result = compareCommandPayloads(echoed, [desired[0]]);
    assert.equal(result.changed, true);
    assert.deepEqual(result.differing, ["-watch"]);
  });

  it("detects an added command", () => {
    const result = compareCommandPayloads(echoed, [...desired, { name: "async", description: "x", type: 1 }]);
    assert.equal(result.changed, true);
    assert.deepEqual(result.differing, ["+async"], "only the new command is reported");
  });

  it("detects a new option on an existing command", () => {
    const changed = [desired[0], {
      ...desired[1],
      options: [{ type: 3, name: "session", description: "Session to watch", required: true, autocomplete: true },
                { type: 3, name: "mode", description: "extra", required: false }],
    }];
    assert.equal(compareCommandPayloads(echoed, changed).changed, true);
  });

  it("ignores the order of contexts and integration types", () => {
    assert.equal(
      canonicalCommandShape({ name: "a", contexts: [2, 0, 1], integration_types: [1, 0] }),
      canonicalCommandShape({ name: "a", contexts: [0, 1, 2], integration_types: [0, 1] }),
    );
  });
});

describe("guild scope fields", () => {
  // Discord returns contexts/integration_types as null for guild commands while
  // still honouring them from the application registration. Comparing them per
  // guild made every restart look changed and reissued command ids.
  const guildLive = desired.map((command: any) => ({ ...command, id: "1", contexts: null, integration_types: null }));

  it("ignores registration fields for a guild scope", () => {
    const result = compareCommandPayloads(guildLive, desired);
    assert.equal(result.changed, false, `unexpected diff in ${result.differing.join(", ")}`);
  });

  it("still notices a description change at guild scope", () => {
    const changed = [{ ...desired[0], description: "new text" }, desired[1]];
    assert.equal(compareCommandPayloads(guildLive, changed).changed, true);
  });

  it("shapes a guild command without the null registration fields", () => {
    const withFields = canonicalCommandShape(desired[0]);
    const withoutFields = canonicalCommandShape({ ...desired[0], contexts: null, integration_types: null });
    assert.notEqual(withFields, withoutFields, "the two scopes are not comparable as-is");
    assert.equal(withoutFields, canonicalCommandShape({ ...desired[0], contexts: null, integration_types: null }, { scopeFields: false }));
  });
});
