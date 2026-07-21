import { type NodePosition, nodeSize } from "./elkLayout"

// Places the GHOST band — the "context · not in review" region that sits below the main layered
// graph (docs/architecture.md §6: ghosts are context, never work).
//
// Why ghosts get their own pass instead of a compound elk node: no edge in an AnalysisResult ever
// touches a ghost. Both engines refuse a file-level edge unless BOTH endpoints are changed files
// (analyzeDeepSources buildFileLayer / analyzeFastSources), so every ghost is an isolated vertex.
// Feeding isolated vertices to a layered algorithm buys nothing — elk just scatters them through
// the first column, mixed in with the isolated CHANGED files, which is exactly the reading problem
// this band fixes. A deterministic grid is cheaper, pinnable in tests, and needs no worker.
//
// Pure on purpose, like elkLayout: geometry in, geometry out, no React and no elk.

export type LaidOutBox = { x: number; y: number; width: number; height: number }

export type GhostGroupBox = { x: number; y: number; width: number; height: number }

export type GhostGroupLayout = {
  box: GhostGroupBox
  positions: Map<string, NodePosition>
}

// The controllable core (architecture style): every spacing that legitimately varies is a setting
// with a default, so the band can be retuned without touching the packing math.
export type GhostGroupSettings = {
  gapAboveGroup: number // clear air between the main graph's bottom edge and the band
  padding: number // inner padding between the band's border and its ghosts
  labelHeight: number // room reserved above the grid for the band's header row
  columnGap: number
  rowGap: number
  minColumns: number // keeps a 2-ghost band from stacking into a tall single file
}

export const DEFAULT_GHOST_GROUP_SETTINGS: GhostGroupSettings = {
  gapAboveGroup: 120,
  padding: 20,
  labelHeight: 26,
  columnGap: 28,
  rowGap: 24,
  minColumns: 3,
}

type MainBounds = { left: number; bottom: number; width: number }

function boundsOf(mainBoxes: LaidOutBox[]): MainBounds {
  // No changed nodes at all (never happens with a real deep result, but the band must not depend
  // on that): anchor the band at the origin and let the grid decide its own width.
  if (mainBoxes.length === 0) return { left: 0, bottom: 0, width: 0 }

  let left = Infinity
  let right = -Infinity
  let bottom = -Infinity

  for (const box of mainBoxes) {
    left = Math.min(left, box.x)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }

  return { left, bottom, width: right - left }
}

// How many ghosts fit across the main graph's width. Matching that width is what makes the band
// read as a footer of the same graph rather than a second graph parked alongside it — and it keeps
// the overall drawing near-square, so fitView zooms to something legible.
//
// Measured against the band's INNER width (main width less its own padding), so a full row can
// never push the band wider than the graph it sits under.
function columnCount(ghostCount: number, mainWidth: number, settings: GhostGroupSettings): number {
  const { width: ghostWidth } = nodeSize({ ghost: true })
  const innerWidth = mainWidth - settings.padding * 2
  const fitting = Math.floor((innerWidth + settings.columnGap) / (ghostWidth + settings.columnGap))
  const wanted = Math.max(settings.minColumns, fitting)

  return Math.max(1, Math.min(ghostCount, wanted))
}

// The band's geometry and each ghost's position inside it. Returns null when there are no ghosts
// (the fast engine, the common case) so the caller renders no band at all — an empty box would be
// a permanent lie about a group that does not exist.
export function layoutGhostGroup(
  ghostPaths: string[],
  mainBoxes: LaidOutBox[],
  overrides: Partial<GhostGroupSettings> = {}
): GhostGroupLayout | null {
  if (ghostPaths.length === 0) return null

  const settings = { ...DEFAULT_GHOST_GROUP_SETTINGS, ...overrides }
  const { width: ghostWidth, height: ghostHeight } = nodeSize({ ghost: true })

  const main = boundsOf(mainBoxes)
  const columns = columnCount(ghostPaths.length, main.width, settings)
  const rows = Math.ceil(ghostPaths.length / columns)

  const gridWidth = columns * ghostWidth + (columns - 1) * settings.columnGap
  const gridHeight = rows * ghostHeight + (rows - 1) * settings.rowGap

  const box: GhostGroupBox = {
    x: main.left,
    y: main.bottom + settings.gapAboveGroup,
    // Never narrower than the grid it holds; stretches to the main graph's width when that is wider.
    width: Math.max(main.width, gridWidth + settings.padding * 2),
    height: settings.padding * 2 + settings.labelHeight + gridHeight,
  }

  const gridLeft = box.x + settings.padding
  const gridTop = box.y + settings.padding + settings.labelHeight

  const positions = new Map<string, NodePosition>()
  ghostPaths.forEach((path, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)

    positions.set(path, {
      x: gridLeft + column * (ghostWidth + settings.columnGap),
      y: gridTop + row * (ghostHeight + settings.rowGap),
    })
  })

  return { box, positions }
}
