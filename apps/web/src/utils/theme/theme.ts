// Theme preference: the one setting that varies, with a sane default of "system".
// "system" is modelled as the ABSENCE of a data-theme attribute — tokens.css already resolves
// the OS preference through @media (prefers-color-scheme). "light"/"dark" stamp data-theme to
// override that. So the whole switcher does one thing: set or clear one attribute on <html>.
export type ThemePreference = "system" | "light" | "dark"

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"]

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system"

// A dedicated localStorage key, read synchronously at boot (index.html) to avoid a flash.
// NOT the async KeyValueStore (Tauri Store is a Promise) — the first paint can't await.
export const THEME_STORAGE_KEY = "prv-theme"

// Parse-don't-trust: an unknown/absent stored value falls back to the default.
export function resolvePreference(raw: string | null): ThemePreference {
  return THEME_PREFERENCES.includes(raw as ThemePreference)
    ? (raw as ThemePreference)
    : DEFAULT_THEME_PREFERENCE
}

// The data-theme value a preference applies — null means "remove the attribute" (system).
export function attributeFor(preference: ThemePreference): "light" | "dark" | null {
  return preference === "system" ? null : preference
}

// Stored string → the data-theme that ends up on <html>. The pure heart the boot script and
// the React hook both go through; unit-tested directly.
export function appliedAttribute(raw: string | null): "light" | "dark" | null {
  return attributeFor(resolvePreference(raw))
}

// Cycle order for a single-button toggle: system → light → dark → system.
export function nextPreference(preference: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(preference)
  const next = THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length]
  return next ?? DEFAULT_THEME_PREFERENCE
}

// Side effect at the edge: stamp or clear the attribute on the document root.
export function applyPreference(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement
): void {
  const attribute = attributeFor(preference)
  if (attribute) root.setAttribute("data-theme", attribute)
  else root.removeAttribute("data-theme")
}

export function readStoredPreference(): ThemePreference {
  try {
    return resolvePreference(window.localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    // Private-mode / disabled storage — fall back to the default rather than crash boot.
    return DEFAULT_THEME_PREFERENCE
  }
}

export function storePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Non-fatal: the choice just won't persist across reloads.
  }
}
