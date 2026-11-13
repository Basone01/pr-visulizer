# Generated and too-large files

A generated file or a file with a huge diff never blocks a review.
The app classifies each changed file, shows what it can, and says plainly what it left out.
This document describes the model, what each part of the app does with it, and what is and is not verified.

## The problem

The trigger was a PR with 13 build CSS and source-map files, with single lines of 80 KB to 1.5 MB.
The reviewer asked for the app to skip those files and let the review continue.
A PR with such files showed no graph, no ranking and no review order.
The first fix was measured on a real PR of this shape (see "Measured before and after").

Four causes were measured:

| Cause | What happened |
| --- | --- |
| S1. One refused patch rejected the whole analysis | 12 files had a diff over the native cap of 128 KiB (`MAX_REPO_FILE_DIFF_BYTES`). The first refusal rejected the whole run, so the app showed the banner "Analysis failed — git diff exceeded the bounded patch byte limit", with no graph and no ranking. The queue listed the files in path order with no rank score. |
| S2. The failure was retried and never cached | The analysis query retried 3 more times, so one click on "Retry analysis" ran 4 analyses. Together they moved 116 MB of file content into the webview, with frame gaps up to 1.94 s. |
| S3. The diff of such a file never finished | The pane showed "Loading diff…" for ever. The patch request failed, but only a commit-range error was ever shown, so a failed patch fell through to the loading text. |
| S4. A one-line patch under the cap froze the UI | A 116 KB patch with one line on each side froze the main thread twice, 1,581 ms and 1,576 ms, before the diff appeared after about 3.5 s. The cause was inferred (highlighting one 58 KB line) and not profiled. |

## The model: two separate facts per file

A changed file has two independent facts.
They are never merged into one "skipped" bucket.
The first version did merge them, and review round 5 showed why that was wrong (see below).

| | `generated` | `diff omitted` |
| --- | --- | --- |
| Meaning | The file is build output or vendored code. | The patch cannot be shown. |
| Values | `generated` | `too-large` (over the 128 KiB cap, or omitted by GitHub) or `unreadable` (any other per-file patch failure, for example not valid UTF-8) |
| Analysed | No. | Yes, by its content, when its blob is within the engine's limit. |
| Ranked | No. It is listed after the ranked files. | Yes. |
| Counts toward review completion | No. | Yes. |
| What the agent is told | It needs no reading, and it is left out of whole-PR commands. | It is part of the review, and it is read in bounded pieces. |
| Pane | A notice with Show diff anyway and Open on GitHub. | A notice that says the file is still in the review, with Open on GitHub. |

The code is in `packages/shared/src/review/changedFileSkip.ts`, in `classifyChangedFile`.
The analysis, the queue, the diff pane, the agent prompt and the snapshot all read the result of that one function, so a file never gets two answers.

### When a file is `generated`

A file is `generated` only on strong evidence, by one of two rules.

1. **By name alone.** The file name ends in one of these suffixes: `.map`, `.min.js`, `.min.css`, `.pb.go`. Or the file is under a `node_modules` folder.
2. **By folder plus shape.** The file is under a build-like folder, and it also has a machine-made shape.

The build-like folders are `.generated`, `__generated__`, `build`, `dist`, `generated`, `bower_components` and `vendor`.
They are matched on folder segments only, never on the file name, and the match is case-sensitive lower case.

The three machine-made shape signals are:

- The patch is over the cap (the native reader refused it on bytes).
- GitHub omitted the patch.
- A line of the patch is longer than 5,000 characters (`LONG_GENERATED_LINE_CHARS`).

A folder name alone never makes a file generated.
The first version matched `build`, `dist`, `generated` and `vendor` on any segment, the file name included.
Review round 5 found that this hides real source such as `cmd/build/main.go`, `src/build/index.ts` or a PHP `Vendor/` domain folder.
Those files now stay in the review unless their shape is machine-made too.

### When a diff is omitted

| Evidence from the patch reader | Fact |
| --- | --- |
| The native reader refused the patch on bytes | `too-large`, with the limit 128 KiB |
| GitHub has no patch for the file | `too-large`, with no limit |
| Any other per-file read failure (a bare string from a Tauri command) | `unreadable`, with the message |

