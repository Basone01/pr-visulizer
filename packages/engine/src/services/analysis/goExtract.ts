import type { Node } from "web-tree-sitter"

import type {
  ImportBinding,
  LanguageAdapter,
  ModuleImport,
  ModuleSymbol,
  ModuleSyntax,
  Reference,
} from "./treeSitter.js"

// The Go extraction adapter (docs/architecture.md §6, deep-engine v1). Node-type names
// below were verified EMPIRICALLY against tree-sitter-go (a scratch parse, not memory):
//
//   symbols     function_declaration / method_declaration (name field),
//               type_declaration → type_spec | type_alias (name = type_identifier),
//               const_declaration → const_spec (name children = identifier)
//   imports     import_spec: field `path` = interpreted_string_literal,
//               optional field `name` = package_identifier (the alias)
//   references  call_expression field `function` = identifier (plain call) or
//               selector_expression (operand=package_identifier-ish, field=func);
//               qualified_type (package + name) and bare type_identifier for type uses
//
// The whole point of deep mode for Go: a same-package reference carries NO import and
// NO qualifier (Go resolves it within the directory), so per-file fast mode can never
// see it. The qualifier is recorded here; resolution happens in `./deepResolve`.

function lineSpan(node: Node): { startLine: number; endLine: number } {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }
}

function referenceLine(node: Node): number {
  return node.startPosition.row + 1
}

function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name)
}

// The last path segment — the default package qualifier for an unaliased import
// (`example.com/proj/pkg/metrics` → `metrics`, used as `metrics.Report`).
function lastPathSegment(importPath: string): string {
  const slash = importPath.lastIndexOf("/")
  return slash < 0 ? importPath : importPath.slice(slash + 1)
}

function unquote(text: string): string {
  return text.slice(1, -1)
}

function collectSymbols(root: Node): ModuleSymbol[] {
  const symbols: ModuleSymbol[] = []

  for (const statement of root.namedChildren) {
    if (!statement) continue

    if (statement.type === "function_declaration" || statement.type === "method_declaration") {
      const name = field(statement, "name")
      if (name)
        symbols.push({
          name: name.text,
          kind: statement.type === "method_declaration" ? "method" : "function",
          ...lineSpan(statement),
        })
      continue
    }

    if (statement.type === "type_declaration") {
      collectTypeSpecs(statement, symbols)
      continue
    }

    if (statement.type === "const_declaration") {
      collectConstSpecs(statement, symbols)
    }
  }

  return symbols
}

// `type` block: one or many `type_spec` (struct/interface/named) or `type_alias`
// (`type Celsius = float64`). Struct, interface and alias all map to kind "type" (§2).
function collectTypeSpecs(declaration: Node, symbols: ModuleSymbol[]): void {
  for (const spec of declaration.namedChildren) {
    if (spec?.type !== "type_spec" && spec?.type !== "type_alias") continue

    const name = field(spec, "name")
    if (name) symbols.push({ name: name.text, kind: "type", ...lineSpan(spec) })
  }
}

// `const` block: one or many `const_spec`, each declaring one or more names
// (`const a, b = 1, 2`). Every name shares the spec's span.
function collectConstSpecs(declaration: Node, symbols: ModuleSymbol[]): void {
  for (const spec of declaration.namedChildren) {
    if (spec?.type !== "const_spec") continue

    const span = lineSpan(spec)
    for (const child of spec.namedChildren) {
      if (child?.type === "identifier") symbols.push({ name: child.text, kind: "const", ...span })
    }
  }
}

function collectImports(root: Node): ModuleImport[] {
  const imports: ModuleImport[] = []

  for (const spec of root.descendantsOfType("import_spec")) {
    if (!spec) continue

    const path = field(spec, "path")
    if (!path) continue

    const specifier = unquote(path.text)
    const alias = field(spec, "name")

    // A dot-import (`import . "pkg"`) merges the package into this file's scope with no
    // qualifier — we cannot resolve those and skip the binding (documented miss, §6).
    if (alias?.text === ".") {
      imports.push({ specifier, bindings: [] })
      continue
    }

    const qualifier = alias ? alias.text : lastPathSegment(specifier)
    const binding: ImportBinding = { localName: qualifier, importedName: qualifier }
    imports.push({ specifier, bindings: [binding] })
  }

  return imports
}

