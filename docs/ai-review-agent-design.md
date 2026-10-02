# Local AI Review Agent — Combined Design

Status: historical design for the retained prompt-only review services.
The active desktop interface has been replaced by an interactive Codex terminal, authorized on 2026-10-02.
See [Embedded Codex terminal](codex-terminal.md) for the current interface and context model.
The restrictions and workflows below describe the legacy broker, not the interactive terminal.

This document combines the decisions from the design interview for adding AI-assisted pull-request review to PR Visualizer.
It extends `docs/architecture.md` and `docs/tauri-architecture.md` without changing their existing graph, ranking, diff, or GitHub review contracts.

---

## 1. Product goal

Add an optional desktop feature that helps a human review a pull request with a locally installed Claude CLI or Codex CLI.

The feature has two connected workflows:

1. A one-shot review scans the PR and produces a summary, structured findings, and Jira requirement coverage when selected Jira issues are available.
2. Scoped chat lets the reviewer ask follow-up questions about the whole PR, the current file, a selected range, or one finding.

The AI is advisory.
It never marks files as reviewed, changes the established review order, chooses a GitHub verdict, publishes comments, edits code, or writes to Jira.

---

## 2. Product boundaries

### 2.1 Desktop only

Local AI review is available only in the Tauri desktop app.
The hosted web app does not run a CLI on the server and does not use a browser helper daemon.
It may show that local AI review requires the desktop app.

Initial support is macOS.
Provider and process interfaces remain platform-neutral so Windows and Linux adapters can be added after they pass the same capability and security checks.

### 2.2 On demand

AI work starts only when the reviewer sends a chat message.
Opening a PR or receiving a new head SHA never starts AI work automatically.

### 2.3 Human authority

AI findings live in a separate advisory layer.
A reviewer may explicitly promote a finding or selected chat response into an editable local draft comment.
Only the existing human-controlled review flow may publish that draft to GitHub.

Published comments do not receive an automatic AI attribution footer.
The app keeps local provenance showing that the source was AI-assisted.

The AI does not recommend `approve`, `comment`, or `request changes`.
It reports findings, requirement gaps, and unresolved risks so the reviewer can choose the verdict.

---

## 3. Main user experience

### 3.1 AI side panel

AI chat lives in a collapsible side panel beside the existing graph, diff, and review tray.
There are no Review or Chat tabs.
The panel has compact model and context controls, a scrollable transcript, and a pinned message composer.
Assistant replies use the existing safe Markdown renderer for lists, links, and code blocks.
A live activity tail shows actual preparation and provider events with elapsed time.
It follows the latest activity until the reader scrolls up, then offers **Jump to latest**.
The current CLI returns answer text at completion, so the UI does not simulate token streaming.

Selecting a finding opens its file and line while keeping the AI panel visible.
AI risk badges may appear on files, but they do not change checkmarks, readiness, queue ordering, or the suggested-next algorithm.

### 3.2 Retained one-shot review contract

One-shot services and stored runs remain available to existing data and tests.
The current chat-only interface has no one-shot Review action or results tab.
The original one-shot contract includes:

- Provider and model.
- Review profile.
- Selected Jira issues.
- Included context scopes.
- Included instruction layers.
- Sensitive-file policy.
- Command, MCP, custom-agent, and nested-agent permissions.
- Expected coverage and active limits.
- A notice that the CLI may send repository content to its provider.

The completed review contains:

- A short PR summary.
- Structured findings.
- A requirement coverage section when Jira context was selected.
- A file coverage report.
- Run provenance and usage information.

A cached run is compatible only when its canonical review-input fingerprint matches the current request.
The fingerprint covers the base and head SHAs, diff digest, mutable PR metadata and GitHub-comment snapshots, selected Jira snapshot, prior-feedback selection and content, effective instructions, context and security policies, provider adapter and CLI versions, model, profile, prompt version, and chunking policy.
The retained service creates a new immutable record for each run.

### 3.3 Chat

