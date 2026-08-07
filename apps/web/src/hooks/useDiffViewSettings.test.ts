import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

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
      intraLineDiff: true,
      markdownPreview: true,
      markdownRichDiff: true,
    }

    // Act — toggle all seven on, then mount a second hook against the same store.
    const first = renderHook(() => useDiffViewSettings(store))
    await waitFor(() => expect(first.result.current.isLoaded).toBe(true))
    await act(async () => first.result.current.toggleWrap())
    await act(async () => first.result.current.toggleHideWhitespace())
    await act(async () => first.result.current.toggleFullFile())
    await act(async () => first.result.current.toggleSplitView())
    await act(async () => first.result.current.toggleIntraLineDiff())
    await act(async () => first.result.current.toggleMarkdownPreview())
    await act(async () => first.result.current.toggleMarkdownRichDiff())

    const second = renderHook(() => useDiffViewSettings(store))
    await waitFor(() => expect(second.result.current.isLoaded).toBe(true))

    // Assert
    expect(second.result.current.settings).toEqual(expected)
  })

  it("keeps the older toggles of a record persisted before the later toggles existed", async () => {
    // Arrange — what a reviewer who used wrap/hide-whitespace already has on disk, from before
    // full-file, split-view, intra-line emphasis and the two markdown toggles were added.
    const store = createMemoryKeyValueStore()
    const legacyRecord = JSON.stringify({ wrap: true, hideWhitespace: true })
    await store.set("diffViewSettings", legacyRecord)
    const expected: DiffViewSettings = {
      wrap: true,
      hideWhitespace: true,
      fullFile: false,
      splitView: false,
      intraLineDiff: false,
      markdownPreview: false,
      markdownRichDiff: false,
    }

    // Act
    const { result } = renderHook(() => useDiffViewSettings(store))
    await waitFor(() => expect(result.current.isLoaded).toBe(true))

    // Assert — the missing field defaults instead of failing the parse and resetting the rest.
    expect(result.current.settings).toEqual(expected)
  })
})

// The DEFAULT store path (no injection) — the one the app actually runs on. It used to be a
// fresh wrapper per call, so `useEffect([store])` re-ran on every render and a read that
// resolved after a toggle put the old value back. The count is the guarantee: load once.

describe("useDiffViewSettings — the default app storage", () => {
  it("reads the persisted settings once, not on every render", async () => {
    // Arrange
    window.localStorage.clear()
    const getItem = vi.spyOn(Storage.prototype, "getItem")
    const settingsKey = "prv:diffViewSettings"

    // Act — mount, let the load settle, then re-render several times.
    const { result, rerender } = renderHook(() => useDiffViewSettings())
    await waitFor(() => expect(result.current.isLoaded).toBe(true))
    rerender()
    rerender()
    rerender()

    // Assert
    const expectedReads = 1
    const settingsReads = getItem.mock.calls.filter(([key]) => key === settingsKey).length
    expect(settingsReads).toBe(expectedReads)

    getItem.mockRestore()
  })

  it("keeps a toggle made right after mount instead of reverting it", async () => {
    // Arrange — the reported symptom: flip a toggle while the initial load is still in flight.
    window.localStorage.clear()
    const { result } = renderHook(() => useDiffViewSettings())

    // Act
    await act(async () => result.current.toggleIntraLineDiff())
    await waitFor(() => expect(result.current.isLoaded).toBe(true))

    // Assert — the toggle survives the load that lands after it.
    const expected = true
    expect(result.current.settings.intraLineDiff).toBe(expected)
  })
})
