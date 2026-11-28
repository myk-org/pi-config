import assert from "node:assert/strict";
import { it } from "node:test";
import { rmSync } from "node:fs";
import { makeTempDir } from "../helpers/temp-dirs.js";
import pitasks, { createTaskForSession, getTaskForSession, taskStore, updateTask, updateTaskForSession, updateTasksForSession } from "../../../extensions/pitasks/index.js";
import { TaskStore } from "../../../extensions/pitasks/task-store.js";
import { TaskWidget } from "../../../extensions/pitasks/task-widget.js";
import { openListDetailOverlay, type OverlayListSpec } from "../../../extensions/orchestrator/overlay-dashboard.js";
import { fakeCommandCtx } from "../helpers/fake-extension-ctx.js";
import { tasksOverlayDeps, taskDetailRows } from "../../../extensions/pitasks/tasks-view.js";
import { registerTaskTools } from "../../../extensions/pitasks/task-tools.js";
import { autoCompleteTask, autoMarkInProgress } from "../../../extensions/orchestrator/task-lifecycle.js";
import { useSupportedPiVersion } from "../helpers/pi-version-env.js";

useSupportedPiVersion();

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
it("refuses peer reassignment of an existing user-assigned task", () => {
 const dir = makeTempDir("peer-reassign-guard-");
 try {
  const task = createTaskForSession("peer", "owner step", "", creator, undefined, dir);
  updateTaskForSession("peer", task.id, { assignee: "user" }, dir);
  assert.throws(() => updateTaskForSession("peer", task.id, { assignee: "llm" }, dir), /only the user/);
  assert.equal(getTaskForSession("peer", task.id, dir).assignee, "user");
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("refuses bulk peer reassignment away from user atomically", () => {
 const dir = makeTempDir("peer-bulk-reassign-");
 try {
  const task = createTaskForSession("peer", "owner step", "", creator, undefined, dir);
  assert.throws(() => updateTasksForSession("peer", [
   { id: task.id, fields: { assignee: "user" } },
   { id: task.id, fields: { assignee: "llm" } },
  ], dir), /only the user/);
  assert.equal(getTaskForSession("peer", task.id, dir).assignee, "llm");
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("refuses peer completedBy spoofing in session updates", () => {
 const dir = makeTempDir("peer-completed-by-");
 try {
  const task = createTaskForSession("peer", "agent step", "", creator, undefined, dir);
  assert.throws(() => updateTaskForSession("peer", task.id, { status: "completed", completedBy: "user" }, dir), /only the user/);
  assert.equal(getTaskForSession("peer", task.id, dir).completedBy, undefined);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("refuses peer completionNote injection in bulk session updates", () => {
 const dir = makeTempDir("peer-completion-note-");
 try {
  const task = createTaskForSession("peer", "agent step", "", creator, undefined, dir);
  assert.throws(() => updateTasksForSession("peer", [
   { id: task.id, fields: { status: "completed", completionNote: "forged" } },
  ], dir), /only the user/);
  assert.equal(getTaskForSession("peer", task.id, dir).completionNote, undefined);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("preserves the shared overlay's default empty-list return", async () => {
 const notifications: string[] = [];
 const listSpec: OverlayListSpec<string, { id: string }> = {
  title: "Jobs",
  countLabel: () => "",
  borderTitle: () => "",
  listItems: () => [],
  rowParts: () => ({ glyph: "", title: "", idLabel: "", rightParts: [] }),
 };
 const ctx = fakeCommandCtx({
  notify: (text: string) => notifications.push(text),
  custom: () => assert.fail("default empty list must not open a dashboard"),
 });
 await openListDetailOverlay(ctx, { emptyMessage: "No jobs.", listSpec });
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
  it(`refuses ${status} across ${assignee} reassignment in TaskUpdate`, async () => {
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
for (const status of ["in_progress", "completed"] as const) {
 it(`refuses TaskUpdate ${status} on a user-assigned task (#1406)`, async () => {
  const store = new TaskStore();
  const t = store.create("merge PR", "", creator, undefined, undefined, "user");
  const result = await tools(store).TaskUpdate.execute("call", { taskId: t.id, status });
  assert.equal(store.get(t.id)?.status, "pending");
  assert.match(result.content[0].text, /only the user/);
 });
}
it("deletes an obsolete user-assigned task via TaskUpdate status deleted (#1406)", async () => {
 const store = new TaskStore();
 const t = store.create("merge PR", "", creator, undefined, undefined, "user");
 const result = await tools(store).TaskUpdate.execute("call", { taskId: t.id, status: "deleted" });
 assert.equal(store.get(t.id), undefined);
 assert.match(result.content[0].text, /Updated task #1 deleted/);
});
it("deletes obsolete user-assigned tasks via TaskBulkDelete (#1406)", async () => {
 const store = new TaskStore();
 const first = store.create("merge PR #1", "", creator, undefined, undefined, "user");
 const second = store.create("merge PR #2", "", creator, undefined, undefined, "user");
 const agent = store.create("keep agent work", "", creator);
 const result = await tools(store).TaskBulkDelete.execute("call", { taskIds: [first.id, second.id] });
 assert.equal(store.get(first.id), undefined);
 assert.equal(store.get(second.id), undefined);
 assert.equal(store.get(agent.id)?.subject, "keep agent work");
 assert.equal(result.content[0].text, "Deleted 2 task(s)");
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
  assert.equal(await transition(t.id, "/unused", "/unused/tasks.json", () => store), false);
  assert.equal(store.get(t.id)?.status, "pending");
 });
}
for (const status of ["in_progress", "completed"]) {
 for (const assignee of ["user", "llm"] as const) {
  it(`refuses exported updateTask ${status} across ${assignee} reassignment`, async () => {
   const handlers = new Map<string, Function>();
   const subagent = process.env.PI_SUBAGENT_CHILD;
   const piTasks = process.env.PI_TASKS;
   delete process.env.PI_SUBAGENT_CHILD;
   process.env.PI_TASKS = "off";
   try {
    pitasks({ on(n: string, h: Function) { handlers.set(n, h); }, registerTool() {}, registerCommand() {}, events: { on() { return () => {}; }, emit() {} } } as any);
    await handlers.get("session_start")!({ reason: "new" }, { ui: { setWidget() {} }, sessionManager: { getSessionId: () => "guard-test" } });
    const t = taskStore.create("step", "", creator, undefined, undefined, assignee);
    assert.throws(() => updateTask(t.id, { status, assignee: assignee === "user" ? "llm" : "user" }), /only the user/);
    assert.equal(taskStore.get(t.id)?.status, "pending");
    assert.equal(taskStore.get(t.id)?.assignee, assignee);
   } finally {
    handlers.get("session_shutdown")?.();
    if (subagent === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = subagent;
    if (piTasks === undefined) delete process.env.PI_TASKS;
    else process.env.PI_TASKS = piTasks;
   }
  });
 }
}
it("deactivates widget telemetry when completeTask closes an in-progress task", () => {
 const store = new TaskStore();
 const widget = new TaskWidget(store);
 try {
  const t = store.create("running", "", creator);
  store.update(t.id, { status: "in_progress" });
  widget.setActiveTask(t.id, true);
  const deps = tasksOverlayDeps(store, (id) => {
   widget.setActiveTask(id, false);
   widget.update();
  });
  assert.equal(deps.completeTask(t.id, { by: "user" }), true);
  widget.addTokenUsage(50, 75);
  assert.equal(store.get(t.id)?.telemetry?.inputTokens, 0);
  assert.equal(typeof store.get(t.id)?.telemetry?.endedAt, "number");
 } finally {
  widget.dispose();
 }
});
for (const bulk of [false, true]) {
 it(`preserves user completedBy across repeated ${bulk ? "bulk" : "single"} completion`, () => {
  const store = new TaskStore();
  const t = store.create("step", "", creator);
  store.update(t.id, { status: "completed", completedBy: "user", completionNote: "owner closed" });
  if (bulk) store.updateTasks([{ id: t.id, fields: { status: "completed" } }]);
  else store.update(t.id, { status: "completed" });
  assert.equal(store.get(t.id)?.completedBy, "user");
  assert.equal(store.get(t.id)?.completionNote, "owner closed");
 });
}
it("creates user-assigned tasks through TaskBulkCreate", async () => {
 const store = new TaskStore();
 const tool = tools(store).TaskBulkCreate;
 assert.ok(tool.parameters.properties.tasks.items.properties.assignee);
 await tool.execute("call", {
  tasks: [
   { subject: "agent work", description: "a" },
   { subject: "merge PR", description: "b", assignee: "user" },
  ],
 });
 assert.equal(store.get("1")?.assignee, "llm");
 assert.equal(store.get("2")?.assignee, "user");
});
