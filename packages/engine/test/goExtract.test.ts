import { describe, expect, it } from "vitest"

import { createSyntaxAnalyzer } from "../src/index.js"
import { createNodeGrammarSource } from "../src/node.js"

// Go symbol/import/reference extraction (docs/architecture.md §6). Driven through the
// REAL tree-sitter-go wasm (node GrammarSource, off disk) — the node-type names below
// were verified empirically against the grammar, not recalled.

const analyzer = createSyntaxAnalyzer(createNodeGrammarSource())

describe("Go extraction — symbols", () => {
  it("extracts functions, methods, types and consts with their kinds", async () => {
    // Arrange
    const source = `package metrics

type Report struct {
	Total int
}

const MaxReports = 100

func Aggregate(r Report) int {
	return r.Total
}

func (r Report) Sum() int {
	return r.Total
}
`

    // Act
    const syntax = await analyzer.analyzeSyntax("go", source)
    const symbolSummary = syntax.symbols.map((symbol) => ({ name: symbol.name, kind: symbol.kind }))

    // Assert
    const expected = [
      { name: "Report", kind: "type" },
      { name: "MaxReports", kind: "const" },
      { name: "Aggregate", kind: "function" },
      { name: "Sum", kind: "method" },
    ]
    expect(symbolSummary).toEqual(expected)
  })
})

describe("Go extraction — imports", () => {
  it("records each import path and its package qualifier, alias or last segment", async () => {
    // Arrange
    const source = `package api

import (
	"fmt"
	m "example.com/proj/mathx"
	"example.com/proj/pkg/metrics"
)

func use() {
	fmt.Println("x")
}
`

    // Act
    const syntax = await analyzer.analyzeSyntax("go", source)
    const importSummary = syntax.imports.map((moduleImport) => ({
      specifier: moduleImport.specifier,
      qualifier: moduleImport.bindings[0]?.localName,
    }))

    // Assert
    const expected = [
      { specifier: "fmt", qualifier: "fmt" },
      { specifier: "example.com/proj/mathx", qualifier: "m" }, // alias wins over last segment
      { specifier: "example.com/proj/pkg/metrics", qualifier: "metrics" },
    ]
    expect(importSummary).toEqual(expected)
  })
})

describe("Go extraction — references", () => {
  it("captures plain + selector calls and qualified + bare type uses, excluding declaration names", async () => {
    // Arrange
    const source = `package api

import "example.com/proj/pkg/metrics"

type Unused struct {
	X int
}

func Build(r metrics.Report) int {
	local := Helper(r)
	return metrics.Total(local)
}

func Helper(r metrics.Report) int {
	var v Report
	return v.Total
}
`

    // Act
    const references = (await analyzer.analyzeSyntax("go", source)).references
    const summary = {
      plainCall: references.some(
        (r) => r.kind === "call" && r.name === "Helper" && r.qualifier === undefined
      ),
      selectorCall: references.some(
        (r) => r.kind === "call" && r.name === "Total" && r.qualifier === "metrics"
      ),
      qualifiedType: references.some(
        (r) => r.kind === "type" && r.name === "Report" && r.qualifier === "metrics"
      ),
      bareType: references.some(
        (r) => r.kind === "type" && r.name === "Report" && r.qualifier === undefined
      ),
      declarationNameExcluded: !references.some((r) => r.name === "Unused"),
    }

    // Assert
    const expected = {
      plainCall: true,
      selectorCall: true,
      qualifiedType: true,
      bareType: true,
      declarationNameExcluded: true,
    }
    expect(summary).toEqual(expected)
  })

  it("captures a const/var used as a value (pkg.Const) as a 'use' reference, not double-counting calls", async () => {
    // Arrange — auth.go consumes constant.TempKeyPrefix as a VALUE (an argument), and calls
    // constant.Validate() (a call). The value use is the link the extractor previously missed.
    const source = `package auth

import "example.com/proj/pkg/constant"

func Check(key string) bool {
	prefix := constant.TempKeyPrefix
	_ = prefix
	if constant.Validate(key) {
		return true
	}
	return strings.HasPrefix(key, constant.TempKeyPrefix)
}
`

    // Act
    const references = (await analyzer.analyzeSyntax("go", source)).references
    const tempKeyUses = references.filter((r) => r.name === "TempKeyPrefix")
    const validateRefs = references.filter((r) => r.name === "Validate")

    // Assert — TempKeyPrefix captured as a value use (both sites), qualified by the package;
    // the call `constant.Validate()` is a call only, never re-captured as a value use.
    const expected = {
      tempKeyUseCount: 2,
      tempKeyKind: "use",
      tempKeyQualifier: "constant",
      validateKinds: ["call"],
    }
    expect({
      tempKeyUseCount: tempKeyUses.length,
      tempKeyKind: tempKeyUses[0]?.kind,
      tempKeyQualifier: tempKeyUses[0]?.qualifier,
      validateKinds: [...new Set(validateRefs.map((r) => r.kind))],
    }).toEqual(expected)
  })
})
