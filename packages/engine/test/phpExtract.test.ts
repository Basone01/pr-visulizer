import { describe, expect, it } from "vitest"

import { createSyntaxAnalyzer } from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"

// PHP symbol/import/reference extraction (docs/architecture.md §5–§6). Driven through the REAL
// tree-sitter-php wasm (node GrammarSource, off disk) — the node-type names the adapter reads
// were verified empirically against the grammar, not recalled. Samples are valid PHP 7.4,
// including typed properties, `fn() =>` arrow functions and the `??=` null-coalescing assignment.

const analyzer = createSyntaxAnalyzer(createNodeGrammarSource())

describe("PHP extraction — symbols", () => {
  it("extracts functions, classes/interfaces/traits with methods, consts and define()", async () => {
    // Arrange
    const source = `<?php
namespace App\\Service;

const LIMIT = 100;
define("DEFINED_ONE", 5);

interface Contract {
    public function doThing(): int;
}

trait Shareable {
    public function share() {}
}

class Widget implements Contract {
    public int $typedProp = 0;

    public function doThing(): int {
        $this->typedProp ??= 5;
        $fn = fn($z) => $z + 1;
        return $fn(2);
    }
}

function top_level(): int {
    return 1;
}
`

    // Act
    const syntax = await analyzer.analyzeSyntax("php", source)
    const symbolSummary = syntax.symbols.map((symbol) => ({ name: symbol.name, kind: symbol.kind }))

    // Assert — a class is kind "class"; an interface/trait is kind "type"; both carry methods.
    const expected = [
      { name: "LIMIT", kind: "const" },
      { name: "DEFINED_ONE", kind: "const" },
      { name: "Contract", kind: "type" },
      { name: "doThing", kind: "method" },
      { name: "Shareable", kind: "type" },
      { name: "share", kind: "method" },
      { name: "Widget", kind: "class" },
      { name: "doThing", kind: "method" },
      { name: "top_level", kind: "function" },
    ]
    expect(symbolSummary).toEqual(expected)
  })
})

describe("PHP extraction — imports", () => {
  it("records use/use-function/use-const with aliases, and relative require/include paths", async () => {
    // Arrange
    const source = `<?php
namespace App\\Service;

use App\\Model\\User;
use App\\Model\\Account as Acct;
use function App\\Helpers\\format_name;
use const App\\Config\\MAX;

require_once __DIR__ . "/bootstrap.php";
require "./helpers.php";
include_once "../lib/x.php";
`

    // Act
    const syntax = await analyzer.analyzeSyntax("php", source)
    const importSummary = syntax.imports.map((moduleImport) => ({
      specifier: moduleImport.specifier,
      binding: moduleImport.bindings[0]?.localName,
      importedName: moduleImport.bindings[0]?.importedName,
    }))

    // Assert — an alias wins as the local name; the imported name stays the short segment. The
    // `__DIR__ . "..."` concatenation is not a plain relative path, so it is skipped.
    const expected = [
      { specifier: "App\\Model\\User", binding: "User", importedName: "User" },
      { specifier: "App\\Model\\Account", binding: "Acct", importedName: "Account" },
      {
        specifier: "App\\Helpers\\format_name",
        binding: "format_name",
        importedName: "format_name",
      },
      { specifier: "App\\Config\\MAX", binding: "MAX", importedName: "MAX" },
      { specifier: "./helpers.php", binding: undefined, importedName: undefined },
      { specifier: "../lib/x.php", binding: undefined, importedName: undefined },
    ]
    expect(importSummary).toEqual(expected)
  })
})

describe("PHP extraction — references", () => {
  it("captures plain calls, static Class::method, new Class, and class names in type position", async () => {
    // Arrange — only names a `use` bound are captured; `helper()` is same-namespace with no use.
    const source = `<?php
namespace App\\Service;

use App\\Model\\User;
use App\\Model\\Account as Acct;

class Widget extends User {
    public function run(Acct $a): int {
        $u = new User();
        $x = User::create();
        return helper($u);
    }
}
`

    // Act
    const references = (await analyzer.analyzeSyntax("php", source)).references
    const summary = {
      newAsCall: references.some(
        (reference) =>
          reference.kind === "call" &&
          reference.name === "User" &&
          reference.qualifier === undefined
      ),
      staticCall: references.some(
        (reference) =>
          reference.kind === "call" && reference.name === "create" && reference.qualifier === "User"
      ),
      typePosition: references.some(
        (reference) => reference.kind === "type" && reference.name === "Acct"
      ),
      extendsType: references.some(
        (reference) => reference.kind === "type" && reference.name === "User"
      ),
      unboundExcluded: !references.some((reference) => reference.name === "helper"),
    }

    // Assert
    const expected = {
      newAsCall: true,
      staticCall: true,
      typePosition: true,
      extendsType: true,
      unboundExcluded: true,
    }
    expect(summary).toEqual(expected)
  })
})
