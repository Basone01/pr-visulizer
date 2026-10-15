import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import type { PrTarget } from "@/entity/pr"

import { createAiChatStorage } from "@/service/aiReview/chatStorage"
import { createAiReviewRunStorage } from "@/service/aiReview/runStorage"
import { createAiReviewSettingsStorage } from "@/service/aiReview/settingsStorage"
import { initTauriAiReviewClient } from "@/service/aiReview/tauriAiReviewClient"

import { addRepoLink } from "@/tauri/repoLinks"

import { AppShell } from "./AppShell"

// The Codex safe profile as the reviewer actually meets it: the production AppShell, the real
// AiReviewPanel/AiChatPanel, the real `createCodexSafeProfileBridge`, the real lifecycle client
// and the real run/chat storage, all composed by production code.
//
// The ONLY fake is the true process boundary — `invoke`/`listen` from @tauri-apps/api, which is
// where the Rust broker lives. Nothing under @/service/aiReview is mocked, so every assertion
// below is about the composition, not about a stand-in for it.

// `env.tauriMode` is read once when config/env.ts is imported, and the AI panel mounts only in
// desktop mode — so the webview marker has to exist before AppShell's module graph loads.
vi.hoisted(() => {
  ;(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

// The mounted composition assembles a bounded revision-pinned context, hashes it into two
// fingerprints, and drives real broker lifecycles — slower than Vitest's 5s default when the whole
// suite is running, so this file states its own budget rather than flaking under load.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// Every wait in this file uses the same budget, for the same reason.
const WAIT_TIMEOUT = 10_000

const OBSERVED_PROVENANCE = {
  executableIdentityDigest: "a".repeat(64),
  cliVersion: "0.153.4",
  helpDigest: "b".repeat(64),
  safeProfileRevision: "codex-safe-profile-r2",
  provenanceFingerprint: "c".repeat(64),
}

const REPLACED_PROVENANCE = {
  ...OBSERVED_PROVENANCE,
  executableIdentityDigest: "f".repeat(64),
  provenanceFingerprint: "e".repeat(64),
}

const RECEIPT_ID = "codex-receipt-0153-4"

const AVAILABLE_CAPABILITY = {
  available: true,
  cliVersion: "0.153.4",
  coreControlsVerified: true,
  provenance: OBSERVED_PROVENANCE,
  receiptId: RECEIPT_ID,
  diagnostics: [],
}

// A broker that still calls itself available after the executable underneath it was replaced. Only
// the app's own binding of launch readiness to the exact receipt stands between this and a launch.
const REPLACED_DESCRIPTOR_CAPABILITY = {
  available: true,
  cliVersion: "0.153.4",
  coreControlsVerified: true,
  provenance: REPLACED_PROVENANCE,
  receiptId: "codex-receipt-replaced",
  diagnostics: [],
}

const REJECTED_CAPABILITY = {
  available: false,
  cliVersion: "0.153.4",
  coreControlsVerified: true,
  provenance: REPLACED_PROVENANCE,
  receiptId: null,
  diagnostics: ["Codex safe-profile exact compatibility receipt was rejected."],
}

const LOGIN_PATH = "src/api/routes/login.ts"
const LOGIN_PATCH = "@@ -10,1 +10,1 @@\n-old redirect\n+new redirect\n"

// The Rust broker's side of the boundary. `onStart` is what a case uses to decide which public
// event sequence the broker answers a typed start request with.
const broker = vi.hoisted(() => {
  const listeners = new Set<(event: { payload: unknown }) => void>()

  return {
    listeners,
    capability: null as unknown,
    capabilityCalls: 0,
    startRequests: [] as Array<Record<string, unknown>>,
    cancelledRunIds: [] as string[],
    terminalStarts: [] as Array<Record<string, unknown>>,
    terminalStops: [] as string[],
    onStart: (() => {}) as (request: Record<string, unknown>) => void,
    emit(event: Record<string, unknown>): void {
      for (const listener of [...listeners]) listener({ payload: event })
    },
  }
})

// The PR data the shell reads, plus the knobs a case turns: which path the bounded reader has to
// refuse, and whether anything ever tried to write review progress.
const prControl = vi.hoisted(() => ({
  requestedSnapshotPaths: [] as string[],
  oversizedPath: null as string | null,
  putProgressCalls: 0,
}))

// The one desktop store the mounted shell and the AI lifecycle client share, so every assertion
// reads back exactly what production wrote. It is created inside the mock factory because that
// is the first place an import is available (vi.hoisted runs before module resolution).
const desktop = vi.hoisted<{ storage: KeyValueStore; reset: () => void }>(() => ({
  storage: null as unknown as KeyValueStore,
  reset: () => {},
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    if (command === "codex_safe_profile_capability") {
      broker.capabilityCalls += 1
      return broker.capability
    }
    if (command === "codex_safe_profile_start") {
      const { request } = args as { request: Record<string, unknown> }
      broker.startRequests.push(request)
      broker.onStart(request)
      return { runId: request.runId }
    }
    if (command === "codex_safe_profile_cancel") {
      const { request } = args as { request: { runId: string } }
      broker.cancelledRunIds.push(request.runId)
      return null
    }
    if (command === "codex_terminal_start") {
      const { request } = args as { request: Record<string, unknown> }
      broker.terminalStarts.push(request)
      return { sessionId: request.sessionId }
    }
    if (command === "codex_terminal_attach" || command === "codex_terminal_resize") return null
    if (command === "codex_terminal_update_context") return null
    if (command === "codex_terminal_stop") {
      const { request } = args as { request: { sessionId: string } }
      broker.terminalStops.push(request.sessionId)
      return null
    }
    throw new Error(`Unexpected Codex safe-profile command: ${command}`)
  },
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_event: string, handler: (event: { payload: unknown }) => void) => {
    broker.listeners.add(handler)
    return () => broker.listeners.delete(handler)
  },
}))

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 24
    cols = 80
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    onData() {
      return { dispose() {} }
    }
    dispose() {}
  },
}))
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}))

