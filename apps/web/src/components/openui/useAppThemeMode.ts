import { useEffect, useSyncExternalStore } from "react"

import { DARK_SCHEME_QUERY, THEME_ATTRIBUTE, resolvedThemeMode } from "@/utils/theme/theme"

export type AppThemeMode = "light" | "dark"

// OpenUI's stylesheet pins its :root defaults with this attribute. Radix portals render under
// <body>, outside the block container, so they only match the app theme through it.
const OPENUI_THEME_ATTRIBUTE = "data-openui-theme"

function readServerThemeMode(): AppThemeMode {
  return "light"
}

function readAppThemeMode(): AppThemeMode {
  return resolvedThemeMode()
}

// The resolved mode changes when the app theme attribute or the OS preference changes.
function subscribeToAppTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  })
  const schemeQuery = window.matchMedia?.(DARK_SCHEME_QUERY)
  schemeQuery?.addEventListener("change", onChange)

  return () => {
    observer.disconnect()
    schemeQuery?.removeEventListener("change", onChange)
  }
}

// The app's resolved light/dark mode, live. Also pins OpenUI's document-level theme to it.
export function useAppThemeMode(): AppThemeMode {
  const mode = useSyncExternalStore(subscribeToAppTheme, readAppThemeMode, readServerThemeMode)

  useEffect(() => {
    document.documentElement.setAttribute(OPENUI_THEME_ATTRIBUTE, mode)
  }, [mode])

  return mode
}
