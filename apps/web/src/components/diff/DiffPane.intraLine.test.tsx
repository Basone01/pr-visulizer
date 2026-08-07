import type { ChangedFile } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_DIFF_VIEW_SETTINGS } from "@/config/settings"

import { buildAnchorIndex } from "@/utils/diff/anchors"

import type { PrTarget } from "@/entity/pr"

import { getAppStorage } from "@/service/clientFactory"

import { usePeekNavigation } from "@/hooks/usePeekNavigation"

import styles from "./Diff.module.css"
import { DiffPane } from "./DiffPane"
import { NO_COMMIT_RANGE } from "./diffPaneTestProps"

// The intra-line (character-level) emphasis toggle (§10). One balanced pair whose lines share a
// long prefix and a short suffix — so the emphasis has to land on "item" / "row" and nowhere else.

const PATCH = [
  "@@ -1,2 +1,2 @@",
  " const kept = 1",
  "-const total = sum(items)",
  "+const total = sum(rows)",
].join("\n")

// A change WIDER than one token: the added run `, "threads"` starts on the comma closing one
// token and ends inside another, so the emphasis arrives as several spans.
const MULTI_TOKEN_PATCH = [
  "@@ -1,1 +1,1 @@",
  '-const sites = {"blog", "youtube"},',
  '+const sites = {"blog", "youtube", "threads"},',
].join("\n")

// Which patch the mocked client serves — set per test, so both shapes share one harness.
const served = vi.hoisted(() => ({ patch: "" }))

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()
  const client = { getPatch: async () => served.patch }

  return { getPrClient: () => client, getAppStorage: () => store }
})

// A stand-in for shiki: one colored token per word. The real grammar isn't the subject here — what
// matters is that a line arrives as SEVERAL colored tokens, so the emphasis has to be painted
// inside them rather than around the line.
vi.mock("@/hooks/useLineTokenizer", () => ({
  useLineTokenizer: () => (lineText: string) =>
    lineText
      .split(/(\s+)/)
      .filter((piece) => piece.length > 0)
      .map((content) => ({ content, cssVar: "var(--syn-keyword)" })),
}))

const target: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

const modifiedFile: ChangedFile = {
  path: "src/x.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  language: "typescript",
}

