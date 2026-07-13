import type { ChangedSymbol } from "@pr-visulizer/shared"
import { Language, type Node, Parser } from "web-tree-sitter"

import { goAdapter } from "./goExtract.js"

// The ONLY module that touches web-tree-sitter (docs/architecture.md §5 steps 4–7).
// It parses a source file and returns PLAIN DATA — top-level symbols, imports, and
// references — so no tree-sitter Node ever leaks upstream. Swappable in one place.
//
// This module is PLATFORM-NEUTRAL (browser-safe): it holds no node builtins. Where the
// wasm bytes come from is injected as a `GrammarSource` (the §3 seam) — node resolves
// them from disk (`@pr-visulizer/engine/node`), the webview fetches bundled assets.

// The platform's wasm loader. Given a grammar id it returns the raw wasm bytes; the
// reserved `CORE_GRAMMAR_ID` asks for web-tree-sitter's OWN runtime wasm, so BOTH the
// core runtime and every language grammar come from the platform, never from node paths.
export type GrammarSource = (grammarId: string) => Promise<Uint8Array>

// Not a language — the sentinel id under which a GrammarSource yields web-tree-sitter's
// core `tree-sitter.wasm` (fed to Parser.init). No real grammar id collides with it.
export const CORE_GRAMMAR_ID = "core"

// 1-based line span of a declaration in the head version.
export type ModuleSymbol = {
  name: string
  kind: ChangedSymbol["kind"]
  startLine: number
  endLine: number
}

export type ImportBinding = {
  localName: string // the name used in THIS file
  importedName: string // the original exported name in the target
  // `import * as ns from "./x"` — `ns` names the whole module, so a reference to it is
  // always qualified (`ns.foo()`). The resolver reads `foo` off the qualifier instead of
  // treating `ns` itself as the imported symbol.
  namespace?: true
}

export type ModuleImport = {
  specifier: string // raw import source, e.g. "../config/limits.js"
  bindings: ImportBinding[] // named imports; empty for default/side-effect
}

// A call or type-use site — resolved to an edge + occurrence (fast §7, deep §6).
export type Reference = {
  name: string
  line: number // 1-based reference site (used as the usage occurrence line)
  // "use" = a value reference to a const/var (`pkg.TempKeyPrefix` in value position).
  kind: "call" | "type" | "use"
  // Go selector qualifier — the `pkg` in `pkg.Func` / `pkg.Type` / `pkg.Const`. Present
  // only for qualified (cross-package) references; absent for TS and Go same-package refs.
  qualifier?: string
}

export type ModuleSyntax = {
  symbols: ModuleSymbol[]
  imports: ModuleImport[]
  references: Reference[]
}

// One per grammar: turns a parsed tree into the plain-data ModuleSyntax. The TS path
// (below) and the Go path (`./goExtract`) each own their node-type knowledge, so
// adding a language is a new adapter, never a change to the shared TS extraction.
export type LanguageAdapter = {
  extract(root: Node): ModuleSyntax
}

// One wasm runtime per process — Parser.init is global, so the core init is shared
// across analyzers even though each keeps its own grammar cache. The core wasm bytes
// come from the first analyzer's source (identical across sources in practice).
let initialization: Promise<void> | null = null

function lineSpan(node: Node): { startLine: number; endLine: number } {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
}

// The declaration a statement introduces — unwrapping `export …` to its inner node.
function declarationOf(statement: Node): Node | null {
  if (statement.type !== "export_statement") return statement

  return statement.childForFieldName("declaration") ?? null
}

function namedChild(node: Node, fieldName: string): Node | null {
  return node.childForFieldName(fieldName)
}

function collectSymbol(statement: Node, symbols: ModuleSymbol[]): void {
  const declaration = declarationOf(statement)
  if (!declaration) return

  // The OUTER statement span (includes the `export` keyword) is the symbol span.
  const span = lineSpan(statement)

  if (declaration.type === "function_declaration") {
    const name = namedChild(declaration, "name")
    if (name) symbols.push({ name: name.text, kind: "function", ...span })
    return
  }

  if (declaration.type === "class_declaration") {
    const name = namedChild(declaration, "name")
    if (name) symbols.push({ name: name.text, kind: "class", ...span })

    collectClassMethods(declaration, symbols)
    return
  }

  if (
    declaration.type === "type_alias_declaration" ||
    declaration.type === "interface_declaration"
  ) {
    const name = namedChild(declaration, "name")
    if (name) symbols.push({ name: name.text, kind: "type", ...span })
    return
  }

  if (declaration.type === "lexical_declaration") {
    collectConsts(declaration, span, symbols)
  }
}

