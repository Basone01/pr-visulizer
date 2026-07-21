import type { ChangedSymbol } from "@pr-visulizer/shared"

import { type GrammarFamily, familyOfGrammar } from "../../utils/language.js"
import { resolveToKnownPath } from "../../utils/modulePath.js"
import { resolvePhpImport } from "../../utils/phpPath.js"
import { dirname } from "../../utils/posixPath.js"
import { resolvePythonModule, resolvePythonSubmodule } from "../../utils/pythonPath.js"
import { type AliasTable, EMPTY_ALIAS_TABLE } from "../../utils/tsconfigPaths.js"
import type { ModuleSyntax, Reference } from "./treeSitter.js"

// Repo-wide name resolution for deep-engine v1 (docs/architecture.md §6). Given every
// parsed source file at `headSha`, it builds a definition index and resolves each
// reference to the symbol it names — across the WHOLE repo, changed files and unchanged
// alike. That repo-wide reach is the entire reason deep mode exists: per-file fast mode
// can only see a changed file's own imports, so it structurally misses
//   - Go SAME-PACKAGE uses (a sibling file references a type with no import, no qualifier)
//   - unchanged callers of changed code (the blast radius)
//
// This is NAME resolution, not type inference (same honesty as §5 step 7). Known misses
// are documented at the bottom of this file.
//
// The resolution FAMILY (go / ts / php / python) comes from `familyOfGrammar` — the single
// definition of the split, shared with the parse-scoping cuts — never re-derived here.

// A parsed source file the resolver indexes and resolves against.
export type ParsedSource = {
  path: string
  grammarId: string
  syntax: ModuleSyntax
}

// One definition anywhere in the repo. `id` matches the §3 ChangedSymbol id
// (`${path}#${name}`), so a resolved target's id equals the changed-symbol id the engine
// built independently — no cross-referencing needed.
export type Definition = {
  id: string
  path: string
  name: string
  kind: ChangedSymbol["kind"]
  startLine: number
  dir: string
}

// A reference resolved to its definition. `fromPath` is the file the reference sits in
// (a ghost file when unchanged); `line` is the head-version usage line.
export type ResolvedReference = {
  fromPath: string
  line: number
  kind: "call" | "type" | "use"
  target: Definition
}

export type DeepResolution = {
  references: ResolvedReference[]
  // File-level import dependencies (`from` depends on `to`), for ranking edges + blast
  // radius. TS relative imports resolved to a real repo file; Go carries none (its
  // cross-file link is a symbol reference, not a file import — §6 known miss).
  fileImports: Array<{ from: string; to: string }>
}

// A directory+name key for the Go index. The separator is a NUL — it cannot occur in a
// POSIX path or a Go identifier, so the two parts can never run together ambiguously.
const dirNameKey = (dir: string, name: string): string => `${dir}\u0000${name}`

// Every top-level definition, indexed by id and — for Go — by (directory, name) so a
// same-package or cross-package reference resolves without an import path to the file.
function buildDefinitionIndex(sources: ParsedSource[]): {
  byId: Map<string, Definition>
  goByDirName: Map<string, Definition>
  goDirs: Set<string>
} {
  const byId = new Map<string, Definition>()
  const goByDirName = new Map<string, Definition>()
  const goDirs = new Set<string>()

  for (const source of sources) {
    const dir = dirname(source.path)
    const isGo = familyOfGrammar(source.grammarId) === "go"
    if (isGo) goDirs.add(dir)

    for (const symbol of source.syntax.symbols) {
      const definition: Definition = {
        id: `${source.path}#${symbol.name}`,
        path: source.path,
        name: symbol.name,
        kind: symbol.kind,
        startLine: symbol.startLine,
        dir,
      }

      byId.set(definition.id, definition)
      if (isGo && !goByDirName.has(dirNameKey(dir, symbol.name))) {
        goByDirName.set(dirNameKey(dir, symbol.name), definition)
      }
    }
  }

  return { byId, goByDirName, goDirs }
}

// Map a Go import path to the repo directory it names. Prefer the module-relative path
// (`<module>/pkg/metrics` under `module <module>` → `pkg/metrics`); otherwise fall back
// to the longest repo dir that is a path-segment suffix of the import (§6: "match import
// path suffix → repo dir"). Aliases are handled by the caller (they change the qualifier,
// not the path).
function resolveGoImportDir(
  importPath: string,
  goModulePath: string | null,
  goDirs: Set<string>
): string | null {
  if (goModulePath && (importPath === goModulePath || importPath.startsWith(`${goModulePath}/`))) {
    const relative = importPath === goModulePath ? "." : importPath.slice(goModulePath.length + 1)
    if (goDirs.has(relative)) return relative
  }

  let best: string | null = null
  for (const dir of goDirs) {
    if (importPath === dir || importPath.endsWith(`/${dir}`)) {
      if (!best || dir.length > best.length) best = dir
    }
  }

  return best
}