A generated file that is shown anyway still has its diff refused when it is over the cap.

## What each part of the app does

### Analysis

- No per-file patch failure of any kind rejects an analysis. A patch read is a result: a patch, or an omission with its reason. Only repo-wide steps may fail a run.
- A patch is not requested for a file that the name alone classifies as generated.
- The retry rule is in `service/queryRetry.ts`. A deterministic failure is not retried, because the same input gives the same answer. That means no repo source yet, a patch refused on bytes, no diff for the file, or data that failed its schema. Anything else, such as a network error, a GitHub 5xx or a git child that died, is retried up to 3 times.

### Review order

- Generated files are listed after the ranked files and have no rank. A skipped file is never the suggested next file.
- The ranking core is untouched. `rankReviewFiles` splits the generated files off, and `rankFiles` gets the same input as before. With no generated file, the result is exactly what it was, and the PR #42 fixture values in `docs/architecture.md` do not change.
- Completion counts reviewable files only: "N files left", all reviewed, the submit warning and the graph's first-unreviewed jump. The tray says how many generated files are not counted ("N generated, not counted").

### Graph

The graph was not redesigned.
On the real PR it showed one node for each ranked file and no node for a generated file.

### Diff pane

| State | When | Controls |
| --- | --- | --- |
| Generated file, not shown | The file is generated | Show diff anyway, Open on GitHub. It says it is not analysed and needs no review, and shows the line counts. |
| Diff too large to show | The diff is over the limit or GitHub omitted it, or "Show diff anyway" was refused | Open on GitHub. It says the file is still part of the review. There is no Retry, because the same read gives the same answer. |
| Diff could not be read | Any other per-file read failure | Open on GitHub, and the real message. There is no Retry. |
| Couldn't load this diff | A load failed for a reason that may pass (network, GitHub) | Retry |

"Loading diff…" can no longer be a final state.
The notice for a generated file comes from local data, with no patch read.

### Long lines

- A diff line is cut at 2,000 characters (`MAX_SHOWN_LINE_CHARS`), with a note such as "… 56,062 more characters not shown".
- A line over 500 characters is shown as plain text, with no highlighting (`MAX_HIGHLIGHTED_LINE_CHARS`).
- The cut line has "Show full line" and "Copy line", so the rest can be seen and copied on demand as plain text, with no highlighting and no word diff.
- Every patch line goes through one component (`CodeContent`), so the cut covers the inline view, both split columns, the peek popup and the full-file view.

### Commit-range view

The commit-range view follows the same states.
GitHub's compare API gives a null patch both for a diff it omits and for a pure rename, and the app tells them apart by the line counts.

## What the agent is told

The first-turn prompt of the chat has a review-files part (`utils/aiReview/skippedFilesPrompt.ts`).

- **Generated files.** "This PR changes N generated files (build output or vendored code). They need no reading." A folder is named once instead of its files only when every changed file under it is generated, and at most 30 entries are named, then "and K more, see list_pr_files".
- **Diff-omitted files.** The prompt says they are part of the review, and names each with "diff too large to print whole" or "diff could not be read". It tells the agent to read one in bounded pieces: `git diff --stat` for its size, then a line window such as `git diff <range> -- <path> | sed -n '1,200p'`, or `git show <headSha>:<path> | sed -n '1,200p'`.
- **Leaving files out.** "Leave these files out of every whole-PR git diff, git show and sem diff", with an example `git diff <range> -- . ':(exclude)<path>'`.
- **The sem command.** `sem diff --from/--to` cannot leave files out by path. So the prompt recommends piping the filtered git diff into sem: `git diff <range> -- . ':(exclude)…' | sem diff --patch -v`. If that piped command is refused or fails, the agent runs the filtered git diff alone. On the PR that was measured, the piped form printed 501 B against 261,081 B for the whole-PR form, as reported by the engineer. A whole-PR `git diff` on such a PR printed about 12 MB.
- **Paths in the example command.** At most 3 paths enter it, and only a path that is exactly what git will match. A path with a glob character (`* ? [ ]`), a quote or backslash, or a leading `:` or `-` stays in the prose. So does a path with hidden characters, which are shown as `\u{XXXX}` escapes and never dropped. A path is capped at 200 characters.
- **Before the analysis lands.** If the chat starts while the analysis runs, only name-rule generated files are known. The prompt says that files with a too-large diff are not known yet, and that `list_pr_files` has them once the analysis is done. The snapshot is rebuilt when the analysis lands, so `list_pr_files` is current.

