import type { Node } from "web-tree-sitter"

import type {
  ImportBinding,
  LanguageAdapter,
  ModuleImport,
  ModuleSymbol,
  ModuleSyntax,
  Reference,
} from "./treeSitter.js"

// The Python 3 extraction adapter (docs/architecture.md §5–§6, "More languages"). Node-type
// names below were verified EMPIRICALLY against tree-sitter-python (a scratch parse of the
// shipped 0.1.13 wasm, not memory):
//
//   symbols     function_definition (field name; `async def` is the SAME node with an anon
//               `async` child), class_definition (field name, body = block; methods are
//               function_definition inside the body), decorated_definition (field
//               `definition` = the wrapped function/class), and a module-level
//               expression_statement → assignment (field left = identifier) whose target is
//               SCREAMING_CASE → a const (Python has no const keyword; the naming convention
//               is the API signal, mirroring the TS "only const module API counts" judgment).
//   imports     import_statement (field name = dotted_name | aliased_import),
//               import_from_statement (field module_name = dotted_name | relative_import,
//               field(s) name = dotted_name | aliased_import; wildcard_import for `*`).
//   references  call (field function = identifier for a plain call, or attribute with fields
//               object/attribute for a qualified `mod.helper()`), and a bare identifier that
//               matches an imported name for a value use. There is no type_identifier — a type
//               annotation is a plain identifier, so it is captured by the value-use sweep.
//
// Resolution (same-dir/relative/dotted module → repo path) happens in `./deepResolve`.

// A module-level constant by convention: an all-caps (SCREAMING_SNAKE) binding name.
const CONST_NAME = /^[A-Z][A-Z0-9_]*$/

function lineSpan(node: Node): { startLine: number; endLine: number } {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
}

function referenceLine(node: Node): number {
  return node.startPosition.row + 1
}

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name)
}

// The definition a top-level statement introduces — unwrapping `@decorator` to its inner node.
function definitionOf(statement: Node): Node | null {
  if (statement.type !== "decorated_definition") return statement

  return field(statement, "definition")
}

function collectSymbols(root: Node): ModuleSymbol[] {
  const symbols: ModuleSymbol[] = []

  for (const statement of root.namedChildren) {
    if (!statement) continue

    if (statement.type === "expression_statement") {
      collectModuleConst(statement, symbols)
      continue
    }

    collectDefinition(statement, symbols)
  }

  return symbols
}

// A `def`/`class` at module level — the OUTER statement span (including any decorator) is the
// symbol span, matching how the TS adapter spans an `export function`.
function collectDefinition(statement: Node, symbols: ModuleSymbol[]): void {
  const definition = definitionOf(statement)
  if (!definition) return

  const span = lineSpan(statement)

  if (definition.type === "function_definition") {
    const name = field(definition, "name")
    if (name) symbols.push({ name: name.text, kind: "function", ...span })
    return
  }

  if (definition.type === "class_definition") {
    const name = field(definition, "name")
    if (name) symbols.push({ name: name.text, kind: "class", ...span })

    collectClassMethods(definition, symbols)
  }
}

// The `def`s inside a class body → methods (each spanning its own decorator too).
function collectClassMethods(classDefinition: Node, symbols: ModuleSymbol[]): void {
  const body = field(classDefinition, "body")
  if (!body) return

  for (const member of body.namedChildren) {
    if (!member) continue

    const definition = definitionOf(member)
    if (definition?.type !== "function_definition") continue

    const name = field(definition, "name")
    if (name) symbols.push({ name: name.text, kind: "method", ...lineSpan(member) })
  }
}

// A module-level assignment whose target is a SCREAMING_CASE name → a const (§3 kinds). A
// lower-case binding is a mutable module variable, not API, and is skipped (like TS skips let/var).
function collectModuleConst(statement: Node, symbols: ModuleSymbol[]): void {
  for (const child of statement.namedChildren) {
    if (child?.type !== "assignment") continue

    const target = field(child, "left")
    if (target?.type !== "identifier" || !CONST_NAME.test(target.text)) continue

    symbols.push({ name: target.text, kind: "const", ...lineSpan(statement) })
  }
}

function collectImports(root: Node): ModuleImport[] {
  const imports: ModuleImport[] = []

  for (const statement of root.descendantsOfType("import_statement")) {
    if (statement) collectPlainImport(statement, imports)
  }

  for (const statement of root.descendantsOfType("import_from_statement")) {
    if (statement) collectFromImport(statement, imports)
  }

  return imports
}

