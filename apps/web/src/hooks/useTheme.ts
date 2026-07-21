import { useCallback, useState } from "react"

import {
  type ThemePreference,
  applyPreference,
  readStoredPreference,
  storePreference,
} from "@/utils/theme/theme"

// Holds the current theme preference and applies it. The initial value matches what the
// index.html boot script already stamped, so mounting the hook re-reads rather than re-applies
// (no flash). Changing it stamps <html> and persists in one step.
export function useTheme(): {
  preference: ThemePreference
  setPreference: (next: ThemePreference) => void
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference)

  const setPreference = useCallback((next: ThemePreference): void => {
    applyPreference(next)
    storePreference(next)
    setPreferenceState(next)
  }, [])

  return { preference, setPreference }
}
