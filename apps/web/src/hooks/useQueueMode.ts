import { type QueueMode } from "@pr-visulizer/shared"
import { useEffect, useState } from "react"

import { getAppStorage } from "@/service/clientFactory"

// The review-queue ordering the reviewer prefers, persisted so it survives restarts (same
// KeyValueStore as panel sizes / collapse). "foundations" reviews the most-depended-upon files
// first; "branch" walks each dependency branch start→end (docs/architecture.md §8.4).
const STORAGE_KEY = "queueMode"

export function useQueueMode() {
  const [mode, setMode] = useState<QueueMode>("foundations")

  useEffect(() => {
    void getAppStorage()
      .get(STORAGE_KEY)
      .then((raw) => {
        if (raw === "foundations" || raw === "branch") setMode(raw)
      })
  }, [])

  function choose(next: QueueMode): void {
    setMode(next)
    void getAppStorage().set(STORAGE_KEY, next)
  }

  return { mode, choose }
}
