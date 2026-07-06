import { useEffect, useState } from "react"

import { type LineTokenizer, createLineTokenizer } from "@/utils/highlight/highlighter"

// Loads the shiki tokenizer for a language asynchronously. Returns null until ready;
// the diff renderer shows plain text meanwhile, so highlighting never blocks paint.
export function useLineTokenizer(language: string | null): LineTokenizer | null {
  const [tokenizer, setTokenizer] = useState<LineTokenizer | null>(null)

  useEffect(() => {
    let active = true
    setTokenizer(null)

    void createLineTokenizer(language).then((next) => {
      if (active) setTokenizer(() => next)
    })

    return () => {
      active = false
    }
  }, [language])

  return tokenizer
}
