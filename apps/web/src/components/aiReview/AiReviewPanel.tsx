import type { AiReviewTarget } from "@pr-visulizer/shared"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  type PromptChangedFile,
  type ReviewFilesPrompt,
  describeReviewFiles,
} from "@/utils/aiReview/skippedFilesPrompt"
import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import {
  type AiReviewSettings,
  DEFAULT_AI_REVIEW_SETTINGS,
  type SelectableAiProviderId,
  TERMINAL_PROVIDERS,
  TERMINAL_PROVIDER_ORDER,
  describePanelSettings,
  panelSurfaceFor,
  selectableAiProviderIdSchema,
} from "@/entity/aiReviewSettings"
import {
  CHAT_PROMPT_SHORTCUTS,
  type CustomTerminalPromptShortcut,
  NO_FILE_SELECTED_TEXT,
  TERMINAL_PROMPT_SHORTCUTS,
  toPromptShortcut,
} from "@/entity/terminalPromptShortcuts"
import type { ReviewSnapshot } from "@/entity/terminalReviewSnapshot"

import {
  type AiReviewSettingsStorage,
  createAiReviewSettingsStorage,
} from "@/service/aiReview/settingsStorage"
import type { CodexTerminalContext } from "@/service/terminal/codexTerminal"
import {
  type NewCustomTerminalPromptShortcut,
  createTerminalShortcutStorage,
} from "@/service/terminal/shortcutStorage"

import { findRepoLink, loadRepoLinks } from "@/tauri/repoLinks"

import { AiChatSurface } from "./AiChatSurface"
import styles from "./AiReviewPanel.module.css"
import { CodexTerminal } from "./CodexTerminal"
import { CustomShortcutsEditor } from "./CustomShortcutsEditor"

// Shown in the aside, toggle, and loading notice until a provider is chosen.
const UNCHOSEN_TERMINAL_LABEL = "AI terminal"
const UNCHOSEN_PROVIDER_VALUE = ""

type AiReviewPanelProps = {
  target: AiReviewTarget
  storage: KeyValueStore
  title: string
  baseSha: string
  headSha: string
  currentFilePath: string | null
  // Null while the analysis or the review progress is still loading.
  review: ReviewSnapshot | null
  // The PR's changed files with what is known of their skip reason at this moment: the path
  // rule from the start, "too-large" once the analysis has read the patches.
  changedFiles: ReadonlyArray<PromptChangedFile>
  // False while the analysis runs: the prompt then says some facts are not known yet.
  analysisReady: boolean
  onTerminalSessionStarted: (sessionId: string) => void
  onTerminalSessionEnded: (sessionId: string) => void
}

type InitialPromptInput = {
  target: AiReviewTarget
  title: string
  baseSha: string
  headSha: string
  currentFilePath: string | null
  // The generated and diff-omitted files, worked out once per file list, not per prompt.
  reviewFiles: ReviewFilesPrompt
}

// The PR facts and the safety line both surfaces send as their first prompt.
function describePullRequest(input: InitialPromptInput): string[] {
  const prUrl = `https://github.com/${input.target.owner}/${input.target.repo}/pull/${input.target.number}`
  const selectedFile = input.currentFilePath ?? NO_FILE_SELECTED_TEXT

  return [
    "You are helping review a GitHub pull request in this repository.",
    `PR: ${prUrl}`,
    `Title: ${input.title}`,
    `Base commit: ${input.baseSha}`,
    `Head commit: ${input.headSha}`,
    `Selected file: ${selectedFile}`,
    "The current checkout may not be the PR head. Do not change branches, checkout commits, edit files, or run destructive commands.",
    `Inspect the PR with git diff ${input.baseSha}...${input.headSha} and git show ${input.headSha}:<path> as needed.`,
    ...input.reviewFiles.lines,
    'The get_current_file tool shows the file and lines the reviewer is looking at right now. Call it when the reviewer says "this file" or "these lines".',
  ]
}

// sem diff --from/--to cannot leave files out, so when some must be, the filtered form wins.
function semDiffCommandFor(input: InitialPromptInput): string {
  return (
    input.reviewFiles.semDiffCommand ?? `sem diff -v --from ${input.baseSha} --to ${input.headSha}`
  )
}

// The git fallback leaves the same files out as the sem command does.
function gitDiffCommandFor(input: InitialPromptInput): string {
  return input.reviewFiles.gitDiffCommand ?? "git diff"
}

