import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { UserEvent } from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PrTarget } from "@/entity/pr"

import { createFixturePrClient } from "@/service/fixture/fixturePrClient"
import type { PrClient } from "@/service/prClient"

import { AppShell } from "./AppShell"

// The comment lifecycle end to end, against the REAL fixture client — the closest thing to a
// browser run available here. A reviewer drafts a comment, submits it, and it must become a
// published thread WITHOUT a manual refresh; editing that thread must show the new body the
// same way. The fixture plays GitHub's half (publish, then rewrite), the hooks re-read the
// comment list on each success, and the local draft is dropped so nothing is shown twice.
//
// React-Flow and shiki are stubbed — the graph and syntax highlighting aren't the subject, and
// neither runs in jsdom. Everything below them (queries, mutations, the fixture client, the
// diff pane's real comment rendering) is the real thing.

vi.mock("./graph/GraphPane", () => ({
  GraphPane: () => <div data-testid="graph-pane">graph</div>,
}))
vi.mock("@/hooks/useLineTokenizer", () => ({
  useLineTokenizer: () => null,
}))

// A FRESH fixture client per test: it holds published comments and edits in memory, so one
// client shared across tests would let the first test's comment turn up in the second's thread.
const fixture = vi.hoisted(() => ({ client: null as PrClient | null }))

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const store = createMemoryKeyValueStore()

  return {
    getPrClient: () => fixture.client,
    getAppStorage: () => store,
  }
})

const PR42: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

// A fixture file with a patch and no seeded threads, so the only comment on screen is this
// test's own.
const FILE_PATH = "src/config/limits.ts"
const COMMENTED_LINE = 3
const COMMENT_BODY = "Pull this limit from config instead."

const DRAFT_PILL = "💬 draft"
const EXISTING_COMMENT = /existing comment/i

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell target={PR42} onBack={() => {}} />
    </QueryClientProvider>
  )
}

// This journey waits on a real async pipeline — the fixture client's simulated latency, then the
// diff pane's progressive row rendering. Under a full parallel suite that regularly outruns
// testing-library's 1s default, which showed up as this file passing alone and failing in the
// suite. The waits are for work that genuinely takes time, so they get a timeout to match.
const PIPELINE_TIMEOUT = { timeout: 5000 }

// …and the whole journey — analysis, two round trips, a submit, a refetch — outruns vitest's 5s
// per-test default under that same load, which is what actually failed: not a missing element,
// but the test budget expiring. Generous on purpose; a genuine miss still fails at the 5s wait
// above, well inside this.
const JOURNEY_TIMEOUT_MS = 20_000

// Open the file, draft one comment on it, and submit the review carrying it.
async function draftAndSubmitComment(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole("button", { name: FILE_PATH }, PIPELINE_TIMEOUT))
  await user.click(
    await screen.findByRole(
      "button",
      { name: `Comment on line ${COMMENTED_LINE}` },
      PIPELINE_TIMEOUT
    )
  )
  await user.type(screen.getByLabelText("Comment body"), COMMENT_BODY)
  await user.click(screen.getByRole("button", { name: "Add" }))
  await screen.findByText(DRAFT_PILL, undefined, PIPELINE_TIMEOUT)

  await user.click(screen.getByRole("button", { name: "submit without reviewing all" }))
  await user.click(screen.getByRole("button", { name: "Comment" }))
  await user.click(screen.getByRole("button", { name: "Submit review" }))
  await user.click(screen.getByRole("button", { name: "Submit comment" }))
}

describe("AppShell — the published comment lifecycle", () => {
  beforeEach(() => {
    fixture.client = createFixturePrClient()
  })

  it(
    "shows a submitted comment as a thread and drops the local draft",
    async () => {
      // Arrange
      const user = userEvent.setup()
      renderShell()

      // Act
      await draftAndSubmitComment(user)

      // Assert — the published thread is on the line straight away, and the draft that became it
      // is gone, so the reviewer sees the comment once rather than twice.
      const bubble = await screen.findByRole("button", { name: EXISTING_COMMENT }, PIPELINE_TIMEOUT)
      expect(bubble).toHaveAttribute(
        "aria-label",
        expect.stringContaining(`line ${COMMENTED_LINE}`)
      )
      await waitFor(() => expect(screen.queryByText(DRAFT_PILL)).toBeNull(), PIPELINE_TIMEOUT)

      await user.click(bubble)
      expect(await screen.findByText(COMMENT_BODY, undefined, PIPELINE_TIMEOUT)).toBeInTheDocument()
    },
    JOURNEY_TIMEOUT_MS
  )

  it(
    "edits that comment in place and renders the new body",
    async () => {
      // Arrange — the submitted comment is the viewer's own, so it carries the Edit affordance.
      const user = userEvent.setup()
      const editedBody = "On reflection: read this from the shared config module."
      renderShell()
      await draftAndSubmitComment(user)
      await user.click(
        await screen.findByRole("button", { name: EXISTING_COMMENT }, PIPELINE_TIMEOUT)
      )

      // Act
      await user.click(await screen.findByRole("button", { name: "Edit" }, PIPELINE_TIMEOUT))
      const editor = screen.getByLabelText("Edit comment body")
      await user.clear(editor)
      await user.type(editor, editedBody)
      await user.click(screen.getByRole("button", { name: "Save" }))

      // Assert — wait for the editor to close FIRST: while it is open its textarea still holds
      // the new text, so asserting the body before that would pass without anything being saved.
      await waitFor(
        () => expect(screen.queryByLabelText("Edit comment body")).toBeNull(),
        PIPELINE_TIMEOUT
      )
      expect(await screen.findByText(editedBody, undefined, PIPELINE_TIMEOUT)).toBeInTheDocument()
      expect(screen.queryByText(COMMENT_BODY)).toBeNull()
    },
    JOURNEY_TIMEOUT_MS
  )
})
