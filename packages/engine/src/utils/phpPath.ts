import { dirname, join } from "./posixPath.js"

// Resolve a PHP import specifier to a repo `.php` path (docs/architecture.md §6 deep engine).
// Pure string logic over the checkout's known path set — no IO, no domain coupling (utils leaf).
//
// Two specifier shapes resolve:
//   RELATIVE  a `require`/`include` string like `./x.php` or `../lib/y.php` → resolved against
//             the importing file's own directory, exactly like a TS relative specifier.
//   NAMESPACE a `use App\Sub\Class` path → matched best-effort as a repo path SUFFIX
//             `**/App/Sub/Class.php` (PSR-4-ish without reading composer.json — a documented
//             §6 known miss). Because PSR-4 maps a namespace ROOT to a directory
//             (`App\ → src/`), the full path rarely matches, so we also try progressively
//             shorter suffixes (`Sub/Class.php`, `Class.php`) — LONGEST first, most specific
//             wins. A wrong autoload root or a duplicate basename can therefore mis-resolve.

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

// A relative require/include path. The literal usually carries `.php`; try the bare join first,
// then an appended extension for the rare extension-less include.
function resolveRequire(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>
): string | null {
  const base = join(dirname(fromPath), specifier)
  const candidates = base.endsWith(".php") ? [base] : [base, `${base}.php`]

  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate
  }

  return null
}

// The repo file whose path ends with `subPath` (or equals it at the root). Exact-root match
// wins; otherwise the shortest suffix match, then lexical, for determinism.
function matchBySuffix(subPath: string, knownPaths: ReadonlySet<string>): string | null {
  if (knownPaths.has(subPath)) return subPath

  const suffix = `/${subPath}`
  let best: string | null = null
  for (const path of knownPaths) {
    if (!path.endsWith(suffix)) continue
    if (
      best === null ||
      path.length < best.length ||
      (path.length === best.length && path < best)
    ) {
      best = path
    }
  }

  return best
}

// A `use` namespace path → a repo file. Try the full namespace-as-path suffix first, then drop
// leading segments one at a time (the PSR-4 namespace root that maps to a directory we cannot
// read) — longest, most specific suffix wins.
function resolveNamespace(namespacePath: string, knownPaths: ReadonlySet<string>): string | null {
  const segments = namespacePath.split("\\").filter((segment) => segment.length > 0)

  for (let start = 0; start < segments.length; start += 1) {
    const match = matchBySuffix(`${segments.slice(start).join("/")}.php`, knownPaths)
    if (match) return match
  }

  return null
}

export function resolvePhpImport(
  fromPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>
): string | null {
  if (isRelative(specifier)) return resolveRequire(fromPath, specifier, knownPaths)

  return resolveNamespace(specifier, knownPaths)
}
