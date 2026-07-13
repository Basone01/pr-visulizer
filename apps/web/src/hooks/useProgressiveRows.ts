import { startTransition, useEffect, useState } from "react"

// How many rows mount in the click's own commit, and how many are added per frame after.
// The first chunk covers more than a screenful of a maximised diff pane; the growth chunk is
// sized so one commit stays well inside a frame on a mid-range machine.
const FIRST_CHUNK = 200
const GROWTH_CHUNK = 400

// Mounting a whole diff in one commit is the longest freeze a file switch can cause: React's
// render phase yields, but its COMMIT phase does not, so a 3,000-row file lands as a single
// ~200ms task. (Hub files — the ones every other file imports — are exactly the big ones, which
// is why the freeze looked degree-proportional.)
//
// So mount a screenful, then grow across frames. Same total work, but no single long task, and
// the first rows paint immediately. `requiredRow` keeps an overlay's target row mounted even if
// growth hasn't reached it yet (a jump-to-definition can land past the first chunk).
export function useProgressiveRows(key: string, total: number, requiredRow = -1): number {
  const [grown, setGrown] = useState(FIRST_CHUNK)
  const [grownFor, setGrownFor] = useState(key)

  // Reset DURING render, not in an effect: an effect would let the new file mount in full for
  // one commit — the exact freeze this hook exists to prevent.
  if (key !== grownFor) {
    setGrownFor(key)
    setGrown(FIRST_CHUNK)
  }

  useEffect(() => {
    if (grown >= total) return

    // A transition, so a click landing mid-growth interrupts it instead of queueing behind it.
    const frame = requestAnimationFrame(() =>
      startTransition(() => setGrown((current) => Math.min(total, current + GROWTH_CHUNK)))
    )

    return () => cancelAnimationFrame(frame)
  }, [grown, total])

  return Math.min(total, Math.max(grown, requiredRow + 1))
}
