import { type ReactNode, useLayoutEffect, useRef } from "react"
import { type Root, createRoot } from "react-dom/client"

// Renders its children in a React root of their own, so a block that breaks can only break itself.
//
// Why a separate root: OpenUI's per-element boundary re-renders the "last good" children after an
// error. If those children throw from an effect, it loops until React throws "Maximum update depth
// exceeded" from its scheduler. No error boundary catches that, so in the app's root it would take
// the whole chat down. A root of our own sees every catch of that loop in onCaughtError, so we
// swap in the fallback after a few, long before React's limit of 50 nested updates.
//
// What counts: catches since the host last rendered new children. A loop catches over and over
// with no new children in between. A healthy block catches each broken element once per update,
// and the next update starts the count again. No timer is involved, so fake timers and many
// updates in one task cannot add up to a false "loop".
//
// Once tripped, the block stays on its fallback for good, even if later children would render.
// A loop comes from a library or platform bug in a component, not from one bad token, so new
// content would most likely loop again. The fallback still shows the latest source.

// Catches without new children in between that mean "loop", not "a few bad elements".
const RUNAWAY_CATCH_LIMIT = 10

type ContainedRootProps = {
  children: ReactNode
  fallback: ReactNode
  // For the host element, which sits in the caller's layout.
  className?: string | undefined
}

export function ContainedRoot({ children, fallback, className }: ContainedRootProps): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<Root | null>(null)
  const hasFailedRef = useRef(false)
  const catchesSinceChildrenRef = useRef(0)
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    // A fresh container per mount: StrictMode mounts twice, and a container may hold one root.
    const container = document.createElement("div")
    host.appendChild(container)

    const showFallback = (): void => {
      hasFailedRef.current = true
      root.render(fallbackRef.current)
    }

    const root = createRoot(container, {
      onCaughtError: (error) => {
        console.error("OpenUI block component failed:", error)
        catchesSinceChildrenRef.current += 1
        if (catchesSinceChildrenRef.current === RUNAWAY_CATCH_LIMIT) showFallback()
      },
      onUncaughtError: (error) => {
        console.error("OpenUI block crashed:", error)
        showFallback()
      },
    })
    rootRef.current = root

    return () => {
      rootRef.current = null
      // Unmounting a root synchronously while the parent root commits is not allowed.
      setTimeout(() => {
        root.unmount()
        container.remove()
      }, 0)
    }
  }, [])

  useLayoutEffect(() => {
    catchesSinceChildrenRef.current = 0
    rootRef.current?.render(hasFailedRef.current ? fallback : children)
  })

  return <div ref={hostRef} className={className} />
}
