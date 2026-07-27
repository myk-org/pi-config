# Creating Slash Commands

## Creating a Prompt-Based Slash Command
Create a simple chat alias for a frequently used, complex prompt.

```markdown
---
description: "Run a quick security audit on the current changes"
---
Review the git diff of the current changes and look for security vulnerabilities.
Check for hardcoded secrets, injection vectors, and broken access control.
```
Place this in `prompts/security-audit.md` to automatically register the `/security-audit` command. The markdown filename determines the slash command name, and the description populates the command menu in the UI.

## Passing Arguments to a Prompt Command
Inject user input from the chat bar directly into your prompt template.

```markdown
---
description: "Explain a specific concept or file — /explain <target>"
argument-hint: "<target>"
---

## Raw Arguments

```text
$ARGUMENTS
```

> **Bug Reporting:** If this command fails, use the `/bug` command to report it.

Explain the target provided in the raw arguments above. Keep the explanation concise and focus on how it fits into the project architecture.
```
When a user runs `/explain src/main.ts`, the `$ARGUMENTS` token is replaced with `src/main.ts`. The `argument-hint` frontmatter provides inline help in the command palette.
> **Note:** The bug reporting blockquote is a project standard and must immediately follow the `$ARGUMENTS` block.

## Creating an Interactive TypeScript Command
Register a programmable extension command to interact with the workspace, manipulate the UI, or trigger background tasks.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerHelloCommand(pi: ExtensionAPI): void {
  pi.registerCommand("hello", {
    description: "Display a custom notification greeting",
    handler: async (args, ctx) => {
      const name = args?.trim() || "Developer";

      if (!ctx.hasUI) {
        return; // Ensure the session supports UI before notifying
      }

      ctx.ui.notify(`Hello, ${name}! Your workspace is ${ctx.cwd}`, "info");
    },
  });
}
```
Place this in a new file within the `extensions/` directory and call it during extension initialization. The handler function receives the raw argument string and a context object containing the session state, UI tools, and workspace details.
> **Tip:** See [Daemon & Websocket Networking](daemon-and-websockets.html) for details on handling asynchronous background tasks within command handlers.

## Adding Argument Autocomplete to a Command
Provide interactive tab-completions for your custom slash commands.

```typescript
// Add to the `completions` record in extensions/orchestrator/extended-autocomplete.ts
"hello": (prefix: string) => {
  return filter([
    { value: "--verbose", label: "--verbose", description: "Show detailed greeting output" },
    { value: "--quiet", label: "--quiet", description: "Suppress the notification bell" }
  ], prefix);
},
```
Add your completion logic to `extensions/orchestrator/extended-autocomplete.ts`. The `filter` helper automatically handles fuzzy matching against the user's current typed prefix.
> **Warning:** If you are adding autocomplete for a prompt template (like the `/explain` example above), you must also add the command name to the `promptTemplateCommands` set located in the same file to intercept the routing.

## Related Pages

- [Implementing Command Guards](safety-enforcements.html)
- [myk_pi_tools CLI Reference](cli-reference.html)
