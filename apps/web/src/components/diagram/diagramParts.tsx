import type { ReactNode } from "react"

import { estimateTextWidth } from "@/utils/diagram/textMetrics"

import type { LedgerEntry } from "@/entity/diagram/diagramLedger"
import { CHANGE_WORDS, type ChangeKind } from "@/entity/diagram/diagramModel"

import styles from "./Diagram.module.css"

// Pieces both diagram kinds draw the same way: change badges, the legend strip, the ledger.

export type ShownChange = Exclude<ChangeKind, "unchanged">

const SHOWN_CHANGES: ShownChange[] = ["added", "changed", "removed"]

export const CHANGE_CLASS: Record<ChangeKind, string | undefined> = {
  added: styles.added,
  changed: styles.changed,
  removed: styles.removed,
  unchanged: undefined,
}

const BADGE_GLYPHS: Record<ShownChange, string> = { added: "+", changed: "Δ", removed: "−" }

export const BADGE_RADIUS = 8

// The status mark drawn over a node's or an edge's corner: shape and glyph, not just colour.
export function ChangeBadge({
  change,
  x,
  y,
}: {
  change: ShownChange
  x: number
  y: number
}): ReactNode {
  return (
    <g className={CHANGE_CLASS[change]} aria-hidden="true">
      <circle className={styles.badgeCircle} cx={x} cy={y} r={BADGE_RADIUS} />
      <text
        className={styles.badgeGlyph}
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {BADGE_GLYPHS[change]}
      </text>
    </g>
  )
}

export function presentChanges(changes: ChangeKind[]): ShownChange[] {
  return SHOWN_CHANGES.filter((change) => changes.includes(change))
}

// ---------- Legend: a strip at the bottom of the SVG, only for statuses that are present ----------

const LEGEND_TOP_GAP = 12
const LEGEND_ROW_HEIGHT = 20
const LEGEND_SWATCH_WIDTH = 14
const LEGEND_ITEM_GAP = 16
const LEGEND_FONT_SIZE = 10
const LEGEND_SIDE_PADDING = 16

type LegendItem = { change: ShownChange; x: number; row: number }

export function legendHeight(changes: ShownChange[], width: number): number {
  if (changes.length === 0) return 0

  const rows = Math.max(...legendItems(changes, width).map((item) => item.row)) + 1
  return LEGEND_TOP_GAP + rows * LEGEND_ROW_HEIGHT + 4
}

function legendItems(changes: ShownChange[], width: number): LegendItem[] {
  const items: LegendItem[] = []
  let x = LEGEND_SIDE_PADDING
  let row = 0

  for (const change of changes) {
    const itemWidth =
      LEGEND_SWATCH_WIDTH + 6 + estimateTextWidth(CHANGE_WORDS[change], LEGEND_FONT_SIZE, "sans")
    if (x > LEGEND_SIDE_PADDING && x + itemWidth > width - LEGEND_SIDE_PADDING) {
      x = LEGEND_SIDE_PADDING
      row += 1
    }
    items.push({ change, x, row })
    x += itemWidth + LEGEND_ITEM_GAP
  }

  return items
}

export function DiagramLegend({
  changes,
  top,
  width,
}: {
  changes: ShownChange[]
  top: number
  width: number
}): ReactNode {
  if (changes.length === 0) return null

  const firstRowY = top + LEGEND_TOP_GAP
  return (
    <g>
      <line
        className={styles.legendRule}
        x1={LEGEND_SIDE_PADDING}
        x2={width - LEGEND_SIDE_PADDING}
        y1={top + 4}
        y2={top + 4}
      />
      {legendItems(changes, width).map(({ change, x, row }) => {
        const rowY = firstRowY + row * LEGEND_ROW_HEIGHT
        return (
          <g key={change} className={CHANGE_CLASS[change]}>
            <rect
              className={styles.legendSwatch}
              x={x}
              y={rowY + 4}
              width={LEGEND_SWATCH_WIDTH}
              height={10}
              rx={2}
            />
            <text className={styles.legendText} x={x + LEGEND_SWATCH_WIDTH + 6} y={rowY + 13}>
              {CHANGE_WORDS[change]}
            </text>
          </g>
        )
      })}
    </g>
  )
}

