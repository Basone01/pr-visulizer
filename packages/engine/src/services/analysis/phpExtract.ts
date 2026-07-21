import type { Node } from "web-tree-sitter"

import type {
  ImportBinding,
  LanguageAdapter,
  ModuleImport,
  ModuleSymbol,
  ModuleSyntax,
  Reference,
} from "./treeSitter.js"

// The PHP 7.4 extraction adapter (docs/architecture.md §5–§6, "More languages"). Node-type
// names below were verified EMPIRICALLY against tree-sitter-php (a scratch parse of the shipped
// 0.1.13 wasm, not memory) — including the 7.4 constructs (typed properties, `fn() =>` arrow
// functions, the `??=` null-coalescing assignment), which all parse without error:
//
//   symbols     function_definition (field name), class_declaration /
//               interface_declaration / trait_declaration (field name, body =
//               declaration_list; methods = method_declaration inside), const_declaration →
//               const_element (child `name`), and `define("X", …)` — a
//               function_call_expression whose function `name` is "define" and whose first
//               argument is an encapsed_string.
//   imports     namespace_use_declaration → namespace_use_clause → qualified_name (whole text
//               is the namespace path, last `name` is the short symbol) | bare `name`, plus an
//               optional namespace_aliasing_clause (child `name` = the alias). And
//               require/include(_once) expressions carrying an encapsed_string path.
//   references  function_call_expression (field function = name), scoped_call_expression
//               (field scope = class name, field name = method), object_creation_expression
//               (`new Name()`), and named_type / base_clause / class_interface_clause for a
//               class name in type position. A member_call_expression (`$obj->method()`) is
//               dynamic — no static class to bind — so it is a known miss.
//
// Resolution (namespace path → repo file, require path → repo file) happens in `./deepResolve`.
// References are collected ONLY for names a `use` bound: PHP resolves a same-namespace call with
// no `use` through PSR-4, which needs composer.json we do not read (a documented §6 miss), so an
// unbound reference could never become an edge and is filtered here.

function lineSpan(node: Node): { startLine: number; endLine: number } {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
}

function referenceLine(node: Node): number {
  return node.startPosition.row + 1
}

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name)
}

function firstChildOfType(node: Node, type: string): Node | null {
  return node.namedChildren.find((child) => child?.type === type) ?? null
}

function collectSymbols(root: Node): ModuleSymbol[] {
  const symbols: ModuleSymbol[] = []

  for (const statement of root.namedChildren) {
    if (statement) collectSymbol(statement, symbols)
  }

  return symbols
}

function collectSymbol(statement: Node, symbols: ModuleSymbol[]): void {
  const type = statement.type

  if (type === "function_definition") {
    const name = field(statement, "name")
    if (name) symbols.push({ name: name.text, kind: "function", ...lineSpan(statement) })
    return
  }

  // A class is kind "class"; an interface/trait is kind "type" (§3). All three carry methods.
  if (type === "class_declaration") {
    collectContainer(statement, "class", symbols)
    return
  }

  if (type === "interface_declaration" || type === "trait_declaration") {
    collectContainer(statement, "type", symbols)
    return
  }

  if (type === "const_declaration") {
    collectConstElements(statement, symbols)
    return
  }

  if (type === "expression_statement") {
    collectDefine(statement, symbols)
  }
}

// A class/interface/trait declaration: the container symbol plus every method_declaration in
// its body — mirroring how the TS adapter collects a class and its methods.
function collectContainer(
  statement: Node,
  kind: ModuleSymbol["kind"],
  symbols: ModuleSymbol[]
): void {
  const name = field(statement, "name")
  if (name) symbols.push({ name: name.text, kind, ...lineSpan(statement) })

  const body = field(statement, "body")
  if (!body) return

  for (const member of body.namedChildren) {
    if (member?.type !== "method_declaration") continue

    const methodName = field(member, "name")
    if (methodName) symbols.push({ name: methodName.text, kind: "method", ...lineSpan(member) })
  }
}

// `const A = 1, B = 2;` — one const_declaration, one or more const_element, each with a `name`.
// Every name shares the declaration's span.
function collectConstElements(declaration: Node, symbols: ModuleSymbol[]): void {
  const span = lineSpan(declaration)

  for (const element of declaration.namedChildren) {
    if (element?.type !== "const_element") continue

    const name = firstChildOfType(element, "name")
    if (name) symbols.push({ name: name.text, kind: "const", ...span })
  }
}

// `define("NAME", value)` at statement level → a module const (its runtime equivalent).
function collectDefine(statement: Node, symbols: ModuleSymbol[]): void {
  const call = firstChildOfType(statement, "function_call_expression")
  if (!call) return

  const callee = field(call, "function")
  if (callee?.type !== "name" || callee.text !== "define") return

  const args = field(call, "arguments")
  const firstArg = args ? firstChildOfType(args, "argument") : null
  const literal = firstArg ? firstChildOfType(firstArg, "encapsed_string") : null
  const name = literal ? stringContent(literal) : null
  if (name !== null) symbols.push({ name, kind: "const", ...lineSpan(statement) })
}

// The text inside an encapsed_string (`"x"` → `x`), or null when it holds no plain content.
function stringContent(literal: Node): string | null {
  return firstChildOfType(literal, "string_content")?.text ?? null
}

