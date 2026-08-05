import type { ChangedFile, ChangedSymbol, SymbolOccurrence } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE } from "./diffPaneTestProps"

// Dismissing the peek popover (§10). The peek's open state lives in the nav machine, so both
// affordances — the × and Esc — must clear it WITHOUT navigating: peek is a detour that pushes
// nothing, and closing one must not pop the jump stack the reviewer is standing in.

// The call to `helper` is what the PR adds, so the usage anchor sits on head line 2.
const PATCH = [
  "@@ -1,2 +1,2 @@",
  " const value = 1",
  "-const result = value",
  "+const result = helper(value)",
].join("\n")

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  // No head content here on purpose: the peek's degraded source (patch only) must still open,
  // close and dismiss exactly the same — those are what these tests are about.
  const client = { getPatch: async () => PATCH, getFileAtHead: async () => null }

  return { getPrClient: () => client, getAppStorage: () => store }
})

// Symbol anchors are matched against whole shiki tokens, so the stand-in has to split identifiers
// out on their own — a tokenizer returning one token per line would leave nothing to click.
vi.mock("@/hooks/useLineTokenizer", () => ({
  useLineTokenizer: () => (lineText: string) =>
    lineText
      .split(/([A-Za-z_][A-Za-z0-9_]*)/)
      .filter((piece) => piece.length > 0)
      .map((content) => ({ content, cssVar: "var(--text)" })),
}))

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

const usageFile: ChangedFile = {
  path: "src/caller.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  language: "typescript",
}

// The definition lives in ANOTHER file, so the open file holds exactly one "helper" anchor — the
// usage — and clicking it is unambiguous.
const helperSymbol: ChangedSymbol = {
  id: "src/helper.ts#helper",
  path: "src/helper.ts",
  name: "helper",
  kind: "function",
  span: { startLine: 1, endLine: 3 },
  changeKind: "modified",
}

const occurrences: SymbolOccurrence[] = [
  { symbolId: helperSymbol.id, path: "src/helper.ts", line: 1, role: "definition" },
  { symbolId: helperSymbol.id, path: usageFile.path, line: 2, role: "usage" },
]

function DiffPaneHarness() {
  const [reviewedFiles, setReviewedFiles] = useState<string[]>([])
  const nav = usePeekNavigation(usageFile.path)
  const anchorIndex = buildAnchorIndex(occurrences, [helperSymbol])

  return (
    <DiffPane
      changedPaths={new Set<string>([usageFile.path, helperSymbol.path])}
      target={target}
      file={usageFile}
      symbols={[helperSymbol]}
      anchorIndex={anchorIndex}
      nav={nav}
      reviewed={reviewedFiles.includes(usageFile.path)}
      onToggleReviewed={(path) => setReviewedFiles((current) => [...current, path])}
      suggestedNextPath="src/next.ts"
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

function renderWithQuery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <DiffPaneHarness />
    </QueryClientProvider>
  )
}

// The peek's own header, `<definition path>:<first line>` — how these tests recognize an open
// popover. Deliberately NOT the close button: a helper that waited on the affordance under test
// would fail for the wrong reason and hide whether Esc works on its own.
const PEEK_HEADER = "src/helper.ts:1"

// Click the usage anchor to open the peek, and wait for the popover to mount.
async function openPeek(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByText("helper")
  await user.click(screen.getByRole("button", { name: "helper" }))
  await screen.findByText(PEEK_HEADER)
}

describe("DiffPane peek dismissal", () => {
  it("closes the peek when the × is clicked", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery()
    await openPeek(user)

    // Act
    await user.click(screen.getByRole("button", { name: "Close peek" }))

    // Assert — the popover is gone and the diff behind it is untouched.
    expect(screen.queryByRole("button", { name: "Close peek" })).toBeNull()
    expect(screen.queryByText(PEEK_HEADER)).toBeNull()
    expect(screen.getByText("src/caller.ts")).toBeInTheDocument()
  })

  it("closes the peek on Escape", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery()
    await openPeek(user)

    // Act
    await user.keyboard("{Escape}")

    // Assert — asserted on the header, so this case stands on its own if the × ever changes.
    expect(screen.queryByText(PEEK_HEADER)).toBeNull()
  })

  it("dismisses without navigating — no jump is pushed and none is popped", async () => {
    // Arrange — a peek pushes nothing onto the jump stack, so closing it must leave the reviewer
    // exactly where they were: same file, and no "↩ back" chip appearing or disappearing.
    const user = userEvent.setup()
    renderWithQuery()
    await openPeek(user)
    const backChip = "↩ back"
    expect(screen.queryByText(backChip)).toBeNull()

    // Act
    await user.click(screen.getByRole("button", { name: "Close peek" }))

    // Assert — still on the usage file, still no detour to unwind.
    expect(screen.getByText("src/caller.ts")).toBeInTheDocument()
    expect(screen.queryByText(backChip)).toBeNull()
  })
})
