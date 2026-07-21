import type { ChangedFile } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE } from "./diffPaneTestProps"

// A patch that touches only the middle of the file, so the head file has unchanged lines the
// hunks-only view cannot show — `const tail = 4` is the proof the full-file view rendered.
const PATCH = ["@@ -2,2 +2,2 @@", " const head = 1", "-const body = 0", "+const body = 2"].join(
  "\n"
)

const HEAD_FILE = ["const top = 0", "const head = 1", "const body = 2", "const tail = 4"].join("\n")

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = {
    getPatch: async () => PATCH,
    // A deleted file has no head revision — the client answers null, same as the real ones.
    getFileAtHead: async (_target: PrTarget, path: string) =>
      path === "src/gone.ts" ? null : HEAD_FILE,
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

const modifiedFile: ChangedFile = {
  path: "src/x.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  language: null,
}

const deletedFile: ChangedFile = {
  path: "src/gone.ts",
  status: "deleted",
  additions: 0,
  deletions: 12,
  language: null,
}

function DiffPaneHarness({ file }: { file: ChangedFile }) {
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
      commitRange={NO_COMMIT_RANGE}
    />
  )
}

function renderWithQuery(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

describe("DiffPane full-file toggle", () => {
  it("renders the head lines outside the hunk once the toggle is on", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery(<DiffPaneHarness file={modifiedFile} />)
    await screen.findByText("const body = 2")
    // The hunk never mentions this line — it can only come from the head file.
    expect(screen.queryByText("const tail = 4")).toBeNull()

    // Act
    await user.click(screen.getByRole("button", { name: "View full file" }))

    // Assert
    expect(await screen.findByText("const tail = 4")).toBeInTheDocument()
    expect(screen.getByText("const top = 0")).toBeInTheDocument()
  })

  it("disables the toggle on a deleted file, whose patch is already the whole file", async () => {
    // Arrange
    const expectedTitle = "A deleted file's patch is already the whole file"

    // Act
    renderWithQuery(<DiffPaneHarness file={deletedFile} />)
    const toggle = await screen.findByRole("button", { name: "View full file" })

    // Assert
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute("title", expectedTitle)
  })
})