The reviewer can attach one of these scopes to a message:

- Current selection.
- Current file.
- Specific finding.
- Whole PR.

Chat defaults to the selected finding when opened from a finding.
Otherwise it defaults to the current file.
Every message displays its attached scope.

There is one main PR conversation with optional focused threads created from files or findings.
A chat response becomes a formal finding only when the reviewer selects **Save as finding**.
The saved result must pass the same schema and anchor validation as one-shot findings.

A provider session is bound to a context and security fingerprint covering its revisions, disclosed source and history, instructions, provider configuration, Jira snapshot, and permissions.
The app may reuse the session only while that fingerprint remains compatible.
A revision change or any tightened context, sensitive-file, instruction, command, MCP, or agent policy forces a fresh session because information already disclosed to a model cannot be revoked.
Provider-neutral messages and context references are persisted so a lost session can be rebuilt deterministically in a fresh process.
A rebuild includes only history permitted by the new policy and labels omitted or historical context.
A rebuilt process is not presented as the same runtime session.

---

## 4. Providers and models

### 4.1 Provider contract

Claude CLI and Codex CLI implement one app-owned provider contract.
The shared workflow, safety rules, review profiles, and output schema belong to PR Visualizer.
Provider adapters handle only provider-specific process invocation, event parsing, capability checks, and cancellation.

Conceptual contract:

```ts
type AiReviewProvider = {
  id: "claude" | "codex"
  probe(configuration: ProviderConfiguration): Promise<ProviderCapabilities>
  review(input: ReviewRunInput, events: ReviewEventSink): Promise<ReviewRunOutput>
  chat(input: ChatTurnInput, events: ReviewEventSink): Promise<ChatTurnOutput>
  cancel(runId: string): Promise<void>
}
```

Provider-specific commands and flags are verified against shipped primary documentation and tested CLI versions before implementation. The Codex safe profile is the documented exception: its broker-owned fixed invocation is specified in §4.5.

### 4.2 Provider selection

One provider runs per review.
The reviewer saves a default provider and may change it before any run.
The app never silently falls back to the other provider after failure.
It offers an explicit retry with the other provider.

### 4.3 Model selection

The app provides a provider-specific model selector containing:

- **CLI default**.
- Previously saved successful model IDs.
- **Custom model ID**.

Hardcoded model catalogs are not authoritative.
The adapter validates a selected model by invoking the CLI capability path and remembers the last successful choice.

Each run records the provider, selected model, reported model when available, CLI version, prompt version, and timestamp.

### 4.4 CLI detection and authentication

A provider profile may use only broker-owned executable resolution. The Codex safe profile resolves its fixed executable from the desktop's adopted login-shell `PATH`; no webview path, executable name, or `PATH` override participates in resolution. It reports capability status and actionable setup errors without disclosing process authority to the webview.

Installation and authentication remain external to PR Visualizer.
The app never installs a CLI, performs provider login, or stores provider credentials.

Adapters define a tested compatibility contract and probe required capabilities at runtime. For the current Codex safe-profile release, that contract is exactly observed CLI `0.153.4`, the fixed help/control digest, and the fixed safe-profile revision; a newer, older, changed-help, or changed-profile executable is unavailable pending an app update. A provider is unavailable when a required core capability is missing. Optional advanced controls may instead be explicitly reported as disabled/degraded when a safe profile intentionally does not offer them.

### 4.5 Codex safe profile

The desktop **Codex safe profile** supports only user-triggered, prompt-only one-shot review and stateless scoped chat. It is not a general Codex integration: provider-neutral PR/Jira context and permitted chat history are bounded and assembled by the app, then supplied through stdin. One-shot terminal results pass the existing revision-pinned schema and anchor validation before immutable storage. A chat turn persists only provider-neutral messages; an optional finding candidate must pass the same anchor validation before it can be saved.

