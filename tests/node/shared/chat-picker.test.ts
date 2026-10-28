/**
 * Picker ordering/paging — the rule behind `/model` opening on the provider you
 * already use instead of at `google` because it sorts first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPickerPage,
  entriesFromModels,
  pickerLabel,
  pickerPageCount,
  clampPickerPage,
  orderPickerEntries,
  PICKER_PAGE_SIZE,
  type PickerEntry,
} from "../../../extensions/shared/chat/chat-picker.ts";

const entries: PickerEntry[] = [
  { id: "google/gemini-4", label: "Gemini 4", group: "google" },
  { id: "EnMaaS/deepseek", label: "DeepSeek V4.1 Flash", group: "EnMaaS", current: true },
  { id: "EnMaaS/glm", label: "GLM 5.3", group: "EnMaaS" },
  { id: "openai/gpt-6", label: "GPT-6", group: "openai" },
];

describe("picker ordering", () => {
  it("puts the preferred group first and keeps the rest alphabetical", () => {
    const ordered = orderPickerEntries(entries, "EnMaaS");
    assert.deepEqual(ordered.map((entry) => entry.id), [
      "EnMaaS/deepseek", "EnMaaS/glm", "google/gemini-4", "openai/gpt-6",
    ]);
  });

  it("falls back to plain grouping when no preference is given", () => {
    const ordered = orderPickerEntries(entries);
    assert.deepEqual(ordered.map((entry) => entry.group), ["EnMaaS", "EnMaaS", "google", "openai"]);
  });

  it("keeps the original order inside a group (stable)", () => {
    const ordered = orderPickerEntries(entries, "EnMaaS");
    assert.equal(ordered[0].id, "EnMaaS/deepseek");
    assert.equal(ordered[1].id, "EnMaaS/glm");
  });
});

describe("picker paging", () => {
  const many: PickerEntry[] = Array.from({ length: 681 }, (_, i) => ({
    id: `m${i}`, label: `model-${i}`, group: i < 600 ? "aaa" : "zzz",
  }));

  it("bounds a page to the select-menu limit", () => {
    const page = buildPickerPage(many, 1);
    assert.equal(page.items.length, PICKER_PAGE_SIZE);
    assert.equal(page.total, 681);
    assert.equal(page.pages, Math.ceil(681 / PICKER_PAGE_SIZE));
  });

  it("keeps the preferred group reachable on page 1", () => {
    const page = buildPickerPage(many, 1, { preferGroup: "zzz" });
    assert.equal(page.items[0].group, "zzz", "an already-used provider must not be 27 pages in");
  });

  it("clamps out-of-range pages", () => {
    assert.equal(pickerPageCount(0), 1);
    assert.equal(clampPickerPage(0, 681), 1);
    assert.equal(clampPickerPage(9999, 681), Math.ceil(681 / PICKER_PAGE_SIZE));
    assert.equal(clampPickerPage(Number.NaN, 681), 1);
  });

  it("marks the current entry", () => {
    const page = buildPickerPage(entries, 1, { preferGroup: "EnMaaS" });
    const current = page.items.find((entry) => entry.current);
    assert.ok(current);
    assert.match(pickerLabel(current!), /^✓ /);
  });
});

describe("models to picker entries", () => {
  it("derives the group from the id when no provider is given", () => {
    const [entry] = entriesFromModels([{ id: "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017" }]);
    assert.equal(entry.group, "rits/deepseek-ai");
    assert.equal(entry.label, "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017");
  });

  it("prefers the model name and the explicit provider", () => {
    const [entry] = entriesFromModels([{ id: "gpt-6", name: "GPT-6", provider: "openai" }], "gpt-6");
    assert.equal(entry.group, "openai");
    assert.equal(entry.label, "GPT-6");
    assert.equal(entry.current, true);
  });

  it("drops entries without an id", () => {
    assert.deepEqual(entriesFromModels([{ id: "" }, {} as any]), []);
  });

  it("truncates labels for the select menu", () => {
    const label = pickerLabel({ id: "x", label: "y".repeat(200) });
    assert.equal(label.length, 100);
    assert.ok(label.endsWith("…"));
  });
});
