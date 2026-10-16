import type { AiReviewTarget } from "@pr-visulizer/shared"
import { useEffect, useMemo, useState } from "react"

import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import {
  type AiReviewSettings,
  DEFAULT_AI_REVIEW_SETTINGS,
  type SelectableAiProviderId,
  TERMINAL_PROVIDERS,
  TERMINAL_PROVIDER_ORDER,
  selectableAiProviderIdSchema,
} from "@/entity/aiReviewSettings"
import {
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
  onTerminalSessionStarted: (sessionId: string) => void
  onTerminalSessionEnded: (sessionId: string) => void
}

export function createInitialPrompt(input: {
  target: AiReviewTarget
  title: string
  baseSha: string
  headSha: string
  currentFilePath: string | null
}): string {
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
    'The get_current_file tool shows the file and lines the reviewer is looking at right now. Call it when the reviewer says "this file" or "these lines".',
    `If the sem CLI is installed (check with command -v sem), prefer sem diff -v --from ${input.baseSha} --to ${input.headSha} for a semantic, entity-level view of the change, and fall back to git diff when it is missing.`,
    "Whenever an answer mentions a file or line the reviewer may need to open, you must call render_answer successfully before finishing, even for a short answer. Include every mentioned file in fileRefs, with its line when known. Use repo-relative Markdown links or inline paths so the references are clickable. If rendering fails, correct the request and retry, then report any unresolved failure instead of claiming the preview is ready.",
    "Use the terminal for progress, questions, and answers without file references. For longer explanations, summaries, or review results, also prefer render_answer with a title and Markdown. After rendering, keep the terminal reply to a brief confirmation that the answer is in the preview window.",
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

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

  const initialPrompt = useMemo(
    () => createInitialPrompt({ target, title, baseSha, headSha, currentFilePath }),
    [baseSha, currentFilePath, headSha, target, title]
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
  const promptShortcuts = useMemo(
    () => [...TERMINAL_PROMPT_SHORTCUTS, ...customShortcuts.map(toPromptShortcut)],
    [customShortcuts]
  )
  const terminalIdentity = `${target.owner}/${target.repo}#${target.number}:${baseSha}:${headSha}`
  const provider = settings.terminalProvider
  const terminalLabel =
    provider === null ? UNCHOSEN_TERMINAL_LABEL : TERMINAL_PROVIDERS[provider].label

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
  function persist(
    localUpdate: AiReviewSettings,
    save: (settingsStorage: AiReviewSettingsStorage) => Promise<AiReviewSettings>
  ): void {
    setSettings(localUpdate)
    setSaveError(null)
    void save(createAiReviewSettingsStorage(storage)).then(setSettings).catch(showSaveError)
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
    </aside>
  )
}
