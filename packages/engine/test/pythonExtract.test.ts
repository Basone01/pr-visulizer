import { describe, expect, it } from "vitest"

import { createSyntaxAnalyzer } from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"

// Python symbol/import/reference extraction (docs/architecture.md §5–§6). Driven through the
// REAL tree-sitter-python wasm (node GrammarSource, off disk) — the node-type names the adapter
// reads were verified empirically against the grammar, not recalled. Samples are valid Python 3.

const analyzer = createSyntaxAnalyzer(createNodeGrammarSource())

describe("Python extraction — symbols", () => {
  it("extracts functions (incl async + decorated), classes with methods, and SCREAMING const", async () => {
    // Arrange
    const source = `import os

TIMEOUT_SECONDS = 30
lower_case = 1

def top_level(x):
    return x

async def fetch_it(u):
    return u

@decorator
def decorated(a):
    return a

class Widget:
    def method_one(self):
        return self.x

    async def method_two(self):
        return 2
`

    // Act
    const syntax = await analyzer.analyzeSyntax("python", source)
    const symbolSummary = syntax.symbols.map((symbol) => ({ name: symbol.name, kind: symbol.kind }))

    // Assert — lower_case is a mutable module var (not SCREAMING), so it is NOT a const.
    const expected = [
      { name: "TIMEOUT_SECONDS", kind: "const" },
      { name: "top_level", kind: "function" },
      { name: "fetch_it", kind: "function" },
      { name: "decorated", kind: "function" },
      { name: "Widget", kind: "class" },
      { name: "method_one", kind: "method" },
      { name: "method_two", kind: "method" },
    ]
    expect(symbolSummary).toEqual(expected)
  })
})

describe("Python extraction — imports", () => {
  it("records dotted, aliased, from-import, and relative specifiers with their bindings", async () => {
    // Arrange
    const source = `import os
import a.b as mod
from a.b import helper as h
from a.b import Thing
from . import sibling
from .mod import y
`

    // Act
    const syntax = await analyzer.analyzeSyntax("python", source)
    const importSummary = syntax.imports.map((moduleImport) => ({
      specifier: moduleImport.specifier,
      binding: moduleImport.bindings[0]?.localName,
      importedName: moduleImport.bindings[0]?.importedName,
      namespace: moduleImport.bindings[0]?.namespace ?? false,
    }))

    // Assert — `import os` and `import a.b as mod` are namespace bindings; from-imports are named.
    const expected = [
      { specifier: "os", binding: "os", importedName: "os", namespace: true },
      { specifier: "a.b", binding: "mod", importedName: "mod", namespace: true },
      { specifier: "a.b", binding: "h", importedName: "helper", namespace: false },
      { specifier: "a.b", binding: "Thing", importedName: "Thing", namespace: false },
      { specifier: ".", binding: "sibling", importedName: "sibling", namespace: false },
      { specifier: ".mod", binding: "y", importedName: "y", namespace: false },
    ]
    expect(importSummary).toEqual(expected)
  })
})

describe("Python extraction — references", () => {
  it("captures plain calls, qualified (mod.helper) calls, and value uses of imported names", async () => {
    // Arrange — `helper` is a plain call, `mod.compute` a namespace-qualified call, `Thing`
    // (bare) and `MAX` value uses of imported names. `local` is not imported, so it is never
    // captured.
    const source = `import a.b as mod
from a.b import helper
from a.b import Thing
from a.b import MAX

def build(x):
    local = 1
    r = helper(x)
    q = mod.compute(x)
    cls = Thing
    return cls(r) + MAX + local
`

    // Act
    const references = (await analyzer.analyzeSyntax("python", source)).references
    const summary = {
      plainCall: references.some(
        (reference) =>
          reference.kind === "call" &&
          reference.name === "helper" &&
          reference.qualifier === undefined
      ),
      qualifiedCall: references.some(
        (reference) =>
          reference.kind === "call" && reference.name === "compute" && reference.qualifier === "mod"
      ),
      typeValueUse: references.some(
        (reference) => reference.kind === "use" && reference.name === "Thing"
      ),
      constValueUse: references.some(
        (reference) => reference.kind === "use" && reference.name === "MAX"
      ),
      localExcluded: !references.some((reference) => reference.name === "local"),
    }

    // Assert
    const expected = {
      plainCall: true,
      qualifiedCall: true,
      typeValueUse: true,
      constValueUse: true,
      localExcluded: true,
    }
    expect(summary).toEqual(expected)
  })
})
