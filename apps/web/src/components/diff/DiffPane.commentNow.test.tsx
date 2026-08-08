import type { ChangedFile, ReviewComment } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE } from "./diffPaneTestProps"

// Regression: "Comment now" publishes a REAL comment straight to GitHub, outside any pending
// review. Measured against real GitHub, the POST returned 201 and the app issued no follow-up
// read — so the comment the reviewer had just published stayed invisible until a manual refresh.
// The published comment list must be re-read on success, and left alone on failure.

const PATCH = ["@@ -0,0 +1,3 @@", "+first", "+second", "+third"].join("\n")

const target: PrTarget = { owner: "acme", repo: "web", number: 42 }

const file: ChangedFile = {
  path: "src/lib/rateLimiter.ts",
  status: "added",
  additions: 3,
  deletions: 0,
  language: "typescript",
}

const addCommentNow = vi.fn<() => Promise<void>>()
const listReviewComments = vi.fn<() => Promise<ReviewComment[]>>()

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()

  return {
    getPrClient: () => ({
      getPatch: async () => PATCH,
      getFileAtHead: async () => null,
      listReviewComments,
      addCommentNow,
      getViewer: async () => ({
        userId: "u",
        login: "reviewer-dev",
        name: null,
        avatarUrl: null,
      }),
    }),
    getAppStorage: () => store,
  }
})

vi.mock("@/hooks/useLineTokenizer", () => ({
  useLineTokenizer: () => null,
}))

function DiffPaneHarness() {
  const nav = usePeekNavigation("")

  return (
    <DiffPane
      changedPaths={new Set<string>()}
      target={target}
      file={file}
      symbols={[]}
      anchorIndex={buildAnchorIndex([], [])}
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
      commitRange={NO_COMMIT_RANGE}
    />
  )
}

function renderDiffPane() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  return render(<DiffPaneHarness />, { wrapper })
}

// Open the composer on a head line and type a body, ready for either publish button.
async function composeOn(line: number, body: string) {
  const user = userEvent.setup()
  renderDiffPane()

  await user.click(await screen.findByRole("button", { name: `Comment on line ${line}` }))
  await user.type(screen.getByLabelText("Comment body"), body)

  return user
}

describe("DiffPane — Comment now", () => {
  beforeEach(() => {
    addCommentNow.mockReset()
    listReviewComments.mockReset()
    listReviewComments.mockResolvedValue([])
  })

  it("re-reads the published comments after publishing one immediately", async () => {
    // Arrange
    const commentedLine = 2
    const body = "publish me immediately"
    addCommentNow.mockResolvedValue(undefined)
    const user = await composeOn(commentedLine, body)
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledTimes(1))

    // Act
    await user.click(screen.getByRole("button", { name: "Comment now" }))

    // Assert — the comment is on GitHub now, so the thread list must be read again.
    const expectedFetches = 2
    await waitFor(() => expect(addCommentNow).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledTimes(expectedFetches))
  })

  it("leaves the comment list alone when the publish fails", async () => {
    // Arrange — nothing was published, so there is nothing new to read.
    const commentedLine = 2
    const rejection = new Error("GitHub rejected the comment")
    addCommentNow.mockRejectedValue(rejection)
    const user = await composeOn(commentedLine, "this will fail")
    await waitFor(() => expect(listReviewComments).toHaveBeenCalledTimes(1))

    // Act
    await user.click(screen.getByRole("button", { name: "Comment now" }))

    // Assert — the composer keeps the text with the failure, and no refetch happened.
    const expectedFetches = 1
    expect(await screen.findByRole("alert")).toHaveTextContent(rejection.message)
    expect(listReviewComments).toHaveBeenCalledTimes(expectedFetches)
  })
})