function collectClassMethods(classDeclaration: Node, symbols: ModuleSymbol[]): void {
  const body = namedChild(classDeclaration, "body")
  if (!body) return

  for (const member of body.namedChildren) {
    if (member?.type !== "method_definition") continue

    const name = namedChild(member, "name")
    if (name) symbols.push({ name: name.text, kind: "method", ...lineSpan(member) })
  }
}

function collectConsts(
  declaration: Node,
  span: { startLine: number; endLine: number },
  symbols: ModuleSymbol[]
): void {
  // Only `const` module API counts as a symbol (§3 kinds); skip let/var.
  if (!/^\s*const\b/.test(declaration.text)) return

  for (const declarator of declaration.namedChildren) {
    if (declarator?.type !== "variable_declarator") continue

    const name = namedChild(declarator, "name")
    if (name?.type === "identifier") symbols.push({ name: name.text, kind: "const", ...span })
  }
}

function unquote(text: string): string {
  return text.slice(1, -1)
}

// Named bindings of one import/export statement: `{ a, b as c }` — plus, for an import,
// the `* as ns` namespace binding.
function collectBindings(statement: Node): ImportBinding[] {
  const bindings: ImportBinding[] = []

  for (const specifier of statement.descendantsOfType("import_specifier")) {
    if (!specifier) continue

    const name = namedChild(specifier, "name")
    if (!name) continue

    const alias = namedChild(specifier, "alias")
    bindings.push({ localName: (alias ?? name).text, importedName: name.text })
  }

  // `export { a, b as c } from "./x"` uses export_specifier, not import_specifier. The
  // re-exported name is a reference to the target's symbol, exactly like a named import.
  for (const specifier of statement.descendantsOfType("export_specifier")) {
    if (!specifier) continue

    const name = namedChild(specifier, "name")
    if (!name) continue

    const alias = namedChild(specifier, "alias")
    bindings.push({ localName: (alias ?? name).text, importedName: name.text })
  }

  for (const namespaceImport of statement.descendantsOfType("namespace_import")) {
    const local = namespaceImport?.namedChildren.find((child) => child?.type === "identifier")
    if (local) bindings.push({ localName: local.text, importedName: local.text, namespace: true })
  }

  return bindings
}

// Every statement that names another module: `import … from "x"` AND the re-export forms
// `export { a } from "x"` / `export * from "x"` (both are an export_statement carrying a
// `source` field — verified by parsing, not assumed). A re-export is a real file-level
// dependency, so skipping it lost an edge per barrel file.
function collectImports(root: Node): ModuleImport[] {
  const imports: ModuleImport[] = []

  const fromStatements = [
    ...root.descendantsOfType("import_statement"),
    ...root.descendantsOfType("export_statement"),
  ]

  for (const statement of fromStatements) {
    if (!statement) continue

    // An export_statement with no `source` is a local declaration (`export function f`),
    // not a dependency — collectTopLevelSymbols already owns it.
    const source = namedChild(statement, "source")
    if (!source) continue

    imports.push({ specifier: unquote(source.text), bindings: collectBindings(statement) })
  }

  return imports
}

// Local name → the binding that introduced it. The ONLY names a reference can resolve
// through (both engines resolve references solely via bindings). Collecting references
// outside this set allocates objects that are always discarded, so extraction filters on it.
function importedLocalNames(imports: ModuleImport[]): Map<string, ImportBinding> {
  const byLocalName = new Map<string, ImportBinding>()
  for (const moduleImport of imports) {
    for (const binding of moduleImport.bindings) {
      if (!byLocalName.has(binding.localName)) byLocalName.set(binding.localName, binding)
    }
  }

  return byLocalName
}

// The TS/TSX symbols: every top-level declaration (functions, classes + their
// methods, types/interfaces, module-level consts). Unchanged from the original
// inline loop — the TS extraction path stays byte-identical.
function collectTopLevelSymbols(root: Node): ModuleSymbol[] {
  const symbols: ModuleSymbol[] = []
  for (const statement of root.namedChildren) {
    if (statement) collectSymbol(statement, symbols)
  }

  return symbols
}

