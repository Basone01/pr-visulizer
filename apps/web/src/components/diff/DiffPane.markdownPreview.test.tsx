import type { ChangedFile, RangeDiff } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_DIFF_VIEW_SETTINGS } from "@/config/settings"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { getAppStorage } from "@/service/clientFactory"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE, activeCommitRange } from "./diffPaneTestProps"

// The markdown preview (§10): a markdown-only toolbar toggle that REPLACES the diff with the
// rendered head revision. What is pinned here is when the toggle exists, when it is usable, and
// that turning it on swaps the diff area — the rendering itself is MarkdownContent's own test.

// The patch and the head text describe the SAME file: the rendered diff reconstructs the base
// from both, so a head line the patch disagrees about would produce a base nobody ever had.
const PATCH = ["@@ -1,3 +1,3 @@", " # webapp", " ", "-old tagline", "+new tagline"].join("\n")

const HEAD_MARKDOWN = [
  "# webapp",
  "",
  "new tagline",
  "",
  "A small API server.",
  "",
  "## Rate limiting",
].join("\n")

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = {
    getPatch: async () => PATCH,
    // A deleted file has no head revision — the client answers null, same as the real ones.
    getFileAtHead: async (_target: PrTarget, path: string) =>
      path === "docs/gone.md" ? null : HEAD_MARKDOWN,
  }

  return {
    getPrClient: () => client,
    getAppStorage: () => store,
  }
})

vi.mock("@/hooks/useLineTokenizer", () => ({
  useLineTokenizer: () => null,
}))

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

const markdownFile: ChangedFile = {
  path: "README.md",
  status: "modified",
  additions: 1,
  deletions: 1,
  // null is the real value for markdown — the engine ships no grammar for it, which is why the
  // toggle keys off the path and not off this field.
  language: null,
}

const deletedMarkdownFile: ChangedFile = {
  path: "docs/gone.md",
  status: "deleted",
  additions: 0,
  deletions: 20,
  language: null,
}

// An ADDED markdown file: previewable, but there is no base revision to compare it against.
const addedMarkdownFile: ChangedFile = {
  path: "docs/new-guide.md",
  status: "added",
  additions: 7,
  deletions: 0,
  language: null,
}

const codeFile: ChangedFile = {
  path: "src/lib/rateLimiter.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  language: "typescript",
}

const rangeDiff: RangeDiff = {
  baseSha: "aaaaaaa",
  headSha: "bbbbbbb",
  files: [
    {
      path: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: PATCH,
      previousPath: null,
    },
  ],
  truncated: false,
}

// Only the DIFF renders a hunk header — the reliable "the diff is on screen" marker now that the
// patch and the head text share their text.
const HUNK_HEADER = "@@ -1,3 +1,3 @@"

const PREVIEW_BUTTON = "Preview rendered markdown"

function DiffPaneHarness({
  file,
  commitRange = NO_COMMIT_RANGE,
}: {
  file: ChangedFile
  commitRange?: typeof NO_COMMIT_RANGE
}) {
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
      drafts={[]}
      onAddDraft={() => {}}
      onUpdateDraft={() => {}}
      onDeleteDraft={() => {}}
      commitRange={commitRange}
    />
  )
}

function renderWithQuery(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

// The toggle PERSISTS through the app storage, and the mocked store is shared by every test in
// this file — so each one starts by putting the defaults back. Without this, a test that leaves
// the preview on decides what the next test renders.
beforeEach(async () => {
  await getAppStorage().set("diffViewSettings", JSON.stringify(DEFAULT_DIFF_VIEW_SETTINGS))
})

describe("DiffPane markdown preview", () => {
  it("offers the toggle on a markdown file", async () => {
    // Arrange
    const expectedTitle = "Preview the rendered markdown instead of the diff"

    // Act
    renderWithQuery(<DiffPaneHarness file={markdownFile} />)
    const toggle = await screen.findByRole("button", { name: PREVIEW_BUTTON })

    // Assert
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAttribute("title", expectedTitle)
  })

  it("hides the toggle on a file it cannot render", async () => {
    // Arrange — a .ts file has no rendered form, and a DELETED markdown file has no head
    // revision to render, so neither shows the control at all.

    // Act
    renderWithQuery(<DiffPaneHarness file={codeFile} />)
    await screen.findByText("new tagline")

    // Assert
    expect(screen.queryByRole("button", { name: PREVIEW_BUTTON })).toBeNull()
  })

  it("hides the toggle on a deleted markdown file", async () => {
    // Arrange

    // Act
    renderWithQuery(<DiffPaneHarness file={deletedMarkdownFile} />)
    await screen.findByRole("button", { name: "View full file" })

    // Assert
    expect(screen.queryByRole("button", { name: PREVIEW_BUTTON })).toBeNull()
  })

  it("swaps the diff for the rendered head revision when switched on", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness file={markdownFile} />)
    // The diff is what the pane shows first — the preview is opt-in.
    await screen.findByText("new tagline")

    // Act
    await user.click(screen.getByRole("button", { name: PREVIEW_BUTTON }))

    // Assert — a real heading from the head revision, and the diff is gone. "Gone" is checked on
    // the HUNK HEADER, which only the diff can render: the tagline used to stand in for it, but
    // now that the head text and the patch agree, that text is legitimately in the preview too.
    expect(await screen.findByRole("heading", { level: 2, name: "Rate limiting" })).toBeVisible()
    expect(screen.queryByText(HUNK_HEADER)).toBeNull()
  })

  it("returns to the diff when switched back off", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness file={markdownFile} />)
    await screen.findByText("new tagline")
    await user.click(screen.getByRole("button", { name: PREVIEW_BUTTON }))
    await screen.findByRole("heading", { level: 2, name: "Rate limiting" })

    // Act
    await user.click(screen.getByRole("button", { name: PREVIEW_BUTTON }))

    // Assert
    expect(await screen.findByText("new tagline")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { level: 2, name: "Rate limiting" })).toBeNull()
  })

  it("disables the toggle while a commit range is selected", async () => {
    // Arrange — same call the full-file toggle makes: the head revision is not the revision the
    // selected commits describe, so previewing it would answer a question nobody asked.
    const commitRange = activeCommitRange({ rangeDiff })
    const expectedTitle = "Preview is unavailable while a commit range is selected"

    // Act
    renderWithQuery(<DiffPaneHarness file={markdownFile} commitRange={commitRange} />)
    const toggle = await screen.findByRole("button", { name: PREVIEW_BUTTON })

    // Assert
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute("title", expectedTitle)
  })
})

