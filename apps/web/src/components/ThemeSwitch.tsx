import { THEME_PREFERENCES, type ThemePreference } from "@/utils/theme/theme"

import { useTheme } from "@/hooks/useTheme"

import styles from "./ThemeSwitch.module.css"

// Segmented control with all three states visible at once — recognition over recall, and no
// hidden state to guess (unlike a cycling button). Each segment is its own target ≥24px.
const OPTIONS: Record<ThemePreference, { icon: string; label: string }> = {
  system: { icon: "🖥", label: "System theme (match OS)" },
  light: { icon: "☀", label: "Light theme" },
  dark: { icon: "🌙", label: "Dark theme" },
}

export function ThemeSwitch() {
  const { preference, setPreference } = useTheme()

  return (
    <div className={styles.group} role="group" aria-label="Theme">
      {THEME_PREFERENCES.map((value) => {
        const active = value === preference
        return (
          <button
            key={value}
            type="button"
            className={`${styles.segment} ${active ? styles.active : ""}`}
            aria-pressed={active}
            aria-label={OPTIONS[value].label}
            title={OPTIONS[value].label}
            onClick={() => setPreference(value)}
          >
            <span aria-hidden="true">{OPTIONS[value].icon}</span>
          </button>
        )
      })}
    </div>
  )
}