// A local name bound to a symbol in another file. `namespace` marks a whole-module binding
// (`import * as ns` / Python `import a.b as ns`) whose references are always qualified.
type BoundImport = { targetPath: string; importedName: string; namespace?: true }

// A reference's target definition id, for the import models that resolve a plain name straight
// to its symbol (TS/JS and Python). A namespace-qualified reference (`ns.helper()`) names
// `helper` inside the module `ns` points at; a plain one uses the binding's imported name.
function boundTargetId(reference: Reference, bindings: Map<string, BoundImport>): string | null {
  if (reference.qualifier !== undefined) {
    const namespaceBinding = bindings.get(reference.qualifier)
    if (!namespaceBinding?.namespace) return null

    return `${namespaceBinding.targetPath}#${reference.name}`
  }

  const binding = bindings.get(reference.name)
  if (!binding || binding.namespace) return null

  return `${binding.targetPath}#${binding.importedName}`
}

// Resolve one file's references through an already-built binding table, appending each hit to
// `out`. Shared by every family: only the way the bindings are BUILT differs per language.
function resolveBoundReferences(
  source: ParsedSource,
  bindings: Map<string, BoundImport>,
  byId: Map<string, Definition>,
  targetIdOf: (reference: Reference, bindings: Map<string, BoundImport>) => string | null,
  out: DeepResolution
): void {
  for (const reference of source.syntax.references) {
    const targetId = targetIdOf(reference, bindings)
    if (!targetId) continue

    const target = byId.get(targetId)
    if (!target) continue

    out.references.push({
      fromPath: source.path,
      line: reference.line,
      kind: reference.kind,
      target,
    })
  }
}

// Resolve one TS/JS file's references through its (repo-wide) relative-import bindings —
// the fast engine's step 7, but the specifier resolves against the FULL repo file set,
// not just the changed files. Also emits the file-level import dependencies.
function resolveTsFile(
  source: ParsedSource,
  allPaths: ReadonlySet<string>,
  byId: Map<string, Definition>,
  aliases: AliasTable,
  out: DeepResolution
): void {
  const bindings = new Map<string, BoundImport>()

  for (const moduleImport of source.syntax.imports) {
    const targetPath = resolveToKnownPath(source.path, moduleImport.specifier, allPaths, aliases)
    if (!targetPath || targetPath === source.path) continue

    out.fileImports.push({ from: source.path, to: targetPath })
    for (const binding of moduleImport.bindings) {
      bindings.set(binding.localName, {
        targetPath,
        importedName: binding.importedName,
        ...(binding.namespace ? { namespace: true as const } : {}),
      })
    }
  }

  resolveBoundReferences(source, bindings, byId, boundTargetId, out)
}

// Resolve one Python file's references. A dotted or relative import resolves to a repo `.py`
// file; `from a.b import c` binds `c` to `a/b.py#c`, `import a.b as m` is a namespace binding
// (`m.f()` → `a/b.py#f`), and `from . import sub` where `sub` is a SUBMODULE binds it namespace-
// style to `sub.py` so `sub.f()` still resolves. Same reference resolution as TS.
function resolvePythonFile(
  source: ParsedSource,
  allPaths: ReadonlySet<string>,
  byId: Map<string, Definition>,
  out: DeepResolution
): void {
  const bindings = new Map<string, BoundImport>()

  for (const moduleImport of source.syntax.imports) {
    const moduleTarget = resolvePythonModule(source.path, moduleImport.specifier, allPaths)
    const importFile = (to: string): void => {
      if (to !== source.path) out.fileImports.push({ from: source.path, to })
    }

    for (const binding of moduleImport.bindings) {
      if (binding.namespace) {
        if (!moduleTarget) continue

        importFile(moduleTarget)
        bindings.set(binding.localName, {
          targetPath: moduleTarget,
          importedName: "",
          namespace: true,
        })
        continue
      }

      // A named import is a symbol in the module file — unless the name is itself a submodule,
      // in which case it binds namespace-style to that submodule's file.
      const submodule = resolvePythonSubmodule(
        source.path,
        moduleImport.specifier,
        binding.importedName,
        allPaths
      )
      if (submodule) {
        importFile(submodule)
        bindings.set(binding.localName, {
          targetPath: submodule,
          importedName: "",
          namespace: true,
        })
        continue
      }

      if (!moduleTarget) continue

      importFile(moduleTarget)
      bindings.set(binding.localName, {
        targetPath: moduleTarget,
        importedName: binding.importedName,
      })
    }
  }

  resolveBoundReferences(source, bindings, byId, boundTargetId, out)
}

