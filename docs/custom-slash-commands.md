# Creating Slash Commands

`pi-config` already points Pi at `./prompts` and `./extensions` in `package.json`, so those are the supported places to add new slash commands.

## Add a prompt-only command
Use this when you want a reusable slash command without writing any TypeScript.

```markdown
<!-- prompts/security-audit.md -->
---
description: "Scan the current changes for security problems"
---

Review the current git diff for security issues.

Focus on:
- hardcoded secrets
- shell injection
- auth and permission regressions
- unsafe file or network access

Return the findings as a short bullet list with severity labels.
```

Dropping this file into `prompts/` creates `/security-audit`. The filename becomes the command name, and the frontmatter `description` is what users see when browsing commands. Use this pattern for repeatable prompts that only need text instructions.

- Keep filenames kebab-case so the slash command is predictable.
- Use prompt templates when the command does not need UI hooks, events, or custom runtime logic.

## Pass arguments into a prompt command
Use this when the command should accept a target like a file path, branch name, or symbol.

````markdown
<!-- prompts/explain-file.md -->
---
description: "Explain a file or symbol from the current project"
argument-hint: "<path-or-symbol>"
---

## Raw Arguments

```text
$ARGUMENTS
```

Explain the target above in 5-8 bullets.

Include:
- what it is
- where it fits in the project
- risky edges or gotchas
- the next file to read
````

`$ARGUMENTS` is replaced with the raw text after the slash command, and `argument-hint` gives the user an inline usage hint. This is the fastest way to turn an ad hoc prompt into a reusable command without adding extension code.

> **Tip:** Keep the prompt robust when `$ARGUMENTS` is empty, either by asking a follow-up question or by describing the expected input format.

## Register a TypeScript command
Use this when the command needs session context, UI notifications, or custom runtime behavior.

```typescript
// extensions/orchestrator/hello.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerHello(pi: ExtensionAPI): void {
  pi.registerCommand("hello", {
    description: "Show a quick greeting for the current workspace",
    handler: async (args, ctx) => {
      const name = args?.trim() || "Developer";

      if (!ctx.hasUI) return;

      ctx.ui.notify(`Hello, ${name}! Workspace: ${ctx.cwd}`, "info");
    },
  });
}

// extensions/orchestrator/index.ts
import { registerHello } from "./hello.js";

// inside the default export:
registerHello(pi);
```

This follows the same `registerCommand()` pattern used throughout `extensions/orchestrator/`. The handler receives raw arguments plus a live command context, including `ctx.cwd`, `ctx.hasUI`, and `ctx.ui.notify()`. Use this when the command needs to inspect session state or talk to the UI directly.

- Put orchestrator commands under `extensions/orchestrator/` so they can be wired into `extensions/orchestrator/index.ts`.
- For larger delegated workflows, see [Managing Custom Agents](managing-custom-agents.html) for details.

## Add static argument completions to an extension command
Use this when an extension command has a small fixed set of subcommands or modes.

```typescript
// extensions/orchestrator/deploy-check.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerDeployCheck(pi: ExtensionAPI): void {
  pi.registerCommand("deploy-check", {
    description: "Run a quick pre-deploy checklist",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "staging", label: "staging", description: "Check staging settings" },
        { value: "prod", label: "prod", description: "Check production settings" },
      ];
      return items.filter((item) =>
        item.value.startsWith(prefix.toLowerCase()),
      );
    },
    handler: async (args, ctx) => {
      const target = (args?.trim() || "staging").toLowerCase();

      if (!ctx.hasUI) return;

      ctx.ui.notify(`Running deploy checks for ${target}...`, "info");
    },
  });
}

// extensions/orchestrator/index.ts
import { registerDeployCheck } from "./deploy-check.js";

// inside the default export:
registerDeployCheck(pi);
```

This matches the built-in pattern used by commands like `/pidash` and `/pidiff`. `getArgumentCompletions()` is the shortest path when your choices are known up front and do not require fetching repository data.

- Prefer this over editing the shared autocomplete layer when the command is a normal extension command.
- For daemon-backed or long-running handlers, see [Daemon & Websocket Networking](daemon-and-websockets.html) for details.

## Add issue-number autocomplete to a prompt command
Use this when a prompt template should tab-complete dynamic values like open issues, PRs, branches, or models.

```text
# prompts/pick-issue.md
---
description: "Summarize an open issue by number"
argument-hint: "[issue number]"
---

## Raw Arguments

```text
$ARGUMENTS
```

Summarize issue #$ARGUMENTS in 5 bullets:
- problem
- current scope
- missing acceptance criteria
- likely owner
- first implementation step

# extensions/orchestrator/extended-autocomplete.ts

// 1) Add a completion entry inside the `completions` record
"pick-issue": (prefix: string) => {
  void ctx.fetchOpenIssues(ctx.lastCwd);
  return ctx.issueCache.data
    ? filter(ctx.issueCache.data, prefix.replace(/^#/, ""))
    : null;
},

// 2) Add the command name to `promptTemplateCommands`
const promptTemplateCommands = new Set([
  "external-ai",
  "pr-review",
  "issue-review",
  "coderabbit-rate-limit",
  "review-local",
  "release",
  "review-handler",
  "cron",
  "create-skill",
  "create-coms-feature-manager",
  "pick-issue",
]);
```

Prompt templates are registered by Pi itself, so they do not go through the `registerCommand()` wrapper used for extension commands. That is why prompt-template autocomplete needs both pieces: a `completions` entry and inclusion in `promptTemplateCommands`.

> **Note:** `extensions/orchestrator/extended-autocomplete.ts` already includes cached fetchers such as `ctx.fetchOpenIssues(ctx.lastCwd)`, so follow that pattern instead of building a second autocomplete system.

- For PR numbers, mirror the existing `/pr-review` pattern.
- For branch names, mirror the existing `/review-local` pattern.
- For model/provider completions, see [External AI Agents & CLI](external-ai-agents.html) for details.

## Related Pages

- [Built-in Workflow Commands](built-in-workflows.html)
- [Managing Custom Agents](managing-custom-agents.html)
- [Asking Side Questions with /btw](btw-command.html)
- [Implementing Command Guards](safety-enforcements.html)
- [Installation & Quickstart](quickstart.html)
