// Clear process.argv[1] so the subagent extension's getPiInvocation() falls
// through to `{ command: "pi", args }` instead of re-running the sidecar.
// This is intentionally in the CLI entry point (not startSidecar()) to avoid
// clobbering argv[1] for programmatic consumers.
// TODO(#47): Remove when upstream getPiInvocation() supports override.
process.argv[1] = "";

import { startSidecar } from "./index.js";
const handle = startSidecar();