// A PHP reference's target id. A `use`-bound name resolves straight to its symbol; a static
// `Class::method` reads the METHOD off the class binding (qualifier = the class's local name),
// mirroring how Go reads a member off a package qualifier.
function phpTargetId(reference: Reference, bindings: Map<string, BoundImport>): string | null {
  if (reference.qualifier !== undefined) {
    const classBinding = bindings.get(reference.qualifier)
    if (!classBinding) return null

    return `${classBinding.targetPath}#${reference.name}`
  }

  const binding = bindings.get(reference.name)
  if (!binding) return null

  return `${binding.targetPath}#${binding.importedName}`
}

// Resolve one PHP file's references. A `use App\Sub\Class` binds `Class` to the repo file matched
// by namespace suffix; a relative `require`/`include` becomes a file-level dependency only. Same
// reference loop as the others, with the PHP class-qualifier target id.
function resolvePhpFile(
  source: ParsedSource,
  allPaths: ReadonlySet<string>,
  byId: Map<string, Definition>,
  out: DeepResolution
): void {
  const bindings = new Map<string, BoundImport>()

  for (const moduleImport of source.syntax.imports) {
    const targetPath = resolvePhpImport(source.path, moduleImport.specifier, allPaths)
    if (!targetPath || targetPath === source.path) continue

    out.fileImports.push({ from: source.path, to: targetPath })
    for (const binding of moduleImport.bindings) {
      bindings.set(binding.localName, { targetPath, importedName: binding.importedName })
    }
  }

  resolveBoundReferences(source, bindings, byId, phpTargetId, out)
}

type GoIndex = { goByDirName: Map<string, Definition>; goDirs: Set<string> }

// Resolve one Go file's references: unqualified → same directory (same package),
// qualified `pkg.Name` → the imported package's directory. THE same-package case
// (`aggregate.go` uses `Report` with no import) is what fast mode can never see.
function resolveGoFile(
  source: ParsedSource,
  goModulePath: string | null,
  index: GoIndex,
  out: DeepResolution
): void {
  const fromDir = dirname(source.path)

  const qualifierToPath = new Map<string, string>()
  for (const moduleImport of source.syntax.imports) {
    const qualifier = moduleImport.bindings[0]?.localName
    if (qualifier) qualifierToPath.set(qualifier, moduleImport.specifier)
  }

  for (const reference of source.syntax.references) {
    const target =
      reference.qualifier === undefined
        ? index.goByDirName.get(dirNameKey(fromDir, reference.name))
        : resolveQualifiedGo(
            reference.qualifier,
            reference.name,
            qualifierToPath,
            goModulePath,
            index
          )

    if (!target) continue

    out.references.push({
      fromPath: source.path,
      line: reference.line,
      kind: reference.kind,
      target,
    })
  }
}

function resolveQualifiedGo(
  qualifier: string,
  name: string,
  qualifierToPath: Map<string, string>,
  goModulePath: string | null,
  index: GoIndex
): Definition | undefined {
  const importPath = qualifierToPath.get(qualifier)
  if (!importPath) return undefined

  const targetDir = resolveGoImportDir(importPath, goModulePath, index.goDirs)
  if (!targetDir) return undefined

  return index.goByDirName.get(dirNameKey(targetDir, name))
}

// Resolve every reference in the repo to its definition. `allPaths` is the full checkout file
// list (TS relative resolution); `goModulePath` comes from go.mod (Go cross-package);
// `aliases` comes from the checkout's tsconfigs (TS `@/…` resolution). Both are derived from
// `contents` by the caller, so this stays pure.
export function resolveRepo(
  sources: ParsedSource[],
  allPaths: ReadonlySet<string>,
  goModulePath: string | null,
  aliases: AliasTable = EMPTY_ALIAS_TABLE
): DeepResolution {
  const { byId, goByDirName, goDirs } = buildDefinitionIndex(sources)
  const out: DeepResolution = { references: [], fileImports: [] }

  const resolveByFamily: Record<GrammarFamily, (source: ParsedSource) => void> = {
    go: (source) => resolveGoFile(source, goModulePath, { goByDirName, goDirs }, out),
    ts: (source) => resolveTsFile(source, allPaths, byId, aliases, out),
    php: (source) => resolvePhpFile(source, allPaths, byId, out),
    python: (source) => resolvePythonFile(source, allPaths, byId, out),
  }

  for (const source of sources) {
    resolveByFamily[familyOfGrammar(source.grammarId)](source)
  }

  return out
}
