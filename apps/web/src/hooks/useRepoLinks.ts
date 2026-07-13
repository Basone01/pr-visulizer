import { useCallback, useEffect, useState } from "react"

import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import type { RepoRef } from "@/entity/pr"
import type { RepoLink } from "@/entity/repoSource"

import { getAppStorage } from "@/service/clientFactory"

import { loadRepoLinks, removeRepoLink } from "@/tauri/repoLinks"

// The home screen's view of the linked-repo registry (docs/tauri-architecture.md §5, "My
// repos"). Adding goes through the picker flow (`linkLocalRepo`), which writes the store
// itself — the component calls `refresh()` afterwards; removing goes through here. The
// `store` is injectable so tests drive the list with an in-memory one.

export type RepoLinksView = {
  links: RepoLink[]
  isLoaded: boolean
  refresh: () => void
  remove: (repo: RepoRef) => void
}

export function useRepoLinks(store: KeyValueStore = getAppStorage()): RepoLinksView {
  const [links, setLinks] = useState<RepoLink[]>([])
  const [isLoaded, setIsLoaded] = useState(false)

  const refresh = useCallback(() => {
    void loadRepoLinks(store).then((loaded) => {
      setLinks(loaded)
      setIsLoaded(true)
    })
  }, [store])

  useEffect(() => {
    refresh()
  }, [refresh])

  const remove = useCallback(
    (repo: RepoRef) => {
      void removeRepoLink(store, repo).then(setLinks)
    },
    [store]
  )

  return { links, isLoaded, refresh, remove }
}
