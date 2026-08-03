// Which changed files can be previewed as rendered markdown.
//
// Decided by EXTENSION, not by `ChangedFile.language`: that field carries a tree-sitter grammar
// id and is null for markdown (packages/engine/src/utils/language.ts ships no `.md` grammar), so
// it can never answer this question.
//
// `.mdx` is deliberately excluded — MDX is JSX-in-markdown, and rendering it through a plain
// markdown renderer would silently drop every component and show a wrong document.
const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase()

  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension))
}
