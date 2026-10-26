/** #968 A — pitasks pidash bridge: list request, task operations, live broadcast. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pitasks, { createTask } from "../../../extensions/pitasks/index.ts";

type Handler = (data: unknown) => void;

interface Captured {
  commands: Map<string, any>;
  events: Array<{ channel: string; data: unknown }>;
}

function bootPitasks(): { pi: any; captured: Captured; fire: (channel: string, data?: unknown) => void } {
  const listeners = new Map<string, Handler[]>();
  const captured: Captured = { commands: new Map(), events: [] };
  const pi: any = {
    registerCommand: (name: string, opts: any) => { captured.commands.set(name, opts); },
    registerTool: () => {},
    on: () => {},
    sendMessage: () => {},
    events: {
      emit: (channel: string, data: unknown) => { captured.events.push({ channel, data }); },
      on: (channel: string, handler: Handler) => {
        if (!listeners.has(channel)) listeners.set(channel, []);
        listeners.get(channel)!.push(handler);
        return () => {};
      },
    },
  };
  const prev = process.env.PI_SUBAGENT_CHILD;
  const prevOneshot = process.env.PI_ONESHOT;
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_ONESHOT;
  try {
    pitasks(pi);
  } finally {
    if (prev !== undefined) process.env.PI_SUBAGENT_CHILD = prev;
    if (prevOneshot !== undefined) process.env.PI_ONESHOT = prevOneshot;
  }
  return {
    pi,
    captured,
    fire: (channel: string, data?: unknown) => {
      for (const h of [...(listeners.get(channel) ?? [])]) h(data);
    },
  };
}

function tasksPayload(captured: Captured): any[] {
  const last = [...captured.events].reverse().find((e) => e.channel === "pidash:tasks-list");
  assert.ok(last, "pidash:tasks-list emitted");
  return (last.data as any).tasks;
}

describe("pitasks pidash bridge", () => {
  let env: ReturnType<typeof bootPitasks>;

  beforeEach(() => { env = bootPitasks(); });

  it("tasks-list-request responds with the live store", () => {
    env.fire("pidash:tasks-list-request");
    assert.equal(tasksPayload(env.captured).length, 0);
  });

  it("task-op create adds a task and broadcasts", () => {
    env.fire("pidash:task-op", { op: "create", subject: "From browser", description: "via pidash" });
    const tasks = tasksPayload(env.captured);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].subject, "From browser");
    assert.equal(tasks[0].description, "via pidash");
    assert.equal(tasks[0].status, "pending");
  });

  it("task-op start/complete transition status", () => {
    env.fire("pidash:task-op", { op: "create", subject: "Lifecycle" });
    const id = tasksPayload(env.captured)[0].id;
    env.fire("pidash:task-op", { op: "start", taskId: id });
    assert.equal(tasksPayload(env.captured).find((t: any) => t.id === id).status, "in_progress");
    env.fire("pidash:task-op", { op: "complete", taskId: id });
    assert.equal(tasksPayload(env.captured).find((t: any) => t.id === id).status, "completed");
  });

  it("task-op delete removes from the broadcast list", () => {
    env.fire("pidash:task-op", { op: "create", subject: "Doomed" });
    const id = tasksPayload(env.captured)[0].id;
    env.fire("pidash:task-op", { op: "delete", taskId: id });
    assert.equal(tasksPayload(env.captured).length, 0);
  });

  it("task-op clear-completed empties completed tasks", () => {
    env.fire("pidash:task-op", { op: "create", subject: "Done thing" });
    const id = tasksPayload(env.captured)[0].id;
    env.fire("pidash:task-op", { op: "complete", taskId: id });
    assert.equal(tasksPayload(env.captured).length, 1);
    env.fire("pidash:task-op", { op: "clear-completed" });
    assert.equal(tasksPayload(env.captured).length, 0);
  });

  it("store changes broadcast without an explicit request (agent-driven updates)", () => {
    // The exported module-level API mutates the same live store the bridge reads.
    createTask("Agent task", "created via exported API");
    const tasks = tasksPayload(env.captured);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].subject, "Agent task");
  });

  it("unknown op is ignored without throwing", () => {
    env.fire("pidash:task-op", { op: "explode" });
    // No new tasks-list beyond initial ops — just verify no throw
    env.fire("pidash:tasks-list-request");
    assert.equal(tasksPayload(env.captured).length, 0);
  });
});
