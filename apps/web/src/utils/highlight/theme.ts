// §10 rule: syntax token colors come from the app's OWN tokens (light + dark), never
// a fixed shiki palette. We tokenize with a "sentinel" theme whose scopes map to
// unique marker colors, then map each marker back to a CSS variable — so the rendered
// text auto-flips with the theme exactly like the rest of the UI.

// Marker color per token kind (arbitrary, just has to be unique).
const KEYWORD = "#f00001"
const STRING = "#f00002"
const FUNC = "#f00003"
const TYPE = "#f00004"
const CONST = "#f00005"
const COMMENT = "#f00006"

// Marker -> the design token CSS variable it renders as.
export const SENTINEL_TO_CSS_VAR: Record<string, string> = {
  [KEYWORD.toLowerCase()]: "--syn-keyword",
  [STRING.toLowerCase()]: "--syn-string",
  [FUNC.toLowerCase()]: "--syn-func",
  [TYPE.toLowerCase()]: "--syn-type",
  [CONST.toLowerCase()]: "--syn-const",
  [COMMENT.toLowerCase()]: "--syn-comment",
}

export const sentinelTheme = {
  name: "prv-sentinel",
  type: "light" as const,
  colors: { "editor.foreground": "#000000" },
  settings: [
    { settings: { foreground: "#000000" } },
    {
      scope: ["keyword", "storage.type", "storage.modifier", "keyword.control"],
      settings: { foreground: KEYWORD },
    },
    {
      scope: ["string", "string.quoted", "string.template", "constant.character"],
      settings: { foreground: STRING },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call",
        "variable.function",
      ],
      settings: { foreground: FUNC },
    },
    {
      scope: [
        "entity.name.type",
        "support.type",
        "entity.other.inherited-class",
        "storage.type.type",
        "entity.name.tag",
      ],
      settings: { foreground: TYPE },
    },
    {
      scope: ["constant", "constant.numeric", "variable.other.constant", "support.constant"],
      settings: { foreground: CONST },
    },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: COMMENT },
    },
  ],
}

// Map a shiki token color back to a CSS variable; unmapped tokens are body text.
export function cssVarForColor(color: string | undefined): string {
  if (!color) return "var(--text)"

  const variable = SENTINEL_TO_CSS_VAR[color.toLowerCase()]
  return variable ? `var(${variable})` : "var(--text)"
}
