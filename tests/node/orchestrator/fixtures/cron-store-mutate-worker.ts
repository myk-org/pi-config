import { mutateDurableCronStore, type DurableCronTask } from "../../../../extensions/orchestrator/cron-store.ts";

const [store, worker, countText] = process.argv.slice(2);
const count = Number(countText);

for (let index = 0; index < count; index++) {
  mutateDurableCronStore(store, (tasks) => [
    ...tasks,
    {
      id: `${worker}-${index}`,
      scope: "project",
      cwd: `/projects/${worker}`,
      description: "concurrent mutation",
      task: "check status",
      intervalMs: 10_000,
      createdAt: index,
    } satisfies DurableCronTask,
  ]);
}
