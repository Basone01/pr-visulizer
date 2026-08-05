import type { ChangedFile, DraftComment, ReviewComment } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE } from "./diffPaneTestProps"

// The existing-comments UI in the diff pane: a bubble on the commented line (distinct from the
// draft marker), expand/collapse of the thread, and — the reason this feature is the TS agent's —
// the comment body rendered through the sanitizing MarkdownContent wrapper.

// Head lines 1..3 exist; the thread is anchored to line 3.
const PATCH = ["@@ -0,0 +1,3 @@", "+first", "+second", "+third"].join("\n")

// Which comments the mocked client serves — set per test, so one file can cover both a
// single-line thread and a multi-line RANGE one without a second harness.
const served = vi.hoisted(() => ({ comments: [] as unknown[] }))

// A body carrying an injected <script> and a javascript: link — both must be neutralized.
const THREAD_ROOT: ReviewComment = {
  id: 700,
  path: "src/lib/rateLimiter.ts",
  line: 3,
  startLine: null,
  side: "RIGHT",
  inReplyToId: null,
  author: "senior-dev",
  body: "Please **guard** this.\n\n<script>window.__pwned = true</script>\n\n[click](javascript:alert(1))",
  createdAt: "2026-07-20T09:00:00Z",
}
const THREAD_REPLY: ReviewComment = {
  id: 701,
  path: "src/lib/rateLimiter.ts",
  line: 3,
  startLine: null,
  side: "RIGHT",
  inReplyToId: 700,
  author: "contributor-dev",
  body: "Will do.",
  createdAt: "2026-07-20T10:00:00Z",
}

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = {
    getPatch: async () => PATCH,
    getFileAtHead: async () => null,
    listReviewComments: async () => served.comments,
  }

  return {
    getPrClient: () => client,
    getAppStorage: () => store,
  }
})

vi.mock("@/hooks/useLineTokenizer", () => ({
  useLineTokenizer: () => null,
}))

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

const file: ChangedFile = {
  path: "src/lib/rateLimiter.ts",
  status: "added",
  additions: 3,
  deletions: 0,
  language: "typescript",
}

// A local DRAFT on the same line, so the test can prove the existing-comment bubble is a
// different element from the draft marker.
const draftOnLine3: DraftComment = {
  path: "src/lib/rateLimiter.ts",
  line: 3,
  side: "RIGHT",
  body: "my local draft",
}

function DiffPaneHarness({ drafts = [] as DraftComment[] }) {
  const nav = usePeekNavigation("")
  const anchorIndex = buildAnchorIndex([], [])

  return (
    <DiffPane
      changedPaths={new Set<string>()}
      target={target}
      file={file}
      symbols={[]}
      anchorIndex={anchorIndex}
      nav={nav}
      reviewed={false}
      onToggleReviewed={() => {}}
      suggestedNextPath={null}
      onOpenFile={() => {}}
      onHide={() => {}}
      drafts={drafts}
      onAddDraft={() => {}}
      onUpdateDraft={() => {}}
      onDeleteDraft={() => {}}
      commitRange={NO_COMMIT_RANGE}
    />
  )
}

function renderWithQuery(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

const BUBBLE_LABEL = /existing comment/i

// A comment on the WHOLE file body — GitHub reports the range as start_line 1 through line 3,
// where `line` is its LAST line.
const RANGE_ROOT: ReviewComment = {
  id: 800,
  path: "src/lib/rateLimiter.ts",
  line: 3,
  startLine: 1,
  side: "RIGHT",
  inReplyToId: null,
  author: "senior-dev",
  body: "This whole block needs a guard.",
  createdAt: "2026-07-20T09:00:00Z",
}

describe("DiffPane existing comments", () => {
  beforeEach(() => {
    served.comments = [THREAD_ROOT, THREAD_REPLY]
  })

  it("shows a comment bubble on the commented line", async () => {
    // Arrange / Act
    renderWithQuery(<DiffPaneHarness />)

    // Assert — the bubble appears, its label names the head line (3) and the comment count (2).
    const bubble = await screen.findByRole("button", { name: BUBBLE_LABEL })
    expect(bubble).toHaveAttribute("aria-label", expect.stringContaining("line 3"))
    expect(bubble).toHaveTextContent("2")
  })

  it("expands the thread on click and collapses it on a second click", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness />)
    const bubble = await screen.findByRole("button", { name: BUBBLE_LABEL })

    // Act — open
    await user.click(bubble)

    // Assert — both authors' comments are shown, root then reply.
    expect(await screen.findByText("senior-dev")).toBeInTheDocument()
    expect(screen.getByText("contributor-dev")).toBeInTheDocument()

    // Act — close
    await user.click(bubble)

    // Assert
    expect(screen.queryByText("contributor-dev")).toBeNull()
  })

  it("renders the comment body through the sanitizer — no raw script, no javascript: link", async () => {
    // Arrange
    const user = userEvent.setup()
    const { container } = renderWithQuery(<DiffPaneHarness />)
    const bubble = await screen.findByRole("button", { name: BUBBLE_LABEL })

    // Act
    await user.click(bubble)
    await screen.findByText("senior-dev")

    // Assert — the emphasis renders, but the injected script and the javascript: anchor do not.
    expect(container.querySelector("strong")).not.toBeNull()
    expect(container.querySelector("script")).toBeNull()
    expect(container.textContent).not.toContain("window.__pwned")
    expect(container.querySelector("a[href^='javascript:']")).toBeNull()
  })

  it("keeps the existing-comment bubble distinct from the local draft marker", async () => {
    // Arrange — a draft AND an existing thread on the same line.
    renderWithQuery(<DiffPaneHarness drafts={[draftOnLine3]} />)

    // Act
    const bubble = await screen.findByRole("button", { name: BUBBLE_LABEL })
    const draftPill = await screen.findByText("💬 draft")

    // Assert — two separate elements: the draft pill is not the existing-comment bubble.
    expect(bubble).toBeInTheDocument()
    expect(draftPill).toBeInTheDocument()
    expect(bubble).not.toBe(draftPill)
    expect(within(bubble).queryByText(/draft/i)).toBeNull()
  })

  it("puts the bubble on the START line of a multi-line comment", async () => {
    // Arrange — the range covers head lines 1..3; GitHub's `line` is the LAST of them, so before
    // this the marker sat on line 3, under the end of the block someone commented on.
    served.comments = [RANGE_ROOT]

    // Act
    renderWithQuery(<DiffPaneHarness />)
    const bubble = await screen.findByRole("button", { name: BUBBLE_LABEL })

    // Assert
    const expectedLabel = "1 existing comment(s) on line 1"
    expect(bubble).toHaveAttribute("aria-label", expectedLabel)
  })

  it("opens the thread panel under the START-line row it is anchored to", async () => {
    // Arrange — the panel is keyed by the same head line as the bubble, so a range comment must
    // not open its thread under a different row than the one carrying its marker.
    const user = userEvent.setup()
    served.comments = [RANGE_ROOT]
    renderWithQuery(<DiffPaneHarness />)
    const bubble = await screen.findByRole("button", { name: BUBBLE_LABEL })

    // Act
    await user.click(bubble)

    // Assert — the thread opens, and the row carrying the marker is the one whose gutter is line
    // 1 (the panel is keyed by that same head line, so both live on the start-line row).
    const markerRow = bubble.closest("div")!
    expect(await screen.findByText("senior-dev")).toBeInTheDocument()
    expect(within(markerRow).getByRole("button", { name: "Comment on line 1" })).toBeInTheDocument()
    expect(markerRow).toHaveTextContent("first")
  })
})
