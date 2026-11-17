import type { ChangedFile, PrCommit, RangeDiff } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { useCommitRange } from "@/hooks/useCommitRange"
import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { CommitRangePicker } from "./CommitRangePicker"
import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE, activeCommitRange } from "./diffPaneTestProps"

// Commit-range selection in the diff pane (§10): the indicator chip and its reset, the RANGE
// patch replacing the whole-PR one, the quiet empty state for an untouched file, and the
// picker's two-click gesture wired to the real selection hook.

// The whole-PR patch — what the pane shows with NO range selected.
const WHOLE_PR_PATCH = [
  "@@ -1,3 +1,4 @@",
  " const a = 1",
  "+const wholePrOnly = 2",
  " const b = 3",
].join("\n")

// The patch for one selected commit — deliberately different text, so a test can tell which
// of the two the pane actually rendered.
const RANGE_PATCH = ["@@ -1,2 +1,3 @@", " const a = 1", "+const rangeOnly = 9"].join("\n")

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = { getPatch: async () => WHOLE_PR_PATCH }

  return { getPrClient: () => client, getAppStorage: () => store }
})

vi.mock("@/hooks/useLineTokenizer", () => ({ useLineTokenizer: () => null }))

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

const openFile: ChangedFile = {
  path: "src/lib/rateLimiter.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  language: null,
}

const BASE_SHA = "base000000000000000000000000000000000000"
const CONFIG_SHA = "c0ffee1000000000000000000000000000000001"
const LIMITER_SHA = "c0ffee2000000000000000000000000000000002"
const WIRING_SHA = "c0ffee3000000000000000000000000000000003"

const commits: PrCommit[] = [
  {
    sha: CONFIG_SHA,
    parents: [BASE_SHA],
    messageHeadline: "Add rate-limit config",
    author: "contributor-dev",
    authoredAt: "2026-06-28T09:14:00Z",
  },
  {
    sha: LIMITER_SHA,
    parents: [CONFIG_SHA],
    messageHeadline: "Add the rate limiter",
    author: "contributor-dev",
    authoredAt: "2026-06-29T15:02:00Z",
  },
  {
    sha: WIRING_SHA,
    parents: [LIMITER_SHA],
    messageHeadline: "Wire the middleware",
    author: "contributor-dev",
    authoredAt: "2026-06-30T11:47:00Z",
  },
]

// A range that DOES touch the open file.
const touchingDiff: RangeDiff = {
  baseSha: CONFIG_SHA,
  headSha: LIMITER_SHA,
  files: [
    {
      path: openFile.path,
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: RANGE_PATCH,
      previousPath: null,
    },
  ],
  truncated: false,
}

// A range that does NOT touch the open file (it only changed a different one).
const untouchingDiff: RangeDiff = {
  baseSha: BASE_SHA,
  headSha: CONFIG_SHA,
  files: [
    {
      path: "src/config/limits.ts",
      status: "added",
      additions: 4,
      deletions: 0,
      patch: "@@ -0,0 +1,1 @@\n+export const LIMIT = 5",
      previousPath: null,
    },
  ],
  truncated: false,
}

function renderWithQuery(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

function DiffPaneHarness({ commitRange = NO_COMMIT_RANGE }) {
  const nav = usePeekNavigation("")
  const anchorIndex = buildAnchorIndex([], [])

  return (
    <DiffPane
      changedPaths={new Set<string>()}
      target={target}
      file={openFile}
      symbols={[]}
      anchorIndex={anchorIndex}
      nav={nav}
      reviewed={false}
      onToggleReviewed={() => {}}
      suggestedNextPath={null}
      onOpenFile={() => {}}
      onHide={() => {}}
      drafts={[]}
      onAddDraft={() => {}}
      onUpdateDraft={() => {}}
      onDeleteDraft={() => {}}
      commitRange={commitRange}
    />
  )
}

describe("DiffPane — no commit range selected", () => {
  it("renders the whole-PR patch, exactly as before the feature existed", async () => {
    // Arrange
    const noRange = NO_COMMIT_RANGE

    // Act
    renderWithQuery(<DiffPaneHarness commitRange={noRange} />)

    // Assert — the whole-PR line is there and no range chip is shown.
    const wholePrLine = await screen.findByText("const wholePrOnly = 2")
    expect(wholePrLine).toBeTruthy()
    expect(screen.queryByText(/show all changes/)).toBeNull()
  })
})

describe("DiffPane — a commit range is selected", () => {
  it("renders the RANGE patch instead of the whole-PR patch", async () => {
    // Arrange
    const commitRange = activeCommitRange({ commits, rangeDiff: touchingDiff })

    // Act
    renderWithQuery(<DiffPaneHarness commitRange={commitRange} />)

    // Assert — the range's line replaces the whole-PR one.
    const rangeLine = await screen.findByText("const rangeOnly = 9")
    expect(rangeLine).toBeTruthy()
    expect(screen.queryByText("const wholePrOnly = 2")).toBeNull()
  })

  it("shows an indicator chip naming the range's short shas and file count", async () => {
    // Arrange
    const commitRange = activeCommitRange({ commits, rangeDiff: touchingDiff })

    // Act
    renderWithQuery(<DiffPaneHarness commitRange={commitRange} />)

    // Assert
    const expectedShas = "c0ffee1…c0ffee2"
    const expectedFiles = "· 1 files"
    const chip = await screen.findByRole("status")
    expect(chip.textContent).toContain(expectedShas)
    expect(chip.textContent).toContain(expectedFiles)
  })

  it("resets to all changes when the chip's reset is clicked", async () => {
    // Arrange
    const user = userEvent.setup()
    const clear = vi.fn()
    const commitRange = activeCommitRange({ commits, rangeDiff: touchingDiff, clear })
    renderWithQuery(<DiffPaneHarness commitRange={commitRange} />)

    // Act
    const resetButton = await screen.findByTitle("Show all changes in this PR")
    await user.click(resetButton)

    // Assert
    const expectedCalls = 1
    expect(clear).toHaveBeenCalledTimes(expectedCalls)
  })

  it("shows a quiet empty state — not an error — for a file the range never touched", async () => {
    // Arrange
    const commitRange = activeCommitRange({ commits, rangeDiff: untouchingDiff })

    // Act
    renderWithQuery(<DiffPaneHarness commitRange={commitRange} />)

    // Assert — the honest message, no alert, and no stale whole-PR diff underneath it.
    const emptyState = await screen.findByText("No changes in the selected commits.")
    expect(emptyState).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText("const wholePrOnly = 2")).toBeNull()
    expect(screen.queryByText("Loading diff…")).toBeNull()
  })
})

