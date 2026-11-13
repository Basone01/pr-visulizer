import type { ThemeProps } from "@openuidev/react-ui"

// OpenUI theme keys → the app's design tokens (design/tokens.css).
// ThemeProvider writes each value into a `--openui-*` variable on the block container,
// so `var(--panel)` resolves against whatever light/dark tokens the app has active.
// One map serves both modes, because the tokens themselves already switch with the app theme.
// Keys not listed keep OpenUI's defaults for the active mode (spacing, radii, chart palette, …).
export const APP_TOKEN_THEME = {
  background: "var(--panel)",
  foreground: "var(--panel)",
  popoverBackground: "var(--panel)",
  sunkLight: "var(--bg)",
  sunk: "var(--code-bg)",
  sunkDeep: "var(--code-bg)",

  textNeutralPrimary: "var(--text)",
  textNeutralSecondary: "var(--muted)",
  textNeutralTertiary: "var(--muted)",
  textNeutralLink: "var(--accent)",
  textBrand: "var(--accent)",
  // Text drawn on an accent-filled button.
  textAccentPrimary: "var(--panel)",

  interactiveAccentDefault: "var(--accent)",
  interactiveAccentHover: "var(--accent)",
  interactiveAccentPressed: "var(--accent)",

  borderDefault: "var(--border)",
  borderInteractive: "var(--border)",
  borderInteractiveEmphasis: "var(--muted)",
  borderInteractiveSelected: "var(--accent)",
  borderAccent: "var(--accent-soft)",
  borderAccentEmphasis: "var(--accent)",

  infoBackground: "var(--accent-soft)",
  textInfoPrimary: "var(--accent)",
  borderInfoEmphasis: "var(--accent)",
  successBackground: "var(--added-soft)",
  textSuccessPrimary: "var(--added)",
  borderSuccessEmphasis: "var(--added)",
  alertBackground: "var(--modified-soft)",
  textAlertPrimary: "var(--modified)",
  borderAlertEmphasis: "var(--modified)",
  dangerBackground: "var(--deleted-soft)",
  textDangerPrimary: "var(--deleted)",
  borderDangerEmphasis: "var(--deleted)",

  // Inherit the app's type instead of OpenUI's "Inter" (not loaded in this app).
  fontBody: "inherit",
  fontHeading: "inherit",
  fontLabel: "inherit",
  fontNumbers: "inherit",
  fontCode: 'ui-monospace, "SF Mono", Menlo, monospace',
} satisfies NonNullable<ThemeProps["lightTheme"]>
