import { Component, type ErrorInfo, type ReactNode } from "react"

// A render-error boundary. One file's diff renders arbitrary content (a huge or unusual patch,
// async syntax highlighting, symbol anchors), so a crash there must NOT take down the whole
// app — the boundary shows a recoverable message and the graph + tray keep working. Key it by
// the open file so switching files remounts it and clears a per-file error.
type Props = {
  children: ReactNode
  fallback: (error: Error) => ReactNode
}

type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No terminal in a double-clicked app — log so it lands in the webview console at least.
    console.error("Render crashed:", error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error) return this.props.fallback(this.state.error)

    return this.props.children
  }
}
