// Parse a `go.mod` for its module path (docs/architecture.md §6, deep-engine v1).
// The module path is the prefix every intra-repo import carries: an import
// `example.com/proj/pkg/metrics` under `module example.com/proj` maps to the repo
// directory `pkg/metrics`. Pure string logic — no domain coupling, no IO (utils leaf).

const MODULE_DIRECTIVE = /^\s*module\s+(\S+)\s*$/

// The declared module path, or null when the file has no `module` line. Comments
// and blank lines are skipped; the first `module` directive wins (go.mod allows one).
export function parseGoModulePath(source: string): string | null {
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "") // strip a trailing line comment
    const match = MODULE_DIRECTIVE.exec(line)
    if (match?.[1]) return match[1]
  }

  return null
}
