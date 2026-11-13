import { describe, expect, it } from "vitest"

import { type ProgramStatement, synthesizedRoot, unreferencedComponents } from "./blockProgram"

const SUB_PARTS = new Set(["DiagramNode", "DiagramEdge", "Series"])
const canDrawOnItsOwn = (component: string) => !SUB_PARTS.has(component)
const ROOT_COMPONENT = "Stack"

function statement(
  name: string,
  component: string | null,
  references: string[] = []
): ProgramStatement {
  return { name, component, references }
}

describe("the components a block's missing root would list", () => {
  it("lists the components no other statement uses, in source order", () => {
    // Arrange
    const statements = [
      statement("d2", "Diagram", ["api_node"]),
      statement("api_node", "DiagramNode"),
      statement("note", "Callout"),
    ]

    // Act
    const entries = unreferencedComponents(statements, canDrawOnItsOwn)

    // Assert
    const expected = ["d2", "note"]
    expect(entries).toEqual(expected)
  })

  it("never lists a value statement or a part that only draws inside its parent", () => {
    // Arrange
    const statements = [
      statement("title", null),
      statement("n3", "DiagramNode"),
      statement("e3", "DiagramEdge"),
      statement("callout", "Callout", ["title"]),
    ]

    // Act
    const entries = unreferencedComponents(statements, canDrawOnItsOwn)

    // Assert
    const expected = ["callout"]
    expect(entries).toEqual(expected)
  })

  it("lists a name defined twice only once", () => {
    // Arrange
    const statements = [statement("a", "Callout"), statement("a", "Callout")]

    // Act
    const entries = unreferencedComponents(statements, canDrawOnItsOwn)

    // Assert
    const expected = ["a"]
    expect(entries).toEqual(expected)
  })
})

describe("a root for a block that has none", () => {
  it("is root = Stack([...]) over the unused components", () => {
    // Arrange
    const statements = [statement("d", "Diagram", ["n"]), statement("n", "DiagramNode")]

    // Act
    const root = synthesizedRoot(statements, ROOT_COMPONENT, canDrawOnItsOwn)

    // Assert
    const expected = "root = Stack([d])"
    expect(root).toBe(expected)
  })

  it("is not made when the block has a root, or holds only parts and values", () => {
    // Arrange
    const hasRoot = [statement("root", "Stack", ["d"]), statement("d", "Diagram")]
    const onlyParts = [statement("n3", "DiagramNode"), statement("e3", "DiagramEdge")]
    const onlyValues = [statement("title", null)]

    // Act
    const roots = [hasRoot, onlyParts, onlyValues, []].map((statements) =>
      synthesizedRoot(statements, ROOT_COMPONENT, canDrawOnItsOwn)
    )

    // Assert
    expect(roots).toEqual([null, null, null, null])
  })
})