vi.mock("./graph/GraphPane", () => ({ GraphPane: () => <div data-testid="graph-pane">graph</div> }))
vi.mock("./diff/DiffPane", () => ({ DiffPane: () => <div data-testid="diff-pane">diff</div> }))

vi.mock("@/service/clientFactory", async () => {
  const { createMemoryKeyValueStore } = await import("@/utils/storage/keyValueStore")
  const { pr42Analysis: analysis } = await import("@/service/fixture/pr42")

  desktop.storage = createMemoryKeyValueStore()
  desktop.reset = () => {
    desktop.storage = createMemoryKeyValueStore()
  }

  const progress = {
    userId: "u",
    owner: analysis.pr.owner,
    repo: analysis.pr.repo,
    prNumber: analysis.pr.number,
    headSha: analysis.pr.headSha,
    reviewedFiles: [],
    drafts: [],
  }
  const patchFor = (path: string): string =>
    path === LOGIN_PATH ? LOGIN_PATCH : `@@ -1,1 +1,1 @@\n-old ${path}\n+new ${path}\n`

  const client = {
    getOverview: () => Promise.resolve({ pr: analysis.pr, files: analysis.files }),
    getAnalysis: () => Promise.resolve({ status: "ready" as const, result: analysis }),
    subscribeAnalysisProgress: () => () => {},
    getPatch: (_target: unknown, path: string) => Promise.resolve(patchFor(path)),
    getRevisionPinnedPatchSnapshot: (
      _target: unknown,
      request: { baseSha: string; headSha: string; paths: readonly string[] }
    ) => {
      prControl.requestedSnapshotPaths.push(...request.paths)
      const patches = Object.fromEntries(
        request.paths.map((path) => [
          path,
          // A single over-limit body is how the desktop reader refuses an unbounded response;
          // the assembler must turn it into a disclosed omission, never into review context.
          path === prControl.oversizedPath ? "x".repeat(200_000) : patchFor(path),
        ])
      )
      return Promise.resolve({
        baseSha: request.baseSha,
        headSha: request.headSha,
        patches,
      })
    },
    getFileAtHead: () => Promise.resolve(null),
    listReviewComments: () => Promise.resolve([]),
    listCommits: () => Promise.resolve({ commits: [], truncated: false }),
    getRangeDiff: () => Promise.resolve({ files: [] }),
    getProgress: () => Promise.resolve(progress),
    putProgress: (_target: unknown, next: unknown) => {
      prControl.putProgressCalls += 1
      return Promise.resolve(next)
    },
    submitReview: () => Promise.resolve(),
    getViewer: () =>
      Promise.resolve({ userId: "u", login: "reviewer", name: "R", avatarUrl: null }),
    listOpenPullRequests: () => Promise.resolve([]),
    invalidatePr: () => Promise.resolve(),
  }

  return {
    getPrClient: () => client,
    getAppStorage: () => desktop.storage,
  }
})