// `import a.b as mod` / `import a` / `import a.b.c`. An alias, or a single-segment module, gives
// a NAMESPACE binding (`mod.helper()` reads `helper` off the qualifier — like Go's `pkg.Func`).
// A bare multi-segment `import a.b.c` binds only the top name to a SUBmodule path we cannot
// resolve one level, so it contributes the file dependency but no symbol binding (a known miss).
function collectPlainImport(statement: Node, imports: ModuleImport[]): void {
  for (const nameNode of statement.childrenForFieldName("name")) {
    if (!nameNode) continue

    if (nameNode.type === "aliased_import") {
      const module = field(nameNode, "name")
      const alias = field(nameNode, "alias")
      if (module && alias) {
        imports.push({
          specifier: module.text,
          bindings: [{ localName: alias.text, importedName: alias.text, namespace: true }],
        })
      }
      continue
    }

    if (nameNode.type !== "dotted_name") continue

    const specifier = nameNode.text
    const singleSegment = !specifier.includes(".")
    const bindings: ImportBinding[] = singleSegment
      ? [{ localName: specifier, importedName: specifier, namespace: true }]
      : []
    imports.push({ specifier, bindings })
  }
}

// `from a.b import c as d` / `from . import x` / `from .mod import y`. Each imported name is a
// NAMED binding; the module specifier keeps its raw dotted/relative form for the resolver.
function collectFromImport(statement: Node, imports: ModuleImport[]): void {
  const moduleName = field(statement, "module_name")
  if (!moduleName) return

  const bindings: ImportBinding[] = []
  for (const nameNode of statement.childrenForFieldName("name")) {
    if (!nameNode) continue

    if (nameNode.type === "aliased_import") {
      const original = field(nameNode, "name")
      const alias = field(nameNode, "alias")
      if (original && alias) bindings.push({ localName: alias.text, importedName: original.text })
      continue
    }

    if (nameNode.type === "dotted_name") {
      bindings.push({ localName: nameNode.text, importedName: nameNode.text })
    }
  }

  imports.push({ specifier: moduleName.text, bindings })
}

// Local name → the binding that introduced it — the only names a reference resolves through.
function importedLocalNames(imports: ModuleImport[]): Map<string, ImportBinding> {
  const byLocalName = new Map<string, ImportBinding>()
  for (const moduleImport of imports) {
    for (const binding of moduleImport.bindings) {
      if (!byLocalName.has(binding.localName)) byLocalName.set(binding.localName, binding)
    }
  }

  return byLocalName
}

// The identifier nodes that DECLARE a binding rather than use it — the names inside an import
// statement (a `dotted_name` segment, an `aliased_import` alias). Excluded from the value sweep.
const BINDING_SITE_PARENTS = new Set(["dotted_name", "aliased_import"])

function isBindingSite(node: Node): boolean {
  const parent = node.parent
  return parent !== null && BINDING_SITE_PARENTS.has(parent.type)
}

// The callee of `helper()` — excluded from the value sweep so one call site yields one edge.
function isCalleePosition(node: Node): boolean {
  const parent = node.parent
  if (parent?.type !== "call") return false

  return field(parent, "function")?.id === node.id
}

// Calls: a plain-identifier callee (`helper()`) and a namespace-qualified call (`mod.helper()`,
// the operand an `import ... as mod` name) — the latter mirrors Go's `pkg.Func`.
function collectCalls(root: Node, bindings: Map<string, ImportBinding>, out: Reference[]): void {
  const boundValue = (name: string): boolean => bindings.get(name)?.namespace !== true

  for (const call of root.descendantsOfType("call")) {
    const callee = call ? field(call, "function") : null
    if (!callee) continue

    if (callee.type === "identifier" && bindings.has(callee.text) && boundValue(callee.text)) {
      out.push({ name: callee.text, line: referenceLine(callee), kind: "call" })
      continue
    }

    if (callee.type !== "attribute") continue

    const object = field(callee, "object")
    const attribute = field(callee, "attribute")
    if (!object || !attribute || object.type !== "identifier") continue
    if (bindings.get(object.text)?.namespace !== true) continue

    out.push({
      name: attribute.text,
      line: referenceLine(attribute),
      kind: "call",
      qualifier: object.text,
    })
  }
}

// Value references to an imported name that are not a call — reading an imported const or class
// (`TIMEOUT`, `Thing` used as a value or in an annotation). Namespace bindings are excluded (a
// namespace name is only ever meaningful qualified, `mod.x`).
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

    out.push({ name: identifier.text, line: referenceLine(identifier), kind: "use" })
  }
}

// References are collected ONLY for names an import bound (both engines resolve solely through
// bindings), so an unbound reference could never become an edge — filtering here is
// behaviour-preserving and keeps the repo-wide sweep affordable.
function collectReferences(root: Node, importedNames: Map<string, ImportBinding>): Reference[] {
  const references: Reference[] = []
  if (importedNames.size === 0) return references

  collectCalls(root, importedNames, references)
  collectValueUses(root, importedNames, references)

  return references
}

function extract(root: Node): ModuleSyntax {
  const imports = collectImports(root)

  return {
    symbols: collectSymbols(root),
    imports,
    references: collectReferences(root, importedLocalNames(imports)),
  }
}

export const pythonAdapter: LanguageAdapter = { extract }