// The rendered CHANGES inside the preview (experimental). The base revision is rebuilt from the
// head text plus the patch, so a block that only the BASE had must still render — that is what
// separates this from the plain head-revision preview.

const RICH_DIFF_BUTTON = "Show rendered changes"

async function openPreview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByText("new tagline")
  await user.click(screen.getByRole("button", { name: PREVIEW_BUTTON }))
  await screen.findByRole("heading", { level: 2, name: "Rate limiting" })
}

describe("DiffPane markdown rendered diff", () => {
  it("offers the sub-toggle only once the preview is on", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness file={markdownFile} />)
    await screen.findByText("new tagline")

    // Act
    const beforePreview = screen.queryByRole("button", { name: RICH_DIFF_BUTTON })
    await user.click(screen.getByRole("button", { name: PREVIEW_BUTTON }))

    // Assert
    expect(beforePreview).toBeNull()
    expect(await screen.findByRole("button", { name: RICH_DIFF_BUTTON })).toBeEnabled()
  })

  it("hides the sub-toggle on an added file, which has no base revision to compare", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness file={addedMarkdownFile} />)

    // Act — the plain preview still works; only the comparison is meaningless here.
    await user.click(await screen.findByRole("button", { name: PREVIEW_BUTTON }))
    await screen.findByRole("heading", { level: 2, name: "Rate limiting" })

    // Assert
    expect(screen.queryByRole("button", { name: RICH_DIFF_BUTTON })).toBeNull()
  })

  it("renders the removed block beside the added one, both as markdown", async () => {
    // Arrange — the patch replaced "old tagline" with "new tagline"; only the head revision
    // holds the new text, and only the reconstructed base holds the old.
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness file={markdownFile} />)
    await openPreview(user)

    // Act
    await user.click(screen.getByRole("button", { name: RICH_DIFF_BUTTON }))

    // Assert — the base-only paragraph is back on screen, banded as removed, and the heading
    // still renders as markdown rather than as diff text.
    const removed = await screen.findByText("old tagline")
    expect(removed.closest("[data-block-status]")).toHaveAttribute("data-block-status", "removed")
    expect(screen.getByRole("heading", { level: 2, name: "Rate limiting" })).toBeVisible()
  })

  it("bands a block only the head has as added", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness file={markdownFile} />)
    await openPreview(user)

    // Act
    await user.click(screen.getByRole("button", { name: RICH_DIFF_BUTTON }))

    // Assert
    const added = await screen.findByText("new tagline")
    expect(added.closest("[data-block-status]")).toHaveAttribute("data-block-status", "added")
  })

  it("leaves an untouched block unbanded", async () => {
    // Arrange — the heading is identical in both revisions, so it carries no colour at all.
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness file={markdownFile} />)
    await openPreview(user)

    // Act
    await user.click(screen.getByRole("button", { name: RICH_DIFF_BUTTON }))

    // Assert
    const heading = await screen.findByRole("heading", { level: 1, name: "webapp" })
    expect(heading.closest("[data-block-status]")).toHaveAttribute("data-block-status", "unchanged")
  })

  it("returns to the plain head preview when switched back off", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness file={markdownFile} />)
    await openPreview(user)
    await user.click(screen.getByRole("button", { name: RICH_DIFF_BUTTON }))
    await screen.findByText("old tagline")

    // Act
    await user.click(screen.getByRole("button", { name: RICH_DIFF_BUTTON }))

    // Assert — the base-only text is gone; the head revision alone is back.
    await waitFor(() => expect(screen.queryByText("old tagline")).toBeNull())
    expect(screen.getByRole("heading", { level: 2, name: "Rate limiting" })).toBeVisible()
  })
})
