import assert from "node:assert/strict";
import { it } from "node:test";
import pitasks from "../../../extensions/pitasks/index.js";

it("headless create explains how to create a task locally", async () => {
 let handler: any;
 const child = process.env.PI_SUBAGENT_CHILD;
 delete process.env.PI_SUBAGENT_CHILD;
 try {
 pitasks({ on() {}, registerTool() {}, registerCommand(name: string, command: any) { if (name === "tasks") handler = command.handler; }, events: { on() { return () => {}; }, emit() {} } } as any);
 const notices: string[] = [];
 await handler("create", { hasUI: false, ui: { notify: (text: string) => notices.push(text) } });
 assert.match(notices.join("\n"), /TaskCreate|interactive/);
 } finally {
  if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = child;
 }
});
