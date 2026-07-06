import type { HighlighterCore } from "shiki/core"

import { cssVarForColor, sentinelTheme } from "./theme"

// Narrow wrapper around shiki (docs/architecture.md §2.1) — the app depends on this
// module, not shiki's API, so the highlighter is swappable in one place.

export type SyntaxToken = {
  content: string
  cssVar: string // a var(--syn-*) reference, or var(--text)
}

const LANGS = ["typescript", "tsx", "javascript"] as const
type SupportedLang = (typeof LANGS)[number]

let highlighterPromise: Promise<HighlighterCore> | null = null

// Fine-grained core, dynamically imported: only the 3 grammars we ship + the JS regex
// engine, in a lazy chunk. The shell paints first (plain text) and swaps in syntax
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
    ] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/tsx.mjs"),
      import("shiki/langs/javascript.mjs"),
    ])

    return createHighlighterCore({
      themes: [sentinelTheme],
      langs: [typescript.default, tsx.default, javascript.default],
      engine: createJavaScriptRegexEngine(),
    })
  })()

  return highlighterPromise
}

function normalizeLang(language: string | null): SupportedLang {
  if (language && (LANGS as readonly string[]).includes(language)) {
    return language as SupportedLang
  }

  return "typescript"
}

export type LineTokenizer = (lineText: string) => SyntaxToken[]

// Resolve a per-line tokenizer for one language. Tokenizing line-by-line keeps the
// diff renderer simple; multiline constructs are rare in a hunk and degrade to plain
// text, never to a crash.
export async function createLineTokenizer(language: string | null): Promise<LineTokenizer> {
  const highlighter = await loadHighlighter()
  const lang = normalizeLang(language)

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