The tool output of `list_pr_files` and `get_current_file` adds a note per file (`codex_answer.rs`).
Only the two reason values parse in Rust, because the value reaches the agent and must never be free text.
A generated file gets `skipReason` and `skipNote`, and its note wins over an omitted diff.
A diff-omitted file gets `diffOmitted` and `diffNote`, and is not called skipped.
A normal file keeps exactly the shape it had before.

| File | Note the agent gets |
| --- | --- |
| Generated | "Skipped: a generated or vendored file. It needs no reading, leave it out of git diff and git show." |
| Diff `too-large` | "Its diff is too large to show whole. It is still part of the review: read it in bounded pieces, for example git diff --stat for this path, then a line window of git show <headSha>:<path>. Do not print the whole diff." |
| Diff `unreadable` | "The app could not read its diff, for example because it is not valid UTF-8. It is still part of the review: read it carefully with bounded commands." |

## Measured before and after

**These numbers are from the first version of the fix.**
The reworked model (after review round 5) has not been re-measured in the desktop app.
The re-run was on the same kind of PR in the desktop WKWebView, after a webview reload.

| Measure | Before the fix | After the first version |
| --- | --- | --- |
| Analysis | Failed, with the banner about the bounded patch byte limit | Succeeded, no banner |
| Time to a usable review | Never | 13.3 s from navigation start to graph nodes and a "#1" rank |
| Analysis runs per load or retry | 4 (3 retries) | 1 completed |
| File content moved per retry click | 116 MB (4 runs of about 29 MB) | Not captured |
| Frame gaps during load or retry | 16 over 200 ms, longest 601 ms (an earlier retry 1,940 ms) | 0 over 200 ms, longest 23 ms (11.3 to 13.3 s). A Refresh PR had 0 over 200 ms, longest 97 ms |
| Webview memory | 571 to 705 MB | 128 MB before the reload, 166 MB after load, 143 MB at the end |
| App (Rust) process memory | 259 to 353 MB | 363 MB before the reload, 866 MB after load, 931 MB at the end (cause unknown) |
| Graph | 0 nodes | 13 nodes, one for each ranked file |
| A large generated file's diff | "Loading diff…" for ever, 4 retries | A generated notice from local data, 0 patch reads. "Show diff anyway" gave "Diff too large to show" after 1 refused read, with no retry |
| The 116 KB one-line patch | 2 stalls of about 1.58 s | The lines were cut, with stalls of 332 ms and 322 ms |

Other results of that re-run:

- The queue listed the 13 ranked files first. Then it listed the 15 generated files after them, with no rank. In that first version every one of them had the reason `generated`, because the path rule won first.
- The next-file button visited only ranked files, but all 15 generated files were already viewed, so this did not prove that an unviewed generated file is excluded.
- The console had 0 errors and 0 warnings.

## Review round 5

An adversarial review ran over the first version.
It kept 20 findings, with 4 rated high, 9 medium and 7 low.
The 4 high findings are two problems, each reported twice.
They were weaknesses in the rules, not bugs in the code.

1. The path rule matched `build`, `dist`, `generated` and `vendor` on any segment, so it hid real source.
2. "Too large" was treated as "not source". A hand-written file with a big patch lost its symbols and rank, had no way to its diff, and the agent was told it "needs no reading".

The model changed to the two facts above, and the contract was rewritten around them.

