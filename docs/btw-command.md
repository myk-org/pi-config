# Asking Side Questions with /btw

Use `/btw` when you want a fast answer based on the current conversation without cluttering the main chat history. It is useful for small clarifications, naming questions, or quick follow-ups while you stay focused on the current task.

## Prerequisites

- An active Pi session with the terminal UI
- A currently selected model
- Enough conversation context for the model to answer from the existing session

## Quick Example

```text
/btw What helper name did we agree on for the auth token parser?
```

This opens a temporary answer view instead of adding a new turn to the main conversation.

## Step-by-step

### 1. Ask the side question

```text
/btw <question>
```

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `<question>` | string | (required) | The short question to answer from the current conversation context. |

```text
/btw What was the final scope of the refactor?
```

**Effect:** Starts a temporary side-question flow. If the question is empty, Pi shows `Usage: /btw <question>`.

### 2. Wait for the temporary answer

While the answer is being generated, Pi shows a loading box with the active model id:

```text
Thinking (<model-id>)...
```

| Item | Effect |
| :--- | :--- |
| Loading view | Shows the request is in progress |
| Abort action | Cancels the side question |
| Empty answer | Shows `No answer received` |

```text
/btw Summarize the decision we made about caching in one sentence.
```

### 3. Read the answer in the overlay

The result appears in a scrollable overlay with the original question and the generated answer.

| Key | Action |
| :--- | :--- |
| `Esc` | Close the overlay |
| `Space` | Close the overlay |
| `q` | Close the overlay |
| `Ctrl+C` | Close the overlay |
| `↑` or `k` | Scroll up |
| `↓` or `j` | Scroll down |
| `PgUp` | Scroll up faster |
| `PgDn` | Scroll down faster |

```text
/btw Which part of the plan is still unresolved?
```

**Effect:** Displays the answer in a temporary view and returns you to the same session after dismissal.

### 4. Continue your main task

`/btw` does not append the side exchange to the main conversation branch.

| Behavior | Normal turn | `/btw` |
| :--- | :--- | :--- |
| Uses current conversation context | Yes | Yes |
| Uses tool access | Yes | No |
| Writes a new turn into the main history | Yes | No |
| Shows answer in a temporary overlay | No | Yes |

```text
/btw Remind me which file we said owns the retry logic.
```

> **Note:** `/btw` answers only from the current conversation plus loaded project context such as context file names and available skill names.

## Advanced Usage

### Best use cases

| Use case | Good fit for `/btw` |
| :--- | :--- |
| Clarify a recent decision | Yes |
| Ask for a one-line recap | Yes |
| Check naming or terminology from the current session | Yes |
| Ask for file inspection or command output | No |
| Make code changes | No |

```text
/btw Give me the shortest version of the migration plan.
```

> **Tip:** Use `/btw` for quick memory refresh. Use a normal prompt when you want the answer preserved in the main transcript or you need tools.

### Context available to the answer

`/btw` can use:

- The current conversation branch
- Loaded project context file names
- Available skill names

`/btw` does not use:

- File reads during the side question
- Shell commands during the side question
- Workspace edits during the side question

```text
/btw Based on this session only, what are the two biggest risks left?
```

### Using and extending

| Goal | What to do |
| :--- | :--- |
| Use `/btw` | Run `/btw <question>` in any active session |
| Create similar commands | Add your own slash commands with custom behavior |

For creating related commands, see [Creating Slash Commands](custom-slash-commands.html) for details.

## Troubleshooting

| Problem | What it means | What to do |
| :--- | :--- | :--- |
| `Usage: /btw <question>` | No question was provided | Run `/btw` with text after it |
| `Cancelled` | The request was aborted | Run the command again |
| `No answer received` | The model returned no usable text | Retry with a clearer question |
| The answer is too vague | The current session does not contain enough context | Ask a more specific question or continue with a normal prompt |

> **Warning:** `/btw` has no tool access, so it cannot verify files, run commands, or inspect new code while answering.

## Related Pages

- [Creating Slash Commands](custom-slash-commands.html)
- [Built-in Workflow Commands](built-in-workflows.html)
- [Installation & Quickstart](quickstart.html)
- [Managing Custom Agents](managing-custom-agents.html)
