// Bounded-concurrency map (generic helper): run `worker` over every item with at most
// `limit` promises in flight at once, resolving to results in INPUT order regardless of the
// order they complete. Both engines fetch file contents this way (docs/architecture.md §5/§6)
// — a fixed pool hides network latency without opening a socket per file on a 300-file PR or
// a thousand-file repo scan. `onSettled` fires the running completed-count after each item so
// callers can report live "reading files 7/23" progress.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: (completed: number) => void
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results

  let nextIndex = 0
  let completed = 0

  const runOne = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return

      results[index] = await worker(items[index]!, index)
      completed += 1
      onSettled?.(completed)
    }
  }

  const poolSize = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: poolSize }, () => runOne()))

  return results
}
