---
description: Review local changes with Qodo before committing or opening a PR
argument-hint: "[--autofix] [--fast|--deep] [--ticket <url>] [path ...]"
---

## Raw Arguments

```text
$ARGUMENTS
```

> **Bug Reporting Policy:** If you encounter ANY error, unexpected behavior, or reproducible bug
> while executing this command, DO NOT work around it silently. Ask the user:
> "Should I create a GitHub issue for this?" Route to:
> `myk-org/pi-config` for plugin/command spec or `myk-pi-tools` CLI issues.
> Do not silently skip steps or apply manual fixes that hide the root cause.

# Qodo local review

Review local changes with the installed `qodo-review` skill. This is a pre-PR workflow. Do not
commit, push, open or update a PR, or post review results to a forge.

## Parse arguments

Parse the raw arguments before running commands:

- `--autofix` applies every finding without an approval prompt, then repeats review and repair for
  at most 3 autofix cycles (one cycle = apply fixes, test, and rerun review).
- `--fast` requests a quick review.
- `--deep` requests a thorough review.
- `--fast` and `--deep` are mutually exclusive. If both appear, report the conflict and stop.
- `--ticket <url>` attaches a ticket URL and may be repeated. A missing URL is an error.
- Remaining arguments are optional git pathspecs passed to `qodo review`.
- Reject unknown `--` options. Never pass `--autofix` to the Qodo CLI.

Keep the parsed depth, tickets, and path scope unchanged throughout a fix loop.

## Preflight

1. Confirm an available skill named `qodo-review` is installed. Read its `SKILL.md` completely and
   follow it as the authority for CLI compatibility, authentication, progress, result parsing,
   context format, errors, and review semantics.
2. Resolve `qodo` from `PATH`, then the skill's documented absolute-path fallback. Run
   `<qodo> --version` before any other Qodo command and enforce the skill's minimum version.
3. Run the skill's read-only authentication check and `qodo review --help`. Use only flags supported
   by that installed CLI.

If the CLI, a compatible version, or the required skill is missing, stop. Display this official
install command exactly, but NEVER execute it:

```bash
curl -fsSL https://get.qodo.ai | sh
```

Tell the user to run `qodo` to finish setup, then rerun `/qodo-review`. Do not install, update,
log in, refresh tools, or run any audit automatically.

## Attach session context

Before each review, write a self-contained JSON context file under `/tmp`. Include:

- what this session changed and why;
- key implementation decisions and their rationale;
- relevant ticket, spec, or code-dependency URLs from the task and raw arguments.

Do not claim the reviewer can see this conversation. Pass the context with `--context-file`, add
parsed tickets with `--ticket`, add the selected depth flag, and append pathspecs after options.
Use `--json` and the progress/background flow required by the installed skill. Remove the temporary
context and result files when the run ends.

## Handle findings

Read the complete structured result, including coverage, skipped reviewers, finding state, and error
envelopes. A zero-length `findings` array is clean only when the skill's coverage and open-finding
state also say the review is complete and clean.

For every finding, inspect the cited code and explain its impact, evidence, and proposed fix.

- Default mode: present all findings in one numbered list, mark your recommendation, then call
  `ask_user` once so the user can select which findings to apply. Preselect nothing. Make no edits
  before the response, and apply only selected findings.
- `--autofix`: skip `ask_user` and fix every finding. Do not silently dismiss or defer findings.
  If a finding cannot be fixed safely, report the blocker and stop.

After edits, run the repository's required tests. Tests are mandatory and every test must pass.
Fix failures before continuing. Then rerun Qodo with the same context, depth, tickets, and path scope.
In `--autofix` mode, stop early if the same findings recur or a cycle makes no effective progress;
stop after at most 3 autofix cycles even if findings remain. Report remaining findings and the
blocker to the user rather than continuing automatically. In default mode, present any new findings
and use one new `ask_user` selection before further edits.

Finish with the findings addressed, tests run and their results, review coverage, and anything still
open. Never commit, push, create a PR, or offer to do those actions automatically.