| # | Area | Severity | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | analysis and ranking | high | The generated-path rule skipped real source: `build`, `dist`, `generated` and `vendor` matched at any depth, and on the file name | fixed (folder plus shape rule) |
| 2 | analysis and ranking | high | A too-large hand-written file was hidden from the agent, never read, and its diff could not be opened | fixed (the two facts) |
| 3 | analysis and ranking | medium | Any patch error other than the cap still failed the whole analysis and was retried 4 times, for example a non-UTF-8 file | fixed (no per-file failure rejects a run) |
| 4 | analysis and ranking | medium | "Too-large" was two facts, not one: over-cap files were ranked, yet the pane said they were left out of the review order | fixed |
| 5 | analysis and ranking | medium | Completion counted skipped files, but "next" stepped over them, so the queue said done while Submit was still gated | fixed (completion counts reviewable files only) |
| 6 | diff pane and queue | high | The path rule hid real source from the reviewer, the queue and the agent | fixed (same as 1) |
| 7 | diff pane and queue | medium | In the commit-range view, a file whose patch GitHub omits showed "Loading diff…" for ever, and the view ignored the classification | fixed (same states in range view) |
| 8 | diff pane and queue | medium | A cut long line hid its changed region, word-diff emphasis and find matches past character 2,000, with no way to see or copy the rest | fixed (Show full line, Copy line) |
| 9 | diff pane and queue | medium | Skipped files counted toward "files left" and blocked "all reviewed", while Next stepped over them | fixed (same as 5) |
| 10 | diff pane and queue | low | The error state dropped the message for the app's real Tauri rejections, which are bare strings | fixed |
| 11 | diff pane and queue | low | A too-large file in API-patch mode showed a futile error and Retry, not the skipped state | fixed |
| 12 | diff pane and queue | low (plausible) | Focus dropped to the page body after "Show diff anyway" and after Retry | not confirmed in the sources |
| 13 | diff pane and queue | low | No test guarded the queue's skip-reason label, and the range and API-mode states were untested | not confirmed in the sources |
| 14 | agent prompt and tools | medium | The preferred whole-PR command, `sem diff -v`, cannot leave skipped files out, so the agent still read megabytes of generated CSS | fixed (the piped sem command) |
| 15 | agent prompt and tools | high | A hand-written file with a patch over 128 KiB got `too-large`, and the agent was told it needs no reading | fixed (same as 2) |
| 16 | agent prompt and tools | medium | The path rule marked real source as generated: PascalCase folders such as `Vendor`, `Build` and `Dist`, and extensionless files named `build` | fixed (case-sensitive, folder segments only) |
| 17 | agent prompt and tools | medium | The example exclude command passed glob characters through, so a folded folder named `*` would hide every changed file from the agent | fixed (unsafe paths stay out of the command) |
| 18 | agent prompt and tools | low | Untrusted paths kept U+2028 and U+2029 and zero-width characters, in the list and in the example command | fixed (escaped) |
| 19 | agent prompt and tools | low | If the chat started before the analysis landed, the first prompt never named too-large files, and "list_pr_files has the current list" failed | fixed (the prompt says so, and the snapshot is rebuilt) |
| 20 | agent prompt and tools | low | Folder folding cost O(files² × depth) and ran twice on every file open | fixed (one pass) |

The status column comes from the contract rulings and from the code I read.
For findings 12 and 13, the sources do not say whether they were fixed.

## Numbers

As verified by the lead:

- Typecheck is clean, and Prettier and `cargo fmt` are clean.
- Web tests: 1,082 passed and 2 failed. Both failures are the known pair in `src/hooks/useDiffViewSettings.test.ts`.
- Engine, server and shared tests: 215 passed.
- Rust tests: 164 passed, 0 failed and 3 ignored.

## Not verified yet and known limits

- The reworked model is not measured in the desktop app. The 116 KB one-line case measured about 330 ms twice on the first version, and the fix after it is unmeasured in WebKit.
- Whether the piped sem command runs without an approval card in the chat is not verified.
- A keyboard focus ring on the pane buttons was never seen rendered. The buttons are focusable and above the 24 px floor, and the rule exists, but a real Tab key could not be sent.
- One frame gap of 712 ms occurred once after a GitHub response landed on a click. Its cause is not proven.
- Unchanged generated files are still read by the repo scan (115 files and 4.0 MB per run on that PR). A follow-up for this was declined.
- The chat needs a linked repository. It never uses the managed clone that the analysis uses.
- The queue's "generated" label is not shown on viewed rows in the first version. The contract now asks for the label on viewed rows too, and it was not seen in the app.
- The app's Rust process memory grew from 363 MB to 931 MB across one reload and the session, and the cause is unknown.
- The app force-checks-out the PR head in its managed clone. A clone that the user keeps for review is treated as the app's own cache.
