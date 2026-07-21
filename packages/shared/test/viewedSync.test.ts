import { describe, expect, it } from "vitest"

import { type ViewedMergeInput, mergeViewedFiles, viewedDelta } from "../src/review/viewedSync.js"

// The reconciliation rules behind the two-way "Viewed" sync (docs/architecture.md §11).
// Paths are PR #42's real changed files so a reader recognizes the fixture.

const AUTH = "src/auth/session.ts"
const API = "src/api/client.ts"
const UTIL = "src/utils/format.ts"

describe("mergeViewedFiles", () => {
  it("unions both sides on a first sync, when there is no ancestor to compare against", () => {
    // Arrange
    const local = [AUTH]
    const remote = [API]
    const base = null
    const input: ViewedMergeInput = { local, remote, base }

    // Act
    const merged = mergeViewedFiles(input)

    // Assert — neither side's checkmark may be dropped without evidence it was un-ticked.
    const expected = [API, AUTH]
    expect(merged).toEqual(expected)
  })

  it("keeps a file GitHub reports as viewed even though the app never ticked it", () => {
    // Arrange — the reviewer ticked "Viewed" on github.com; the app has nothing recorded.
    const local: string[] = []
    const remote = [AUTH]
    const base: string[] = []
    const input: ViewedMergeInput = { local, remote, base }

    // Act
    const merged = mergeViewedFiles(input)

    // Assert
    const expected = [AUTH]
    expect(merged).toEqual(expected)
  })

  it("drops a file un-viewed on github.com since the last sync", () => {
    // Arrange — the ancestor proves GitHub HAD it viewed, so its absence now is a real
    // un-view rather than a side that simply never knew about the file.
    const local = [AUTH, API]
    const remote = [API]
    const base = [AUTH, API]
    const input: ViewedMergeInput = { local, remote, base }

    // Act
    const merged = mergeViewedFiles(input)

    // Assert
    const expected = [API]
    expect(merged).toEqual(expected)
  })

  it("keeps a file the app ticked since the last sync, which GitHub has not seen yet", () => {
    // Arrange
    const local = [AUTH, UTIL]
    const remote = [AUTH]
    const base = [AUTH]
    const input: ViewedMergeInput = { local, remote, base }

    // Act
    const merged = mergeViewedFiles(input)

    // Assert
    const expected = [AUTH, UTIL]
    expect(merged).toEqual(expected)
  })

  it("is a no-op when both sides already agree", () => {
    // Arrange
    const local = [AUTH, API]
    const remote = [API, AUTH]
    const base = [AUTH, API]
    const input: ViewedMergeInput = { local, remote, base }

    // Act
    const merged = mergeViewedFiles(input)

    // Assert
    const expected = [API, AUTH]
    expect(merged).toEqual(expected)
  })
})

describe("viewedDelta", () => {
  it("reports only what GitHub still has to be told, in both directions", () => {
    // Arrange
    const remote = [AUTH, API]
    const merged = [AUTH, UTIL]

    // Act
    const delta = viewedDelta(remote, merged)

    // Assert
    const expected = { toMark: [UTIL], toUnmark: [API] }
    expect(delta).toEqual(expected)
  })

  it("reports nothing to write when GitHub already matches the merged set", () => {
    // Arrange
    const remote = [AUTH, API]
    const merged = [API, AUTH]

    // Act
    const delta = viewedDelta(remote, merged)

    // Assert
    const expected = { toMark: [], toUnmark: [] }
    expect(delta).toEqual(expected)
  })
})
