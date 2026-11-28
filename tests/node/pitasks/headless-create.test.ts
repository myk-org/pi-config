import assert from "node:assert/strict";
import { it } from "node:test";
import pitasks from "../../../extensions/pitasks/index.js";
import { useSupportedPiVersion } from "../helpers/pi-version-env.js";

useSupportedPiVersion();

it("headless /tasks falls back to plain-text task list regardless of args", async () => {
 let handler: any;
 const child = process.env.PI_SUBAGENT_CHILD;
 delete process.env.PI_SUBAGENT_CHILD;
 try {
 pitasks({ on() {}, registerTool() {}, registerCommand(name: string, command: any) { if (name === "tasks") handler = command.handler; }, events: { on() { return () => {}; }, emit() {} } } as any);
 const notices: string[] = [];
 await handler("", { hasUI: false, ui: { notify: (text: string) => notices.push(text) } });
 assert.equal(notices[0], "No tasks.");
 } finally {
  if (child === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = child;
 }
});