export function createInitialPrompt(input: InitialPromptInput): string {
  return [
    ...describePullRequest(input),
    `If the sem CLI is installed (check with command -v sem), prefer ${semDiffCommandFor(input)} for a semantic, entity-level view of the change, and fall back to ${gitDiffCommandFor(input)} when it is missing.`,
    "Whenever an answer mentions a file or line the reviewer may need to open, you must call render_answer successfully before finishing, even for a short answer. Include every mentioned file in fileRefs, with its line when known. Use repo-relative Markdown links or inline paths so the references are clickable. If rendering fails, correct the request and retry, then report any unresolved failure instead of claiming the preview is ready.",
    "Use the terminal for progress, questions, and answers without file references. For longer explanations, summaries, or review results, also prefer render_answer with a title and Markdown. After rendering, keep the terminal reply to a brief confirmation that the answer is in the preview window.",
    "Start by briefly confirming the PR context, then wait for the reviewer’s question.",
  ].join("\n")
}

// The chat cannot approve a tool call, so the sem check is "try it" instead of a
// command -v probe that would need approval and show the reviewer a denial.
export function createChatInitialPrompt(input: InitialPromptInput): string {
  return [
    ...describePullRequest(input),
    `Prefer ${semDiffCommandFor(input)} for a semantic, entity-level view of the change. Only if that command fails, run ${gitDiffCommandFor(input)} as a separate second command, never joined to it with ||.`,
    // The chat asks the reviewer before a command that needs approval (CONTRACT.md 6).
    "Some shell commands need the reviewer’s approval: the reviewer is asked and may deny it. A denial applies to that one command only, so carry on with a simpler read-only command such as git diff, git diff --stat, git show or git grep.",
    "Answer in this chat, in Markdown.",
    "Mermaid diagrams are not rendered in this chat, so draw a diagram with an openui-lang Diagram or SequenceDiagram block.",
    "Make every location in a file of this PR clickable: write it as a Markdown link to the repo-relative path, with the line when known, such as [src/app.ts:42](src/app.ts#L42).",
    "Only files of this PR are clickable in this chat. Write any other path as plain text.",
    "Single line breaks are not shown in this chat. Use a Markdown list, or a blank line between paragraphs.",
    "render_answer is optional in this chat. A rendered answer is shown inline in the chat, so do not repeat its content in your reply. openui-lang blocks, diagrams included, are drawn only in your chat reply and show as plain code inside a rendered answer, so put anything with a block in the reply.",
    "Start by briefly confirming the PR context, then wait for the reviewer’s question.",
  ].join("\n")
}

