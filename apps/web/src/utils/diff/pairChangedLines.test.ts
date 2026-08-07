import { describe, expect, it } from "vitest"

import { type LinePair, pairChangedLines } from "./pairChangedLines"

// Which removed line answers which added line. Positional pairing is right only while the two
// runs describe the same lines in the same order — these cases are the ones where it isn't.

// The user's Go PR, reduced: one line changed, and an unrelated comment inserted ABOVE it.
const CHANNELS_BEFORE = 'supportChannels := []string{"blog", "youtube"}'
const CHANNELS_AFTER = 'supportChannels := []string{"blog", "youtube", "threads"}'
const NEW_COMMENT = "// Threads is the newest support channel."

describe("pairChangedLines", () => {
  it("finds the counterpart below an unrelated inserted line", () => {
    // Arrange — read positionally, the deletion would answer the COMMENT, which is nothing like
    // it, and the real pair would never be considered.
    const dels = [CHANNELS_BEFORE]
    const adds = [NEW_COMMENT, CHANNELS_AFTER]

    // Act
    const pairs = pairChangedLines(dels, adds)

    // Assert
    const expected: LinePair[] = [{ delIndex: 0, addIndex: 1 }]
    expect(pairs).toEqual(expected)
  })

  it("pairs run-for-run when the two runs are already in step", () => {
    // Arrange — the easy case positional pairing always got right; alignment must not disturb it.
    const dels = ["const a = 1", "const b = 2"]
    const adds = ["const a = 11", "const b = 22"]

    // Act
    const pairs = pairChangedLines(dels, adds)

    // Assert
    const expected: LinePair[] = [
      { delIndex: 0, addIndex: 0 },
      { delIndex: 1, addIndex: 1 },
    ]
    expect(pairs).toEqual(expected)
  })

  it("skips in BOTH directions — a dropped removal and an inserted addition in one region", () => {
    // Arrange — `gamma()` is deleted outright, `inserted()` is new, and the two edited lines keep
    // their counterparts across both gaps.
    const dels = ["alpha(1)", "gamma()", "omega(9)"]
    const adds = ["alpha(2)", "inserted()", "omega(8)"]

    // Act
    const pairs = pairChangedLines(dels, adds)

    // Assert — order-preserving: 0↔0 and 2↔2, with the unrelated middle lines left unpaired.
    const expected: LinePair[] = [
      { delIndex: 0, addIndex: 0 },
      { delIndex: 2, addIndex: 2 },
    ]
    expect(pairs).toEqual(expected)
  })

  it("pairs nothing when no candidate is close enough to be a counterpart", () => {
    // Arrange — a wholesale rewrite: past the changed-fraction threshold these are not two
    // versions of one line, they are a deletion and an insertion that happen to be adjacent.
    const dels = ["const total = sum(items)"]
    const adds = ["logger.warn('unrelated entirely')"]

    // Act
    const pairs = pairChangedLines(dels, adds)

    // Assert
    const expected: LinePair[] = []
    expect(pairs).toEqual(expected)
  })

  it("keeps the pairing in order rather than taking the best match out of sequence", () => {
    // Arrange — del 0 is most like add 1, and del 1 is most like add 0. Honouring both would
    // cross the lines over; a diff cannot render that, so the better single pair wins.
    const dels = ["alpha(1)", "omega(1)"]
    const adds = ["omega(2)", "alpha(2)"]

    // Act
    const pairs = pairChangedLines(dels, adds)

    // Assert — one pair, and the indexes only ever move forward.
    const expectedPairCount = 1
    expect(pairs).toHaveLength(expectedPairCount)
    expect(pairs[0]!.delIndex).toBeLessThanOrEqual(pairs[0]!.addIndex + 1)
  })

  it("treats an identical pair as a perfect counterpart", () => {
    // Arrange — a line that moved within the region: nothing to emphasize, but it is still the
    // answer to its own deletion, and pairing it keeps the real edit below it aligned.
    const dels = ["untouched()", "value := 1"]
    const adds = ["untouched()", "value := 2"]

    // Act
    const pairs = pairChangedLines(dels, adds)

    // Assert
    const expected: LinePair[] = [
      { delIndex: 0, addIndex: 0 },
      { delIndex: 1, addIndex: 1 },
    ]
    expect(pairs).toEqual(expected)
  })

  it("pairs nothing when either run is empty", () => {
    // Arrange — a pure-addition or pure-deletion region has no pairs to make.
    const onlyAdds = pairChangedLines([], ["added()"])
    const onlyDels = pairChangedLines(["removed()"], [])

    // Act / Assert
    const expected: LinePair[] = []
    expect(onlyAdds).toEqual(expected)
    expect(onlyDels).toEqual(expected)
  })
})