function collectCallReferences(root: Node, references: Reference[]): void {
  for (const call of root.descendantsOfType("call_expression")) {
    const callee = call ? field(call, "function") : null
    if (!callee) continue

    // Plain same-package / builtin call: `Aggregate(x)`.
    if (callee.type === "identifier") {
      references.push({ name: callee.text, line: referenceLine(callee), kind: "call" })
      continue
    }

    // Selector call `pkg.Func(...)` — but ALSO method/field calls `v.Method(...)`. We
    // record the operand as the qualifier regardless; resolution only accepts it when
    // it matches an imported package, so a variable receiver harmlessly resolves to
    // nothing. Nested selectors (`a.b.c()`) have a non-identifier operand → skipped.
    if (callee.type === "selector_expression") {
      const operand = field(callee, "operand")
      const member = field(callee, "field")
      if (operand?.type === "identifier" && member) {
        references.push({
          name: member.text,
          line: referenceLine(member),
          kind: "call",
          qualifier: operand.text,
        })
      }
    }
  }
}

function collectTypeReferences(root: Node, references: Reference[]): void {
  // Cross-package type use `pkg.Type` — a distinct node from a bare type_identifier.
  for (const qualified of root.descendantsOfType("qualified_type")) {
    if (!qualified) continue

    const pkg = field(qualified, "package")
    const name = field(qualified, "name")
    if (pkg && name) {
      references.push({
        name: name.text,
        line: referenceLine(name),
        kind: "type",
        qualifier: pkg.text,
      })
    }
  }

  // Bare type uses — same-package or builtin. Two must be excluded:
  //   - the `name` inside a qualified_type (already recorded, with its qualifier)
  //   - a declaration's OWN name (`type Report struct` — that is a definition, not a use)
  for (const typeRef of root.descendantsOfType("type_identifier")) {
    if (!typeRef) continue

    const parent = typeRef.parent
    if (parent?.type === "qualified_type") continue
    if (isDeclarationName(typeRef, parent)) continue

    references.push({ name: typeRef.text, line: referenceLine(typeRef), kind: "type" })
  }
}

// Is this type_identifier the NAME being declared (vs. a type being used)? True when it
// is the `name` field of its enclosing type_spec / type_alias.
function isDeclarationName(node: Node, parent: Node | null): boolean {
  if (parent?.type !== "type_spec" && parent?.type !== "type_alias") return false

  const name = field(parent, "name")
  return name != null && name.startIndex === node.startIndex && name.endIndex === node.endIndex
}

// Value references to a package member: `pkg.Const` / `pkg.Var` in VALUE position (an
// argument, an assignment RHS, a condition) — a `selector_expression` whose operand is an
// identifier. This is the link for a Go file that consumes a shared constant/var but calls no
// function and uses no type of the other package (e.g. `constant.TempKeyPrefix`). It is safe
// to capture broadly: resolution only accepts a qualifier that matches an imported package, so
// a local receiver's field access (`v.Field`) matches no import and resolves to nothing.
// Callee selectors (`pkg.Func()`) are already recorded by collectCallReferences — skip those.
function collectValueReferences(root: Node, references: Reference[]): void {
  for (const selector of root.descendantsOfType("selector_expression")) {
    if (!selector) continue

    const operand = field(selector, "operand")
    const member = field(selector, "field")
    if (operand?.type !== "identifier" || !member) continue

    const parent = selector.parent
    const callee = parent?.type === "call_expression" ? field(parent, "function") : null
    if (
      callee &&
      callee.startIndex === selector.startIndex &&
      callee.endIndex === selector.endIndex
    ) {
      continue
    }

    references.push({
      name: member.text,
      line: referenceLine(member),
      kind: "use",
      qualifier: operand.text,
    })
  }
}

function extract(root: Node): ModuleSyntax {
  const references: Reference[] = []
  collectCallReferences(root, references)
  collectTypeReferences(root, references)
  collectValueReferences(root, references)

  return { symbols: collectSymbols(root), imports: collectImports(root), references }
}

export const goAdapter: LanguageAdapter = { extract }