function DiffPaneHarness() {
  const [reviewedFiles, setReviewedFiles] = useState<string[]>([])
  const nav = usePeekNavigation("")
  const anchorIndex = buildAnchorIndex([], [])

  return (
    <DiffPane
      changedPaths={new Set<string>()}
      target={target}
      file={modifiedFile}
      symbols={[]}
      anchorIndex={anchorIndex}
      nav={nav}
      reviewed={reviewedFiles.includes(modifiedFile.path)}
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

// A CSS-module class is `string | undefined` to the compiler, and a missing one would make every
// query silently match nothing — the shape of a test that passes for the wrong reason.
function charSelector(charClass: string | undefined): string {
  if (!charClass) throw new Error("Diff.module.css is missing an intra-line emphasis class")

  return `.${charClass}`
}

function emphasizedText(container: HTMLElement, charClass: string | undefined): string[] {
  return [...container.querySelectorAll(charSelector(charClass))].map(
    (node) => node.textContent ?? ""
  )
}

describe("DiffPane intra-line diff toggle", () => {
  // The mocked storage lives for the whole module, and the toggle persists — so each test
  // re-arms the defaults rather than inheriting the previous one's setting.
  beforeEach(async () => {
    await getAppStorage().set("diffViewSettings", JSON.stringify(DEFAULT_DIFF_VIEW_SETTINGS))
    served.patch = PATCH
  })

  it("emphasizes nothing until the toggle is on", async () => {
    // Arrange
    const { container } = renderWithQuery()
    await waitFor(() => expect(container.textContent).toContain("sum(items)"))
    const expectedEmphasis: string[] = []

    // Act — nothing; the default is off.

    // Assert — both lines render in full, with no character-level layer over them.
    expect(emphasizedText(container, styles.charDel)).toEqual(expectedEmphasis)
    expect(emphasizedText(container, styles.charAdd)).toEqual(expectedEmphasis)
    expect(container.textContent).toContain("sum(rows)")
  })

  it("emphasizes only the differing characters on each side of the pair", async () => {
    // Arrange
    const user = userEvent.setup()
    const { container } = renderWithQuery()
    await waitFor(() => expect(container.textContent).toContain("sum(items)"))
    const expectedRemoved = ["item"]
    const expectedAdded = ["row"]

    // Act
    await user.click(screen.getByRole("button", { name: "Highlight changed characters" }))

    // Assert — the shared prefix, the shared "s)" suffix and the untouched context line are all
    // left alone; the lines themselves still read in full.
    expect(emphasizedText(container, styles.charDel)).toEqual(expectedRemoved)
    expect(emphasizedText(container, styles.charAdd)).toEqual(expectedAdded)
    expect(container.textContent).toContain("const total = sum(items)")
    expect(container.textContent).toContain("const total = sum(rows)")
  })

  it("keeps the syntax color on the token it split", async () => {
    // Arrange
    const user = userEvent.setup()
    const { container } = renderWithQuery()
    await waitFor(() => expect(container.textContent).toContain("sum(items)"))
    const expectedColor = "var(--syn-keyword)"

    // Act
    await user.click(screen.getByRole("button", { name: "Highlight changed characters" }))

    // Assert — the emphasis span sits INSIDE the colored token, so syntax color still applies.
    const emphasis = container.querySelector(charSelector(styles.charAdd))
    const token = emphasis?.closest("span[style]")
    expect(token?.getAttribute("style")).toContain(expectedColor)
  })

  it("emphasizes each column's own side in the side-by-side view", async () => {
    // Arrange
    const user = userEvent.setup()
    const { container } = renderWithQuery()
    await waitFor(() => expect(container.textContent).toContain("sum(items)"))
    const baseColumn = 0
    const headColumn = 1

    // Act — both toggles on: the emphasis has to follow each line into its own column.
    await user.click(screen.getByRole("button", { name: "Side-by-side view" }))
    await user.click(screen.getByRole("button", { name: "Highlight changed characters" }))

    // Assert
    const removed = container.querySelector(charSelector(styles.charDel))?.closest("td")
    const added = container.querySelector(charSelector(styles.charAdd))?.closest("td")
    const removedRow = removed?.closest("tr") as HTMLTableRowElement
    expect([...removedRow.cells].indexOf(removed as HTMLTableCellElement)).toBe(baseColumn)
    expect([...removedRow.cells].indexOf(added as HTMLTableCellElement)).toBe(headColumn)
    expect(removed?.textContent).toContain("item")
    expect(added?.textContent).toContain("row")
  })
})

// A run that crosses token boundaries has to READ as one highlight. It is still several spans —
// the emphasis lives inside each token so syntax colour and anchor clicks survive — so what is
// pinned here is that the pieces are marked as joined: only the outer ends carry an end, and the
// text they cover, spliced back together, is exactly the changed run.

describe("DiffPane intra-line diff — a run wider than one token", () => {
  beforeEach(async () => {
    await getAppStorage().set("diffViewSettings", JSON.stringify(DEFAULT_DIFF_VIEW_SETTINGS))
    served.patch = MULTI_TOKEN_PATCH
  })

  it("joins the pieces of one run into a single continuous box", async () => {
    // Arrange
    const user = userEvent.setup()
    const { container } = renderWithQuery()
    await waitFor(() => expect(container.textContent).toContain('"threads"'))

    // Act
    await user.click(screen.getByRole("button", { name: "Highlight changed characters" }))

    // Assert — one run: it opens once, closes once, and every piece between is a middle.
    const pieces = [...container.querySelectorAll(charSelector(styles.charAdd))]
    const expectedRun = ["start", "mid", "end"]
    expect(pieces.map((piece) => piece.getAttribute("data-run"))).toEqual(expectedRun)
    expect(pieces.map((piece) => piece.textContent).join("")).toBe(', "threads"')
  })

  it("still emphasizes nothing outside the changed run", async () => {
    // Arrange — the shared prefix and the `},` suffix are identical on both sides.
    const user = userEvent.setup()
    const { container } = renderWithQuery()
    await waitFor(() => expect(container.textContent).toContain('"threads"'))

    // Act
    await user.click(screen.getByRole("button", { name: "Highlight changed characters" }))

    // Assert
    const emphasized = emphasizedText(container, styles.charAdd).join("")
    expect(emphasized).not.toContain("blog")
    expect(container.textContent).toContain('const sites = {"blog", "youtube", "threads"},')
  })
})
