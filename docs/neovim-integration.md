# Neovim Integration and Quickfix Support

When you run pi inside a Neovim `:terminal` buffer, it automatically detects the parent Neovim instance and unlocks the ability to send file lists directly to Neovim's quickfix window — letting you jump between changed files without leaving your editor.

## Prerequisites

- Neovim 0.5+ with the `--remote-expr` server feature (included in all modern builds)
- Pi must be started from a Neovim `:terminal` buffer (not an external terminal)
- A git repository with changed files (for `/nvim-changed-files`)

## Quick Example

Open a terminal inside Neovim and start pi:

```vim
:terminal pi
```

Then, inside the pi session, run:

```
/nvim-changed-files
```

Your quickfix window opens instantly with every file changed on your branch. Press `Enter` on any entry to jump to that file.

## How Automatic Detection Works

Pi checks for the `NVIM` environment variable, which Neovim sets automatically in every `:terminal` buffer. If `NVIM` is present, pi registers the Neovim integration commands. If it's absent (you're running pi in a regular terminal), the commands simply don't appear — no configuration needed.

> **Note:** The integration only activates for the main pi session, not for background subagents. This prevents background tasks from interfering with your quickfix list.

## Sending Changed Files to Quickfix

The `/nvim-changed-files` command collects all files that differ from the default branch and sends them to your quickfix list.

### What It Detects

| Scenario | Files Shown |
|----------|-------------|
| On a feature branch | All committed changes vs `origin/main` (or `origin/master`) **plus** any uncommitted working tree changes |
| On `main` or `master` | Uncommitted changes only (working tree diff against `HEAD`) |

Each quickfix entry shows the file path and its git status — `modified`, `added`, `deleted`, `renamed`, or `copied`.

### Navigating the Quickfix List

Once `/nvim-changed-files` populates the quickfix window, use standard Neovim quickfix commands:

| Command | Action |
|---------|--------|
| `:cnext` / `:cprev` | Jump to the next / previous file |
| `:cfirst` / `:clast` | Jump to the first / last file |
| `:copen` | Reopen the quickfix window if you closed it |
| `:cclose` | Close the quickfix window |
| `Enter` (in quickfix window) | Open the file under the cursor |

> **Tip:** Map `:cnext` and `:cprev` to convenient keybindings for fast navigation. For example, add to your Neovim config:
> ```vim
> nnoremap ]q :cnext<CR>
> nnoremap [q :cprev<CR>
> ```

## Typical Workflow

1. Start pi in a Neovim terminal: `:terminal pi`
2. Ask pi to implement a feature or fix a bug.
3. Run `/nvim-changed-files` to see which files were modified.
4. Navigate the quickfix list to review each change in your editor.
5. Make manual adjustments if needed, then return to the pi terminal buffer to continue.

This is especially useful after pi completes a multi-file change — you get an instant overview of every touched file without running `git diff --name-only` yourself.

## How Pi Communicates with Neovim

Pi communicates with the parent Neovim instance using Neovim's built-in RPC mechanism. The `NVIM` environment variable contains the path to Neovim's Unix domain socket. Pi uses `nvim --server <socket> --remote-expr` to execute Lua code in the parent Neovim process, which populates the quickfix list via `vim.fn.setqflist()` and opens it with `vim.cmd("copen")`.

All file paths are resolved to absolute paths before being sent, so quickfix entries work correctly regardless of your working directory.

> **Note:** The RPC call has a 5-second timeout. If Neovim is unresponsive (e.g., running a blocking plugin), pi displays a warning notification and continues without interruption.

## Advanced Usage

### Combining with Code Reviews

After running a code review with pi's review system, use `/nvim-changed-files` to load all modified files into quickfix. This gives you a checklist-style workflow — open each changed file, review pi's modifications, and move to the next one.

For details on the review system, see [Running the Automated Code Review Loop](code-review-loop.html).

### Using with Background Agents

Background agents (spawned via async delegation) do not interact with your Neovim quickfix list — only the main session has access. After a background agent completes its work, you can run `/nvim-changed-files` from the main session to see what changed.

For more on background agents, see [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html).

### Running Pi Outside Neovim

If you run pi in a standalone terminal (outside Neovim), the `/nvim-changed-files` command is not registered. Pi gracefully skips all Neovim integration when the `NVIM` environment variable is absent — no errors, no warnings, no performance impact.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `/nvim-changed-files` doesn't appear as a command | Verify you started pi from inside a Neovim `:terminal`. Check that `echo $NVIM` prints a socket path in your terminal. |
| "No changed files found" notification | You're on the default branch with no uncommitted changes, or git can't detect a diff base. Ensure you're on a feature branch with committed or staged changes. |
| "Failed to send quickfix to nvim" warning | The Neovim RPC call timed out or failed. Check that the parent Neovim instance is still running and responsive. Restarting Neovim and pi resolves most cases. |
| Quickfix shows files but paths are wrong | Make sure pi's working directory matches your project root. Pi resolves all paths to absolute paths, but a mismatched `cwd` can produce unexpected results. |

## Related Pages

- [Running the Automated Code Review Loop](code-review-loop.html)
- [Running Background Agents and Scheduled Tasks](async-agents-and-cron.html)
- [Slash Commands and Extension Commands Reference](commands-reference.html)
- [Your First Coding Workflow](first-workflow.html)
- [Configuration and Environment Variables Reference](configuration-reference.html)
