// Path -> shiki grammar id for the diff viewer. Kept apart from the engine's
// `languageForPath`, whose list is pinned to the tree-sitter grammars used for analysis.

export type HighlightLang =
  | "typescript"
  | "tsx"
  | "javascript"
  | "shellscript"
  | "yaml"
  | "json"
  | "jsonc"
  | "docker"
  | "bruno"

// TS family mirrors packages/engine GRAMMAR_BY_EXTENSION so TS highlighting is unchanged.
// Docker compose files are plain YAML, so .yml/.yaml covers them.
const LANG_BY_EXTENSION: Record<string, HighlightLang> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".json": "json",
  ".jsonc": "jsonc",
  ".dockerfile": "docker",
  ".bru": "bruno",
}

const LANG_BY_BASENAME: Record<string, HighlightLang> = {
  ".bashrc": "shellscript",
  ".zshrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zprofile": "shellscript",
  Dockerfile: "docker",
  Containerfile: "docker",
}

const DOCKERFILE_VARIANT_PREFIX = "Dockerfile." // e.g. Dockerfile.dev

export function highlightLanguageForPath(path: string | null): HighlightLang | null {
  if (!path) return null

  const basename = path.slice(path.lastIndexOf("/") + 1)
  const byBasename = LANG_BY_BASENAME[basename]
  if (byBasename) return byBasename

  if (basename.startsWith(DOCKERFILE_VARIANT_PREFIX)) return "docker"

  const dotIndex = basename.lastIndexOf(".")
  if (dotIndex <= 0) return null

  const extension = basename.slice(dotIndex).toLowerCase()
  return LANG_BY_EXTENSION[extension] ?? null
}
