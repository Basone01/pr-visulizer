import type { ChangedFile, DraftComment, ReviewComment } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

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
    listReviewComments: async () => [THREAD_ROOT, THREAD_REPLY],
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

describe("DiffPane existing comments", () => {
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
})
