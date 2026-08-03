// Who owns an Escape keypress. Seven surfaces listen for Escape on the same window (find bar,
// commit picker, description sheet, peek, line selection, thread panel, the shell's pane
// collapse), so "the innermost one wins" is not something any of them can decide locally — each
// would need to know the state of the other six. This table is the one place that decides; the
// pure pick below is its whole implementation, and `useEscapeKey` is the only caller.

// Innermost first: an earlier layer outranks every later one. The order follows what the UI
// actually stacks — a modal sheet covers the whole app, a popover covers the pane, the pane's
// own overlays cover its content, and the shell's pane collapse is the fallback that acts only
// when nothing else is open.
export const ESCAPE_LAYERS = [
  "descriptionPanel",
  "commitPicker",
  "findBar",
  "peek",
  "lineSelection",
  "threadPanel",
  "paneCollapse",
] as const

export type EscapeLayer = (typeof ESCAPE_LAYERS)[number]

// The winning claim, or null when nothing is claiming Escape.
export function pickEscapeOwner<TClaim extends { layer: EscapeLayer }>(
  claims: readonly TClaim[]
): TClaim | null {
  let owner: TClaim | null = null
  let ownerRank: number = ESCAPE_LAYERS.length

  for (const claim of claims) {
    const rank = ESCAPE_LAYERS.indexOf(claim.layer)

    // `<=` so the LAST claim of a layer wins a tie: two instances of one surface means the one
    // registered second is the inner one.
    if (rank <= ownerRank) {
      owner = claim
      ownerRank = rank
    }
  }

  return owner
}
