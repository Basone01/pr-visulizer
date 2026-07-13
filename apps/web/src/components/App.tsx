import { useEffect, useState } from "react"

import { readPrefillFromUrl, readTargetFromUrl, writeTargetToUrl } from "@/utils/prUrl/targetUrl"

import { OPEN_TARGET_EVENT } from "@/entity/deepLink"
import type { PrTarget } from "@/entity/pr"

import { AppShell } from "./AppShell"
import { HomeScreen } from "./home/HomeScreen"

// App state is explicit now (docs/tauri-architecture.md §5): home, or reviewing a target.
// URL params (and, in the desktop shell, CLI args) are deep-link INITIALIZERS — a valid
// ?owner&repo&number opens straight onto the review screen; anything else lands on home. The
// chosen target is mirrored back into the URL so the review screen stays shareable/refreshable.
type Screen = { screen: "home" } | { screen: "review"; target: PrTarget }

function initialScreen(): Screen {
  const target = readTargetFromUrl()
  return target ? { screen: "review", target } : { screen: "home" }
}

export function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen)

  function openTarget(target: PrTarget): void {
    writeTargetToUrl(target)
    setScreen({ screen: "review", target })
  }

  // A second `pr-visualizer <url>` invocation forwards its target as this event (docs/tauri-
  // architecture.md §5, §6) — this already-open window navigates to it. setScreen is stable,
  // so a one-time subscription is enough.
  useEffect(() => {
    function onOpen(event: Event): void {
      const target = (event as CustomEvent<PrTarget>).detail
      writeTargetToUrl(target)
      setScreen({ screen: "review", target })
    }

    window.addEventListener(OPEN_TARGET_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_TARGET_EVENT, onOpen)
  }, [])

  function goHome(): void {
    writeTargetToUrl(null)
    setScreen({ screen: "home" })
  }

  if (screen.screen === "home")
    return <HomeScreen onOpenTarget={openTarget} initialUrlText={readPrefillFromUrl()} />

  return <AppShell target={screen.target} onBack={goHome} />
}
