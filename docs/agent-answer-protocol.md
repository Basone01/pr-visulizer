# Agent answers in app windows

The terminal remains the interactive Codex session.
The agent can send a formatted answer to a separate PR Visualizer window through app-provided MCP tools.
The app receives structured data directly rather than extracting text from terminal output.

## Agent tools

1. `get_pr_context` returns the PR metadata and selected file for this terminal session.
2. `open_file` shows a repository-relative file in the main app's diff viewer.
3. `render_answer` opens or updates the session's answer window.
4. `get_current_file` returns the file the reviewer has open, its review status, and the selected line range, if any.
5. `list_pr_files` lists every PR file in the reviewer's queue order, with its status, its reviewed mark, and the suggested next file.
6. `get_review_drafts` lists the reviewer's pending inline comment drafts.

For a longer summary or explanation, the agent calls `render_answer` and leaves a short confirmation in the terminal.
The existing repository access, model selection, conversation, and live terminal output remain available.

## Review state

The app shares a review snapshot with the terminal session, and the last three tools answer from it.
The snapshot holds the queue mode, the gutter line selection in the open file, every PR file in tray order, and the pending drafts.
Selection lines are head-side line numbers.
Each draft carries a side, and its lines are head line numbers on the RIGHT side and base line numbers on the LEFT side, where a comment sits on a deleted line.
The app pushes the snapshot inside the terminal context whenever it changes, coalesced to one update per 150 ms.
The tools read the stored snapshot, so they never wait on the app window.
Until the app has shared a snapshot, the tools report that the review state is not available yet.
The tools are read-only, and the agent never publishes or edits a draft.

## Version 1 answer

```json
{
  "version": 1,
  "title": "PR summary",
  "markdown": "## What changed\n\n- Added request validation.\n- Covered invalid inputs with tests.\n\n| Area | Status |\n| --- | --- |\n| Validation | Reviewed |",
  "fileRefs": [
    {
      "path": "src/validation.ts",
      "line": 42,
      "label": "Open validation"
    }
  ]
}
```

Markdown uses the app's existing renderer for headings, emphasis, lists, tables, links, and fenced code blocks.
A ```mermaid fenced block renders as a diagram, and falls back to the plain code block if it does not parse.
Inline HTML renders through a GitHub-style sanitizer, so safe tags such as `details`, `summary`, `sup`, `kbd`, and tables work.
The sanitizer drops inline `style` attributes, removes `script` elements with their content, and removes event handler attributes such as `onerror`.
File references are app actions that open the named file in the main window.
The app supplies the session ID and update timestamp, so the agent cannot choose another session's destination.

Each successful update replaces the current answer for that session.
The window reads the latest stored snapshot and listens for updates.
There is no need to copy terminal output into the viewer.
Closing the window destroys it, the stored answer stays with the session.
The terminal header shows an Open answer button once a session has an answer, and it rebuilds the window from that stored answer.

## Lifecycle

The app registers the MCP tools only for the Codex or Claude Code process it launches.
It does not edit the user's global Codex configuration.
The user's existing CLI configuration and MCP tools remain available.
The six internal app tools are approved for this launch, without a consent prompt or a global settings change.

PR identity belongs to the terminal session.
Selecting another file updates the context without restarting Codex.
Changing the PR ends the old terminal session and prevents its tools from navigating the new PR.
The native bridge validates session identity, report size, and repository-relative file paths.
The terminal still starts with a read-only repository sandbox.

## Implementation references

Codex supports local MCP servers configured with a command, arguments, and environment variables.
See the [official MCP configuration documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Codex supports per-invocation configuration overrides through `-c`.
See the [official advanced configuration documentation](https://learn.chatgpt.com/docs/config-file/config-advanced).

The desktop app creates the answer window with Tauri's webview window builder.
See the [Tauri WebviewWindowBuilder API](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewWindowBuilder.html).
