import { describe, expect, it } from "vitest"

import { createMemoryKeyValueStore } from "@/utils/storage/keyValueStore"

import { createTerminalShortcutStorage } from "./shortcutStorage"

describe("terminal shortcut storage", () => {
  it("adds_and_removes_a_custom_shortcut", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createTerminalShortcutStorage(store)
    const label = "Summarize"
    const template = "Summarize the changes up to {headSha}"

    // Act
    const [addedShortcut] = await storage.add({ label, template })
    const shortcutsAfterAdd = await createTerminalShortcutStorage(store).load()
    await storage.remove(addedShortcut!.id)
    const shortcutsAfterRemove = await createTerminalShortcutStorage(store).load()

    // Assert
    expect(shortcutsAfterAdd).toEqual([{ id: addedShortcut!.id, label, template }])
    expect(shortcutsAfterRemove).toEqual([])
  })

  it("loads_malformed_stored_shortcuts_as_empty", async () => {
    // Arrange
    const store = createMemoryKeyValueStore()
    const storage = createTerminalShortcutStorage(store)
    const shortcutWithoutTemplate = { id: "broken", label: "Broken" }
    await store.set("terminal:prompt-shortcuts", JSON.stringify([shortcutWithoutTemplate]))

    // Act
    const shortcuts = await storage.load()

    // Assert
    expect(shortcuts).toEqual([])
  })
})
