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

// `fullFile` defaults IN THE SCHEMA, not just in the constant: a record persisted before the
// toggle existed carries only wrap + hideWhitespace, and a required field would fail the parse
// and silently reset the reviewer's other two toggles to their defaults.
const diffViewSettingsSchema = z.object({
  wrap: z.boolean(),
  hideWhitespace: z.boolean(),
  fullFile: z.boolean().default(false),
})

export type DiffViewSettingsApi = {
  settings: DiffViewSettings
  isLoaded: boolean
  toggleWrap: () => void
  toggleHideWhitespace: () => void
  toggleFullFile: () => void
}

export function useDiffViewSettings(store: KeyValueStore = getAppStorage()): DiffViewSettingsApi {
  const [settings, setSettings] = useState<DiffViewSettings>(DEFAULT_DIFF_VIEW_SETTINGS)
  const [isLoaded, setIsLoaded] = useState(false)

  // The latest settings, read by the toggles without re-creating them on every change.
  const settingsRef = useRef<DiffViewSettings>(DEFAULT_DIFF_VIEW_SETTINGS)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    let active = true

    void store.get(DIFF_VIEW_SETTINGS_KEY).then((raw) => {
      if (!active) return

      const parsed = raw === null ? null : diffViewSettingsSchema.safeParse(JSON.parse(raw))
      setSettings(parsed?.success ? parsed.data : DEFAULT_DIFF_VIEW_SETTINGS)
      setIsLoaded(true)
    })

    return () => {
      active = false
    }
  }, [store])

  const commit = useCallback(
    (next: DiffViewSettings) => {
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

  return { settings, isLoaded, toggleWrap, toggleHideWhitespace, toggleFullFile }
}
