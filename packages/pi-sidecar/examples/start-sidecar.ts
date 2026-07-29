/**
 * Start the sidecar programmatically.
 *
 * Shows how to embed the sidecar in your own application
 * with custom port, host, and optional watchdog.
 *
 * Install: npm install @myk-org/pi-sidecar
 * Run:     npx tsx start-sidecar.ts
 */
import { startSidecar } from "@myk-org/pi-sidecar";

// Start with custom options
const handle = startSidecar({
  port: 9200,
  host: "127.0.0.1",
  // Optional: monitor a backend health endpoint
  // watchdogUrl: "http://localhost:8000/health",
});

console.log("Sidecar started on http://127.0.0.1:9200");
console.log("Press Ctrl+C to stop\n");

// Graceful shutdown on SIGINT
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await handle.close();
  process.exit(0);
});