Rust is the only process authority. It resolves the fixed Codex executable from the adopted login-shell `PATH`; the webview never supplies or receives an executable path and cannot supply an argument list, working directory, environment, command, MCP server, tool call, schema path, or configuration path. The broker invokes only this fixed template, with a broker-generated output schema and run-owned configuration/state paths:

```text
codex --ask-for-approval never exec --ephemeral --ignore-user-config --ignore-rules \
  --sandbox read-only --json --output-schema <broker-generated-schema> \
  --skip-git-repo-check <fixed safety overrides> [--model <validated-model>] -
```

The fixed overrides disable persisted history, hooks, multi-agent delegation, shell tools, web search, MCP servers, plugins, and automatic update checks. The working directory is the broker-generated run directory, which holds only the broker's schema, configuration, and state files and never repository content; together with ignored user configuration/rules and disabled multi-agent mode it prevents repository/global rule loading, skills, and custom-agent loading. The broker filters the environment, streams only bounded sanitized JSONL events, and retains no raw stdout/stderr, environment values, broker paths, prompt, schema, logs, or state in webview diagnostics.

Availability is not controlled by a test-only runtime boolean. A capability response is available only when Rust has issued an opaque receipt for the exact `0.153.4` descriptor-derived executable identity, fixed help/control digest, and safe-profile revision. The receipt is revalidated before launch and before stdin disclosure; any replacement, version, help, or revision mismatch fails closed. The webview sees no executable path or bytes.

The broker retains the documented visible per-PR/global FIFO queue. Each request has one Rust-owned run state and one cancellation latch: `queued` → `preparing` → `active` → `terminal`. Queue dequeue and `preparing` registration are one mutex-protected transition. The latch is checked before and after receipt revalidation, run-root materialization, child spawn, durable admission evidence, and stdin delivery. `active` exists only after durable marker-owned admission and process-group liveness evidence exist; only then does Rust emit `admitted`, allowing local review/chat persistence. Every first terminal outcome is serialized through that same state machine. A pre-admission failure rejects admission without creating local content; an admitted failure/cancellation first settles admission, then is persisted only if the current UI generation still owns it.

Timeout, cancellation, output-limit rejection, and normal exit all prove owned process-group absence before liveness/root evidence may be removed. If absence cannot be proven, marker-owned recovery evidence remains rather than guessing. Bootstrap may mark a persisted admitted run interrupted only after Rust has resolved the owned group; it then acknowledges recovery so Rust can delete the terminal receipt. After these conditions, the broker removes run-owned prompt, schema, configuration, log, and state files unless app-owned diagnostics have an explicit permitted retention boundary. Cancellation remains cancelled rather than failed, and cleanup cannot weaken run invalidation or the immutable terminal-result boundary.

The following advanced capabilities are deliberately **disabled/degraded**, not fatal to Codex safe-profile availability: repository commands, MCP startup and tool calls, hooks, plugins, skills, custom agents, nested agents, web search, code editing, and automatic updates. Unsupported advanced features never receive a fallback execution path.

---

## 5. Review profiles and nested agents

### 5.1 Review focus

High-signal risks are enabled by default:

- Correctness.
- Security.
- Data loss.
- Concurrency.
- API and contract breaks.
- Material performance regressions.
- Missing tests for changed behavior.

Performance, maintainability, and style checks are configurable.
Pure style review is off by default.

### 5.2 Depth presets

The app exposes **Quick**, **Balanced**, and **Thorough** presets instead of raw token limits.
Balanced is the default.
The launch screen shows expected coverage and limits without claiming a monetary estimate that the CLI cannot support.

### 5.3 Nested agents

A provider may delegate to nested agents within preset limits only when its enabled profile can enforce those limits:

| Preset   | Maximum nested agents | Maximum depth |
| -------- | --------------------: | ------------: |
| Quick    |                     0 |             0 |
| Balanced |                     3 |             1 |
| Thorough |                     6 |             2 |

The model may use fewer agents.
Cancellation terminates the parent and all descendants.

