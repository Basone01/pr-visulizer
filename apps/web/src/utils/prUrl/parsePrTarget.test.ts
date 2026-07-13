import { describe, expect, it } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { parsePrTarget } from "./parsePrTarget"

// The URL input is an untrusted boundary (docs/tauri-architecture.md §5): every accepted
// form must parse to the SAME typed target, and everything else must be null so the UI can
// show the inline hint instead of navigating to a broken PR.

describe("parsePrTarget", () => {
  const expected: PrTarget = { owner: "acme", repo: "web", number: 42 }

  it("parses a full GitHub PR URL", () => {
    // Arrange
    const input = "https://github.com/acme/web/pull/42"

    // Act
    const target = parsePrTarget(input)

    // Assert
    expect(target).toEqual(expected)
  })

  it("parses a full URL with a trailing sub-path", () => {
    // Arrange
    const input = "https://github.com/acme/web/pull/42/files"

    // Act
    const target = parsePrTarget(input)

    // Assert
    expect(target).toEqual(expected)
  })

  it("parses the owner/repo#number form", () => {
    // Arrange
    const input = "acme/web#42"

    // Act
    const target = parsePrTarget(input)

    // Assert
    expect(target).toEqual(expected)
  })

  it("parses the owner/repo/number form", () => {
    // Arrange
    const input = "acme/web/42"

    // Act
    const target = parsePrTarget(input)

    // Assert
    expect(target).toEqual(expected)
  })

  it("trims surrounding whitespace before parsing", () => {
    // Arrange
    const input = "  acme/web#42  "

    // Act
    const target = parsePrTarget(input)

    // Assert
    expect(target).toEqual(expected)
  })

  it.each([
    ["empty string", ""],
    ["a bare repo with no number", "acme/web"],
    ["a non-numeric number", "acme/web#abc"],
    ["a zero PR number", "acme/web/0"],
    ["a URL without the pull segment", "https://github.com/acme/web"],
    ["a repo path with too many segments", "acme/web/extra/42"],
    ["junk", "not a pr at all"],
  ])("returns null for %s", (_label, input) => {
    // Act
    const target = parsePrTarget(input)

    // Assert
    expect(target).toBeNull()
  })
})
