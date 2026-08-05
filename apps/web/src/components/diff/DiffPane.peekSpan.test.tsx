import type { ChangedFile, ChangedSymbol, SymbolOccurrence } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE } from "./diffPaneTestProps"

// A definition WIDER than the hunks that touch it (§10). The patch carries hunk lines only, so
// the peek used to render whatever slice of the definition happened to be inside a hunk — a Go
// function spanning 82 lines showed its last 27, starting mid-body, under a footer that claimed
// the whole thing. The head revision is the only source that holds every line, so the peek reads
// from it and overlays the patch's add/context status.

const HELPER_PATH = "src/helper.ts"
const CALLER_PATH = "src/caller.ts"

// The definition, head revision — 7 lines, all of it.
const HELPER_HEAD = [
  "export function helper(value: number) {",
  "  const doubled = value * 2",
  "  const label = `helper ${value}`",
  "  const scaled = doubled * 3",
  "  report(label, scaled)",
  "  return scaled",
  "}",
  "",
  "export const unrelated = 1",
].join("\n")

// …and the only part of it that CHANGED: head lines 4–5. Lines 1–3, 6 and 7 of the definition
// appear in no hunk at all, which is exactly what used to make them disappear from the peek.
const HELPER_PATCH = [
  "@@ -4 +4,2 @@",
  "-  report(doubled)",
  "+  const scaled = doubled * 3",
  "+  report(label, scaled)",
].join("\n")

const CALLER_PATCH = [
  "@@ -1,2 +1,2 @@",
  " const value = 1",
  "-const result = value",
  "+const result = helper(value)",
].join("\n")

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = {
    getPatch: async (_target: unknown, path: string) =>
      path === HELPER_PATH ? HELPER_PATCH : CALLER_PATCH,
    getFileAtHead: async (_target: unknown, path: string) =>
      path === HELPER_PATH ? HELPER_HEAD : null,
  }

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

const callerFile: ChangedFile = {
  path: CALLER_PATH,
  status: "modified",
  additions: 1,
  deletions: 1,
  language: "typescript",
}

const helperSymbol: ChangedSymbol = {
  id: `${HELPER_PATH}#helper`,
  path: HELPER_PATH,
  name: "helper",
  kind: "function",
  // The whole function — wider than the two lines the patch touches.
  span: { startLine: 1, endLine: 7 },
  changeKind: "modified",
}

const occurrences: SymbolOccurrence[] = [
  { symbolId: helperSymbol.id, path: HELPER_PATH, line: 1, role: "definition" },
  { symbolId: helperSymbol.id, path: CALLER_PATH, line: 2, role: "usage" },
]

function DiffPaneHarness() {
  const nav = usePeekNavigation(CALLER_PATH)

  return (
    <DiffPane
      changedPaths={new Set<string>([CALLER_PATH, HELPER_PATH])}
      target={target}
      file={callerFile}
      symbols={[helperSymbol]}
      anchorIndex={buildAnchorIndex(occurrences, [helperSymbol])}
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

// Open the peek on the `helper` usage and hand back the popover's body. The rows render one
// span per token, so there is no single text node to assert on — the body's text is read whole.
async function openPeekBody(): Promise<HTMLElement> {
  const user = userEvent.setup()
  await screen.findByText("helper")
  await user.click(screen.getByRole("button", { name: "helper" }))
  await screen.findByText(`${HELPER_PATH}:1`)

  const body = document.querySelector("[data-peek-body]")
  if (!body) throw new Error("peek body never rendered")

  return body as HTMLElement
}

function renderWithQuery() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <DiffPaneHarness />
    </QueryClientProvider>
  )
}

describe("DiffPane peek — a definition wider than its hunks", () => {
  it("renders every line of the span, including the ones no hunk touches", async () => {
    // Arrange
    renderWithQuery()
    const definitionLines = [
      "export function helper(value: number) {",
      "  const doubled = value * 2",
      "  const label = `helper ${value}`",
      "  const scaled = doubled * 3",
      "  report(label, scaled)",
      "  return scaled",
      "}",
    ]

    // Act
    const body = await openPeekBody()

    // Assert — the signature and body lines outside the hunk are the ones that used to vanish.
    const expectedMissing: string[] = []
    const missing = definitionLines.filter((line) => !body.textContent?.includes(line))
    expect(missing).toEqual(expectedMissing)
  })

  it("stops at the span — the head line after the definition stays out", async () => {
    // Arrange — reading from the head file must not spill the REST of the file into the peek.
    renderWithQuery()
    const afterTheDefinition = "export const unrelated = 1"

    // Act
    const body = await openPeekBody()

    // Assert
    expect(body.textContent).not.toContain(afterTheDefinition)
  })

  it("claims the whole definition only once every line of it is on screen", async () => {
    // Arrange
    renderWithQuery()

    // Act
    await openPeekBody()

    // Assert — the count comes from the span, so it was already right; what changed is that
    // the body now actually holds that many lines.
    const expectedFooter = "whole definition (7 lines)"
    expect(screen.getByText(expectedFooter)).toBeInTheDocument()
  })
})
