import assert from "node:assert/strict";
import { it } from "node:test";
import { rmSync } from "node:fs";
import { makeTempDir } from "../helpers/temp-dirs.js";
import { createTaskForSession, getTaskForSession, updateTaskForSession, updateTasksForSession } from "../../../extensions/pitasks/index.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { openListDetailOverlay } from "../../../extensions/orchestrator/overlay-dashboard.js";
import { tasksOverlayDeps, taskDetailRows } from "../../../extensions/pitasks/tasks-view.js";
import { registerTaskTools } from "../../../extensions/pitasks/task-tools.js";
import { autoCompleteTask, autoMarkInProgress } from "../../../extensions/orchestrator/task-lifecycle.js";

const creator = { type: "local" as const, origin: "user", session: "", project: "" };
for (const status of ["in_progress", "completed"]) {
 for (const assignee of ["user", "llm"] as const) {
  it(`refuses peer ${status} across ${assignee} reassignment`, () => {
   const dir = makeTempDir("peer-owner-guard-");
   try {
    const task = createTaskForSession("peer", "step", "", creator, undefined, dir);
    updateTaskForSession("peer", task.id, { assignee }, dir);
    assert.throws(() => updateTaskForSession("peer", task.id, { status, assignee: assignee === "user" ? "llm" : "user" }, dir), /only the user/);
    const unchanged = getTaskForSession("peer", task.id, dir);
    assert.equal(unchanged.status, "pending");
    assert.equal(unchanged.assignee, assignee);
   } finally { rmSync(dir, { recursive: true, force: true }); }
  });
 }
}
for (const status of ["in_progress", "completed"]) {
 it(`refuses bulk peer ${status} of user-assigned work atomically`, () => {
  const dir = makeTempDir("peer-bulk-owner-");
  try {
   const first = createTaskForSession("peer", "allowed", "", creator, undefined, dir);
   const owned = createTaskForSession("peer", "manual", "", creator, undefined, dir);
   updateTaskForSession("peer", owned.id, { assignee: "user" }, dir);
   assert.throws(() => updateTasksForSession("peer", [
    { id: first.id, fields: { status } },
    { id: owned.id, fields: { status, assignee: "llm" } },
   ], dir), /only the user/);
   assert.equal(getTaskForSession("peer", first.id, dir).status, "pending");
   assert.equal(getTaskForSession("peer", owned.id, dir).assignee, "user");
   assert.throws(() => updateTasksForSession("peer", [
    { id: first.id, fields: { assignee: "user" } },
    { id: first.id, fields: { status } },
   ], dir), /only the user/);
   assert.equal(getTaskForSession("peer", first.id, dir).assignee, "llm");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 });
}
it("preserves the shared overlay's default empty-list return", async () => {
 const notifications: string[] = [];
 await openListDetailOverlay({ hasUI: true, ui: {
  notify: (text: string) => notifications.push(text),
  custom: () => assert.fail("default empty list must not open a dashboard"),
 } } as any, { emptyMessage: "No jobs.", listSpec: { listItems: () => [] } as any });
 assert.deepEqual(notifications, ["No jobs."]);
});
for (const bulk of [false, true]) {
 it(`clears reopened outcomes through ${bulk ? "bulk" : "single"} updates`, () => {
  const store = new TaskStore();
  const t = store.create("step", "", creator);
  store.update(t.id, { status: "completed", completedBy: "user", completionNote: "old" });
  if (bulk) store.updateTasks([{ id: t.id, fields: { status: "pending" } }]);
  else store.update(t.id, { status: "pending" });
  assert.equal(store.get(t.id)?.completedBy, undefined);
  assert.equal(store.get(t.id)?.completionNote, undefined);
  tasksOverlayDeps(store).completeTask(t.id, { by: "user" });
  assert.equal(store.get(t.id)?.completionNote, undefined);
 });
}
it("records manual actor without notifying for agent assignments", () => {
 const store = new TaskStore();
 const t = store.create("step", "", creator);
 const notices: unknown[] = [];
 const deps = tasksOverlayDeps(store, undefined, t => notices.push(t));
 deps.completeTask(t.id, { by: "user" });
 assert.equal(store.get(t.id)?.completedBy, "user");
 assert.deepEqual(notices, []);
});
it("notifies only once for repeated manual completion", () => {
 const store = new TaskStore();
 const t = store.create("step", "", creator, undefined, undefined, "user");
 const notices: unknown[] = [];
 const deps = tasksOverlayDeps(store, undefined, t => notices.push(t));
 deps.completeTask(t.id, { by: "user" });
 deps.completeTask(t.id, { by: "user" });
 assert.equal(notices.length, 1);
});
function tools(store: TaskStore) {
 const registered: Record<string, any> = {};
 registerTaskTools({ registerTool: (t: any) => { registered[t.name] = t; } } as any, () => store,
  { update() {}, setActiveTask() {} } as any);
 return registered;
}
for (const status of ["in_progress", "completed"]) {
 for (const assignee of ["user", "llm"] as const) {
  it(`refuses ${status} with existing ${assignee} and resulting user assignment`, async () => {
   const store = new TaskStore();
   const t = store.create("step", "", creator, undefined, undefined, assignee);
   await tools(store).TaskUpdate.execute("call", { taskId: t.id, status, assignee: assignee === "user" ? "llm" : "user" });
   assert.equal(store.get(t.id)?.status, "pending");
   assert.equal(store.get(t.id)?.assignee, assignee);
  });
 }
}
it("refuses bulk completion of a user task while updating agent tasks", async () => {
 const store = new TaskStore();
 const user = store.create("owner", "", creator, undefined, undefined, "user");
 const agent = store.create("agent", "", creator);
 const result = await tools(store).TaskBulkUpdate.execute("call", { updates: [user, agent].map(t => ({ taskId: t.id, status: "completed" })) });
 assert.equal(store.get(user.id)?.status, "pending");
 assert.equal(store.get(agent.id)?.status, "completed");
 assert.match(result.content[0].text, /only the user/);
});
it("preserves reassignment without a status transition", async () => {
 const store = new TaskStore();
 const t = store.create("step", "", creator, undefined, undefined, "user");
 await tools(store).TaskUpdate.execute("call", { taskId: t.id, assignee: "llm" });
 assert.equal(store.get(t.id)?.assignee, "llm");
});
it("exposes the completion outcome through TaskGet", async () => {
 const store = new TaskStore();
 const t = store.create("step", "", creator);
 store.update(t.id, { status: "completed", completedBy: "user", completionNote: "verbatim outcome" });
 const result = await tools(store).TaskGet.execute("call", { taskId: t.id });
 assert.match(result.content[0].text, /Completed by: user/);
 assert.match(result.content[0].text, /verbatim outcome/);
});
it("exposes the completion outcome in detail rows", () => {
 const store = new TaskStore();
 const t = store.create("step", "", creator);
 store.update(t.id, { status: "completed", completedBy: "user", completionNote: "verbatim outcome" });
 const rows = taskDetailRows(store.get(t.id)!);
 assert.ok(rows.some(([label, value]) => label === "Completed by" && value === "user"));
 assert.ok(rows.some(([, value]) => value === "verbatim outcome"));
});
for (const transition of [autoCompleteTask, autoMarkInProgress]) {
 it(`${transition.name} refuses user-assigned tasks in factory paths`, async () => {
  const store = new TaskStore();
  const t = store.create("step", "", creator, undefined, undefined, "user");
  assert.equal(await transition(t.id, "/unused", undefined, () => store), false);
  assert.equal(store.get(t.id)?.status, "pending");
 });
}
