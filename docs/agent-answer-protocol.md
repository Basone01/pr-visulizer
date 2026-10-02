# Agent answers in app windows

The terminal remains the interactive Codex session.
The agent can send a formatted answer to a separate PR Visualizer window through app-provided MCP tools.
The app receives structured data directly rather than extracting text from terminal output.

## Agent tools

1. `get_pr_context` returns the PR metadata and selected file for this terminal session.
2. `open_file` shows a repository-relative file in the main app's diff viewer.
3. `render_answer` opens or updates the session's answer window.

For a longer summary or explanation, the agent calls `render_answer` and leaves a short confirmation in the terminal.
The existing repository access, model selection, conversation, and live terminal output remain available.

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
Raw HTML is not executed.
File references are app actions that open the named file in the main window.
The app supplies the session ID and update timestamp, so the agent cannot choose another session's destination.

Each successful update replaces the current answer for that session.
The window reads the latest stored snapshot and listens for updates.
There is no need to copy terminal output into the viewer.

## Lifecycle

The app registers the MCP tools only for the Codex process it launches.
It does not edit the user's global Codex configuration.
The user's existing CLI configuration and MCP tools remain available.
The three internal app tools are approved for this launch, without a consent prompt or a global settings change.

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
