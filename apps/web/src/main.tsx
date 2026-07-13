import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { type ReactNode, StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { env } from "@/config/env"

import { App } from "@/components/App"

import "@/styles/global.css"

// One QueryClient for the whole SPA. In a browser-only app a singleton is correct —
// there is no server request to leak state across (docs/architecture.md §9).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
})

const container = document.getElementById("root")
if (!container) throw new Error("Missing #root element")

const root = createRoot(container)

function render(tree: ReactNode): void {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>{tree}</QueryClientProvider>
    </StrictMode>
  )
}

// The desktop shell (docs/tauri-architecture.md §5) loads its startup gate as a separate
// chunk — the gate and every Tauri plugin it pulls in stay out of the web/http entry bundle,
// and only load when running under Tauri. The gate wires the client from `gh auth token` +
// CLI args before the App's queries run; web/http mode mounts the App directly.
// Dev-only: let the tauri-webview MCP server drive this WKWebView (no CDP endpoint exists).
// Guarded by import.meta.env.DEV so it is dead-code-eliminated from release bundles.
if (import.meta.env.DEV && env.tauriMode) {
  void import("@/tauri/devBridge").then(({ startDevBridge }) => startDevBridge())
}

// Whole-app zoom (Cmd/Ctrl +/-/0, Ctrl+wheel) in the desktop webview.
if (env.tauriMode) {
  void import("@/tauri/webviewZoom").then(({ startZoomControls }) => startZoomControls())
}

if (env.tauriMode) {
  import("@/components/TauriGate")
    .then(({ TauriGate }) =>
      render(
        <TauriGate>
          <App />
        </TauriGate>
      )
    )
    // A failed gate chunk must never leave a silent white window — surface the error
    // in the page (there is no terminal to read in a double-clicked app).
    .catch((error: unknown) => {
      console.error("TauriGate failed to load", error)
      container.innerText = `PR Visualizer failed to start: ${String(error)}`
    })
} else {
  render(<App />)
}
