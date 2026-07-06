import { posix } from "node:path"

// Resolve a RELATIVE import specifier to a repo path (docs/architecture.md §5 step 6).
// Repo paths are always POSIX (forward slashes) — GitHub serves them that way.
// Aliased specifiers (`@app/...`) need the repo's tsconfig at headSha (the "alias
// hack", §6) and are out of the fast-engine MVP — this returns null for them.

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const

// NodeNext source often imports with a `.js` extension even though the file is
// `.ts`; strip any known source extension before re-resolving against real files.
function stripSourceExtension(path: string): string {
  for (const extension of SOURCE_EXTENSIONS) {
    if (path.endsWith(extension)) return path.slice(0, -extension.length)
  }

  return path
}

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

// Candidate repo paths a relative specifier could resolve to, most specific first:
// the file itself (`.ts`/`.tsx`/…), then a directory `index` file.
export function resolutionCandidates(fromPath: string, specifier: string): string[] {
  const base = stripSourceExtension(posix.join(posix.dirname(fromPath), specifier))

  const direct = SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`)
  const indexed = SOURCE_EXTENSIONS.map((extension) => posix.join(base, `index${extension}`))

  return [...direct, ...indexed]
}

// Resolve to whichever candidate actually exists in the given path set (the changed
// files). Returns null when nothing matches — the import is to unchanged/external
// code and does not become a graph edge (§5 step 6).
export function resolveToKnownPath(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>
): string | null {
  if (!isRelativeSpecifier(specifier)) return null

  for (const candidate of resolutionCandidates(fromPath, specifier)) {
    if (knownPaths.has(candidate)) return candidate
  }

  return null
}
