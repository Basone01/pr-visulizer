import { Fragment, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from "react"

import type {
  ChangeBlock,
  ChangeKind,
  LineRange,
  SplitCell,
  SplitView,
} from "@/utils/diff/splitBlocks"
import {
  type BlockEdges,
  type PaneSide,
  type ScrollAnchor,
  edgesInViewport,
  followerScrollTop,
  isBlockVisible,
  ribbonPath,
  scrollAnchors,
} from "@/utils/diff/splitGeometry"

import styles from "./Diff.module.css"

// The side-by-side view, JetBrains style (§10): two panes that each read as a whole file, a
// gutter of ribbons joining every changed block to what it became, and synced scrolling that
// keeps those ribbons short. Rows render through the pane's own `renderLine`, so a line still has
// exactly one markup; this component only owns the layout, the ribbons and the scroll sync.

const GUTTER_WIDTH = 40

const MARKER: Record<ChangeKind, string> = {
  modified: "≠",
  inserted: "+",
  deleted: "−",
}

// Which block each line of one side belongs to, or -1 for context. Index = side cell index.
function blockIndexPerLine(blocks: ChangeBlock[], side: PaneSide, lineCount: number): number[] {
  const owner = new Array<number>(lineCount).fill(-1)

  blocks.forEach((block, blockIndex) => {
    for (let line = block[side].start; line < block[side].end; line += 1) owner[line] = blockIndex
  })

  return owner
}

// Blocks whose range on this side is EMPTY, keyed by the side index they sit before. Those draw a
// thin line at the insertion point, which is where the ribbon's wedge lands.
function gapsPerLine(blocks: ChangeBlock[], side: PaneSide): Map<number, number[]> {
  const gaps = new Map<number, number[]>()

  blocks.forEach((block, blockIndex) => {
    const range = block[side]
    if (range.start !== range.end) return

    gaps.set(range.start, [...(gaps.get(range.start) ?? []), blockIndex])
  })

  return gaps
}

type SideRows = { rows: HTMLElement[]; gaps: Map<number, HTMLElement> }

// One query per side, not one per block: a long file has hundreds of blocks and this runs after
// every render. Rows are mounted as a prefix of the side, so the list position IS the side index.
function collectRows(content: HTMLElement): SideRows {
  const rows = [...content.querySelectorAll<HTMLElement>("[data-row]")]
  const gaps = new Map<number, HTMLElement>()
  content.querySelectorAll<HTMLElement>("[data-gap]").forEach((gap) => {
    gaps.set(Number(gap.dataset.gap), gap)
  })

  return { rows, gaps }
}

function edgesOn(sideRows: SideRows, range: LineRange, blockIndex: number) {
  if (range.start === range.end) {
    const gap = sideRows.gaps.get(blockIndex)
    if (!gap) return null

    return { top: gap.offsetTop, bottom: gap.offsetTop }
  }

  const first = sideRows.rows[range.start]
  const last = sideRows.rows[range.end - 1]
  if (!first || !last) return null

  return { top: first.offsetTop, bottom: last.offsetTop + last.offsetHeight }
}

// The two tops of every mounted context line. A context row carries its FLAT index, which is
// the same on both sides because both render the same cell.
function measureContextTops(leftContent: HTMLElement, rightContent: HTMLElement): ScrollAnchor[] {
  const rightTops = new Map<string, number>()
  rightContent.querySelectorAll<HTMLElement>("[data-context]").forEach((row) => {
    rightTops.set(row.dataset.context!, row.offsetTop)
  })

  const tops: ScrollAnchor[] = []
  leftContent.querySelectorAll<HTMLElement>("[data-context]").forEach((row) => {
    const right = rightTops.get(row.dataset.context!)
    if (right !== undefined) tops.push({ left: row.offsetTop, right })
  })

  return tops
}

// Each block's top and bottom on both sides, from the mounted DOM. A block whose rows are not
// mounted yet (progressive mount) is null, so it has no ribbon until it mounts.
function measureBlocks(
  blocks: ChangeBlock[],
  leftContent: HTMLElement,
  rightContent: HTMLElement
): Array<BlockEdges | null> {
  const leftRows = collectRows(leftContent)
  const rightRows = collectRows(rightContent)

  return blocks.map((block, blockIndex) => {
    const left = edgesOn(leftRows, block.left, blockIndex)
    const right = edgesOn(rightRows, block.right, blockIndex)
    if (!left || !right) return null

    return {
      leftTop: left.top,
      leftBottom: left.bottom,
      rightTop: right.top,
      rightBottom: right.bottom,
    }
  })
}

export function SplitDiffView({
  view,
  mountedLineCount,
  renderLine,
  renderOverlays,
}: {
  view: SplitView
  // The progressive mount budget, in FLAT line indices: a cell renders once its index is below it.
  mountedLineCount: number
  renderLine: (cell: SplitCell, gutterSide: "head" | "base") => ReactNode
  // What opens under a head line (composer, peek, threads). The right pane only.
  renderOverlays: (headLine: number | null) => ReactNode
}) {
  const leftPaneRef = useRef<HTMLDivElement>(null)
  const rightPaneRef = useRef<HTMLDivElement>(null)
  const leftContentRef = useRef<HTMLDivElement>(null)
  const rightContentRef = useRef<HTMLDivElement>(null)
  const ribbonRefs = useRef<Array<SVGPathElement | null>>([])

  // Measured once per layout change, read on every scroll frame.
  const edgesRef = useRef<Array<BlockEdges | null>>([])
  const anchorsRef = useRef<ScrollAnchor[]>([{ left: 0, right: 0 }])

  // The scrollTop this component last WROTE to a pane. Its own scroll event then arrives as an
  // echo, and following it back would fight the reader's scroll on the other pane.
  const echoRef = useRef<Record<PaneSide, number | null>>({ left: null, right: null })

  const { blocks } = view
  const leftOwner = useMemo(
    () => blockIndexPerLine(blocks, "left", view.left.length),
    [blocks, view.left.length]
  )
  const rightOwner = useMemo(
    () => blockIndexPerLine(blocks, "right", view.right.length),
    [blocks, view.right.length]
  )
  const leftGaps = useMemo(() => gapsPerLine(blocks, "left"), [blocks])
  const rightGaps = useMemo(() => gapsPerLine(blocks, "right"), [blocks])

  // Writes the ribbon paths straight to the DOM: this runs on every scroll frame, and a React
  // render per frame would re-render every row with it.
  const drawRibbons = useCallback(() => {
    const leftPane = leftPaneRef.current
    const rightPane = rightPaneRef.current
    if (!leftPane || !rightPane) return

    const height = rightPane.clientHeight
    edgesRef.current.forEach((edges, blockIndex) => {
      const path = ribbonRefs.current[blockIndex]
      if (!path) return

      const shifted = edges && edgesInViewport(edges, leftPane.scrollTop, rightPane.scrollTop)
      const isShown = shifted !== null && isBlockVisible(shifted, height)
      path.setAttribute("d", isShown ? ribbonPath(shifted, GUTTER_WIDTH) : "")
    })
  }, [])

  const measure = useCallback(() => {
    const leftContent = leftContentRef.current
    const rightContent = rightContentRef.current
    if (!leftContent || !rightContent) return

    const edges = measureBlocks(blocks, leftContent, rightContent)
    edgesRef.current = edges
    anchorsRef.current = scrollAnchors(
      edges.filter((edge): edge is BlockEdges => edge !== null),
      measureContextTops(leftContent, rightContent)
    )
    drawRibbons()
  }, [blocks, drawRibbons])

  // Re-measure after every render (rows mount progressively, overlays open and close) and on any
  // size change of either side (wrap toggled, pane resized, a font finished loading).
  useLayoutEffect(measure)

  useLayoutEffect(() => {
    const leftContent = leftContentRef.current
    const rightContent = rightContentRef.current
    if (!leftContent || !rightContent || typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(measure)
    observer.observe(leftContent)
    observer.observe(rightContent)
    observer.observe(rightPaneRef.current!)

    return () => observer.disconnect()
  }, [measure])

  function handleScroll(driver: PaneSide) {
    const driverPane = driver === "left" ? leftPaneRef.current : rightPaneRef.current
    const followerPane = driver === "left" ? rightPaneRef.current : leftPaneRef.current
    const follower: PaneSide = driver === "left" ? "right" : "left"
    if (!driverPane || !followerPane) return

    const echo = echoRef.current[driver]
    echoRef.current[driver] = null
    const isEcho = echo !== null && Math.abs(driverPane.scrollTop - echo) < 1
    if (isEcho) {
      drawRibbons()
      return
    }

    const target = followerScrollTop(
      driverPane.scrollTop,
      driverPane.clientHeight,
      anchorsRef.current,
      driver
    )
    const maxScroll = followerPane.scrollHeight - followerPane.clientHeight
    const clamped = Math.max(0, Math.min(maxScroll, target))

    const needsVertical = Math.abs(followerPane.scrollTop - clamped) >= 1
    const needsHorizontal = followerPane.scrollLeft !== driverPane.scrollLeft
    if (needsVertical) followerPane.scrollTop = clamped
    if (needsHorizontal) followerPane.scrollLeft = driverPane.scrollLeft
    if (needsVertical || needsHorizontal) echoRef.current[follower] = followerPane.scrollTop

    drawRibbons()
  }

  function jumpToBlock(block: ChangeBlock, blockIndex: number) {
    const rightContent = rightContentRef.current
    const isEmpty = block.right.start === block.right.end
    const selector = isEmpty ? `[data-gap="${blockIndex}"]` : `[data-row="${block.right.start}"]`

    rightContent?.querySelector(selector)?.scrollIntoView({ block: "center" })
  }

  function renderSide(side: PaneSide): ReactNode {
    const cells = side === "left" ? view.left : view.right
    const owner = side === "left" ? leftOwner : rightOwner
    const gaps = side === "left" ? leftGaps : rightGaps
    const gutterSide = side === "left" ? "base" : "head"

    function renderGaps(beforeIndex: number): ReactNode {
      return (gaps.get(beforeIndex) ?? []).map((blockIndex) => (
        <div
          key={`gap-${blockIndex}`}
          className={styles.splitGap}
          data-gap={blockIndex}
          data-block={blocks[blockIndex]!.kind}
          aria-hidden="true"
        />
      ))
    }

    // Each side's flat indices only grow, so the mounted rows are always a prefix of the side.
    const mountedCells = cells.filter((cell) => cell.index < mountedLineCount)
    const isFullyMounted = mountedCells.length === cells.length

    return (
      <>
        {mountedCells.map((cell, sideIndex) => {
          const blockIndex = owner[sideIndex]!
          const kind = blockIndex >= 0 ? blocks[blockIndex]!.kind : undefined

          return (
            <Fragment key={sideIndex}>
              {renderGaps(sideIndex)}
              <div
                className={styles.splitRow}
                data-row={sideIndex}
                data-block={kind}
                data-context={kind ? undefined : cell.index}
              >
                <span className={styles.splitMarker} aria-hidden="true">
                  {kind ? MARKER[kind] : ""}
                </span>
                {renderLine(cell, gutterSide)}
              </div>
              {side === "right" && renderOverlays(cell.line.newLine)}
            </Fragment>
          )
        })}
        {isFullyMounted && renderGaps(cells.length)}
      </>
    )
  }

  return (
    <div className={styles.splitView}>
      <div
        ref={leftPaneRef}
        className={styles.splitPane}
        onScroll={() => handleScroll("left")}
        aria-label="Base version"
        role="region"
      >
        <div ref={leftContentRef} className={styles.splitContent}>
          {renderSide("left")}
        </div>
      </div>

      <svg className={styles.splitRibbons} width={GUTTER_WIDTH} aria-hidden="true">
        {blocks.map((block, blockIndex) => (
          <path
            key={blockIndex}
            ref={(path) => {
              ribbonRefs.current[blockIndex] = path
            }}
            className={styles.splitRibbon}
            data-block={block.kind}
          />
        ))}
      </svg>

      <div
        ref={rightPaneRef}
        className={styles.splitPane}
        onScroll={() => handleScroll("right")}
        aria-label="Head version"
        role="region"
      >
        <div ref={rightContentRef} className={styles.splitContent}>
          {renderSide("right")}
        </div>
      </div>

      {/* A mouse shortcut over the same places the pane scroll reaches, so it stays out of the
          accessibility tree: a 3px mark could never be a 24px keyboard target anyway. */}
      <div className={styles.changeMap} aria-hidden="true">
        {blocks.map((block, blockIndex) => {
          const total = Math.max(view.right.length, 1)
          const top = (block.right.start / total) * 100
          const height = ((block.right.end - block.right.start) / total) * 100

          return (
            <div
              key={blockIndex}
              className={styles.changeMapMark}
              data-block={block.kind}
              style={{ top: `${top}%`, height: `max(3px, ${height}%)` }}
              onClick={() => jumpToBlock(block, blockIndex)}
            />
          )
        })}
      </div>
    </div>
  )
}
