import type { SymbolOccurrence } from "@pr-visulizer/shared"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { GhostFilePane } from "./GhostFilePane"

const GHOST_HEAD = [
  "import { changed } from './file0'",
  "",
  "export function uses(): number {",
  "  return changed()",
  "}",
].join("\n")

vi.mock("@/service/clientFactory", () => ({
  getPrClient: () => ({
    // The "gone" path exercises the unavailable state; everything else has head text.
    getFileAtHead: async (_target: PrTarget, path: string) =>
      path === "src/gone.ts" ? null : GHOST_HEAD,
  }),
}))

vi.mock("@/hooks/useLineTokenizer", () => ({
  useLineTokenizer: () => null,
}))

const target: PrTarget = { owner: "acme", repo: "webapp", number: 999 }

const ghostPath = "src/ghostConsumer.ts"
const headSha = "head999"

// Lines 1 and 4 reference changed symbols — the pane must highlight exactly those.
const refs: SymbolOccurrence[] = [
  { symbolId: "src/file0.ts#Symbol0", path: ghostPath, line: 1, role: "usage" },
  { symbolId: "src/file0.ts#Symbol0", path: ghostPath, line: 4, role: "usage" },
]

function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe("GhostFilePane", () => {
  it("renders the whole head file with exactly the referencing lines highlighted", async () => {
    // Arrange
    const onOpenFile = vi.fn()

    // Act
    const { container } = renderWithQuery(
      <GhostFilePane
        target={target}
        path={ghostPath}
        headSha={headSha}
        refs={refs}
        suggestedNextPath="src/next.ts"
        onOpenFile={onOpenFile}
        onHide={() => {}}
      />
    )
    await screen.findByText(/return changed/)

    // Assert — all 5 head lines render; rows 1 and 4 (and only those) carry the ref marker,
    // and a ghost is not reviewable so there is no Mark viewed control.
    const expectedRefRows = 2
    expect(container.querySelectorAll("[data-ghost-ref]")).toHaveLength(expectedRefRows)
    expect(screen.getByText(/2 refs to changed code/)).toBeInTheDocument()
    expect(screen.getByText("unchanged")).toBeInTheDocument()
    expect(screen.queryByLabelText("Mark viewed")).toBeNull()
  })

  it("opens the next suggested file from the toolbar", async () => {
    // Arrange
    const onOpenFile = vi.fn()
    const nextPath = "src/next.ts"
    renderWithQuery(
      <GhostFilePane
        target={target}
        path={ghostPath}
        headSha={headSha}
        refs={refs}
        suggestedNextPath={nextPath}
        onOpenFile={onOpenFile}
        onHide={() => {}}
      />
    )
    await screen.findByText(/return changed/)

    // Act
    await userEvent.click(screen.getByLabelText("Open next suggested file"))

    // Assert
    const expected = [nextPath]
    expect(onOpenFile).toHaveBeenCalledWith(...expected)
  })

  it("shows the unavailable state when the client has no head content", async () => {
    // Arrange
    const unavailablePath = "src/gone.ts"

    // Act
    renderWithQuery(
      <GhostFilePane
        target={target}
        path={unavailablePath}
        headSha={headSha}
        refs={[]}
        suggestedNextPath={null}
        onOpenFile={() => {}}
        onHide={() => {}}
      />
    )

    // Assert
    expect(await screen.findByText(/content isn't available/)).toBeInTheDocument()
  })
})