// ---------- Scaling: CSS only ----------

const MIN_SCALE = 0.8

type ScalingCanvasProps = {
  naturalWidth: number
  blockWidth: number
  children: ReactNode
}

// True when a picture this wide would have to scroll in a block this wide.
export function scrollsInBlock(naturalWidth: number, blockWidth: number): boolean {
  return blockWidth > 0 && blockWidth < naturalWidth * MIN_SCALE
}

// Below 80% of the natural width the diagram stops shrinking and scrolls here, inside the block,
// so the transcript itself never scrolls sideways. The scroll region is then focusable.
export function ScalingCanvas({
  naturalWidth,
  blockWidth,
  children,
}: ScalingCanvasProps): ReactNode {
  const scrolls = scrollsInBlock(naturalWidth, blockWidth)
  const scrollProps = scrolls
    ? { tabIndex: 0, role: "region", "aria-label": "Diagram, scrolls sideways" }
    : {}

  return (
    <>
      <div className={styles.canvas} {...scrollProps}>
        {children}
      </div>
      {scrolls && <p className={styles.scrollHint}>Scroll sideways to see the whole diagram →</p>}
    </>
  )
}

// Stands where the picture will be: while the reply streams or the layout runs (as tall as a
// typical diagram, so the transcript does not jump), or compact when there is nothing to draw.
const PLACEHOLDER_HEIGHT = 240
const COMPACT_PLACEHOLDER_HEIGHT = 72

export function DiagramPlaceholder({
  text,
  isCompact = false,
}: {
  text: string
  isCompact?: boolean
}): ReactNode {
  const height = isCompact ? COMPACT_PLACEHOLDER_HEIGHT : PLACEHOLDER_HEIGHT

  return (
    <div className={styles.placeholder} style={{ height }} role="status">
      {text}
    </div>
  )
}

// ---------- Description: the SVG's text summary ----------

export function describeCounts(
  parts: Array<[number, string, string]>,
  changes: ChangeKind[]
): string {
  const sizes = parts.map(
    ([count, singular, plural]) => `${count} ${count === 1 ? singular : plural}`
  )
  const statusCounts = SHOWN_CHANGES.map(
    (change) => [change, changes.filter((c) => c === change).length] as const
  )
    .filter(([, count]) => count > 0)
    .map(([change, count]) => `${count} ${change}`)

  const summary = `${sizes.join(", ")}.`
  return statusCounts.length > 0 ? `${summary} ${statusCounts.join(", ")}.` : summary
}

// Opens a PR file, at a line when the diagram gave one.
export type OpenFile = (path: string, line: number | null) => void

// ---------- Ledger: one row per changed object, the text alternative of the picture ----------

type DiagramLedgerProps = {
  entries: LedgerEntry[]
  canOpenFile: (path: string) => boolean
  onOpenFile: OpenFile
}

export function DiagramLedger({ entries, canOpenFile, onOpenFile }: DiagramLedgerProps): ReactNode {
  if (entries.length === 0) return null

  return (
    <section className={styles.ledger} aria-label="Changes">
      <h4 className={styles.ledgerHeading}>Changes</h4>
      <ul className={styles.ledgerList}>
        {entries.map(({ key, change, name, note, path, line }) => (
          <li key={key} className={styles.ledgerRow}>
            <span className={`${styles.ledgerStatus} ${CHANGE_CLASS[change] ?? ""}`}>
              {CHANGE_WORDS[change]}
            </span>
            <span className={styles.ledgerName}>{name}</span>
            {note && <span className={styles.ledgerNote}>{note}</span>}
            {path !== null && canOpenFile(path) && (
              <button
                type="button"
                className={styles.fileLink}
                onClick={() => onOpenFile(path, line)}
              >
                {path}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
