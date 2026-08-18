/**
 * Start the sidecar programmatically.
 *
 * Shows how to embed the sidecar in your own application
 * with custom port, host, and optional watchdog.
 *
 * Install: npm install @myk-org/pi-sidecar
 * Run:     npx tsx start-sidecar.ts
 */
import { bindSidecarListenExit, startSidecar } from "@myk-org/pi-sidecar";

const handle = startSidecar({
  port: 9200,
  host: "127.0.0.1",
  // Optional: monitor a backend health endpoint
  // watchdogUrl: "http://localhost:8000/health",
});
bindSidecarListenExit(handle);

process.on("SIGINT", async () => {
  await handle.close();
  process.exit(0);
});
