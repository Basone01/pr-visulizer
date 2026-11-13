# Embedded AI terminal (Codex or Claude)

The desktop AI panel runs an interactive AI CLI inside the linked local repository.
The reviewer picks the provider first, Codex or Claude Code, then presses Start, and the terminal does not start before that.
It replaces the custom chat interface and its per-message diff packaging.
Codex can also open a separate formatted-answer window through the [agent answer protocol](agent-answer-protocol.md).
The graph, diff viewer, review queue, and GitHub submission flow are unchanged.
For Claude, the panel now also offers a chat surface beside the terminal, described in [Chat surface for Claude (OpenUI)](openui-chat.md).
The terminal remains the default surface and works as described here.

## Context

The app passes a small initial prompt containing the PR URL, title, base commit, head commit, and selected file when available.
Codex can then inspect repository files and Git objects through its normal tools.
The prompt identifies the PR revisions explicitly because the linked checkout may be on a different branch.
When the `sem` CLI is installed, the prompt asks the agent to prefer `sem diff -v --from <base> --to <head>` for an entity-level view, the same command the `sem-commit` and `sem-pr` skills use, and to fall back to `git diff` otherwise.
The app does not switch branches or reset the working tree.

The app does not build a bounded patch snapshot for each turn.
It does not add GitHub comments or Jira issues automatically.
The CLI owns conversation history and renders its own live output.
Existing review records remain stored, but the terminal does not turn replies into structured app findings.

## Interface

The panel offers a provider choice, a model choice, and terminal controls.
Nothing runs until a provider is chosen and the reviewer presses Start.
The provider choice is remembered for the next session, but each session still waits for Start.
For Codex, Luna remains the default model.
For Claude, Haiku is preselected as the fastest alias, and the reviewer can switch to any alias (`fable`, `opus`, `sonnet`, `haiku`) or the CLI default.
The suggestions are family aliases so the app never pins a version.
Switching the provider or the model ends the current terminal session and returns to the Start button, it never launches a new one.
Provider, Model, Custom model ID, Surface (Claude only) and Custom shortcuts sit in one settings row, a native disclosure.
Its summary names the current choice, for example "Claude · Haiku · Chat".
The row is open until a provider is chosen and closed once one is saved.
The open state is not saved, and opening or closing the row never restarts a session.
The session surface keeps a 150 px minimum height, and open settings scroll inside themselves.

The terminal header also offers prompt shortcuts.
A shortcut only prefills the CLI's input box, the reviewer edits it and presses Enter.
The first shortcut, PR description, asks the agent to build the same description the `sem-pr` skill produces (sem diff, JIRA ticket, System design, Changes) without the test scenario and test report sections, and to render it in the answer window.
Built-in shortcuts are data in `apps/web/src/entity/terminalPromptShortcuts.ts`, so adding one is a data change.
The reviewer can also add their own shortcuts under Custom shortcuts in the panel: a label and a prompt template.
A template may use the placeholders `{prUrl}`, `{title}`, `{baseSha}`, `{headSha}`, and `{selectedFile}`, any other braces stay as written.
Custom shortcuts are stored app-wide, not per PR.
Collapsing the panel keeps the terminal session alive behind the vertical tab.
Changing the PR ends the old terminal session so another PR cannot inherit its context.
Selecting a different diff file does not restart the conversation.

The terminal uses the installed CLI's own login and configuration.
This is a normal interactive CLI session, not the legacy prompt-only broker's restricted execution profile.
The hosted web app cannot start local terminal processes.

## Providers

Both providers get the same initial prompt, the same linked checkout, and the same per-launch app MCP server (`pr_visualizer`) described in the [agent answer protocol](agent-answer-protocol.md).

Codex starts with `--sandbox read-only`, `--no-alt-screen`, and `-c` overrides that register the app MCP server for this launch only.

Claude Code has no read-only sandbox flag, so the app removes the editing tools instead and leaves every other mutation to the CLI's own interactive permission prompt:

- `--mcp-config` with an inline JSON `mcpServers` entry for `pr_visualizer`.
- `--allowedTools mcp__pr_visualizer "Bash(sem diff *)"`, so the three app tools and `sem diff` run without a prompt. `sem diff` is read-only, its flags only change output format or filtering. No git rule is pre-approved: a wildcard such as `Bash(git diff *)` would also allow `git diff --output=<file>`, and the CLI's built-in read-only set already runs plain `git diff` and `git show`.
- `--disallowedTools Edit Write NotebookEdit`.
- `--permission-mode manual`, the prompt-on-first-use mode. Newer CLIs start interactive sessions in `auto` mode, so the flag is explicit. It needs Claude Code 2.1.200 or later.
- `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` keeps the transcript in the embedded terminal's scrollback, the Claude equivalent of Codex's `--no-alt-screen`.
- `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, and `CLAUDE_CODE_ENTRYPOINT` are stripped from the child environment, so a desktop app launched from inside a Claude Code session still gets an independent session with transcript saving on.

## Implementation references

The native process uses portable-pty 0.9.0 to create a pseudoterminal, spawn a child process, and connect input and output.
See the [portable-pty API](https://docs.rs/portable-pty/0.9.0/portable_pty/).

The webview renders terminal bytes and forwards keyboard input using a narrow wrapper around xterm.js.
See the [xterm Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/).

The installed Codex CLI help was checked for the optional initial prompt, working-directory, model, and sandbox options.
See the [official Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

The Claude Code flags, permission rule syntax, MCP configuration, and environment variables were checked against the official docs on 2026-10-14.
See the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference), [permissions](https://code.claude.com/docs/en/permissions), [permission modes](https://code.claude.com/docs/en/permission-modes), [MCP](https://code.claude.com/docs/en/mcp), and [environment variables](https://code.claude.com/docs/en/env-vars).