The Codex safe profile disables nested agents and never uses this delegation table. App-owned roles and installed user-agent definitions are available only to a future enabled profile that can enforce their read-only rules, command approval requirements, and budgets. The Codex safe profile does not load, select, or execute them.

A profile that enables delegation rewrites nested-agent results into the final structured list and retains sanitized nested-agent events only as permitted diagnostics.

---

## 6. Repository context

### 6.1 Context supplied to review

The review brief includes:

- PR title and description.
- Base and head SHAs.
- Base-to-head diff.
- Changed-file contents.
- Dependency analysis and ranking data.
- Relevant unchanged callers and dependencies.
- Relevant tests and configuration.
- Existing GitHub review comments to reduce duplicates.
- Selected Jira requirement context.
- Active review and instruction policies.

Repository text, PR text, GitHub comments, and Jira content are untrusted data.
They never become safety, tool-permission, or output-format instructions.

### 6.2 Isolated snapshot

The agent never runs in the user's active working tree.
The app prepares source at the exact PR head SHA through an app-owned temporary repository area.
The source visible to the agent is read-only.

Temporary source is reused during the active PR session.
It is cleaned after an idle period.
Startup recovery identifies stale app-owned source areas and removes them only after verifying ownership, recorded SHA, and absence of a live process.

### 6.3 Sensitive-file policy

Safe defaults exclude:

- `.env*` files.
- Private keys and credential files.
- Dependency directories.
- Generated and vendored content.
- Binaries.
- Oversized files.
- Symlinks that resolve outside the prepared source root.

The reviewer can add repository-specific exclusions.
Including a detected sensitive file requires an explicit override.
The launch screen shows excluded paths.

Each repository chooses between:

1. **Hard exclusion**, which gives the agent a filtered snapshot without the Git object database plus precomputed safe Git context.
2. **Full Git history**, which keeps arbitrary Git inspection but provides only best-effort sensitive-file exclusion.

The app must state the trade-off clearly because full Git object access can reveal files excluded from the visible tree.

### 6.4 Submodules and Git LFS

Locally available submodule and Git LFS content may be used.
Any network fetch requires explicit approval.
Missing content appears in the coverage report and is never treated as reviewed source.

---

## 7. Instructions and prompt isolation

Instruction precedence is:

1. Non-overridable app safety and output rules.
2. App-owned review workflow.
3. Explicitly selected repository review rules.
4. Explicitly selected global review preferences.
5. Optional per-run focus.

Native automatic loading of repository and global instruction files, startup hooks, executable plugins, and MCP servers is disabled.
The broker builds a minimal run-specific configuration containing only app-owned rules and explicitly selected data-only instructions.
The app reads and displays selected `AGENTS.md`, `CLAUDE.md`, equivalent review rules, and custom-agent definitions before passing them as bounded review guidance.
They cannot execute during startup or change tool permissions, execution limits, context boundaries, or output schemas.

The app reads installed hook, plugin, agent, and MCP declarations as configuration data without executing them.
Startup hooks and executable plugins remain disabled in the initial release.
Starting a selected MCP server requires its own approval and broker-controlled launch before individual MCP tool calls can be approved.
A provider launch fails safely if the tested CLI version cannot prevent uncontrolled instruction loading or startup execution.

---

## 8. Commands, MCP, and process security

### 8.1 Rust process broker

Tauri launches AI CLIs through a Rust-owned process broker.
The existing shell-plugin permission for `gh auth token` remains narrow and is not widened into a general shell capability.

The broker is responsible for:

- Broker-owned provider executable resolution.
- Profile-owned fixed arguments and working directories.
- Environment filtering.
- Structured event streaming.
- Timeouts and cancellation.
- Process-tree tracking.
- Parent and nested-agent budgets where an enabled profile permits delegation.
- Permission requests where an enabled profile permits them.
- Capability probes.
- Exit and crash classification.

For the Codex safe profile, the broker exposes only typed capability, start, and cancel operations. Its closed `review | chat` operation selects an embedded schema; it does not accept a provider executable, arguments, command, MCP server, tool call, working directory, environment, configuration, or schema path from the webview.