// The picker driven by the REAL selection hook, so the two-click gesture is asserted end to end
// rather than against a stubbed selection.
function PickerHarness({ onRange }: { onRange: (sha: string | null) => void }) {
  const { selection, range, select, clear } = useCommitRange(commits, BASE_SHA)

  onRange(range ? `${range.baseSha}...${range.headSha}` : null)

  return (
    <CommitRangePicker
      commits={commits}
      loading={false}
      selection={selection}
      truncated={false}
      onSelect={select}
      onClear={clear}
      onClose={() => {}}
    />
  )
}

describe("CommitRangePicker — two-click range selection", () => {
  it("selects one commit on the first click, based at that commit's parent", async () => {
    // Arrange
    const user = userEvent.setup()
    let lastRange: string | null = null
    render(<PickerHarness onRange={(range) => (lastRange = range)} />)

    // Act — click the SECOND commit only.
    await user.click(screen.getByText("Add the rate limiter"))

    // Assert — base is commit 1's parent (the config commit), not the PR base.
    const expected = `${CONFIG_SHA}...${LIMITER_SHA}`
    expect(lastRange).toEqual(expected)
  })

  it("extends to a contiguous range on the second click", async () => {
    // Arrange
    const user = userEvent.setup()
    let lastRange: string | null = null
    render(<PickerHarness onRange={(range) => (lastRange = range)} />)

    // Act
    await user.click(screen.getByText("Add rate-limit config"))
    await user.click(screen.getByText("Wire the middleware"))

    // Assert — the first commit's parent through the last selected commit.
    const expected = `${BASE_SHA}...${WIRING_SHA}`
    expect(lastRange).toEqual(expected)
  })

  it("marks every commit inside the range as pressed, not just the two ends", async () => {
    // Arrange
    const user = userEvent.setup()
    render(<PickerHarness onRange={() => {}} />)

    // Act
    await user.click(screen.getByText("Add rate-limit config"))
    await user.click(screen.getByText("Wire the middleware"))

    // Assert — the middle commit is selected too.
    const expected = ["true", "true", "true"]
    const pressed = commits.map(
      (commit) =>
        screen.getByText(commit.messageHeadline).closest("button")?.getAttribute("aria-pressed") ??
        "missing"
    )
    expect(pressed).toEqual(expected)
  })

  it("lists the commits newest first", () => {
    // Arrange — `commits` is the API's oldest-first order.
    const headlines = commits.map((commit) => commit.messageHeadline)

    // Act
    render(<PickerHarness onRange={() => {}} />)

    // Assert — a row's text starts with its headline, so match on that rather than the whole
    // sha/author/date line.
    const listed = within(screen.getByRole("list"))
      .getAllByRole("button")
      .map(
        (row) => headlines.find((headline) => row.textContent?.startsWith(headline)) ?? "unknown"
      )
    const expected = ["Wire the middleware", "Add the rate limiter", "Add rate-limit config"]
    expect(listed).toEqual(expected)
  })

  it("bases a range picked DOWN the newest-first list at the oldest selected commit's parent", async () => {
    // Arrange — the regression the newest-first sort invites: reading the two clicks as
    // first-clicked = oldest would compare from the PR base up to the limiter, the wrong slice.
    const user = userEvent.setup()
    let lastRange: string | null = null
    render(<PickerHarness onRange={(range) => (lastRange = range)} />)

    // Act — the top row (newest), then the one below it.
    await user.click(screen.getByText("Wire the middleware"))
    await user.click(screen.getByText("Add the rate limiter"))

    // Assert — base is the OLDEST selected commit's parent, head the NEWEST selected commit.
    const expected = `${CONFIG_SHA}...${WIRING_SHA}`
    expect(lastRange).toEqual(expected)
  })

  it("clears back to the whole PR from the picker's 'all changes'", async () => {
    // Arrange
    const user = userEvent.setup()
    let lastRange: string | null = null
    render(<PickerHarness onRange={(range) => (lastRange = range)} />)
    await user.click(screen.getByText("Add the rate limiter"))

    // Act
    await user.click(screen.getByText("all changes"))

    // Assert
    const expected = null
    expect(lastRange).toEqual(expected)
  })
})