// The identifier nodes that DECLARE a binding rather than use it — `CONFIG` inside its own
// `import { CONFIG } from …`, a default import's name, a namespace alias, an export list entry.
//
// Matched by the identifier's PARENT, never by walking ancestors to the statement: an ancestor
// walk also catches every usage inside an `export const x = () => CONFIG.a`, because an exported
// declaration with no statement_block reaches `export_statement` before it reaches `program` —
// which silently dropped value references from arrow-function consts and exported objects.
const BINDING_SITE_PARENTS = new Set([
  "import_specifier",
  "export_specifier",
  "namespace_import",
  "import_clause",
])

function isBindingSite(node: Node): boolean {
  const parent = node.parent
  return parent !== null && BINDING_SITE_PARENTS.has(parent.type)
}

// A reference site already reported as a call — the callee of `foo()` and the constructor of
// `new Foo()`. Excluded from the value-reference ("use") sweep so one site yields one edge.
function isCalleePosition(node: Node): boolean {
  const parent = node.parent
  if (!parent) return false

  if (parent.type === "call_expression") return parent.childForFieldName("function")?.id === node.id
  if (parent.type === "new_expression")
    return parent.childForFieldName("constructor")?.id === node.id

  return false
}

// Calls: a plain-identifier callee (`helper()`), a constructor (`new Client()`), and a
// namespace-qualified call (`ns.helper()`) — the last mirrors Go's `pkg.Func`, reusing the
// same `qualifier` field the Go adapter set.
function collectCalls(root: Node, bindings: Map<string, ImportBinding>, out: Reference[]): void {
  const boundValue = (name: string): boolean => bindings.get(name)?.namespace !== true

  for (const call of root.descendantsOfType("call_expression")) {
    const callee = call ? namedChild(call, "function") : null
    if (!callee) continue

    if (callee.type === "identifier" && bindings.has(callee.text) && boundValue(callee.text)) {
      out.push({ name: callee.text, line: callee.startPosition.row + 1, kind: "call" })
      continue
    }

    if (callee.type !== "member_expression") continue

    // `ns.helper()` where `ns` is `import * as ns` — the reference is to `helper` in the
    // target module. A member call on a plain value (`config.load()`) is NOT this; it falls
    // through to the value sweep, which records a use of `config`.
    const object = namedChild(callee, "object")
    const property = namedChild(callee, "property")
    if (!object || !property || object.type !== "identifier") continue
    if (bindings.get(object.text)?.namespace !== true) continue

    out.push({
      name: property.text,
      line: property.startPosition.row + 1,
      kind: "call",
      qualifier: object.text,
    })
  }

  for (const expression of root.descendantsOfType("new_expression")) {
    const constructor = expression ? namedChild(expression, "constructor") : null
    if (constructor?.type !== "identifier") continue
    if (!bindings.has(constructor.text) || !boundValue(constructor.text)) continue

    out.push({ name: constructor.text, line: constructor.startPosition.row + 1, kind: "call" })
  }
}

// Value references to an imported name that are neither a call nor a type — reading an
// imported const (`CONFIG.mongoUri`, `limit = MAX`). Go has emitted these as `kind:"use"`
// from the start; TS did not, so an imported const produced no symbol edge at all.
function collectValueUses(
  root: Node,
  bindings: Map<string, ImportBinding>,
  out: Reference[]
): void {
  for (const identifier of root.descendantsOfType("identifier")) {
    if (!identifier) continue

    const binding = bindings.get(identifier.text)
    if (!binding || binding.namespace) continue
    if (isCalleePosition(identifier) || isBindingSite(identifier)) continue

    out.push({ name: identifier.text, line: identifier.startPosition.row + 1, kind: "use" })
  }
}

// Type uses: a `type_identifier` naming an imported type. (The `javascript` grammar emits
// none, so this simply yields nothing there.)
function collectTypeUses(root: Node, bindings: Map<string, ImportBinding>, out: Reference[]): void {
  for (const typeRef of root.descendantsOfType("type_identifier")) {
    if (!typeRef || !bindings.has(typeRef.text)) continue

    out.push({ name: typeRef.text, line: typeRef.startPosition.row + 1, kind: "type" })
  }
}