export function AiReviewPanel({
  target,
  storage,
  title,
  baseSha,
  headSha,
  currentFilePath,
  review,
  changedFiles,
  analysisReady,
  onTerminalSessionStarted,
  onTerminalSessionEnded,
}: AiReviewPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [repositoryPath, setRepositoryPath] = useState<string | null>(null)
  const [settings, setSettings] = useState<AiReviewSettings>(DEFAULT_AI_REVIEW_SETTINGS)
  const [customShortcuts, setCustomShortcuts] = useState<CustomTerminalPromptShortcut[]>([])
  const [customModel, setCustomModel] = useState("")
  const [usingCustomModel, setUsingCustomModel] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  // Open until the saved settings name a provider, then one closed row. Not persisted, and never
  // closed for the reviewer: picking a provider in the open row leaves it open.
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Counts saves, so a save result can tell whether a newer save has started since.
  const latestSaveRef = useRef(0)

  useEffect(() => {
    let active = true
    setIsLoading(true)
    setLoadError(null)
    void Promise.all([
      loadRepoLinks(storage),
      createAiReviewSettingsStorage(storage).load(),
      createTerminalShortcutStorage(storage).load(),
    ])
      .then(([links, loadedSettings, loadedShortcuts]) => {
        if (!active) return

        setRepositoryPath(findRepoLink(links, target)?.path ?? null)
        setSettings(loadedSettings)
        setSettingsOpen(loadedSettings.terminalProvider === null)
        setCustomShortcuts(loadedShortcuts)
        if (loadedSettings.terminalProvider !== null) {
          showModelControls(loadedSettings, loadedSettings.terminalProvider)
        }
      })
      .catch((error: unknown) => {
        if (!active) return

        setLoadError(error instanceof Error ? error.message : "Could not load terminal settings.")
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })

    return () => {
      active = false
    }
  }, [storage, target])

  // Keyed on the file list's content, so opening another file never redoes this work.
  const reviewFiles = useMemo(
    () => describeReviewFiles({ files: changedFiles, baseSha, headSha, analysisReady }),
    [analysisReady, baseSha, changedFiles, headSha]
  )
  const initialPrompt = useMemo(
    () => createInitialPrompt({ target, title, baseSha, headSha, currentFilePath, reviewFiles }),
    [baseSha, currentFilePath, headSha, reviewFiles, target, title]
  )
  const chatInitialPrompt = useMemo(
    () =>
      createChatInitialPrompt({ target, title, baseSha, headSha, currentFilePath, reviewFiles }),
    [baseSha, currentFilePath, headSha, reviewFiles, target, title]
  )
  // Memoized so the terminal only pushes a context update when something in it really changed.
  const terminalContext = useMemo<CodexTerminalContext>(
    () => ({
      owner: target.owner,
      repo: target.repo,
      number: target.number,
      title,
      baseSha,
      headSha,
      selectedFilePath: currentFilePath,
      ...(review === null ? {} : { review }),
    }),
    [baseSha, currentFilePath, headSha, review, target, title]
  )
  const terminalIdentity = `${target.owner}/${target.repo}#${target.number}:${baseSha}:${headSha}`
  const provider = settings.terminalProvider
  const terminalLabel =
    provider === null ? UNCHOSEN_TERMINAL_LABEL : TERMINAL_PROVIDERS[provider].label
  // The provider decides the surface: Claude chats, Codex runs in the terminal.
  const surface = provider === null ? "terminal" : panelSurfaceFor(provider)
  // Built-in shortcuts depend on the surface (only the chat can draw a diagram block),
  // the reviewer's custom shortcuts go on both.
  const promptShortcuts = useMemo(
    () => [
      ...(surface === "chat" ? CHAT_PROMPT_SHORTCUTS : TERMINAL_PROMPT_SHORTCUTS),
      ...customShortcuts.map(toPromptShortcut),
    ],
    [customShortcuts, surface]
  )

  // A saved model outside the provider's suggestions can only have come from the custom field,
  // so it reopens there.
  function showModelControls(
    nextSettings: AiReviewSettings,
    nextProvider: SelectableAiProviderId
  ): void {
    const model = nextSettings.providers[nextProvider].selectedModel
    const isSuggestedModel = TERMINAL_PROVIDERS[nextProvider].modelSuggestions.some(
      (option) => option.id === model
    )
    setUsingCustomModel(model !== null && !isSuggestedModel)
    setCustomModel(model ?? "")
  }

  // The local update applies first so the select responds at once,
  // then the saved settings replace it.
  // Only the newest save may replace it. An older save that lands later would put back the
  // model of an earlier pick, and in a running chat every model flip is a real switch request.
  function persist(
    localUpdate: AiReviewSettings,
    save: (settingsStorage: AiReviewSettingsStorage) => Promise<AiReviewSettings>
  ): void {
    latestSaveRef.current += 1
    const saveNumber = latestSaveRef.current
    setSettings(localUpdate)
    setSaveError(null)
    void save(createAiReviewSettingsStorage(storage))
      .then((savedSettings) => {
        if (saveNumber === latestSaveRef.current) setSettings(savedSettings)
      })
      .catch(showSaveError)
  }

  function showSaveError(error: unknown): void {
    setSaveError(error instanceof Error ? error.message : String(error))
  }

  function saveProvider(nextProvider: SelectableAiProviderId): void {
    showModelControls(settings, nextProvider)
    persist({ ...settings, terminalProvider: nextProvider }, (settingsStorage) =>
      settingsStorage.saveTerminalProvider(nextProvider)
    )
  }

  function saveModel(provider: SelectableAiProviderId, nextModel: string | null): void {
    const localUpdate = {
      ...settings,
      providers: {
        ...settings.providers,
        [provider]: { ...settings.providers[provider], selectedModel: nextModel },
      },
    }
    persist(localUpdate, (settingsStorage) =>
      settingsStorage.saveSelectedModel(provider, nextModel)
    )
  }

  function saveCustomModel(provider: SelectableAiProviderId): void {
    const model = customModel.trim()
    if (model) saveModel(provider, model)
  }

  async function addShortcut(shortcut: NewCustomTerminalPromptShortcut): Promise<boolean> {
    setSaveError(null)
    try {
      setCustomShortcuts(await createTerminalShortcutStorage(storage).add(shortcut))
      return true
    } catch (error) {
      showSaveError(error)
      return false
    }
  }

  function removeShortcut(id: string): void {
    setSaveError(null)
    void createTerminalShortcutStorage(storage)
      .remove(id)
      .then(setCustomShortcuts)
      .catch(showSaveError)
  }

  return (
    <aside
      className={`${styles.panel} ${collapsed ? styles.collapsed : ""}`}
      aria-label={terminalLabel}
      data-codex-collapsed={collapsed ? "true" : undefined}
      data-pane-min-height="220"
    >
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? `Show ${terminalLabel}` : `${terminalLabel} · Hide`}
      </button>

      <div className={styles.content}>
        {/* The surface stays outside this disclosure, so opening or closing it never remounts,
            restarts or stops a session. */}
        <details
          className={styles.settings}
          open={settingsOpen}
          onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
        >
          <summary className={styles.settingsSummary}>{describePanelSettings(settings)}</summary>
          <div>
            <label className={styles.field}>
              Provider
              <select
                className={styles.select}
                value={provider ?? UNCHOSEN_PROVIDER_VALUE}
                onChange={(event) => {
                  const nextProvider = selectableAiProviderIdSchema.parse(event.target.value)
                  saveProvider(nextProvider)
                }}
              >
                {provider === null && (
                  <option value={UNCHOSEN_PROVIDER_VALUE} disabled>
                    Choose a provider…
                  </option>
                )}
                {TERMINAL_PROVIDER_ORDER.map((providerId) => (
                  <option key={providerId} value={providerId}>
                    {TERMINAL_PROVIDERS[providerId].label}
                  </option>
                ))}
              </select>
            </label>
            {/* Model suggestions depend on the provider, so the control waits for that choice. */}
            {provider !== null && (
              <>
                <label className={styles.field}>
                  Model
                  <select
                    className={styles.select}
                    value={
                      usingCustomModel
                        ? "__custom__"
                        : (settings.providers[provider].selectedModel ?? "__cli_default__")
                    }
                    onChange={(event) => {
                      const nextValue = event.target.value
                      if (nextValue === "__custom__") {
                        setUsingCustomModel(true)
                        return
                      }

                      setUsingCustomModel(false)
                      saveModel(provider, nextValue === "__cli_default__" ? null : nextValue)
                    }}
                  >
                    <option value="__cli_default__">CLI default</option>
                    {TERMINAL_PROVIDERS[provider].modelSuggestions.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                    <option value="__custom__">Custom model ID…</option>
                  </select>
                </label>
                {usingCustomModel && (
                  <label className={styles.field}>
                    Custom model ID
                    <input
                      className={styles.input}
                      value={customModel}
                      onChange={(event) => setCustomModel(event.target.value)}
                      onBlur={() => saveCustomModel(provider)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur()
                      }}
                    />
                  </label>
                )}
                <CustomShortcutsEditor
                  shortcuts={customShortcuts}
                  onAdd={addShortcut}
                  onRemove={removeShortcut}
                />
              </>
            )}
          </div>
        </details>
        {/* Outside the row, so a failed save is seen even after the row is closed. */}
        {saveError && (
          <p className={styles.error} role="alert">
            Couldn&apos;t save the terminal settings: {saveError}
          </p>
        )}
        {isLoading ? (
          <p className={styles.notice}>Loading {terminalLabel}…</p>
        ) : loadError ? (
          <p className={styles.error} role="alert">
            {loadError}
          </p>
        ) : provider === null ? (
          <p className={styles.notice} role="status">
            Choose a provider, then press Start.
          </p>
        ) : (
          // The slot keeps the surface a usable height, the open settings above it yield first.
          <div className={styles.surfaceSlot}>
            {surface === "chat" ? (
              // A provider change swaps the surface, which ends the left one's session.
              // Nothing relaunches on its own.
              <AiChatSurface
                provider={provider}
                shortcuts={promptShortcuts}
                repositoryPath={repositoryPath}
                initialPrompt={chatInitialPrompt}
                model={settings.providers[provider].selectedModel}
                terminalIdentity={terminalIdentity}
                onSessionStarted={onTerminalSessionStarted}
                onSessionEnded={onTerminalSessionEnded}
                context={terminalContext}
              />
            ) : (
              <CodexTerminal
                provider={provider}
                shortcuts={promptShortcuts}
                repositoryPath={repositoryPath}
                initialPrompt={initialPrompt}
                model={settings.providers[provider].selectedModel}
                terminalIdentity={terminalIdentity}
                onSessionStarted={onTerminalSessionStarted}
                onSessionEnded={onTerminalSessionEnded}
                context={terminalContext}
              />
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
