# Neovim Integration

When you run Pi inside a Neovim terminal buffer, it automatically detects the editor environment and enables direct RPC communication. This allows you to quickly load working context into your editor, populate the quickfix list with branch changes, and programmatically execute Neovim Lua commands from your AI session.

## Prerequisites

* Neovim installed and running.
* Pi started from an embedded Neovim terminal buffer (`:terminal`).

## Quick Example

The simplest way to use the integration is to send your current Git changes directly to the Neovim quickfix window for easy review.

Start Pi inside a Neovim terminal:
```bash
:term pi
```

Inside the Pi chat interface, run the built-in slash command:
```
/nvim-changed-files
```
Neovim will immediately open the quickfix window containing all modified, added, renamed, or deleted files relative to your default branch.

## Step-by-Step

Reviewing a large pull request or a batch of local changes is much easier when loaded directly into Neovim's quickfix list rather than scrolling through terminal output.

1. **Open a terminal in Neovim:** From normal mode, type `:terminal` or open a split with `:vsplit term://bash`.
2. **Launch Pi:** Start your session by typing `pi` in the terminal prompt. The integration automatically connects to the parent editor using the `$NVIM` socket variable.
3. **Trigger the quickfix population:** Type `/nvim-changed-files` in the Pi chat prompt and hit enter.
4. **Navigate the files:** Pi calculates the Git diff (comparing against `origin/main` or your local `HEAD`), formats the results, and automatically commands Neovim to open the quickfix list (`:copen`). You can now use standard Neovim commands (like `:cnext` and `:cprev`) to jump through your changed files.

> **Tip:** The `/nvim-changed-files` command automatically detects whether you are on the `main` branch or a feature branch, pulling committed changes versus `origin/main` as well as any uncommitted working tree changes.

## Advanced Usage

### Leveraging Remote Lua Execution

Because Pi runs as a child process of Neovim, it inherits the `$NVIM` socket environment variable. You can leverage this directly in your own shell scripts, custom extensions, or AI prompts to send commands back to your Neovim instance.

For example, you can tell the AI to evaluate a Lua command inside your active editor using standard Neovim CLI arguments:

```bash
nvim --server $NVIM --remote-expr 'luaeval("vim.notify(\"Task complete from Pi!\")")'
```

If you are running long bash scripts or tests via Pi, you can use this trick to trigger notifications or reload buffers in Neovim when the job finishes.

> **Note:** Neovim integration and remote execution are automatically disabled when Pi spawns background sub-agents (identifiable by the `PI_SUBAGENT_CHILD=1` environment variable). This ensures that background tasks do not unexpectedly change your active editor state or steal focus.

## Troubleshooting

* **Quickfix list does not open:** Ensure you are running Pi *inside* a Neovim terminal. Running Pi in a separate tmux pane or external terminal emulator will not expose the `$NVIM` socket environment variable required for RPC communication.
* **No files loaded in quickfix:** The `/nvim-changed-files` command relies on standard Git output. Check that your repository has an `origin/main` or `origin/master` branch fetched locally, as it uses this as the base comparison for feature branches.

## Related Pages

- [Daemon & Websocket Networking](daemon-and-websockets.html)
- [Installation & Quickstart](quickstart.html)
