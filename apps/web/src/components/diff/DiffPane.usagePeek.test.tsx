import type { ChangedFile, ChangedSymbol, SymbolOccurrence } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE } from "./diffPaneTestProps"

// Peeking a usage site from a definition's "N usages" list (§10): the usage's code opens inline
// under the list item, and nothing navigates until the reviewer asks to jump.

const DEFINITION_PATH = "src/helper.ts"
const CALLER_PATH = "src/caller.ts"
const USAGE_LINE_TEXT = "const result = helper(value)"

// The open file: the PR adds `helper`, so its definition sits on head line 1.
const DEFINITION_PATCH = [
  "@@ -0,0 +1,3 @@",
  "+function helper(value) {",
  "+  return value",
  "+}",
].join("\n")

// The caller's head content, with the usage on line 5.
const CALLER_HEAD = [
  "import { helper } from './helper'",
  "",
  "const value = 1",
  "",
  USAGE_LINE_TEXT,
  "export { result }",
].join("\n")

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = {
    getPatch: async (_target: unknown, path: string) =>
      path === DEFINITION_PATH ? DEFINITION_PATCH : null,
    getFileAtHead: async (_target: unknown, path: string) =>
      path === CALLER_PATH ? CALLER_HEAD : null,
  }

  return { getPrClient: () => client, getAppStorage: () => store }
})

// Symbol anchors are matched against whole shiki tokens, so the stand-in splits identifiers out.
vi.mock("@/hooks/useLineTokenizer", () => ({
  useLineTokenizer: () => (lineText: string) =>
    lineText
      .split(/([A-Za-z_][A-Za-z0-9_]*)/)
      .filter((piece) => piece.length > 0)
      .map((content) => ({ content, cssVar: "var(--text)" })),
}))

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

const definitionFile: ChangedFile = {
  path: DEFINITION_PATH,
  status: "added",
  additions: 3,
  deletions: 0,
  language: "typescript",
}

const helperSymbol: ChangedSymbol = {
  id: `${DEFINITION_PATH}#helper`,
  path: DEFINITION_PATH,
  name: "helper",
  kind: "function",
  span: { startLine: 1, endLine: 3 },
  changeKind: "added",
}

const occurrences: SymbolOccurrence[] = [
  { symbolId: helperSymbol.id, path: DEFINITION_PATH, line: 1, role: "definition" },
  { symbolId: helperSymbol.id, path: CALLER_PATH, line: 5, role: "usage" },
]

function DiffPaneHarness() {
  const nav = usePeekNavigation(DEFINITION_PATH)
  const anchorIndex = buildAnchorIndex(occurrences, [helperSymbol])

  return (
    <>
      <p>current path: {nav.state.current.path}</p>
      <DiffPane
        changedPaths={new Set<string>([DEFINITION_PATH, CALLER_PATH])}
        target={target}
        file={definitionFile}
        symbols={[helperSymbol]}
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
    </>
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

describe("DiffPane usage peek", () => {
  it("shows_the_usage_code_inline_when_a_listed_usage_is_clicked", async () => {
    // Arrange
    const user = userEvent.setup()
    renderWithQuery()
    await user.click(await screen.findByRole("button", { name: "1 usages in this PR" }))
    const usageItem = screen.getByRole("button", { name: `${CALLER_PATH}:5` })

    // Act
    await user.click(usageItem)

    // Assert
    const usageRow = await within(usageItem.parentElement!).findByText(
      (_content, element) => element?.hasAttribute("data-focus-line") ?? false
    )
    expect(usageRow).toHaveTextContent(USAGE_LINE_TEXT)
    expect(screen.getByText(`current path: ${DEFINITION_PATH}`)).toBeInTheDocument()
  })
})