const TARGET: PrTarget = { owner: "acme", repo: "webapp", number: 42 }

function queuedOnly(runId: string): Array<Record<string, unknown>> {
  return [{ type: "queued", runId }]
}

function admittedThrough(runId: string): Array<Record<string, unknown>> {
  return [
    { type: "queued", runId },
    { type: "admitted", runId, provenance: OBSERVED_PROVENANCE },
    { type: "started", runId, provenance: OBSERVED_PROVENANCE },
    { type: "progress", runId },
  ]
}

function completedEvent(runId: string, result: unknown): Record<string, unknown> {
  return {
    type: "completed",
    runId,
    result,
    usage: { elapsedMs: 1200, toolEventCount: 0 },
    provenance: OBSERVED_PROVENANCE,
  }
}

function failedEvent(runId: string, code: string): Record<string, unknown> {
  return { type: "failed", runId, code, provenance: OBSERVED_PROVENANCE }
}

function reviewTerminal() {
  return {
    summary: "The new login redirect is not validated before use.",
    findings: [
      {
        id: "login-open-redirect",
        title: "Login redirect target is not validated",
        severity: "high" as const,
        confidence: "high" as const,
        category: "security",
        path: LOGIN_PATH,
        side: "RIGHT" as const,
        startLine: 10,
        endLine: 10,
        evidence: "The changed line forwards an unvalidated redirect target.",
        impact: "An attacker can redirect a signed-in reviewer to an external host.",
        suggestedFix: "Validate the redirect target against an allowlist.",
        source: "code-review" as const,
      },
    ],
    requirementCoverage: null,
    reportedModel: "gpt-5-codex",
  }
}

function chatTerminal() {
  return {
    message: "The redirect target reaches the response without an allowlist check.",
    findingCandidate: null,
    reportedModel: "gpt-5-codex",
  }
}

// Emit the public sequence the way the broker does: one event per task turn, so the lifecycle's
// admission transaction settles between `admitted` and the terminal rather than inside one tick.
function emitSequence(events: ReadonlyArray<Record<string, unknown>>): void {
  void events.reduce(
    (previous, event) =>
      previous.then(() => {
        broker.emit(event)
      }),
    Promise.resolve()
  )
}

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell target={TARGET} onBack={() => {}} />
    </QueryClientProvider>
  )
}

function runStorage() {
  return createAiReviewRunStorage(desktop.storage)
}

function chatStorage() {
  return createAiChatStorage(desktop.storage)
}

async function chooseCodexProvider(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByText("Chat options")
  await user.selectOptions(screen.getByLabelText("Provider"), "codex")
}

function launchButton(): HTMLElement {
  return screen.getByRole("button", { name: "Review PR" })
}

// The panel rebuilds its revision-pinned context whenever the live PR inputs change identity, and
// the overview and analysis queries land at different times. Each rebuild reads every included
// path once, so a snapshot-request count that stops growing means the identity has settled.
async function waitForSettledReviewContext(): Promise<void> {
  let previousRequestCount = -1

  await waitFor(
    () => {
      const currentRequestCount = prControl.requestedSnapshotPaths.length
      const settled = currentRequestCount > 0 && currentRequestCount === previousRequestCount
      previousRequestCount = currentRequestCount
      expect(settled).toBe(true)
    },
    { timeout: WAIT_TIMEOUT }
  )
}

