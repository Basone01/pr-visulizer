import type { AnalysisResult } from "@pr-visulizer/shared"
import { LRUCache } from "lru-cache"

// The §5 step-9 result cache: LRU keyed by headSha (+ engine name). Because the key
// contains the SHA, a cached entry is IMMUTABLE — a new push is a new SHA and simply
// misses the cache, so there is no invalidation logic. Wraps lru-cache in one place.

export type AnalysisCache = {
  get(headSha: string, engine: string): AnalysisResult | undefined
  set(headSha: string, engine: string, result: AnalysisResult): void
}

function cacheKey(headSha: string, engine: string): string {
  return `${engine}:${headSha}`
}

export function createAnalysisCache(max = 128): AnalysisCache {
  const store = new LRUCache<string, AnalysisResult>({ max })

  return {
    get(headSha, engine) {
      return store.get(cacheKey(headSha, engine))
    },
    set(headSha, engine, result) {
      store.set(cacheKey(headSha, engine), result)
    },
  }
}
