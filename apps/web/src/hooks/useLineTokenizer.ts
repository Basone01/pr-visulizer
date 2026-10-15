import { useEffect, useState } from "react"

import { highlightLanguageForPath } from "@/utils/highlight/highlightLanguage"
import { type LineTokenizer, createLineTokenizer } from "@/utils/highlight/highlighter"

// Loads the shiki tokenizer for a file path asynchronously. Returns null until ready;
// the diff renderer shows plain text meanwhile, so highlighting never blocks paint.
export function useLineTokenizer(path: string | null): LineTokenizer | null {
  const [tokenizer, setTokenizer] = useState<LineTokenizer | null>(null)
  // Keyed on the grammar, not the path: moving between two files of the same language
  // keeps the tokenizer instead of flashing plain text for a frame.
  const language = highlightLanguageForPath(path)

  useEffect(() => {
    let active = true
    setTokenizer(null)

    void createLineTokenizer(path).then((next) => {
      if (active) setTokenizer(() => next)
    })

    return () => {
      active = false
    }
  }, [language])

  return tokenizer
}
