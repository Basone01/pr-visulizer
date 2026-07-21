import { describe, expect, it } from "vitest"

import {
  type ThemePreference,
  appliedAttribute,
  applyPreference,
  attributeFor,
  nextPreference,
  resolvePreference,
} from "./theme"

describe("resolvePreference", () => {
  it("keeps a valid stored preference", () => {
    // Arrange
    const stored = "dark"

    // Act
    const preference = resolvePreference(stored)

    // Assert
    const expected: ThemePreference = "dark"
    expect(preference).toBe(expected)
  })

  it("falls back to system for an unknown or absent value", () => {
    // Arrange
    const unknown = "solarized"
    const absent = null

    // Act
    const fromUnknown = resolvePreference(unknown)
    const fromAbsent = resolvePreference(absent)

    // Assert
    const expected: ThemePreference = "system"
    expect(fromUnknown).toBe(expected)
    expect(fromAbsent).toBe(expected)
  })
})

describe("appliedAttribute — stored preference to the data-theme that lands on <html>", () => {
  it("maps an explicit choice to its attribute", () => {
    // Arrange
    const storedLight = "light"
    const storedDark = "dark"

    // Act
    const lightAttribute = appliedAttribute(storedLight)
    const darkAttribute = appliedAttribute(storedDark)

    // Assert
    expect(lightAttribute).toBe("light")
    expect(darkAttribute).toBe("dark")
  })

  it("maps system (and any invalid value) to null — no attribute, OS preference wins", () => {
    // Arrange
    const storedSystem = "system"
    const garbage = "not-a-theme"

    // Act
    const systemAttribute = appliedAttribute(storedSystem)
    const garbageAttribute = appliedAttribute(garbage)

    // Assert
    const expected = null
    expect(systemAttribute).toBe(expected)
    expect(garbageAttribute).toBe(expected)
  })
})

describe("attributeFor", () => {
  it("returns null for system so the attribute is removed", () => {
    // Arrange
    const preference: ThemePreference = "system"

    // Act
    const attribute = attributeFor(preference)

    // Assert
    expect(attribute).toBeNull()
  })
})

describe("nextPreference — single-button cycle order", () => {
  it("cycles system -> light -> dark -> system", () => {
    // Arrange
    const start: ThemePreference = "system"

    // Act
    const afterFirst = nextPreference(start)
    const afterSecond = nextPreference(afterFirst)
    const afterThird = nextPreference(afterSecond)

    // Assert
    expect(afterFirst).toBe("light")
    expect(afterSecond).toBe("dark")
    expect(afterThird).toBe("system")
  })
})

describe("applyPreference — the side effect at the edge", () => {
  it("stamps data-theme for an explicit choice", () => {
    // Arrange
    const root = document.createElement("html")
    const preference: ThemePreference = "dark"

    // Act
    applyPreference(preference, root)

    // Assert
    const expected = "dark"
    expect(root.getAttribute("data-theme")).toBe(expected)
  })

  it("removes data-theme for system", () => {
    // Arrange
    const root = document.createElement("html")
    root.setAttribute("data-theme", "light")
    const preference: ThemePreference = "system"

    // Act
    applyPreference(preference, root)

    // Assert
    expect(root.hasAttribute("data-theme")).toBe(false)
  })
})
