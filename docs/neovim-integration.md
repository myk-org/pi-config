# Neovim Integration

Use Pi inside Neovim when you want to turn changed files into a navigable quickfix list and stay in your editor while reviewing work. This is fastest when you are iterating on a branch and want to jump file-to-file without leaving the terminal buffer.

## Prerequisites

- Neovim is installed and running.
- The `nvim` CLI is available on your `PATH`.
- Pi is started from a Neovim terminal buffer such as `:terminal`.
- Your repository has `git` available, with `origin/main` or `origin/master` fetched if you want branch-vs-base comparisons.

## Quick Example

Start Pi inside Neovim, then send changed files to quickfix:

```bash
:term pi
```

```text
/nvim-changed-files
```

Neovim opens the quickfix window and fills it with changed files so you can move through them with normal quickfix commands.

## Step-by-Step

1. Open a terminal inside Neovim.

```vim
:terminal
```

You can also use a split if you prefer to keep code visible while Pi runs:

```vim
:vsplit term://bash
```

2. Start Pi from that terminal.

```bash
pi
```

Pi only exposes the Neovim quickfix command when it is launched from a Neovim terminal session.

3. Populate quickfix with the files you need to review.

```text
/nvim-changed-files
```

Pi collects changed files from the current repository and sends them to Neovim's quickfix list.

4. Navigate the results in Neovim.

```vim
:copen
:cnext
:cprev
```

Each quickfix item points to a changed file and includes its git status such as `modified`, `added`, `deleted`, or `renamed`.

5. Re-run the command after new edits or commits.

```text
/nvim-changed-files
```

This refreshes quickfix with the latest set of changed files for the current branch or working tree.

## Advanced Usage

### What the Command Compares

`/nvim-changed-files` behaves differently depending on your current branch:

| Current branch | What Pi includes |
|---|---|
| `main` or `master` | Changes in your current working tree compared to `HEAD` |
| Any other branch | Branch changes compared to `origin/main` if it exists, otherwise `origin/master`, plus current uncommitted changes |

> **Tip:** On feature branches, this makes quickfix useful for both local edits and the branch-level diff you are preparing for review.

### Run Remote Lua in Your Current Neovim Session

Because Pi inherits the `$NVIM` socket when started from a Neovim terminal, you can trigger editor actions from commands, scripts, or prompts.

```bash
nvim --server "$NVIM" --remote-expr 'luaeval("vim.notify(\"Task complete from Pi!\")")'
```

A simple use case is sending yourself a notification after a long-running command or test finishes.

### Use Neovim for Review, Browser UI for Diff Publishing

If you want keyboard-first navigation, Neovim quickfix is the fastest path. If you want a browser diff viewer with inline comment publishing, see [Using the Web Dashboard](using-the-web-dashboard.html) for details.

## Troubleshooting

- **`/nvim-changed-files` does not appear:** Start Pi from inside Neovim, not from tmux or a separate terminal window.
- **Quickfix does not open or update:** Make sure the `nvim` CLI can talk to the current editor session through `$NVIM`.
- **No files are listed:** Check that your repository actually has changed files. On feature branches, also make sure `origin/main` or `origin/master` is available locally.
- **Remote Lua command fails:** Verify that `$NVIM` is set in the shell where you run the command.
- **You are using a background subagent:** Neovim integration is only available from your main interactive session, not background child sessions.

See [Installation & Quickstart](quickstart.html) for basic Pi setup.

## Related Pages

- [Installation & Quickstart](quickstart.html)
- [Built-in Workflow Commands](built-in-workflows.html)
- [Creating Slash Commands](custom-slash-commands.html)
- [Using the Web Dashboard](using-the-web-dashboard.html)
