import type { PrTarget } from "@/entity/pr"

// The one window event the desktop shell uses to navigate an already-open window
// (docs/tauri-architecture.md §5, §6): the single-instance bootstrap dispatches it with the
// forwarded target, App listens for it. Named in one place so the two sides can't drift.
export const OPEN_TARGET_EVENT = "prv:open-target"

export type OpenTargetEvent = CustomEvent<PrTarget>