The webview never receives a general-purpose process execution API.

### 8.2 Commands

File reads, searches, and safe Git context may be available automatically within the chosen repository policy.
Tests, typechecks, builds, and other repository commands require explicit approval of the exact command.

The approval UI shows the command, working directory, reason, and expected effect.
Repository scripts are untrusted because they can execute arbitrary code or mutate external services.

Edits, dependency installation, and automatic network fetches are prohibited during review.

### 8.3 MCP and custom tools

Installed MCP declarations are discovered without starting their servers.
Starting an MCP server requires explicit approval of its executable, arguments, environment names, data access, and network scope.
After startup approval, every MCP tool call still requires explicit approval showing the server, tool, arguments, requested data, and possible side effects.
Startup hooks and executable plugins are not available in the initial release because they can execute before per-action approval.

The app does not silently resolve ambiguous or unavailable MCP tools.
A selected custom agent or MCP tool cannot bypass app-level read-only, scope, budget, or approval rules.
Run-owned provider state and MCP processes are tracked by the broker for cancellation and cleanup.

### 8.4 Timeouts and concurrency

Timeouts are configurable with safe defaults.
One-shot review defaults to ten minutes.
Chat uses a shorter default.

There may be one active AI task per open PR.
Global concurrency is configurable and defaults to two active CLI process trees.
Excess work waits in a visible queue.

Cancellation terminates the complete process tree and marks the run cancelled rather than failed.
Closing the desktop app terminates active process trees, preserves completed events, and marks affected runs interrupted.

---

## 9. Structured results

### 9.1 Run output

Conceptual result shape:

```ts
type AiReviewRun = {
  id: string
  target: PrTarget
  baseSha: string
  headSha: string
  inputFingerprint: string
  contextSecurityFingerprint: string
  provider: "claude" | "codex"
  selectedModel: string | null
  reportedModel: string | null
  cliVersion: string
  promptVersion: string
  profile: "quick" | "balanced" | "thorough"
  status: "running" | "completed" | "cancelled" | "interrupted" | "failed" | "invalid"
  summary: string | null
  findings: AiFinding[]
  requirementCoverage: RequirementCoverage | null
  coverage: ReviewCoverage
  usage: ReviewUsage
  createdAt: string
  completedAt: string | null
}
```

### 9.2 Findings

Each finding includes:

```ts
type AiFinding = {
  id: string
  title: string
  severity: "critical" | "high" | "medium" | "low"
  confidence: "high" | "medium" | "low"
  category: string
  path: string | null
  side: "LEFT" | "RIGHT" | null
  startLine: number | null
  endLine: number | null
  evidence: string
  impact: string
  suggestedFix: string | null
  source: "code-review" | "requirement-mismatch" | "chat"
}

type FindingDisposition = {
  runId: string
  findingId: string
  state: "open" | "dismissed" | "saved-as-draft" | "resolved"
  dismissalReason?: "false-positive" | "not-relevant" | "accepted-risk" | "other"
  note?: string
  updatedAt: string
}
```

The stored severity is technical.
The UI maps severity and confidence to reviewer-facing labels such as **Blocks merge**, **Should fix**, and **Consider**.

High-confidence findings appear by default.
Medium- and low-confidence observations appear in a collapsed section.
Severity and confidence remain separate.

A finding without a valid changed-file anchor is an unanchored observation.
It is never attached to an invented line.
Anchored findings identify `LEFT` for the base side or `RIGHT` for the head side, and their line range is validated against the exact base-to-head patch recorded by the run fingerprint.
Findings may point to unchanged lines or unchanged files for advisory purposes, in which case `side` is null.
Only GitHub-commentable diff lines with a valid side may become inline drafts.
Other findings can be added manually to the overall review body.

### 9.3 Finding lifecycle

A run may transition from `running` to one terminal status.
After that transition, its model output and `AiFinding` values are immutable.
Mutable reviewer workflow state lives in separate `FindingDisposition` records keyed by run ID and finding ID.
A disposition may be:

- Open.
- Dismissed.
- Saved as a draft.
- Resolved.

Dismissal reasons include false positive, not relevant, accepted risk, and free-text context.
Changing a disposition never rewrites the original run.
A new run may include prior findings and disposition feedback only when the reviewer enables **Use prior feedback**.
The feedback digest then becomes part of the new run's input fingerprint.
The toggle is off by default so independent runs remain possible.

### 9.4 Validation

Only schema-valid output enters the findings interface.
A successful process exit with malformed output creates an **invalid** run.
The app preserves permitted diagnostics and offers an explicit repair retry.
It does not silently repair output or display raw prose as validated findings.

The UI streams progress and sanitized events during execution.
Findings appear only after complete structured validation.
Partial output remains diagnostic and is never presented as a completed review.

---

## 10. Large PRs and coverage

A PR that exceeds one model context is reviewed in dependency-aware chunks using the existing analysis graph and ranking.
A final synthesis pass combines chunk results into one validated run.

The coverage report lists:

- Reviewed files.
- Skipped files and reasons.
- Failed chunks.
- Missing submodule or Git LFS content.
- Excluded sensitive files.
- Unavailable Jira issues.
- Whether synthesis completed.

The app never describes a partial run as a complete PR review.

---

## 11. Jira requirement verification

### 11.1 Detection and selection

The app detects Jira issue URLs or keys in the PR description.
It presents the detected issues and lets the reviewer select which ones to include.
It does not fetch every linked issue automatically.

Jira access uses the installed Jira MCP after explicit read approval.
The integration never writes, comments, transitions, or edits Jira issues.

### 11.2 Jira context

For each selected issue, the review may use:

- Issue key and URL.
- Summary.
- Description.
- Acceptance criteria.
- Comments.
- Authors and timestamps needed to explain conflicting requirements.

Parent epics, linked issues, and attachments are outside the default context.
They require a later explicit selection if supported.

### 11.3 Requirement coverage

Requirement coverage is separate from code findings.
Each acceptance criterion maps to one state:

- **Met**.
- **Partially met**.
- **Not evidenced**.
- **Contradicted**.

Each conclusion cites the Jira criterion and supporting code or test evidence.
A serious mismatch also appears as a normal finding with source `requirement-mismatch`.
Its severity depends on impact and evidence rather than receiving a fixed severity.

Conflicting descriptions, acceptance criteria, or comments are shown with source, author, and timestamp.
The AI does not decide which conflicting requirement is authoritative.
It creates a reviewer question rather than a code defect.

### 11.4 Jira snapshots and failure

Selected Jira data is stored as a versioned local snapshot with the immutable review run.
The snapshot records issue key, URL, fetched time, and Jira updated time.

A changed Jira issue offers an explicit refresh.
Refreshing creates a new review run and never mutates an old result.

When Jira MCP is unavailable, access is denied, or an issue cannot be read, the code review continues.
Requirement verification is marked unavailable or partial, with exact missing issues listed.
The AI never infers missing Jira content and presents it as a Jira requirement.

---

## 12. Local persistence and privacy

AI runs, immutable findings, mutable finding dispositions, chat, Jira snapshots, and permitted diagnostics are stored as plain JSON in the desktop app data directory.
No AI state is synchronized through the BFF by default.

Storage keys include repository, PR number, base and head SHAs, input fingerprint, run ID, provider, model, and prompt version.
Runs and their model output are immutable.
Reviewer dispositions are stored separately and may change.
The latest run with an exactly matching input fingerprint is displayed by default.

When the PR head changes, the base branch is retargeted, or any mutable input changes:

- Old runs remain readable as stale or context-mismatched history.
- A new review is required because the input fingerprint no longer matches.
- Old findings cannot become draft comments until their anchors are revalidated against the current base-to-head patch.

Deletion controls support:

- One run and its app-owned provider state.
- One PR and its app-owned sessions, snapshots, dispositions, logs, caches, and temporary source.
- All app-owned AI data and active AI process trees.
- An optional automatic retention period.

Automatic deletion is off by default.
Settings show the storage path, approximate disk use, and any provider data the app cannot control.
Adapters use run-specific app-owned state directories when the CLI supports state redirection.
If a provider stores sessions, logs, caches, or remote data outside those directories, the deletion UI names that limitation and provides verified provider cleanup guidance rather than claiming the data was deleted.

Persisted diagnostics contain sanitized events and raw model output where allowed.
They exclude environment variables, detected credentials, authentication tokens, and sensitive file contents fetched only through tools.

This internal app does not ask for a separate data-sharing consent checkbox.
The reviewer starts each review or chat turn explicitly with its action button.
The run screen retains a visible provider and context indicator.
Changing provider, model, repository, or context invalidates pending work before a new run can start.

---

## 13. Usage reporting

A run reports:

- Elapsed time.
- Provider and model provenance.
- Parent and nested-agent counts.
- Tool and approved-command events.
- Tokens when reliably reported by the CLI.
- Provider-derived cost only when reliably reported.

The app never fabricates token counts or monetary estimates.
Unknown values are shown as unknown.

---

## 14. Failure behavior

| Failure                      | Behavior                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| CLI missing                  | Show setup guidance and retry.                                                                        |
| CLI unauthenticated          | Ask the user to authenticate externally, then retry.                                                  |
| Missing core capability      | Mark the adapter unavailable and name the missing capability.                                         |
| Disabled advanced capability | Keep an otherwise safe profile available and disclose the disabled control as degraded/non-invocable. |
| Provider or model failure    | Preserve the failed run and offer explicit retry.                                                     |
| Other provider available     | Offer it as a manual retry, never automatic fallback.                                                 |
| Invalid structured output    | Mark the run invalid and offer explicit repair retry.                                                 |
| Timeout                      | Terminate the process tree and mark the run failed by timeout.                                        |
| User cancellation            | Terminate the process tree and mark the run cancelled.                                                |
| App closes                   | Terminate the process tree and mark the run interrupted.                                              |
| Jira unavailable             | Continue code review and mark requirement coverage unavailable.                                       |
| Partial file coverage        | Complete only as a partial run with a visible coverage report.                                        |

---

## 15. Core invariants

1. AI work is always user-triggered.
2. The active Git working tree is never exposed to the agent.
3. The agent cannot edit project files.
4. Repository commands require exact, explicit approval.
5. MCP operations require explicit approval and remain within app limits.
6. Repository, PR, comment, and Jira text is untrusted data.
7. App safety and output rules cannot be overridden by imported instructions.
8. Only validated findings enter the review UI.
9. AI never changes human review progress or ranking.
10. AI never publishes to GitHub or writes to Jira.
11. Every result is pinned to base and head SHAs plus a canonical review-input fingerprint.
12. Runtime sessions cannot cross incompatible context or security fingerprints.
13. Model output is immutable, while reviewer dispositions are separate mutable state.
14. Partial context or failed inputs are always disclosed.
15. Unknown usage, retention, and capability facts are reported as unknown.

---

## 16. Delivery plan

### Slice 1 — safe provider foundation

Build:

- Shared AI schemas and provider contract.
- Fake provider adapter.
- Rust process broker.
- Executable discovery and capability probing.
- Event streaming, timeout, cancellation, process-tree cleanup, and concurrency queue.
- Isolated source preparation and repository security policy.
- Canonical input and context-security fingerprints.
- Plain JSON local run and disposition storage with app-owned and provider-owned deletion boundaries.

Verify:

- The fake adapter completes a full run through Tauri.
- Cancellation kills the full process tree.
- The webview cannot launch arbitrary programs.
- The active working tree remains unchanged.
- Sensitive paths follow the selected repository policy.

### Slice 2 — one-shot Claude and Codex review

Build:

