import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { DEFAULT_DIFF_VIEW_SETTINGS, type DiffViewSettings } from "@/config/settings"

import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import { useDiffViewSettings } from "./useDiffViewSettings"

// The hook persists the diff-view preferences through an injected KeyValueStore and restores
// them on the next mount — the same round-trip the desktop Store / localStorage give in the app.

describe("useDiffViewSettings", () => {
  it("starts from the defaults and reports loaded", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const expected: DiffViewSettings = DEFAULT_DIFF_VIEW_SETTINGS

    // Act
    const { result } = renderHook(() => useDiffViewSettings(store))
    await waitFor(() => expect(result.current.isLoaded).toBe(true))

    // Assert
    expect(result.current.settings).toEqual(expected)
  })

  it("persists a toggle and restores it on a fresh mount", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const expected: DiffViewSettings = {
      wrap: true,
      hideWhitespace: true,
      fullFile: true,
      splitView: true,
    }

    // Act — toggle all four on, then mount a second hook against the same store.
    const first = renderHook(() => useDiffViewSettings(store))
    await waitFor(() => expect(first.result.current.isLoaded).toBe(true))
    await act(async () => first.result.current.toggleWrap())
    await act(async () => first.result.current.toggleHideWhitespace())
    await act(async () => first.result.current.toggleFullFile())
    await act(async () => first.result.current.toggleSplitView())

    const second = renderHook(() => useDiffViewSettings(store))
    await waitFor(() => expect(second.result.current.isLoaded).toBe(true))

    // Assert
    expect(second.result.current.settings).toEqual(expected)
  })

  it("keeps the older toggles of a record persisted before full-file and split-view existed", async () => {
    // Arrange — what a reviewer who used wrap/hide-whitespace already has on disk.
    const store = createMemoryKeyValueStore()
    const legacyRecord = JSON.stringify({ wrap: true, hideWhitespace: true })
    await store.set("diffViewSettings", legacyRecord)
    const expected: DiffViewSettings = {
      wrap: true,
      hideWhitespace: true,
      fullFile: false,
      splitView: false,
    }

    // Act
    const { result } = renderHook(() => useDiffViewSettings(store))
    await waitFor(() => expect(result.current.isLoaded).toBe(true))

    // Assert — the missing field defaults instead of failing the parse and resetting the rest.
    expect(result.current.settings).toEqual(expected)
  })
})
