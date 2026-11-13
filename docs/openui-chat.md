# Chat surface for Claude (OpenUI)

The desktop AI panel has a second surface beside the [embedded terminal](codex-terminal.md): a chat.
The chat drives Claude Code headless and shows replies as markdown prose plus rich blocks written in [OpenUI Lang](https://github.com/thesysdev/openui).
It is an experiment kept next to the terminal, not a replacement for it.

## What it is

The panel has a Terminal | Chat switch.
It defaults to Terminal.
Chat is offered only when the provider is Claude.
Codex has no chat and always shows the terminal.

The chat runs one long-lived `claude -p` process per session in the linked local repository.
The process talks stream-json on stdin and stdout.
A native Rust module pipes the lines between the process and the webview.
The webview turns each line into transcript entries.
An assistant reply is markdown prose, and it may contain fenced blocks tagged `openui-lang`.
OpenUI's `Renderer` draws those blocks with a small code-review component library.

What stays unchanged:

- The terminal, its PTY path and xterm are not touched. It is still the default surface.
- The graph, diff viewer, review queue and GitHub submission flow are unchanged.
- The per-launch app MCP server (`pr_visualizer`) works as before, and the chat reuses the same session registry, keyed by the session ID. The terminal still pops its answer out in a window, as in the [agent answer protocol](agent-answer-protocol.md). In the chat, an answer shows inline (see below).
- The older prompt-only chat panel and its broker are not used by this surface.

The chat needs the desktop app, because the hosted web app cannot start local processes.
In a browser the chat shows "The Claude chat is available in the desktop app."

## Interface

1. Provider, Model, Custom model ID, Surface and Custom shortcuts sit in one settings row, a native disclosure. Its summary names the current choice, for example "Claude · Haiku · Chat" (`describePanelSettings`). It is open until a provider is chosen and closed once one is saved. The open state is not persisted, and toggling it never restarts a session. The session surface keeps a 150 px minimum height, and open settings scroll inside themselves.
2. The Surface switch shows Terminal and Chat as two radio options. It appears only when the provider has more than one surface.
3. The choice is saved app-wide as `panelSurface` and defaults to `terminal`, so settings saved before the chat existed load unchanged. If Chat is saved and the reviewer picks Codex, the terminal shows and the saved choice is kept for when Claude is picked again.
4. Switching to Chat shows a Start button and starts nothing. The same Start gate as the terminal applies.
5. Switching surface ends the session of the surface that is left. Nothing relaunches on its own.

After Start, the app does this:

1. It loads the review UI prompt and passes it to the CLI as `--append-system-prompt`.
2. It starts the session and pushes the PR context to the native side.
3. It sends the PR briefing as the first user turn. The transcript shows only the notice "PR context sent".

The briefing differs a little from the terminal one.
It asks for Markdown answers and for every file location as a Markdown link such as `[src/app.ts:42](src/app.ts#L42)`.
It tells the agent to try `sem diff` and fall back to `git diff`, because a `command -v sem` probe would need approval and show a denial.

### Parts of the chat

| Part | Behavior |
| --- | --- |
| Composer | Enter sends. Shift+Enter adds a new line. The Enter that confirms an IME candidate does not send. A repeated keydown never sends, so holding Enter on a follow-up button cannot send the prefilled text. The composer is disabled until the session runs. |
| Send and Interrupt | While a reply is running, Send becomes Interrupt. Interrupt ends the turn and keeps the session. The transcript shows "Interrupted." |
| Message size | A message over 256 KiB is kept in the composer with an error. It is not sent. |
| Rejected send | If the native side rejects a send, the text returns to the composer and the session stays alive. |
| Failed turn | The notice shows the CLI's reason as plain text, capped at 2,000 characters. A tool still running when the turn or the process ends reads Stopped. |
| Shortcuts | The same prompt shortcuts as the terminal. They are enabled only while the session runs. A shortcut adds its text after what the reviewer typed and never sends. |
| Tool rows | One row per tool call with the tool name, a one-line summary (the command, path or pattern) and a status: Running, Done, Failed, Denied or Stopped. The `mcp__<server>__` prefix is removed from MCP tool names. |
| Denial notice | A denied tool shows a Denied row and the notice "`<tool>` needed approval, and this chat cannot approve actions yet." The turn still ends normally. |
| File references | Only files of this PR are clickable, in prose, in answers and in `FileRef` buttons. A click opens that file in the main diff viewer, at the line when there is one. The reason is that the click jumps the diff, and the diff has only PR files (a link to another file used to empty the diff with no message). Any other path is plain text. A `FileRef` to such a path renders as plain text with its location still readable, for example "Other doc (docs/other.md:3)", and is not a button. `OpenUiBlock` takes a required `canOpenFile` prop, and the chat passes it from the same PR file list that prose and answers use. The block normalizes the path once (`normalizeFileRefPath`: trim, backslashes to `/`, leading `./` removed) and uses that value for the check and the click. If opening a PR file fails, an alert says "Couldn't open the file". |
| Follow-ups | A follow-up button in a block puts its text in the composer after what is already there. The reviewer decides whether to send. |
| Inline answer | An answer the agent sends through `render_answer` shows inline as a transcript entry. It has an author line ("Claude · answer"), the title, the markdown under the strict policy, and a "Referenced files" list. No window opens by itself. |
| Open answer | Shown after the agent calls `render_answer`. It opens the answer window on request. A mermaid diagram in an answer renders only there. |
| Header buttons | Start when idle, Stop while running, Restart after the session stopped or failed. |

### What ends a session

| Event | Result |
| --- | --- |
| Stop | The session ends and the chat reads "Stopped." |
| The process exits | The chat shows the reason (with up to 4 KiB of stderr) or "Claude exited (code)." and offers Restart. Tools still running show Stopped. |
| Provider or model change | The chat returns to the Start gate. It never launches a new session. |
| PR change (different PR, base or head) | The old session ends so another PR cannot inherit its context. |
| Leaving the Chat surface | The session ends. |
| App exit or page reload | The native side stops every chat process. |

Selecting a different diff file does not restart the session.
Collapsing the panel does not end it either, because collapsing is CSS only (`.collapsed .content { display: none }`) and the chat is mounted inside that same `.content`.
The new context is pushed to the native side, coalesced to one update per 150 ms.

### AI pane width

The AI pane has no maximum width (a request of 2026-11-13).
It may be dragged over the review, and the change has three parts:

1. The drag limit is the window width minus the 6 px handle (`clampCodexWidth` in `usePanelSizes.ts`), so the handle always stays on screen and the pane can be dragged back.
2. The review shell clips (`overflow-x: clip` in `AppShell.module.css`), and its minimum width is 0 (`data-pane-min-width={0}`), so a wide pane covers the review without sticky headers painting over the handle.
3. The graph and tray widths are fitted at render time (`fitSidePanesToWindow`) and are not stored fitted. A wide pane no longer overwrites the saved side widths, and they come back when the room does.

Measured in the desktop app (run 3, 2026-11-13): the separator had `aria-valuemax` 1506 at `innerWidth` 1512.
Shift+ArrowLeft stepped the pane 390 to 1430 in 40 px steps.
At 1430 the shell was 76 px wide and clipped, hit tests on the handle and on the pane edge returned the right element, and the transcript had 0 px of sideways overflow.
After Shift+ArrowRight back to 390, the graph, diff and tray widths were 220, 664 and 220 again, the same as before the drag.
The test `lets_the_codex_pane_be_dragged_over_the_review_and_keeps_the_saved_side_pane_widths` in `AppShell.codexSafeProfile.test.tsx` guards it.
There was no screenshot of this run, because the app window sat behind another window.

## How a reply is rendered

The chat does not hand the whole reply to OpenUI.
It splits the reply into segments itself, in `splitMessageSegments`.

Why: OpenUI's parser drops prose that sits outside fences, and it does not check the fence tag.
In the spike an earlier ```python block was merged into the program.
So the app finds the blocks and passes only the body of each one to the renderer.

| Segment | How it is drawn |
| --- | --- |
| Prose | The app's own `MarkdownContent` in `inline` variant with the `strict` URL policy (see Safety). Other fences such as `ts` or `mermaid` stay in the prose and show as ordinary code blocks. A `mermaid` fence is not rendered as a diagram in the chat. |
| A fence tagged exactly `openui-lang` | `OpenUiBlock`, lazy loaded. Only the fence body is passed. |
| An `openui-lang` fence still open while streaming | The block renders what has arrived. |
| A fence line that may still grow into an `openui-lang` opener, at the end of a streaming reply | Held back until its newline arrives, so it does not flash as an empty code block. |
| A fence nested inside another fence | Stays prose. |

If a block cannot be shown, the chat shows its source with the note "This block could not be shown."
Reply text is read only from streamed `text_delta` events.
The finished `assistant` line and `result.result` repeat the same text, so reading them too would print every reply twice.

### Layout

The chat lives in a panel the reviewer drags between about 240 and 1000 px wide, or down to 220 px tall.
The source of truth is the top comment of `AiChatSurface.module.css`.

| Rule | How |
| --- | --- |
| Container, not viewport | The chat section is a named size container, `ai-chat`. Adaptations are container queries on it, with no viewport media queries. No resize listener sets React state. |
| Two named breakpoints | Narrow, under 280 px wide: the decorative "Prompts" caption goes and the chips get the whole row. Short, under 300 px tall: the prompt strip and the composer compact so the transcript keeps the rest. |
| Wide content | Tables and code scroll inside their own box. `FileRef` buttons size to their content. |
| Text measure | Prose and user text are capped at `--prose-measure: 58ch`, about 75 characters on the widest line. It was measured in the desktop WKWebView on 2026-11-12, where 64ch gave about 84 characters. |
| Scroll position | A `ResizeObserver` on the transcript only writes `scrollTop`, so a drag causes no React render. It keeps the bottom pin, or the entry that was at the top of the view, across a resize. It is done by hand because WebKit has no CSS scroll anchoring. |
| `content-visibility` | Left out on purpose. It would replace off-screen heights with estimates and break the scroll anchor. This is a design note recorded here, not in the code. |
| Tables | `SafeTable` (`reviewDataComponents.tsx`) uses OpenUI's plain `Table`. Text cells wrap with a 16ch minimum, and number cells stay on one line, right-aligned. `ScrollableTable` is not used, because it sets an inline `width: max-content` once it overflows, which unwraps every cell again. |
| Bar charts | Names that OpenUI's chart would cut get the app's own horizontal bars instead (see "Bar charts with long labels"). |

### The component set

The library is OpenUI's stock library cut down to code review, plus the app's own `FileRef` and the diagram components.
Every image and media component is removed.

| Group | Components |
| --- | --- |
| Layout | `Stack` (the root), `Tabs`, `TabItem`, `Accordion`, `AccordionItem`, `Steps`, `StepsItem`, `Separator` |
| Content | `Card`, `CardHeader`, `TextContent`, `Callout`, `CodeBlock`, `FileRef` |
| Tables | `Table` (column oriented), `Col` |
| Charts | `BarChart` (vertical, or horizontal bars for long labels), `Series`, `PieChart` |
| Lists and tags | `ListBlock`, `ListItem`, `TagBlock`, `Tag`, `Icon` |
| Buttons | `Buttons`, `Button` |
| Diagrams | `Diagram`, `DiagramNode`, `DiagramEdge`, `DiagramGroup`, `SequenceDiagram`, `SequenceParticipant`, `SequenceMessage` (see "Diagrams in chat") |

`TextContent`, `Callout`, `Steps`, `StepsItem`, `ListBlock`, `ListItem` and `Button` are replaced by safe versions in `reviewComponents.tsx`.
They drop markdown images and route links through the https-only opener.
`Callout` has no auto-dismiss, so a finding does not vanish.
A `Button` or list item that opens a URL shows the target host in its label.

`FileRef(path: string, line?: number, label?: string)` is a component the stock library does not have.
It renders a button that opens the file in the diff viewer.
A line that is not a positive integer is treated as no line.
The agent is told to use `FileRef` for every file location inside a block.

The agent is taught this library by the review UI prompt (see the integration notes).
The prompt tells it to write prose by default and to use a block only when a diagram, table, chart, steps list or grouped file list makes the answer clearer.
Each block must be a complete program with its own `root = Stack(...)`.

### Bar charts with long labels

OpenUI 0.18.6 cuts long x-axis labels at the end inside its own chart, and the app found no way to change that.
In run 3, 4 of 6 file names ended in "…" at panel widths 320, 390 and 640 px, and the first label was cut hardest.
The rule now is that `BarChart` keeps OpenUI's vertical chart only for names it shows whole.
Anything else gets the app's own horizontal bars (`components/chart/HorizontalBarChart.tsx`), plain HTML and CSS, with the full name on its own line above each row.

The thresholds come from a measurement in the app's webview at a 240 px block:

| Case | What was seen |
| --- | --- |
| Labels up to 6 characters, up to 10 categories | Uncut |
| 7 characters at 10 categories | The first label is cut |
| 8 characters at 8 categories | The first label is cut |
| More than 10 categories | Some labels are left out entirely |

So the horizontal form is used when the longest label is over 6 characters, or when there are more than 10 categories.
Every value is printed and each value names its series, so colour is never the only cue.
Both forms show a caption from `xLabel` and `yLabel`, written "<yLabel> by <xLabel>" when both are given, and the one that is given when only one is.
What the horizontal form does not do: a `stacked` variant draws as grouped, because the variant is not passed on.

## Diagrams in chat

The ask (2026-11-13): since a PR review is mostly about the system, the agent should show a diagram in the chat, summarizing what the PR changes, because visual information is easier to review.
The visual reference was [github.com/cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design).

### The ruling: the agent sends data, the app draws

The agent never writes SVG, HTML or coordinates.
It describes nodes, edges, groups and what the PR did to each.
The app lays out the diagram and draws it.

Agent-written SVG was rejected for these reasons:

- Agent-written markup is the same class of hole that got mermaid removed from the chat.
- It cannot follow the app theme.
- It cannot link to a PR file.
- A small model such as `haiku` places coordinates badly.

What was taken from the reference, and what was not:

| Taken | Not taken |
| --- | --- |
| Its visual language: a 4 px grid, borders and no shadows, rounded rectangles, orthogonal elbow edges, small uppercase mono labels, a legend strip at the bottom | Its hex colours, which are replaced by the app's design tokens |
| Its change vocabulary from the "architecture delta" type: added, removed and changed | Google Fonts, the app's own sans and mono stacks are used |
| The rule to delete before adding: few nodes, and above 8 nodes it is two diagrams | Hand-written SVG as the output format |
| | Its Before, Changes and After layout in three panels at 960 px, because a chat pane is 280 to 1000 px |

The reference draws three panels.
The chat draws one merged topology, the union of before and after, with a status on each object and a text ledger under it.
One layout keeps the mental map stable by construction.

### The seven components

OpenUI Lang arguments are positional, and optional arguments come last.
`?` marks an optional argument.

| Component | Arguments |
| --- | --- |
| `Diagram` | `title`, `nodes`, `edges`, `groups?` |
| `DiagramNode` | `id`, `label`, `change?`, `note?`, `path?`, `kind?` |
| `DiagramEdge` | `from`, `to`, `label?`, `change?` |
| `DiagramGroup` | `label`, `nodeIds` |
| `SequenceDiagram` | `title`, `participants`, `messages` |
| `SequenceParticipant` | `id`, `label`, `change?` |
| `SequenceMessage` | `from`, `to`, `label`, `change?`, `reply?` |

What the arguments mean:

| Argument | Meaning |
| --- | --- |
| `change` | `added`, `removed`, `changed` or `unchanged` (the default). A rewired relationship is one removed edge plus one added edge. |
| `note` | What changed, in a few words. It is shown in the ledger, not in the node. |
| `path` | The repo-relative path of the PR file behind the node, as a string or as a `FileRef`. It opens only when the host can open it (a PR file), after the same path normalization as `FileRef`. |
| `kind` | `component` (the default), `store` or `external`. |
| `reply` | `true` draws the message as a return line. |

To skip a middle optional argument, the agent writes `null` (the prompt example does this for `DiagramNode`).

### How status is encoded

Status is never colour alone.
Each status has a badge, a stroke and a dash pattern, and kinds differ by shape.

| Status or kind | Badge | Stroke | Dash |
| --- | --- | --- | --- |
| added | `+` | `--added`, width 1.2 | solid |
| changed | `Δ` | `--modified`, width 1.2 | solid |
| removed | `−` | `--deleted`, width 1.2 | dashed `5 4`, muted name |
| unchanged | none | the quiet default border | solid |
| a reply message | none of its own | its status stroke | dotted `1 3`, so dashed keeps meaning removed and `3 3` keeps meaning lifeline |
| `store` kind | | | a rim line under the top edge, like a cylinder lid |
| `external` kind | | | a double border with square corners |

Node outlines use `color-mix(in srgb, var(--muted) 80%, var(--panel))` (`--node-outline`).
Computed contrast is 3.49:1 against the node fill and 3.27:1 against the group fill in the light theme, and 4.08:1 and 4.52:1 in the dark theme.
Before, the outline used `--border`, which gave 1.36 to 1.73:1.

Colours come only from the app tokens (`--added`, `--modified`, `--deleted`, `--border`, `--accent` and the like), so light and dark follow the app theme with no second variant.
A legend strip at the bottom of the SVG lists only the statuses that are present.

### The ledger

Under the picture there is real HTML with the heading "Changes".
It has one row per object whose change is not `unchanged`, nodes first, then edges as "A → B".
A row has the status word (ADDED, REMOVED or CHANGED), the name, the note, and a file link when the path is openable.
The ledger is also the text alternative of the picture, and it shows the full edge label.

### Layout and sizing

1. The flow layout runs in ELK, in a worker (`workers/runElkGraphInWorker.ts`), never on the main thread. Groups are compound nodes. Sequence diagrams use plain arithmetic and no ELK.
2. The direction follows the block's own inline size: top-to-bottom under 720 px and left-to-right from 720 px, with a band of 16 px each way so a drag across the line does not flip back and forth.
3. If left-to-right would have to scroll at this width, the top-to-bottom layout is shown instead.
4. There is one layout cache per diagram, keyed by direction. At most two layout runs happen however the width moves, and a ready layout is shown while the wanted one runs.
5. The SVG scales with CSS only. It shrinks with its block down to 80% of its natural width and never grows past 100%. Below 80% it scrolls sideways inside its own block, with the hint "Scroll sideways to see the whole diagram →". The transcript keeps 0 px of sideways overflow.
6. While the reply streams, nothing is measured or laid out. A placeholder of 240 px stands where the picture will be, and the layout runs once when the block is complete.
7. If the layout fails or does not answer in 5 seconds, a designed fallback shows the ledger and a plain list of relationships. It is never a blank box.

Nodes are sized to their content, between 96 and 200 px wide, and a name wraps to at most 2 lines before it is cut with "…".
The full text stays in an SVG `<title>`.
Measured at the default pane (a 330 px block), in Chromium (Orca's embedded browser) and not in the WKWebView:

| Diagram | Natural width | Scale | Scrolls? |
| --- | --- | --- | --- |
| A 6-node flow | 410 px | 0.80 | no |
| A 3-participant sequence | 399 px | 0.83 | no |
| A 4-participant sequence | 563 px | below 0.80 | yes, with the hint (its four header boxes alone are about 444 px) |

These numbers come from the engineer's browser measurements, and I did not re-measure them.

Edge labels wrap between words and after "/" and "-", into lines about 60 px wide, never narrower than their longest piece.
A changed edge's badge sits above its label, inside the label box, so ELK reserves room for it.
The measured reason is width: the same flow was 376 px wide without edge labels, 497 px with one-line labels, and 410 px with wrapped labels.
In the top-to-bottom layout width runs out and height is cheap, so the badge goes above and not beside.

### Limits and tolerance

| Limit | Taught to the agent | Hard render cap |
| --- | --- | --- |
| Nodes in a `Diagram` | 8 | 16 |
| Edges in a `Diagram` | 10 | 24 |
| Participants in a `SequenceDiagram` | 5 | 8 |
| Messages in a `SequenceDiagram` | 12 | 24 |
| Edge label in the picture | 14 characters | 14 characters, the full label stays in the ledger and the fallback |
| Message label in the picture | not stated in the prompt | 40 characters, the full text is in the title and the ledger |

Past a cap the diagram draws the first N and shows a visible line such as "Showing 16 of 23 components".
Nothing is dropped silently.

Every agent string is cut to a hard character budget in the readers, before anything measures it, with bidi controls stripped:

| String | Budget (characters) |
| --- | --- |
| `id` | 80 |
| `title` | 160 |
| `label` | 120 |
| `note` | 240 |
| `path` | 512 |

The tolerance rules, which the readers apply:

- An edge to an unknown id creates a plain node with that id as its label. Past the edge cap, no node is created for an endpoint named only by capped edges.
- A duplicate id keeps the first node.
- A group member that does not exist is ignored.
- An unknown `change` or `kind` falls back to the default, and a capitalised `Added` still counts.
- Layout ids are never taken from agent ids, so an id like `group-0` cannot hide a node.
- The schemas are lenient on purpose. OpenUI drops a whole component when a required field is null or of the wrong type, before the readers can apply their rules.

### Accessibility

- The SVG is `role="img"` when no node can be opened. When a node can be opened, it is `role="group"` with the same `aria-labelledby`, and each openable node is a focusable button.
- Both have a `<title>` and a generated `<desc>`, such as "6 components, 7 relationships. 1 added, 1 changed, 1 removed.", followed by every component or participant name in full.
- An openable node is operable with Enter and Space and has an `aria-label` such as "Orders API, open src/api/orders.ts". A node whose path is not a PR file is not focusable.
- Every id inside the SVG (title, desc, markers) is unique per instance.
- A scrolling diagram is a focusable region labelled "Diagram, scrolls sideways".

### Where the code lives

| Folder or file | What is in it |
| --- | --- |
| `apps/web/src/entity/diagram/` | The diagram model, the readers with their caps and tolerance, the node and edge sizing, the ledger. Pure code, no React, no OpenUI. |
| `apps/web/src/utils/diagram/` | Generic geometry: text metrics, the ELK graph reading, orthogonal paths, sequence arithmetic, the layout direction rule. |
| `apps/web/src/workers/runElkGraphInWorker.ts` | The worker runner for ELK. |
| `apps/web/src/components/diagram/` | `DiagramView`, `SequenceDiagramView`, the SVG parts, the layout hook and the CSS module. No OpenUI import. |
| `apps/web/src/components/openui/reviewDiagramComponents.tsx` | Only the `defineComponent` wrappers. They hand the parsed props to the views. |
| `apps/web/src/components/openui/reviewLibrary.ts` | The library registration, the component group and the prompt rules. |
| `apps/web/src/components/chart/` | The horizontal bar chart. |

The layout function is injected into the views, with the worker as the default, so tests run without a Worker.

### Where diagrams are drawn

Diagram blocks are drawn only in the chat reply.
Inside a `render_answer` answer, an `openui-lang` block shows as plain code.
The chat prompt (`createChatInitialPrompt`) says so, and tells the agent that Mermaid is not rendered and that it should draw a `Diagram` or `SequenceDiagram` block instead.

The chat has one extra prompt shortcut, "Diagram changes" (`CHAT_PROMPT_SHORTCUTS`).
It asks for one diagram of what the PR changes, marked as added, changed and removed, drawn in the chat reply and not through `render_answer`, then at most five short bullets with clickable file locations.
The terminal does not get this shortcut.
Like the others, it only fills the composer.

The prompt rule for summaries tells the agent to lead with one `Diagram`, to use components and not one node per file, and to give each changed node a note.
The review UI prompt is limited to 14,000 characters by `reviewUiPrompt.test.ts` (it was 12,000 before the diagrams).
Its size is 13,991 of 14,000 characters (main session, 2026-11-13), so there is almost no room left.

### Does a real agent draw a good diagram?

The method (2026-11-13):

- The real Claude CLI (2.1.322) was run with the chat's exact argv, taken from `claude_chat_command` and `claude_safety_profile`, and with the chat's exact prompts, taken from the code (`buildReviewUiPrompt()`, `createChatInitialPrompt(...)` and the "Diagram changes" shortcut).
- The PR was wisesight/analytics-suite #1424, in its linked checkout, which was left untouched (`git status --porcelain` was empty before and after).
- A fresh process ran each time. Turn 1 was the initial prompt, and turn 2 was the diagram shortcut.
- Each turn-2 reply was split with `splitMessageSegments`, and each fence was rendered through the real `OpenUiBlock`, with ELK in-process.
- Statuses were checked against the base commit, with `git diff` and `git grep` at base.
- The one difference from the app: `--mcp-config '{"mcpServers":{}}'`. The app's `pr_visualizer` server only exists in the running app, so `get_pr_context`, `get_current_file` and `render_answer` were not available and not exercised.

Rounds in numbers (round 1 had 3 `haiku` runs and 1 `sonnet` run, rounds 2 and 3 had 4 `haiku` runs and 2 `sonnet` runs, and round 4 had 2 of each):

| Measure | Round 1 | Round 2 | Round 3 | Round 4 |
| --- | --- | --- | --- | --- |
| Runs with a diagram | 3 of 4 | 6 of 6 | 6 of 6 | 4 of 4 |
| Denied shell commands | 3 | 0 | 0 | 1 (the run carried on) |
| Runs that gave up after a denial | 1 | 0 | 0 | 0 |
| Wrong statuses in total (per diagram) | 5 (1.7) | 5 (0.8) | 2 (0.3) | 2 (0.5) |
| Wrong statuses that invent a change on untouched code | 4 | 0 | 0 | 0 |
| The new handler call to `ToFilter` right, `haiku` | 1 of 2 drawn | 2 of 4 | 4 of 4 | 2 of 2 |
| The new handler call to `ToFilter` right, `sonnet` | 0 of 1 | 1 of 2 | 0 of 2 | 0 of 2 |
| Test nodes | 1 | 0 | 0 | 0 |
| Paths to files outside the PR | 2 | 4 | 0 | 0 |
| A PR node without a path | 1 | 0 | 0 | 0 |
| A missing title or label | 0 | 0 | 0 | 0 |
| Edge labels over 14 characters | 0 | 1 | 3 | 1 |
| Diagram before any prose | 0 of 3 | 1 of 6 | 1 of 6 | 2 of 4 |

Outcome of round 4, stated plainly:

- The last wording change did not fix the one remaining slip. `sonnet` still marks the handler's new call to `ToFilter` as `changed` in 2 of 2 runs, which is 0 of 4 across rounds 3 and 4. It should be `added`, because the base handler has no such call, while the function itself has existed since base.
- `haiku` made 0 status errors across its last 6 runs.
- Nothing regressed after the sentence "Always give the title and every label" was cut from the prompt. Every diagram has a title, and every node and edge has a label.
- There was one new denied command in round 4 (`git grep -n -A12 … | head -80`). The model carried on and still drew a correct diagram.
- Prompt tuning stopped here by decision.


What went wrong in each round, the sentence that caused it, and the rule that replaced it:

| Round | Mistake | Cause in the prompt | Replacement |
| --- | --- | --- | --- |
| 1 | One run drew no diagram. A command such as `git rev-parse … && … && git diff` was denied, the denial text said not to retry anything that needs approval, and the run stopped reading the diff. | Turn 1 said "fall back to git diff when sem is missing or fails", which invited `sem diff \|\| git diff` in a subshell. | Turn 1 now says to run `git diff` only as a separate second command, never joined with `\|\|`, and names the denied forms (see "Shell commands in the chat"). |
| 1 | Changes invented on code the PR did not touch (an "Action storage" node and its edge marked changed, a test node marked added). | "Set change on every node and edge the PR touched" never defined `changed`, and said nothing about tests. | Node change is defined by the diff, and tests are never nodes. |
| 1 | Paths to files outside the PR, and a PR node with no path. | The `DiagramNode` signature only said `path?: string`. | A path only for files in the PR's diff, on every node that lives in one. |
| 2 | 5 of 6 diagrams had the `ToFilter` relation wrong. Four marked the existing mapping `added`, one marked the new handler call `changed`, one `unchanged`. | "The edge to it carries the status" did not say which status. | Edge change is defined (added, removed, changed). Paths are limited to files listed by `git diff --stat`. |
| 3 | Both `sonnet` runs marked the handler's new `ToFilter` call `changed`, because the function already existed at base. | "A call or dependency that did not exist before this PR" read as "the function did not exist". | "added = this PR makes the source call or depend on the target where it did not before, even if the target already existed". |
| 4 | The same `sonnet` slip, 2 of 2 runs. | Unchanged by the new wording. `sonnet` keeps reading the label `ToFilter`, an existing function, as an existing call. | None. Tuning stopped. |

The final rule text is the summary rule in `REVIEW_RULES` (`reviewLibrary.ts`):

```
For what a PR changes, a summary or an overview, lead with ONE Diagram of the parts of the system the PR touches, then explain in prose. Nodes are components (modules, services, stores, screens, jobs), not functions, not one node per file, never tests. Node change: added = new in this PR, removed = deleted by it, changed = this PR edits its own code. A neighbour that only receives new data or a new call stays unchanged. Edge change: added = this PR makes the source call or depend on the target where it did not before, even if the target already existed. removed = this PR deletes that call. changed = this PR edits the call site itself (different arguments or data there). An untouched call that only carries a payload with more fields stays unchanged. Give each changed node a note. Set path only to a file in this PR's diff (git diff --stat), on every node whose code is in one, never to any other file, even one in the repository. Keep an untouched neighbour only if needed to read the change. At most 8 nodes and 10 edges (more is two diagrams), edge labels at most 14 characters.
```

The honest limits:

- The samples are small: 4 to 6 runs per round, on one PR.
- Only `haiku` and `sonnet` were run.
- The app's MCP tools were absent. Whether a diagram ever goes into `render_answer` is untested.
- Over-long edge labels and "diagram first" were not fixed. The app cuts long edge labels, so that part is cosmetic.
- A residual error remains (see Known limits).
- These runs show that the diagrams parse and draw, and that the statuses were mostly right. They are not a proof for other PRs.

### Review

Two adversarial review rounds ran over the diagram code.

Round 1 gave 12 confirmed findings, which are 8 distinct problems:

| Problem | Severity | Fix |
| --- | --- | --- |
| Long labels were measured before they were cut, so a long unbroken word froze the main thread (a 4,000-character word took about 9 to 10 s) | high | Every agent string has a character budget in the readers, and the wrap is linear |
| An agent node id such as `group-0` collided with an internal group id, so the node was not drawn and the group zone moved (reported three times) | medium | Layout ids are never taken from agent ids |
| OpenUI's strict schemas dropped a whole node, message or diagram on a typo, such as a null label or `Added` | medium | The schemas are lenient and the readers apply the tolerance |
| The top-to-bottom layout cache was thrown away on every resize back to wide, so ELK ran again each time (reported three times) | medium | One cache per diagram keyed by direction, at most two runs |
| The prompt asked for `FileRef` for every file, but `DiagramNode.path` took only a string, so the file link was dropped | medium | `path` accepts a string or a `FileRef`, and the prompt rule names the plain string for `DiagramNode` |
| Sequence message labels had no length cap, so the SVG width grew without bound | low | The picture cuts a message label to 40 characters, with the full text in the title and the ledger |
| Edges past the edge cap still created implicit nodes, drawn as disconnected boxes | low | No node is created for an endpoint named only past the cap |
| A diagram with zero nodes showed an empty SVG | low | A designed empty state |

Five rulings changed the contract at the same time: the SVG is `role="group"` when a node can be opened, a reply message has its own dash pattern, the `<desc>` lists names in full, an edge label keeps its full text outside the picture, and every agent string has a budget.

Round 2 checked the fixes.
11 of them held, and some tests could not fail on their own fix.
Round 2 is closed: all its items are fixed, and each has a test that goes red when that fix alone is undone.

| Item | Fix |
| --- | --- |
| A diagram that was still streaming said "This diagram has no components to draw." | The empty state shows only when the reply is complete (`isEmpty = !streaming && …`) |
| The prompt printed optional markers on `title` and the labels, but OpenUI treats them as required by position, so skipping the title dropped the whole diagram | The signatures print as exact and required, while the runtime stays forgiving. `tagSchemaId` from lang-core changes only what the prompt prints, and `.catch` supplies the default |
| `nodes`, `edges`, `participants` and `messages` were required lists | A list prop accepts a missing list or a single item |
| Values were lost silently: a numeric label, a boolean id, a string `reply`, a group written with node references | These values are kept. Any number, string or boolean is text to the diagram |
| A `FileRef` line was dropped when `FileRef` was used as a node path | The path is carried through |
| The group eyebrow overflowed its zone and the viewBox | The eyebrow is fitted with its letter spacing |
| Invisible padding ate the whole character budget, because the cut came before the strip | Leading padding is skipped first, so it cannot use the budget |
| Three tests could not fail on their own: the string budget, the id collision, and "an abort is not a failure" | Each now fails when its fix alone is undone |
| A misspelled component, such as `Diagramm`, vanished silently | The block shows the note "Part of this block could not be shown: Diagramm is not a known component." |

### Not verified yet (diagrams)

- The desktop WKWebView. Diagrams were checked only in Chromium and jsdom so far.
- `role="group"` with inner buttons in WebKit. It is untested there.
- Label placement for every graph shape.
- Whether a diagram ever goes into `render_answer`, because the app's MCP tools were absent from the agent runs.
- A real agent on other PRs. The runs covered one PR with small samples.

## Safety

The agent here reads untrusted pull requests, so the chat starts Claude with an allowlist posture.
All flags below were observed on Claude Code 2.1.322 on 2026-11-12.

### Claude flags

| Flag | Why |
| --- | --- |
| `-p`, `--input-format stream-json`, `--output-format stream-json` | One headless, long-lived process that speaks stream-json both ways. |
| `--verbose` | Required with stream-json output. Without it the CLI exits 1. |
| `--include-partial-messages` | Streams the reply as `text_delta` events. |
| `--setting-sources ""` | Loads neither user nor project settings. With `user`, the reviewer's own allow list ran `touch` without a prompt and their hooks fired. With `project`, the repository under review could ship hooks with no trust dialog. Login still works. |
| `--strict-mcp-config` and `--mcp-config <inline JSON>` | Only the app's own `pr_visualizer` MCP server, the same inline JSON as the terminal. |
| `--allowedTools mcp__pr_visualizer "Bash(sem diff *)"` | The app tools and `sem diff` run without a prompt. `sem diff` is read-only. No git rule is allowed on purpose, because a wildcard like `git diff *` would also allow `git diff --output=<file>`. |
| `--disallowedTools Edit Write NotebookEdit` | Removes the editing tools. |
| `--permission-mode manual` | Prompt on first use. It is explicit because newer CLIs start in `auto` mode. |
| `--permission-prompts none` | There is no approval UI in this cut, so anything that needs approval is denied. |
| `--tools Bash,Read,Grep,Glob` | An allowlist of built-in tools. It leaves the app's MCP tools alone. The CLI accepts an unknown name in `--tools` without an error, so the proof is the `init.tools` list, which the ignored real-CLI test asserts. See the before and after below. |
| `--disable-slash-commands` | Took slash commands from 55 to 0 and skills from 19 to 0. |
| `--model <m>` | Only when the reviewer picked a model. |
| `--append-system-prompt <text>` | Only when not empty. It carries the review UI prompt. |

| Environment change | Why |
| --- | --- |
| Remove `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` | An app started from inside a Claude Code session still gets an independent session. |
| Remove `CLAUDE_CODE_PLUGIN_DIRS` (chat only) | A plugin directory in the environment loads plugins and their hooks, and `--setting-sources ""` does not cover it. The terminal keeps the reviewer's own setup. |
| Set `PR_VISUALIZER_RENDER_SOCKET` and `PR_VISUALIZER_RENDER_TOKEN` | Lets the MCP helper reach this session's answer window. |
| Working directory is the linked repository root | The agent reads the PR checkout. |

The process runs in its own process group, so stop can end the whole group.

### What the agent can and cannot do

- Read-only `git` (`git diff`, `git show`, `git log`) and `sem diff` run.
- Anything that needs approval is denied. In the live check, `touch` was denied and the file was not created.
- The chat shows each denial and cannot approve it. There is no approval UI yet.
- The agent cannot edit files, because the editing tools are removed.
- The tool allowlist is `Bash`, `Read`, `Grep`, `Glob`, plus the six app MCP tools of `pr_visualizer`.

Before and after the allowlist, from the live `init` line (2026-11-12):

| | Before | After |
| --- | --- | --- |
| Built-in tools | 21, including `Task`, `Workflow`, `SendMessage`, `RemoteTrigger`, `CronCreate`, `PushNotification`, `Skill` and `WebSearch` | `Bash`, `Glob`, `Grep`, `Read` |
| App MCP tools | not recorded | the 6 `mcp__pr_visualizer__*` tools, and `mcp_servers` shows `pr_visualizer` as `connected` |
| Slash commands | 55 | 0 |
| Skills | 19 | 0 |

Shell commands in the chat, observed with the chat's flags on 2026-11-13 (`chain-probe/observed.txt`, a throwaway repo):

| Command form | Result |
| --- | --- |
| `git diff HEAD~1 --stat` | allowed |
| `git diff HEAD~1 --stat \| head -5` | allowed |
| `git log --oneline -1 && git diff HEAD~1 --stat` | allowed |
| `git diff HEAD~1 --stat \|\| git status` | allowed |
| `git log --oneline -1` then `git diff HEAD~1 --stat`, joined by a semicolon | allowed |
| `git diff HEAD~1 --stat 2>&1` | allowed |
| `git diff HEAD~1 -- . ':(exclude)c.txt'` | allowed |
| `(git diff HEAD~1 --stat)`, a subshell | denied |
| `(git diff HEAD~1 --stat \|\| git status) \| head -5` | denied |
| `git rev-parse --verify -q HEAD`, alone or joined with `&&` | denied |
| `git diff -U2 HEAD~1 -- . ':(exclude)*.json'`, and the same with `\| head -50` | denied |

So `&&`, `||` and a semicolon between read-only commands were not denied.
The denied forms were a subshell, `git rev-parse` and `git diff -U<n>`.
Two lines in `createChatInitialPrompt` came from this:

- "Prefer sem diff … for a semantic, entity-level view of the change. Only if that command fails, run git diff as a separate second command, never joined to it with ||."
- "Some shell commands are denied in this chat without asking: subshells in parentheses, git rev-parse, and git diff with -U<n>. A denial applies to that one command only, so run a simpler read-only command such as git diff, git diff --stat, git show or git grep, and carry on."

The code comment next to the second line says `&&`, `||`, a semicolon, pipes and `2>&1` between read-only commands are allowed.

### What model text cannot do in the webview

The agent may be steered by the PR it reads, so its text gets less trust than the app's own text.

| It cannot | How |
| --- | --- |
| Make the webview load a remote URL | Prose uses the `strict` policy: no image loads (an image shows its alt text), and raw HTML images do not load either. Mermaid does not run in the chat at all (see below). In blocks, `<img>` is removed from markdown, no component loads a URL, and `Renderer` gets no `toolProvider` or `queryLoader`, so `Query` and `Mutation` cannot fetch. |
| Open a non-https link | Prose links open only when they are https. A link with any other scheme shows as plain text. In blocks, one function, `actionLinkUrl`, decides the single https URL an action may open. A non-https `@OpenUrl` opens nothing. |
| Act without a click | A link or an `@OpenUrl` button needs a click. A click arms exactly the URL the control shows, and the block opens an `open_url` event only when its URL equals the armed one, so one click opens at most that one URL. A follow-up button only fills the composer. A shortcut only fills the composer. Nothing the model writes sends a message. |
| Run its own HTML | Inline HTML in prose is stripped, the `MarkdownContent` default. |

Why mermaid does not run in the chat: mermaid parses YAML and runs its own layout.
A review showed three ways a diagram could make the webview fetch a URL past a text filter: a quoted or escaped `img` key in shape data, front-matter `config` with `fontFamily` or `themeCSS`, and `-webkit-image-set` in CSS.
So the chat does not run it.
The answer window still renders mermaid as before.
The chat prompt (`createChatInitialPrompt`) tells the agent to use an `openui-lang` block or plain text for structure.

In a block, the control shows the host of the URL it would open, in its own direction-isolated `<bdi dir="ltr">` element, with the full URL as the title.
Bidi control characters are stripped from model-written labels and link text, so a label cannot reorder the host.
Prose links under the `strict` policy follow the same rule, from shared helpers in `utils/`. An https link shows its text with bidi controls stripped, then its host in its own `<bdi dir="ltr">` element, with the full URL as the title, and the click opens exactly that normalized URL.
The default policy is unchanged.
A list item with an action renders it as a real, keyboard-operable button, disabled while the block is still streaming, like `Button`.

OpenUI's DevTools would also load remote JavaScript in development, and the Vite alias blocks that (see the integration notes).

### Containment per block

Each `OpenUiBlock` renders inside its own React root (`ContainedRoot`).
OpenUI re-renders its last good children after an error.
If a child throws from an effect, this loops until React aborts with "Maximum update depth exceeded", and no error boundary catches that.
In a root of its own, the loop is counted in `onCaughtError`.
What counts is catches since the host last rendered new children, with no timer.
A loop catches over and over with no new children in between, while a healthy block starts its count again at every update.
After 10 such catches the block swaps to its source fallback, so a broken block cannot take the chat down.
Once tripped, the block stays on its fallback, and the fallback keeps showing the latest source.

## Native protocol

All commands take one argument `{ request: { ... } }` in camelCase and return `Result<_, String>`.
The code is in `apps/desktop/src-tauri/src/ai_chat.rs`.
The safety profile shared with the terminal is `claude_safety_profile` in `codex_terminal.rs`.

| Command or event | Payload | Notes |
| --- | --- | --- |
| `ai_chat_start` | `{sessionId, provider, repositoryPath, model, systemPromptAppend, context}` | Returns `{sessionId}`. `provider: "codex"` is rejected with "the chat supports only Claude, use the terminal for Codex". `systemPromptAppend` is at most 64 KiB with no NUL. The session ID is 1 to 128 characters of letters, digits, hyphen and underscore. |
| `ai_chat_attach` | `{sessionId}` | Flushes lines buffered before attach, then streams live. |
| `ai_chat_send` | `{sessionId, text}` | `text` is 1 byte to 256 KiB. Rust builds the stdin line. The webview never writes raw stdin. |
| `ai_chat_interrupt` | `{sessionId}` | Rust writes a `control_request` with subtype `interrupt`. It never sends SIGINT. |
| `ai_chat_stop` | `{sessionId}` | See stop order below. |
| `ai-chat://line` (event) | `{sessionId, sequence, line}` | One stdout line, unparsed. |
| `ai-chat://exit` (event) | `{sessionId, code, error}` | `error` is null for a clean exit or a requested stop. Otherwise it carries the reason and a stderr tail of at most 4 KiB. |

The context update reuses `codex_terminal_update_context` unchanged.

An answer session has a presentation, `AnswerPresentation`, either window or inline (`codex_answer.rs`).
The terminal uses window and the chat uses inline.
The `--render-mcp` helper learns it from the environment variable `PR_VISUALIZER_ANSWER_PRESENTATION`, which is passed only for inline, so the terminal's helper environment is unchanged.
For the chat, the MCP instructions, the `render_answer` description and its result text say the answer is shown inline and must not be repeated in the reply (`app_tool_mcp.rs`).
In the chat, `render_answer` is optional, and answering in the reply is the default.
An inline answer is stored and announced as an update, and no window opens.
Events are emitted app-wide and the web side filters them by `sessionId`.

Why Rust builds the stdin lines:

- Claude exits on a malformed stdin line (observed: exit 1), so a line is never built by string concatenation.
- SIGINT ends the whole process (observed), while the stdin interrupt keeps the session.

Rust is a bounded line pipe.
It frames stdout into lines and forwards them without reading them.

| Limit | Value |
| --- | --- |
| One stdout line | 4 MiB. A longer line fails the pipe, stops the child and is reported once. It is never cut or spliced. |
| Output before the chat attaches | 8 MiB. Past that, the child is stopped and the failure is reported at attach. |
| User message | 256 KiB |
| System prompt append | 64 KiB |
| Stderr tail | 4 KiB |

Empty lines are skipped and invalid UTF-8 is converted lossily.
Send, interrupt and stop run off the main thread, and a per-session mutex keeps each stdin write whole.

Stop order, signal first:

1. Set the stop flag, then send TERM to the process group.
2. Wait 250 ms, then send KILL to what is left, and wait up to 1 s more.
3. Close stdin without waiting on its lock.

The order matters.
A send blocked on a full stdin pipe holds the stdin lock, and only ending the child releases it.
Waiting for the lock first would hang stop and shutdown.
The exit watcher also ends the process group after Claude exits, so descendants cannot keep the pipes open and the exit event always arrives.
The session is removed and its answer socket revoked before the exit event is emitted, so a UI that restarts on exit can reuse the session ID.

On Windows, the stop path calls `kill` on the child.
That path is not verified (see below).

## OpenUI integration notes

Only `apps/web/src/components/openui/` imports `@openuidev/*`.
The rest of the app imports the wrapper (`OpenUiBlock`, `buildReviewUiPrompt`) and never the library.
The one other mention is the DevTools stub below.

- **Lazy loading.** Building the review prompt imports the component library, so the large lazy chunk (`reviewLibrary-*.js`) loads when the chat starts, not at the first block. Only `OpenUiBlock` (loaded with `React.lazy`) and its stylesheet load at the first block. Everything stays outside the eager entry chunk.
- **Measured size** (final production `vite build` with the repo config, minify off, 2026-11-12, after the last changes). The eager entry chunk `index-*.js` is 2,919,622 B raw and has 0 occurrences of `@openuidev`, `createLibrary` and `jsdelivr`. The lazy files are listed below. No file in the build output contains `jsdelivr`.

| Lazy file (production build) | Raw | Gzip |
| --- | --- | --- |
| `reviewLibrary-*.js` (shared by the block and the prompt) | 3,155,991 B | 680,616 B |
| `OpenUiBlock-*.css` | 365,441 B | 39,466 B |
| `OpenUiBlock-*.js` | 7,721 B | 2,515 B |
| `reviewUiPrompt-*.js` | 583 B | not recorded |
| `reviewLibrary-*.css` | 2,733 B | 1,183 B |

- **Packages** in `apps/web/package.json`: `@openuidev/react-lang` 1.1.0, `@openuidev/react-ui` 0.18.6, `@openuidev/react-headless` 0.18.6 and `zustand` 4.5.5. Only `react-lang` and `react-ui` are imported in `src`. `react-headless` and `zustand` are declared explicitly because `react-ui` needs them as peer dependencies, and nothing in `src` imports them directly. pnpm reports an unmet peer: `use-sync-external-store@1.2.2` (pulled in by zustand 4.5.5) wants React 18 or older, and the app has React 19.2.7.
- **Imports.** The library is imported from the `@openuidev/react-ui` root and not from the lighter `@openuidev/react-ui/genui-lib` subpath. The subpath bundles its own copy of the theme context, so its components would not see the app's scoped `ThemeProvider`.
- **Theme.** `ThemeProvider` is scoped to the block container with `cssSelector`, and `APP_TOKEN_THEME` maps OpenUI theme keys to the app's design tokens. The stylesheet `@openuidev/react-ui/styles/index.css` is 363,218 B (38,549 B gzip) and its only unprefixed selectors are the `.text-content` family, which the app does not use.
- **DevTools alias.** In development, `react-lang` auto-mounts `@openuidev/devtools`, which imports its UI from `cdn.jsdelivr.net` at run time. Remote JavaScript must never load into the Tauri webview. `vite.config.ts` aliases the package to `src/utils/openuiDevtoolsStub.ts`, a component that renders nothing. Observed: without the alias the dev pre-bundle contains the jsdelivr URL, with it no dep file does. An empty `div[data-openui-devtools-auto-mount]` is still added to the page in development.
- **pnpm `allowBuilds`.** `pnpm-workspace.yaml` has `'@openuidev/lang-core': false`. Its postinstall only sends install telemetry, so it stays off. Without an explicit entry, pnpm fails every install with `ERR_PNPM_IGNORED_BUILDS`, and `pnpm --filter` commands fail with it.
- **Prompt size budget.** The prompt is sent with every chat session. `reviewUiPrompt.test.ts` fails if it reaches 12,000 characters. The final prompt is 10,551 characters (from the test run), under that budget. In the spike, the full stock prompt was 37,073 characters. `reviewLibrary.ts` builds its own component groups and preamble, because the stock notes and examples still mention removed components such as `Form`, `Modal` and `LineChart`.
- **Tests under jsdom.** Table and charts need `ResizeObserver`, `matchMedia` and canvas stubs, or OpenUI's element boundary loops. They live in `apps/web/src/test/openuiJsdomPolyfills.ts`, imported only by the tests that render OpenUI.

## How it is verified

Web tests run with `pnpm --filter @pr-visulizer/web test`.
They assert the promises the chat makes.

Results of 2026-11-13, verified by the main session after the diagram work:

- Web typecheck is clean.
- Web tests: 936 passed and 2 failed, in 144 files. Both failures are in `src/hooks/useDiffViewSettings.test.ts` (`window.localStorage` is undefined under Node 26) and are unrelated to this change.
- Production build: the eager entry chunk has 0 matches for `@openuidev`, `createLibrary`, `DiagramLayoutContext`, `TEXT_BUDGETS`, `HorizontalBarChart` and `tagSchemaId`. The lazy `reviewLibrary` chunk is 3,236 kB raw and 699 kB gzip.
- The review UI prompt is 13,991 of 14,000 characters.
- `cargo test` was not re-run since 2026-11-12, because no Rust change has been made since.

Results of 2026-11-12, run by the main session before the diagram work:

- Web tests: 846 passed and 2 failed (the same two). Prettier was clean on all 51 touched web files.
- `cargo fmt --check` was clean.
- `cargo test`: 119 passed and 2 ignored. The two ignored tests need the real Claude and Codex CLIs.
- The ignored real-CLI test passed three times on the `haiku` model.
- Three review rounds were run over the chat change, with 29, then 10, then 6 confirmed findings. All were fixed, and the last round had none rated high.
- The build sizes in the table of the integration notes were measured then, and they do not include the diagram code. The 2026-11-13 chunk figures above replace them.

- **Wire format against captured fixtures.** `claudeStreamEvents.test.ts` runs real captured stdout lines (`text-turn`, `tool-turn`, `denied-turn` and a four-turn capture with a denial and an interrupt) through the parser. It checks that text shows once, tool rows go Running to Done, a denial shows one notice, an interrupted turn ends as interrupted and the next turn still answers.
- **Splitting.** `messageSegments.test.ts` covers prose and fences in order, other languages kept as prose, the exact tag only, an open fence while streaming, and CRLF.
- **The surface.** `AiChatSurface.test.tsx` covers the Start gate, Enter and Shift+Enter, IME Enter, Interrupt, shortcuts that prefill and never send, follow-ups that land in the composer, the file jump, PR and model change, Stop reading "Stopped.", Restart, the denial row and notice, a block that fails to load, and the strict policy (no image, https-only links, mermaid stays a code block). `AiReviewPanel.chat.test.tsx` covers the switch: Chat shows Start and never starts a session, and going back to Terminal stops a running chat.
- **Blocks.** `OpenUiBlock.test.tsx`, `OpenUiBlock.containment.test.tsx` and `blockActions.test.ts` cover rendering, partial blocks, `FileRef`, follow-ups, https-only links, one URL per click, dropped images and the effect-throw containment.
- **Native.** Rust unit tests cover framing, limits and the pipe. `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml ai_chat` runs them.

The real-CLI test is ignored by default because it needs the installed Claude CLI, a logged-in user and network.
Run it with:

```
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml real_claude -- --ignored --nocapture
```

It starts a real chat with `haiku` through `start_chat`, runs four turns, then stops the chat:

1. A plain answer streams text and carries the appended system prompt.
2. A shell write (`touch`) is denied and the file is not created.
3. An interrupted turn ends as `error_during_execution`.
4. The next turn still answers, so the session survived.
5. After Stop, the exit event has no error and no process of the chat is left.

It also checks the `init` line: only the allowlisted built-in tools and `pr_visualizer` tools, no slash commands, no skills, and only built-in plugins.
If `target/debug/pr-visualizer` is built, it also checks that the MCP server is `connected` with its tools listed.
Set `AI_CHAT_CAPTURE_PATH` to write the raw stdout lines of the run to a file.

### Real desktop runs

The chat was run in the desktop WKWebView on 2026-11-12, on PR wisesight/analytics-suite #1424 with the `haiku` model.
These are observations from scripted runs by the main session.
The scripts are not part of the repository.

Run 1 had 16 checks, and 14 passed:

- Start reached running in 2.4 s, and the first text came in 10 s.
- A real OpenUI table with `FileRef` buttons rendered and followed the theme.
- A `FileRef` click jumped the diff.
- A shortcut appended to typed text without sending.
- Interrupt ended the turn, and the session kept answering.
- A `touch` was denied. The row read Denied, the notice appeared once, and no file was created.
- The agent listed exactly Bash, Glob, Grep, Read and the six `mcp__pr_visualizer__*` tools.
- `get_current_file` named the open file.
- A link showed its host, no `<img>` existed, mermaid stayed code, and nothing was fetched from outside localhost.
- Enter sent, and a repeated Enter did not.
- There were no chat console errors.
- The two failures were one layout bug. A message with an OpenUI table was 814 px wide and scrolled the transcript sideways by 468 px at the default 390 px panel.

Run 2, after the responsive pass and inline answers:

| Check | Result |
| --- | --- |
| Sideways overflow of the transcript | 0 px at 240, 280, 320, 390, 480, 640, 800 and 1000 px (baseline before the fix: 618, 578, 538, 468, 378, 218, 58 and 0 px) |
| Controls outside the chat | None at any width |
| Chart refit after a resize | About two frames |
| Bottom pin | Held at every width |
| A paragraph in the middle of a long message | Moved 0 px across 390, 640, 280 and 390 px |
| A 24-step drag with a table and a chart on screen | No frame over 34 ms, longest 19 ms |
| `CSS.supports` in the page | True for `container-type: size`, `1cqb`, `fit-content` and `:has()` |
| Inline answer | Showed with no window, Open answer worked on request, and a path outside the PR was plain text |

Run 3 did run, on 2026-11-13, on the same PR with `haiku` in the dark theme.
The window stayed at `innerWidth` 1512 and `innerHeight` 916 the whole run, and the screen did not lock.
Two earlier tries on 2026-11-12 had not run, because the Mac screen locked and a locked screen suspends the WKWebView.
Nine of 10 chat turns were mine, and a hot reload restarted the chat once and re-sent the PR context.

| # | Check | Verdict | Measured |
| --- | --- | --- | --- |
| 1 | Settings row | PASS | Closed by default, one 28 px summary row, "Claude · Haiku · Terminal", then "Claude · Haiku · Chat". The surface slot top moved from 274 px to 88 px. Open, the row is 210 px. Sideways overflow was 0 at panel widths 240, 320, 390 and 640. Switching the surface inside the row mounted the chat. Opening and closing it during a running chat kept the same section and transcript. |
| 2 | Tables in WebKit | PASS | At 240, 320 and 390 px a 4-column table was 498 px wide and scrolled inside its block (177 to 327 px). At 640 px it was 577 px and fit. Transcript overflow was 0 everywhere. Cells wrapped, none were clipped, and the minimum cell width was 124.6 px (16ch). Rows are about 11 lines tall at 240 to 390 px, which is readable but long. The number-column path was not exercised, because the agent sent strings. |
| 3 | Chart labels | FAIL | 4 of 6 long labels ended in "…" at 320, 390 and 640 px. One label was outside the chart at 390 px. |
| 4 | Inline answer | PASS | Entry "Claude · answer", heading, and "Referenced files" with two buttons. Only one app was connected (no window opened). Open answer opened a second webview on request. |
| 5 | Prose cap | PASS | The widest paragraph was 455 px at 800 and 1000 px panels, about 76 characters (58ch). |
| 6 | Short panel in the stacked layout | NOT RUN | The window never went to 1100 px or less. A side-layout substitute found the settings bug below. |
| 7 | Stacked layout | NOT RUN | `innerWidth` stayed 1512 for 3 minutes of polling. |
| 8 | Regression | PASS | Prose and tool turns, a Bash turn, a denied write (Denied row, one notice, no file), interrupt (then "ok" in 2.6 s), a `FileRef` to a PR file moved the diff, a `FileRef` to another file was plain text and a click changed nothing, Stop left no process, 0 requests outside localhost. |
| 9 | Wide AI pane | PASS | See "AI pane width". |

The run found two problems, and both have been fixed since:

| Found | Fix | How the fix was checked |
| --- | --- | --- |
| Chart labels truncated | Horizontal bars for long labels (see "Bar charts with long labels") | The thresholds were measured in the app's webview at a 240 px block. I found no re-run of check 3 after the fix in the sources. |
| In a 220 px tall panel the settings `<details>` shrank to 0 px, so the summary row was gone and the settings could not be opened | The settings row no longer shrinks (`flex: 0 0 auto`), and the surface minimum gives way first in the shortest panel | Measured in Chrome at panel heights 220, 260, 300 and 420 px. **Not yet measured in the WKWebView.** |

Two other items were reported and not resolved.
Pane widths changed by themselves at about 02:13 and all three review panes ended collapsed, and the run could not tell whether that was a user drag or the old stored-fit behaviour, which is fixed now.
A hot reload restarts a running chat in development, and it re-sends the PR context.

### Not verified yet

- The Windows build was not compiled. The Windows stop path (`kill`) was not compiled or run.
- The stacked layout (window 1100 px or narrower), and the short panel inside it. The window stayed at 1512 px in run 3.
- The settings row fix for a 220 px panel, in the WKWebView. It was measured in Chrome only.
- Whether an https link really opens on click was not exercised in the app.
- Diagrams, the horizontal bar chart and the settings row fix in the desktop WKWebView (see "Not verified yet (diagrams)"), and `role="group"` with inner buttons in WebKit.
- The app's MCP tools together with diagrams, for example whether a diagram ever goes into `render_answer`.
- Run 3 had no screenshots, so check 3 (chart labels) and check 9 (wide pane) rest on measured numbers only.

## Known limits and follow-ups

- No approval UI. Anything that needs approval is denied. A follow-up can use `--permission-prompt-tool`, whose wire shape was observed in a spike.
- Claude only. Codex stays on the terminal.
- No rendered mermaid diagrams in the chat. Open answer shows the report in the window, where mermaid renders. A sandboxed renderer is the possible follow-up. Diagrams in the chat come from the `Diagram` and `SequenceDiagram` components instead.
- Diagrams are drawn only in the chat reply, not inside `render_answer`.
- The horizontal bar chart draws a `stacked` variant as grouped.
- A new call to an existing function can be drawn as `changed` (amber, Δ) where it should be `added` (green, +). `sonnet` did this in 2 of 2 runs of round 4. The arrow is still marked as touched by the PR, so the reviewer is pointed at the right place with the wrong shade.
- The layout is guarded by a scripted sweep in the real app, not by unit tests, because the test environment does no layout.
- The lifecycle logic (start gate, provider and model reset, PR change, debounced context, "Stopped.") is written twice, in `CodexTerminal.tsx` and in `useAiChatSession.ts`. A change to one belongs in both until a shared hook exists.
- Built-in plugins and agents still show in the CLI session. After the hardening, `init.plugins` lists 4 built-in plugins (agents-md, telemetry, privacy, plugin-authoring) and `init.agents` names 6 agents (claude, Explore, general-purpose, Plan, statusline-setup, web-fetch), observed in the live `init` line of the real-CLI test on 2026-11-12. `--setting-sources ""` and the removed plugin directory variable do not remove them. The `Task` tool is not on the allowlist, so nothing should be able to start those agents, but that was not tested.

## Implementation references

The Claude Code flags and the stream-json wire format were observed on Claude Code 2.1.322 on 2026-11-12.
The captures are the fixtures under `apps/web/src/service/aiChat/__fixtures__/claude`.

OpenUI is at [github.com/thesysdev/openui](https://github.com/thesysdev/openui).
The OpenUI package facts above were observed on `@openuidev/react-lang` 1.1.0 and `@openuidev/react-ui` 0.18.6 on 2026-11-12.

The flag choices for the terminal are in [the terminal doc](codex-terminal.md), and the app MCP tools are in the [agent answer protocol](agent-answer-protocol.md).
