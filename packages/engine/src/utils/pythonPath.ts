import { dirname, join } from "./posixPath.js"

// Resolve a Python import specifier to a repo `.py` path (docs/architecture.md §6 deep engine).
// Pure string logic over the checkout's known path set — no IO, no domain coupling (utils leaf).
//
// Two specifier shapes resolve:
//   DOTTED   `a.b.c` → `a/b/c.py` or `a/b/c/__init__.py`, tried from the repo root AND from each
//            ancestor directory of the importing file (Go-style best-effort suffix matching,
//            since the checkout may be rooted at a package parent).
//   RELATIVE `.` / `.mod` / `..pkg.sub` → resolved against the importing file's own directory,
//            one directory up per leading dot beyond the first.
// Known miss: no sys.path / setup.cfg / installed-package map is read (§6 documented-miss style).

const INIT = "__init__.py"

// Normalize a package base to "" at the repo root, so candidate building never emits a stray ".".
function cleanBase(path: string): string {
  const normalized = join(path)
  return normalized === "." ? "" : normalized
}

// The repo files an extension-less module base could be: the module file, or a package __init__.
function fileCandidates(base: string): string[] {
  if (base === "") return [INIT]

  return [`${base}.py`, `${base}/${INIT}`]
}

function firstExisting(candidates: string[], knownPaths: ReadonlySet<string>): string | null {
  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate
  }

  return null
}

// The importing file's directory, then the repo root and every ancestor directory in between —
// the prefixes an absolute dotted import is tried against (root first, then shallow → deep).
function searchPrefixes(fromPath: string): string[] {
  const chain: string[] = []
  let dir = dirname(fromPath)
  while (dir !== "." && dir !== "/" && dir !== "") {
    chain.push(dir)
    dir = dirname(dir)
  }

  return ["", ...chain.reverse()]
}

// The package base a relative specifier points at: the importing file's directory for one dot,
// one directory up per extra dot, then the remaining dotted segments appended.
function relativeBase(fromPath: string, specifier: string): string {
  let dots = 0
  while (dots < specifier.length && specifier[dots] === ".") dots += 1

  let dir = dirname(fromPath)
  for (let up = 1; up < dots; up += 1) dir = dirname(dir)

  const remainder = specifier.slice(dots)
  const parts = remainder === "" ? [] : remainder.split(".")
  return cleanBase(join(dir, ...parts))
}

export function resolvePythonModule(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>
): string | null {
  if (specifier.startsWith(".")) {
    return firstExisting(fileCandidates(relativeBase(fromPath, specifier)), knownPaths)
  }

  const parts = specifier.split(".")
  for (const prefix of searchPrefixes(fromPath)) {
    const base = cleanBase(join(prefix, ...parts))
    const hit = firstExisting(fileCandidates(base), knownPaths)
    if (hit) return hit
  }

  return null
}

// `from PKG import name` where `name` is a SUBMODULE, not a symbol (the `from . import sibling`
// case): resolve `<package dir>/name.py` (or its __init__). Returns null when `name` is a plain
// symbol living inside the package module — that resolves through the module file instead.
export function resolvePythonSubmodule(
  fromPath: string,
  specifier: string,
  name: string,
  knownPaths: ReadonlySet<string>
): string | null {
  const base = specifier.startsWith(".")
    ? relativeBase(fromPath, specifier)
    : cleanBase(join(...specifier.split(".")))

  const withName = base === "" ? name : `${base}/${name}`
  return firstExisting(fileCandidates(withName), knownPaths)
}
