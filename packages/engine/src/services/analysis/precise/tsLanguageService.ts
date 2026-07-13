import type { ChangedSymbol } from "@pr-visulizer/shared"
import ts from "typescript"

import { isTypeScriptFamily } from "../../../utils/language.js"
import { resolveToKnownPath } from "../../../utils/modulePath.js"
import type { AliasTable } from "../../../utils/tsconfigPaths.js"
import { DEFAULT_LIB, type PrecisionPolicy } from "./policy.js"
import type { PreciseReference, PreciseReferenceIndex } from "./referenceIndex.js"

// The ONLY module that imports `typescript`. It builds a LanguageService over a VIRTUAL host
// backed by the checkout the caller already read — no filesystem, no child process, no LSP
// server. `tsserver` and `typescript-language-server` are JSON-RPC wrappers around this same
// `ts.createLanguageService`, so the evidence is identical; hence `source:'lsp'`.
//
// It never reads the repo's tsconfig `compilerOptions.plugins`, so no repo code is ever
// executed (§12) — a real tsserver would load TS language-service plugins from node_modules.

// The platform seam for the default type library, mirroring `GrammarSource` exactly: node
// reads `lib.*.d.ts` off disk, the webview imports them as `?raw` assets. (A `.d.ts` cannot
// ride the `?url` seam — a bundler serves it as an erased, empty module.)
export type LibSource = (libName: string) => Promise<string | undefined>


// Virtual roots. Engine paths are repo-relative POSIX; the compiler wants absolute-looking
// ones, so everything is prefixed. The two namespaces cannot collide.
const SOURCE_ROOT = "/repo/"
const LIB_ROOT = "/lib/"

const REFERENCE_LIB = /\/\/\/\s*<reference\s+lib\s*=\s*"([^"]+)"\s*\/>/g

// `LanguageServiceHost.readFile` is SYNCHRONOUS, so the whole `/// <reference lib="…" />`
// chain must be resolved into memory before the service exists.
async function loadLibChain(libSource: LibSource, entry: string): Promise<Map<string, string>> {
  const loaded = new Map<string, string>()
  const queue = [entry]

  while (queue.length > 0) {
    const name = queue.pop()!
    if (loaded.has(name)) continue

    const text = await libSource(name)
    if (text === undefined) continue

    loaded.set(name, text)
    for (const match of text.matchAll(REFERENCE_LIB)) queue.push(`lib.${match[1]}.d.ts`)
  }

  return loaded
}

function extensionFor(path: string): ts.Extension {
  if (path.endsWith(".tsx")) return ts.Extension.Tsx
  if (path.endsWith(".jsx")) return ts.Extension.Jsx
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.Extension.Js
  return ts.Extension.Ts
}

// The identifier's offset: the first occurrence of the symbol's name at or after its
// declaration line. Good enough because a declaration names itself before it uses anything.
function offsetOfSymbol(text: string, symbol: ChangedSymbol): number | null {
  let offset = 0
  for (let line = 1; line < symbol.span.startLine; line += 1) {
    const next = text.indexOf("\n", offset)
    if (next < 0) return null
    offset = next + 1
  }

  const found = text.indexOf(symbol.name, offset)
  return found < 0 ? null : found
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1
  }

  return line
}

// The innermost node starting at `position` — the identifier a reference entry points at.
function nodeAt(sourceFile: ts.SourceFile, position: number): ts.Node | null {
  let found: ts.Node | null = null

  const visit = (node: ts.Node): void => {
    if (position < node.getStart(sourceFile) || position >= node.getEnd()) return

    found = node
    node.forEachChild(visit)
  }

  sourceFile.forEachChild(visit)
  return found
}

// How the reference is used, in the same vocabulary as an Edge. Mirrors the tree-sitter
// classifier: a callee (plain or through a property access) is a call; anything under a type
// node is a type use; everything else is a value use.
function classify(node: ts.Node): PreciseReference["kind"] {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isTypeReferenceNode(current)) return "uses-type"

    const parent: ts.Node | undefined = current.parent
    if (!parent) break

    if (ts.isCallExpression(parent) && parent.expression === current) return "calls"
    if (ts.isNewExpression(parent) && parent.expression === current) return "calls"
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.name === current &&
      parent.parent &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      return "calls"
    }

    // Stop climbing once we leave the expression that contains the identifier.
    if (ts.isStatement(parent)) break
  }

  return "uses"
}

export type TsReferenceIndexInput = {
  // The whole checkout, repo-relative POSIX path → text (what the worker already holds).
  contents: ReadonlyMap<string, string>
  // The changed symbols, indexed by id, so a reference entry maps back to one.
  symbols: readonly ChangedSymbol[]
  // The repo's tsconfig aliases — reused through the engine's OWN resolver below, so nearest-
  // tsconfig `@/…` semantics stay in one place instead of being re-derived for the compiler.
  aliases: AliasTable
  libSource: LibSource
  policy: PrecisionPolicy
}

