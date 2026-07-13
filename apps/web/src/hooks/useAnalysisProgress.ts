import { useEffect, useState } from "react"

import type { AnalysisProgress } from "@/entity/analysisProgress"
import { type PrTarget, prKey } from "@/entity/pr"

import { getPrClient } from "@/service/clientFactory"

// Live analysis-step progress for a target (docs/architecture.md §5, task 5). A queryFn can't
// stream, so the shell reads progress through this seam instead: it subscribes to the client's
// per-target emitter, which the tauri client feeds from the in-webview engine and the fixture
// client feeds a synthetic sequence. http mode never emits (202-poll), so this stays null and
// the panel falls back to its indeterminate state. Re-subscribes when the target changes.
export function useAnalysisProgress(target: PrTarget): AnalysisProgress | null {
  const [progress, setProgress] = useState<AnalysisProgress | null>(null)
  const key = prKey(target)

  useEffect(() => {
    setProgress(null)
    const unsubscribe = getPrClient().subscribeAnalysisProgress(target, setProgress)

    return unsubscribe
    // `key` fully identifies the target; `target` is a fresh object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return progress
}
