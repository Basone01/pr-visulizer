import type { KeyValueStore } from "@/utils/storage/keyValueStore"

const mutationQueues = new WeakMap<KeyValueStore, Promise<void>>()

// Store reads and writes are individually asynchronous, so an immutable record plus its index
// must share one backing-store queue even when separate storage factory instances perform them.
export function serializeStorageMutation<T>(
  store: KeyValueStore,
  mutation: () => Promise<T>
): Promise<T> {
  const previous = mutationQueues.get(store) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => current)
  mutationQueues.set(store, queued)

  return previous.then(mutation).finally(() => {
    release()
    if (mutationQueues.get(store) === queued) mutationQueues.delete(store)
  })
}
