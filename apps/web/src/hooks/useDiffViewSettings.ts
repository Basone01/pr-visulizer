import { useCallback, useEffect, useRef, useState } from "react"
import { z } from "zod"

import { DEFAULT_DIFF_VIEW_SETTINGS, type DiffViewSettings } from "@/config/settings"

import { type KeyValueStore } from "@/utils/storage/keyValueStore"

import { getAppStorage } from "@/service/clientFactory"

// Owns the diff-view preferences (§10): loads them from the app storage on mount, applies the
// defaults until they land, and persists every toggle. Same persistence shape as the watched-
// repo list — parsed-don't-trusted on read so a corrupt/stale value falls back to defaults. The
// `store` is injectable so tests exercise it against an in-memory KeyValueStore.

const DIFF_VIEW_SETTINGS_KEY = "diffViewSettings"

// Every late-added toggle defaults IN THE SCHEMA, not just in the constant: a record persisted
// before it existed carries only the fields of its day, and a required field would fail the parse
// and silently reset the reviewer's other toggles to their defaults.
const diffViewSettingsSchema = z.object({
  wrap: z.boolean(),
  hideWhitespace: z.boolean(),
  fullFile: z.boolean().default(false),
  splitView: z.boolean().default(false),
  intraLineDiff: z.boolean().default(false),
  markdownPreview: z.boolean().default(false),
  markdownRichDiff: z.boolean().default(false),
})

export type DiffViewSettingsApi = {
  settings: DiffViewSettings
  isLoaded: boolean
  toggleWrap: () => void
  toggleHideWhitespace: () => void
  toggleFullFile: () => void
  toggleSplitView: () => void
  toggleIntraLineDiff: () => void
  toggleMarkdownPreview: () => void
  toggleMarkdownRichDiff: () => void
}

export function useDiffViewSettings(store: KeyValueStore = getAppStorage()): DiffViewSettingsApi {
  const [settings, setSettings] = useState<DiffViewSettings>(DEFAULT_DIFF_VIEW_SETTINGS)
  const [isLoaded, setIsLoaded] = useState(false)

  // The latest settings, read by the toggles without re-creating them on every change.
  const settingsRef = useRef<DiffViewSettings>(DEFAULT_DIFF_VIEW_SETTINGS)

  // Has the reviewer changed anything yet? The initial read is a snapshot of what was on disk
  // BEFORE they touched the toolbar, so applying it after a toggle is a revert, not a load — and
  // the desktop's Tauri store is slow enough (an IPC round trip) for a click to land inside that
  // window. Once a toggle has committed, the in-flight read is stale and gets dropped.
  const hasLocalEdit = useRef(false)

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    let active = true

    void store.get(DIFF_VIEW_SETTINGS_KEY).then((raw) => {
      if (!active) return

      const parsed = raw === null ? null : diffViewSettingsSchema.safeParse(JSON.parse(raw))
      if (!hasLocalEdit.current)
        setSettings(parsed?.success ? parsed.data : DEFAULT_DIFF_VIEW_SETTINGS)
      setIsLoaded(true)
    })

    return () => {
      active = false
    }
  }, [store])

  const commit = useCallback(
    (next: DiffViewSettings) => {
      hasLocalEdit.current = true
      settingsRef.current = next
      setSettings(next)
      void store.set(DIFF_VIEW_SETTINGS_KEY, JSON.stringify(next))
    },
    [store]
  )

  const toggleWrap = useCallback(
    () => commit({ ...settingsRef.current, wrap: !settingsRef.current.wrap }),
    [commit]
  )

  const toggleHideWhitespace = useCallback(
    () => commit({ ...settingsRef.current, hideWhitespace: !settingsRef.current.hideWhitespace }),
    [commit]
  )

  const toggleFullFile = useCallback(
    () => commit({ ...settingsRef.current, fullFile: !settingsRef.current.fullFile }),
    [commit]
  )

  const toggleSplitView = useCallback(
    () => commit({ ...settingsRef.current, splitView: !settingsRef.current.splitView }),
    [commit]
  )

  const toggleIntraLineDiff = useCallback(
    () => commit({ ...settingsRef.current, intraLineDiff: !settingsRef.current.intraLineDiff }),
    [commit]
  )

  const toggleMarkdownPreview = useCallback(
    () => commit({ ...settingsRef.current, markdownPreview: !settingsRef.current.markdownPreview }),
    [commit]
  )

  const toggleMarkdownRichDiff = useCallback(
    () =>
      commit({ ...settingsRef.current, markdownRichDiff: !settingsRef.current.markdownRichDiff }),
    [commit]
  )

  return {
    settings,
    isLoaded,
    toggleWrap,
    toggleHideWhitespace,
    toggleFullFile,
    toggleSplitView,
    toggleIntraLineDiff,
    toggleMarkdownPreview,
    toggleMarkdownRichDiff,
  }
}