// The trailing short segment of a `use` path — `App\Model\User` → `User`, a bare `Foo` → `Foo`.
function lastNamespaceSegment(pathNode: Node): string {
  if (pathNode.type === "name") return pathNode.text

  const names = pathNode.namedChildren.filter((child) => child?.type === "name")
  const last = names[names.length - 1]
  return last ? last.text : pathNode.text
}

function collectImports(root: Node): ModuleImport[] {
  const imports: ModuleImport[] = []

  for (const declaration of root.descendantsOfType("namespace_use_declaration")) {
    if (declaration) collectUseDeclaration(declaration, imports)
  }

  for (const requireExpr of root.descendantsOfType(REQUIRE_TYPES)) {
    if (requireExpr) collectRequire(requireExpr, imports)
  }

  return imports
}

// `use App\Model\User [as Acct]` / `use function App\Helpers\f` / `use const App\Config\MAX`.
// The specifier is the namespace path (`\` stripped from the front); the binding's local name is
// the alias or the short segment, its imported name always the short segment (the defined symbol).
function collectUseDeclaration(declaration: Node, imports: ModuleImport[]): void {
  for (const clause of declaration.namedChildren) {
    if (clause?.type !== "namespace_use_clause") continue

    const pathNode = firstChildOfType(clause, "qualified_name") ?? firstChildOfType(clause, "name")
    if (!pathNode) continue

    const shortName = lastNamespaceSegment(pathNode)
    const aliasing = firstChildOfType(clause, "namespace_aliasing_clause")
    const alias = aliasing ? firstChildOfType(aliasing, "name") : null
    const localName = alias ? alias.text : shortName

    const specifier = pathNode.text.replace(/^\\/, "")
    const binding: ImportBinding = { localName, importedName: shortName }
    imports.push({ specifier, bindings: [binding] })
  }
}

const REQUIRE_TYPES = [
  "require_expression",
  "require_once_expression",
  "include_expression",
  "include_once_expression",
]

// `require "./x.php"` / `include_once "../lib/y.php"` — only a RELATIVE string-literal path is a
// resolvable file dependency. A concatenated path (`__DIR__ . "/x.php"`) yields a non-relative
// string and is skipped; require carries no symbol bindings.
function collectRequire(requireExpr: Node, imports: ModuleImport[]): void {
  const literal = requireExpr.descendantsOfType("encapsed_string")[0]
  const path = literal ? stringContent(literal) : null
  if (path === null) return
  if (!path.startsWith("./") && !path.startsWith("../")) return

  imports.push({ specifier: path, bindings: [] })
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

// Calls: a plain `f()` (bound by `use function`), a static `Class::method()` (the class bound by
// `use`, recorded qualifier-style like Go's `pkg.Func`), and `new Class()` (construction is a
// call). Fully-qualified inline forms (`\App\f()`, `new \App\Thing()`) carry no `use` and are a
// known miss; a dynamic `$obj->method()` has no static class and is skipped.
function collectCallReferences(
  root: Node,
  bindings: Map<string, ImportBinding>,
  out: Reference[]
): void {
  for (const call of root.descendantsOfType("function_call_expression")) {
    const callee = call ? field(call, "function") : null
    if (callee?.type === "name" && bindings.has(callee.text)) {
      out.push({ name: callee.text, line: referenceLine(callee), kind: "call" })
    }
  }

  for (const scoped of root.descendantsOfType("scoped_call_expression")) {
    const scope = scoped ? field(scoped, "scope") : null
    const method = scoped ? field(scoped, "name") : null
    if (scope?.type === "name" && method && bindings.has(scope.text)) {
      out.push({
        name: method.text,
        line: referenceLine(method),
        kind: "call",
        qualifier: scope.text,
      })
    }
  }

  for (const creation of root.descendantsOfType("object_creation_expression")) {
    const className = creation ? firstChildOfType(creation, "name") : null
    if (className && bindings.has(className.text)) {
      out.push({ name: className.text, line: referenceLine(className), kind: "call" })
    }
  }
}

// A class name in type position: a `named_type` (parameter / return / typed property), or an
// `extends` / `implements` clause — each a bound short `name`.
function collectTypeReferences(
  root: Node,
  bindings: Map<string, ImportBinding>,
  out: Reference[]
): void {
  for (const typeNode of root.descendantsOfType("named_type")) {
    const name = typeNode ? firstChildOfType(typeNode, "name") : null
    if (name && bindings.has(name.text)) {
      out.push({ name: name.text, line: referenceLine(name), kind: "type" })
    }
  }

  for (const clause of root.descendantsOfType(["base_clause", "class_interface_clause"])) {
    if (!clause) continue

    for (const child of clause.namedChildren) {
      if (child?.type === "name" && bindings.has(child.text)) {
        out.push({ name: child.text, line: referenceLine(child), kind: "type" })
      }
    }
  }
}

function collectReferences(root: Node, bindings: Map<string, ImportBinding>): Reference[] {
  const references: Reference[] = []
  if (bindings.size === 0) return references

  collectCallReferences(root, bindings, references)
  collectTypeReferences(root, bindings, references)

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

export const phpAdapter: LanguageAdapter = { extract }
