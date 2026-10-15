import { useState } from "react"

import {
  type CustomTerminalPromptShortcut,
  SHORTCUT_PLACEHOLDERS,
} from "@/entity/terminalPromptShortcuts"

import type { NewCustomTerminalPromptShortcut } from "@/service/terminal/shortcutStorage"

import styles from "./AiReviewPanel.module.css"

type CustomShortcutsEditorProps = {
  shortcuts: ReadonlyArray<CustomTerminalPromptShortcut>
  // Resolves true once saved, so the form only clears when nothing would be lost.
  onAdd: (shortcut: NewCustomTerminalPromptShortcut) => Promise<boolean>
  onRemove: (id: string) => void
}

const PLACEHOLDER_HELP = `Placeholders: ${SHORTCUT_PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}`

export function CustomShortcutsEditor({ shortcuts, onAdd, onRemove }: CustomShortcutsEditorProps) {
  const [label, setLabel] = useState("")
  const [template, setTemplate] = useState("")
  const isComplete = label.trim() !== "" && template.trim() !== ""

  async function addShortcut(): Promise<void> {
    const saved = await onAdd({ label: label.trim(), template })
    if (!saved) return

    setLabel("")
    setTemplate("")
  }

  return (
    <details className={styles.field}>
      <summary>Custom shortcuts</summary>
      <ul>
        {shortcuts.map((shortcut) => (
          <li key={shortcut.id}>
            {shortcut.label}{" "}
            <button
              type="button"
              aria-label={`Remove ${shortcut.label}`}
              onClick={() => onRemove(shortcut.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <label className={styles.field}>
        Shortcut label
        <input
          className={styles.input}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        Prompt template
        <textarea
          className={styles.input}
          rows={4}
          value={template}
          onChange={(event) => setTemplate(event.target.value)}
        />
      </label>
      <p>{PLACEHOLDER_HELP}</p>
      <button type="button" disabled={!isComplete} onClick={() => void addShortcut()}>
        Add shortcut
      </button>
    </details>
  )
}
