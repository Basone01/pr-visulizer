import { describe, expect, it } from "vitest"

import type { TrayRow } from "@/entity/viewModels"

import { nextUnreviewedPath } from "./nextInQueue"

type QueueRow = Pick<TrayRow, "path" | "reviewed" | "skipReason">

describe("the next file in the review queue", () => {
  it("steps over a skipped file, also when wrapping to the start", () => {
    // Arrange
    const rows: QueueRow[] = [
      { path: "src/a.ts", reviewed: false, skipReason: null },
      { path: "src/b.ts", reviewed: false, skipReason: null },
      { path: "assets/build/app.min.css", reviewed: false, skipReason: "generated" },
      { path: "assets/build/app.css.map", reviewed: false, skipReason: "generated" },
    ]
    const openOnLastRanked = "src/b.ts"
    const openOnFirst = "src/a.ts"

    // Act
    const next = {
      afterLastRanked: nextUnreviewedPath(rows, openOnLastRanked),
      afterFirst: nextUnreviewedPath(rows, openOnFirst),
    }

    // Assert
    const expected = { afterLastRanked: "src/a.ts", afterFirst: "src/b.ts" }
    expect(next).toEqual(expected)
  })
})
