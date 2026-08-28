import { useState } from "react"

import { updateRecentFiles } from "@/entity/recentFiles"

// Tracks which files the reviewer has moved through, most recent first. Navigation is a detour
// (§10) — this only watches it, it never steers it.
//
// The list is adjusted DURING render when the open path changes: React's documented alternative
// to an effect whose only job is keeping two values in step. It also means the very first render
// showing a new file already has that file at the front, so a ⌘P landing right after a switch
// can't read a stale list.
export function useRecentFiles(currentPath: string): string[] {
  const [recentFiles, setRecentFiles] = useState<string[]>(() => updateRecentFiles([], currentPath))
  const [trackedPath, setTrackedPath] = useState(currentPath)

  if (currentPath !== trackedPath) {
    setTrackedPath(currentPath)
    setRecentFiles(updateRecentFiles(recentFiles, currentPath))
  }

  return recentFiles
}
