import type { AiReviewTarget } from "@pr-visulizer/shared"
import { useEffect, useMemo, useState } from "react"

import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import { CODEX_MODEL_SUGGESTIONS } from "@/entity/aiReviewSettings"

import { createAiReviewSettingsStorage } from "@/service/aiReview/settingsStorage"

import { findRepoLink, loadRepoLinks } from "@/tauri/repoLinks"

import styles from "./AiReviewPanel.module.css"
import { CodexTerminal } from "./CodexTerminal"

type AiReviewPanelProps = {
  target: AiReviewTarget
  storage: KeyValueStore
  title: string
  baseSha: string
  headSha: string
  currentFilePath: string | null
  onTerminalSessionStarted: (sessionId: string) => void
  onTerminalSessionEnded: (sessionId: string) => void
}

function createInitialPrompt(input: {
  target: AiReviewTarget
  title: string
  baseSha: string
  headSha: string
  currentFilePath: string | null
}): string {
  const prUrl = `https://github.com/${input.target.owner}/${input.target.repo}/pull/${input.target.number}`
  const selectedFile = input.currentFilePath ?? "No file is selected."

  return [
    "You are helping review a GitHub pull request in this repository.",
    `PR: ${prUrl}`,
    `Title: ${input.title}`,
    `Base commit: ${input.baseSha}`,
    `Head commit: ${input.headSha}`,
    `Selected file: ${selectedFile}`,
    "The current checkout may not be the PR head. Do not change branches, checkout commits, edit files, or run destructive commands.",
    `Inspect the PR with git diff ${input.baseSha}...${input.headSha} and git show ${input.headSha}:<path> as needed.`,
    "Keep terminal replies brief. For a longer explanation, summary, or review result, call render_answer with a title, Markdown, and optional changed-file references.",
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
  onTerminalSessionStarted,
  onTerminalSessionEnded,
}: AiReviewPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [repositoryPath, setRepositoryPath] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [customModel, setCustomModel] = useState("")
  const [usingCustomModel, setUsingCustomModel] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setIsLoading(true)
    setLoadError(null)
    void Promise.all([loadRepoLinks(storage), createAiReviewSettingsStorage(storage).load()])
      .then(([links, settings]) => {
        if (!active) return

        setRepositoryPath(findRepoLink(links, target)?.path ?? null)
        const model = settings.providers.codex.selectedModel
        const knownModel = CODEX_MODEL_SUGGESTIONS.some((option) => option.id === model)
        setSelectedModel(model)
        setUsingCustomModel(model !== null && !knownModel)
        setCustomModel(model ?? "")
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
  const terminalIdentity = `${target.owner}/${target.repo}#${target.number}:${baseSha}:${headSha}`

  function saveModel(nextModel: string | null): void {
    setSelectedModel(nextModel)
    setSaveError(null)
    void createAiReviewSettingsStorage(storage)
      .saveSelectedModel("codex", nextModel)
      .catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : String(error))
      })
  }

  function saveCustomModel(): void {
    const model = customModel.trim()
    if (model) saveModel(model)
  }

  return (
    <aside className={`${styles.panel} ${collapsed ? styles.collapsed : ""}`} aria-label="Codex">
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? "Show Codex" : "Codex · Hide"}
      </button>

      <div className={styles.content}>
        <label className={styles.field}>
          Model
          <select
            className={styles.select}
            value={usingCustomModel ? "__custom__" : (selectedModel ?? "__cli_default__")}
            onChange={(event) => {
              const nextValue = event.target.value
              if (nextValue === "__custom__") {
                setUsingCustomModel(true)
                return
              }

              setUsingCustomModel(false)
              saveModel(nextValue === "__cli_default__" ? null : nextValue)
            }}
          >
            <option value="__cli_default__">CLI default</option>
            {CODEX_MODEL_SUGGESTIONS.map((model) => (
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
              onBlur={saveCustomModel}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur()
              }}
            />
          </label>
        )}
        {saveError && (
          <p className={styles.error} role="alert">
            Couldn&apos;t save the model: {saveError}
          </p>
        )}
        {isLoading ? (
          <p className={styles.notice}>Loading Codex terminal…</p>
        ) : loadError ? (
          <p className={styles.error} role="alert">
            {loadError}
          </p>
        ) : (
          <CodexTerminal
            repositoryPath={repositoryPath}
            initialPrompt={initialPrompt}
            model={selectedModel}
            terminalIdentity={terminalIdentity}
            onSessionStarted={onTerminalSessionStarted}
            onSessionEnded={onTerminalSessionEnded}
            context={{
              owner: target.owner,
              repo: target.repo,
              number: target.number,
              title,
              baseSha,
              headSha,
              selectedFilePath: currentFilePath,
            }}
          />
        )}
      </div>
    </aside>
  )
}
