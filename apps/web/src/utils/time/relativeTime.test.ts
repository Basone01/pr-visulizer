import { describe, expect, it } from "vitest"

import { formatRelativeTime } from "./relativeTime"

// Deterministic because `now` is injected — the open-PR list's updated-at label.

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-07T12:00:00.000Z")

  it.each([
    ["seconds ago", "2026-07-07T11:59:30.000Z", "just now"],
    ["minutes ago", "2026-07-07T11:30:00.000Z", "30m ago"],
    ["hours ago", "2026-07-07T09:00:00.000Z", "3h ago"],
    ["days ago", "2026-07-01T12:00:00.000Z", "6d ago"],
    ["months ago", "2026-04-07T12:00:00.000Z", "3mo ago"],
  ])("formats a timestamp %s", (_label, iso, expected) => {
    // Act
    const label = formatRelativeTime(iso, now)

    // Assert
    expect(label).toBe(expected)
  })

  it("returns an empty string for an unparseable value", () => {
    // Arrange
    const iso = "not-a-date"

    // Act
    const label = formatRelativeTime(iso, now)

    // Assert
    expect(label).toBe("")
  })
})
