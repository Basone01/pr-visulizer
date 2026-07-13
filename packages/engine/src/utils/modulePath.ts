import { dirname, join } from "./posixPath.js"
import { type AliasTable, EMPTY_ALIAS_TABLE, aliasCandidateBases } from "./tsconfigPaths.js"

// Resolve an import specifier to a repo path (docs/architecture.md §5 step 6).
// Repo paths are always POSIX (forward slashes) — GitHub serves them that way.
//
// Two specifier shapes resolve: RELATIVE (`./x`, `../y`) always, and ALIASED (`@/x`) when the
// caller supplies the repo's tsconfig alias table (the "alias hack", §6). The deep engine
// builds that table from the checkout it already read; the fast engine only ever holds the
// CHANGED files, never the tsconfig, so it passes none and aliased specifiers stay unresolved
// there. A bare package import ("react") resolves to null in both — it is external.

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

// The repo paths a resolved BASE (an extension-less path) could name, most specific first:
// the file itself (`.ts`/`.tsx`/…), then a directory `index` file.
function candidatesForBase(base: string): string[] {
  const direct = SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`)
  const indexed = SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`))

  return [...direct, ...indexed]
}

// Candidate repo paths a relative specifier could resolve to.
export function resolutionCandidates(fromPath: string, specifier: string): string[] {
  return candidatesForBase(stripSourceExtension(join(dirname(fromPath), specifier)))
}

// Resolve to whichever candidate actually exists in the given path set (the changed files in
// fast mode, the whole checkout in deep mode). Returns null when nothing matches — the import
// is to unchanged/external code and does not become a graph edge (§5 step 6).
export function resolveToKnownPath(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
  aliases: AliasTable = EMPTY_ALIAS_TABLE
): string | null {
  const bases = isRelativeSpecifier(specifier)
    ? [stripSourceExtension(join(dirname(fromPath), specifier))]
    : aliasCandidateBases(fromPath, specifier, aliases).map(stripSourceExtension)

  for (const base of bases) {
    for (const candidate of candidatesForBase(base)) {
      if (knownPaths.has(candidate)) return candidate
    }
  }

  return null
}