async function waitForReviewReady(): Promise<void> {
  await waitForSettledReviewContext()
  await waitFor(() => expect(launchButton()).toBeEnabled(), { timeout: WAIT_TIMEOUT })
}

async function openChatTab(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("tab", { name: "Chat" }))
  await waitFor(
    () => expect(screen.queryByText("Loading local chat history…")).not.toBeInTheDocument(),
    { timeout: WAIT_TIMEOUT }
  )
}

async function pressTerminalStart(): Promise<void> {
  const startButton = await screen.findByRole(
    "button",
    { name: "Start" },
    { timeout: WAIT_TIMEOUT }
  )
  fireEvent.click(startButton)
}

async function waitForChatReady(): Promise<HTMLElement> {
  const composer = screen.getByLabelText("Message")
  await waitFor(() => expect(composer).toBeEnabled(), { timeout: WAIT_TIMEOUT })
  return composer
}

describe("AppShell — Codex safe profile through its production composition", () => {
  beforeEach(async () => {
    broker.listeners.clear()
    broker.capability = AVAILABLE_CAPABILITY
    broker.capabilityCalls = 0
    broker.startRequests = []
    broker.cancelledRunIds = []
    broker.terminalStarts = []
    broker.terminalStops = []
    broker.onStart = () => {}
    prControl.requestedSnapshotPaths = []
    prControl.oversizedPath = null
    prControl.putProgressCalls = 0
    desktop.reset()
    // Every test here drives the docked Codex terminal, which only starts after a provider choice.
    await createAiReviewSettingsStorage(desktop.storage).saveTerminalProvider("codex")
    initTauriAiReviewClient({ storage: desktop.storage })
  })

  it("docked_codex_terminal_opens_and_collapses_without_hiding_the_review_workspace", async () => {
    // Arrange
    const user = userEvent.setup()
    renderShell()
    await screen.findByLabelText("Codex terminal")
    const workspace = document.querySelector("[data-workspace]")
    const shell = document.querySelector("[data-shell]")
    const hideAiReview = screen.getByRole("button", { name: "Codex · Hide" })

    // Act
    await user.click(hideAiReview)

    // Assert
    expect(workspace).not.toBeNull()
    expect(shell?.parentElement).toBe(workspace)
    expect(document.querySelector("aside")?.parentElement).toBe(workspace)
    expect(screen.getByText("Dependency graph")).toBeInTheDocument()
    expect(screen.getByText("Review queue")).toBeInTheDocument()
    expect(screen.queryByRole("separator", { name: "Resize Codex pane" })).toBeNull()
    const showAiReview = screen.getByRole("button", { name: "Show Codex" })
    expect(showAiReview).toHaveAttribute("aria-expanded", "false")
    await user.click(showAiReview)
    expect(screen.getByLabelText("Codex terminal")).toBeInTheDocument()
    expect(screen.getByLabelText("Model")).toBeInTheDocument()
  })

  it("does_not_prepare_a_bounded_patch_context_for_the_terminal", async () => {
    // Arrange
    renderShell()

    // Act
    await screen.findByLabelText("Codex terminal")

    // Assert
    expect(prControl.requestedSnapshotPaths).toEqual([])
    expect(broker.startRequests).toEqual([])
  })

  it("does_not_restart_codex_when_its_started_session_rerenders_the_production_shell", async () => {
    // Arrange
    await addRepoLink(desktop.storage, { path: "/repo", owner: TARGET.owner, repo: TARGET.repo })

    // Act
    renderShell()
    await pressTerminalStart()
    await waitFor(() => expect(broker.terminalStarts).toHaveLength(1), { timeout: WAIT_TIMEOUT })

    // Assert
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(broker.terminalStarts).toHaveLength(1)
    expect(broker.terminalStops).toEqual([])
  })

  it("resizes_every_workspace_pane_and_persists_the_docked_widths_without_restarting_codex", async () => {
    // Arrange
    await addRepoLink(desktop.storage, { path: "/repo", owner: TARGET.owner, repo: TARGET.repo })
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1700 })
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 })
    renderShell()
    await pressTerminalStart()
    await waitFor(() => expect(broker.terminalStarts).toHaveLength(1), { timeout: WAIT_TIMEOUT })

    const workspace = document.querySelector<HTMLElement>("[data-workspace]")
    const shell = document.querySelector<HTMLElement>("[data-shell]")
    const codexPane = screen.getByLabelText("Codex")
    const graphPane = document.querySelector<HTMLElement>('[data-pane-id="graph"]')
    const trayPane = document.querySelector<HTMLElement>('[data-pane-id="tray"]')
    const codexHeightDivider = document.querySelector<HTMLElement>(
      '[aria-label="Resize Codex height"]'
    )
    if (!workspace || !shell || !graphPane || !trayPane || !codexHeightDivider) {
      throw new Error("Workspace panes are missing")
    }

    Object.defineProperty(workspace, "clientWidth", { configurable: true, value: 1700 })
    Object.defineProperty(workspace, "clientHeight", { configurable: true, value: 860 })
    Object.defineProperty(shell, "clientWidth", { configurable: true, value: 1310 })
    vi.spyOn(codexPane, "getBoundingClientRect").mockReturnValue(new DOMRect(1122, 0, 390, 390))
    vi.spyOn(graphPane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 916))
    vi.spyOn(trayPane, "getBoundingClientRect").mockReturnValue(new DOMRect(822, 0, 300, 916))

    const codexDivider = screen.getByRole("separator", { name: "Resize Codex pane" })
    const graphDivider = screen.getByRole("separator", { name: "Resize graph pane" })
    const trayDivider = screen.getByRole("separator", { name: "Resize review tray" })

    // Act
    fireEvent.keyDown(graphDivider, { key: "ArrowRight" })
    expect(shell.style.getPropertyValue("--graph-width")).toBe("410px")

    fireEvent.pointerDown(codexDivider, { pointerId: 1, clientX: 1122 })
    fireEvent.pointerMove(codexDivider, { pointerId: 1, clientX: 1022 })
    fireEvent.pointerUp(codexDivider, { pointerId: 1, clientX: 1022 })

    fireEvent.pointerDown(graphDivider, { pointerId: 2, clientX: 400 })
    fireEvent.pointerMove(graphDivider, { pointerId: 2, clientX: 450 })
    fireEvent.pointerUp(graphDivider, { pointerId: 2, clientX: 450 })

    fireEvent.pointerDown(trayDivider, { pointerId: 3, clientX: 822 })
    fireEvent.pointerMove(trayDivider, { pointerId: 3, clientX: 772 })
    fireEvent.pointerUp(trayDivider, { pointerId: 3, clientX: 772 })

    fireEvent.pointerDown(codexHeightDivider, { pointerId: 4, clientY: 500 })
    fireEvent.pointerMove(codexHeightDivider, { pointerId: 4, clientY: 400 })
    fireEvent.pointerUp(codexHeightDivider, { pointerId: 4, clientY: 400 })

    // Assert
    expect(workspace.style.getPropertyValue("--codex-width")).toBe("490px")
    expect(workspace.style.getPropertyValue("--codex-height")).toBe("490px")
    expect(shell.style.getPropertyValue("--graph-width")).toBe("450px")
    expect(shell.style.getPropertyValue("--tray-width")).toBe("350px")
    expect(screen.getByTestId("diff-pane")).toBeInTheDocument()
    expect(shell.style.getPropertyValue("--diff-width")).toBe("")
    expect(codexDivider).toHaveAttribute("aria-orientation", "vertical")
    expect(codexHeightDivider).toHaveAttribute("aria-orientation", "horizontal")
    expect(broker.terminalStarts).toHaveLength(1)
    expect(broker.terminalStops).toEqual([])

    await waitFor(async () => {
      const persisted = await desktop.storage.get("panelSizes")
      expect(JSON.parse(persisted ?? "{}")).toEqual({
        codex: 490,
        codexHeight: 490,
        graph: 450,
        tray: 350,
      })
    })
  })
})
