// Whole-app zoom for the desktop webview. macOS WKWebView's native zoom hotkeys are
// unreliable, so we own zoom in JS: Cmd/Ctrl +/-/0 and Ctrl+wheel call the webview's
// setZoom, and the chosen factor persists. Needs the core:webview:allow-set-webview-zoom
// capability. Tauri-only (main.tsx guards the import).
import { getAppStorage } from "@/service/clientFactory"

const STORAGE_KEY = "webviewZoom"
const MIN = 0.5
const MAX = 3
const STEP = 0.1

function clamp(factor: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(factor * 100) / 100))
}

async function applyZoom(factor: number): Promise<void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview")
  await getCurrentWebview().setZoom(factor)
  // Exposed for tests/diagnostics — the applied zoom isn't otherwise readable from JS.
  ;(globalThis as unknown as { __zoom?: number }).__zoom = factor
}

export async function startZoomControls(): Promise<void> {
  let factor = 1

  const stored = await getAppStorage().get(STORAGE_KEY)
  if (stored) {
    const parsed = Number(stored)
    if (Number.isFinite(parsed)) factor = clamp(parsed)
  }
  void applyZoom(factor)

  function setFactor(next: number): void {
    factor = clamp(next)
    void applyZoom(factor)
    void getAppStorage().set(STORAGE_KEY, String(factor))
  }

  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey)) return

    // "=" is the unshifted "+" key; support both, plus the numpad variants.
    if (event.key === "=" || event.key === "+") {
      event.preventDefault()
      setFactor(factor + STEP)
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault()
      setFactor(factor - STEP)
    } else if (event.key === "0") {
      event.preventDefault()
      setFactor(1)
    }
  })

  // Ctrl+wheel is the conventional zoom gesture (kept to Ctrl so Cmd-scroll / trackpad pan in
  // the graph is unaffected). A trackpad pinch arrives as a Ctrl+wheel event, and over the
  // graph the React Flow canvas already zooms itself on pinch — so skip events originating
  // inside it, or a pinch would zoom the canvas AND the whole webview at once.
  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return
      if (event.target instanceof Element && event.target.closest(".react-flow")) return

      event.preventDefault()
      setFactor(factor + (event.deltaY < 0 ? STEP : -STEP))
    },
    { passive: false }
  )
}
