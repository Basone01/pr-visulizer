import type { ChangedSymbol } from "@pr-visulizer/shared"
import { createRequire } from "node:module"
import { Language, type Node, Parser } from "web-tree-sitter"

// The ONLY module that touches web-tree-sitter (docs/architecture.md §5 steps 4–7).
// It parses a source file and returns PLAIN DATA — top-level symbols, imports, and
// references — so no tree-sitter Node ever leaks upstream. Swappable in one place.

const requireFromHere = createRequire(import.meta.url)

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
}

export type ModuleImport = {
  specifier: string // raw import source, e.g. "../config/limits.js"
  bindings: ImportBinding[] // named imports; empty for default/namespace/side-effect
}

// A call or type-use site — resolved to an edge + occurrence in the fast engine (§7).
export type Reference = {
  name: string
  line: number // 1-based reference site (used as the usage occurrence line)
  kind: "call" | "type"
}

export type ModuleSyntax = {
  symbols: ModuleSymbol[]
  imports: ModuleImport[]
  references: Reference[]
}

let initialization: Promise<void> | null = null
const grammarCache = new Map<string, Promise<Language>>()

async function loadGrammar(grammarId: string): Promise<Language> {
  const cached = grammarCache.get(grammarId)
  if (cached) return cached

  const loading = (async () => {
    if (!initialization) initialization = Parser.init()
    await initialization

    // tree-sitter-wasms ships prebuilt grammar binaries (building from the
    // tree-sitter-typescript source needs emscripten — not available offline).
    const wasmPath = requireFromHere.resolve(`tree-sitter-wasms/out/tree-sitter-${grammarId}.wasm`)
    return Language.load(wasmPath)
  })()

  grammarCache.set(grammarId, loading)
  return loading
}

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

function collectImports(root: Node): ModuleImport[] {
  const imports: ModuleImport[] = []

  for (const statement of root.descendantsOfType("import_statement")) {
    if (!statement) continue

    const source = namedChild(statement, "source")
    if (!source) continue

    const bindings: ImportBinding[] = []
    for (const specifier of statement.descendantsOfType("import_specifier")) {
      if (!specifier) continue

      const name = namedChild(specifier, "name")
      if (!name) continue

      const alias = namedChild(specifier, "alias")
      bindings.push({ localName: (alias ?? name).text, importedName: name.text })
    }

    imports.push({ specifier: unquote(source.text), bindings })
  }

  return imports
}

function collectReferences(root: Node): Reference[] {
  const references: Reference[] = []

  // Calls: only plain-identifier callees (name resolution, not type inference, §7).
  for (const call of root.descendantsOfType("call_expression")) {
    const callee = call ? namedChild(call, "function") : null
    if (callee?.type === "identifier") {
      references.push({ name: callee.text, line: callee.startPosition.row + 1, kind: "call" })
    }
  }

  // Type uses: every type_identifier (a definition's own name never matches an
  // import binding, so it resolves to nothing and is harmlessly ignored).
  for (const typeRef of root.descendantsOfType("type_identifier")) {
    if (typeRef) {
      references.push({ name: typeRef.text, line: typeRef.startPosition.row + 1, kind: "type" })
    }
  }

  return references
}

// Parse one file and extract its symbols, imports, and references (§5 steps 4, 6, 7).
export async function analyzeSyntax(grammarId: string, source: string): Promise<ModuleSyntax> {
  const language = await loadGrammar(grammarId)
  const parser = new Parser()
  parser.setLanguage(language)

  const tree = parser.parse(source)
  if (!tree) throw new Error(`tree-sitter failed to parse a ${grammarId} source`)

  const root = tree.rootNode

  const symbols: ModuleSymbol[] = []
  for (const statement of root.namedChildren) {
    if (statement) collectSymbol(statement, symbols)
  }

  return { symbols, imports: collectImports(root), references: collectReferences(root) }
}
