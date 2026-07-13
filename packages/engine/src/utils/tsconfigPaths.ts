import { parseJsonc } from "./jsonc.js"
import { dirname, join } from "./posixPath.js"

// tsconfig `paths` alias resolution (docs/architecture.md §6, "the alias hack"). Without it a
// repo-wide TS analysis loses every `@/…` import — measured on a real monorepo, 2121 of 3533
// imports (60%) resolved to nothing, so most files had no dependency edges at all.
//
// The subtlety that shapes this file: one repo can hold SEVERAL tsconfigs that each map the
// SAME alias to a DIFFERENT root (verified on wisesight/analytics-suite — `web/`,
// `zem-web/` and `worker/export-summary-powerpoint/` all define `@/*`, each pointing at their
// own `src`). A single global alias table would silently mis-resolve across sub-projects, so an
// importing file resolves against the NEAREST ancestor tsconfig that declares `paths`.
//
// Known misses, deliberate: `extends` is not followed (a `paths` block inherited from a base
// config is invisible), and only a single trailing `*` wildcard is supported — the shape ~all
// real configs use.

export type AliasEntry = {
  // Directory of the tsconfig that declared this alias, as a repo path ("." at the root).
  dir: string
  // The text before the `*` in the alias pattern, e.g. "@/" for "@/*". An exact (starless)
  // pattern has `wildcard: false` and matches the specifier whole.
  prefix: string
  wildcard: boolean
  // Repo-path prefixes the alias expands to, in declaration order (TS tries each in turn).
  targets: string[]
}

export type AliasTable = readonly AliasEntry[]

export const EMPTY_ALIAS_TABLE: AliasTable = []

const TSCONFIG_BASENAME = "tsconfig.json"

// Is `path` inside `dir` (or is `dir` the repo root)?
function isAncestorDir(dir: string, path: string): boolean {
  return dir === "." || path.startsWith(`${dir}/`)
}

// Depth of a repo dir, so the NEAREST declaring tsconfig can win.
function depthOf(dir: string): number {
  return dir === "." ? 0 : dir.split("/").length
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null

  return value as Record<string, unknown>
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return value.filter((item): item is string => typeof item === "string")
}

// TypeScript resolves `paths` targets against `baseUrl` when it is set, and against the
// tsconfig's own directory otherwise. Both appear in the wild: analytics-suite's `web/`
// uses `baseUrl: "./src/"` with `"@/*": ["*"]`, while its `zem-web/` uses no baseUrl with
// `"@/*": ["./src/*"]` — the two must land on the same place.
function targetBaseDir(tsconfigDir: string, baseUrl: unknown): string {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return tsconfigDir

  return join(tsconfigDir, baseUrl)
}

function entriesFromTsconfig(path: string, text: string): AliasEntry[] {
  const parsed = asRecord(parseJsonc(text))
  const compilerOptions = parsed && asRecord(parsed.compilerOptions)
  const paths = compilerOptions && asRecord(compilerOptions.paths)
  if (!paths) return []

  const dir = dirname(path)
  const baseDir = targetBaseDir(dir, compilerOptions.baseUrl)

  const entries: AliasEntry[] = []
  for (const [pattern, rawTargets] of Object.entries(paths)) {
    const starIndex = pattern.indexOf("*")
    // Only a trailing wildcard is supported; a mid-pattern `*` is rare and would need
    // suffix matching, so it is skipped rather than half-resolved.
    if (starIndex >= 0 && starIndex !== pattern.length - 1) continue

    const targets = asStringArray(rawTargets)
      .map((target) => (target.endsWith("*") ? target.slice(0, -1) : target))
      .map((target) => join(baseDir, target))
    if (targets.length === 0) continue

    entries.push({
      dir,
      prefix: starIndex >= 0 ? pattern.slice(0, -1) : pattern,
      wildcard: starIndex >= 0,
      targets,
    })
  }

  return entries
}

// Build the repo's alias table from the already-read checkout contents — the same pattern the
// deep engine uses for `go.mod` (findGoModule), so no new I/O seam is introduced. Entries are
// sorted deepest-tsconfig-first, which makes "nearest declaring config wins" a plain find().
export function buildAliasTable(contents: ReadonlyMap<string, string>): AliasTable {
  const entries: AliasEntry[] = []

  for (const [path, text] of contents) {
    if (path !== TSCONFIG_BASENAME && !path.endsWith(`/${TSCONFIG_BASENAME}`)) continue

    entries.push(...entriesFromTsconfig(path, text))
  }

  return entries.sort((a, b) => depthOf(b.dir) - depthOf(a.dir))
}

// The repo paths (without file extension) an aliased specifier could name, for the tsconfig
// nearest the importing file. Empty when the specifier matches no alias in scope — a bare
// package import like "react" stays external, exactly as before.
export function aliasCandidateBases(
  fromPath: string,
  specifier: string,
  table: AliasTable
): string[] {
  for (const entry of table) {
    if (!isAncestorDir(entry.dir, fromPath)) continue

    if (entry.wildcard) {
      if (!specifier.startsWith(entry.prefix)) continue

      const rest = specifier.slice(entry.prefix.length)
      return entry.targets.map((target) => join(target, rest))
    }

    if (specifier !== entry.prefix) continue

    return [...entry.targets]
  }

  return []
}