// Build a compiler-grade reference index. Returns null when the program cannot be built
// within the policy's budget — the caller then keeps the AST result untouched.
// How many symbols to query between yields. Each `getReferencesAtPosition` is a synchronous
// compiler call, so the phase deadline can only be observed at a chunk boundary.
const QUERY_CHUNK = 25

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export async function createTsReferenceIndex(
  input: TsReferenceIndexInput
): Promise<PreciseReferenceIndex | null> {
  const sourcePaths = [...input.contents.keys()].filter(isTypeScriptFamily)
  if (sourcePaths.length === 0) return null

  // Nothing TS/JS changed — a Go-only PR. Building a program over the repo's TypeScript would
  // cost a full parse and yield exactly nothing, since every query would name a Go path.
  const querySymbols = input.symbols.filter((symbol) => isTypeScriptFamily(symbol.path))
  if (querySymbols.length === 0) return null

  const libs = await loadLibChain(input.libSource, DEFAULT_LIB)
  if (libs.size === 0) return null

  const allPaths = new Set(sourcePaths)
  const virtualNames = sourcePaths.map((path) => `${SOURCE_ROOT}${path}`)

  const repoPathOf = (fileName: string): string | null =>
    fileName.startsWith(SOURCE_ROOT) ? fileName.slice(SOURCE_ROOT.length) : null

  const read = (fileName: string): string | undefined => {
    const repoPath = repoPathOf(fileName)
    if (repoPath !== null) return input.contents.get(repoPath)
    if (fileName.startsWith(LIB_ROOT)) return libs.get(fileName.slice(LIB_ROOT.length))

    return undefined
  }

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    skipLibCheck: true,
    noResolve: false,
  }

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => virtualNames,
    getScriptVersion: () => "1",
    getScriptSnapshot: (fileName) => {
      const text = read(fileName)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => `${LIB_ROOT}${DEFAULT_LIB}`,
    fileExists: (fileName) => read(fileName) !== undefined,
    readFile: read,
    readDirectory: () => [],
    directoryExists: () => true,
    getDirectories: () => [],

    // Module resolution is delegated to the ENGINE's resolver, which already implements
    // nearest-tsconfig `@/…` aliases, extension-less and index resolution (tsconfigPaths.ts).
    // One definition of "what does this specifier mean", shared by both tiers.
    resolveModuleNameLiterals: (literals, containingFile) => {
      const fromPath = repoPathOf(containingFile)

      return literals.map((literal) => {
        if (fromPath === null) return { resolvedModule: undefined }

        const target = resolveToKnownPath(fromPath, literal.text, allPaths, input.aliases)
        if (!target) return { resolvedModule: undefined }

        return {
          resolvedModule: {
            resolvedFileName: `${SOURCE_ROOT}${target}`,
            extension: extensionFor(target),
            isExternalLibraryImport: false,
          },
        }
      })
    },
  }

  const deadline = Date.now() + input.policy.programTimeoutMs
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const program = service.getProgram()
  if (!program || Date.now() > deadline) return null

  const symbolById = new Map(input.symbols.map((symbol) => [symbol.id, symbol]))

  // One symbol's references. Isolated: a compiler throw here (an unexpected path, a corrupt
  // position) costs THIS symbol, never the batch. Before, a single Go path threw
  // `Could not find source file` and the caller's catch discarded every TS result with it.
  const referencesToSymbol = (symbolId: string): PreciseReference[] => {
    const symbol = symbolById.get(symbolId)
    if (!symbol || !isTypeScriptFamily(symbol.path)) return []

    const text = input.contents.get(symbol.path)
    if (text === undefined) return []

    const offset = offsetOfSymbol(text, symbol)
    if (offset === null) return []

    const declarationFile = `${SOURCE_ROOT}${symbol.path}`

    let entries: readonly ts.ReferenceEntry[]
    try {
      entries = service.getReferencesAtPosition(declarationFile, offset) ?? []
    } catch {
      return []
    }

    const found: PreciseReference[] = []
    for (const entry of entries) {
      // The query position itself comes back as an entry — that is the DECLARATION, not a
      // use of it. (`entry.isDefinition` is unset in practice, so compare the span.)
      if (entry.fileName === declarationFile && entry.textSpan.start === offset) continue

      const repoPath = repoPathOf(entry.fileName)
      if (repoPath === null) continue

      const sourceFile = program.getSourceFile(entry.fileName)
      const entryText = input.contents.get(repoPath)
      if (!sourceFile || entryText === undefined) continue

      const node = nodeAt(sourceFile, entry.textSpan.start)
      if (!node) continue

      found.push({
        symbolId,
        path: repoPath,
        line: lineAt(entryText, entry.textSpan.start),
        kind: symbol.kind === "type" ? "uses-type" : classify(node),
      })
    }

    return found
  }

  return {
    async referencesTo(symbolIds) {
      const references: PreciseReference[] = []
      const queryDeadline = Date.now() + input.policy.queryBudgetMs

      // Only TS/JS symbols can be asked of a TypeScript program; the cap applies to those.
      const queryable = symbolIds
        .filter((id) => {
          const symbol = symbolById.get(id)
          return symbol !== undefined && isTypeScriptFamily(symbol.path)
        })
        .slice(0, input.policy.maxSymbols)

      for (let index = 0; index < queryable.length; index += 1) {
        if (Date.now() > queryDeadline) break

        references.push(...referencesToSymbol(queryable[index]!))

        // Hand the event loop back every chunk, so an outer deadline can actually fire while
        // a long batch is running. Without this the whole batch is one uninterruptible task.
        if ((index + 1) % QUERY_CHUNK === 0) await yieldToEventLoop()
      }

      return references
    },
  }
}
