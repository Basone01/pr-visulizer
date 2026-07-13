// A tolerant reader for JSON-with-comments (utils leaf, no domain coupling). `tsconfig.json`
// is JSONC: TypeScript accepts `//` and `/* */` comments and trailing commas, and real repos
// use both — `JSON.parse` rejects them outright.
//
// Hand-rolled rather than pulled from npm: the whole job is one string-aware scan, and the
// engine must stay browser-safe with no new dependency. Call sites depend on this wrapper,
// so swapping in a library later is a one-file change (repo rule: wrap externals).
//
// The scan is string-aware on purpose — a `//` inside a string literal (a URL, a glob) must
// survive, and an escaped quote must not end the string early.

function stripCommentsAndTrailingCommas(text: string): string {
  let out = ""

  let inString = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    const next = text[index + 1]

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        out += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      // A backslash escapes the next character, so `\"` cannot close the string.
      if (char === "\\") {
        out += char + (next ?? "")
        index += 1
        continue
      }

      if (char === '"') inString = false
      out += char
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      continue
    }

    if (char === "/" && next === "/") {
      inLineComment = true
      index += 1
      continue
    }

    if (char === "/" && next === "*") {
      inBlockComment = true
      index += 1
      continue
    }

    out += char
  }

  // A comma followed only by whitespace before a closing brace/bracket is trailing.
  return out.replace(/,(\s*[}\]])/g, "$1")
}

// Parse JSONC. Returns null when the text is not valid JSON even after stripping — a broken
// or exotic config must never sink a whole analysis, exactly like the engine's defensive
// file reader (repoFiles.readRepoSources).
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripCommentsAndTrailingCommas(text))
  } catch {
    return null
  }
}
