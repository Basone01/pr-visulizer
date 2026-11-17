import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { CommitRangePicker } from "./CommitRangePicker"

function renderPicker(loading: boolean) {
  return render(
    <CommitRangePicker
      commits={[]}
      loading={loading}
      selection={null}
      truncated={false}
      onSelect={() => {}}
      onClear={() => {}}
      onClose={() => {}}
    />
  )
}

describe("the commit range picker's empty list", () => {
  it("says the commits are loading while they load, and that there are none only once loaded", () => {
    // Arrange
    const stillLoading = true
    const loaded = false

    // Act
    const { unmount } = renderPicker(stillLoading)
    const whileLoading = {
      loading: screen.queryByText("Loading commits…") !== null,
      noCommits: screen.queryByText("No commits to choose from.") !== null,
    }
    unmount()
    renderPicker(loaded)
    const onceLoaded = {
      loading: screen.queryByText("Loading commits…") !== null,
      noCommits: screen.queryByText("No commits to choose from.") !== null,
    }

    // Assert
    const expected = {
      whileLoading: { loading: true, noCommits: false },
      onceLoaded: { loading: false, noCommits: true },
    }
    expect({ whileLoading, onceLoaded }).toEqual(expected)
  })
})
