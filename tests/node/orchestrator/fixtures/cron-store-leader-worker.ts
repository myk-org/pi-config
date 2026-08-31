import {
  acquireLeaderLock,
  releaseLeaderLock,
} from "../../../../extensions/orchestrator/cron-store.ts";

const [store, instanceId] = process.argv.slice(2);
const owner = acquireLeaderLock(store, instanceId);
if (!owner) process.exit(1);
process.stdout.write("ready\n");
process.stdin.once("data", () => {
  releaseLeaderLock(store, owner);
  process.exit(0);
});
