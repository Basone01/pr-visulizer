import type { HighlighterCore } from "shiki/core"

import { type HighlightLang, highlightLanguageForPath } from "./highlightLanguage"
import { cssVarForColor, sentinelTheme } from "./theme"

// Narrow wrapper around shiki (docs/architecture.md §2.1) — the app depends on this
// module, not shiki's API, so the highlighter is swappable in one place.

export type SyntaxToken = {
  content: string
  cssVar: string // a var(--syn-*) reference, or var(--text)
}

let highlighterPromise: Promise<HighlighterCore> | null = null

// Fine-grained core, dynamically imported: only the grammars `HighlightLang` names + the
// JS regex engine, in a lazy chunk. The shell paints first (plain text) and swaps in syntax
// colors once this arrives — highlighting never blocks the diff.
function loadHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise

  highlighterPromise = (async () => {
    const [
      { createHighlighterCore },
      { createJavaScriptRegexEngine },
      typescript,
      tsx,
      javascript,
      shellscript,
      yaml,
      json,
      jsonc,
      docker,
      { brunoLanguage },
    ] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/tsx.mjs"),
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/shellscript.mjs"),
      import("shiki/langs/yaml.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/jsonc.mjs"),
      import("shiki/langs/docker.mjs"),
      import("./grammars/bruno"),
    ])

    return createHighlighterCore({
      themes: [sentinelTheme],
      langs: [
        typescript.default,
        tsx.default,
        javascript.default,
        shellscript.default,
        yaml.default,
        json.default,
        jsonc.default,
        docker.default,
        brunoLanguage,
      ],
      engine: createJavaScriptRegexEngine(),
    })
  })()

  return highlighterPromise
}

export type LineTokenizer = (lineText: string) => SyntaxToken[]

// Resolve a per-line tokenizer for one file path. Tokenizing line-by-line keeps the
// diff renderer simple; multiline constructs are rare in a hunk and degrade to plain
// text, never to a crash.
export async function createLineTokenizer(path: string | null): Promise<LineTokenizer> {
  const highlighter = await loadHighlighter()
  // Go/PHP/Python still borrow the TypeScript grammar until they get their own.
  const lang: HighlightLang = highlightLanguageForPath(path) ?? "typescript"

  return (lineText: string): SyntaxToken[] => {
    if (lineText.length === 0) return [{ content: "", cssVar: "var(--text)" }]

    const { tokens } = highlighter.codeToTokens(lineText, {
      lang,
      theme: sentinelTheme.name,
    })

    // One input line -> one row of themed tokens.
    const row = tokens[0] ?? []
    return row.map((token) => ({ content: token.content, cssVar: cssVarForColor(token.color) }))
  }
}