- Claude adapter behind capability detection.
- Codex adapter behind capability detection.
- Provider and model settings.
- Review profiles and bounded nested-agent support.
- Dependency-aware chunking and synthesis.
- Structured findings, confidence filtering, anchors, coverage report, and risk badges.
- Manual finding-to-draft promotion.
- Run history, stale-SHA handling, usage, and sanitized diagnostics.

Verify:

- Each available adapter passes the same contract suite independently.
- Findings anchor only to valid patch sides and locations.
- Invalid and partial output never appears as a completed review.
- Promoted findings enter the existing draft flow without automatic publication.
- AI runs never alter review checkmarks or ranking.

### Slice 3 — scoped chat and Jira requirements

Build:

- Main and focused chat threads.
- Selection, file, finding, and whole-PR scopes.
- Save-chat-response-as-finding.
- Explicit command and MCP approval UI.
- Selected global, repository, and custom-agent instructions.
- Jira link detection, issue selection, read-only MCP retrieval, snapshots, and refresh.
- Requirement coverage and mismatch findings.

Verify:

- Lost provider sessions rebuild from provider-neutral history.
- Jira failures do not block code review.
- Requirement states cite Jira and code evidence.
- Jira conflicts remain questions rather than invented decisions.
- No Jira write operation is available.

---

## 17. Quality strategy

Deterministic tests cover schemas, storage, queues, state transitions, permission gates, snapshot policies, chunk coverage, anchor validation, and UI behavior.
Every test follows Arrange, Act, and Assert sections.

Provider contract tests run against fake event streams and recorded sanitized fixtures.
Live Claude and Codex checks are separate capability tests because model output is nondeterministic.

A curated PR fixture set contains:

- Known correctness and security issues.
- Requirement mismatches.
- Clean changes that should not create high-confidence findings.
- Invalid anchors.
- Large PR chunking cases.
- Missing Jira access.
- Conflicting Jira comments.

Quality evaluation tracks expected issue detection, false positives on clean changes, anchor correctness, disclosed coverage, and schema validity.
A feature is not considered ready from schema tests alone.

---

## 18. Explicit non-goals

The initial design does not include:

- Server-hosted AI providers.
- Browser-to-local helper daemons.
- Automatic reviews on PR open or push.
- Automatic provider fallback.
- Simultaneous Claude and Codex review merging.
- AI-selected GitHub verdicts.
- Automatic publication of GitHub comments.
- Automatic changes to review progress or ranking.
- AI code edits or dependency installation.
- Automatic command, network, or MCP approval.
- Startup hooks or executable provider plugins.
- Codex safe-profile repository commands, MCP startup or tool calls, skills, custom agents, nested agents, web search, code editing, or automatic updates.
- Jira writes.
- Shared team chat or AI-result synchronization.
- Automatic AI attribution in published comments.
- Initial Windows or Linux availability.

---

## 19. Open implementation proofs

The product decisions are complete, but implementation must prove these provider-specific facts before an enabled profile depends on them. The Codex safe profile is available only under its exact-receipt model; its release gate and independent review proved its fixed prompt-only invocation, bounded JSONL output, cancellation/cleanup, and disabled advanced controls. The following remain open for broader provider profiles:

1. The shipped Claude CLI and Codex CLI mechanisms for structured output and event streaming.
2. Their supported sandbox, tool permission, instruction-loading, model-selection, and cancellation controls.
3. Whether native nested-agent events and usage are observable enough to enforce the agreed limits.
4. How each CLI disables startup hooks, executable plugins, automatic instruction loading, and automatic MCP startup.
5. How each CLI exposes separately approvable MCP server startup and tool-call requests without granting uncontrolled access.
6. Whether each CLI can redirect local sessions, logs, caches, and other state into app-owned directories, plus its remote retention and deletion behavior.
7. The installed Jira MCP tool names and schemas available on the reviewer's machine.

If a tested CLI cannot enforce a required safety boundary for a profile, that profile remains unavailable rather than weakening the design. The Codex safe profile does not claim or enable any unproven advanced control.
