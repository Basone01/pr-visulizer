import { describe, expect, it } from "vitest"

import { synthesizedRoot } from "@/entity/openuiBlock/blockProgram"

import { readStatements } from "./blockStatements"
import { REVIEW_ROOT_COMPONENT, canDrawOnItsOwn } from "./reviewLibrary"

function program(...lines: string[]): string {
  return lines.join("\n")
}

describe("a block's statements as lang-core reads them", () => {
  it("does not count a name inside a string or a comment as a use", () => {
    // Arrange
    const code = program(
      '# a uses b, see "b"',
      'a = Callout("info", "b", \'mentions b\')',
      "// b is used by a",
      'b = Callout("info", "B", "text")'
    )

    // Act
    const statements = readStatements(code)

    // Assert
    expect(statements.map((statement) => statement.references)).toEqual([[], []])
  })

  it("keeps a ternary that continues on the next lines as one statement", () => {
    // Arrange
    const code = program("pick = $show", "  ? w", "  : i", 'w = Callout("info", "W", "w")')

    // Act
    const statements = readStatements(code)

    // Assert
    expect(statements.map(({ name, references }) => ({ name, references }))).toEqual([
      { name: "pick", references: ["w", "i"] },
      { name: "w", references: [] },
    ])
  })

  it("does not count an object key as a use, but does count its value", () => {
    // Arrange
    const code = "cfg = {summary: total, other: 1}"

    // Act
    const statements = readStatements(code)

    // Assert
    expect(statements[0]?.references).toEqual(["total"])
  })

  it("knows which statements build a component and which are plain values", () => {
    // Arrange
    const code = program('title = "Queue rollout"', "count = 3", "d = Diagram(title, [n], [])")

    // Act
    const statements = readStatements(code)

    // Assert
    expect(statements.map(({ name, component }) => ({ name, component }))).toEqual([
      { name: "title", component: null },
      { name: "count", component: null },
      { name: "d", component: "Diagram" },
    ])
  })

  it("still reads the statements after one that does not parse", () => {
    // Arrange
    const code = program(
      'a = Callout("info", "A", "a")',
      "broken = = =",
      'b = Callout("info", "B", "b")',
      "c = Stack([a])"
    )

    // Act
    const statements = readStatements(code)

    // Assert
    expect(statements.map(({ name, references }) => ({ name, references }))).toEqual([
      { name: "a", references: [] },
      { name: "broken", references: [] },
      { name: "b", references: [] },
      { name: "c", references: ["a"] },
    ])
  })

  it("does not count a property after a dot or a call's own name as a use", () => {
    // Arrange
    const code = "cell = Callout(total.label, Badge(items))"

    // Act
    const statements = readStatements(code)

    // Assert
    expect(statements[0]?.references).toEqual(["total", "items"])
  })

  it("gives a rootless block a root over its components, never over a built-in action", () => {
    // Arrange
    const code = program(
      'ask = @ToAssistant("Explain the queue")',
      'note = Callout("info", "N", "n")'
    )

    // Act
    const root = synthesizedRoot(readStatements(code), REVIEW_ROOT_COMPONENT, canDrawOnItsOwn)

    // Assert
    const expected = "root = Stack([note])"
    expect(root).toBe(expected)
  })
})
