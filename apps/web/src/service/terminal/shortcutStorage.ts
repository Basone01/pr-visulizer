import { z } from "zod"

import type { KeyValueStore } from "@/utils/storage/keyValueStore"

import {
  type CustomTerminalPromptShortcut,
  customTerminalPromptShortcutSchema,
} from "@/entity/terminalPromptShortcuts"

import { serializeStorageMutation } from "@/service/aiReview/storageMutationQueue"

const TERMINAL_SHORTCUTS_KEY = "terminal:prompt-shortcuts"

const storedShortcutsSchema = z.array(customTerminalPromptShortcutSchema)

export type NewCustomTerminalPromptShortcut = Omit<CustomTerminalPromptShortcut, "id">

function createShortcutId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `shortcut-${Date.now()}-${Math.random()}`
}

async function loadTerminalShortcuts(
  store: KeyValueStore
): Promise<CustomTerminalPromptShortcut[]> {
  const raw = await store.get(TERMINAL_SHORTCUTS_KEY)
  if (raw === null) return []

  try {
    const parsed = storedShortcutsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

async function saveTerminalShortcuts(
  store: KeyValueStore,
  shortcuts: CustomTerminalPromptShortcut[]
): Promise<CustomTerminalPromptShortcut[]> {
  const parsedShortcuts = storedShortcutsSchema.parse(shortcuts)
  await store.set(TERMINAL_SHORTCUTS_KEY, JSON.stringify(parsedShortcuts))
  return parsedShortcuts
}

export function createTerminalShortcutStorage(store: KeyValueStore) {
  const mutate = <T>(mutation: () => Promise<T>): Promise<T> =>
    serializeStorageMutation(store, mutation)

  return {
    load: (): Promise<CustomTerminalPromptShortcut[]> => loadTerminalShortcuts(store),

    add(shortcut: NewCustomTerminalPromptShortcut): Promise<CustomTerminalPromptShortcut[]> {
      return mutate(async () => {
        const shortcuts = await loadTerminalShortcuts(store)
        return saveTerminalShortcuts(store, [...shortcuts, { id: createShortcutId(), ...shortcut }])
      })
    },

    remove(id: string): Promise<CustomTerminalPromptShortcut[]> {
      return mutate(async () => {
        const shortcuts = await loadTerminalShortcuts(store)
        return saveTerminalShortcuts(
          store,
          shortcuts.filter((shortcut) => shortcut.id !== id)
        )
      })
    },
  }
}