// References are collected ONLY for names an import bound. Both engines resolve a reference
// solely through its file's bindings, so an unbound reference could never become an edge —
// filtering here is behaviour-preserving for calls/types, and is what makes the repo-wide
// `use` sweep affordable (a 2577-file checkout would otherwise allocate a reference per
// identifier).
function collectReferences(root: Node, importedNames: Map<string, ImportBinding>): Reference[] {
  const references: Reference[] = []
  if (importedNames.size === 0) return references

  collectCalls(root, importedNames, references)
  collectTypeUses(root, importedNames, references)
  collectValueUses(root, importedNames, references)

  return references
}

// The TS/TSX/JS adapter: one extraction shared by all three grammars. Verified empirically
// (a scratch parse, not memory) that `javascript` emits the SAME node types this reads —
// function_declaration, class_declaration, lexical_declaration, import_statement,
// export_statement, call_expression, import_specifier. It has no `type_identifier`, which
// simply yields no type references.
const typescriptAdapter: LanguageAdapter = {
  extract: (root) => {
    const imports = collectImports(root)

    return {
      symbols: collectTopLevelSymbols(root),
      imports,
      references: collectReferences(root, importedLocalNames(imports)),
    }
  },
}

// Grammar id → adapter. `languageForPath` only yields ids present here; an id with no
// adapter is a programmer error (a grammar wired without its extraction), so we throw.
const ADAPTERS: Record<string, LanguageAdapter> = {
  typescript: typescriptAdapter,
  tsx: typescriptAdapter,
  javascript: typescriptAdapter,
  go: goAdapter,
}

// A parser bound to a platform's wasm loader. `analyzeSyntax` parses one file and
// returns plain data (§5 steps 4, 6, 7). The per-grammar cache and the loader are held
// in the closure, so the SAME extraction logic runs in node and in the webview — only
// the injected `GrammarSource` differs.
export type SyntaxAnalyzer = {
  analyzeSyntax(grammarId: string, source: string): Promise<ModuleSyntax>
}

export function createSyntaxAnalyzer(source: GrammarSource): SyntaxAnalyzer {
  const grammarCache = new Map<string, Promise<Language>>()
  // One Parser per grammar, not one per file. A Parser is a wasm allocation; the deep pass
  // walks thousands of files.
  const parserCache = new Map<string, Parser>()

  async function loadGrammar(grammarId: string): Promise<Language> {
    const cached = grammarCache.get(grammarId)
    if (cached) return cached

    const loading = (async () => {
      // Parser.init needs web-tree-sitter's own core wasm; take its bytes from the
      // platform too (Emscripten's `wasmBinary`), so no locateFile/fetch path is used.
      if (!initialization)
        initialization = Parser.init({ wasmBinary: await source(CORE_GRAMMAR_ID) })
      await initialization

      // Grammar bytes from the platform: node reads tree-sitter-wasms off disk, the
      // webview fetches the bundled asset. Language.load accepts bytes as well as a path.
      return Language.load(await source(grammarId))
    })()

    grammarCache.set(grammarId, loading)
    return loading
  }

  async function parserFor(grammarId: string): Promise<Parser> {
    const cached = parserCache.get(grammarId)
    if (cached) return cached

    // `loadGrammar` performs the one-time `Parser.init()`; constructing a Parser before it
    // throws. Await the grammar FIRST.
    const language = await loadGrammar(grammarId)
    const parser = new Parser()
    parser.setLanguage(language)
    parserCache.set(grammarId, parser)

    return parser
  }

  async function analyzeSyntax(grammarId: string, sourceCode: string): Promise<ModuleSyntax> {
    const adapter = ADAPTERS[grammarId]
    if (!adapter) throw new Error(`no extraction adapter for grammar "${grammarId}"`)

    const parser = await parserFor(grammarId)
    const tree = parser.parse(sourceCode)
    if (!tree) throw new Error(`tree-sitter failed to parse a ${grammarId} source`)

    try {
      // `extract` returns PLAIN DATA (strings, numbers) — it holds no tree-sitter Node — so the
      // tree can be released immediately. Without this each tree stays in the wasm heap for the
      // analyzer's lifetime (~266 KB per parse, measured); the wasm heap never shrinks.
      return adapter.extract(tree.rootNode)
    } finally {
      tree.delete()
    }
  }

  return { analyzeSyntax }
}
