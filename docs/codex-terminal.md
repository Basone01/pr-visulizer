# Embedded Codex terminal

The desktop AI panel runs the interactive Codex CLI inside the linked local repository.
It replaces the custom chat interface and its per-message diff packaging.
Codex can also open a separate formatted-answer window through the [agent answer protocol](agent-answer-protocol.md).
The graph, diff viewer, review queue, and GitHub submission flow are unchanged.

## Context

The app passes a small initial prompt containing the PR URL, title, base commit, head commit, and selected file when available.
Codex can then inspect repository files and Git objects through its normal tools.
The prompt identifies the PR revisions explicitly because the linked checkout may be on a different branch.
The app does not switch branches or reset the working tree.

The app does not build a bounded patch snapshot for each turn.
It does not add GitHub comments or Jira issues automatically.
The CLI owns conversation history and renders its own live output.
Existing review records remain stored, but the terminal does not turn replies into structured app findings.

## Interface

The panel offers a model choice and terminal controls.
Luna remains the default.
Collapsing the panel keeps the terminal session alive behind the vertical tab.
Changing the PR ends the old terminal session so another PR cannot inherit its context.
Selecting a different diff file does not restart the conversation.

The terminal uses the installed Codex login and configuration.
The app launches it with a read-only sandbox.
This is a normal interactive CLI session, not the legacy prompt-only broker's restricted execution profile.
The hosted web app cannot start local terminal processes.

## Implementation references

The native process uses portable-pty 0.9.0 to create a pseudoterminal, spawn a child process, and connect input and output.
See the [portable-pty API](https://docs.rs/portable-pty/0.9.0/portable_pty/).

The webview renders terminal bytes and forwards keyboard input using a narrow wrapper around xterm.js.
See the [xterm Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/).

The installed Codex CLI help was checked for the optional initial prompt, working-directory, model, and sandbox options.
See the [official CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
