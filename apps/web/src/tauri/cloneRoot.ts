import { CLONE_ROOT_KEY } from "@/entity/repoSource"

import { getAppStorage } from "@/service/clientFactory"

// The clone-root setting (docs/tauri-architecture.md §6 deep mode): the folder the user picks
// ONCE for where clones live, reused across PRs and across restarts. This module is the narrow
// wrapper over the Tauri Dialog plugin and the app storage — call sites depend on these four
// functions, never on the plugin, so the picker is swappable in one place (external-lib rule).
//
// Folder-picker + fs-scope note (verified against the Tauri 2 docs, 2026-07): a directory
// chosen through the Dialog `open()` picker is AUTOMATICALLY added to the fs plugin's runtime
// scope, so `readTextFile` under it works immediately in the same session. That runtime grant
// is NOT persisted on its own — the `tauri-plugin-persisted-scope` plugin (registered after
// `fs`) saves the dialog-granted scopes to disk so a cloneRoot picked in one run is still
// readable after a restart. We persist the PATH in app storage AND the scope via that plugin.

export { CLONE_ROOT_KEY }

export async function getCloneRoot(): Promise<string | null> {
  return getAppStorage().get(CLONE_ROOT_KEY)
}

export async function setCloneRoot(path: string): Promise<void> {
  await getAppStorage().set(CLONE_ROOT_KEY, path)
}

// Open the native folder picker; returns the chosen absolute path, or null if cancelled.
// The dialog plugin is loaded through a lazy dynamic import so it stays in its own chunk,
// out of the web/http entry bundle — the same pattern as ghToken/tauriHttp.
export async function pickCloneRoot(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog")
  const selected = await open({
    directory: true,
    // recursive grants the fs scope for SUBPATHS too — clones live at <root>/<owner>/<repo>,
    // so a non-recursive grant forbids every clone dir (verified: "forbidden path" on exists).
    recursive: true,
    multiple: false,
    title: "Choose where PR clones are stored",
  })

  // `open` returns string | string[] | null; a single-directory pick is a string.
  return typeof selected === "string" ? selected : null
}
